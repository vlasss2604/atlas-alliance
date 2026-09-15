# Current task

> Overwrite this file each round. Never append.

## ACQUISITION GRACEFUL DEGRADATION V1 (done this round)

Offline round. No live/API/RPC call, no A2 rerun, no Research B, no Memory
enabled, no schema change, no budget change.

**Proven from A2's persisted trace (job `b5395f96-…`):**

1. `FLOW_PATH` / `RECIPIENT` / `EXECUTION_EVIDENCE`: one fair-share search
   unit → `MODEL_CALL_SKIPPED` (proposer) → the only query was the
   explorer locator → every candidate
   `SKIPPED_EXPLORER_HTTP_ONCHAIN_PATH_OWNS_FACT` →
   `NO_SOURCE_COULD_BE_FETCHED`.
2. `MECHANISM_SPEC`: one open of a 94,584-character sealed page →
   `EXTRACT_FAILED` diagnostic `MAX_TOKENS_TRUNCATED` →
   `EVIDENCE_EXTRACTOR_UNAVAILABLE`.

**Fixed generically** — see the ACQUISITION GRACEFUL DEGRADATION V1 section
of `CURRENT_STATE.md`:

- `documentaryExecutableLocators` (`acquisition-targeting.ts`): a locator is
  a documentary search opportunity only when the explorer open is the
  mechanism. `s4-executor.ts` decides `explorerHttpOpenIsNotTheMechanism`
  once, before query planning, and feeds both the source-open filter and
  the proposer-skip / targeting inputs from it.
- `EvidenceExtractionInput.mode = "COMPACT"`: one bounded compact
  extraction of the same document after `MAX_TOKENS_TRUNCATED`, at most
  `COMPACT_EXTRACTION_MAX_FACTS` (5) direct facts, `maxAttempts: 1`, fail
  closed on a second truncation or invalid output.

Tests: `tests/acquisition-graceful-degradation-v1.test.ts` (new, 17 cases);
`acquisition-candidate-reachability-v1` B2 and `generation-diagnostic` 17
updated to the new invariants.

### Next

- Request Founder approval for ONE A2′ + ONE B (same frozen question, same
  alpha budget). Expected cost per run ≈ A2's $0.17 plus at most one
  compact extraction per truncated document; the search-target fix adds no
  spend (it redirects an already-authorised unit).
