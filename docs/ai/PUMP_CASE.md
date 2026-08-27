# PUMP case — durable research state

Read only for a PUMP task. **Nothing here may drive generic code.** These are
observations about one project; the rules they taught are in `CORE_RULES.md`.

## Identity

| | |
|---|---|
| Project | `pump_fun` |
| Chain | Solana |
| Ticker | PUMP |
| Confirmed mint | `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` |
| Official docs routes used | `pump.fun/docs`, `pump.fun/pump-token` |

The official claim, approximately: half of every dollar Pump.fun earns buys $PUMP
on the open market, then burns it forever. The page publishes buyback/burn
figures, supply offset, revenue allocation, daily records and burn addresses.

**Official docs prove what Pump.fun claims. They do not independently prove
execution.**

## Documentary locators

- Confirmed full locator, labelled "Burn address" by the docs:
  `99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c`
- Second burn address published on the same page:
  `9jHrTCwpDANHLNQz5cem6XLUBM8KiTWKe766Br6KVCXM`

Both arrived through normal documentary provenance and are recorded in
`evidence_documentary_locators` with `literally_present = true` and
`validation_result = CONFIRMED` — `99mRw3…` at ordinal 0 and `9jHrTCwp…` at
ordinal 1 of the same evidence rows. Neither was ever hardcoded, and neither may
be. The second address has additionally been followed one hop (see the inventory
below); the old note that it "still needs to enter through provenance" is
resolved.

A documentary "burn address" label proves none of: that a burn occurred, that
PUMP reached the account, that `Burn`/`BurnChecked` executed, that supply
decreased, or that the economic role is what the label says.

## Persisted on-chain inventory (verified from the local database)

Everything below was read from `onchain_artifacts`, `onchain_observed_signatures`
and `onchain_derived_subjects`. Ten artifacts exist in total; all are
`STANDALONE_STRUCTURED_OBSERVATION` (no research job attached), so these are
established chain FACTS in the artifact store, **not yet Evidence in a Proof**.

### Balance observations

| slot | artifact | subject | result |
|---|---|---|---|
| `441498936` | `6161bae4-…` | owner `99mRw3…` | one PUMP token account `9Wtcf…`, balance **0** |
| `441835488` | `0bfa3d2d-…` | owner `9jHrTCwp…` | one PUMP token account `HxT8kiUKxJ7jdvWfDeRZQzQia4wyRCNN2iRBjMUzcimN`, balance **0** |

Both derived accounts are recorded in `onchain_derived_subjects` with
`derivation_method = TOKEN_ACCOUNTS_BY_OWNER`, `binding_status = CONFIRMED`.

### Signature windows — three, all on `9Wtcf…`

| artifact | n | slots | block times | span |
|---|---|---|---|---|
| `d0b844a0-…` | 10 | `441595243`–`441595300` | 2026-08-25 08:54:21–08:54:42 | 21 s |
| `cdddfcc1-…` | 10 | `441840911`–`441840980` | 2026-08-26 09:50:00–09:50:26 | 26 s |
| `2e332079-…` | 25 | `441976802`–`441977087` | 2026-08-26 23:39:19–23:41:02 | 103 s |

Every window returned exactly its limit, so each is saturated and the density is
a lower bound: roughly 0.24–0.48 signatures per second. No row anywhere has
`err = true`.

### Transactions read in full — five artifacts, four distinct signatures

| slot | signature | burns |
|---|---|---|
| `441977087` | `zdjrE4w…` | 0 — the reciprocal acquisition |
| `441840980` | `5R5LhLd…` | **1 — BurnChecked** |
| `441840975` | `4eMRNdm…` | 0 (read twice; two artifacts, same signature) |
| `441595300` | `44235e2…` | 0 |

## The established burn

Artifact `8ccbbac0-96d7-4dbf-91c9-ece29d62ec0e`, signature
`5R5LhLdHyzDJtFgHFG4UdkwNh66iGhf7Y2XVaagMi5XadQB1cbRJP66EqkKyao9FBmYPVB3gyCinb6vy3RwdUPSF`,
slot `441840980`, block time 2026-08-26T09:50:26Z, succeeded.

- `artifact_hash` `sha256:4a9d2394874829b4a2d9e0aec035832d010fc5d4577cc4fbb2ab99b52c1ff712`
- `raw_response_hash` `sha256:a3e22c49f42d9af4c1209a01beceee4a481dd9a182bc646566479d7edbff014d`
- Programs invoked: **Token-2022 only** (`TokenzQdB…`). A single-instruction
  transaction.
