# Current task

> Overwrite this file each round. Never append.

## NONE — D-146 Slice 1: the bounded acquisition chain, offline

Offline round. No live HTTP, no RPC, no model call, no worker started, no
browser launched, no Proof.

### What FETCHING does now

A closed chain of three code-owned strategies per URL, stopping at the first
COMPLETE document:

```
DIRECT_HTTP  →  CONTENT_NEGOTIATION  →  ISOLATED_RENDER
```

- **DIRECT_HTTP** — canonical safe-http, unchanged.
- **CONTENT_NEGOTIATION** — the *same URL*, the *same transport*, one
  different standard `Accept` header (`ACCEPT_PREFERENCES = DEFAULT |
  TEXT_REPRESENTATION`). No new host, no guessed path, no vendor header;
  every DNS/blocked-address/pinning/redirect check identical.
- **ISOLATED_RENDER** — the existing isolated renderer through its existing
  seam. **Slice 1 starts no browser**; production installs no renderer, so
  this branch is inert until Slice 2.

**Stage-0 is not a strategy.** `recoverEmbeddedPayloads` is requested on the
same fetch call under the existing `docsPayloadRecoveryEligible` gate and
reserves no extra source open.

### Fallback policy (by failure class, never by hope)

| class | fallback |
|---|---|
| `BLOCKED_ADDRESS`, `REDIRECT_TARGET_BLOCKED` | **none — chain ends** |
| `INVALID_URL`, `UNSUPPORTED_PROTOCOL`, `TOO_MANY_REDIRECTS`, `TOO_LARGE`, `DNS_RESOLUTION_FAILED`, untyped | none |
| `HTTP_ERROR` 404/410/5xx | none |
| `HTTP_ERROR` 401/403/429 | render (existing render-on-refusal policy) |
| `NETWORK_ERROR`, `TIMEOUT` | negotiate, then render |
| `UNSUPPORTED_CONTENT_TYPE` | negotiate |

The security row is the load-bearing one: every strategy shares one address
classifier, so a fallback there could only "succeed" by weakening the boundary.

For the render-after-transport-failure path (where no HTTP status exists), the
existing shared `routeEligibility` gate is now exported and reused — the same
https + CONFIRMED + OFFICIAL_DOCS + matched-prefix test both existing policies
are built on. No third notion of renderability; the route bar is unchanged.

### Bounds, metering, memory

`MAX_FALLBACK_ATTEMPTS_PER_URL = 2`; `MAX_RENDER_ATTEMPTS_PER_JOB = 4` (a
policy ceiling counted from persisted trace, so redelivery cannot reset it);
everything inside the unchanged 24 source opens. **No new budget axis.** Every
real strategy invocation reserves before the call; D-137 replay stays free and
provider-declared.

The ledger gained `strategiesAttempted` and `attemptsByProvider` from the same
`FETCH_ATTEMPTED` rows, and `loadFetchTargets` now retires a URL on
**acquisition**, not on one provider's failure — so a worker death between
strategies lets redelivery continue with the next without repeating or
re-paying for the first.

### Provenance and integrity

Migration `0037`: nullable `acquisition_strategy` (closed in code to the three
strategies) and `admission` (`OWNER_STRICT`/`PRODUCT_ACQUISITION` — previously
a function parameter no row recorded). Additive, no backfill; historical rows
read NULL. **No completeness column**: a sealed document is complete by
invariant.

**Transport ≠ authority** — pinned by test: negotiation succeeding on an
unconfirmed route leaves authority `CLAIMED`/null.

The phased replay now verifies the same `textSha256` seal the strict resume
path verifies; a mismatch removes the document from the replay set, never
repairs or re-seals it.

### Deferred, explicitly

- **D-146 Slice 2** — production FETCH worker renderer enablement, isolated
  self-test, one controlled owner probe.
- **D-146 Slice 3** — environmental-class cross-delivery same-strategy retry
  (every later attempt is LIVE and charges another source open; replay stays
  free; full SSRF revalidation; no environment identity).
- Also deferred: unconfirmed-host rendering, cross-URL alternate
  representations, mirrors/archives, project-specific adapters.

### Standing boundaries

- A security refusal never earns a fallback.
- Partial content is never sealed; there is no third completeness state.
- No URL is invented; the chain only ever re-attempts what search found.
- A strategy is never run twice for one URL.
- Strategy is provenance, never authority.
