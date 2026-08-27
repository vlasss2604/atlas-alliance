# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The classified re-run returned **`NAVIGATION_FAILED:UNCLASSIFIED_NAVIGATION_ERROR`**
— branch C. Analysed offline; no retry, no network call, nothing persisted.

### What the classifier bought

Two hypotheses retired on its first outing, one of them mine:

- **Not `NAVIGATION_TIMEOUT`.** Playwright's typed `TimeoutError` did not fire,
  so the `networkidle`-mismatch reading proposed last round is **refuted for
  this observation**. It stays a plausible generic concern for polling pages;
  it is not what happened here, and it should not be "fixed" on the strength of
  a guess that has now been tested and failed.
- **Not `BLOCKED_BY_ROUTE_POLICY`.** Our own containment did not abort a
  main-frame navigation, so no cross-host redirect was refused by us. The proof
  channel was available — production runs real Playwright, which exposes
  `isNavigationRequest`, `frame` and `mainFrame` — so this is a finding, not a
  missing API. Residual: had Chromium classified the request as something other
  than a main-frame navigation, the abort would not have been recorded.

The navigation threw at transport level, and the closed signal says no more.
`net::ERR_*` codes live only in the exception message and are deliberately not
parsed.

### The branch is NOT exhausted — and this is the next task

`startEgressProxy` records **every decision it makes**, with a closed,
code-owned `EgressDenialReason`: `NOT_HTTPS`, `HOST_NOT_CONFIRMED`,
`BLOCKED_ADDRESS`, `DNS_FAILED`, `MALFORMED_TARGET`. The isolated fetcher opens
the proxy, holds the handle, and **drops the entire log in its `finally`** —
nothing in `src/` or `scripts/` reads `.decisions` at all.

Fourth instance of the same defect: information produced and discarded. It
discriminates exactly what is now unknown:

| proxy record | meaning |
|---|---|
| `DNS_FAILED` | resolution failed for the confirmed host |
| `BLOCKED_ADDRESS` | resolved into a reserved range — the SSRF guard fired |
| `HOST_NOT_CONFIRMED` | a CONNECT elsewhere, refused by the proxy |
| `NOT_HTTPS` / `MALFORMED_TARGET` | malformed or downgraded target |
| **no denial at all** | the proxy allowed it; the failure was downstream |

Even the empty case is informative — it separates *we refused it* from *the
network failed after we allowed it*.

**Safety constraint:** an allow-decision carries `host`, `port` and `address`,
and every decision carries a raw `target`. None of that may travel. Only the
closed denial reason and counts are safe. Fully offline-testable: the proxy has
an injectable `lookup`, so every branch is deterministic without a network.

**A concrete hypothesis it would settle immediately.** MantaRay's fake-IP DNS
returns `198.18.0.0/15`, which safe-http correctly refuses. A stale cached entry
surviving the tunnel going down would make the proxy deny with `BLOCKED_ADDRESS`
while the browser reported only a generic connection failure — precisely what was
observed. The procedure's `ipconfig /flushdns` step exists for this. Unverified.

### Another live window is not justified yet

Same reasoning that has now paid off three times: a window spent on a failure
that cannot explain itself buys one bit at full price. Surface the proxy log
first — it is offline, cheap, and would either name the cause outright or prove
the failure was genuinely downstream of everything we control.

If the owner would rather spend a window regardless, the honest cheapest version
is to run `ipconfig /flushdns` and confirm `fees.pump.fun` resolves to a public
address **before** invoking the inspection — which tests the stale-DNS
hypothesis without any new code.

### Unchanged

Actor → acquisition remains unresolved; the page is still unread, so the
address's absence from it is **not** established. `fees.pump.fun` stays
CONFIRMED and unclassified — classifying a page nobody has read is the inversion
inspection exists to prevent.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
