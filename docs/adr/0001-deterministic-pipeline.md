# ADR-0001: Deterministic pipeline, versioned decisions

Date: 2026-09-03. Status: accepted.

## Context

Claims adjudication must be reproducible: regulators, auditors, and claimants
all need the answer to "why was this decided this way" to be stable and
complete.

## Decision

- `runPipeline` is deterministic: same claim state always yields the same
  decision, flags, and score. Fraud rules are pure functions over an explicit
  `FraudContext` — no clock reads, no randomness, no hidden inputs.
- Decisions are versioned rows (`decisions.version` per claim). Overrides and
  appeal re-runs append versions; nothing is overwritten.
- Rule-set version is pinned (`RULES_VERSION = "1.0.0"`) and recorded as the
  first reason on every decision, so old decisions stay interpretable after
  rule changes.

## Consequences

Appeal re-runs can produce a *different* version with the *same* rules if the
underlying data changed (new documents, corrected items) — that is correct and
auditable. Changing `RULES_VERSION` semantics requires a migration note, since
`reasons` strings are the audit surface.

## Rejected

Re-running adjudication in place (UPDATE the decision row): destroys the
before/after that appeals, audits, and model training need.
