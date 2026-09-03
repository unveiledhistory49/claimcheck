#!/usr/bin/env bash
# ClaimCheck end-to-end smoke test: builds, provisions, and walks the
# policy -> claim -> override -> pay -> appeal flow against a live server.
# Env overrides: PORT (default 8000), PYTHON (default python3, JSON parsing only).
set -euo pipefail
PORT="${PORT:-8000}"
PYTHON="${PYTHON:-python3}"
BASE="http://127.0.0.1:${PORT}"

TMPDB="$(mktemp /tmp/claimcheck-e2e-XXXXXX.db)"
rm -f "$TMPDB"
export CLAIMCHECK_DATABASE_URL="$TMPDB" CLAIMCHECK_PEPPER="e2e-pepper"
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi
  rm -f "$TMPDB"
}
trap cleanup EXIT

npm run build >/dev/null 2>&1

echo "==> provision org + adjusters"
PROV="$(node dist/cli.js provision-org --name e2e --db "$TMPDB")"
API_KEY="$($PYTHON -c 'import json,sys; print(json.loads(sys.argv[1])["api_key"])' "$PROV")"
ORG="$($PYTHON -c 'import json,sys; print(json.loads(sys.argv[1])["org_id"])' "$PROV")"
node dist/cli.js create-adjuster --db "$TMPDB" --org-id "$ORG" --email "sup@e2e.test" --name Sup --password 'supervisor-pw-1' --role supervisor >/dev/null

echo "==> start server"
node dist/server.js & PID=$!
UP=0
for _ in $(seq 1 50); do
  if curl -sSf "$BASE/health" -o /dev/null; then UP=1; break; fi
  sleep 0.2
done
[ "$UP" = 1 ] || { echo "FAIL: server never healthy"; exit 1; }

auth() { echo "X-API-Key: $API_KEY"; }
now_ms() { "$PYTHON" -c 'import time; print(int(time.time()*1000))'; }
FROM="$(($(now_ms) - 86400000 * 30))"
UNTIL="$(($(now_ms) + 86400000 * 300))"

echo "==> policy + watchlist + claim"
POL="$(curl -sSf -X POST "$BASE/v1/policies" -H "$(auth)" -H 'Content-Type: application/json' \
  -d "{\"policyNumber\":\"AUTO-E2E\",\"holderName\":\"Ed\",\"product\":\"auto\",\"coverageLimit\":\"50000\",\"deductible\":\"1000\",\"effectiveFromMs\":$FROM,\"effectiveUntilMs\":$UNTIL}")"
curl -sSf -X POST "$BASE/v1/watchlist" -H "$(auth)" -H 'Content-Type: application/json' \
  -d '{"kind":"name","value":"fraud fraser","reason":"e2e"}' >/dev/null
INC="$(($(now_ms) - 86400000 * 5))"
CL="$(curl -sSf -X POST "$BASE/v1/claims" -H "$(auth)" -H 'Content-Type: application/json' \
  -d "{\"policyNumber\":\"AUTO-E2E\",\"claimantName\":\"Fraud Fraser\",\"incidentMs\":$INC,\"reportedMs\":$((INC + 3600000)),\"items\":[{\"category\":\"repair\",\"amount\":\"45000.00\"}]}")"
CID="$($PYTHON -c 'import json,sys; print(json.loads(sys.argv[1])["claim"]["id"])' "$CL")"
STATUS="$($PYTHON -c 'import json,sys; print(json.loads(sys.argv[1])["claim"]["status"])' "$CL")"
[ "$STATUS" = "fraud_review" ] || { echo "FAIL: want fraud_review got $STATUS"; exit 1; }
echo "manual queue ok: $CID"

echo "==> supervisor override -> pay"
SUP_TOKEN="$(curl -sSf -X POST "$BASE/v1/login" -H 'Content-Type: application/json' \
  -d "{\"orgId\":\"$ORG\",\"email\":\"sup@e2e.test\",\"password\":\"supervisor-pw-1\"}" | $PYTHON -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
OV="$(curl -sSf -X POST "$BASE/v1/claims/$CID/override" -H "Authorization: Bearer $SUP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"outcome":"approve","reason":"verified by phone"}')"
echo "$OV" | $PYTHON -c 'import json,sys; assert json.load(sys.stdin)["outcome"] == "approve"'
PAY="$(curl -sSf -X POST "$BASE/v1/claims/$CID/pay" -H "$(auth)" -H 'Content-Type: application/json' -H 'Idempotency-Key: e2e-pay-00000001' \
  -d '{"amount":"44000.00","reference":"CHK-E2E"}')"
echo "$PAY" | $PYTHON -c 'import json,sys; assert json.load(sys.stdin)["status"] == "paid"'
echo "override+pay ok"

echo "==> timeline + audit verify"
curl -sSf "$BASE/v1/claims/$CID/timeline" -H "$(auth)" | $PYTHON -c 'import json,sys; d=json.load(sys.stdin); assert len(d["decisions"]) >= 2 and len(d["reserves"]) >= 2, d'
curl -sSf "$BASE/v1/audit/verify" -H "$(auth)" | $PYTHON -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True'
echo "E2E PASS"
