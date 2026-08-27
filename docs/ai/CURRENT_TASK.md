# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The egress proxy's decision log is now surfaced, counts only. Observability
only — no DNS, SSRF, CONNECT, routing or navigation behaviour changed.

### What changed

A failed render carries a **counts-only** summary of what the proxy decided,
beside the browser's own verdict. The two are independent witnesses and neither
replaces the other:

```
reason:           NAVIGATION_FAILED
diagnostic:       UNCLASSIFIED_NAVIGATION_ERROR
proxyDenials:     1 denied, 0 allowed
  NOT_HTTPS             0
  HOST_NOT_CONFIRMED    0
  BLOCKED_ADDRESS       1
  DNS_FAILED            0
  MALFORMED_TARGET      0
```

Every reason key is always present, so "no denial of this kind" and "no summary
at all" stay different observations. `allowedCount` separates a proxy that
permitted traffic — failure downstream — from one never consulted at all. And a
zero-denial line says so outright.

Both owner scripts print it: `inspect-official-page.ts` on failure, and
`renderer-selftest.ts` always.

### What still cannot be seen, by construction

A decision record holds a raw `host:port`, and an allow carries the resolved
address. **None of it travels.** The summary is built by counting, has no field
that could hold a string, and is **rebuilt key by key** from the closed list at
the error's edge — so an object arriving with a `target`, a hostname or an
address yields a summary that structurally cannot contain them. Unrecognised
reasons are counted as denials but never become keys, because a key taken from
data is a key that can carry data.

So a result licenses exactly this much: a count above zero says **we** refused at
least one request and names the class. All-zero says no containment refusal was
recorded. Never which host, never which address, and never a redirect
destination.

### No cause is claimed

The `fees.pump.fun` failure is **not** explained by this work. The capability to
read one now exists; the page has not been re-run and will not be without an
authorized window.

If it is re-run, the reading key is:

| observation | meaning |
|---|---|
| `BLOCKED_ADDRESS` ≥ 1 | our SSRF guard refused a resolved address — **the stale-DNS hypothesis becomes checkable, not proven** |
| `DNS_FAILED` ≥ 1 | resolution failed for the confirmed host |
| `HOST_NOT_CONFIRMED` ≥ 1 | a CONNECT elsewhere, refused by the proxy |
| all zero, `allowedCount` > 0 | the proxy permitted traffic; the failure was downstream of everything we control |
| all zero, `allowedCount` 0 | the proxy was never consulted — the browser failed before reaching it |

The cheapest version still needs no code and no new window logic: run
`ipconfig /flushdns` and confirm the host resolves publicly **before** invoking
the inspection.

### Unchanged

Actor → acquisition remains unresolved; the page is unread, so the address's
absence from it is **not** established. `fees.pump.fun` stays CONFIRMED and
unclassified.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
