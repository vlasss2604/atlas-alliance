# Current task

> Overwrite this file each round. Never append.

## TRANSIENT EXTRACTOR RESILIENCE V1 (done this round)

Offline round. No live call, no provider/model call, no new Research job, no
budget change, no schema, no new subsystem, no provider fallback. Founder
decision: option C through the existing caller-decides seam, N = 2.

The seed-injection validation run `06ade56b-…` selected, fetched and began
extracting its approved documents, then died as
`FAILED / SYSTEM_OR_PROVIDER_FAILURE / CapabilityFatalError` on ONE
document's `NETWORK_NO_RESPONSE` — its first component's second document,
right after the first had extracted OK — with two FAILED
`MODEL_CALL_ATTEMPTED` rows that said only `PROVIDER_ERROR` (verified in
the local `atlas_dev` trace, rows 53-64).

- **Before → after.** Before: a document whose extractor generation call
  failed transiently twice was by itself proof the capability was down —
  `CapabilityFatalError` at once, job fatal. After: that document is a
  document-local `EXTRACT_FAILED` carrying its typed `diagnostic_code`, no
  Evidence, no contradiction, and the attempt continues to the next
  document. Only the SECOND consecutive such document of the same job run
  (no successful extraction between them) throws `CapabilityFatalError`,
  exactly as before. A successful extraction resets the count.
- **Unchanged.** At most 2 calls per document, each separately reserved.
  `TOKEN_COUNT_UNAVAILABLE`, preflight configuration failures, QueryProposer
  and SearchGateway retries stay immediately fatal. Budgets, SearchGateway,
  QueryProposer, admission, reducers, verdicts, Verification, provider
  configuration, latency architecture: untouched.
- **Observability.** Both FAILED `MODEL_CALL_ATTEMPTED` rows and the
  `EXTRACT_FAILED` row persist the same typed `diagnostic_code` through the
  existing gate. No vocabulary widened, no schema.

Files: `src/server/engine/s4-executor.ts`,
`tests/transient-extractor-resilience-v1.test.ts` (new, 10 cases),
`tests/generation-diagnostic.test.ts`, `tests/s10-acceptance-closure.test.ts`,
`docs/ai/CURRENT_STATE.md`, `docs/ai/ARCHITECTURE.md`, this file.

### Reported, not done

- A non-transient document-local failure between two transient ones does
  NOT reset the count (only a successful extraction does — the literal
  approved rule). If the founder prefers "any answered document resets",
  that is a one-line change in the extractor loop plus test 4b.
- `tests/acquisition-candidate-reachability-v1.test.ts` shipped in 63d3776
  with three `tsc --noEmit` errors (runtime-green under vitest, which does
  not type-check): two `supersedeProjectMemoryItem` calls missing the
  `replacedBy` successor id, one dead `"FETCH_OK"` branch in a ternary over
  a two-member literal union. Fixed as test-fixture-only corrections in the
  follow-up hygiene commit — same fixture shape as d148 TESTS 6/7; no
  production file touched. `tsc --noEmit` is clean again.

### Next

- Founder decides whether to spend one bounded validation run.
