# Current task

> Overwrite this file each round. Never append.

## TEMPORAL PROVENANCE MARKER + FIX 3 LIFECYCLE — IMPLEMENTED OFFLINE (awaiting Founder review)

Founder-approved 2026-09-27 (S2). LIVE CALLS MADE: 0. Not pushed.

UNTRUSTED DOCUMENTARY DATES MUST NOT CREATE CURRENT OR LIFECYCLE TEMPORAL
TRUTH.

- **Marker**: `evidence.published_at_rule_version smallint NULL` (migration
  0059, no default, no backfill). 1 = strict publication-date rule; NULL =
  legacy. Written on documentary extraction (`PUBLISHED_AT_RULE_VERSION`),
  copied exactly on Memory reuse, never set on chain rows.
- **Temporal uses now trusted-only**: (A) CURRENT_STATE freshness; (B)
  durable stop ordering; (C) lifecycle newer-conflict; (D)
  TEMPORAL_STATE_MISMATCH; (E) the temporal basis a component result reports.
  Global supersession (§8.1) is unchanged for every component — BACKLOG.
- **Fix 3 lifecycle** (rows read directly, option a): DEPRECATED/REMOVED are
  durable stops → HISTORICAL with execution; PAUSED never durable →
  NOT_ESTABLISHED; a newer trusted stop blocks CURRENT; a newer fresh LIVE
  restores it; a stale LIVE does not; same-date conflicts → NOT_ESTABLISHED.
- **Surface**: a saved CURRENT_STATE resting on unmarked documentary dates is
  not established; a current state established as PAUSED / DEPRECATED /
  REMOVED is said as that, never "happening now"; a not-established current
  state names the latest trusted record ("last recorded as paused on …;
  current state unknown").

Still waiting on the Founder: global unmarked-date supersession (BACKLOG);
EVM V1 live validation candidate; Blind Batch V1 inputs (§11).

STOP here until the Founder reviews. No push, no live call.
