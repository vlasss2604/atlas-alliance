# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Two generic acquisition gaps are closed. Written up in `ARCHITECTURE.md`, "What a
failure may say about itself" and "Rendering: two ways in, one set of gates".

### What changed

A fetch failure now carries the HTTP status when there was one —
`CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:403`. The number comes from
the Response's own `status` and is re-checked as an integer in 100..599; it is
never parsed out of a message, and a number cannot carry a URL, a header or a
body whatever the server sent.

And a static request declined by `401`, `403` or `429` on an already
renderer-eligible OFFICIAL_DOCS route now attempts exactly one isolated render,
on its own source-open reservation. Previously the renderer was reachable only as
an upgrade to a fetch that had already succeeded, so a site declining ordinary
clients made its own docs permanently unreadable.

`404`, ordinary 5xx (503 included) and every failure that never reached a server
are excluded. Same renderer, same route gates in one shared implementation, no
user-agent spoofing, no evasion, zero retry.

### Not yet known

`pump.fun` was **not** re-run in that task, as instructed. Whether its refusal is
one of the three statuses, and whether a render would then succeed, is untested.
That is the obvious next authorized window, and the run would now say which
status it hit either way.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, and never add anti-bot evasion.
- Do not edit or re-run the old DESTINATION rows.
