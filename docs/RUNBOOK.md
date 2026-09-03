# Runbook — ClaimCheck

## Provision an org

```bash
node dist/cli.js provision-org --name "Acme Mutual"
# -> {"org_id":"...","api_key":"cc_live_..."}  (save the key: shown once)
node dist/cli.js create-adjuster --org-id <ORG> --email sup@ac.me \
  --name "Supervisor" --password '<10+ chars>' --role supervisor
```

## Daily operations

- Intake: `POST /v1/claims` (runs the full pipeline synchronously).
- Manual queue: `GET /v1/claims?status=fraud_review` → review flags →
  `POST /v1/claims/:id/override` (supervisor).
- Pay: `POST /v1/claims/:id/pay` with `Idempotency-Key` (safe to retry).
- Appeals: `POST /v1/claims/:id/appeal` then `POST /v1/appeals/:id/decide`.
- Evidence: `GET /v1/claims/:id/timeline` shows audit + decisions + reserves + payouts.
- Verify integrity: `GET /v1/audit/verify` (409 + culprit seq on tamper).

## Key rotation

No rotation endpoint (deliberate — rotation is a ceremony, not a click):

1. Provision a standby org key out of band (same pepper scheme, new row).
2. Migrate integrations to the new key.
3. Delete the old row: `DELETE FROM orgs` is wrong (cascade!) — instead update
   `api_key_hash` to the new hash directly in SQLite, or re-provision the org
   and migrate data. Document the window in the audit log by hand
   (`claims.transition` won't cover it — use a dated ops note).

Pepper rotation requires re-issuing every key (hashes can't be recomputed
without originals).

## Backup

SQLite single file: stop writes or copy under `BEGIN IMMEDIATE`
(`sqlite3 db ".backup main backup.db"`). WAL mode — copy the `-wal` file too,
or checkpoint first.

## Triage

| Symptom | Check |
| --- | --- |
| Decision `manual` unexpected | `GET claim` → `flags[]` rule codes + score |
| Reserve mismatch | `GET reserves` — recompute running balance by hand |
| `409` on pay | payable − paidTotal < amount (see claim detail) |
| Pipeline 422 | `WorkflowError` message names the illegal jump |
| Webhooks stuck pending | `POST /v1/webhooks/dispatch`; check endpoint secret/URL |
