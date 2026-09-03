# Threat Model — ClaimCheck

## Assets

1. Claim evidence integrity (items, documents, decisions, reserves)
2. Org API keys and adjuster credentials/sessions
3. Audit log completeness (the record regulators read)

## Trust boundaries

- Network → Express app (JSON body limit 1MB, validated schemas)
- App → SQLite file (same host; file access = total compromise, same as peers)
- App → webhook endpoints (outbound only, HMAC-signed)

## Threats and mitigations

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Claim spoofing across orgs | Every store read/write is org-scoped; cross-org IDs 404 | wrong-org tests |
| Double payout on retry | `Idempotency-Key` on intake/pay; reserve `pay` bounded by balance | idempotency + overpay tests |
| Silent adjudication changes | Versioned decisions, pinned `RULES_VERSION` in reasons | decision version tests |
| Reserve drift/negative | Running balance + `CHECK` constraint + `BEGIN IMMEDIATE` | invariant tests |
| Illegal lifecycle jumps | `TRANSITIONS` map, `WorkflowError` → 422 | jump tests |
| Key leakage | sha256(pepper::key) stored, prefix-only logging, constant-time compare | code review |
| Password theft | scrypt N=16384, 10-char minimum, no plaintext anywhere | roundtrip tests |
| Session theft | HttpOnly-equivalent bearer tokens hashed at rest, TTL, logout invalidates | login/logout tests |
| Audit tampering | Per-org hash chain + `/audit/verify` (409 on gap/tamper) | tamper/gap tests |
| Webhook SSRF | https-only except `http://localhost`; HMAC `sha256=` signatures | URL tests |

## Residual risks (honest)

- No rate limiting or login lockout — brute force belongs at the edge.
- SQLite file readable by the host operator; encryption at rest is undeployed.
- Fraud rules are heuristics, not ML — novel fraud patterns need new rules.
- Sessions have no rotation or device binding.
- First supervisor bootstraps via CLI; a compromised host during setup owns the org.
