# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The third authorized `pump.fun` window was executed by the owner and analysed
offline. No further live call was made.

### What the window established

`pump.fun` refuses the static fetcher with **`403`** — a renderable status. The
scope gate passed, the refusal path opened exactly as designed, and the render
was attempted once on its own reservation.

**The render failed because our browser never started**, not because of the
site: `DOCS_RENDER_AFTER_REFUSAL_FAILED:BROWSER_LAUNCH_FAILED`, raised before any
navigation. The hypothesis that the page defeats the renderer has still never
been tested.

Under last week's code the same run would have said only
`DOCS_RENDER_AFTER_REFUSAL_FAILED`, and the obvious reading would have been the
opposite, wrong conclusion. Second time in this case that an observability fix
paid for itself on first use.

Nothing was written: zero Evidence, no `sources` row, `MECHANISM_SPEC` unchanged
at 112 SOCIAL/CLAIMED rows, S5 `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. The
extractor was never reached. Details in `PUMP_CASE.md`, "Third attempt".

### The blocker, and why it needs no live window

**The isolated renderer will not launch on this machine right now.** Verified
offline: Chromium `chromium-1234` is installed and complete, `playwright` 1.62.1
matches the revision its own `browsers.json` names, and this same isolated path
rendered this very page successfully earlier in the project. So neither the
install, the code path nor the host is new.

Why it fails is **not** established, and cannot be from what was captured: the
child is spawned with `stdio: [..., "ignore"]`, so Playwright's launch
diagnostic is discarded at the boundary. A scrubbed-environment cause was
considered and is weakened rather than supported — that same allowlist was in
force for the render that worked.

This is reproducible **entirely offline**. Diagnosing it needs no authorized
window and no network: the renderer can be pointed at a local fixture, and
`BROWSER_LAUNCH_FAILED` can be split into code-owned sub-reasons the same way
the stage itself was split. Nothing here requires touching `pump.fun`.

**Do not spend another live window until it is fixed.** The fetch will be
refused with `403` again and the render will fail at the same stage again; the
outcome is already known.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
