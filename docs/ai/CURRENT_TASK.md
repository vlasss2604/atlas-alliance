# Current task

> Overwrite this file each round. Never append.

## PREPARED, NOT EXECUTED — the pump.fun re-extraction, with the refusal path in place

The owner authorized preparation only. **No live call was made this round.**
Nothing in the engine changed; this file is the artifact. Executing it needs a
separate authorized window.

## What the run is for

`pump.fun` refuses ATLAS's static fetcher — established, not assumed, by job
`cee22fcb-4238-4827-a1b4-6ce06f8cafa7`, which returned
`CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR`. `HTTP_ERROR` is raised
only after DNS resolved and the connection succeeded, so a server answered with
a non-2xx status.

Since then the failure carries the status number, and a refusal on an
already-renderer-eligible OFFICIAL_DOCS route opens one isolated render. So this
run answers **two** questions that no previous window could:

1. Which status is the refusal — is it one of `401`, `403`, `429`?
2. If it is, does a real browser get the page where the plain client could not?

And, only if the page is actually read, the original question underneath both:
does the current pipeline file the mechanism sentence into `MECHANISM_SPEC`?

**The run cannot fail to inform.** Every outcome, including refusal, now names
itself.

## The command

Exactly this, with the tunnel off. One line, no variations, zero retries.

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://pump.fun/pump-token \
  --component=MECHANISM_SPEC \
  --step=3 \
  --actor=owner \
  --project=pump_fun
```

## Gates — re-verified offline this round, read-only, not carried over

| gate | state | how |
|---|---|---|
| `internal_alpha_enabled` | true | local DB read |
| `ANTHROPIC_API_KEY` | set | env |
| `pump_fun` in live allowlist | yes | `INTERNAL_ALPHA_LIVE_PROJECT_SLUGS` |
| extractor model | `claude-haiku-4-5`, cost profile OK | local DB read |
| active topic | `token_value_capture` | local DB read |
| scope-gate officiality | `CONFIRMED` | `resolveSourceRoute` |
| scope-gate routeClass | `OFFICIAL_DOCS` | `resolveSourceRoute` |
| matched path prefix | `/pump-token` | `resolveSourceRoute` |
| route observation | none — no `SOURCE_ROUTE_CONFLICT` | `resolveSourceRoute` |

The script fails closed on all of these itself before spending anything, so this
table is a prediction of its behaviour, not a substitute for it.

**Route half of the refusal gate therefore passes already.** https ✓, officiality
`CONFIRMED` ✓, routeClass `OFFICIAL_DOCS` ✓, non-empty prefix ✓, and the url path
`/pump-token` equals the prefix, which `pathWithinPrefix` accepts. The **only**
undetermined input is the status number.

**Renderer dependency, verified present:** `playwright` and `playwright-core` are
installed, and the Chromium binaries exist (`chromium-1234`,
`chromium_headless_shell-1234`). The script installs the isolated fetcher itself
and sets `RENDERED_DOCS_ENABLED=1`, so `renderedDocsEnabled()` and
`renderedDocsAvailable()` are both satisfied for this run.

## Expected footprint

- **At most 2 source opens** against `pump.fun` — the static fetch, plus one
  isolated render if the refusal gate opens. `maxSourceOpens` is 2 and the
  SearchGateway yields exactly one candidate, so there is no third and no
  competing candidate to spend the second on.
- **At most 1 Anthropic call** (the extractor), and only if a document is read.
- **0 search-provider calls.** Brave is never constructed; the proposer is a
  fixture.
- **0 chain calls.** No on-chain retriever is in the script's import graph.

## Reading the result

`spent.sourceOpens` is the tell, because a *failed* static fetch reserves DB
budget but never increments the reported `spent`. Read the console this way:

| status | reason | spent.sourceOpens | meaning |
|---|---|---|---|
| FAILED | `…:HTTP_ERROR:404` (or 5xx) | 0 | refusal is not renderable; no render attempted — correct behaviour, question closed differently |
| FAILED | `…:HTTP_ERROR:403` (or 401/429) | 0 | should not happen — would mean a route gate refused after all; investigate the gate, not the site |
| FAILED | `…:HTTP_ERROR:403` (or 401/429) | 1 | render **was** attempted and failed. See the ambiguity below |
| FAILED | `…:BLOCKED_ADDRESS` | 0 | the tunnel was still up. The window never opened; not a result |
| SKIPPED / FAILED with evidence-stage reason | carries `DOCS_RENDERED_AFTER_REFUSAL` | 1 | **the render worked.** The page was read and the pipeline's filing behaviour is finally observable |

A successful render reaches the extraction stage, whose reasons are wrapped with
the observation channel — so `DOCS_RENDERED_AFTER_REFUSAL` will be visible in the
`reason:` line. The zero-document failure path is not wrapped, so on a failed
render the reason line shows only the static failure string and
`spent.sourceOpens = 1` is the sole indicator.

## Known ambiguity, to state honestly before the window rather than after

**A failed render will not say why it failed.** The catch is bare and records
only `DOCS_RENDER_AFTER_REFUSAL_FAILED`. So row 3 above cannot distinguish
"`pump.fun` refused the browser too" from "the isolated renderer's own plumbing
failed here" — the scrubbed-env child spawn, the egress proxy and a real Chromium
launch have never been exercised end-to-end against a live host on this machine.

This is the same class of defect as the one just fixed: a failure that cannot say
which failure it was. It is **named, not fixed** — fixing it is a separate task
and was not authorized this round. Neither render path records a trace event
either; that asymmetry is pre-existing and was not introduced by `e9269fb`.

If the owner wants row 3 to be unambiguous, that observability work should land
**before** the window, not after it.

## Procedure for the window (from `PUMP_CASE.md`)

1. this command, already prepared above — do not edit it;
2. MantaRay OFF;
3. `ipconfig /flushdns`;
4. verify DNS returns real public IPs for `pump.fun` and `api.anthropic.com`;
5. execute once;
6. capture the complete console output the first time;
7. **zero retries**;
8. MantaRay ON again;
9. analyse offline.

With MantaRay up both hosts resolve into `198.18.0.0/15` and would be
SSRF-blocked. That is the protection working and is never to be relaxed.

## Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
