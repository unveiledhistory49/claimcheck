-- ClaimCheck schema v1. Amounts are INTEGER USD cents. Audit seq is
-- app-assigned (max+1 in IMMEDIATE tx) so the hash chain is gapless.

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adjusters (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'adjuster',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  adjuster_id TEXT NOT NULL REFERENCES adjusters(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  policy_number TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  product TEXT NOT NULL,
  coverage_limit_minor INTEGER NOT NULL,
  deductible_minor INTEGER NOT NULL DEFAULT 0,
  effective_from_ms INTEGER NOT NULL,
  effective_until_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, policy_number)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  claim_number TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE RESTRICT,
  claimant_name TEXT NOT NULL,
  claimant_email TEXT NOT NULL DEFAULT '',
  incident_ms INTEGER NOT NULL,
  reported_ms INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'intake',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, claim_number)
);
CREATE INDEX IF NOT EXISTS idx_claims_policy ON claims(policy_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(org_id, status);

CREATE TABLE IF NOT EXISTS claim_items (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_claim ON claim_items(claim_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  rule_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flags_claim ON fraud_flags(claim_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  payable_minor INTEGER NOT NULL DEFAULT 0,
  deductible_applied_minor INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (claim_id, version)
);

CREATE TABLE IF NOT EXISTS reserve_entries (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  balance_after_minor INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (balance_after_minor >= 0)
);
CREATE INDEX IF NOT EXISTS idx_reserves_claim ON reserve_entries(claim_id);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  decided_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, kind, value)
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org_seq ON audit_log(org_id, seq);

CREATE TABLE IF NOT EXISTS idempotency (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  req_hash TEXT NOT NULL,
  resp_status INTEGER NOT NULL,
  resp_body TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS idx_delivery_retry ON webhook_deliveries(status, next_retry_at);
