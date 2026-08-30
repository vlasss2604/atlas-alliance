# Current task

> Overwrite this file each round. Never append.

## NONE — D-146 Slice 2: production isolated renderer enablement

Offline round. No live HTTP, no RPC, no model call, no browser launched,
no Proof, and the owner probe deliberately NOT run.

### What changed

`ISOLATED_RENDER` is a real capability of the FETCH worker. One module,
`src/server/jobs/renderer-capability.ts`, decides on two declarations —
the `FETCH` role and `RENDERED_DOCS_ENABLED=1` — and nothing else. Not VPN
state, not DNS, not a reachability probe, not a hostname, not a project.

- **FETCH only.** SEARCH_EXTRACT never starts a browser, flag or no flag.
- **Self-test first, install second, both before any queue is served.**
- **Declared but broken = startup fails**, with the self-test's own closed
  reason. No quiet degraded mode. The self-test opens no source, writes no
  trace, reserves no sourceOpen.
- **Teardown exactly once**, renderer removed first, guarded against a
  second signal.

### The Slice 1 regression the owner predicted

Real, and fixed generically. Slice 1 planned a URL's chain only from a
failure seen live, so a redelivery reported the URL exhausted while a
never-attempted strategy was still owed to it. The ledger now carries
`failureDiagnosticsByUrl` (same `FETCH_FAILED` rows, closed D-143
vocabulary only) and `acquireOneUrl` rebuilds the plan from persisted
failure CLASSES before its first attempt. Nothing already tried is tried
again — the same chain simply continues into a strategy that has never
run. A reconstructed `HTTP_ERROR` earns nothing, because the status is not
persisted and a category cannot tell 403 from 404.

### Unchanged

Four renders per job, two fallbacks per URL, one sourceOpen reserved
before every real render inside the same 24-open envelope, security stops
that never reach the renderer, the confirmed-route gate, the closed trace
vocabulary, and transport ≠ authority.

### Prepared, NOT run

```
npm run probe:renderer -- <https url> <projectSlug>
```

Generic; same production installer, same route gate; one render, zero
retries; writes nothing; bounded output only (success/failure, final URL,
observed status if any, sizes, duration, closed failure category).

### Deferred, explicitly

- **D-146 Slice 3** — environmental-class cross-delivery SAME-STRATEGY
  retry semantics. Every later attempt is LIVE and charges another source
  open; replay stays free; full SSRF revalidation; no environment identity.
- Still deferred: unconfirmed-host rendering, cross-URL alternate
  representations, mirrors/archives, project-specific adapters.

### Standing boundaries

- Capability is declared, never discovered.
- A declared capability that cannot start fails the process, loudly.
- Only the role that acquires documents may start a browser.
- A security refusal never earns a fallback, whatever is installed.
- A strategy is never run twice for one url; a never-run one is never
  skipped just because a delivery boundary fell between them.
- Strategy is provenance, never authority.
