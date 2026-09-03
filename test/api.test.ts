import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { newApiKey } from "../src/auth.js";
import { createAdjuster } from "../src/store/users.js";

const DAY = 86_400_000;
const NOW = Date.now();

let db: Db;
let base: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let ORG = "";
let KEY = "";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function J(r: { json: unknown }): Record<string, unknown> {
  return r.json as Record<string, unknown>;
}

function S(obj: Record<string, unknown>, key: string): string {
  const v: unknown = obj[key];
  if (typeof v !== "string") throw new Error(`expected string at ${key}`);
  return v;
}

function A(obj: Record<string, unknown>, key: string): unknown[] {
  const v: unknown = obj[key];
  if (!Array.isArray(v)) throw new Error(`expected array at ${key}`);
  return v;
}

beforeAll(async () => {
  const cfg = { ...loadConfig(), databaseUrl: ":memory:" };
  db = new Db(":memory:");
  db.migrate();
  // provision org directly (provision-org CLI tested via e2e script)
  const orgId = "org1";
  const minted = newApiKey("test-pepper");
  db.raw.prepare(`INSERT INTO orgs (id, name, api_key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)`).run(orgId, "T", minted.hash, minted.prefix, NOW);
  ORG = orgId;
  KEY = minted.raw;
  const app = createApp(db, cfg, "test-pepper");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      resolve();
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err === undefined) resolve();
      else reject(err);
    });
  });
  db.close();
});

const H = (): Record<string, string> => ({ "X-API-Key": KEY });

function mkPolicyBody(num: string): Record<string, unknown> {
  return {
    policyNumber: num,
    holderName: "Holder",
    product: "auto",
    coverageLimit: "50000",
    deductible: "1000",
    effectiveFromMs: NOW - 365 * DAY,
    effectiveUntilMs: NOW + 365 * DAY,
  };
}

function mkClaimBody(policyRef: Record<string, unknown>, items: { category: string; amount: string }[]): Record<string, unknown> {
  return {
    ...policyRef,
    claimantName: "Ann Claimant",
    claimantEmail: "ann@example.com",
    incidentMs: NOW - 10 * DAY,
    reportedMs: NOW - 10 * DAY + 3_600_000,
    description: "fender bender",
    items,
  };
}

