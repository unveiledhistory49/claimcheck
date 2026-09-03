import { createHmac, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { nowMs, type Db } from "./db.js";

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 86_400_000;

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function enqueue(db: Db, orgId: string, event: string, payload: unknown): number {
  const eps = db.raw
    .prepare(`SELECT id, secret, url FROM webhook_endpoints WHERE org_id = ? AND active = 1`)
    .all(orgId) as unknown as { id: string; secret: string; url: string }[];
  const body = JSON.stringify(payload);
  const now = nowMs();
  let n = 0;
  for (const ep of eps) {
    db.raw
      .prepare(`INSERT INTO webhook_deliveries (id, endpoint_id, org_id, event, payload, status, attempts, next_retry_at, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
      .run(randomUUID().replace(/-/g, ""), ep.id, orgId, event, body, now, now);
    n += 1;
  }
  return n;
}

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

export async function dispatchDue(
  db: Db,
  cfg: AppConfig,
  limit = 25,
): Promise<{ dispatched: number; pending: number }> {
  const now = nowMs();
  const due = db.raw
    .prepare(`SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_retry_at <= ? LIMIT ?`)
    .all(now, limit) as unknown as {
    id: string;
    endpoint_id: string;
    event: string;
    payload: string;
    attempts: number;
  }[];
  let dispatched = 0;
  let pending = 0;
  for (const d of due) {
    const ep = db.raw.prepare(`SELECT url, secret, active FROM webhook_endpoints WHERE id = ?`).get(d.endpoint_id) as unknown as
      | { url: string; secret: string; active: number }
      | undefined;
    if (ep === undefined || ep.active !== 1) {
      db.raw.prepare(`UPDATE webhook_deliveries SET status = 'dead' WHERE id = ?`).run(d.id);
      continue;
    }
    const attempts = d.attempts + 1;
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ClaimCheck-Event": d.event,
          "X-ClaimCheck-Signature": signPayload(ep.secret, d.payload),
        },
        body: d.payload,
        signal: AbortSignal.timeout(cfg.webhookTimeoutMs),
      });
      if (res.status >= 200 && res.status < 300) {
        db.raw.prepare(`UPDATE webhook_deliveries SET status = 'delivered', attempts = ? WHERE id = ?`).run(attempts, d.id);
        dispatched += 1;
      } else {
        throw new Error(`HTTP ${String(res.status)}`);
      }
    } catch {
      if (attempts >= cfg.webhookMaxAttempts) {
        db.raw.prepare(`UPDATE webhook_deliveries SET status = 'dead', attempts = ? WHERE id = ?`).run(attempts, d.id);
      } else {
        db.raw
          .prepare(`UPDATE webhook_deliveries SET attempts = ?, next_retry_at = ? WHERE id = ?`)
          .run(attempts, now + retryDelayMs(attempts), d.id);
      }
      pending += 1;
    }
  }
  return { dispatched, pending };
}
