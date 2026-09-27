# Current task

> Overwrite this file each round. Never append.

## TEMPORAL RELIABILITY — FIXES 1, 2, 4 IMPLEMENTED OFFLINE; FIX 3 IN DESIGN REVIEW (awaiting Founder)

Founder-approved 2026-09-27. LIVE CALLS MADE: 0. Not pushed.

- **Fix 1 — FRESH DOCUMENT ≠ CURRENT CLAIM.** A component with
  `requiresCurrentState` (CURRENT_STATE) is established only by a row that
  states a known state; a fresh-dated row whose state is UNKNOWN/null is
  excluded as NOT_CURRENT_STATE_BEARING (stale, undated and wrong-kind rows
  keep their old reasons). Display-only safeguard: a saved CURRENT_STATE
  resting only on rows with no known state renders NOT_ESTABLISHED ("The
  sources checked do not state whether this is happening now; a recent page
  date alone cannot show it."). Saved jobs are not recomputed or mutated.
- **Fix 2 — `published_at` is document metadata.** The extractor prompt now
  defines it: an explicit publication or last-updated date of the document
  itself, else null; never fetch dates, dates in the facts, "as of" dates,
  governance or transaction dates.
- **Fix 4 — honest wording.** EXECUTION_EVIDENCE: "Execution has been
  observed"; a confirmed/partial execution row states its evidence date and
  that it does not show continuation. GOVERNANCE_BASIS: an approval later
  superseded by a newer PAUSED / DEPRECATED / REMOVED record carries
  `APPROVAL_LATER_WITHDRAWN` ("Approved earlier · later withdrawn") in place
  of APPROVAL_NOT_ESTABLISHED; same status, same support.
- **Fix 3 — NOT implemented.** Read-only design review of stop-state
  durability delivered to the Founder; lifecycle semantics unchanged.
- **Backlog:** on-chain temporal basis is read time, not block time (latent).

Still waiting on the Founder: Fix 3 decision; EVM V1 live validation has no
admissible positive candidate; Blind Batch V1 inputs (`BLIND_BATCH_V1.md` §11).

STOP here until the Founder reviews. No push, no live call.
