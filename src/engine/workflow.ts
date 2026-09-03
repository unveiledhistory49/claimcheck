/** Claim lifecycle. Transition map is the single source of truth for legal moves. */
import { nowMs, type Db } from "../db.js";
import { InvalidInput, NotFound } from "../store/errors.js";
import { appendAudit } from "../store/audit.js";
import {
  addAppeal,
  addDecision,
  addFraudFlag,
  addPayout,
  claimTotal,
  decideAppeal,
  getAppeal,
  getClaim,
  latestDecision,
  listDocuments,
  listItems,
  listClaims,
  paidTotal,
  listWatch,
  reserveAppend,
  reserveBalance,
  setClaimStatus,
} from "../store/claims.js";
import { getPolicy } from "../store/policies.js";
import type { Claim, ClaimStatus, Decision } from "../types.js";
import { adjudicateClaim } from "./adjudicate.js";
import type { FraudFinding } from "./fraud.js";

export const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  intake: ["validating"],
  validating: ["fraud_review", "denied"],
  // denied is reachable from appealed on upheld appeals (re-review found nothing new).
  fraud_review: ["adjudicating", "closed"],
  adjudicating: ["approved", "denied", "fraud_review"],
  approved: ["paid", "closed"],
  denied: ["appealed", "closed"],
  appealed: ["adjudicating", "denied"],
  paid: ["closed"],
  closed: [],
};

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export function transition(db: Db, orgId: string, claimId: string, to: ClaimStatus, actor: string): Claim {
  const claim = getClaim(db, orgId, claimId);
  // Status comes from the database, not the type system — a corrupt row must
  // deny the transition rather than crash on undefined.includes.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const allowed = TRANSITIONS[claim.status] ?? [];
  if (!allowed.includes(to)) {
    throw new WorkflowError(`illegal transition ${claim.status} -> ${to}`);
  }
  const now = nowMs();
  setClaimStatus(db, orgId, claimId, to, now);
  appendAudit(db, orgId, actor, "claims.transition", claimId, `${claim.status}->${to}`, now);
  return getClaim(db, orgId, claimId);
}

export interface PipelineResult {
  claim: Claim;
  decision: Decision | null;
  flags: FraudFinding[];
  score: number;
}

/**
 * Run the pipeline from intake (or re-run from appealed). Deterministic:
 * same claim state always yields the same decision.
 */
export function runPipeline(db: Db, orgId: string, claimId: string, actor: string): PipelineResult {
  let claim = getClaim(db, orgId, claimId);
  if (claim.status !== "intake" && claim.status !== "appealed") {
    throw new WorkflowError(`pipeline starts from intake|appealed, not ${claim.status}`);
  }
  const policy = getPolicy(db, orgId, claim.policyId);
  const items = listItems(db, claim.id);
  const docs = listDocuments(db, claim.id);
  const priors = listClaims(db, orgId).filter((c) => c.policyId === claim.policyId && c.id !== claim.id);
  const watch = listWatch(db, orgId).map((w) => ({ kind: w.kind, value: w.value }));
  const total = items.reduce((s, i) => s + i.amountMinor, 0);

  const step = (to: ClaimStatus): void => {
    claim = transition(db, orgId, claim.id, to, actor);
  };

  // Precheck gate: policy/window/items. Failures deny immediately with no reserve.
  if (policy.status !== "active" || claim.incidentMs < policy.effectiveFromMs || claim.incidentMs > policy.effectiveUntilMs || items.length === 0) {
    if (claim.status === "intake") step("validating");
    const adj = adjudicateClaim({ claim, policy, items, totalMinor: total, docCount: docs.length, priorClaims: priors, watchlist: watch });
    const decision = addDecision(
      db,
      claim.id,
      { outcome: "deny", payableMinor: 0, deductibleAppliedMinor: 0, reasons: adj.reasons, decidedBy: actor },
      nowMs(),
    );
    appendAudit(db, orgId, actor, "claims.decide", claim.id, "deny", nowMs());
    step("denied");
    return { claim: getClaim(db, orgId, claim.id), decision, flags: [], score: 0 };
  }

  if (claim.status === "intake") step("validating");
  step("fraud_review");

  // Reserve: set on first run, adjust (delta) on re-runs.
  const wantReserve = Math.min(total, policy.coverageLimitMinor);
  const haveReserve = reserveBalance(db, claim.id);
  const delta = wantReserve - haveReserve;
  if (delta !== 0) {
    reserveAppend(db, claim.id, orgId, haveReserve === 0 ? "set" : "adjust", haveReserve === 0 ? wantReserve : delta, actor, nowMs());
  }

  const adj = adjudicateClaim({ claim, policy, items, totalMinor: total, docCount: docs.length, priorClaims: priors, watchlist: watch });
  for (const f of adj.flags) {
    addFraudFlag(db, claim.id, { ruleCode: f.ruleCode, severity: f.severity, points: f.points, detail: f.detail }, nowMs());
  }

  if (adj.outcome === "manual") {
    const decision = addDecision(
      db,
      claim.id,
      { outcome: "manual", payableMinor: adj.payableMinor, deductibleAppliedMinor: adj.deductibleAppliedMinor, reasons: adj.reasons, decidedBy: actor },
      nowMs(),
    );
    appendAudit(db, orgId, actor, "claims.decide", claim.id, "manual", nowMs());
    return { claim: getClaim(db, orgId, claim.id), decision, flags: adj.flags, score: adj.score };
  }

  step("adjudicating");
  const decision = addDecision(
    db,
    claim.id,
    { outcome: adj.outcome, payableMinor: adj.payableMinor, deductibleAppliedMinor: adj.deductibleAppliedMinor, reasons: adj.reasons, decidedBy: actor },
    nowMs(),
  );
  appendAudit(db, orgId, actor, "claims.decide", claim.id, adj.outcome, nowMs());
  if (adj.outcome === "approve") {
    const newBal = reserveBalance(db, claim.id);
    const adjustTo = adj.payableMinor - newBal;
    if (adjustTo !== 0) reserveAppend(db, claim.id, orgId, "adjust", adjustTo, actor, nowMs());
    step("approved");
  } else {
    reserveAppend(db, claim.id, orgId, "release", 0, actor, nowMs());
    step("denied");
  }
  return { claim: getClaim(db, orgId, claim.id), decision, flags: adj.flags, score: adj.score };
}

