# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The second authorized run failed at the fetch again, but this time it said why:

```
CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR
```

`pump.fun` refuses ATLAS's static fetcher. Details in `PUMP_CASE.md`, "Second
attempt: the page refuses the fetcher". No code changed this round.

### What that word settles

`HTTP_ERROR` is raised only after DNS resolved and the connection succeeded, so
the server answered with a non-2xx status. It was **not** `BLOCKED_ADDRESS` —
which also proves the tunnel was genuinely off and the window genuinely open —
nor DNS, timeout, or content-type. Nothing about the engine or the tunnel needs
changing.

MECHANISM_SPEC is unchanged (SOCIAL-only), no Evidence was created, DESTINATION
untouched, S5 `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`.

### Two open decisions, neither started

- **Render-on-refusal.** The isolated renderer exists for exactly this case and a
  real browser is what usually satisfies bot protection — but the render gate
  reads the size of an *already-fetched* document, so it is an upgrade path for a
  successful fetch, never a fallback for a refused one. Adding that branch costs a
  source open on every refusal. Generic, not a Pump.fun quirk.
- **HTTP status granularity.** 403 vs 429 vs 404 lives in the exception message
  and is not surfaced. A status code is a bounded integer, so it could join the
  closed allowlist — a new decision, not a consequence of the last one.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, and never spoof a user agent to defeat a refusal
  without an explicit decision.
- Do not edit or re-run the old DESTINATION rows.