- Decoded `BurnChecked`, outer instruction: mint = the confirmed PUMP mint,
  `amountRaw` `7723746661` at 6 decimals = **7723.746661 PUMP**,
  `sourceAccount` = `9Wtcf…`, `authority` = `99mRw3…` — the documented burn
  address acting as authority over its own token account.
- Balances: pre `7723746661` → post `0`. The account's entire balance, destroyed.
- Provenance: the signature was listed in window `cdddfcc1-…` on parent subject
  `9Wtcf…`, `binding_status = CONFIRMED`.

**This is a genuine on-chain destruction of the project's confirmed mint.** It is
the strongest single fact in the case, and it corrects the earlier record, which
said no PUMP `Burn`/`BurnChecked` had been established.

What it still does not establish: that the burned tokens came from a buyback,
that the SOL that bought them was protocol revenue, that the published mechanism
is what ran, the cumulative burn totals, the Aug 23 attribution, or
circulating-supply semantics. It is also not yet Evidence — no research job owns
it. What it WOULD reach, and why it cannot get there offline, is below.

## The burn's own interval, closed under the observed index

Verified offline from persisted rows only. No RPC call was made and none is
needed for what follows.

### The window around the burn

Artifact `cdddfcc1-c5d0-466a-8f7f-2df0757680e5` — `SIGNATURES_FOR_ADDRESS` on
`9Wtcf…`, `limit 10`, returned 10, slots `441840911`–`441840980`, 26 seconds,
every row `err = false` and `binding_status = CONFIRMED`. The burn at
`441840980` is the **newest** signature in it; nothing in the window is later.

Two of the ten signatures already have `TRANSACTION_DETAIL` artifacts. They are
the two newest, and they are adjacent:

| slot | what the persisted detail shows for `9Wtcf…` |
|---|---|
| `441840975` | pre **0** → post **7723746661**, via one inner `transferChecked` of the confirmed mint, `amountRaw 7723746661`, into `9Wtcf…`. Zero burns. |
| `441840980` | pre **7723746661** → post **0**, via `BurnChecked`, `amountRaw 7723746661`, authority `99mRw3…`. |

The window lists **no signature between those two slots**. The quantities
reconcile exactly: `+7723746661` in, `−7723746661` destroyed, and both outer
balances are zero.

That transaction was read twice (artifacts `bfb959f1-…` and `1c9f3afd-…`, the
second carrying `lifecycleInstructions`). Both agree on the balances and the
transfer — an unplanned but welcome consistency check.

### The continuity statement this supports

Say exactly this, and not more:

> Across the interval bounded by the transaction at slot `441840975` and the
> transaction at slot `441840980`, token account `9Wtcf…` is observed holding
> zero units of the confirmed mint at both ends; `7723746661` raw units entered
> it and `7723746661` raw units were destroyed from it by a decoded
> `BurnChecked`. **No further transaction involving the account was listed for
> that slot range by the observed signature window.**

It never says "the same tokens" — fungible units have no individual identity and
none is claimed. It is account-level quantity continuity, and the quantities
reconcile exactly.

**What it is NOT allowed to say is "no other transaction touched the account".**
That is a census claim, and this is an index reading. The two differ by a premise
ATLAS does not hold — see below.

### Why "complete" is the wrong word here

The continuity claim would be complete only if the RPC address-signature index
returns every transaction capable of mutating the account. Checked against the
code, that premise is **unverified**, and this is not a subtlety an offline
inventory merely "could not check" — it is absent from the system:

- There is **no Solana SDK dependency** in the repository. The adapter speaks raw
  JSON-RPC against its own Zod schemas, so no vendored contract states what the
  index covers.
- **Address lookup tables are not modelled anywhere.** `meta.loadedAddresses` and
  `message.addressTableLookups` are not read; the sole mention of versioned
  transactions in the whole tree is one comment about
  `maxSupportedTransactionVersion`.
- The account-key schema parses the `jsonParsed` key object and keeps **only**
  `pubkey`, discarding `source` — so even where the node says an address arrived
  via a lookup table, ATLAS drops it. A stored artifact cannot be asked which of
  its keys were static.
- Nothing in the codebase claims within-window completeness. The nearest wording
  is the signature fact's own limit — the list is not "complete beyond the queried
  window" — which implies within-window completeness by contrast without ever
  asserting it. No production path relies on it; the promotion module treats a
  window as deterministic sampling, not a census.

