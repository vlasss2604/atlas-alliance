# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Raydium prepared as the next case. **Decision: B — ARCHITECTURE BLOCKER**, and
the blockers are small, known, and mine. The case itself is good; two owner
capabilities are missing before it can start. No research, no code, no network.

**Everything the owner supplied is a LEAD, not Evidence.** Nothing about
Raydium's fee split, its published addresses or its flow is recorded as a
finding, and none of it becomes a fact until ATLAS acquires and classifies it
through the normal pipeline.

### Local state: a genuinely clean slate

Verified across all 115 text-bearing columns. **No `raydium` project, no
identity, no route, no source, no job, no artifact.** The only mentions anywhere
are 11 Evidence rows belonging to **`pump_fun`** — SOCIAL/CLAIMED, `entity_binding`
null — that name Raydium as the venue graduated tokens move to. They say nothing
about Raydium's own mechanism and are bound to a different project.

Repository fixtures mention a Raydium program id only as generic decoding test
data. Nothing to reuse, nothing to unlearn.

### The two blockers

**1. `PROJECT_IDENTITY` has no supported creation path.** Nothing in `src/` or
`scripts/` inserts one. Several owner scripts *read* it and refuse without it
(`onchain-account-check.ts`, `onchain-derive-token-accounts.ts`), and S4 skips
structured on-chain acquisition entirely unless the project has a confirmed
identity. **Without it the on-chain half — the entire reason this case was
chosen — cannot be invoked at all.**

**2. Route classification has no supported path either.** `confirm-source-route.ts`
exists and works, but deliberately assigns no `routeClass`, and I never built the
tool for the "separate later owner act" that assigns one. Without
`routeClass = OFFICIAL_DOCS` the acquisition scope gate refuses and no
documentary Evidence can be admitted.

Both are the same shape as the gap closed two rounds ago: an owner decision with
no controlled, auditable tool. The smallest fix is one script per act, mirroring
`confirm-source-route.ts` — insert as OBSERVED, reuse `promoteProjectMemoryItem`,
validate at the edge, refuse duplicates and conflicts, print the resolved result.
**Not implemented here.**

A third prerequisite is not a blocker: adding a `raydium` row means one line in
`src/server/db/seed.ts`'s catalog and `npx tsx scripts/seed.ts`, which is
idempotent (`onConflictDoNothing`). It is a code change, so it did not happen in
a preparation task.

### Why this case is worth the tooling

**It is on Solana**, so the transport wall that blocked Uniswap and Hyperliquid
does not apply. And the mechanism shape is materially different from PUMP:

```
trading fee → protocol fee collection → conversion → RAY accumulation at a
protocol-controlled destination
```

**No burn is assumed, and that is the point.** The invariant to test is
**BUYBACK ≠ SUPPLY REDUCTION**: an asset retained at a protocol-controlled
destination is economically and mechanically different from one destroyed.
CORE_RULES already says *buyback ≠ burn*; nothing has ever exercised it against
a project that only buys and holds.

### Proof plan — the question, not the claim

The target is **not** "Raydium says it does buybacks". It is: *do trading fees
actually fund RAY purchases, and what happens to the RAY afterwards?*

| component | documentary evidence needed | deterministic evidence needed | ceiling |
|---|---|---|---|
| `SOURCE_OF_VALUE` | fees named as the source | — | CONFIRMED docs can exceed CLAIMED |
| `MECHANISM_SPEC` | the routing rule and its share | — | as above |
| `FLOW_PATH` | **addresses assigned to the flow, by role** | movement into a collection address | mixed |
| `DESTINATION` | where bought RAY is meant to end up | RAY present at that address, confirmed mint | `PARTIALLY_SUPPORTED` |
| `EXECUTION_EVIDENCE` | — | a decoded exchange producing RAY | `PARTIALLY_SUPPORTED` |
| `NET_EFFECT` | whether supply is reduced | **held ≠ burned** | see below |

**D-074 is untouched and caps every on-chain component at
`PARTIALLY_SUPPORTED / INSUFFICIENT_AUTHORITY`**, because a canonical chain read
is written `officiality: CLAIMED` by design. Only human-confirmed documentary
routes carry `CONFIRMED`.

### First deterministic chain test — one bounded target

**The published RAY-holding address → `ACCOUNT_INFO` → promotion to
`TOKEN_ACCOUNTS_BY_OWNER`, filtered to the confirmed RAY mint.**

Why this one first: it is a single bounded read chain, needs no signature paging,
needs no counterparty, and produces exactly what has never existed —
Evidence with `onchainArtifactId` set, `sourceClass ONCHAIN_VERIFIABLE`,
`entityBinding CONFIRMED` (the mint matches the project identity). **That is the
artifact → Evidence → component pipeline, tested end to end, with one read.**

It also tests the invariant directly: a *held balance* is the correct outcome for
a buy-and-hold mechanism, and it must reconcile as accumulation at a destination
— **never** as supply reduction.

Signature/transaction work (`SIGNATURES_FOR_ADDRESS` → `TRANSACTION_DETAIL`) is
Phase 2 at the earliest, and only for `EXECUTION_EVIDENCE`, which is the one
component permitted to walk a signature into a transaction.

### PUMP failure modes — pre-registered, so we cannot rationalise later

The owner's lead claims the docs publish addresses *with roles*. **If true**, the
actor → acquisition bridge becomes testable rather than structurally missing —
the single thing PUMP never had. **If false**, we are in PUMP's position again
and should say so immediately rather than re-deriving it over four windows.

**What will count** (decide now, not after reading):

- an address published **with a role verb** — "fees are collected at X",
  "buybacks are held at Y" — not merely listed under a heading;
- the address appearing **literally and completely** in the document text or an
  exact `href`, so a documentary locator can be admitted at all.

**What will not count**, unchanged: address occurrence alone; a heading label;
cardinality matching; chain behaviour resembling a role; a third party's
terminology; an endpoint name.

Avoided by construction if the leads hold: **no counterparty chasing, no dense
history paging, no burn-address inference** — there is no burn to infer, which is
itself why this case is a better test.

### Bounded Phase 1, after the blockers are cleared

At most **3 owner-supplied documentation URLs**, no web search, no social
sources, no history paging, and **one** deterministic chain target only after a
documentary locator has been admitted. Zero retries without separate
authorization. No live command is proposed yet.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Nothing owner-supplied is Evidence until acquired through the pipeline.
