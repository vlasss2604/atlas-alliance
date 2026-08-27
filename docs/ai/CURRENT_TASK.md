# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The renderer observability gap is closed. Written up in `ARCHITECTURE.md`,
"What a failure may say about itself".

### What changed

A failed render now names the stage that failed:
`DOCS_RENDER_AFTER_REFUSAL_FAILED:BROWSER_LAUNCH_FAILED`, and the same for every
other stage. Previously every renderer failure collapsed into one
indistinguishable observation, so a browser that never started read exactly like
a site that defeated the browser — opposite diagnoses with opposite next moves.

The renderer had typed reasons the whole time. The child classified its own
failure and put a reason on the wire; the parent supervisor discarded it one line
before use. Three further stages had no reason of their own at all — the egress
proxy, the spawn, and the exit — and now do.

Reasons are admitted through two independent gates: the `RenderedDocsError` class
**and** membership of a closed list that now exists at runtime, plus, for the
child's envelope, membership of the subset the child could actually have
witnessed. No message, stack, url, stderr or renderer name crosses. The trace
enum is untouched, so no migration.

### The next intended action, unchanged and still prepared

**The pump.fun re-extraction.** Not opened this round, by instruction. Run it
with the tunnel off, exactly this, zero retries:

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://pump.fun/pump-token \
  --component=MECHANISM_SPEC \
  --step=3 \
  --actor=owner \
  --project=pump_fun
```

Gates were re-verified offline last round and nothing since then touched them:
internal alpha on, key present, `pump_fun` allowlisted, extractor
`claude-haiku-4-5` with a resolvable cost profile, topic `token_value_capture`,
and the scope gate resolving CONFIRMED / OFFICIAL_DOCS on prefix `/pump-token`
with no route conflict. The route half of the refusal gate already passes, so the
only undetermined input is the status the server answers with.

**Footprint:** at most two source opens (`maxSourceOpens` is 2 and the injected
gateway yields exactly one candidate), at most one model call and only if a page
is read, no search provider, no chain call.

**Reading the result.** `spent.sourceOpens` is the tell — a failed static fetch
reserves database budget without incrementing the reported spend.

| status | reason | spent.sourceOpens | meaning |
|---|---|---|---|
| FAILED | `…:HTTP_ERROR:404` (or 5xx) | 0 | refusal is not renderable; no render attempted |
| FAILED | `…:HTTP_ERROR:403` (or 401/429) | 1 | render attempted and failed — **the suffix now names the stage** |
| FAILED | `…:BLOCKED_ADDRESS` | 0 | the tunnel was still up; the window never opened |
| SKIPPED / FAILED with an evidence-stage reason carrying `DOCS_RENDERED_AFTER_REFUSAL` | | 1 | the render worked; the page was read |

Row 2 was the ambiguous one and is no longer ambiguous:
`…FAILED:BROWSER_LAUNCH_FAILED` or `…:CHILD_SPAWN_FAILED` or
`…:EGRESS_PROXY_UNAVAILABLE` means the fault is local and the site is innocent;
`…:HOST_NOT_ALLOWED` or `…:NAVIGATION_BLOCKED` means our own containment
refused; `…:TIMEOUT` or `…:TOO_LARGE` implicates the page; a bare
`DOCS_RENDER_AFTER_REFUSAL_FAILED` with no suffix means the error was not a
renderer error at all.

**One limit to hold in mind while reading it.** A browser served `403` receives a
page rather than an error, so if `pump.fun` refuses Chromium the run reports a
*successful* render of the refusal page, not a failure. Nothing currently tells
that apart from a real document. This is a known gap, not a defect introduced
here, and no code was changed for it.

**Procedure** (from `PUMP_CASE.md`): MantaRay OFF, `ipconfig /flushdns`, verify
real public IPs, execute once, capture the complete output the first time, zero
retries, MantaRay ON, analyse offline.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
