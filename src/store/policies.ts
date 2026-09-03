import type { Db } from "../db.js";
import { newId } from "../db.js";
import type { Policy, PolicyProduct, PolicyStatus } from "../types.js";
import { Conflict, InvalidInput, NotFound } from "./errors.js";

const PRODUCTS: PolicyProduct[] = ["auto", "health", "property"];
const STATUSES: PolicyStatus[] = ["active", "lapsed", "cancelled"];

interface PolicyRow {
  id: string;
  org_id: string;
  policy_number: string;
  holder_name: string;
  product: string;
  coverage_limit_minor: number;
  deductible_minor: number;
  effective_from_ms: number;
  effective_until_ms: number;
  status: string;
  created_at: number;
}

function toPolicy(r: PolicyRow): Policy {
  return {
    id: r.id,
    orgId: r.org_id,
    policyNumber: r.policy_number,
    holderName: r.holder_name,
    product: r.product as PolicyProduct,
    coverageLimitMinor: r.coverage_limit_minor,
    deductibleMinor: r.deductible_minor,
    effectiveFromMs: r.effective_from_ms,
    effectiveUntilMs: r.effective_until_ms,
    status: r.status as PolicyStatus,
    createdAt: r.created_at,
  };
}

export interface PolicyInput {
  policyNumber: string;
  holderName: string;
  product: string;
  coverageLimitMinor: number;
  deductibleMinor: number;
  effectiveFromMs: number;
  effectiveUntilMs: number;
  status?: PolicyStatus;
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed");
}

export function createPolicy(db: Db, orgId: string, input: PolicyInput, now: number): Policy {
  const policyNumber = input.policyNumber.trim();
  const holderName = input.holderName.trim();
  if (policyNumber === "") throw new InvalidInput("policy number must not be empty");
  if (holderName === "") throw new InvalidInput("holder name must not be empty");
  if (!PRODUCTS.includes(input.product as PolicyProduct)) {
    throw new InvalidInput(`unknown product ${JSON.stringify(input.product)}`);
  }
  const status = input.status ?? "active";
  if (!STATUSES.includes(status)) throw new InvalidInput(`unknown status ${JSON.stringify(status)}`);
  if (!Number.isInteger(input.coverageLimitMinor) || input.coverageLimitMinor <= 0) {
    throw new InvalidInput("coverage limit must be a positive integer");
  }
  if (!Number.isInteger(input.deductibleMinor) || input.deductibleMinor < 0) {
    throw new InvalidInput("deductible must be a non-negative integer");
  }
  if (
    !Number.isInteger(input.effectiveFromMs) ||
    !Number.isInteger(input.effectiveUntilMs) ||
    input.effectiveFromMs >= input.effectiveUntilMs
  ) {
    throw new InvalidInput("effective window must satisfy from < until");
  }
  const id = newId();
  try {
    db.raw
      .prepare(
        `INSERT INTO policies (id, org_id, policy_number, holder_name, product,
         coverage_limit_minor, deductible_minor, effective_from_ms, effective_until_ms,
         status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        orgId,
        policyNumber,
        holderName,
        input.product,
        input.coverageLimitMinor,
        input.deductibleMinor,
        input.effectiveFromMs,
        input.effectiveUntilMs,
        status,
        now,
      );
  } catch (err) {
    if (isUniqueViolation(err)) throw new Conflict(`policy number ${policyNumber} exists`);
    throw err;
  }
  return getPolicy(db, orgId, id);
}

export function getPolicy(db: Db, orgId: string, id: string): Policy {
  const row = db.raw
    .prepare(`SELECT * FROM policies WHERE id = ? AND org_id = ?`)
    .get(id, orgId) as unknown as PolicyRow | undefined;
  if (row === undefined) throw new NotFound(`policy ${id} not found`);
  return toPolicy(row);
}

export function getPolicyByNumber(db: Db, orgId: string, policyNumber: string): Policy {
  const row = db.raw
    .prepare(`SELECT * FROM policies WHERE org_id = ? AND policy_number = ?`)
    .get(orgId, policyNumber) as unknown as PolicyRow | undefined;
  if (row === undefined) throw new NotFound(`policy ${policyNumber} not found`);
  return toPolicy(row);
}

export function listPolicies(db: Db, orgId: string): Policy[] {
  const rows = db.raw
    .prepare(`SELECT * FROM policies WHERE org_id = ? ORDER BY policy_number`)
    .all(orgId) as unknown as PolicyRow[];
  return rows.map(toPolicy);
}
