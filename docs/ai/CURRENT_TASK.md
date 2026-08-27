# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Pre-response render failures are now classified. Written up in `ARCHITECTURE.md`,
"Rendering: two ways in, one set of gates". Observability only — no navigation
behaviour changed.

### What changed

A navigation that never completed is its own stage, **`NAVIGATION_FAILED`**,
carrying its own closed diagnostic:

| diagnostic | signal it rests on |
|---|---|
| `NAVIGATION_TIMEOUT` | Playwright's typed `TimeoutError`, matched on a name pinned as a constant |
| `BLOCKED_BY_ROUTE_POLICY` | **our own route handler** recorded aborting the main-frame navigation |
| `UNCLASSIFIED_NAVIGATION_ERROR` | everything else, honestly |

Previously all three fell into the generic `RENDER_FAILED`, beside failures
happening nowhere near the network — and the three call for opposite next
actions: wait longer, confirm a different host, or nothing at all.

`RENDER_FAILED` keeps its meaning and is now genuinely elsewhere: context
creation, text extraction, anything outside the navigation itself.

### What it deliberately does not do

**It never infers containment from a generic failure.** The abort is recorded at
the moment the route handler makes the decision, and only when the request was a
navigation belonging to the page's own main frame. A driver that cannot prove
that claims nothing — absence of proof is not proof, and a test pins it.

**It does not parse `net::ERR_*`.** Chromium's transport codes live only inside
the exception message, which is provider-influenced text. There is no typed path
to them, so that case stays unclassified — which still separates it from the
other two by elimination.

**A contract test pins the timeout name** against the installed Playwright, so a
future rename fails there rather than silently degrading every timeout to
unclassified during a live window.

### Also

The inspection script printed only the stage, which is how a window came back
saying `RENDER_FAILED` and nothing else. It now prints the sub-reason beside it —
closed-set values only, no message, url, host or stack.

### Reported separately, as instructed — not fixed

**`waitUntil: "networkidle"` is a poor fit for a live dashboard.** A page that
polls or streams may never reach two seconds of network silence, so the
navigation can time out while the document is perfectly readable. That is a
plausible reading of the `fees.pump.fun` failure, and the next window will now
say so outright if it is one.

Changing it is a navigation-behaviour decision — `domcontentloaded` or `load`
trades settled-DOM completeness for reachability — and it was explicitly out of
scope here. **Get one classified observation first**: if the diagnostic comes
back `NAVIGATION_TIMEOUT`, the case for changing it is evidence rather than a
guess.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
