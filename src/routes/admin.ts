import { Router } from "express";
import type { AppConfig } from "../config.js";
import { nowMs, type Db } from "../db.js";
import { HttpError } from "../auth.js";
import { deleteSession } from "../store/users.js";
import { createHash } from "node:crypto";
import { createAdjuster } from "../store/users.js";
import { addWatch, listWatch, removeWatch } from "../store/claims.js";
import { appendAudit, listAudit, verifyAudit } from "../store/audit.js";
import { dispatchDue } from "../webhooks.js";
import {
  actorOf,
  asyncHandler,
  orgOf,
  paginate,
  pathParam,
  requireSupervisor,
  str,
  ustr,
  type AuthedRequest,
} from "../http.js";

export function adminRoutes(db: Db, cfg: AppConfig): Router {
  const r = Router();

  // ---- adjusters & sessions (supervisor-gated management; login is public, see app.ts) ----
  r.post(
    "/adjusters",
    requireSupervisor,
    asyncHandler(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const roleRaw = b["role"];
      const a = createAdjuster(
        db,
        orgOf(req),
        {
          email: str(b, "email"),
          name: str(b, "name"),
          password: str(b, "password"),
          ...(roleRaw === undefined ? {} : { role: ustr(roleRaw) }),
        },
        nowMs(),
      );
      appendAudit(db, orgOf(req), actorOf(req), "adjusters.create", a.id, a.email, nowMs());
      res.status(201).json({ id: a.id, email: a.email, name: a.name, role: a.role, status: a.status });
    }),
  );

  r.post(
    "/logout",
    asyncHandler(async (req, res) => {
      const auth = req.header("Authorization") ?? "";
      const m = /^Bearer (.+)$/.exec(auth);
      if (m?.[1] !== undefined) {
        const h = createHash("sha256").update(m[1]).digest("hex");
        const row = db.raw.prepare(`SELECT id FROM sessions WHERE token_hash = ?`).get(h) as unknown as
          | { id: string }
          | undefined;
        if (row !== undefined) deleteSession(db, row.id);
      }
      res.status(204).end();
    }),
  );

  r.get(
    "/me",
    asyncHandler(async (req, res) => {
      const id = (req as AuthedRequest).identity;
      res.json({ orgId: id.orgId, adjusterId: id.adjusterId, role: id.role, kind: id.kind });
    }),
  );

  // ---- watchlist ----
  r.post(
    "/watchlist",
    asyncHandler(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const w = addWatch(
        db,
        orgOf(req),
        str(b, "kind"),
        str(b, "value"),
        str(b, "reason"),
        nowMs(),
      );
      appendAudit(db, orgOf(req), actorOf(req), "watchlist.add", w.id, `${w.kind}:${w.value}`, nowMs());
      res.status(201).json(w);
    }),
  );

  r.get(
    "/watchlist",
    asyncHandler(async (req, res) => {
      res.json({ data: listWatch(db, orgOf(req)) });
    }),
  );

  r.delete(
    "/watchlist/:id",
    asyncHandler(async (req, res) => {
      removeWatch(db, orgOf(req), pathParam(req, "id"));
      appendAudit(db, orgOf(req), actorOf(req), "watchlist.remove", pathParam(req, "id"), "", nowMs());
      res.status(204).end();
    }),
  );

  // ---- audit ----
  r.get(
    "/audit",
    asyncHandler(async (req, res) => {
      const { limit } = paginate(req, cfg);
      const since = Number(req.query["since"] ?? 0);
      res.json({ data: listAudit(db, orgOf(req), Number.isFinite(since) ? since : 0, limit) });
    }),
  );

  r.get(
    "/audit/verify",
    asyncHandler(async (req, res) => {
      const result = verifyAudit(db, orgOf(req));
      if (!result.ok) {
        res.status(409).json(result);
        return;
      }
      res.json(result);
    }),
  );

  // ---- webhooks ----
  r.post(
    "/webhook-endpoints",
    asyncHandler(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const url = str(b, "url");
      if (!(url.startsWith("https://") || url.startsWith("http://localhost"))) {
        throw new HttpError(422, "webhook URL must be https (http allowed only for localhost)");
      }
      const secret = str(b, "secret");
      if (secret.length < 16) throw new HttpError(422, "webhook secret must be >= 16 chars");
      const id = crypto.randomUUID().replace(/-/g, "");
      db.raw
        .prepare(`INSERT INTO webhook_endpoints (id, org_id, url, secret, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
        .run(id, orgOf(req), url, secret, nowMs());
      res.status(201).json({ id, url });
    }),
  );

  r.post(
    "/webhooks/dispatch",
    asyncHandler(async (_req, res) => {
      res.json(await dispatchDue(db, cfg));
    }),
  );

  return r;
}
