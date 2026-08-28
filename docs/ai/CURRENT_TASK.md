# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The generation-side diagnostic gap is **closed** (option 1 of the previous
round's fork, executed offline exactly in the BACKLOG shape). The next
EvidenceExtractor generation failure will name its cause from a closed
vocabulary instead of collapsing to a constant:

- provider/API failures are classified by **the same one classifier**
  count_tokens already uses (`classifyTokenCountFailure`, token-gate.ts) —
  `AUTHENTICATION_FAILED:401`, `PERMISSION_DENIED:403`, `NOT_FOUND:404`,
  `INVALID_REQUEST:400/422`, `RATE_LIMITED:429`, `PROVIDER_SERVER_ERROR:5xx`,
  `NETWORK_NO_RESPONSE`, `UNCLASSIFIED_PROVIDER_ERROR`;
- three output-side classes exist, each emitted only from the branch that
  deterministically identifies it: `MAX_TOKENS_TRUNCATED` (only from
  `stop_reason === "max_tokens"`), `OUTPUT_NOT_JSON` (only from the JSON-parse
  failure), `OUTPUT_SCHEMA_INVALID` (only from schema validation);
- surfaces: a single-attempt (non-transient) failure ends
  `FAILED / EVIDENCE_EXTRACTOR_UNAVAILABLE; … EXTRACT_FAILED:<class>` on the
  terminal line; a retry-exhausted transient failure ends
  `capability unavailable: EVIDENCE_EXTRACTOR — …:<class>[:<status>]`.
  Both membership-gated; forged values cannot cross (mutation-tested).

Retry counts, the 1,536 output ceiling, count_tokens diagnostics, usage
accounting, Evidence validation and D-127/D-128 semantics are all unchanged
and asserted unchanged. Contract in `ARCHITECTURE.md` ("A generation failure
names its cause"); regression suite `tests/generation-diagnostic.test.ts`.

**For the already-failed Stage B run (job `b3457f0b-…`) the
cause stays genuinely unknown** — the vocabulary is never applied
retroactively; the two-candidate narrowing (non-transient 4xx or max_tokens
truncation) stands as recorded in `CURRENT_STATE.md`.

### Next — the owner's choice

One Stage B window, when authorized, will now name the cause on its terminal
line. The document is verified (2026-08-28, offline): present, seal recomputed
and matching, **unconsumed, resumable**.

### The standing Stage B command (document still resumable)

```
npx tsx scripts/extract-from-document.ts --document-id=711e6745-abc1-44c0-b4a0-4d3eb449b7df --component=DESTINATION --step=6 --actor=owner --project=raydium --mode=documentary-only
```

If the next window reports `MAX_TOKENS_TRUNCATED`, the follow-up is an owner
decision about the extractor output ceiling (D-122 territory); if a 4xx class,
it is credential/permission territory.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
