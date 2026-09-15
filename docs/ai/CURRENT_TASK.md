# Current task

> Overwrite this file each round. Never append.

## DOCUMENTARY CANDIDATE CONTINUATION V1 (done this round)

Offline round. No live/API/RPC call, no rerun, no Memory change, no
budget change, no schema change.

**Proven from A2-prime's persisted trace (job `58eeba58-…`):**
MECHANISM_SPEC → one search → five confirmed OFFICIAL_DOCS candidates →
fair share allowed one open → first document extracted cleanly with an
empty facts array → component stopped → INSUFFICIENT_EVIDENCE with 11
global source opens unused.

**Fixed generically** (see the DOCUMENTARY CANDIDATE CONTINUATION V1
section of `CURRENT_STATE.md`): the open→extract sequence in
`s4-executor.ts` runs in at most two rounds over the same ordered
candidate list; the second round is entered only when the single opened
document completed acquisition and admitted zero facts, an un-opened
candidate remains, and live ledgers show room for one more open and one
more extraction. Maximum extra work: +1 open, +1 extraction. No proposer,
no search, no reopen, no ceiling change.

**Search-budget audit** (reported, not fixed): (a) the last component's
refused search throws before its already-paid candidates are opened;
(b) components with no reachable admissible documentary class
(GOVERNANCE-only / OFFICIAL_REPORT-only without a confirmed route) spend
searches S5 must exclude. Both need a Founder decision.

Tests: `tests/documentary-candidate-continuation-v1.test.ts` (new, 13).

### Next

- Founder decision on audit items (a)/(b); then, with new approval, ONE
  A2-double-prime + ONE B.
