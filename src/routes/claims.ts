import { Router } from "express";
import type { AppConfig } from "../config.js";
import { nowMs, type Db } from "../db.js";
import { parseAmountToMinor } from "../money.js";
import { HttpError } from "../auth.js";
import {
  addDocument,
  addItem,
  claimTotal,
  createClaim,
  getAppeal,
  getClaim,
  getDocument,
  listAppealsByClaim,
  listDecisions,
  listDocuments,
  listFraudFlags,
  listItems,
  listClaims,
  listPayouts,
  listReserves,
  paidTotal,
  reserveBalance,
} from "../store/claims.js";
import { getPolicy, getPolicyByNumber } from "../store/policies.js";
import { appendAudit, listAudit } from "../store/audit.js";
import {
  appealClaim,
  decideAppealClaim,
  overrideClaim,
  payClaim,
  runPipeline,
} from "../engine/workflow.js";
import { enqueue } from "../webhooks.js";
import {
  actorOf,
  asyncHandler,
  checkIdempotency,
  orgOf,
  paginate,
  pathParam,
  storeIdempotency,
  str,
  ustr,
  type AuthedRequest,
} from "../http.js";

interface IntakeItem {
  category?: unknown;
  description?: unknown;
  amount?: unknown;
}

function parseItems(raw: unknown): { category: string; description: string; amountMinor: number }[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(422, "items must be a non-empty array");
  }
  return raw.map((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null) throw new HttpError(422, `items[${String(i)}] must be an object`);
    const it = entry as IntakeItem;
    return {
      category: ustr(it.category),
      description: ustr(it.description),
      amountMinor: parseAmountToMinor(ustr(it.amount) === "" ? "0" : ustr(it.amount)),
    };
  });
}

function fullClaim(db: Db, orgId: string, claimId: string): Record<string, unknown> {
  const claim = getClaim(db, orgId, claimId);
  const policy = getPolicy(db, orgId, claim.policyId);
  return {
    claim,
    policy: { id: policy.id, policyNumber: policy.policyNumber, product: policy.product, status: policy.status },
    items: listItems(db, claimId),
    totalMinor: claimTotal(db, claimId),
    flags: listFraudFlags(db, claimId),
    decisions: listDecisions(db, claimId),
    reserves: listReserves(db, claimId),
    reserveBalance: reserveBalance(db, claimId),
    payouts: listPayouts(db, claimId),
    paidTotal: paidTotal(db, claimId),
    appeals: listAppealsByClaim(db, claimId),
    documents: listDocuments(db, claimId),
  };
}

function emitDecisionEvents(db: Db, orgId: string, outcome: string, claimId: string, flags: { severity: string }[]): void {
  try {
    if (outcome === "approve") enqueue(db, orgId, "claim.approved", { claim_id: claimId });
    else if (outcome === "deny") enqueue(db, orgId, "claim.denied", { claim_id: claimId });
    if (flags.some((f) => f.severity === "block")) enqueue(db, orgId, "fraud.blocked", { claim_id: claimId });
  } catch (err) {
    console.warn("webhook enqueue failed", err);
  }
}

