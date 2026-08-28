# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

**Stage A succeeded; Stage B has not run in substance.** The Raydium buyback
document is persisted, sealed and unconsumed. No Evidence exists; the chain
gate is still locked. Analysis only this round — no live calls, no retry, no
code changes.

### Stage A — verified, not just read from the terminal

Document `711e6745-abc1-44c0-b4a0-4d3eb449b7df` (job `983d8ebb-…`):
`text/markdown` (**the header value is now persisted for the first time**),
HTTP 200, 2,940 bytes, `STATIC`, authority snapshot
`CONFIRMED / OFFICIAL_DOCS / /ray/ray-buybacks.md`, `consumedAt null`. The
seal was recomputed offline and matches. The stored `text_sha256`
(`f71a3dd3…`) equals the browser window's rendered-text hash — two
transports, one identical document. All four role-bound addresses are
literally present in the stored text (checked in the DB).

Created beyond the document: only the executor's pre-existing url-registry
`sources` row (`OTHER` / `UNKNOWN`, no content, no authority — not Evidence).
Zero Evidence, locators, artifacts, attempts, component rows. Trace confirms
the real `safe-http` fetch and the `document-capture` stub. `findAdmittedLocator`
0 for all four addresses; `resolveOnchainSubject` `NOT_FOUND`.

### Stage B — why it did not run

The invocation used the **literal placeholder** `<DOCUMENT_ID>`. Postgres
refused the malformed uuid at the row lookup — before any job creation,
before any fetch, before any model call. Verified: still exactly three
Raydium jobs (the two old failures + Stage A), and the document is
unconsumed. Another owner-authorized Stage B is technically allowed and is
exactly what the contract anticipates.

One hardening item recorded in BACKLOG (not fixed here): a malformed id
should produce the closed `NOT_FOUND` refusal, not a raw driver error that
echoes the SQL.

### The next owner act — Window 2, MantaRay ON, with the REAL id

```
npx tsx scripts/extract-from-document.ts --document-id=711e6745-abc1-44c0-b4a0-4d3eb449b7df --component=DESTINATION --step=6 --actor=owner --project=raydium --mode=documentary-only
```

No Raydium fetch is possible in this stage (replay transport only); RPC is
impossible under documentary-only (D-127). After success, evaluate offline:
`findAdmittedLocator(DdHDoz…VEZaz)` and `resolveOnchainSubject`.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
