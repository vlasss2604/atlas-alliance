# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Raydium has a catalog row, a confirmed identity and **two unclassified routes**.
**Two inspection windows have been spent and neither page was read.** No source,
no Evidence, no job, no artifact.

### The two windows

| url | reason | proxy |
|---|---|---|
| `/ray/ray-buybacks` | `NAVIGATION_FAILED:NAVIGATION_TIMEOUT` | 0 denied, 1 allowed |
| `/raydium/protocol/protocol-fees` | `TIMEOUT` | 0 denied, 1 allowed |

No HTTP status, no `finalUrl`, no bytes, no text in either.

### The difference is real, and it is a stage difference

`NAVIGATION_TIMEOUT` is thrown **inside** `page.goto`: navigation never
completed, no response ever existed. `TIMEOUT` is the wall-clock check, and both
places it can be raised sit **after** a navigation attempt:

1. **child-side** (`rendered-docs-playwright.ts`) — the check is after the `goto`
   try/catch, so reaching it means **`goto` returned without throwing**;
2. **parent-side** (`rendered-docs-isolated.ts`) — the supervisor's hard deadline
   at `totalWallClockMs + 5_000` = 20s, for a child that produced no envelope.

`TIMEOUT` is in `CHILD_REPORTABLE_RENDER_REASONS`, so the child's own is
re-thrown by the parent with provider `"isolated"` — **identical output to the
parent's own**. Reason `TIMEOUT`, no diagnostic, no status, either way. The
printed output **cannot separate them**.

Reading 1 is the more economical one, and it is **an inference, not a finding**:
the previous window proves the child reports a `goto` timeout promptly and the
parent receives it well inside 20s, so a second `goto` timeout would have printed
`NAVIGATION_TIMEOUT` again. It printed something else. One differing observation
is not reproducibility.

### A generic limit worth fixing later — BACKLOG, not now

`startedAt` is stamped **before** `launch()`, and `navigationTimeoutMs` and
`totalWallClockMs` are **both 15_000**. Browser launch is therefore deducted from
the same budget the navigation is measured against, so a navigation that takes
14s and **succeeds** is discarded by the post-check whenever launch cost more
than a second. The renderer can throw away a completed navigation. Generic, not
Raydium-specific. Do not "fix" it inside a research task.

### Host-wide or page-specific: cannot be distinguished

Two observations, two stages, neither repeated. What they share matters more than
what differs: **no containment refusal, no proxy denial of any class, no
`HTTP_ERROR`, no `BLOCKED_BY_ROUTE_POLICY`**. Nothing observed says the site
refused ATLAS. Leading hypothesis — the 15s budget is too tight for this host
under this renderer — plausible, unproven, and engineering rather than research.

### Nothing about either page is known

Fee source, allocation share, executing address, destination, supply effect: all
**unknown, not absent**. Failure to read a source is not evidence about its
contents. Both routes stay ACTIVE and **unclassified**; neither
`84774bb9-b10a-4519-8a69-7f1c3a6c0b93` nor
`d09657e6-96b6-423e-9973-a2578cb71069` may be classified on this evidence.

No documentary locator exists, so no on-chain subject can be named.
`resolveOnchainSubject` on the confirmed RAY mint returns `NOT_FOUND`: an
identity does not admit itself.

### Next — the owner's choice, not a queue

1. **Raise the render budget first, then re-inspect.** The one change that
   addresses the leading hypothesis, and it is a code task with a regression
   test, not a live window. Separating `totalWallClockMs` from
   `navigationTimeoutMs` — or starting the wall clock after launch — is the
   generic correction.
2. **Re-inspect one url unchanged**, to test reproducibility of either signal.
   Cheapest, and it settles nothing about content if it fails again.
3. **Stop.** Two windows, no content. Closing the case with the bridge named —
   "Raydium's own documentation could not be read" — is a legitimate outcome and
   implies nothing negative about the mechanism.

Each live option is a separate authorized window, one navigation, zero retry.

**The standard when a page is finally read has not moved:** classification needs
first-party documentation of the mechanism, and a usable locator needs an
explicit **role assignment** to an address. An address occurrence, a heading, a
bare table row, or matching cardinality do not count. Pre-registered before
anything was read; PUMP closed on exactly it.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
