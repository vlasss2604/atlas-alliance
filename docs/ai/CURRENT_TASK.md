# Current task

> Overwrite this file each round. Never append.

## NONE — D-143: durable categorical fetch diagnostics

Offline round. No live HTTP, no RPC, no model call, no worker started, no new
Proof, no further network probe. Observability only.

### What changed

`research_trace_events.diagnostic_code` — additive, nullable text, migration
`0036`, no default, no NOT NULL, no backfill.

The canonical vocabulary is untouched: a provider failure is still
`status = FAILED`, `reasonCode = PROVIDER_ERROR`. The diagnostic sits beside
it and answers the one question the catch-all cannot — which of its own closed
codes the provider classified.

**Only source of a value:** the existing `CONTENT_FETCH_FAILURE_REASONS` set
(`NETWORK_ERROR`, `DNS_RESOLUTION_FAILED`, `BLOCKED_ADDRESS`,
`REDIRECT_TARGET_BLOCKED`, `TIMEOUT`, `HTTP_ERROR`, `INVALID_URL`,
`UNSUPPORTED_PROTOCOL`, `TOO_MANY_REDIRECTS`, `TOO_LARGE`,
`UNSUPPORTED_CONTENT_TYPE`). No second taxonomy.

**Never stored:** raw `error.message`, `read ECONNRESET` text, stacks, IPs,
DNS answers, hostnames, or any arbitrary provider string. A real failure whose
message is `read ECONNRESET` records exactly `NETWORK_ERROR`.

Two independent gates, mirroring `safeFailureDetail` in `s4-executor.ts`: the
error class vouches for the field (`e instanceof ContentFetchError`), and
membership in the closed set vouches for the value (`safeDiagnosticCode`
re-checks at write time, because a runtime value can violate a compile-time
union). Untyped error → null. Success row → null. Historical rows → NULL,
which reads as "older than the diagnostic", never as "no failure".

### D-142 correction — read this before trusting the old analysis

- The exact typed reason for the historical `docs.raydium.io` failures is
  **UNKNOWN and unrecoverable**. `runFetchPhase` discarded it.
- Timing suggested a pre-HTTP/DNS-like failure, and the first analysis named
  `DNS_RESOLUTION_FAILED`. **That was inference, not a persisted fact, and it
  is retracted.**
- A later controlled canonical probe with MantaRay OFF returned
  `FAILED reason= NETWORK_ERROR status= null`, message observed operationally
  as `read ECONNRESET` — so DNS resolved, validation passed, and a connection
  was attempted.
- That probe does **not** retroactively prove the historical job failed as
  `NETWORK_ERROR` either. Different time, different network state.

What does hold from D-142: the failure was per **host**, not per authority
(8 of 10 failing hosts were third-party, 6 hosts succeeded), and
`provider_name` was `safe-http` on all 25 attempts.

### Verified against the real dev database

4067 trace rows before and after the migration; 3 Proofs, 419 Evidence rows,
45 jobs untouched; column nullable with no default; zero non-null diagnostics
(nothing was backfilled or invented).

### Unchanged

Fetch behaviour, SSRF, redirect revalidation, dead-URL semantics, D-141
replay, budgets, reconciliation, S5–S9.

### Standing boundaries

- The diagnostic is audit-only and may only ever hold a code-owned category.
- `PROVIDER_ERROR` remains the single canonical reason for a provider failure.
- Replay serves only what this job discovered, for the component it was
  discovered for.
- Capability is declared, never discovered.
