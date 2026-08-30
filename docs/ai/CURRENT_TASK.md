# Current task

> Overwrite this file each round. Never append.

## NONE — D-141: EXTRACTING can now see what its own job discovered

Offline round. No live HTTP, no RPC, no model call, no worker started, no new
live run. Read-only diagnosis of the real job first, then one narrow fix.

### The diagnosis (job `b77170f6-…`)

| stage | measured |
|---|---|
| search candidates | 60, correctly attributed across all 10 components |
| fetch targets | 25 attempted, 7 OK, 17 failed `PROVIDER_ERROR` |
| sealed documents | 6, all third-party (`consumed_at` null on every one) |
| documents visible to EXTRACTING | all 6, to every component, repeatedly |
| component attempts | 10, all `attemptNumber` 1 |
| extractor model calls | **1** |
| Evidence | 4 rows, one document, GOVERNANCE_BASIS |
| 9 other components | `NO_SEARCH_CANDIDATES`, **0 spent on every axis** |

**First loss boundary: candidate discovery inside EXTRACTING** — before any
fetch, any model call, any admissibility rule.

**Root cause.** The executor's targeting (D-129/D-133) *replaces* a
component's model queries with `site:<domain>` or `site:<explorer> <token>`
forms. The SEARCHING phase searches proposer queries as given. The two halves
of a phased job therefore speak different query vocabularies by design — and
the replay gateway was keyed only on the exact query string, so it truthfully
answered "nothing" for strings SEARCHING had never run, while the job's own
candidates sat in the trace under those very components.

Measured: **every generic query returned 5 candidates; every targeted query
returned 0.** GOVERNANCE_BASIS produced the only Evidence because it is the
one component whose targeting failed to rewrite anything
(`CLASS_REQUIRES_CONFIRMED_ROUTE:GOVERNANCE`), so its generic query survived
and matched the ledger. The single successful component was the one where
targeting broke.

### The fix

`prepareExtractionReplaySearch` is keyed the way the corpus was actually
discovered. `CANDIDATE_RETURNED` rows carry `patternStep` and `component`, so
the gateway answers for the component being researched; exact-query matches
still come first, so a query the phase really ran replays byte-for-byte.
Lossy refs are excluded exactly as the ledger excludes them.

It admits no URL this job did not discover, for a component it did not
discover it for. No authority, admissibility, budget or reconciliation rule
was touched.

### Disproven hypothesis

Documents are **not** claimed by the first component to use them. All six
sealed documents have `consumed_at` null; the replay fetcher serves any of
them to any component repeatedly; one document may legitimately support
several components. Pinned by test.

### Open, deliberately not fixed

- Every `docs.raydium.io` target failed in FETCHING with `PROVIDER_ERROR`, so
  **no official document was ever sealed**. The known buyback document was
  never even returned by search.
- Both the phase and the canonical executor collapse typed fetch failures into
  the single `PROVIDER_ERROR` code, so the trace cannot distinguish
  `BLOCKED_ADDRESS` from a timeout or a 404. Diagnosing the above needs that
  distinction, and adding it means extending a closed trace vocabulary — an
  owner decision, not a side effect.

### Standing boundaries

- Replay serves only what this job discovered, for the component it was
  discovered for.
- Dedupe prevents duplicate Evidence, never independent component evaluation.
- The budget default is expensive; replay stays free under D-137.
- Capability is declared, never discovered.
- Phases are never component attempts; the controller runs once.