What *is* settled, from the execution model rather than from anything in this
repository: a transaction cannot read or write an account it does not declare, so
a mutation implies membership in the transaction's effective account set (static
keys plus lookup-loaded addresses). The open question is not whether the account
is in that set — it is whether the **index** covers every way it can get there.

Local evidence bears on a neighbouring question only. Persisted transactions with
54 and 25 account keys resolve every token-balance index without a single
unresolved account, which indicates `getTransaction` under `jsonParsed` does
merge loaded addresses into `accountKeys`. That is a different subsystem from the
address-signature index and settles nothing about it.

**Safe vocabulary, to be used from here on:** an interval is *closed under the
observed index* when the window lists nothing further in its range. Call it
*complete* only once the index guarantee is actually held.

### What it is not

Not a buyback, purchase, swap, market buy or revenue-funded acquisition. The
inflow is a decoded transfer and nothing more; who `48xDcrnn…` and `45ssPkUQ…`
are, and what funded them, is unestablished and out of scope. Economic
interpretation is a separate question with separate evidence.

Not a pattern, a rate or a policy — one cycle observed in a 26-second window
supports no claim about how often this happens.

Not connected to the later acquisition at slot `441977087`. That is a different
cycle, and this interval says nothing about it.

Not yet Evidence: both artifacts are standalone, so nothing has been reconciled.

### What remains unknown before the window

Everything before slot `441840911`: how the account came to be in whatever state
it was in, whether earlier inflow-and-burn cycles occurred, and when the account
was created. There is also a boundary ambiguity at `441840911` itself — the
window was saturated at its limit of 10, so a further transaction at that same
slot could have been cut off. The guaranteed-complete region is therefore
everything strictly after the oldest returned signature.

### Cost of characterizing the rest of the window

Eight signatures have no `TRANSACTION_DETAIL` artifact, none of them failed, so
**eight** bounded RPC reads would characterize the whole window.

They are not needed for the statement above. The pre-balance at `441840975` is
zero, so whatever those eight transactions did, they left the account empty and
cannot bear on this burn's accounting. Spending them would answer a different
question — whether the cycle recurs — which ten signatures cannot answer anyway.

## The inflow transaction, and the fact it does not produce

Artifact `1c9f3afd-f02f-4c04-a394-2aa78d0537c3` (and its earlier twin
`bfb959f1-…`, same raw response, taken before `lifecycleInstructions` existed —
use the former), signature `4eMRNdm…`, slot `441840975`, block time
2026-08-26T09:50:24Z, succeeded, **zero burns**. Both are standalone artifacts.

### The legs, all of them

| leg | asset | amount (raw) | from | to |
|---|---|---|---|---|
| System `transfer` | native SOL | `382585174` | `99mRw3…` | `Dnpwdpj…` |
| `transferChecked` | wSOL | `382202589` | `Dnpwdpj…` (authority `99mRw3…`) | `A5VBGEV5…` |
| `transfer` | wSOL | `382585` | `Dnpwdpj…` (authority `99mRw3…`) | `2oL6my4Q…` |
| `transferChecked` | **confirmed mint** | `7723746661` | `48xDcrnn…` (authority `45ssPkUQ…`) | `9Wtcf…` |

`Dnpwdpj…` is created (`createIdempotent`, `createAccount`,
`initializeAccount3` naming owner `99mRw3…`), funded, `syncNative`d, spent and
`closeAccount`d — all inside this one transaction.

Two exact reconciliations, computed rather than eyeballed:

- `382202589 + 382585 = 382585174` — every lamport delivered to the wrapper
  leaves it again in the same transaction.
- `+7723746661` into `9Wtcf…` and `−7723746661` out of `48xDcrnn…`.

### Ownership, from balance metadata

`9Wtcf…` → `99mRw3…` · `48xDcrnn…` → `45ssPkUQ…` · `A5VBGEV5…` → `45ssPkUQ…` ·
`2oL6my4Q…` → `7iWnBRRh…`.

So the counterparty that sends the project's token, `45ssPkUQ…`, is the same
party that receives the larger wSOL amount. The smaller wSOL amount goes to a
third owner; what that is for is not established and is not guessed at here.

`Dnpwdpj…` appears in **no** balance metadata — it did not exist before the
transaction and did not survive it. Its owner is known only from the lifecycle
instruction that initialized it.

### The reciprocal shape, and how ATLAS came to see it

The documented address pays out native SOL and a counterparty's account pays in
the project's token, in one successful transaction, with the same counterparty
on both sides — routed through a wrapper the payer creates and closes.

