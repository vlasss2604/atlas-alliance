# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The first production acquisition **failed at the static content fetcher**. No
Evidence exists, the chain gate is still locked, and nothing about Raydium's
mechanism is established. Analysis only this round — no retry, no network.

### The failure, exactly

Job `451770c3-2e64-4e27-9d3e-cf8263b876d2`, `--mode=documentary-only`:

```
CONTENT_FETCHER_FAILED:ContentFetchError:UNSUPPORTED_CONTENT_TYPE
```

The static `ContentFetcher` admits exactly `text/html`, `text/plain`,
`application/json`, `application/xml`. **`text/plain` is on that list**, so the
server answered with something outside it — most plausibly `text/markdown`,
but the exact header is **not recorded**: `safeFailureReason` strips provider
messages by design, so only the reason code survives.

**The page is readable** — the browser inspection window read it end to end.
What failed is ATLAS's static transport contract meeting this representation.

The render fallback correctly did **not** fire:
`evaluateRefusalRenderEligibility` is scoped to `{401, 403, 429}`, and an
`UNSUPPORTED_CONTENT_TYPE` error carries no HTTP status, so it returns
`NOT_A_RENDERABLE_REFUSAL`. The renderer is for pages that refuse ordinary
clients, not for content-type mismatches.

### What the run did and did not create

Created: the job row, six trace events, and one S5 component result — step 6
`DESTINATION` = `INSUFFICIENT_EVIDENCE` / `NO_EVIDENCE_FOUND`, the correct
fail-closed outcome. Not created: **0** sources, **0** Evidence, **0**
locators, **0** on-chain artifacts. `findAdmittedLocator` still 0 for all four
addresses; `resolveOnchainSubject` still `NOT_FOUND`.

Two artifacts of the direct-execute entrypoint, not defects: the job row stays
`QUEUED` (no worker claimed it) and `research_attempts` is 0 (the script
executes the item directly and says so). The `sourceOpens` reserved-1 /
spent-0 mismatch is the pre-existing BACKLOG accounting item.

### D-127 held

`chain work: DISABLED by owner instruction — branch not entered`, observation
`ONCHAIN_DISABLED_DOCUMENTARY_ONLY`, zero artifacts. The mode — not the empty
locator table — is what guaranteed it.

### The options, and what each costs

The blocker is generic, not Raydium-specific: **ATLAS cannot ingest a
first-party document served as Markdown.** Raydium's own `llms.txt` index
advertises `.md` canonical urls, so this will recur on `/ray/treasury.md` and
`/ray/protocol-fees.md` too.

1. **Widen the content-type allowlist** to admit a Markdown type. Smallest
   generic correction, offline, with a regression test. It touches an SSRF-
   adjacent safety list, so it needs its own scoped owner task and careful
   reasoning about what else the widening admits — it must not become "accept
   anything".
2. **Confirm and acquire the browser-facing `/ray/ray-buybacks` route
   instead** — but that url is the SPA representation that never delivered a
   parseable document in three windows. Unattractive.
3. **Stop**, with the bridge named: the document exists and is readable by
   inspection, but is not ingestible by the production path.

Option 1 is the honest fix. It is a code change and is **not** authorized by
this analysis task.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
