import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { newId, type Db } from "../db.js";
import { Conflict, InvalidInput, NotFound } from "./errors.js";

export interface Adjuster {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: "adjuster" | "supervisor";
  status: string;
  createdAt: number;
}

interface AdjusterRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: number;
}

function toAdjuster(r: AdjusterRow): Adjuster {
  return {
    id: r.id,
    orgId: r.org_id,
    email: r.email,
    name: r.name,
    role: r.role as Adjuster["role"],
    status: r.status,
    createdAt: r.created_at,
  };
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function hashPassword(password: string): string {
  if (password.length < 10) throw new InvalidInput("password must be at least 10 characters");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, want] = parts as [string, string, string, string, string, string];
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  const wantBuf = Buffer.from(want, "hex");
  if (derived.length !== wantBuf.length) return false;
  return timingSafeEqual(derived, wantBuf);
}

export function createAdjuster(
  db: Db,
  orgId: string,
  input: { email: string; name: string; password: string; role?: string },
  now: number,
): Adjuster {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new InvalidInput("invalid email");
  if (input.name.trim() === "") throw new InvalidInput("name must not be empty");
  const roleRaw = input.role ?? "adjuster";
  if (roleRaw !== "adjuster" && roleRaw !== "supervisor") throw new InvalidInput(`unknown role ${roleRaw}`);
  const role: Adjuster["role"] = roleRaw;
  const id = newId();
  try {
    db.raw
      .prepare(`INSERT INTO adjusters (id, org_id, email, name, password_hash, role, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, orgId, email, input.name.trim(), hashPassword(input.password), role, now);
  } catch (err) {
    if (err instanceof InvalidInput) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint failed")) throw new Conflict(`adjuster ${email} exists`);
    throw err;
  }
  return getAdjuster(db, orgId, id);
}

export function getAdjuster(db: Db, orgId: string, id: string): Adjuster {
  const row = db.raw
    .prepare(`SELECT * FROM adjusters WHERE id = ? AND org_id = ?`)
    .get(id, orgId) as unknown as AdjusterRow | undefined;
  if (row === undefined) throw new NotFound(`adjuster ${id} not found`);
  return toAdjuster(row);
}

export function getAdjusterByEmail(db: Db, orgId: string, email: string): Adjuster {
  const row = db.raw
    .prepare(`SELECT * FROM adjusters WHERE org_id = ? AND email = ?`)
    .get(orgId, email.trim().toLowerCase()) as unknown as AdjusterRow | undefined;
  if (row === undefined) throw new NotFound(`adjuster ${email} not found`);
  return toAdjuster(row);
}

function getPasswordHash(db: Db, id: string): string {
  const row = db.raw.prepare(`SELECT password_hash FROM adjusters WHERE id = ?`).get(id) as unknown as
    | { password_hash: string }
    | undefined;
  if (row === undefined) throw new NotFound("adjuster not found");
  return row.password_hash;
}

export function checkAdjusterPassword(db: Db, adjuster: Adjuster, password: string): boolean {
  return verifyPassword(getPasswordHash(db, adjuster.id), password);
}

export interface SessionToken {
  id: string;
  token: string;
  expiresAt: number;
}

export function createSession(db: Db, orgId: string, adjusterId: string, ttlMs: number, now: number): SessionToken {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const id = newId();
  db.raw
    .prepare(`INSERT INTO sessions (id, org_id, adjuster_id, token_hash, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, adjusterId, tokenHash, now + ttlMs, now);
  return { id, token, expiresAt: now + ttlMs };
}

export function getSessionByHash(db: Db, tokenHash: string): { id: string; orgId: string; adjusterId: string; expiresAt: number } {
  const row = db.raw.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) as unknown as
    | { id: string; org_id: string; adjuster_id: string; expires_at: number }
    | undefined;
  if (row === undefined) throw new NotFound("session not found");
  return { id: row.id, orgId: row.org_id, adjusterId: row.adjuster_id, expiresAt: row.expires_at };
}

export function deleteSession(db: Db, id: string): void {
  db.raw.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}
