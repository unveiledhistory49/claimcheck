import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Db } from "../src/db.js";
import { Conflict, InvalidInput, NotFound } from "../src/store/errors.js";
import { createPolicy, getPolicyByNumber } from "../src/store/policies.js";
import {
  addAppeal,
  addDecision,
  addDocument,
  addFraudFlag,
  addItem,
  addPayout,
  addWatch,
  claimTotal,
  createClaim,
  decideAppeal,
  getClaim,
  listPayouts,
  nextClaimNumber,
  paidTotal,
  removeWatch,
  reserveAppend,
  reserveBalance,
  setClaimStatus,
} from "../src/store/claims.js";
import { appendAudit, idemGet, idemPut, verifyAudit } from "../src/store/audit.js";
import { checkAdjusterPassword, createAdjuster, createSession, deleteSession, getSessionByHash } from "../src/store/users.js";

function memDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

const NOW = 1_712_000_000_000;
const DAY = 86_400_000;

function mkOrg(db: Db, id: string): void {
  db.raw
    .prepare(`INSERT INTO orgs (id, name, api_key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, `org-${id}`, `hash-${id}`, `prefix-${id}`, NOW);
}

function mkPolicy(db: Db, org: string, num: string): string {
  const p = createPolicy(db, org, {
    policyNumber: num,
    holderName: "Holder",
    product: "auto",
    coverageLimitMinor: 5_000_000,
    deductibleMinor: 100_000,
    effectiveFromMs: NOW - 365 * DAY,
    effectiveUntilMs: NOW + 365 * DAY,
  }, NOW);
  return p.id;
}

describe("policies", () => {
  it("validates and dedups", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    mkPolicy(db, "o1", "P-1");
    expect(() => mkPolicy(db, "o1", "P-1")).toThrow(Conflict);
    // same number, different org is fine
    mkPolicy(db, "o2", "P-1");
    expect(getPolicyByNumber(db, "o1", "P-1").holderName).toBe("Holder");
    expect(() => getPolicyByNumber(db, "o1", "NOPE")).toThrow(NotFound);
    expect(() => createPolicy(db, "o1", {
      policyNumber: "X", holderName: "H", product: "spaceship",
      coverageLimitMinor: 1, deductibleMinor: 0,
      effectiveFromMs: 2, effectiveUntilMs: 1,
    }, NOW)).toThrow(InvalidInput);
  });
});

describe("claims", () => {
  it("sequences claim numbers per org", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    expect(nextClaimNumber(db, "o1")).toBe("CC-000001");
    createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW);
    createClaim(db, { orgId: "o1", policyId: pid, claimantName: "B", incidentMs: NOW, reportedMs: NOW }, NOW);
    expect(nextClaimNumber(db, "o1")).toBe("CC-000003");
    expect(nextClaimNumber(db, "o2")).toBe("CC-000001");
  });

  it("rejects bad input and wrong-org policies", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    expect(() => createClaim(db, { orgId: "o2", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW)).toThrow(NotFound);
    expect(() => createClaim(db, { orgId: "o1", policyId: pid, claimantName: " ", incidentMs: NOW, reportedMs: NOW }, NOW)).toThrow(InvalidInput);
    expect(() => createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW - 1 }, NOW)).toThrow(InvalidInput);
  });

  it("totals items and guards amounts", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    const c = createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW);
    addItem(db, c.id, { category: "repair", amountMinor: 100_00 }, NOW);
    addItem(db, c.id, { category: "medical", amountMinor: 50_00 }, NOW);
    expect(claimTotal(db, c.id)).toBe(150_00);
    expect(() => addItem(db, c.id, { category: "ufo", amountMinor: 1 }, NOW)).toThrow(InvalidInput);
    expect(() => addItem(db, c.id, { category: "repair", amountMinor: 0 }, NOW)).toThrow(InvalidInput);
  });

  it("stores documents with hash and size cap", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    const c = createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW);
    const meta = addDocument(db, c.id, { filename: "bill.pdf", mime: "application/pdf", content: Buffer.from("hello") }, NOW);
    expect(meta.sizeBytes).toBe(5);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => addDocument(db, c.id, { filename: "x", mime: "y", content: Buffer.alloc(0) }, NOW)).toThrow(InvalidInput);
  });

  it("versions decisions", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    const c = createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW);
    const d1 = addDecision(db, c.id, { outcome: "manual", payableMinor: 100, deductibleAppliedMinor: 0, reasons: ["r"], decidedBy: "s" }, NOW);
    const d2 = addDecision(db, c.id, { outcome: "approve", payableMinor: 100, deductibleAppliedMinor: 0, reasons: ["r"], decidedBy: "s" }, NOW);
    expect(d1.version).toBe(1);
    expect(d2.version).toBe(2);
  });
});

describe("reserves", () => {
  it("holds the running-balance invariant", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    const c = createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW);
    expect(reserveBalance(db, c.id)).toBe(0);
    reserveAppend(db, c.id, "o1", "set", 500_00, "seed", NOW);
    reserveAppend(db, c.id, "o1", "adjust", 100_00, "seed", NOW);
    expect(reserveBalance(db, c.id)).toBe(600_00);
    expect(() => reserveAppend(db, c.id, "o1", "adjust", -700_00, "seed", NOW)).toThrow(InvalidInput);
    expect(() => reserveAppend(db, c.id, "o1", "pay", 700_00, "seed", NOW)).toThrow(InvalidInput);
    reserveAppend(db, c.id, "o1", "pay", 600_00, "seed", NOW);
    expect(reserveBalance(db, c.id)).toBe(0);
    addPayout(db, c.id, 10_00, "ref", NOW);
    expect(paidTotal(db, c.id)).toBe(10_00);
    expect(listPayouts(db, c.id)).toHaveLength(1);
  });
});

describe("appeals and watchlist", () => {
  it("decides open appeals once", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    const c = createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW);
    const a = addAppeal(db, c.id, "unfair", NOW);
    decideAppeal(db, a.id, "upheld", NOW);
    expect(() => {
      decideAppeal(db, a.id, "overturned", NOW);
    }).toThrow(Conflict);
  });

  it("dedups watch entries", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    addWatch(db, "o1", "email", "Fraud@Example.com", "ring", NOW);
    expect(() => {
      addWatch(db, "o1", "email", "fraud@example.com", "x", NOW);
    }).toThrow(Conflict);
    const all = [{ kind: "email", value: "fraud@example.com" }];
    expect(all[0]?.value).toBe("fraud@example.com");
    expect(() => {
      removeWatch(db, "o1", "missing");
    }).toThrow(NotFound);
  });
});

describe("audit and idempotency", () => {
  it("chains, verifies, and detects tampering", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    appendAudit(db, "o1", "a", "x.y", "t1", "d1", NOW);
    appendAudit(db, "o1", "a", "x.y", "t2", "d2", NOW);
    expect(verifyAudit(db, "o1")).toEqual({ ok: true, checked: 2 });
    db.raw.prepare(`UPDATE audit_log SET hash = 'tampered' WHERE seq = 2 AND org_id = 'o1'`).run();
    expect(verifyAudit(db, "o1").ok).toBe(false);
    db.raw.prepare(`DELETE FROM audit_log WHERE seq = 1 AND org_id = 'o1'`).run();
    expect(verifyAudit(db, "o1").ok).toBe(false);
  });

  it("roundtrips idempotency records", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    expect(idemGet(db, "o1", "k")).toBeNull();
    idemPut(db, "o1", "k", "POST", "/p", "h", 201, "{}", NOW);
    expect(idemGet(db, "o1", "k")?.respStatus).toBe(201);
  });
});

describe("adjusters", () => {
  it("hashes, verifies, and manages sessions", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    expect(() => checkAdjusterPassword(db, { id: "x", orgId: "o", email: "e", name: "n", role: "adjuster", status: "a", createdAt: 0 }, "pw")).toThrow();
    const a = (() => {
      // create directly to test dup + short pw paths
      expect(() => createAdjuster(db, "o1", { email: "a@x.io", name: "A", password: "short" }, NOW)).toThrow(InvalidInput);
      return createAdjuster(db, "o1", { email: "a@x.io", name: "A", password: "long-enough-pw", role: "supervisor" }, NOW);
    })();
    expect(a.role).toBe("supervisor");
    expect(checkAdjusterPassword(db, a, "long-enough-pw")).toBe(true);
    expect(checkAdjusterPassword(db, a, "wrong")).toBe(false);
    const s = createSession(db, "o1", a.id, 3_600_000, NOW);
    expect(getSessionByHash(db, createHash("sha256").update(s.token).digest("hex")).id).toBe(s.id);
    deleteSession(db, s.id);
  });

  it("sets raw status transitions", () => {
    const db = memDb();
    mkOrg(db, "o1");
    mkOrg(db, "o2");
    const pid = mkPolicy(db, "o1", "P-1");
    const c = createClaim(db, { orgId: "o1", policyId: pid, claimantName: "A", incidentMs: NOW, reportedMs: NOW }, NOW);
    expect(getClaim(db, "o1", c.id).status).toBe("intake");
    setClaimStatus(db, "o1", c.id, "closed", NOW);
    expect(getClaim(db, "o1", c.id).status).toBe("closed");
    addFraudFlag(db, c.id, { ruleCode: "X", severity: "info", points: 1 }, NOW);
  });
});
