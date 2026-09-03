/** Deterministic adjudication rules. Pure — no I/O. */
import { fraudScore, runFraudChecks, type FraudContext, type FraudFinding } from "./fraud.js";
import type { Claim, ClaimItem, DecisionOutcome, Policy } from "../types.js";

export const RULES_VERSION = "1.0.0";
export const MANUAL_SCORE_THRESHOLD = 70;

export interface Adjudication {
  outcome: DecisionOutcome;
  payableMinor: number;
  deductibleAppliedMinor: number;
  capped: boolean;
  reasons: string[];
  flags: FraudFinding[];
  score: number;
}

export interface AdjudicationInput {
  claim: Claim;
  policy: Policy;
  items: ClaimItem[];
  totalMinor: number;
  docCount: number;
  priorClaims: Claim[];
  watchlist: { kind: string; value: string }[];
}

export function adjudicateClaim(input: AdjudicationInput): Adjudication {
  const { claim, policy, items, totalMinor, docCount, priorClaims, watchlist } = input;
  const reasons = [`rules:${RULES_VERSION}`];

  if (policy.status !== "active") {
    return deny([...reasons, "policy_inactive"]);
  }
  if (claim.incidentMs < policy.effectiveFromMs || claim.incidentMs > policy.effectiveUntilMs) {
    return deny([...reasons, "policy_not_effective"]);
  }
  if (items.length === 0) {
    return deny([...reasons, "no_claimed_items"]);
  }

  const capped = totalMinor > policy.coverageLimitMinor;
  const payable = Math.min(totalMinor, policy.coverageLimitMinor);
  if (capped) reasons.push("capped_to_limit");
  const deductible = Math.min(policy.deductibleMinor, payable);
  const net = payable - deductible;

  const ctx: FraudContext = { claim, policy, items, totalMinor, docCount, priorClaims, watchlist };
  const flags = runFraudChecks(ctx);
  const score = fraudScore(flags);
  for (const f of flags) reasons.push(`flag:${f.ruleCode}`);

  const blocked = flags.filter((f) => f.severity === "block").map((f) => f.ruleCode);
  if (blocked.length > 0) {
    return { outcome: "manual", payableMinor: net, deductibleAppliedMinor: deductible, capped, reasons: [...reasons, `fraud_block:${blocked.join(",")}`], flags, score };
  }
  if (score >= MANUAL_SCORE_THRESHOLD) {
    return { outcome: "manual", payableMinor: net, deductibleAppliedMinor: deductible, capped, reasons: [...reasons, `fraud_score:${String(score)}`], flags, score };
  }
  if (net === 0) reasons.push("deductible_covers_all");
  return { outcome: "approve", payableMinor: net, deductibleAppliedMinor: deductible, capped, reasons, flags, score };
}

function deny(reasons: string[]): Adjudication {
  return { outcome: "deny", payableMinor: 0, deductibleAppliedMinor: 0, capped: false, reasons, flags: [], score: 0 };
}
