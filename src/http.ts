import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { HttpError, resolveIdentity, type Identity } from "./auth.js";
import { Conflict, InvalidInput, NotFound } from "./store/errors.js";
import { idemGet, idemPut } from "./store/audit.js";
import { MoneyError } from "./money.js";
import { WorkflowError } from "./engine/workflow.js";

export interface AuthedRequest extends Request {
  identity: Identity;
}

export function authMiddleware(db: Db, pepper: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      (req as AuthedRequest).identity = resolveIdentity(db, pepper, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireSupervisor(req: Request, _res: Response, next: NextFunction): void {
  const id = (req as AuthedRequest).identity;
  if (id.role !== "supervisor") {
    next(new HttpError(403, "supervisor role required"));
    return;
  }
  next();
}

export function actorOf(req: Request): string {
  const id = (req as AuthedRequest).identity;
  return id.adjusterId ?? "api_key";
}

/** Safe string field reader: objects/arrays become "" instead of "[object Object]". */
export function str(record: Record<string, unknown>, key: string): string {
  const v: unknown = record[key];
  return typeof v === "string" ? v : "";
}

/** Coerce unknown to string, "" for anything non-string. */
export function ustr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Path params are string|undefined under noUncheckedIndexedAccess. */
export function pathParam(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || v === "") throw new HttpError(400, `missing path param ${name}`);
  return v;
}

export function orgOf(req: Request): string {
  return (req as AuthedRequest).identity.orgId;
}

export function paginate(req: Request, cfg: AppConfig): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(req.query["limit"] ?? cfg.pageSize), 1), cfg.maxPageSize);
  const offset = Math.max(Number(req.query["offset"] ?? 0), 0);
  return { limit: Number.isFinite(limit) ? limit : cfg.pageSize, offset: Number.isFinite(offset) ? offset : 0 };
}

/** Idempotency-Key protocol. Returns "replayed" if a stored response was sent. */
export function checkIdempotency(
  db: Db,
  req: Request,
  res: Response,
): { key: string; reqHash: string } | { replayed: true } {
  const key = req.header("Idempotency-Key") ?? "";
  if (key === "") return { key: "", reqHash: "" };
  if (key.length < 8 || key.length > 64) throw new HttpError(422, "Idempotency-Key must be 8..64 chars");
  const orgId = orgOf(req);
  const raw = JSON.stringify(req.body ?? {});
  const reqHash = createHash("sha256").update(raw).digest("hex");
  const rec = idemGet(db, orgId, key);
  if (rec !== null) {
    if (rec.reqHash !== reqHash) throw new HttpError(409, "Idempotency-Key already used with different payload");
    res.status(rec.respStatus).json(JSON.parse(rec.respBody) as unknown);
    return { replayed: true };
  }
  return { key, reqHash };
}

export function storeIdempotency(
  db: Db,
  req: Request,
  path: string,
  key: string,
  reqHash: string,
  status: number,
  body: unknown,
): void {
  if (key === "") return;
  idemPut(db, orgOf(req), key, req.method, path, reqHash, status, JSON.stringify(body), Date.now());
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof NotFound) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof Conflict) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof InvalidInput || err instanceof MoneyError || err instanceof WorkflowError) {
    res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (err instanceof SyntaxError && "body" in (err as unknown as Record<string, unknown>)) {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }
  // express.json limit errors (entity.too.large) carry a numeric status.
  const statusProp = (err as { status?: unknown }).status;
  if (typeof statusProp === "number" && Number.isInteger(statusProp) && statusProp >= 400 && statusProp < 500) {
    res.status(statusProp).json({ error: err instanceof Error ? err.message : "bad request" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal error" });
}