export function claimRoutes(db: Db, cfg: AppConfig): Router {
  const r = Router();

  r.post(
    "/",
    asyncHandler(async (req, res) => {
      const check = checkIdempotency(db, req, res);
      if ("replayed" in check) return;
      const b = req.body as Record<string, unknown>;
      const orgId = orgOf(req);
      const policy =
        b["policyNumber"] !== undefined
          ? getPolicyByNumber(db, orgId, str(b, "policyNumber"))
          : getPolicy(db, orgId, str(b, "policyId"));
      const items = parseItems(b["items"]);
      const claim = db.transaction(() => {
        const c = createClaim(
          db,
          {
            orgId,
            policyId: policy.id,
            claimantName: str(b, "claimantName"),
            claimantEmail: str(b, "claimantEmail"),
            incidentMs: Number(b["incidentMs"] ?? 0),
            reportedMs: Number(b["reportedMs"] ?? 0),
            description: str(b, "description"),
          },
          nowMs(),
        );
        for (const it of items) {
          addItem(db, c.id, { category: it.category, description: it.description, amountMinor: it.amountMinor }, nowMs());
        }
        return c;
      });
      appendAudit(db, orgId, actorOf(req), "claims.intake", claim.id, claim.claimNumber, nowMs());
      const result = runPipeline(db, orgId, claim.id, actorOf(req));
      emitDecisionEvents(db, orgId, result.decision?.outcome ?? "manual", claim.id, result.flags);
      const body = { claim: result.claim, decision: result.decision, flags: result.flags, score: result.score };
      storeIdempotency(db, req, "/v1/claims", check.key, check.reqHash, 201, body);
      res.status(201).json(body);
    }),
  );

  r.get(
    "/",
    asyncHandler(async (req, res) => {
      const { limit, offset } = paginate(req, cfg);
      const status = req.query["status"];
      const claims = listClaims(db, orgOf(req), typeof status === "string" ? (status as "approved") : undefined);
      res.json({ data: claims.slice(offset, offset + limit) });
    }),
  );

  r.get(
    "/:id",
    asyncHandler(async (req, res) => {
      res.json(fullClaim(db, orgOf(req), pathParam(req, "id")));
    }),
  );

  r.post(
    "/:id/documents",
    asyncHandler(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const content = Buffer.from(str(b, "contentBase64"), "base64");
      const meta = addDocument(
        db,
        pathParam(req, "id"),
        { filename: str(b, "filename"), mime: str(b, "mime"), content },
        nowMs(),
      );
      appendAudit(db, orgOf(req), actorOf(req), "claims.document", pathParam(req, "id"), meta.filename, nowMs());
      res.status(201).json(meta);
    }),
  );

  r.get(
    "/:id/documents/:docId",
    asyncHandler(async (req, res) => {
      const doc = getDocument(db, pathParam(req, "id"), pathParam(req, "docId"));
      res.json({ ...doc, content: undefined, contentBase64: doc.content.toString("base64") });
    }),
  );

  r.post(
    "/:id/override",
    asyncHandler(async (req, res) => {
      const ident = (req as AuthedRequest).identity;
      if (ident.role !== "supervisor") {
        res.status(403).json({ error: "supervisor role required" });
        return;
      }
      const b = req.body as Record<string, unknown>;
      const outcome = str(b, "outcome");
      if (outcome !== "approve" && outcome !== "deny") {
        res.status(422).json({ error: "outcome must be approve|deny" });
        return;
      }
      const actor = ident.adjusterId ?? "api_key";
      const decision = overrideClaim(db, orgOf(req), pathParam(req, "id"), actor, outcome, str(b, "reason"));
      res.status(201).json(decision);
    }),
  );

  r.post(
    "/:id/pay",
    asyncHandler(async (req, res) => {
      const check = checkIdempotency(db, req, res);
      if ("replayed" in check) return;
      const b = req.body as Record<string, unknown>;
      const result = payClaim(
        db,
        orgOf(req),
        pathParam(req, "id"),
        parseAmountToMinor(str(b, "amount")),
        str(b, "reference"),
        actorOf(req),
      );
      try {
        enqueue(db, orgOf(req), "claim.paid", { claim_id: pathParam(req, "id"), paid_total: result.paidTotal });
      } catch (err) {
        console.warn("webhook enqueue failed", err);
      }
      storeIdempotency(db, req, "/v1/pay", check.key, check.reqHash, 201, result);
      res.status(201).json(result);
    }),
  );

  r.post(
    "/:id/appeal",
    asyncHandler(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const appeal = appealClaim(db, orgOf(req), pathParam(req, "id"), str(b, "reason"));
      // Fetch full row for the response (appealClaim returns id only).
      const full = getAppeal(db, appeal.id);
      res.status(201).json(full);
    }),
  );

  r.get(
    "/:id/reserves",
    asyncHandler(async (req, res) => {
      getClaim(db, orgOf(req), pathParam(req, "id"));
      res.json({ data: listReserves(db, pathParam(req, "id")), balance: reserveBalance(db, pathParam(req, "id")) });
    }),
  );

  r.get(
    "/:id/timeline",
    asyncHandler(async (req, res) => {
      const orgId = orgOf(req);
      const claimId = pathParam(req, "id");
      getClaim(db, orgId, claimId);
      const audit = listAudit(db, orgId, 0, 1000).filter((a) => a.target === claimId);
      res.json({
        audit,
        decisions: listDecisions(db, claimId),
        reserves: listReserves(db, claimId),
        payouts: listPayouts(db, claimId),
      });
    }),
  );

  return r;
}

export function appealRoutes(db: Db, _cfg: AppConfig): Router {
  const r = Router();
  r.post(
    "/:id/decide",
    asyncHandler(async (req, res) => {
      const ident = (req as AuthedRequest).identity;
      if (ident.role !== "supervisor") {
        res.status(403).json({ error: "supervisor role required" });
        return;
      }
      const b = req.body as Record<string, unknown>;
      const actor = ident.adjusterId ?? "api_key";
      const result = decideAppealClaim(
        db,
        orgOf(req),
        pathParam(req, "id"),
        actor,
        b["overturn"] === true,
        str(b, "reason"),
      );
      if ("upheld" in result) {
        res.json({ upheld: true });
        return;
      }
      emitDecisionEvents(db, orgOf(req), result.decision?.outcome ?? "manual", result.claim.id, result.flags);
      res.json(result);
    }),
  );
  return r;
}
