# Current task

> Overwrite this file each round. Never append.

## CLAUSE-LEVEL GUARD FOR THE STATE CUE (D-164) — IMPLEMENTED OFFLINE

Founder-approved 2026-10-02. LIVE CALLS MADE BY THIS TASK: 0. Not pushed.

The offline corpus audit of D-163 on `atlas_dev` (125 CURRENT_STATE /
EXECUTION_EVIDENCE results, 1597 documentary rows, read-only) found that the
refusal words were checked on the cue alone, so a narrow cue escaped its
sentence ("is live" out of "…once the token is live…").

- **Fix**: `cueIsAsserted` in `domain/mechanism-state-cue.ts`. Every
  word-bounded occurrence of the cue must sit in an asserted sentence: no
  D-163 refusal word, no contingency marker, not a question. Unlocatable cue
  → refused. Marker version stays 1; cue table and taxonomy unchanged.
- **Corpus after the fix**: 0 status changes; Wave 1A CURRENT_STATE stays
  INSUFFICIENT even with trusted dates; no variant is stronger than legacy.
- **Known fail-closed cost**: an assertion sharing a sentence with "when",
  "after", "can", "no" … is left uncued.
- **Not in the v1 table** (needs its own decision): "has been active since",
  "active since", "went live", "was deprecated", bare "deprecated",
  "no longer".

atlas_dev has migrations through 0061 applied. App and workers are not
running.

Still waiting on the Founder: the EXECUTION_EVIDENCE historical-execution
decision (BACKLOG; also: its live gate still reads an uncued label); cue
table extension (above); Raydium HTML route classification (optional);
global unmarked-date supersession (BACKLOG); EVM V1 live validation
candidate; Blind Batch V1 inputs.

STOP here until the Founder reviews. No push, no live call.
