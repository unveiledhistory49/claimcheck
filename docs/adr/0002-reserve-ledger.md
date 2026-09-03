# ADR-0002: Reserve ledger with running balance

Date: 2026-09-03. Status: accepted.

## Context

Carriers must track loss reserves per claim: set on intake, adjusted as facts
change, released on denial, consumed by payouts. A bare `reserve` column on
the claim row invites silent mutation and arithmetic drift.

## Decision

Reserves are an append-only ledger (`reserve_entries`): every row carries
`kind` (set/adjust/release/pay), `amountMinor`, and `balanceAfterMinor`.
Semantics:

- `set` → balance = amount (must be ≥ 0)
- `adjust` → balance = last + amount (must stay ≥ 0)
- `release` → balance = 0, stored amount = −last
- `pay` → balance = last − amount (amount must be within balance)

Writes happen inside `BEGIN IMMEDIATE` transactions and a
`CHECK (balance_after_minor >= 0)` constraint backs the application logic, so
a bug that slips the code check still fails loudly at the database.

## Consequences

Reserve history is a first-class audit artifact (`GET /v1/claims/:id/reserves`).
Partial payouts are natural (repeated `pay` rows). There is intentionally no
"edit reserve" path — corrections are `adjust` rows with an actor attached.

## Rejected

A mutable `reserve_minor` column on `claims`: no history, no actor, and every
reader must trust the writer's arithmetic.
