import { createHash } from "node:crypto";
import type { Db } from "../db.js";

export interface AuditEntry {
  seq: number;
  orgId: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  prevHash: string;
  hash: string;
  createdAt: number;
}

interface AuditRow {
  seq: number;
  org_id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  prev_hash: string;
  hash: string;
  created_at: number;
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    seq: r.seq,
    orgId: r.org_id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail,
    prevHash: r.prev_hash,
    hash: r.hash,
    createdAt: r.created_at,
  };
}

export function chainHash(prev: string, orgId: string, actor: string, action: string, target: string, detail: string, seq: number): string {
  return createHash("sha256").update([prev, orgId, actor, action, target, detail, String(seq)].join("\n")).digest("hex");
}

export function appendAudit(
  db: Db,
  orgId: string,
  actor: string,
  action: string,
  target: string,
  detail: string,
  now: number,
): AuditEntry {
  return db.transaction(() => {
    const last = db.raw
      .prepare(`SELECT seq, hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(orgId) as unknown as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? "genesis";
    const hash = chainHash(prev, orgId, actor, action, target, detail, seq);
    db.raw
      .prepare(`INSERT INTO audit_log (seq, org_id, actor, action, target, detail, prev_hash, hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(seq, orgId, actor, action, target, detail, prev, hash, now);
    const row = db.raw.prepare(`SELECT * FROM audit_log WHERE seq = ? AND org_id = ?`).get(seq, orgId) as unknown as AuditRow;
    return toEntry(row);
  });
}

export function listAudit(db: Db, orgId: string, sinceSeq: number, limit: number): AuditEntry[] {
  const rows = db.raw
    .prepare(`SELECT * FROM audit_log WHERE org_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
    .all(orgId, sinceSeq, limit) as unknown as AuditRow[];
  return rows.map(toEntry);
}

export function verifyAudit(db: Db, orgId: string): { ok: boolean; checked: number; error?: string } {
  const rows = db.raw
    .prepare(`SELECT * FROM audit_log WHERE org_id = ? ORDER BY seq`)
    .all(orgId) as unknown as AuditRow[];
  let prev = "genesis";
  let expect = rows.length > 0 ? (rows[0] as AuditRow).seq : 0;
  for (const r of rows) {
    if (r.seq !== expect) return { ok: false, checked: expect, error: `gap at seq ${expect}` };
    if (r.prev_hash !== prev) return { ok: false, checked: r.seq, error: `prev_hash mismatch at seq ${r.seq}` };
    const recomputed = chainHash(r.prev_hash, r.org_id, r.actor, r.action, r.target, r.detail, r.seq);
    if (recomputed !== r.hash) return { ok: false, checked: r.seq, error: `hash mismatch at seq ${r.seq}` };
    prev = r.hash;
    expect += 1;
  }
  return { ok: true, checked: rows.length };
}

export interface IdemRecord {
  method: string;
  path: string;
  reqHash: string;
  respStatus: number;
  respBody: string;
}

export function idemGet(db: Db, orgId: string, key: string): IdemRecord | null {
  const row = db.raw
    .prepare(`SELECT method, path, req_hash, resp_status, resp_body FROM idempotency WHERE org_id = ? AND key = ?`)
    .get(orgId, key) as unknown as
    | { method: string; path: string; req_hash: string; resp_status: number; resp_body: string }
    | undefined;
  if (row === undefined) return null;
  return { method: row.method, path: row.path, reqHash: row.req_hash, respStatus: row.resp_status, respBody: row.resp_body };
}

export function idemPut(
  db: Db,
  orgId: string,
  key: string,
  method: string,
  path: string,
  reqHash: string,
  respStatus: number,
  respBody: string,
  now: number,
): void {
  db.raw
    .prepare(`INSERT INTO idempotency (org_id, key, method, path, req_hash, resp_status, resp_body, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(orgId, key, method, path, reqHash, respStatus, respBody, now);
}
