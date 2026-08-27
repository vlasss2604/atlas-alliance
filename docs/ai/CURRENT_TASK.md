# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The `fees.pump.fun` acquisition was prepared offline. **Decision: B — a
source-authority prerequisite is missing.** No live call was made, no route was
created, no code changed.

### Local state: `fees.pump.fun` is entirely unknown to ATLAS

Verified, not assumed:

- **0** `sources` rows for any `fees.` host; **0** Evidence rows mentioning it.
- **0** SOURCE_ROUTE rows naming it. All five pump_fun routes name `pump.fun`.
- The repository contains no code, fixture or constant referencing it — only
  this document set.
- `resolveSourceRoute("https://fees.pump.fun/…")` returns
  **`officiality=CLAIMED, routeClass=null, matchedPathPrefix=null`.**

**Routes are host-exact.** `source-authority.ts` compares
`routeDomain !== host` and skips, so a subdomain inherits nothing from
`pump.fun` — by design, and correctly: confirming a domain is not confirming
everything under it.

### What that blocks today

| gate | requires | fees.pump.fun |
|---|---|---|
| `alpha-acquire-url.ts` scope gate | CONFIRMED **and** routeClass ≠ null | refuses |
| render eligibility (both entry points) | CONFIRMED + OFFICIAL_DOCS + prefix | refuses |
| inspection eligibility | CONFIRMED + prefix + routeClass **=== null** | refuses (officiality is CLAIMED) |

Nothing can be fetched at all, so no command can be given yet. Decision A is
unavailable.

### The smallest prerequisite

**One ACTIVE SOURCE_ROUTE for `fees.pump.fun`, CONFIRMED and UNCLASSIFIED** — a
`pathPrefix`, and **no `routeClass`**.

CONFIRMED comes from an ACTIVE row naming the exact domain, independently of
`routeClass`, so an unclassified row is enough to open inspection while
asserting no documentation authority over a page nobody has read. That ordering
is the architecture's own: inspection exists only for the undecided case, and
`/pump-token` was promoted this way — inspected first, classified afterwards.

Deliberately **not** created in this task.

### Target: the page, not the API

The owner's first preference — an already-known authoritative endpoint — does
not actually apply. `fees.pump.fun/api/buybacks` is known only from a
third-party adapter; nothing first-party published that path to ATLAS, so it is
neither already-known-to-us nor authoritative. Preference 2 governs.

**Primary target: `https://fees.pump.fun/`.**

Role assignments live in human-readable labels, not in data payloads. The
question needs something of the form "these wallets execute buybacks", which is
prose. An endpoint returning records that merely contain the addresses is
locator co-occurrence — the error already rejected twice in this case, with a
fresher source. That is a judgement about where labels usually live, not a claim
about a payload nobody has seen.

**Fallback, a separate later window: `https://fees.pump.fun/api/buybacks`** with
prefix `/api`. `application/json` is an accepted content type, so it is
fetchable — but it is likely to fail the evidence standard even when it
succeeds technically.

### A prefix detail that will bite if missed

`pathWithinPrefix("/x", "/")` is **false**. A route with prefix `/` matches the
root path and nothing beneath it. So if `fees.pump.fun/` redirects or
client-side-routes to any sub-path, the render ends `FINAL_URL_OUTSIDE_ROUTE` —
exactly what `pump.fun/pump-token` did. This is consistent with the stated
design (a bare-domain confirmation must not authorize the whole site), so it is
reported as a fact to plan around, **not** as a defect.

If that happens, the honest next step is to confirm a route at the specific
sub-path, not to widen the prefix.

### The sequence, only step 2 being live

1. **Offline, owner:** create the ACTIVE unclassified SOURCE_ROUTE above.
2. **Live, one bounded render — the only network step:**

```
npx tsx scripts/inspect-official-page.ts https://fees.pump.fun/ pump_fun
```

3. **Offline:** read the output and decide whether it deserves OFFICIAL_DOCS.
4. **Live, later separate window:** evidentiary acquisition, only if step 3 says
   the page assigns the role.

**Footprint of step 2:** one isolated render, one navigation, zero retries.
No model call, no Evidence, no facts, no S5/S6/S7, no research budget, no
database write — the script imports none of those, and a test asserts it. The
renderer boundary is the usual one: scrubbed child, deny-by-default egress proxy
pinned to the confirmed host, cross-origin blocked, bounded time and size.

Run it with MantaRay off, capture the complete output the first time, then
MantaRay on and analyse offline.

### What counts as success

An explicit first-party semantic binding: text assigning the acquisition role to
the address — "wallet `99mRw3…` executes buybacks", "buyback wallets:
`99mRw3…`", or equivalent.

### What does not count

The address under generic data; the address in transaction rows; the path saying
`/buybacks`; purchase amounts with no actor role; DefiLlama's label; two-and-two
cardinality; chain behaviour resembling a buyback.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
