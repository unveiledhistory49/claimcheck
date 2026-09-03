/** Deterministic fraud rules. Pure functions — the caller loads context. */
import type { Claim, ClaimItem, FraudSeverity, Policy } from "../types.js";

export interface FraudFinding {
  ruleCode: string;
  severity: FraudSeverity;
  points: number;
  detail: string;
}

export interface FraudContext {
  claim: Claim;
  policy: Policy;
  items: ClaimItem[];
  totalMinor: number;
  docCount: number;
  priorClaims: Claim[];
  watchlist: { kind: string; value: string }[];
}

const DAY_MS = 86_400_000;

export function runFraudChecks(ctx: FraudContext): FraudFinding[] {
  const out: FraudFinding[] = [];
  const { claim, policy, items, totalMinor, docCount, priorClaims, watchlist } = ctx;

  for (const prior of priorClaims) {
    if (prior.id !== claim.id && Math.abs(prior.incidentMs - claim.incidentMs) < DAY_MS) {
      out.push({
        ruleCode: "DUP_INCIDENT",
        severity: "review",
        points: 40,
        detail: `prior claim ${prior.claimNumber} within 24h of incident`,
      });
      break;
    }
  }

  const recent = priorClaims.filter(
    (p) => p.id !== claim.id && p.incidentMs < claim.incidentMs && claim.incidentMs - p.incidentMs <= 30 * DAY_MS,
  );
  if (recent.length >= 3) {
    out.push({
      ruleCode: "VELOCITY",
      severity: "review",
      points: 30,
      detail: `${recent.length} prior claims in 30d`,
    });
  }

  if (items.length > 0 && items.every((i) => i.amountMinor % 100_000 === 0) && totalMinor > 1_000_000) {
    out.push({
      ruleCode: "ROUND_AMOUNT",
      severity: "info",
      points: 15,
      detail: "all line items are round thousands above $10k",
    });
  }

  if (policy.coverageLimitMinor > 0 && totalMinor > Math.floor(policy.coverageLimitMinor * 0.8)) {
    out.push({
      ruleCode: "HIGH_VALUE",
      severity: "review",
      points: 20,
      detail: "claimed total exceeds 80% of coverage limit",
    });
  }

  if (claim.reportedMs - claim.incidentMs > 30 * DAY_MS) {
    out.push({
      ruleCode: "BACKDATED",
      severity: "review",
      points: 25,
      detail: "reported more than 30d after incident",
    });
  }

  const name = claim.claimantName.trim().toLowerCase();
  const email = claim.claimantEmail.trim().toLowerCase();
  for (const w of watchlist) {
    if ((w.kind === "name" && w.value === name) || (w.kind === "email" && email !== "" && w.value === email)) {
      out.push({
        ruleCode: "WATCHLIST",
        severity: "block",
        points: 50,
        detail: `claimant matches watchlist ${w.kind}`,
      });
      break;
    }
  }

  if (docCount === 0 && totalMinor > 500_000) {
    out.push({
      ruleCode: "NO_DOCS_HIGH_VALUE",
      severity: "review",
      points: 10,
      detail: "no supporting documents on claim above $5k",
    });
  }

  out.sort((a, b) => (a.ruleCode < b.ruleCode ? -1 : 1));
  return out;
}

export function fraudScore(findings: FraudFinding[]): number {
  return findings.reduce((sum, f) => sum + f.points, 0);
}
