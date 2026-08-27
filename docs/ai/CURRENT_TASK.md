# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The bounded MECHANISM_SPEC re-extraction ran and **failed at the fetch**. The
question it was meant to answer is still open: the model never saw the page.
Details in `PUMP_CASE.md`, "The re-extraction ran, and failed at the fetch".

### What the run did and did not do

Job `168ac103-…` passed the scope gate (CONFIRMED / OFFICIAL_DOCS, prefix
`/pump-token`), then `FETCH_FAILED / PROVIDER_ERROR` with `sourceOpens 0`. Zero
Evidence rows, no `sources` row, MECHANISM_SPEC unchanged at SOCIAL-only, S5
`INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. DESTINATION untouched, as instructed.

### The finding worth acting on

Fetch-failure observability is now a **proven** defect. `ContentFetchError`
carries a typed reason from a closed eleven-value enum, but the trace hardcodes
`PROVIDER_ERROR` and `safeFailureReason` keeps only the exception class name. So a
spent live window cannot distinguish "the site refused the fetcher" from "the
tunnel was still up and the window never opened".

The smallest generic fix is identified and **not implemented**: append the typed
reason only when the error exposes one from a closed code-owned enum. It modifies
a security-motivated boundary — the current design exists because a fetch error's
*message* can carry credentials — so it wants explicit approval. No migration
needed.

### Before any retry of the extraction

Fixing observability first is worth more than another blind attempt, because a
second failure would be equally unreadable.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF to accommodate the tunnel.
- Do not edit or re-run the old DESTINATION rows.
- This task does not touch the actor → acquisition bridge.
