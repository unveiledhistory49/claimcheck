/** Shared domain types. Amounts are integer USD cents — never float. */

export type ClaimStatus =
  | "intake"
  | "validating"
  | "fraud_review"
  | "adjudicating"
  | "approved"
  | "denied"
  | "paid"
  | "closed"
  | "appealed";

export type PolicyProduct = "auto" | "health" | "property";
export type PolicyStatus = "active" | "lapsed" | "cancelled";
export type ItemCategory = "medical" | "repair" | "property" | "other";
export type AdjusterRole = "adjuster" | "supervisor";
export type DecisionOutcome = "approve" | "deny" | "manual";
export type AppealStatus = "open" | "upheld" | "overturned";
export type FraudSeverity = "info" | "review" | "block";

export interface Policy {
  id: string;
  orgId: string;
  policyNumber: string;
  holderName: string;
  product: PolicyProduct;
  coverageLimitMinor: number;
  deductibleMinor: number;
  effectiveFromMs: number;
  effectiveUntilMs: number;
  status: PolicyStatus;
  createdAt: number;
}

export interface Claim {
  id: string;
  orgId: string;
  claimNumber: string;
  policyId: string;
  claimantName: string;
  claimantEmail: string;
  incidentMs: number;
  reportedMs: number;
  description: string;
  status: ClaimStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimItem {
  id: string;
  claimId: string;
  category: ItemCategory;
  description: string;
  amountMinor: number;
  createdAt: number;
}

export interface FraudFlag {
  id: string;
  claimId: string;
  ruleCode: string;
  severity: FraudSeverity;
  points: number;
  detail: string;
  createdAt: number;
}

export interface Decision {
  id: string;
  claimId: string;
  version: number;
  outcome: DecisionOutcome;
  payableMinor: number;
  deductibleAppliedMinor: number;
  reasons: string[];
  decidedBy: string;
  createdAt: number;
}

export interface ReserveEntry {
  id: string;
  claimId: string;
  orgId: string;
  kind: "set" | "adjust" | "release" | "pay";
  amountMinor: number;
  balanceAfterMinor: number;
  actor: string;
  createdAt: number;
}

export interface Payout {
  id: string;
  claimId: string;
  amountMinor: number;
  reference: string;
  createdAt: number;
}