This produced **nothing** until the transient-wrapper capability landed. The
derivation looked for a native transfer whose destination is a token account
owned by the **counterparty**; here it is a wrapper owned by the **payer**, and
the counterparty is one hop further on. The wrapper appears in no balance
metadata — it did not exist before the transaction and did not survive it — so
its owner was unresolvable and the leg was dropped before any pairing. No burn
plus no flow meant no fact for any component.

It resolves now from the same-transaction instructions that name the owner by
protocol definition. Both `createIdempotent` and `initializeAccount3` do here,
and both are reported: agreement is a stronger basis than one attestation, and
naming only the first would understate it. Balance metadata still comes first,
and disagreement between the two sources resolves the account to nothing.

The derived flow keeps the routing visible rather than flattening it. The native
leg records the lamports going into the wrapper; the onward hop to the
counterparty is stated separately with its own amount and mint. **No amount is
carried across the hop** — what arrived and what went on are different numbers,
and the remainder went somewhere this says nothing about.

Legs and pairing stay DIRECT + CONTEXT. Seeing the shape did not make it mean
anything: nothing here can establish a component on its own.

### Connection to the burn — quantity and account only

`7723746661` raw units entered `9Wtcf…` at slot `441840975` from a balance of
zero; `7723746661` raw units were destroyed from `9Wtcf…` at slot `441840980`,
returning it to zero; the observed window lists nothing further involving the
account between those slots.

Never "the same tokens". The claim is account-level quantity continuity, and it
carries the coverage ceiling recorded above: *nothing further was listed* is not
*nothing else happened*.

### Why it cannot be called a swap, from what is stored

The transaction invokes seven programs. Five are chain infrastructure ATLAS
decodes: Compute Budget, the Associated Token program, the System program, SPL
Token and Token-2022. Two are not:
`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` and
`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`.

**Both are UNKNOWN, and that is a finding rather than a gap in effort.** Neither
id appears anywhere in this repository outside the test that records them as
opaque, there is no Solana, Jupiter, Raydium or Anchor dependency among the 347
installed packages, and no IDL, registry or program list exists locally. Nothing
here can say what either program does, and nothing may pretend to.

**They also contributed zero decoded instructions.** Every decoded instruction in
the payload belongs to the System program, an SPL Token program or the ATA
program. What the two unknown programs actually did is not represented at all.

Three things would be needed to decode them, and none survives:

- **Instruction payloads.** `parsedInstructionSchema` keeps only `programId` and
  `parsed.{type,info}`. An unknown program's instruction arrives with `data` and
  `accounts` instead, and both are dropped — for every transaction, not just this
  one.
- **The raw response.** Only its hash is stored. The bytes are gone.
- **Parent linkage.** `innerInstructions` groups are flattened with `flatMap`,
  discarding the group index, so no decoded instruction names the outer
  instruction it was a CPI of.

That last one matters on its own. Without it ATLAS cannot even establish the
weaker structural claim that both legs happened inside ONE invocation of the same
program — only that they happened in the same transaction between the same two
owners. Retaining the group index would be a small, program-agnostic addition and
would still not establish a swap; it is not implemented.

So the ladder stops early. Same transaction: yes. Same counterparty ownership:
yes. Same program invocation: **not establishable**. Decoded swap instruction:
**no**. Deterministic economic exchange: **no**.

Decoding would require re-retrieving the transaction and a human-authored program
registry — a label whose own provenance would then need answering. And even a
fully decoded swap would establish ACQUISITION, never buyback: nothing would bind
it to protocol revenue or to a published policy.

### What it still cannot prove

Not a buyback. Not revenue funding — what funded `99mRw3…`'s lamports is outside
this transaction, and no inbound native leg to that address appears anywhere in
it. Not a market purchase. Not causality: the two directions are recorded as
co-occurring in one transaction and nothing establishes that either caused the
other, nor that they were exchanged for one another.

The programs invoked — including `JUP6LkbZ…` and `CAMMCzo5…` — are recorded as
opaque ids on purpose. Decoding what a program does is a separate, separately
authorized step, and it is precisely the step that would license the words
"swap" or "market purchase". One transaction is also not a policy.

## What the burn would establish if it reached Evidence

Verified offline through the real synthesizer and the real reconciler against the
exact persisted payload — `tests/onchain-persisted-burn-evidence.test.ts` pins all
of it. Nothing was inserted into the database and no chain read was made.