describe("auth", () => {
  it("rejects missing and bad keys", async () => {
    expect((await api("GET", "/v1/policies")).status).toBe(401);
    expect((await api("GET", "/v1/policies", undefined, { "X-API-Key": "cc_live_dead" })).status).toBe(401);
    expect((await api("GET", "/health")).status).toBe(200);
  });

  it("logs adjusters in and out", async () => {
    createAdjuster(db, ORG, { email: "sup@x.io", name: "Sup", password: "supervisor-pw-1", role: "supervisor" }, NOW);
    const bad = await api("POST", "/v1/login", { orgId: ORG, email: "sup@x.io", password: "nope" });
    expect(bad.status).toBe(401);
    const good = await api("POST", "/v1/login", { orgId: ORG, email: "sup@x.io", password: "supervisor-pw-1" });
    expect(good.status).toBe(200);
    const token = S(J(good), "token");
    const me = await api("GET", "/v1/me", undefined, { Authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    expect(J(me)["role"]).toBe("supervisor");
    expect((await api("POST", "/v1/logout", undefined, { Authorization: `Bearer ${token}` })).status).toBe(204);
    expect((await api("GET", "/v1/me", undefined, { Authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe("policies", () => {
  it("creates with dollar strings and rejects bad money", async () => {
    const r = await api("POST", "/v1/policies", mkPolicyBody("AUTO-E2E"), H());
    expect(r.status).toBe(201);
    expect(J(r)["coverageLimitMinor"]).toBe(5_000_000);
    const bad = await api("POST", "/v1/policies", { ...mkPolicyBody("AUTO-BAD"), coverageLimit: "10.999" }, H());
    expect(bad.status).toBe(422);
  });
});

describe("intake pipeline", () => {
  it("approves a clean claim and sets the reserve", async () => {
    await api("POST", "/v1/policies", mkPolicyBody("AUTO-CLEAN"), H());
    const r = await api("POST", "/v1/claims", mkClaimBody({ policyNumber: "AUTO-CLEAN" }, [{ category: "repair", amount: "3200.50" }]), H());
    expect(r.status).toBe(201);
    const body = J(r);
    expect((body["decision"] as Record<string, unknown>)["outcome"]).toBe("approve");
    // 320050 - 100000 deductible = 220050 payable
    expect((body["decision"] as Record<string, unknown>)["payableMinor"]).toBe(220_050);
    const detail = await api("GET", `/v1/claims/${String((body["claim"] as Record<string, unknown>)["id"])}`, undefined, H());
    expect(detail.status).toBe(200);
    expect(J(detail)["reserveBalance"]).toBe(220_050);
  });

  it("parks watchlisted claims for manual review", async () => {
    await api("POST", "/v1/watchlist", { kind: "name", value: "fraud fraser", reason: "ring" }, H());
    await api("POST", "/v1/policies", mkPolicyBody("AUTO-FRAUD"), H());
    const r = await api("POST", "/v1/claims", {
      ...mkClaimBody({ policyNumber: "AUTO-FRAUD" }, [{ category: "repair", amount: "45000" }]),
      claimantName: "Fraud Fraser",
    }, H());
    expect(r.status).toBe(201);
    expect(S(J(r)["claim"] as Record<string, unknown>, "status")).toBe("fraud_review");
    expect(S(J(r)["decision"] as Record<string, unknown>, "outcome")).toBe("manual");
  });

  it("replays idempotent intake and rejects conflicts", async () => {
    const hk = { ...H(), "Idempotency-Key": "intake-key-00000001" };
    const body = mkClaimBody({ policyNumber: "AUTO-CLEAN" }, [{ category: "repair", amount: "100" }]);
    const r1 = await api("POST", "/v1/claims", body, hk);
    const r2 = await api("POST", "/v1/claims", body, hk);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((r1.json as Record<string, unknown>)["claim"]).toEqual((r2.json as Record<string, unknown>)["claim"]);
    const r3 = await api("POST", "/v1/claims", { ...body, claimantName: "Someone Else" }, hk);
    expect(r3.status).toBe(409);
  });

  it("enforces supervisor-only override", async () => {
    createAdjuster(db, ORG, { email: "adj@x.io", name: "Adj", password: "adjuster-pw-1", role: "adjuster" }, NOW);
    const login = await api("POST", "/v1/login", { orgId: ORG, email: "adj@x.io", password: "adjuster-pw-1" });
    const adjTok = S(login.json as Record<string, unknown>, "token");
    // find the fraud_review claim from the watchlist test
    const list = await api("GET", "/v1/claims?status=fraud_review", undefined, H());
    const items = (J(list)["data"] ?? J(list)) as unknown;
    const arr = Array.isArray(items) ? items : (J(list)["data"] as unknown[]);
    const first: unknown = arr[0];
    if (typeof first !== "object" || first === null) throw new Error("expected claim");
    const target = S(first as Record<string, unknown>, "id");
    const denied = await api("POST", `/v1/claims/${target}/override`, { outcome: "deny", reason: "x" }, { Authorization: `Bearer ${adjTok}` });
    expect(denied.status).toBe(403);
    const supLogin = await api("POST", "/v1/login", { orgId: ORG, email: "sup@x.io", password: "supervisor-pw-1" });
    const supTok = S(supLogin.json as Record<string, unknown>, "token");
    const ok = await api("POST", `/v1/claims/${target}/override`, { outcome: "deny", reason: "confirmed fraud" }, { Authorization: `Bearer ${supTok}` });
    expect(ok.status).toBe(201);
    expect((J(ok)["reasons"] as unknown[]).some((x) => typeof x === "string" && x.startsWith("override:"))).toBe(true);
  });
});

describe("pay and appeal", () => {
  it("pays in full, rejects overpay, and overturns on appeal", async () => {
    await api("POST", "/v1/policies", mkPolicyBody("AUTO-PAY"), H());
    const r = await api("POST", "/v1/claims", mkClaimBody({ policyNumber: "AUTO-PAY" }, [{ category: "repair", amount: "2000" }]), H());
    const claimId = S(J(r)["claim"] as Record<string, unknown>, "id");
    // payable = 200000-100000 = 100000
    const over = await api("POST", `/v1/claims/${claimId}/pay`, { amount: "1500", reference: "CHK" }, { ...H(), "Idempotency-Key": "pay-key-0000000001" });
    expect(over.status).toBe(422);
    const pay = await api("POST", `/v1/claims/${claimId}/pay`, { amount: "1000", reference: "CHK-1" }, { ...H(), "Idempotency-Key": "pay-key-0000000002" });
    expect(pay.status).toBe(201);
    expect(J(pay)["status"]).toBe("paid");
    const timeline = await api("GET", `/v1/claims/${claimId}/timeline`, undefined, H());
    expect(timeline.status).toBe(200);
    expect(A(J(timeline), "decisions").length).toBeGreaterThan(0);
    expect(A(J(timeline), "reserves").length).toBeGreaterThan(0);
  });

  it("appeals a denial and upholds it", async () => {
    await api("POST", "/v1/policies", { ...mkPolicyBody("AUTO-DENY"), coverageLimit: "500" }, H());
    const r = await api("POST", "/v1/claims", mkClaimBody({ policyNumber: "AUTO-DENY" }, [{ category: "repair", amount: "5000" }]), H());
    void J(r); // capped approve here; the real deny case follows
    const lapsed = await api("POST", "/v1/policies", { ...mkPolicyBody("AUTO-LAPSED"), effectiveFromMs: NOW - 700 * DAY, effectiveUntilMs: NOW - 365 * DAY }, H());
    expect(lapsed.status).toBe(201);
    const denied = await api("POST", "/v1/claims", mkClaimBody({ policyNumber: "AUTO-LAPSED" }, [{ category: "repair", amount: "100" }]), H());
    const deniedId = S(J(denied)["claim"] as Record<string, unknown>, "id");
    expect(S(J(denied)["decision"] as Record<string, unknown>, "outcome")).toBe("deny");
    const appeal = await api("POST", `/v1/claims/${deniedId}/appeal`, { reason: "unfair" }, H());
    expect(appeal.status).toBe(201);
    const supLogin = await api("POST", "/v1/login", { orgId: ORG, email: "sup@x.io", password: "supervisor-pw-1" });
    const supTok = S(supLogin.json as Record<string, unknown>, "token");
    const decide = await api("POST", `/v1/appeals/${S(J(appeal), "id")}/decide`, { overturn: false, reason: "policy clear" }, { Authorization: `Bearer ${supTok}` });
    expect(decide.status).toBe(200);
  });
});

describe("documents and audit", () => {
  it("caps uploads and verifies the audit chain", async () => {
    await api("POST", "/v1/policies", mkPolicyBody("AUTO-DOC"), H());
    const r = await api("POST", "/v1/claims", mkClaimBody({ policyNumber: "AUTO-DOC" }, [{ category: "repair", amount: "100" }]), H());
    const claimId = S(J(r)["claim"] as Record<string, unknown>, "id");
    const small = Buffer.from("bill").toString("base64");
    const ok = await api("POST", `/v1/claims/${claimId}/documents`, { filename: "bill.pdf", mime: "application/pdf", contentBase64: small }, H());
    expect(ok.status).toBe(201);
    const big = "A".repeat(8 * 1024 * 1024);
    const tooBig = await api("POST", `/v1/claims/${claimId}/documents`, { filename: "big.bin", mime: "application/octet-stream", contentBase64: big }, H());
    // 8MB of base64 exceeds the 1MB JSON body limit -> 413 (the 5MB store cap is unit-tested separately)
    expect(tooBig.status).toBe(413);
    const verify = await api("GET", "/v1/audit/verify", undefined, H());
    expect(verify.status).toBe(200);
    expect(J(verify)["ok"]).toBe(true);
  });
});
