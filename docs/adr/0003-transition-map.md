# ADR-0003: Explicit transition map, no deletes

Date: 2026-09-03. Status: accepted.

## Context

Claim lifecycle bugs (paying a denied claim, appealing a paid one) are the
most expensive class of defect in claims systems. Status strings checked
ad hoc at each call site drift.

## Decision

- `TRANSITIONS` in `engine/workflow.ts` is the single source of truth for
  legal moves. `transition()` rejects anything else with `WorkflowError`
  (mapped to HTTP 422).
- The one deliberate exception is documented in the map: `appealed → denied`
  exists so upheld appeals return to a terminal denial without fabricating a
  second adjudication.
- Nothing is ever deleted: users suspend, claims close, watch entries are the
  only removable rows (operational list, not evidence).

## Consequences

Adding a status (e.g. `subrogation`) requires editing one map plus the
affected flows — grep-able and reviewable. The map is asserted by tests that
walk the full happy path and probe illegal jumps.

## Rejected

Per-handler status checks: unenforceable consistency, silent drift.
