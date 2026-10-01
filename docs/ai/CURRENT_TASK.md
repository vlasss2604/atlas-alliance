# Current task

> Overwrite this file each round. Never append.

## does_not_prove POLARITY CONTRACT (D-162) — IMPLEMENTED OFFLINE

Founder-approved 2026-10-01. LIVE CALLS MADE BY THIS TASK: 0. Not pushed.

A MODEL-WRITTEN CAVEAT MUST NOT CREATE AN INVERTED OR AMBIGUOUS USER-FACING
STATEMENT. Found in Wave 1A (`fd1252ef`, evidence `41838267`: "The mechanism
is not yet LIVE, or that …" shown under "Does not prove:").

- **Contract**: extractor prompt + schema ask for the claim itself, in its own
  polarity — `that …`, `whether …`, or a short noun phrase.
- **Marker**: `evidence.does_not_prove_rule_version smallint NULL` (migration
  0060, no default, no backfill). 1 only for a v1-form caveat; text never
  edited; Memory copies it exactly.
- **Surface**: v1 → "Does not establish: …"; chain row → its own sentence;
  legacy → code-owned source-class limit; raw legacy text only in the audit as
  "Legacy extractor note".
- Verdicts, components, confidence, authority, CURRENT_STATE, mechanism_state,
  claim evaluator, Memory eligibility, BURN/supply: unchanged.

Before the next live run on `atlas_dev`: migration 0060 is NOT applied there
(`npm run db:migrate` is a schema change and needs Founder approval). The app
and both workers were stopped (background time limit) and are not running.

Still waiting on the Founder: Raydium HTML route classification
(`84774bb9…`, optional; no Wave 1A verdict effect); the present-tense-LIVE
labelling audit (BACKLOG); global unmarked-date supersession (BACKLOG); EVM V1
live validation candidate; Blind Batch V1 inputs.

STOP here until the Founder reviews. No push, no live call.