/** Supervisor override from the manual queue. Recomputes payable, ignores fraud gate. */
export function overrideClaim(
  db: Db,
  orgId: string,
  claimId: string,
  supervisorId: string,
  outcome: "approve" | "deny",
  reason: string,
): Decision {
  const claim = getClaim(db, orgId, claimId);
  if (claim.status !== "fraud_review") {
    throw new WorkflowError(`override requires fraud_review, not ${claim.status}`);
  }
  if (reason.trim() === "") throw new InvalidInput("override reason must not be empty");
  const policy = getPolicy(db, orgId, claim.policyId);
  const items = listItems(db, claim.id);
  const total = claimTotal(db, claim.id);
  const adj = adjudicateClaim({
    claim,
    policy,
    items,
    totalMinor: total,
    docCount: listDocuments(db, claim.id).length,
    priorClaims: [],
    watchlist: [],
  });
  const now = nowMs();
  const decision = addDecision(
    db,
    claim.id,
    {
      outcome,
      payableMinor: outcome === "approve" ? adj.payableMinor : 0,
      deductibleAppliedMinor: outcome === "approve" ? adj.deductibleAppliedMinor : 0,
      reasons: [...adj.reasons, `override:${reason.trim()}`],
      decidedBy: supervisorId,
    },
    now,
  );
  appendAudit(db, orgId, supervisorId, "claims.override", claim.id, outcome, now);
  if (outcome === "approve") {
    const adjustTo = decision.payableMinor - reserveBalance(db, claim.id);
    if (adjustTo !== 0) reserveAppend(db, claim.id, orgId, "adjust", adjustTo, supervisorId, now);
    transition(db, orgId, claim.id, "adjudicating", supervisorId);
    transition(db, orgId, claim.id, "approved", supervisorId);
  } else {
    reserveAppend(db, claim.id, orgId, "release", 0, supervisorId, now);
    transition(db, orgId, claim.id, "adjudicating", supervisorId);
    transition(db, orgId, claim.id, "denied", supervisorId);
  }
  return decision;
}

export function appealClaim(db: Db, orgId: string, claimId: string, reason: string): { id: string } {
  const claim = getClaim(db, orgId, claimId);
  if (claim.status !== "denied") throw new WorkflowError(`appeal requires denied, not ${claim.status}`);
  const now = nowMs();
  const appeal = addAppeal(db, claimId, reason, now);
  appendAudit(db, orgId, "claimant", "claims.appeal", claimId, reason.trim(), now);
  transition(db, orgId, claimId, "appealed", "claimant");
  return { id: appeal.id };
}

export function decideAppealClaim(
  db: Db,
  orgId: string,
  appealId: string,
  supervisorId: string,
  overturn: boolean,
  reason: string,
): PipelineResult | { upheld: true } {
  const appeal = getAppeal(db, appealId);
  const claim = getClaim(db, orgId, appeal.claimId);
  if (claim.status !== "appealed") throw new WorkflowError(`appeal decision requires appealed, not ${claim.status}`);
  if (reason.trim() === "") throw new InvalidInput("appeal decision reason must not be empty");
  const now = nowMs();
  if (!overturn) {
    decideAppeal(db, appealId, "upheld", now);
    appendAudit(db, orgId, supervisorId, "appeals.decide", appealId, `upheld:${reason.trim()}`, now);
    transition(db, orgId, claim.id, "denied", supervisorId);
    return { upheld: true as const };
  }
  decideAppeal(db, appealId, "overturned", now);
  appendAudit(db, orgId, supervisorId, "appeals.decide", appealId, `overturned:${reason.trim()}`, now);
  return runPipeline(db, orgId, claim.id, supervisorId);
}

export function payClaim(
  db: Db,
  orgId: string,
  claimId: string,
  amountMinor: number,
  reference: string,
  actor: string,
): { paidTotal: number; status: ClaimStatus } {
  const claim = getClaim(db, orgId, claimId);
  if (claim.status !== "approved") throw new WorkflowError(`pay requires approved, not ${claim.status}`);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new InvalidInput("payout must be > 0");
  let payable = 0;
  try {
    payable = latestPayable(db, claimId);
  } catch (err) {
    if (err instanceof NotFound) throw new WorkflowError("no decision to pay against");
    throw err;
  }
  const now = nowMs();
  const total = paidTotal(db, claimId);
  if (total + amountMinor > payable) throw new InvalidInput("payout exceeds payable balance");
  reserveAppend(db, claimId, orgId, "pay", amountMinor, actor, now);
  addPayout(db, claimId, amountMinor, reference, now);
  appendAudit(db, orgId, actor, "claims.pay", claimId, `${String(amountMinor)}:${reference.trim()}`, now);
  const newTotal = paidTotal(db, claimId);
  if (newTotal >= payable) {
    transition(db, orgId, claimId, "paid", actor);
    return { paidTotal: newTotal, status: "paid" };
  }
  return { paidTotal: newTotal, status: "approved" };
}

function latestPayable(db: Db, claimId: string): number {
  const d = latestDecision(db, claimId);
  if (d.outcome !== "approve") throw new WorkflowError("latest decision is not an approval");
  return d.payableMinor;
}
