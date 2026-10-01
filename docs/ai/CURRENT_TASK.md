# Current task

> Overwrite this file each round. Never append.

## DOCUMENTARY STATE CUE (D-163) — IMPLEMENTED OFFLINE

Founder-approved 2026-10-01. LIVE CALLS MADE BY THIS TASK: 0. Not pushed.

PRESENT TENSE ≠ CURRENT STATE. DOCUMENTED ≠ EXECUTING. CURRENT_STATE requires
an explicit, validated state cue AND trusted temporal provenance.

- **Cue**: the extractor returns `stateCue` (verbatim words of the support
  fragment). `domain/mechanism-state-cue.ts` accepts it only if literal
  (`isTraceable`), mapped by the closed table to exactly one canonical state,
  and equal to the model's label; negation/condition/modal/future refuse it.
- **Marker**: `evidence.mechanism_state_rule_version smallint NULL` (migration
  0061, no default, no backfill); Memory copies it exactly.
- **Rule**: for CURRENT_STATE, an uncued model-written state is UNKNOWN; same
  for lifecycle signals and the surface. Chain rows unchanged.
- **Not changed (stop-and-report, D-163 §5)**: EXECUTION_EVIDENCE's live gate.
  Historical execution cannot be represented without LIVE; see BACKLOG.
- Offline corpus: no stored CURRENT_STATE / EXECUTION_EVIDENCE status changes;
  the Wave 1A trusted-date probe no longer yields SUPPORTED/LIVE.

Before the next live run on `atlas_dev`: migrations 0060 and 0061 are NOT
applied there (`npm run db:migrate` needs Founder approval). App and workers
are not running.

Still waiting on the Founder: the EXECUTION_EVIDENCE historical-execution
decision (BACKLOG); Raydium HTML route classification (`84774bb9…`, optional);
global unmarked-date supersession (BACKLOG); EVM V1 live validation candidate;
Blind Batch V1 inputs.

STOP here until the Founder reviews. No push, no live call.