The synthesizer produces **one** fact from this artifact (there is no native leg,
so the reciprocal-flow derivation contributes nothing): `SUPPORTS`, `DIRECT`,
`mechanismState = LIVE`, `publishedAt = null`, with a statement naming the
signature, slot, `BurnChecked`, 7723.746661 PUMP formatted without rounding, the
mint and the token account — and the hand-authored burn limits attached.

Written as production writes on-chain evidence — class `ONCHAIN_VERIFIABLE`,
officiality **`CLAIMED`**, `entityBinding CONFIRMED`, `fetchedAt` = the artifact's
own `retrievedAt` — the reconciler returns:

**`PARTIALLY_SUPPORTED`, reason `INSUFFICIENT_AUTHORITY`, with the burn row as the
establishing element.**

The component IS established: the row survives every gate, is returned as
supporting, and `currentState` comes back `LIVE`. What caps it is D-074 (LOCKED) —
officiality `CLAIMED` limits any component to `PARTIALLY_SUPPORTED`, and every
on-chain fact is written `CLAIMED` on purpose. **`SUPPORTED` is unreachable for
on-chain evidence**, and no configuration lifts it: `CONFIRMED` comes only from a
human-approved `SOURCE_ROUTE` matched by hostname, and `atlas-onchain://` URIs
have none.

Two further checks: the same row with `entityBinding UNVERIFIED` establishes
nothing (`ENTITY_NOT_CONFIRMED`), and no freshness window applies here, so a
days-old retrieval is not stale — the temporal basis is the artifact's real
`retrievedAt`, which means reuse can never make evidence look fresher than it is.

The burn establishes step 4 and step 4 alone. Offered for any other component it
is excluded — a fact does not drift to whichever component would find it
convenient.

## Why it is not Evidence today

The artifact is `STANDALONE_STRUCTURED_OBSERVATION`: no research job, no source
row. That is deliberate and regression-tested — *a standalone artifact gains
nothing by existing: not Evidence, not a source class, not Proof eligibility.*

It is unrepresentable rather than merely disallowed. `evidence.source_id` is NOT
NULL, a standalone artifact has `source_id IS NULL` by CHECK constraint, and the
only writer of on-chain Evidence requires a job and creates a fresh
`RESEARCH_JOB`-mode artifact of its own. The conflict lookup is deliberately
scoped by mode so a job insert can never resolve to a standalone row with
identical content.

**So the supported route to Evidence goes through a live retrieval inside a
research job.** There is no offline adoption path, by design.

One practical obstacle sits on top of that design question: the stored
`normalized_result` is unversioned, and this artifact predates the
`lifecycleInstructions` field. Replaying it through today's synthesizer throws.
See `BACKLOG.md`.

## The temporal picture, and the hole in it

Ordered by slot, this is everything observed about `9Wtcf…`:

```
441498936  balance 0                                    (TOKEN_ACCOUNTS_BY_OWNER)
   ... 342,044 slots unobserved ...
441840980  balance 7723746661 -> 0   BURN 7723.746661   (BurnChecked)
   ... 136,107 slots unobserved (~13.8 h) ...
441977087  balance 0 -> 17509274333  ACQUISITION        (reciprocal flow, 0 burns)
   ... nothing observed after this slot, anywhere ...
```

Two things follow, and neither is comfortable.

**The burn precedes the acquisition.** It destroyed a balance that arrived during
an unobserved interval — not the 17,509.274333 PUMP received later. These are two
different cycles, and pairing them would be inventing a link.

**Nothing at all is observed after slot `441977087`.** Not one persisted signature
anywhere has a higher slot. So what became of the 17,509.274333 PUMP is entirely
unrecorded here.

One interval is closed under the observed index: slots `441840975`–`441840980`,
where the inflow and the burn sit adjacent with nothing further listed between
them (see above — "closed under the observed index" is deliberately weaker than
"complete", and the difference is a premise ATLAS does not hold). The others —
342,044 slots before the burn, 136,107 after it, and everything past
`441977087` — are not covered at all. Those endpoints are suggestive, and
suggestive is not established.

## Established on-chain observations

**The locator itself** — `ACCOUNT_INFO`: exists; owner program
`11111111111111111111111111111111` (System Program); relation
`NOT_TOKEN_PROGRAM_OWNED`; no parsed token account; binding `CONFIRMED`. So the
documented locator is a System-Program-owned account, not an SPL token account.

