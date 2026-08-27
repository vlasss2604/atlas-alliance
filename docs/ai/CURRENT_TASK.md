# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The Chromium launch failure was investigated offline. **It does not reproduce**,
and no speculative fix was made.

### What was established

The isolated renderer is **healthy on this machine**. Driven through the
production path — real egress proxy, real scrubbed environment, real argv-only
spawn, real child script, real shared launch call — it starts Chromium
`151.0.7922.34` in about 2.5–5 seconds, repeatably, well inside the 20-second
parent deadline.

Every candidate cause was tested and cleared on its own: the scrubbed
environment, the production proxy launch arguments, the child's `stdio` with
stderr ignored, and a `TEMP`/`TMP` pointed at a non-existent path. **No
environment variable was added and nothing was loosened**, because nothing
needed to be.

So the live failure was transient or environmental — the run was made seconds
after the VPN tunnel was taken down — and it stays **unexplained**. It is not
written down as understood.

### What changed, so this is never opaque again

**A self-test.** `npx tsx scripts/renderer-selftest.ts` answers "can this
machine start the locked-down browser?" offline, in seconds, with no
authorization. It navigates nowhere: the self-test message carries no url, no
confirmed host and no path prefix, so the child structurally cannot be pointed
at anything, and the only page opened is `about:blank`.

**A launch diagnostic.** A browser that fails to start now says which local
fault it was — `…:BROWSER_LAUNCH_FAILED:EXECUTABLE_NOT_FOUND`,
`:PROCESS_START_FAILED`, `:PROCESS_EXITED_DURING_LAUNCH`, or
`:UNKNOWN_BROWSER_LAUNCH_FAILURE`. All three named values were observed by
inducing the failure offline and reading what Playwright actually emitted; the
raw message is classified once and dropped, because every real one carried an
absolute filesystem path and two carried Chromium's whole command line.

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

**Run the self-test first, in the same session.** If it fails, do not open the
window — the outcome is already known.

What the last window established and this one does not change: `pump.fun`
answers `403`, the scope gate passes, and the refusal path opens the render
correctly. What is still untested is whether `pump.fun` serves the page to
Chromium.

One limit to hold while reading the next result: a browser served `403`
receives a page, not an error. If `pump.fun` refuses Chromium, the run reports a
*successful* render of the refusal page. Nothing distinguishes that from a real
document today — known, and not changed here.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
