# Current task

> Overwrite this file each round. Never append.

## NETWORK TRANSIENT RESILIENCE V1 (done this round)

Offline round. No live call, no provider/model call, no new Research job, no
budget change, no retry-count change, no schema, no new subsystem, no
provider fallback, no Happ/Windows/VPN change. Founder decision:
application-level resilience only.

The unseen Lido validation `1f8e1a63-…` did not fail on research semantics:
it died `FAILED / SYSTEM_OR_PROVIDER_FAILURE / CapabilityFatalError` on ONE
document's `count_tokens` `NETWORK_NO_RESPONSE` during a short Windows Happ
tunnel outage, after substantial paid work had completed. Its one immediate
count_tokens retry landed inside the same outage.

- **Part 1 — count_tokens transient exhaustion is document-local, N = 2.**
  `reserveAndCallWithRetry` now splits the count_tokens fatal cause on the
  error's existing `transient` flag: `TOKEN_COUNT_TRANSIENT_RETRY_EXHAUSTED`
  (two attempts, 429/5xx/no-response) vs `TOKEN_COUNT_UNAVAILABLE` (one
  attempt, permanent). The EvidenceExtractor loop treats the former exactly
  like generation `TRANSIENT_RETRY_EXHAUSTED`: `EXTRACT_FAILED`
  (`reason_code TOKEN_COUNT_UNAVAILABLE`, typed `diagnostic_code`), no
  Evidence, no contradiction, attempt continues; the SAME consecutive-
  document counter and threshold apply (one increment per document — the
  retry is inside the call); a successful extraction resets; the second
  consecutive transient document (either cause) throws `CapabilityFatalError`
  exactly as before. Permanent count_tokens failures stay immediately fatal.
- **Part 2 — one bounded wait before the one count_tokens retry.**
  `retryOnceIfTransient(fn, isTransient, { delayBeforeRetryMs })`;
  `countThenGate` passes `countTokensRetryDelayMs`: 15 s
  (`NETWORK_NO_RESPONSE_RETRY_DELAY_MS`) only for `NETWORK_NO_RESPONSE`,
  0 for every other class. No third attempt, no delay on success, none for
  429/5xx (unchanged immediate retry), none for permanent failures.
- **Not changed.** The executor-level generation retry still retries at
  once (out of the approved scope — same option, one more call site, if
  wanted). QueryProposer count_tokens transient exhaustion stays fatal.
  Evidence admission, authority, SOURCE_ROUTE, reducers, routing, Research
  Memory, EVM/Solana scope: untouched.

Files: `src/server/engine/providers/retry.ts`,
`src/server/engine/providers/token-gate.ts`, `src/server/engine/s4-executor.ts`,
`scripts/anthropic-count-tokens-probe.ts`,
`tests/transient-extractor-resilience-v1.test.ts`,
`tests/count-tokens-diagnostic.test.ts`, `docs/ai/CURRENT_STATE.md`,
`docs/ai/ARCHITECTURE.md`, this file.

### Reported, not done

- The generation-path retry in `reserveAndCallWithRetry` has no pre-retry
  wait: a tunnel flap that outlasts count_tokens' 15 s wait can still cost
  that document its generation retry immediately (then tolerated once by
  Part 1 / TRANSIENT EXTRACTOR RESILIENCE V1).
- The tolerance class is the existing `transient` flag (429/5xx/no-response),
  the same class the generation-side tolerance already uses — not
  no-response only. One rule for both calls, deliberately.
- A non-transient document-local failure between two transient documents
  still does NOT reset the count (unchanged from TRANSIENT EXTRACTOR
  RESILIENCE V1).

### Next

- Founder decides whether to spend one bounded validation run.
