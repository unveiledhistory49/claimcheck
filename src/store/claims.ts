import { createHash } from "node:crypto";
import { newId, type Db } from "../db.js";
import type { Claim, ClaimItem, ClaimStatus, Decision, FraudFlag, ItemCategory } from "../types.js";
import { Conflict, InvalidInput, NotFound } from "./errors.js";

const CATEGORIES: ItemCategory[] = ["medical", "repair", "property", "other"];
const STATUSES: ClaimStatus[] = [
  "intake",
  "validating",
  "fraud_review",
  "adjudicating",
  "approved",
  "denied",
  "paid",
  "closed",
  "appealed",
];

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed");
}

interface ClaimRow {
  id: string;
  org_id: string;
  claim_number: string;
  policy_id: string;
  claimant_name: string;
  claimant_email: string;
  incident_ms: number;
  reported_ms: number;
  description: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function toClaim(r: ClaimRow): Claim {
  return {
    id: r.id,
    orgId: r.org_id,
    claimNumber: r.claim_number,
    policyId: r.policy_id,
    claimantName: r.claimant_name,
    claimantEmail: r.claimant_email,
    incidentMs: r.incident_ms,
    reportedMs: r.reported_ms,
    description: r.description,
    status: r.status as ClaimStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Next human-readable claim number, per org: CC-000001, CC-000002, … */
export function nextClaimNumber(db: Db, orgId: string): string {
  const row = db.raw
    .prepare(`SELECT claim_number FROM claims WHERE org_id = ? ORDER BY claim_number DESC LIMIT 1`)
    .get(orgId) as unknown as { claim_number: string } | undefined;
  let n = 0;
  if (row !== undefined) {
    const m = /^CC-(\d+)$/.exec(row.claim_number);
    if (m?.[1] !== undefined) n = Number(m[1]);
  }
  return `CC-${String(n + 1).padStart(6, "0")}`;
}

export interface ClaimInput {
  orgId: string;
  policyId: string;
  claimantName: string;
  claimantEmail?: string;
  incidentMs: number;
  reportedMs: number;
  description?: string;
}

export function createClaim(db: Db, input: ClaimInput, now: number): Claim {
  const policy = db.raw
    .prepare(`SELECT id FROM policies WHERE id = ? AND org_id = ?`)
    .get(input.policyId, input.orgId) as unknown as { id: string } | undefined;
  if (policy === undefined) throw new NotFound(`policy ${input.policyId} not found`);
  const claimantName = input.claimantName.trim();
  if (claimantName === "") throw new InvalidInput("claimant name must not be empty");
  if (!Number.isInteger(input.incidentMs) || input.incidentMs <= 0) {
    throw new InvalidInput("incidentMs must be a positive integer");
  }
  if (!Number.isInteger(input.reportedMs) || input.reportedMs < input.incidentMs) {
    throw new InvalidInput("reportedMs must be >= incidentMs");
  }
  const id = newId();
  const claimNumber = nextClaimNumber(db, input.orgId);
  db.raw
    .prepare(
      `INSERT INTO claims (id, org_id, claim_number, policy_id, claimant_name,
       claimant_email, incident_ms, reported_ms, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intake', ?, ?)`,
    )
    .run(
      id,
      input.orgId,
      claimNumber,
      input.policyId,
      claimantName,
      (input.claimantEmail ?? "").trim(),
      input.incidentMs,
      input.reportedMs,
      (input.description ?? "").trim(),
      now,
      now,
    );
  return getClaim(db, input.orgId, id);
}

export function getClaim(db: Db, orgId: string, id: string): Claim {
  const row = db.raw
    .prepare(`SELECT * FROM claims WHERE id = ? AND org_id = ?`)
    .get(id, orgId) as unknown as ClaimRow | undefined;
  if (row === undefined) throw new NotFound(`claim ${id} not found`);
  return toClaim(row);
}

export function listClaims(db: Db, orgId: string, status?: ClaimStatus): Claim[] {
  const rows =
    status === undefined
      ? (db.raw.prepare(`SELECT * FROM claims WHERE org_id = ? ORDER BY created_at`).all(orgId) as unknown as ClaimRow[])
      : (db.raw
          .prepare(`SELECT * FROM claims WHERE org_id = ? AND status = ? ORDER BY created_at`)
          .all(orgId, status) as unknown as ClaimRow[]);
  return rows.map(toClaim);
}

export function setClaimStatus(db: Db, orgId: string, id: string, status: ClaimStatus, now: number): Claim {
  if (!STATUSES.includes(status)) throw new InvalidInput(`unknown status ${status}`);
  const res = db.raw
    .prepare(`UPDATE claims SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?`)
    .run(status, now, id, orgId);
  if (Number(res.changes) === 0) throw new NotFound(`claim ${id} not found`);
  return getClaim(db, orgId, id);
}

// ---- items ----

interface ItemRow {
  id: string;
  claim_id: string;
  category: string;
  description: string;
  amount_minor: number;
  created_at: number;
}

function toItem(r: ItemRow): ClaimItem {
  return {
    id: r.id,
    claimId: r.claim_id,
    category: r.category as ItemCategory,
    description: r.description,
    amountMinor: r.amount_minor,
    createdAt: r.created_at,
  };
}

export function addItem(
  db: Db,
  claimId: string,
  input: { category: string; description?: string; amountMinor: number },
  now: number,
): ClaimItem {
  if (!CATEGORIES.includes(input.category as ItemCategory)) {
    throw new InvalidInput(`unknown category ${JSON.stringify(input.category)}`);
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new InvalidInput("item amount must be a positive integer");
  }
  const id = newId();
  db.raw
    .prepare(`INSERT INTO claim_items (id, claim_id, category, description, amount_minor, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, claimId, input.category, (input.description ?? "").trim(), input.amountMinor, now);
  const row = db.raw.prepare(`SELECT * FROM claim_items WHERE id = ?`).get(id) as unknown as ItemRow;
  return toItem(row);
}

export function listItems(db: Db, claimId: string): ClaimItem[] {
  const rows = db.raw
    .prepare(`SELECT * FROM claim_items WHERE claim_id = ? ORDER BY created_at`)
    .all(claimId) as unknown as ItemRow[];
  return rows.map(toItem);
}

export function claimTotal(db: Db, claimId: string): number {
  const row = db.raw
    .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM claim_items WHERE claim_id = ?`)
    .get(claimId) as unknown as { total: number };
  return row.total;
}

// ---- documents ----

export const MAX_DOC_BYTES = 5 * 1024 * 1024;

export interface DocMeta {
  id: string;
  claimId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

interface DocRow extends DocMeta {
  claim_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  created_at: number;
  content: Buffer;
}

function toDocMeta(r: DocRow): DocMeta {
  return {
    id: r.id,
    claimId: r.claim_id,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    createdAt: r.created_at,
  };
}

export function addDocument(
  db: Db,
  claimId: string,
  input: { filename: string; mime: string; content: Buffer },
  now: number,
): DocMeta {
  const filename = input.filename.trim();
  if (filename === "") throw new InvalidInput("filename must not be empty");
  if (input.mime.trim() === "") throw new InvalidInput("mime must not be empty");
  if (input.content.length === 0 || input.content.length > MAX_DOC_BYTES) {
    throw new InvalidInput(`document must be 1..${MAX_DOC_BYTES} bytes`);
  }
  const id = newId();
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  db.raw
    .prepare(`INSERT INTO documents (id, claim_id, filename, mime, size_bytes, sha256, content, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, claimId, filename, input.mime.trim(), input.content.length, sha256, input.content, now);
  return { id, claimId, filename, mime: input.mime.trim(), sizeBytes: input.content.length, sha256, createdAt: now };
}

export function listDocuments(db: Db, claimId: string): DocMeta[] {
  const rows = db.raw
    .prepare(
      `SELECT id, claim_id, filename, mime, size_bytes, sha256, created_at FROM documents
       WHERE claim_id = ? ORDER BY created_at`,
    )
    .all(claimId) as unknown as DocRow[];
  return rows.map(toDocMeta);
}

export function getDocument(db: Db, claimId: string, id: string): DocMeta & { content: Buffer } {
  const row = db.raw
    .prepare(`SELECT * FROM documents WHERE id = ? AND claim_id = ?`)
    .get(id, claimId) as unknown as DocRow | undefined;
  if (row === undefined) throw new NotFound(`document ${id} not found`);
  return { ...toDocMeta(row), content: row.content };
}

// ---- fraud flags ----

interface FlagRow {
  id: string;
  claim_id: string;
  rule_code: string;
  severity: string;
  points: number;
  detail: string;
  created_at: number;
}

function toFlag(r: FlagRow): FraudFlag {
  return {
    id: r.id,
    claimId: r.claim_id,
    ruleCode: r.rule_code,
    severity: r.severity as FraudFlag["severity"],
    points: r.points,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

export function addFraudFlag(
  db: Db,
  claimId: string,
  input: { ruleCode: string; severity: FraudFlag["severity"]; points: number; detail?: string },
  now: number,
): FraudFlag {
  if (!["info", "review", "block"].includes(input.severity)) {
    throw new InvalidInput(`unknown severity ${input.severity}`);
  }
  if (!Number.isInteger(input.points) || input.points < 0) {
    throw new InvalidInput("points must be a non-negative integer");
  }
  const id = newId();
  db.raw
    .prepare(`INSERT INTO fraud_flags (id, claim_id, rule_code, severity, points, detail, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, claimId, input.ruleCode, input.severity, input.points, input.detail ?? "", now);
  const row = db.raw.prepare(`SELECT * FROM fraud_flags WHERE id = ?`).get(id) as unknown as FlagRow;
  return toFlag(row);
}

export function listFraudFlags(db: Db, claimId: string): FraudFlag[] {
  const rows = db.raw
    .prepare(`SELECT * FROM fraud_flags WHERE claim_id = ? ORDER BY created_at`)
    .all(claimId) as unknown as FlagRow[];
  return rows.map(toFlag);
}

// ---- decisions ----

interface DecisionRow {
  id: string;
  claim_id: string;
  version: number;
  outcome: string;
  payable_minor: number;
  deductible_applied_minor: number;
  reasons: string;
  decided_by: string;
  created_at: number;
}

function toDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    claimId: r.claim_id,
    version: r.version,
    outcome: r.outcome as Decision["outcome"],
    payableMinor: r.payable_minor,
    deductibleAppliedMinor: r.deductible_applied_minor,
    reasons: JSON.parse(r.reasons) as string[],
    decidedBy: r.decided_by,
    createdAt: r.created_at,
  };
}

export function addDecision(
  db: Db,
  claimId: string,
  input: {
    outcome: Decision["outcome"];
    payableMinor: number;
    deductibleAppliedMinor: number;
    reasons: string[];
    decidedBy: string;
  },
  now: number,
): Decision {
  if (!["approve", "deny", "manual"].includes(input.outcome)) {
    throw new InvalidInput(`unknown outcome ${input.outcome}`);
  }
  if (!Number.isInteger(input.payableMinor) || input.payableMinor < 0) {
    throw new InvalidInput("payable must be a non-negative integer");
  }
  const row = db.raw
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM decisions WHERE claim_id = ?`)
    .get(claimId) as unknown as { v: number };
  const id = newId();
  db.raw
    .prepare(`INSERT INTO decisions (id, claim_id, version, outcome, payable_minor,
              deductible_applied_minor, reasons, decided_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      claimId,
      row.v + 1,
      input.outcome,
      input.payableMinor,
      input.deductibleAppliedMinor,
      JSON.stringify(input.reasons),
      input.decidedBy,
      now,
    );
  const saved = db.raw.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as unknown as DecisionRow;
  return toDecision(saved);
}

export function latestDecision(db: Db, claimId: string): Decision {
  const row = db.raw
    .prepare(`SELECT * FROM decisions WHERE claim_id = ? ORDER BY version DESC LIMIT 1`)
    .get(claimId) as unknown as DecisionRow | undefined;
  if (row === undefined) throw new NotFound(`no decisions for claim ${claimId}`);
  return toDecision(row);
}

export function listDecisions(db: Db, claimId: string): Decision[] {
  const rows = db.raw
    .prepare(`SELECT * FROM decisions WHERE claim_id = ? ORDER BY version`)
    .all(claimId) as unknown as DecisionRow[];
  return rows.map(toDecision);
}

// ---- reserves (append-only running-balance ledger) ----

interface ReserveRow {
  id: string;
  claim_id: string;
  org_id: string;
  kind: string;
  amount_minor: number;
  balance_after_minor: number;
  actor: string;
  created_at: number;
}

function toReserve(r: ReserveRow): import("../types.js").ReserveEntry {
  return {
    id: r.id,
    claimId: r.claim_id,
    orgId: r.org_id,
    kind: r.kind as "set" | "adjust" | "release" | "pay",
    amountMinor: r.amount_minor,
    balanceAfterMinor: r.balance_after_minor,
    actor: r.actor,
    createdAt: r.created_at,
  };
}

export function reserveBalance(db: Db, claimId: string): number {
  const row = db.raw
    .prepare(`SELECT balance_after_minor AS b FROM reserve_entries WHERE claim_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(claimId) as unknown as { b: number } | undefined;
  return row?.b ?? 0;
}

export function reserveAppend(
  db: Db,
  claimId: string,
  orgId: string,
  kind: "set" | "adjust" | "release" | "pay",
  amountMinor: number,
  actor: string,
  now: number,
): import("../types.js").ReserveEntry {
  return db.transaction(() => {
    const last = reserveBalance(db, claimId);
    let balance: number;
    let stored = amountMinor;
    if (kind === "set") {
      if (!Number.isInteger(amountMinor) || amountMinor < 0) throw new InvalidInput("set amount must be >= 0");
      balance = amountMinor;
    } else if (kind === "adjust") {
      if (!Number.isInteger(amountMinor)) throw new InvalidInput("adjust amount must be an integer");
      balance = last + amountMinor;
      if (balance < 0) throw new InvalidInput("adjustment would drive reserve negative");
    } else if (kind === "release") {
      balance = 0;
      stored = -last;
    } else {
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new InvalidInput("pay amount must be > 0");
      if (amountMinor > last) throw new InvalidInput("payout exceeds reserve balance");
      balance = last - amountMinor;
    }
    const id = newId();
    db.raw
      .prepare(`INSERT INTO reserve_entries (id, claim_id, org_id, kind, amount_minor,
                balance_after_minor, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, claimId, orgId, kind, stored, balance, actor, now);
    const row = db.raw.prepare(`SELECT * FROM reserve_entries WHERE id = ?`).get(id) as unknown as ReserveRow;
    return toReserve(row);
  });
}

export function listReserves(db: Db, claimId: string): import("../types.js").ReserveEntry[] {
  const rows = db.raw
    .prepare(`SELECT * FROM reserve_entries WHERE claim_id = ? ORDER BY created_at, rowid`)
    .all(claimId) as unknown as ReserveRow[];
  return rows.map(toReserve);
}

// ---- payouts / appeals / watchlist ----

export function addPayout(db: Db, claimId: string, amountMinor: number, reference: string, now: number): import("../types.js").Payout {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new InvalidInput("payout must be > 0");
  const id = newId();
  db.raw
    .prepare(`INSERT INTO payouts (id, claim_id, amount_minor, reference, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, claimId, amountMinor, reference.trim(), now);
  const row = db.raw.prepare(`SELECT * FROM payouts WHERE id = ?`).get(id) as unknown as {
    id: string; claim_id: string; amount_minor: number; reference: string; created_at: number;
  };
  return { id: row.id, claimId: row.claim_id, amountMinor: row.amount_minor, reference: row.reference, createdAt: row.created_at };
}

export function listPayouts(db: Db, claimId: string): import("../types.js").Payout[] {
  const rows = db.raw
    .prepare(`SELECT * FROM payouts WHERE claim_id = ? ORDER BY created_at`)
    .all(claimId) as unknown as { id: string; claim_id: string; amount_minor: number; reference: string; created_at: number }[];
  return rows.map((r) => ({
    id: r.id, claimId: r.claim_id, amountMinor: r.amount_minor, reference: r.reference, createdAt: r.created_at,
  }));
}

export function paidTotal(db: Db, claimId: string): number {
  const row = db.raw
    .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS t FROM payouts WHERE claim_id = ?`)
    .get(claimId) as unknown as { t: number };
  return row.t;
}

interface AppealRow {
  id: string;
  claim_id: string;
  reason: string;
  status: string;
  created_at: number;
  decided_at: number;
}

export function addAppeal(db: Db, claimId: string, reason: string, now: number): { id: string; claimId: string; reason: string; status: string; createdAt: number; decidedAt: number } {
  if (reason.trim() === "") throw new InvalidInput("appeal reason must not be empty");
  const id = newId();
  db.raw
    .prepare(`INSERT INTO appeals (id, claim_id, reason, status, created_at, decided_at) VALUES (?, ?, ?, 'open', ?, 0)`)
    .run(id, claimId, reason.trim(), now);
  const row = db.raw.prepare(`SELECT * FROM appeals WHERE id = ?`).get(id) as unknown as AppealRow;
  return { id: row.id, claimId: row.claim_id, reason: row.reason, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at };
}

export function getAppeal(db: Db, id: string): { id: string; claimId: string; reason: string; status: string; createdAt: number; decidedAt: number } {
  const row = db.raw.prepare(`SELECT * FROM appeals WHERE id = ?`).get(id) as unknown as AppealRow | undefined;
  if (row === undefined) throw new NotFound(`appeal ${id} not found`);
  return { id: row.id, claimId: row.claim_id, reason: row.reason, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at };
}

export function listAppealsByClaim(db: Db, claimId: string): { id: string; status: string }[] {
  const rows = db.raw
    .prepare(`SELECT id, status FROM appeals WHERE claim_id = ? ORDER BY created_at`)
    .all(claimId) as unknown as { id: string; status: string }[];
  return rows;
}

export function decideAppeal(db: Db, id: string, status: string, now: number): void {
  if (status !== "upheld" && status !== "overturned") throw new InvalidInput("bad appeal decision");
  const res = db.raw
    .prepare(`UPDATE appeals SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
    .run(status, now, id);
  if (Number(res.changes) === 0) throw new Conflict(`appeal ${id} is not open`);
}

export interface WatchEntry {
  id: string;
  kind: string;
  value: string;
  reason: string;
}

export function addWatch(db: Db, orgId: string, kind: string, value: string, reason: string, now: number): WatchEntry {
  if (!["name", "email", "phone"].includes(kind)) throw new InvalidInput(`unknown watch kind ${kind}`);
  const v = value.trim().toLowerCase();
  if (v === "") throw new InvalidInput("watch value must not be empty");
  const id = newId();
  try {
    db.raw
      .prepare(`INSERT INTO watchlist (id, org_id, kind, value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, kind, v, reason.trim(), now);
  } catch (err) {
    if (isUniqueViolation(err)) throw new Conflict(`watch entry exists`);
    throw err;
  }
  return { id, kind, value: v, reason: reason.trim() };
}

export function listWatch(db: Db, orgId: string): WatchEntry[] {
  const rows = db.raw
    .prepare(`SELECT id, kind, value, reason FROM watchlist WHERE org_id = ? ORDER BY kind, value`)
    .all(orgId) as unknown as WatchEntry[];
  return rows;
}

export function removeWatch(db: Db, orgId: string, id: string): void {
  const res = db.raw.prepare(`DELETE FROM watchlist WHERE id = ? AND org_id = ?`).run(id, orgId);
  if (Number(res.changes) === 0) throw new NotFound(`watch entry ${id} not found`);
}