**Its PUMP token account** — `TOKEN_ACCOUNTS_BY_OWNER` filtered by the confirmed
mint returned exactly one account:
`9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX`, owner `99mRw3…`, balance 0 PUMP
**at slot `441498936`** — roughly 478,000 slots BEFORE the acquisition
transaction, not after it. **Zero balance proves neither burn nor absence of
historical tokens**, and this one proves nothing about the acquisition at all: it
was observed first.

**History is dense.** A bounded `SIGNATURES_FOR_ADDRESS` (limit 25) on that token
account returned 25/25, one observed window covering roughly 1–2 minutes. Bounded
head windows are for deterministic sampling, not for reaching a date several days
back. Do not add paging to get to a date.

## The acquisition transaction, in detail

One of five persisted transaction artifacts (see the inventory above). Selected
from a persisted 25-signature window by the deterministic rule
`ORDER BY slot DESC, signature ASC` — no content-based cherry-picking.

| | |
|---|---|
| Signature artifact | `2e332079-27e8-4806-b45a-36d8271ea93d` |
| Transaction artifact | `df2ed321-abe1-4d92-99f9-997127e9af1a` |
| Signature | `zdjrE4w9ur4rsedH5o4nwfvzZJdDPhjN8TE24ssJiZMpJ1mN5waWvYQJYViEU8FjQFeMQ2VLGDKvXW16QYNzGvB` |
| Slot | `441977087` |
| Artifact hash | `sha256:01e73440e7d9c706d5a11cc652554c86300db9fe53aee6d74fa2c5360e31a3c1` |
| Raw hash | `sha256:50d374d65f14a342c60307990e6d4117cb70b2a740814b6669231f31149b495d` |
| Result | succeeded |

**The slot is `441977087`.** A previous narrative report wrote `442006244`; that
number was fabricated in prose and appears in no row, probe output or fixture.
Never repeat it. The code provenance was correct throughout — this is the reason
for the reporting-discipline rule in `CLAUDE.md`.

The transaction invokes Compute Budget, the Associated Token Account program, the
System Program, SPL Token, Token-2022, and an external program
`61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH` which is **not** to be semantically
decoded without explicit authorization.

### What it deterministically contains

- Native transfer: `850140914` lamports from `99mRw3…` to `5yiGAF4C…`, plus a
  `syncNative` on that account. Balance metadata reports `5yiGAF4C…` as owned by
  `FkaLnX17cXZGyeu3kZGdHCNdFMJJzBrPPYVvd18B3MZp`.
- Inner `transferChecked` (Token-2022): `17509274333` raw of the confirmed mint,
  6 decimals (17509.274333 PUMP), from token account `BTuqVet…` — also owned by
  `FkaLnX17…` — into `9Wtcf…`, owned by `99mRw3…`.
- Balance deltas reconcile exactly on both sides.
- **Decoded `Burn`/`BurnChecked`: 0.**

### Safe interpretation

One successful transaction contains a native transfer from an address toward an
account owned by a counterparty, while a target-mint token account owned by that
same counterparty sends target tokens into an account owned by the first address.
That is **same-transaction reciprocal asset flow** and nothing more.

Not proven: buyback, purchase, swap, market buy, revenue funding, causality,
burn, supply reduction. Never write "in exchange for".

## The daily table

A representative row (2026-08-23) was recovered from the embedded record:
`pumpTokensBought ≈ 160,148,975.6`, `buybacksSol ≈ 8,851.32`,
`buybacksUsd ≈ 842,575.61`, `buybackPercentage ≈ 51.3703`,
`transactionCount = 14345`. The values reconcile with the UI.

Two discrepancies to hold on to:

- The field is named **`pumpTokensBought`** while the UI labels it **"$PUMP
  BURNED"**. `pumpTokensBought == burned amount` is **not** independently proven.
- `transactionCount = 14345` has unknown semantics. Never call them "14,345 burn
  transactions".

Embedded-record search result: `EVENT_RECORD_FOUND_NO_IDENTIFIER_IN_RECORD`,
coverage PARTIAL, zero signature-like, zero address-like, zero explorer URLs. The
dated record exists and carries no on-chain identifier. **That line of digging is
closed.**

## Not yet proven

The reciprocal transaction is a buyback · the SOL came from protocol revenue ·
PUMP was purchased on the open market · the 17,509.274333 PUMP received at slot
`441977087` was later burned · the acquisition → burn bridge · that the observed
burn belongs to the published mechanism · official cumulative burn totals ·
Aug 23 record → exact transactions · circulating-supply reduction attributable to
the claimed flow.

