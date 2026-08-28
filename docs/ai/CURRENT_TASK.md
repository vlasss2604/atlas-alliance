# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Raydium has a catalog row, a confirmed identity and one **unclassified** route.
One inspection window was spent and **the page was never read**. No source, no
Evidence, no job, no artifact.

### The window

Owner-executed once, 2026-08-28, MantaRay off, zero retry:

```
npx tsx scripts/inspect-official-page.ts https://docs.raydium.io/ray/ray-buybacks raydium
```

Gate passed (`CONFIRMED` / `null` / `/ray/ray-buybacks`), then:

```
INSPECTION FAILED: NAVIGATION_FAILED:NAVIGATION_TIMEOUT
proxyDenials:     0 denied, 1 allowed   (every denial class 0)
```

No `finalUrl`, no status, no bytes, no term scan, no links, no rendered text.

### What is and is not established

**Established.** Not `BLOCKED_BY_ROUTE_POLICY` — our containment did not abort
the main-frame navigation. Not `UNCLASSIFIED_NAVIGATION_ERROR` — Playwright's
typed `TimeoutError` fired, the **first time that diagnostic has appeared in this
repository**; all four `fees.pump.fun` windows returned the unclassified value.
`DNS_FAILED` and `BLOCKED_ADDRESS` both zero, so the stale-fake-IP hypothesis is
refuted here as it was there.

**Not established.** `1 allowed` is recorded at policy-decision time, **before
`netConnect`**; the failure path destroys both sockets silently. It proves DNS
resolved and the address was public — nothing about the connection succeeding.
Two readings survive, unseparated by any local signal:

1. the server never answered through the tunnel;
2. the page answered but `waitUntil: "networkidle"` never settled within the 15s
   budget — ordinary for a documentation SPA.

Reading 2 was **refuted for `pump.fun`** (the timeout never fired there); here the
timeout is precisely what fired, so it is live again for this host. Separating
them needs the tunnel-outcome diagnostic already named in `BACKLOG.md`. Do not
spend research on it: CORE_RULES' brake applies, and four PUMP windows already
went into transport plumbing and produced no evidence.

**Absence is not established.** Whether the page states a fee share, an executing
address, a destination or a burn is **unknown**. Failure to read a source is not
evidence that anything is missing from it.

### Consequences

- The route stays ACTIVE and **unclassified**. Classification follows reading,
  and no reading occurred. `classify-source-route.ts` must not be run on
  `84774bb9-b10a-4519-8a69-7f1c3a6c0b93` on this evidence.
- **No documentary locator exists**, so no on-chain subject can be named. Verified
  again: `resolveOnchainSubject` on the confirmed RAY mint returns `NOT_FOUND`.
  The mint is an identity, not a locator — it does not admit itself.
- Nothing persisted. Verified by timestamp, not only by count: newest `sources`
  row 2026-08-24, newest Evidence 2026-08-24, newest job 2026-08-27, newest
  on-chain artifact 2026-08-27 — all older than the route confirmation.

### Next — the owner's choice, not a queue

1. **Another inspection window on the same url.** Cheapest, and the one thing
   that would settle whether the timeout is reproducible.
2. **A different first-party url** inside a newly confirmed prefix. Note the
   host is already CONFIRMED domain-wide, so this needs only a route act — and
   an overlapping prefix would be refused.
3. **Neither.** A page that cannot be read after two windows is a legitimate
   stopping point, and the case can be closed with the bridge named.

No live call without a separate authorized window.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
