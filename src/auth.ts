import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { nowMs, type Db } from "./db.js";
import { checkAdjusterPassword, createSession, deleteSession, getAdjuster, getAdjusterByEmail, getSessionByHash } from "./store/users.js";
import { NotFound } from "./store/errors.js";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function newApiKey(pepper: string): { raw: string; hash: string; prefix: string } {
  const raw = `cc_live_${randomBytes(16).toString("hex")}`;
  return { raw, hash: hashApiKey(pepper, raw), prefix: raw.slice(-8) };
}

export function hashApiKey(pepper: string, raw: string): string {
  return createHash("sha256").update(`${pepper}::${raw}`).digest("hex");
}

export interface Identity {
  orgId: string;
  adjusterId: string | null;
  role: "adjuster" | "supervisor" | null;
  kind: "api_key" | "session";
}

interface OrgRow {
  id: string;
}

export function authenticateApiKey(db: Db, pepper: string, raw: string): Identity {
  if (raw === "" || !raw.startsWith("cc_live_")) throw new HttpError(401, "invalid API key");
  const want = hashApiKey(pepper, raw);
  const rows = db.raw.prepare(`SELECT id, api_key_hash FROM orgs`).all() as unknown as (OrgRow & { api_key_hash: string })[];
  for (const r of rows) {
    const a = Buffer.from(r.api_key_hash, "hex");
    const b = Buffer.from(want, "hex");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { orgId: r.id, adjusterId: null, role: null, kind: "api_key" };
    }
  }
  throw new HttpError(401, "invalid API key");
}

export function resolveIdentity(db: Db, pepper: string, req: Request): Identity {
  const apiKey = req.header("X-API-Key") ?? "";
  if (apiKey !== "") return authenticateApiKey(db, pepper, apiKey);
  const auth = req.header("Authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (m?.[1] === undefined) throw new HttpError(401, "missing credentials");
  const tokenHash = createHash("sha256").update(m[1]).digest("hex");
  let session;
  try {
    session = getSessionByHash(db, tokenHash);
  } catch (err) {
    if (err instanceof NotFound) throw new HttpError(401, "invalid session");
    throw err;
  }
  if (session.expiresAt <= nowMs()) {
    deleteSession(db, session.id);
    throw new HttpError(401, "session expired");
  }
  const adjuster = getAdjuster(db, session.orgId, session.adjusterId);
  if (adjuster.status !== "active") throw new HttpError(401, "adjuster suspended");
  return { orgId: session.orgId, adjusterId: adjuster.id, role: adjuster.role, kind: "session" };
}

export function loginAdjuster(
  db: Db,
  orgId: string,
  email: string,
  password: string,
  ttlMs: number,
): { token: string; expiresAt: number; adjusterId: string; role: string } {
  const now = nowMs();
  let adjuster;
  try {
    adjuster = getAdjusterByEmail(db, orgId, email);
  } catch (err) {
    if (err instanceof NotFound) throw new HttpError(401, "invalid credentials");
    throw err;
  }
  if (adjuster.status !== "active" || !checkAdjusterPassword(db, adjuster, password)) {
    throw new HttpError(401, "invalid credentials");
  }
  const s = createSession(db, orgId, adjuster.id, ttlMs, now);
  return { token: s.token, expiresAt: s.expiresAt, adjusterId: adjuster.id, role: adjuster.role };
}
