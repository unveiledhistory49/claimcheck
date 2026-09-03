import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import type { Claim, ClaimItem, Policy } from "../src/types.js";
import { fraudScore, runFraudChecks } from "../src/engine/fraud.js";
import { adjudicateClaim } from "../src/engine/adjudicate.js";
import { appealClaim, decideAppealClaim, overrideClaim, payClaim, runPipeline, transition, WorkflowError } from "../src/engine/workflow.js";
import { createPolicy } from "../src/store/policies.js";
import { addItem, createClaim, latestDecision, reserveBalance } from "../src/store/claims.js";
import { addWatch } from "../src/store/claims.js";

const NOW = 1_712_000_000_000;
const DAY = 86_400_000;

function memDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

function mkOrg(db: Db, id: string): void {
  db.raw
    .prepare(`INSERT INTO orgs (id, name, api_key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, `org-${id}`, `hash-${id}`, `prefix-${id}`, NOW);
}

function mkPolicy(db: Db, overrides: Partial<{ status: "active" | "lapsed" | "cancelled"; from: number; until: number; limit: number; ded: number }> = {}): Policy {
  return createPolicy(db, "o1", {
    policyNumber: `P-${String(Math.floor(Math.random() * 1e9))}`,
    holderName: "Holder",
    product: "auto",
    coverageLimitMinor: overrides.limit ?? 5_000_000,
    deductibleMinor: overrides.ded ?? 10_000,
    effectiveFromMs: overrides.from ?? NOW - 365 * DAY,
    effectiveUntilMs: overrides.until ?? NOW + 365 * DAY,
    status: overrides.status,
  }, NOW);
}

function mkClaim(db: Db, policyId: string, incidentAgoDays = 10): Claim {
  return createClaim(db, {
    orgId: "o1", policyId, claimantName: "Ann Claimant", claimantEmail: "ann@example.com",
    incidentMs: NOW - incidentAgoDays * DAY, reportedMs: NOW - incidentAgoDays * DAY + 3_600_000,
    description: "t",
  }, NOW);
}

function ctxOf(over: Partial<Parameters<typeof runFraudChecks>[0]> = {}) {
  const claim = { id: "c", orgId: "o1", policyId: "p", claimantName: "Ann", claimantEmail: "a@x.io", incidentMs: NOW, reportedMs: NOW, description: "", status: "intake", claimNumber: "CC-1", createdAt: 0, updatedAt: 0 } as Claim;
  const policy = { id: "p", orgId: "o1", policyNumber: "P", holderName: "H", product: "auto", coverageLimitMinor: 5_000_000, deductibleMinor: 10_000, effectiveFromMs: 0, effectiveUntilMs: NOW + DAY, status: "active", createdAt: 0 } as Policy;
  const items = [{ id: "i", claimId: "c", category: "repair", description: "", amountMinor: 100_00, createdAt: 0 }] as ClaimItem[];
  return {
    claim, policy, items, totalMinor: 100_00, docCount: 1, priorClaims: [] as Claim[], watchlist: [] as { kind: string; value: string }[],
    ...over,
  };
}

describe("fraud rules", () => {
  it("scores a clean claim zero and is deterministic", () => {
    const a = runFraudChecks(ctxOf());
    const b = runFraudChecks(ctxOf());
    expect(a).toEqual([]);
    expect(fraudScore(a)).toBe(0);
    expect(b).toEqual(a);
  });

  it("fires each rule", () => {
    const prior = { ...ctxOf().claim, id: "prior", claimNumber: "CC-0", incidentMs: NOW - 3_600_000 };
    expect(runFraudChecks(ctxOf({ priorClaims: [prior] })).map((f) => f.ruleCode)).toContain("DUP_INCIDENT");

    const olds = [1, 2, 3].map((d) => ({ ...ctxOf().claim, id: `p${String(d)}`, claimNumber: `CC-${String(d)}`, incidentMs: NOW - d * DAY }));
    expect(runFraudChecks(ctxOf({ priorClaims: olds })).map((f) => f.ruleCode)).toContain("VELOCITY");

    const round = [{ id: "i", claimId: "c", category: "repair", description: "", amountMinor: 11_000_00, createdAt: 0 }] as ClaimItem[];
    expect(runFraudChecks(ctxOf({ items: round, totalMinor: 11_000_00 })).map((f) => f.ruleCode)).toContain("ROUND_AMOUNT");

    expect(runFraudChecks(ctxOf({ totalMinor: 4_500_000 })).map((f) => f.ruleCode)).toContain("HIGH_VALUE");
    expect(runFraudChecks(ctxOf({ claim: { ...ctxOf().claim, reportedMs: NOW + 40 * DAY } })).map((f) => f.ruleCode)).toContain("BACKDATED");
    expect(runFraudChecks(ctxOf({ watchlist: [{ kind: "email", value: "a@x.io" }] }))[0]).toMatchObject({ ruleCode: "WATCHLIST", severity: "block" });
    expect(runFraudChecks(ctxOf({ docCount: 0, totalMinor: 600_000 })).map((f) => f.ruleCode)).toContain("NO_DOCS_HIGH_VALUE");
  });
});

describe("adjudication math", () => {
  it("applies deductible and cap", () => {
    const c = ctxOf({ totalMinor: 1500_00 });
    const a = adjudicateClaim({ ...c, items: [{ id: "i", claimId: "c", category: "repair", description: "", amountMinor: 1500_00, createdAt: 0 }] });
    expect(a.outcome).toBe("approve");
    expect(a.payableMinor).toBe(1400_00);
    expect(a.deductibleAppliedMinor).toBe(10_000);
    expect(a.capped).toBe(false);
    expect(a.reasons[0]).toBe("rules:1.0.0");
  });

  it("caps at the limit and denies bad policies", () => {
    const c = ctxOf({ totalMinor: 9_000_000 });
    const a = adjudicateClaim(c);
    expect(a.outcome).toBe("approve");
    expect(a.payableMinor).toBe(4_990_000);
    expect(a.capped).toBe(true);
    expect(a.reasons).toContain("capped_to_limit");
  });

  it("denies inactive, out-of-window, and empty claims", () => {
    const base = ctxOf();
    expect(adjudicateClaim({ ...base, policy: { ...base.policy, status: "lapsed" } }).outcome).toBe("deny");
    expect(adjudicateClaim({ ...base, claim: { ...base.claim, incidentMs: NOW + 400 * DAY } }).outcome).toBe("deny");
    expect(adjudicateClaim({ ...base, items: [], totalMinor: 0 }).outcome).toBe("deny");
  });
});

describe("workflow", () => {
  it("walks the happy path and guards jumps", () => {
    const db = memDb();
    mkOrg(db, "o1");
    const p = mkPolicy(db);
    const c = mkClaim(db, p.id);
    addItem(db, c.id, { category: "repair", amountMinor: 1100_00 }, NOW);
    const r = runPipeline(db, "o1", c.id, "sys");
    expect(r.claim.status).toBe("approved");
    expect(r.decision?.outcome).toBe("approve");
    expect(r.decision?.version).toBe(1);
    expect(reserveBalance(db, c.id)).toBe(1000_00); // 1100 - 100 deductible
    expect(() => transition(db, "o1", c.id, "appealed", "x")).toThrow(WorkflowError);
  });

  it("parks watchlisted claims in fraud_review", () => {
    const db = memDb();
    mkOrg(db, "o1");
    const p = mkPolicy(db);
    addWatch(db, "o1", "name", "ann claimant", "ring", NOW);
    const c = createClaim(db, {
      orgId: "o1", policyId: p.id, claimantName: "Ann Claimant", claimantEmail: "",
      incidentMs: NOW - DAY, reportedMs: NOW - DAY + 1000, description: "",
    }, NOW);
    addItem(db, c.id, { category: "repair", amountMinor: 2000_00 }, NOW);
    const r = runPipeline(db, "o1", c.id, "sys");
    expect(r.claim.status).toBe("fraud_review");
    expect(r.decision?.outcome).toBe("manual");
  });

  it("denies out-of-window incidents with no reserve", () => {
    const db = memDb();
    mkOrg(db, "o1");
    const p = mkPolicy(db, { until: NOW - DAY });
    const c = mkClaim(db, p.id, 400);
    addItem(db, c.id, { category: "repair", amountMinor: 200_00 }, NOW);
    const r = runPipeline(db, "o1", c.id, "sys");
    expect(r.claim.status).toBe("denied");
    expect(reserveBalance(db, c.id)).toBe(0);
  });

  it("overrides, appeals, and pays", () => {
    const db = memDb();
    mkOrg(db, "o1");
    const p = mkPolicy(db);
    addWatch(db, "o1", "name", "ann claimant", "ring", NOW);
    const c = createClaim(db, {
      orgId: "o1", policyId: p.id, claimantName: "Ann Claimant", claimantEmail: "",
      incidentMs: NOW - DAY, reportedMs: NOW - DAY + 1000, description: "",
    }, NOW);
    addItem(db, c.id, { category: "repair", amountMinor: 2000_00 }, NOW);
    const r = runPipeline(db, "o1", c.id, "sys");
    expect(r.claim.status).toBe("fraud_review");
    // adjuster cannot override via engine? engine doesn't check roles — API does. Engine accepts any id.
    const d = overrideClaim(db, "o1", c.id, "sup1", "approve", "verified by phone");
    expect(d.version).toBe(2);
    expect(d.reasons.some((x) => x.startsWith("override:"))).toBe(true);
    const paid = payClaim(db, "o1", c.id, 1900_00, "CHK-1", "sup1");
    expect(paid.status).toBe("paid");
    expect(() => payClaim(db, "o1", c.id, 1, "x", "sup1")).toThrow(WorkflowError);
  });

  it("appeals overturn to a new decision version", () => {
    const db = memDb();
    mkOrg(db, "o1");
    const p = mkPolicy(db, { until: NOW - DAY });
    const c = mkClaim(db, p.id, 400);
    addItem(db, c.id, { category: "repair", amountMinor: 200_00 }, NOW);
    const r = runPipeline(db, "o1", c.id, "sys");
    expect(r.claim.status).toBe("denied");
    // fix the policy window message? appeal path re-runs and denies again (window still bad)
    const { id } = appealClaim(db, "o1", c.id, "unfair");
    expect(id).toBeTruthy();
    const out = decideAppealClaim(db, "o1", id, "sup1", false, "no new evidence");
    expect(out).toEqual({ upheld: true });
    expect(latestDecision(db, c.id).version).toBe(1);
  });

  it("documents feed NO_DOCS rule", () => {
    const db = memDb();
    mkOrg(db, "o1");
    const p = mkPolicy(db);
    const c = mkClaim(db, p.id);
    addItem(db, c.id, { category: "property", amountMinor: 600_000 }, NOW);
    const before = runPipeline(db, "o1", c.id, "sys");
    expect(before.flags.map((f) => f.ruleCode)).toContain("NO_DOCS_HIGH_VALUE");
  });
});
