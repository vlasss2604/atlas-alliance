# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Raydium has a catalog row, a confirmed identity and **two unclassified routes**.
One inspection window was spent on the first and **the page was never read**. The
second has not been inspected at all. No source, no Evidence, no job, no artifact.

### The second route, confirmed 2026-08-28

```
MSYS_NO_PATHCONV=1 npx tsx scripts/confirm-source-route.ts --project=raydium   --domain=docs.raydium.io --prefix=/raydium/protocol/protocol-fees --actor=owner
```

Row `d09657e6-96b6-423e-9973-a2578cb71069`, ACTIVE via `OBSERVED -> CANDIDATE ->
ACTIVE`, content exactly `{ domain, pathPrefix }`, `routeClass` absent. No SQL,
no classification.

`https://docs.raydium.io/raydium/protocol/protocol-fees` → `CONFIRMED` /
`routeClass null` / `matchedPathPrefix "/raydium/protocol/protocol-fees"`.
Inspection **allowed**; docs-inspection, render-as-Evidence and payload recovery
all refuse `NOT_OFFICIAL_DOCS`; `resolveSourceClass` still `SOCIAL`.

**The buyback route is byte-identical before and after** — snapshotted through the
resolver before the write and re-compared after. Across nine urls, exactly two
changed: the new prefix and `/raydium/protocol/protocol-fees/detail` under it.
The two prefixes are disjoint, which is the only reason the second was accepted:
`/raydium/…` is a string-prefix neighbour of `/ray/…` but not a segment prefix,
and matching is segment-bounded. `-extra` variants of both stay outside, and a
parent path is not covered by its child's prefix.

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

1. **Inspect `/raydium/protocol/protocol-fees`.** Now eligible, never attempted.
   A different url on the same host, so it also tests whether the buyback
   timeout was about that page or about the host.
2. **Retry `/ray/ray-buybacks`.** Would settle whether its timeout is
   reproducible; nothing else would.
3. **Neither.** Stopping with the bridge named is a legitimate outcome.

Each is a separate authorized live window, one navigation, zero retry. Nothing
here should be run without one.

**When a page is finally read, the standard has not moved:** classification
requires the page to be first-party documentation of the mechanism, and a usable
documentary locator requires an explicit **role assignment** to an address —
"fees collected at X", "executed by X", "accumulated at X". An address
occurrence, a heading, a bare table row, or matching cardinality do not count.
That was pre-registered before anything was read, and PUMP closed on exactly it.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
