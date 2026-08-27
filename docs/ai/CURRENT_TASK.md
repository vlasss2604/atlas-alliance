# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The last correctness gap in the rendered-docs path is closed. Written up in
`ARCHITECTURE.md`, "Rendering: two ways in, one set of gates".

### What changed

**A rendered page must have answered with a success status.** A browser does not
throw on `403` — it receives the refusal page, renders it, and reports success —
so the renderer would have handed a server's "access denied" HTML to extraction
as though it were the page we asked for. `page.goto()` returns the Response that
says otherwise, and it was being discarded although the adapter's own type
already declared it.

It is read now. A non-success status fails closed as `HTTP_ERROR` carrying the
trusted number, surfacing as `…:HTTP_ERROR:403`. The number comes from
`Response.status()` and from nowhere else — never from markup, a title, a body, a
header or an error string — so a page claiming `200 OK` in its own text changes
nothing, and a page that merely discusses `403` is still a document.

The success rule `200..299` is now **one shared predicate** used by both the
static fetcher and the renderer. Which statuses yield a document is a property of
HTTP, not of the transport, and two copies would eventually disagree. `204` sits
inside that class and renders to an empty document, which cannot become evidence.

Redirects are unchanged: Playwright returns the last response, and the route
check still runs first, because landing outside the confirmed route is a
containment failure and the more serious statement. A navigation with no Response
at all is `NO_NAVIGATION_RESPONSE` — unverifiable is not the same as fine.

Nothing was relaxed, and the renderer self-test still passes offline.

### The next intended live action, unchanged

**The `pump.fun` MECHANISM_SPEC re-extraction**, exactly as prepared:

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://pump.fun/pump-token \
  --component=MECHANISM_SPEC \
  --step=3 \
  --actor=owner \
  --project=pump_fun
```

**Run `npx tsx scripts/renderer-selftest.ts` first, in the same session.** If it
fails, do not open the window.

What is established: `pump.fun` answers `403` to the static fetcher, the scope
gate passes, and the refusal path opens the render correctly. What is still
untested is whether `pump.fun` serves the page to Chromium — and that question
now has an honest answer either way. The risk flagged in the prepared run, that a
refusal to the browser would come back looking like a successful render, is gone.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
