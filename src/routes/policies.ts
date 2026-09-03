import { Router } from "express";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import { parseAmountToMinor } from "../money.js";
import { createPolicy, getPolicy, listPolicies } from "../store/policies.js";
import { appendAudit } from "../store/audit.js";
import { nowMs } from "../db.js";
import { actorOf, asyncHandler, checkIdempotency, orgOf, paginate, pathParam, storeIdempotency, str, ustr } from "../http.js";

export function policyRoutes(db: Db, _cfg: AppConfig): Router {
  const r = Router();

  r.post(
    "/",
    asyncHandler(async (req, res) => {
      const check = checkIdempotency(db, req, res);
      if ("replayed" in check) return;
      const b = req.body as Record<string, unknown>;
      const statusRaw = b["status"];
      const policy = createPolicy(
        db,
        orgOf(req),
        {
          policyNumber: str(b, "policyNumber"),
          holderName: str(b, "holderName"),
          product: str(b, "product"),
          coverageLimitMinor: parseAmountToMinor(str(b, "coverageLimit")),
          deductibleMinor: b["deductible"] === undefined ? 0 : parseAmountToMinor(str(b, "deductible")),
          effectiveFromMs: Number(b["effectiveFromMs"] ?? 0),
          effectiveUntilMs: Number(b["effectiveUntilMs"] ?? 0),
          ...(statusRaw === undefined
            ? {}
            : { status: ustr(statusRaw) as "active" | "lapsed" | "cancelled" }),
        },
        nowMs(),
      );
      appendAudit(db, orgOf(req), actorOf(req), "policies.create", policy.id, policy.policyNumber, nowMs());
      storeIdempotency(db, req, "/v1/policies", check.key, check.reqHash, 201, policy);
      res.status(201).json(policy);
    }),
  );

  r.get(
    "/",
    asyncHandler(async (req, res) => {
      const { limit, offset } = paginate(req, _cfg);
      res.json({ data: listPolicies(db, orgOf(req)).slice(offset, offset + limit) });
    }),
  );

  r.get(
    "/:id",
    asyncHandler(async (req, res) => {
      res.json(getPolicy(db, orgOf(req), pathParam(req, "id")));
    }),
  );

  return r;
}
