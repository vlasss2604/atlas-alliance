# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The second production acquisition **cleared the transport and failed at the
model provider**. No Evidence exists, the chain gate is still locked. Analysis
only — no retry, no network.

### Real progress: the document was fetched

Job `4b437b14-1cf8-4637-8539-e0e1e4835e62`. The same url that traced
`FETCH_FAILED` in run 1 traced **`FETCH_OK`** in run 2, with the only
intervening change being the two lines admitting `text/markdown`. That
controlled before/after is the evidence the fix worked — and it is the strongest
available statement, because **the header value is still not persisted**:
`FETCH_OK` records no content type, and no Source row was created.

### The new blocker

```
CapabilityFatalError: capability unavailable: EVIDENCE_EXTRACTOR_COUNT_TOKENS
```

`countThenGate` raised `TokenCountUnavailableError`, which
`reserveAndCallWithRetry` classifies as **immediately fatal** — count_tokens
already spent its own internal `retryOnceIfTransient` inside `token-gate.ts`
before throwing. Exactly one extraction attempt; the executor did not retry.

### The diagnostic gap this exposes — recommended next task

**Why the count failed cannot be recovered from anything persisted.**
`safeFailureDetail` extracts a status only for `ContentFetchError` and returns
null here; `CapabilityFatalError`'s message carries only the capability name;
the computed reason travels as an unprinted `cause`; the trace reason code is
the generic `PROVIDER_ERROR`.

So a bad credential (401), an unrecognised model id (404), an exhausted rate
limit (429) and a provider outage (5xx) are **indistinguishable** — and each
calls for a different action: fix a secret, fix the model id, wait, or wait
longer. The model id sent is `claude-haiku-4-5` (config default; its cost
profile resolves fine).

This now meets the bar I declined to meet last round for the MIME case: it
**materially prevents a blind live retry**. An HTTP status integer from
`Anthropic.APIError` is the same class of safe, closed, non-sensitive value the
codebase already persists for `ContentFetchError` — no message, no body, no
provider text. Recommended as its own scoped offline task with a regression
test; **not done here**, since this round is analysis only.

### What this run persisted

The job row and eight trace events. **No Source** (creation happens at
Evidence-persist time, never reached), no Evidence, no locators, no artifacts,
and — unlike run 1 — **no component result**, because the exception propagated
out of `execute()` before the script's S5 call. `findAdmittedLocator` 0 for all
four addresses; `resolveOnchainSubject` `NOT_FOUND`.

**D-127 held again**: branch not entered, no retriever, zero artifacts.

### Also observed, not a research finding

After the fatal error the process aborted during teardown with a libuv
assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`). All
trace writes had already committed — no data loss — but the cleanup path is not
crash-clean on Windows when `execute()` throws. Worth a BACKLOG line, not a
research window.

### The options

1. **Add the closed provider-status diagnostic**, then one live window. The
   only option that stops the next attempt from being blind.
2. **Investigate the credential/model id offline** — check `ANTHROPIC_API_KEY`
   validity and whether `claude-haiku-4-5` is an id the API accepts. Cheaper,
   but it cannot confirm which cause was actually hit.
3. **Stop.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