A specific PUMP `BurnChecked` **is** now established as a chain fact — see "The
established burn" above. It is not yet Evidence, and it is not bridged to any
acquisition.

## Burn-side strategy — Step 0 executed, Step 1 rejected

Written before Step 0 ran, on the assumption that no PUMP `Burn`/`BurnChecked`
existed anywhere. Step 0 found one already persisted and refuted the premise of
Step 1. The reasoning is kept — including the parts that turned out wrong — so it
is not rebuilt from scratch and not re-litigated.

### What the engine can and cannot reach on its own

The automatic chain for `EXECUTION_EVIDENCE` is
`ACCOUNT_INFO` → `TOKEN_ACCOUNTS_BY_OWNER` → `SIGNATURES_FOR_ADDRESS` →
`TRANSACTION_DETAIL`, and it ends there: a transaction is `TERMINAL_OBSERVATION`,
refused before the depth ceiling so the trace names the true reason. A signature
window promotes **exactly one** transaction, chosen by "newest successful, ties by
signature string" — a rule that cannot be steered by a memo or by content.

So the only transaction the engine will ever read from this locator is whichever
one happened to be newest at observation time. It was read; it contains zero
burns. **Automatic promotion cannot reach a burn from here.** That is the brake
working, not a defect — `onchain-subject-promotion.ts` says in as many words that
"keep looking until you find a burn" is written nowhere.

### The seam that does not need a new capability

`onchain_observed_signatures` already holds every signature of the persisted
window with durable provenance, and `scripts/onchain-transaction-detail.ts`
accepts any signature that `resolveObservedSignature` can re-validate — it
re-checks the originating artifact, its intent, and the parent subject's own
provenance on every call. That is precisely why the window was persisted.

So the window can be read **exhaustively** through the owner-authorized script
path, with the engine's one-transaction brake untouched and no pagination added.

### The discipline that makes this evidence rather than fishing

Reading a second transaction because the first disappointed is a search for a
desired answer. Reading **all** of a pre-declared, already-justified, bounded set
is not: the outcome no longer depends on which one you looked at, and the negative
result is recorded as a finding.

The rule: **declare the complete set in advance and read all of it, or read none
of it.** Never "read one more and see".

### Step 0 — DONE, offline, and it refuted its own premise

Executed against the local database, read-only, zero network calls. Results are in
the inventory sections above. Three things came out of it.

**The premise was wrong.** Step 0 was designed around the possibility that the
zero-balance observation came *after* the acquisition, which would have
established a decrease of a known size in a known interval. It came **before** —
slot `441498936` against `441977087`, roughly 478,000 slots earlier. No decrease
is established by that pairing, and the reasoning built on it is withdrawn.

**A genuine burn was already sitting in the artifact store.** Artifact
`8ccbbac0-…` at slot `441840980` contains a decoded `BurnChecked` of the confirmed
mint. Nobody had looked. The lesson is cheap and worth keeping: **read what is
already persisted before designing a plan to go and get it.**

**Nothing is observed after slot `441977087`.** Not one persisted signature, in any
of the three windows, has a higher slot.

### Step 1 — REJECTED for the burn-after-acquisition question. Not executed.

The 25-signature window `2e332079-…` spans slots `441976802`–`441977087`, and
`441977087` **is** the acquisition — the newest signature in the window is the
acquisition itself. The other 24 all lie strictly before it.

Whatever became of the 17,509.274333 PUMP received *at* that slot is necessarily
recorded in transactions at slots **≥ `441977087`**, of which exactly one is held:
the acquisition, which contains no burn. Reading the remaining 24 exhaustively
would be looking strictly into the past of the event in question. It cannot
answer it — not with poor odds, but structurally.

So Step 1 is rejected **for that purpose** and was not run. It would still answer a
different question (how often burns occur within a 103-second window), and that is
a different question, to be decided on its own merits and not smuggled in on this
one's authorization.

### Step 2 — partly done already, and it was never a fallback

`9jHrTCwp…` did arrive through normal documentary provenance, and one hop was
already taken: artifact `0bfa3d2d-…` at slot `441835488` returned exactly one PUMP
token account, `HxT8kiUKxJ7jdvWfDeRZQzQia4wyRCNN2iRBjMUzcimN`, balance **0**,
`binding_status = CONFIRMED`. Its history has never been observed.

### Rejected, with reasons — do not reopen

