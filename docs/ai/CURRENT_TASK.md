# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The count_tokens diagnostic gap is closed. **No live call was made** — every
client in every test is a stub, Raydium was not re-run, and nothing about
routes, Evidence, D-127 or token limits changed.

### What changed

- **`TOKEN_COUNT_DIAGNOSTICS`** (token-gate.ts) — a closed, code-owned set:
  `AUTHENTICATION_FAILED` (401) · `PERMISSION_DENIED` (403) · `NOT_FOUND`
  (404 — the endpoint is SDK-fixed, so in practice the model id) ·
  `INVALID_REQUEST` (400/422) · `RATE_LIMITED` (429) · `PROVIDER_SERVER_ERROR`
  (5xx) · `NETWORK_NO_RESPONSE` (the SDK's own no-response class or a
  status-less APIError; claims nothing about DNS/VPN/routing) ·
  `UNCLASSIFIED_PROVIDER_ERROR`.
- Classified **once, at the throw site**, from the SDK's class identity and
  trusted status integer — never from a message. `TokenCountUnavailableError`
  now carries `diagnostic` + `httpStatus` (appended constructor params; every
  existing construction stays valid).
- The boundary (`safeFailureDetail`) admits it through the **same two-gate
  discipline as fetch details**: class + runtime membership check. A forged
  out-of-vocabulary value returns null — mutation-tested.
- `CapabilityFatalError` now surfaces a **string** cause in its message (all
  string causes are safeFailureReason products), so the next terminal failure
  reads e.g.
  `capability unavailable: EVIDENCE_EXTRACTOR_COUNT_TOKENS — EVIDENCE_EXTRACTOR_FAILED:TokenCountUnavailableError:RATE_LIMITED:429`.

### What a future single failure now tells the operator

- `AUTHENTICATION_FAILED:401` → credential problem
- `NOT_FOUND:404` → configured model id problem
- `RATE_LIMITED:429` → usage/rate ceiling
- `PROVIDER_SERVER_ERROR:5xx` → provider-side failure
- `NETWORK_NO_RESPONSE` → the provider was never heard from; the network path
  (including the MantaRay-off window arrangement) is where to look

No retry is prescribed by any of these; the mode of the next window stays an
owner decision. The previous run's cause remains **genuinely unknown** — it
predates this fix and nothing recorded it.

### Deliberately unchanged

Retry semantics (at most one internal count_tokens retry, only for
429/5xx/no-status; 401/403/404 stay non-retryable and single-attempt —
asserted), token limits, documentary-only mode, D-127, fetch and renderer
failure semantics (asserted unchanged), the trace vocabulary (no enum
migration; the diagnostic travels in the error surfaces).

### Windows teardown residual — assessed, not fixed

The libuv abort happens **after** the terminal message prints and after all
trace writes commit, on both observed occurrences — so it neither destroys the
new diagnostic nor loses data. Recorded in `BACKLOG.md` under
Tooling/environment.

### Next — the owner's choice

1. **A third live window** with the same prepared command. If it fails again,
   the terminal line now names the class; if it succeeds, the DESTINATION
   evidence path finally runs end to end.
2. **Stop.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
