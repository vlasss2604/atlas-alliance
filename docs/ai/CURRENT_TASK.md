# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The renderer's phase-budget defect is fixed generically. **Raydium was not
re-run**, nothing was classified, and no Evidence exists.

### What was wrong

`totalWallClockMs` was checked once, immediately after navigation, against a
clock stamped **before** `launch()`. With `navigationTimeoutMs` and
`totalWallClockMs` both `15_000`, browser startup was subtracted from the budget
the navigation was judged against — so a navigation that completed well inside
its own timeout could still be discarded as `TIMEOUT`. The renderer could throw
away a completed navigation.

Startup was also the one phase with **no bound this repository owned**:
`launch()` was called with no `timeout`, inheriting Playwright's undeclared 30s
default.

### What changed

- `browserLaunchTimeoutMs` (new, `20_000`) bounds startup, enforced by the driver
  at `launch()` — the same arrangement `navigationTimeoutMs` already had at
  `page.goto`. Sized from measurement: `renderer-selftest.ts` took 7,095 ms cold
  and 2,831 ms warm on this machine.
- `totalWallClockMs` (unchanged at `15_000`) now measures the **document phase**,
  from the moment the browser is up.
- `isolatedChildDeadlineMs(limits)` — the parent's deadline, **derived** as
  startup + document + a fixed `ISOLATION_ENVELOPE_ALLOWANCE_MS` (`5_000`,
  unchanged), replacing `totalWallClockMs + 5_000`. The old formula was already
  shorter than a healthy child's worst case; once startup became its own budget,
  ignoring it would have let the parent kill a blameless child.
- `chromiumLaunchOptions()` — launch options as inspectable data, so a test can
  assert the startup budget actually reaches the driver.

`renderDurationMs` still reports whole-render wall time including launch: it is a
measurement, not a budget.

### What did NOT change

`waitUntil: "networkidle"`, `navigationTimeoutMs`, retry count (still exactly one
navigation), allowed hosts, route containment, SSRF rules, proxy policy, HTTP
status handling, source authority, evidence semantics. Failure stages keep their
meanings: `NAVIGATION_TIMEOUT` still means `page.goto` hit its own typed timeout;
`TIMEOUT` now means the document phase overran, measured correctly.

### Known residuals, not hidden

- Child `TIMEOUT` and parent-supervisor `TIMEOUT` still collapse to one
  owner-visible reason. Left as-is deliberately: both mean "the child exceeded a
  wall clock", the operator's next action is the same, and a new closed
  diagnostic would be added on speculation rather than on a need that has arisen.
- The document budget is checked at a single point, after navigation. Extraction
  that follows is bounded only by the parent's deadline, so a child wedged in
  extraction is caught by the supervisor rather than by its own budget.

### About the Raydium TIMEOUT

**Not confirmed as the cause.** It is a plausible explanation and nothing more —
the page has not been re-inspected. The two readings from that window (the server
never answered, or `networkidle` never settled) both remain open, and this fix
does not decide between them.

### Next — the owner's choice

1. **A new live window on either Raydium url**, now that startup no longer spends
   the document budget. That, and only that, would confirm or refute the
   explanation.
2. **Stop.** Closing the case with the bridge named remains legitimate.

Each live option is a separate authorized window, one navigation, zero retry.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