- **Paging signature history back to Aug 23.** Prohibited, and hopeless. All three
  saturated windows give 0.24–0.48 signatures per second as a lower bound, so four
  days is on the order of 10^5 signatures — an order-of-magnitude estimate from
  the observed windows, not a measurement, and decisive either way.
- **`TOKEN_SUPPLY` on the mint.** One observation has no time dimension. Two give
  a net change attributable to nothing. Supply is also a definitional concept, not
  only a chain value.
- **Following the counterparty `FkaLnX17…`.** Counterparty-chasing, and it is not
  a documented address.
- **Re-running the head sample until a burn appears.** The prohibited search
  wearing a deterministic rule as a disguise. One scheduled re-observation is
  sampling; repeating it until the answer changes is not.
- **Decoding program `61DF…`.** Out of scope without explicit authorization.

### What the burn establishes, and what it does not

A decoded `Burn`/`BurnChecked` of the confirmed mint is synthesized with
`mechanismState = LIVE`, `SUPPORTS`, `DIRECT`, class `ONCHAIN_VERIFIABLE`. With
confirmed entity binding it satisfies `EXECUTION_EVIDENCE`'s live-state gate —
that component sets `requiresCurrentState = false`, so no freshness window
applies — and it can establish step 4.

The observed burn is not there yet: its artifact is standalone, owned by no
research job, so no Evidence row exists and nothing has been reconciled. Getting
it there is a separate, ordinary step, not a discovery.

Even reconciled, it would not establish: that the burned tokens came from a
buyback, that the SOL was protocol revenue, that the published mechanism is what
ran, the cumulative burn totals, the Aug 23 attribution, or circulating-supply
semantics. The overall mechanism claim stays at best `PARTIALLY_SUPPORTED`.

### The bridge, and what it would actually take

SPL units are fungible, so "*these* tokens were burned" is not directly provable —
no chain record links an acquired unit to a destroyed one. That is a property of
the asset.

It is **not** a reason to declare the bridge impossible. Bounded account-level
QUANTITY continuity would establish one: the account that received the acquisition
is the same account the observed burn destroyed from, and if every state-changing
transaction between two known balance points were deterministically accounted for,
what entered and what left would reconcile as quantities. The bridge holds on
completeness of the interval, not on identity of the units.

One such interval now exists at the strength the index supports, and it needed no
further chain read: across slots `441840975`–`441840980` inflow and destruction
reconcile exactly, both ends are observed at zero, and the window lists nothing
further in that range. That is an inflow → burn continuity statement at account
level, bounded to 26 seconds and one cycle — and bounded also by the index, since
"nothing further was listed" is not the same claim as "nothing else happened".

What it is not is the claimed MECHANISM. The inflow is a transfer; nothing
establishes it as a buyback, a market purchase or revenue-funded, and one cycle
is not a policy. The larger intervals stay unaccounted — 342,044 slots before the
burn, 136,107 after it, and everything past slot `441977087`. Two suggestive
endpoints with a hole between them still establish nothing about the hole.

### Reporting the sample honestly

Four distinct transactions have been read in full, out of an estimated 10^5 in the
relevant period. One of them contains a burn.

That fraction cuts both ways and neither conclusion is available: it is far too
small to support "burns happen routinely", and **absence in a bounded sample is
not evidence of absence** either. The findings are "one burn observed at slot
`441840980`" and "no burn in the transactions read from the other windows" —
never a rate, never a policy, never "no burns occur".

## Success criterion

PUMP does not need to end `SUPPORTED`. `PARTIALLY_SUPPORTED`,
`INSUFFICIENT_EVIDENCE` and `CONTRADICTED` are all correct outcomes. The case is
complete when ATLAS can state what is proven, what is not, which bridge is
missing, and why further exploration is or is not justified. Do not force a
positive verdict.

## Live validation procedure (MantaRay)

The local machine runs a MantaRay VPN/TUN whose fake-IP DNS returns addresses in
`198.18.0.0/15`. ATLAS safe-http correctly SSRF-blocks these reserved IPs.

**Never** weaken safe-http, whitelist `198.18.0.0/15`, special-case a domain, or
relax SSRF validation to accommodate it.

When a live call is separately authorized:

1. prepare the exact bounded command offline;
2. MantaRay OFF;
3. `ipconfig /flushdns`;
4. verify DNS returns real public IPs;
5. execute the exact authorized bounded call;
6. capture complete output the first time;
7. zero retries unless separately authorized;
8. MantaRay ON again;
9. analyse offline.

This workflow has already worked. Development stays MantaRay ON.
