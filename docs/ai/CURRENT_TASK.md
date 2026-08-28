# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

`text/markdown` is admitted as a document representation. **Raydium was not
re-run** — no HTTP, RPC, browser or model call this round.

### The fix

Two lines: `"text/markdown"` added to the `ContentType` union
(`providers/types.ts`) and to `ALLOWED_CONTENT_TYPES`
(`providers/content-fetcher.ts`). Nothing else in production changed.

It is genuinely that small because the fetcher already branches only on
`text/html` (HTML normalization + opt-in Stage 0 payload recovery) and treats
**everything else** as `rawText.trim()`. Markdown therefore travels the exact
`text/plain` path — trimmed text, never parsed, rendered or followed; no
embedded HTML executed, no link resolved, no directive honoured.

### Why it is safe, verified structurally

The MIME gate sits **last**: SSRF/DNS/redirect validation happens *before any
network activity*, the byte cap is enforced *during streaming*, and the HTTP
status check precedes the content-type check. Admitting a MIME essence cannot
loosen any of them — and each is pinned by a test in the new file, not merely
argued.

The allowlist stays a **closed list of essences, never a family**. The
load-bearing test probes an unknown `text/x-made-up-subtype`; it **fails** if
the check ever becomes a `text/*` prefix match. Verified by actually mutating
the code to a wildcard: exactly that one test failed, then the mutation was
reverted.

**MIME is representation, never authority.** Content type is read from the
response header and never inferred from a file extension; officiality, source
class, project identity and truth are unchanged and untouched.

### Observability — deliberately NOT changed

I assessed adding a closed diagnostic carrying the rejected MIME essence.
**Declined for now.** The essence is arguably safe to expose (it is a short,
server-declared token, and the codebase already persists `content_type` in
network observations), but the criteria were not met: this failure has occurred
once, and the one page it blocked is now expected to pass. Adding a diagnostic
channel on a single occurrence is speculation, and `safeFailureReason`'s
message-stripping discipline (D-116 MEDIUM-2) is deliberate. Revisit if an
`UNSUPPORTED_CONTENT_TYPE` failure recurs on a page that matters — at that
point it would materially prevent a blind live retry, which is the bar.

### Raydium preflight — offline, conditional

**Not run, and no claim is made about the live server's header** — the failed
run recorded only the reason code, never the value. What can be said: *if* the
response essence is `text/markdown`, the same command now passes the
content-type gate, and the route/authority gates it already passed are
unchanged:

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://docs.raydium.io/ray/ray-buybacks.md \
  --component=DESTINATION --step=6 --actor=owner --project=raydium \
  --mode=documentary-only
```

If the server sends some *other* unsupported essence, this run will fail the
same way — and that is the correct outcome, not a reason to widen further.

### State unchanged

Raydium: 0 Evidence, 0 sources, 0 locators; `findAdmittedLocator` 0;
`resolveOnchainSubject` `NOT_FOUND`; chain gate locked. Routes, classification,
documentary-only mode and D-127 untouched.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
