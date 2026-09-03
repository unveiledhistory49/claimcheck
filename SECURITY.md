# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |

## Reporting a vulnerability

Open a **private security advisory** on GitHub (Security tab → Advisories).
Include reproduction steps, expected vs actual behavior, and the commit hash.
We aim to acknowledge within 3 business days. Do not file public issues for
suspected vulnerabilities.

## Posture

- Threat model: `docs/THREAT_MODEL.md` (includes honest residual risks).
- `npm audit` runs in CI on every push/PR; Dependabot covers npm and GitHub Actions.
- Secrets live in env (`CLAIMCHECK_PEPPER`, `CLAIMCHECK_DATABASE_URL`) — see `.env.example`.
