# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Fetch-failure observability is fixed. A terminal reason now carries the typed
reason — `CONTENT_FETCHER_FAILED:ContentFetchError:BLOCKED_ADDRESS` — which is
enough to tell a refusal from a block from a timeout. The boundary is written up
in `ARCHITECTURE.md`, "What a failure may say about itself".

### What guards it

Two independent gates, both required: the error is `instanceof ContentFetchError`
— a class this repository owns, never a duck-typed `reason` field — **and** the
value is a member of the closed list the reason type is derived from. The second
is not redundant: a runtime value can violate a compile-time union.

Message, stack, url, headers and response body are still never surfaced. The
trace's `reason_code` stays a closed Postgres enum recording `PROVIDER_ERROR`, so
there is no migration.

### Worth knowing

The Pump.fun run that motivated this is **not** retroactively explained — its
reason was recorded before the fix and still reads only
`CONTENT_FETCHER_FAILED:ContentFetchError`. A future attempt would say why it
failed, which is the point.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF to accommodate the tunnel.
- Do not edit or re-run the old DESTINATION rows.
- PUMP semantics were not touched in this task.
