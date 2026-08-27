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

### The exchange, decoded

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

Three things would be needed to decode them. **Two are now captured for this
transaction; the third still is not.**

One owner-authorized re-read was performed on 2026-08-27 — a single
`getTransaction`, zero retries — producing artifact
`bff0290c-2d5e-4b33-a518-5efaece12338`. Its `raw_response_hash` is **identical**
to the reads a day earlier (`sha256:686ba894…`), so the node returned byte-identical
content and the two observations agree exactly. The `artifact_hash` differs only
because the projection now retains more.

- **Instruction payloads — captured.** Five unparsed instructions preserved: two
  Compute Budget (no accounts, which is legitimate for that program), two
  `JUP6LkbZ…` (31 accounts / 54-char blob outer, 1 account / 181-char blob inner)
  and one `CAMMCzo5…` (17 accounts / 56-char blob).
- **Parent linkage — captured.** See below.
- **Program identity — still absent.** No registry, no IDL, no dependency. The
  material now exists to decode; the means to decode it does not, and acquiring
  it is a separate decision.

### What the linkage establishes, and what it does not

Every one of the three token movements carries `parentIndex = 5`: the wSOL
transfer of `382202589`, the project-token transfer of `7723746661`, and the
wSOL transfer of `382585`. The `CAMMCzo5…` instruction carries it too. Outer
instruction 5 is a `JUP6LkbZ…` instruction.

So the two opposing legs are **CPIs of one and the same outer instruction**, not
merely two movements in one transaction. That rung — *same program invocation* —
was previously recorded as not establishable. It is established now.

**It is still only that rung.** What that invocation was asked to do is not
represented anywhere: the blob is retained, unread. Co-occurrence inside one
invocation is a stronger structure than co-occurrence inside one transaction,
and it is not an exchange, a purchase or an acquisition. A program could batch
unrelated movements inside one invocation and produce this identical picture.
Nothing here identifies `JUP6LkbZ…` or `CAMMCzo5…`, and nothing may.

Derivation is unchanged by the re-read: the reciprocal flow and all three facts
come out byte-identical to the earlier payload, still DIRECT + CONTEXT, still
zero burns. Seeing more did not change what anything means.

The ladder now: same transaction — yes. Same counterparty ownership — yes.
Same program invocation — yes. **Decoded swap instruction — yes.**
**Asset exchange — yes.** Buyback, revenue funding, published mechanism,
market-wide purchase — still no, and those are different questions.

### How it was decoded without a vendored contract

An Anchor program dispatches on `sha256("global:<method>")[0..8]`. A method
name is therefore a HYPOTHESIS that either reproduces the observed eight bytes
exactly or is wrong, and that check runs locally on the real blob. The venue
instruction's eight bytes reproduce `global:swap_v2` exactly.

That result does not rest on the owner-supplied program identities, and barely
uses them: a program answering to that discriminator is answering to that method
name whoever it is. The outer aggregator instruction, by contrast, matched none
of nineteen tested method names and is recorded as **UNSUPPORTED** — nothing
depends on it.

The aggregator's inner instruction is an Anchor event CPI (marker derived from
`anchor:event`, matched exactly). Its event NAME is not established and is
never asserted — only its discriminator bytes, `982f4eebc0606e6a`. Its 132-byte
payload tiles exactly, and every field the tiling produces is corroborated
against something the transaction states independently:

| offset | content | corroboration |
|---|---|---|
| 20 | `So1111…112` | base58-matches the wSOL mint |
| 52 | `382202589` | equals the wSOL transfer out of A's wrapper |
| 60 | `pumpCmXq…` | base58-matches the confirmed project mint |
| 92 | `7723746661` | equals the project-token transfer into A's account |
| 100 | `CAMMCzo5…` | the venue program |

**Account roles were never read from array position.** The ordering contract of
a third-party program is not available locally, and assuming one is exactly the
remembered layout that fails silently. Roles come from mints and amounts instead,
corroborated against the transaction's own transfers; direction comes from those
transfers, never from a flag byte. Reversing the venue instruction's whole
account list changes the result not at all — pinned by test.

### What the exchange is, exactly

> The transaction deterministically executes an asset exchange in which the
> documented address's SOL/wSOL side is used and confirmed PUMP is received.

Concretely: within outer instruction 5, `99mRw3…` paid `382202589` raw wSOL
from its transient wrapper into an account owned by `45ssPkUQ…`, and received
`7723746661` raw units of the confirmed mint from an account owned by that same
party. Note the consideration is `382202589`, not the `382585174` lamports
A wrapped — the remainder went elsewhere and is not part of the exchange.

The fact is **CONTEXT**, exactly like the movement facts. An exchange is an
economic fact about two parties; it is not evidence that a published mechanism
was being carried out, so it establishes no component.

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

## The whole official corpus, and what it does not contain

Searched exhaustively and offline: every source, every Evidence fragment and
summary, every documentary locator, research memory and its provenance, and
project memory. **No document body is stored anywhere** — `sources` holds url,
publisher and title only, and no `snapshot_ref` is populated on any of the 401
Evidence rows. So the documentary corpus ATLAS holds IS the set of fragments.

For Pump.fun that corpus is **four distinct fragments** (10 rows), all from
`https://pump.fun/pump-token`, all OFFICIAL_DOCS / CONFIRMED, and all filed at
**step 6 / DESTINATION**:

1. "Half of every dollar Pump.fun earns buys $PUMP on the open market, then burns
   it forever." (×3)
2. "Burn addresses / 99mRw3…pm4F3c / 9jHrTC…6KVCXM" (×3)
3. "As of 28 Apr 2026, 50% of revenue is programmatically locked and allocated to
   be burned for one year." (×3)
4. "Every burn, on-chain — A verifiable record of each daily purchase and burn,
   settled on Solana." (×1)

### No actor → acquisition bridge exists

The actor address appears in **exactly one fragment**: the "Burn addresses"
heading. Nowhere in the corpus does any text place it near a buying, purchasing,
acquiring or treasury-execution statement.

A keyword sweep does return the claim sentence when searching for the address —
but that match comes from the row's `documentary_locator` column, not from its
text. Checked directly: the claim sentence's fragment does **not** contain the
address. That is locator co-occurrence, which is exactly the thing that does not
count.

So the gap named last round is confirmed by exhaustion, not assumed: **the
documents bind the address to burning and describe the buying, and never join
the two.**

### Second attempt: the page refuses the fetcher

Job `cee22fcb-4238-4827-a1b4-6ce06f8cafa7`, 2026-08-27T15:06:08Z, run with the
observability fix in place. Same six trace events, same ending — but the terminal
reason now reads:

```
CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR
```

**That single word settles what the first attempt could not.** `HTTP_ERROR` is
raised only after DNS resolved and the connection succeeded — it is the server
answering with a non-2xx status. So it was **not** `BLOCKED_ADDRESS`, which means
the tunnel really was off and the live window genuinely open; not
`DNS_RESOLUTION_FAILED`; not `TIMEOUT`; not `UNSUPPORTED_CONTENT_TYPE`.

`pump.fun` refuses ATLAS's static fetcher. Nothing about the research engine is
wrong, and nothing about the tunnel needs changing.

Everything else is unchanged and verified: zero Evidence for the job, no new
`sources` row, the Evidence table still 401 rows with nothing newer than
2026-08-24, `MECHANISM_SPEC` still SOCIAL-only (112 rows), the ten
OFFICIAL_DOCS DESTINATION rows untouched, and S5 returning
`INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. `sourceOpens` stayed 0, so
budget was never the constraint.

The first attempt's reason is still unknowable — it was recorded before the fix.
It plausibly failed the same way; that is not proven and should not be written
as though it were.

### The next blocker: the renderer cannot be reached

The isolated Playwright renderer exists precisely for pages like this, is enabled
for confirmed path-scoped OFFICIAL_DOCS routes, and a real browser is exactly
what usually satisfies whatever refused the plain client. It cannot run here.

The render gate is **static-first by construction**: it evaluates eligibility
from `staticHtmlBytes` and `staticTextLength` of an already-fetched document,
to detect an SPA shell worth re-reading in a browser. A static fetch that throws
`continue`s to the next candidate and never reaches that block at all.

So rendering is an **upgrade path for a successful fetch, never a fallback for a
refused one** — and the gate has no branch for "the server refused us outright".
That is generic, not a Pump.fun quirk: any bot-protected official-docs page is
unreachable the same way.

Whether to add a render-on-refusal fallback is a real design decision with real
cost — a render is its own source open, and a fallback keyed on any 4xx/5xx would
spend one on every refusal. **Not implemented, not decided.**

A smaller open question alongside it: the HTTP status itself (403 vs 429 vs 404)
lives in the exception message and is deliberately not surfaced. A status code is
a bounded integer rather than free text, so it could join the closed allowlist —
but that is a new decision, not a consequence of the last one.
### The re-extraction ran, and failed at the fetch

Job `168ac103-9938-432e-bfc8-dbef29a942fa`, 2026-08-27T14:30:56Z. The scope gate
passed exactly as predicted — officiality CONFIRMED, routeClass OFFICIAL_DOCS,
matched prefix `/pump-token`. Then the fetch failed.

Six trace events, and they stop early: query proposed (fixture), search executed
(fixture), candidate returned, `FETCH_ATTEMPTED`, `FETCH_FAILED /
`PROVIDER_ERROR`. Spend was `searchQueries 1, sourceOpens 0` — the fetch
failed before a source was even opened.

Consequences, all verified: **zero** Evidence rows for the job, no `sources`
row created, the Evidence table still at 401 rows with nothing newer than
2026-08-24, `MECHANISM_SPEC` still holding only SOCIAL/CLAIMED evidence (112
rows), and S5 returning `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. The
DESTINATION rows were not touched.

**So the question the run was meant to answer is still open.** Whether the
current pipeline files that sentence into MECHANISM_SPEC is unknown: the model
was never given the page.

### The observability defect, now proven at real cost

The run reported `CONTENT_FETCHER_FAILED:ContentFetchError` and the trace
recorded `PROVIDER_ERROR`. Neither says **why**, and the difference matters:
`HTTP_ERROR` would mean the site refused the fetcher, `BLOCKED_ADDRESS` would
mean the tunnel was still up and the window never actually opened, `TIMEOUT` and
`UNSUPPORTED_CONTENT_TYPE` would each imply something different again. Each
points at a different next action, and an owner-authorized live window was spent
without being able to tell them apart.

The information exists and is thrown away. `ContentFetchError` carries a typed
`reason` from a **closed, code-authored** enum of eleven values. Two places
discard it:

- `s4-executor.ts` hardcodes `reasonCode: "PROVIDER_ERROR"` on every fetch
  failure, so the trace cannot distinguish any of them.
- `safeFailureReason()` reduces the exception to its CLASS NAME before anyone
  sees it, so `ContentFetchError.reason` never escapes the fetcher.

**The second one is deliberate and its reasoning is sound**: a fetch error's
`message` can embed a credential-bearing URL or an Authorization header
verbatim, which the code notes is confirmed reproducible. But that argument is
about `message`. The `reason` enum is code-authored and structurally
incapable of carrying provider text, so surfacing it leaks nothing.

Smallest generic fix, **not implemented** — it modifies a security-motivated
boundary and deserves explicit approval: have `safeFailureReason` append a
typed reason when, and only when, the error exposes one from a closed code-owned
enum, giving `CONTENT_FETCHER_FAILED:ContentFetchError:BLOCKED_ADDRESS`. No
database enum change and no migration — that string already flows to
`termination_reason` and to owner-script output. Widening the trace's
`reason_code` enum instead would need a migration and is the larger option.
### The supported re-extraction path, prepared and gated offline

The bounded tool for this is `scripts/alpha-acquire-url.ts`: one component, one
already-known URL, no search provider. It builds the REAL S4 executor with the
real ContentFetcher, the real EvidenceExtractor and real S5 reconciliation, so it
cannot make a document admissible that the engine would otherwise refuse. Its
SearchGateway returns only the URL given and its QueryProposer is a fixture, so
no candidate the owner did not name can enter the run and no query model is
called.

Every gate it checks was verified offline before any attempt:

| gate | state |
|---|---|
| `internal_alpha_enabled` | true |
| `ANTHROPIC_API_KEY` | set |
| `pump_fun` in live allowlist | yes |
| extractor model | `claude-haiku-4-5` |
| active topic | `token_value_capture` |
| scope gate | officiality CONFIRMED, routeClass OFFICIAL_DOCS |

The scope gate deserved checking rather than assuming: five SOURCE_ROUTE rows
exist for this domain, and one of them carries no routeClass at all. Two are
ACTIVE, only one applies to `/pump-token`, and a class-less row contributes
null rather than a competing value — so `SOURCE_ROUTE_CONFLICT` does not fire
and the gate resolves to OFFICIAL_DOCS. The rest are SUPERSEDED.

**Expected live footprint:** at most two source opens against `pump.fun` (the
static fetch, plus one isolated render if the render gate opens — the script's
budget allows no third) and **one** Anthropic call for the extractor.

**Command**, for a window with the tunnel off:

```
npx tsx scripts/alpha-acquire-url.ts \
  --url=https://pump.fun/pump-token \
  --component=MECHANISM_SPEC \
  --step=3 \
  --actor=owner \
  --project=pump_fun
```

Not yet run: with MantaRay up, both `pump.fun` and `api.anthropic.com`
resolve into `198.18.0.0/15`, so the fetch and the model call would both be
SSRF-blocked. That is the protection working, and it is not to be relaxed.

### Third attempt: the refusal is 403, the render fired, and OUR browser failed

Job `0f28d892-8bdc-40fa-b877-033ade617c32`, 2026-08-27T16:39:11Z, owner-executed
with MantaRay off. Terminal reason, in full:

```
CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:403; source-route
observations: CLASS_REQUIRES_CONFIRMED_ROUTE:GOVERNANCE,
DOCS_RENDER_AFTER_REFUSAL_FAILED:BROWSER_LAUNCH_FAILED
```

Three things are settled by that line, and one of them reverses the standing
assumption.

**The refusal is `403`** — a renderable status. The scope gate passed
(CONFIRMED / OFFICIAL_DOCS / `/pump-token`), so the refusal path opened exactly
as designed and the render was attempted on its own reservation: DB
`sourceOpensReserved` = 2 (the refused static fetch, then the render), reported
`spent.sourceOpens` = 1, against a ceiling of 2. No third was possible.

**The renderer did not fail because of `pump.fun`. It never started.**
`BROWSER_LAUNCH_FAILED` is raised around the browser launch inside the isolated
child, before any navigation. **The site is not implicated in the render at
all.** Every earlier note treating "the page defeats the renderer" as the live
hypothesis is superseded: that hypothesis has not been tested even once.

**Nothing was written.** Zero Evidence for the job, no new `sources` row (newest
is still 2026-08-24), Evidence table still 401 with nothing newer than
2026-08-24, `MECHANISM_SPEC` still 112 rows and still SOCIAL / CLAIMED only,
S5 `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`. Six trace events, ending
`FETCH_FAILED / PROVIDER_ERROR`. The extractor was never reached — no extraction
event exists and no document was ever handed to a model. The one
`MODEL_CALL_ATTEMPTED` (6560 micro, provider `owner-supplied-url`) is the
script's fixture query proposer, which calls no model.

**The observability fix paid for itself on first use, for the second time in
this case.** Under the previous code this run would have reported a bare
`DOCS_RENDER_AFTER_REFUSAL_FAILED`, and the natural reading — the one the
prepared window's own notes warned about — would have been "pump.fun defeated
the browser too". That conclusion would have been wrong, and it would have
retired a live option that is in fact still open.

**Why the launch failed is NOT established.** What is verified: Chromium is
fully installed (`chromium-1234/chrome-win64/chrome.exe`, with
`INSTALLATION_COMPLETE`), `playwright` 1.62.1 is present, and
`playwright-core`'s own `browsers.json` names revision 1234 — so the install is
coherent, not missing or mismatched. Also verified: this same isolated path,
scrubbed env and all, **previously rendered this very page successfully** — that
render is what promoted `/pump-token` to OFFICIAL_DOCS, and it post-dates the
spawn fix in `808f3e8`. So neither the code path nor the host is new.

The cause inside the stage is unavailable by design: the child is spawned with
`stdio: [..., "ignore"]`, so Playwright's own launch diagnostic is discarded and
never crosses the boundary. A scrubbed-environment cause was considered and is
**weakened, not supported** — the allowlist keeps 14 of 85 parent variables and
drops Windows plumbing a browser may touch (`ProgramFiles`, `ProgramData`,
`ALLUSERSPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `USERNAME`, `PUBLIC`,
`CommonProgramFiles`, `DriverData`), but that same allowlist was in force for the
render that succeeded. Recorded as an open question, not a finding.

### Why the official rows all landed on DESTINATION

Investigated through the trace. **The routing is not the cause, and there is no
generic routing defect.**

One document reaching several components is supported and does happen:
`pump.fun/pump-token` was opened under **six** components — DESTINATION,
DURABILITY_BASIS, FLOW_PATH, GOVERNANCE_BASIS, MECHANISM_SPEC, NET_EFFECT — and
across the corpus eight sources produced Evidence under two to four distinct
components. There is no job-scoped lock claiming a URL for whichever component
reaches it first.

Two separate things went wrong instead:

**1. MECHANISM_SPEC never got a successful extraction of that page with current
guidance.** Its only successful fetch-and-extract ran 2026-08-24T12:21 UTC —
before `evidenceGoal` shipped at 14:02 UTC — and returned nothing. Both later
attempts, on 2026-08-26, died at `FETCH_FAILED / PROVIDER_ERROR` and never
reached the model. So the sentence's absence from MECHANISM_SPEC is a retrieval
reliability outcome, not a judgement one.

**2. DESTINATION over-reported inside its own lane.** Its extractions ran
20:52–21:55 UTC, after evidenceGoal shipped, and returned four semantically
distinct sentences all labelled DESTINATION — a specification, a durability
statement, an execution-record claim, and the one genuine destination fact.

### Why the existing guard cannot catch this

S4 discards any fact whose (step, component) differs from the requested one
(`REJECTED_WRONG_COMPONENT`). That guard has **never fired in this database** —
zero rows — and by construction it cannot fire here: the extractor is *told* the
component and echoes it, so a wrong fact carrying the right label always passes.
The guard prevents cross-component leakage, not mislabelling within the lane.

There is no deterministic fix available. Deciding whether a sentence is really
destination evidence is a semantic judgement, and the architecture deliberately
keeps semantic judgement out of the structural layers — S5 is structural, and
S6's lexical classifiers never decide existence.

### The correctness cost, measured

All three PARTIALLY_SUPPORTED DESTINATION results rest on supporting sets where
only **one of three or four** rows is actually destination evidence. The
component's status is partly carried by evidence that belongs elsewhere.

And `MECHANISM_SPEC` holds only SOCIAL / CLAIMED evidence, which establishes
nothing ever (D-074), so it is INSUFFICIENT_EVIDENCE in all 17 jobs.

### Remedy

Re-extraction through the normal pipeline — a fresh job whose MECHANISM_SPEC work
item actually fetches the page. No rows were edited and none should be: where a
row is filed is an output of extraction, not a field to correct by hand.

**Verified inventory of the claim sentence, 2026-08-27** (read-only, offline).
"Half of every dollar Pump.fun earns buys $PUMP on the open market, then burns
it forever." appears in Evidence **three times, all under `DESTINATION` step 6**,
all `OFFICIAL_DOCS` / `CONFIRMED` / `SUPPORTS` / `DIRECT`, created 2026-08-24,
with `entityBinding` null and `mechanismState` recorded variously as
`buyback_and_burn`, `burned forever` and `active`; one carries the documentary
locator `99mRw3…`. It appears **zero times under `MECHANISM_SPEC`**, whose 112
rows remain SOCIAL / CLAIMED without exception. Three attempts have now been
spent trying to change that and the model has still never been shown the page.

One option was considered and **not** taken: passing sibling components' evidence
goals into the extractor prompt as exclusions. It is generic and Pattern-driven,
but it is a model-behaviour change whose effect cannot be proven offline — a test
could show the prompt contains the text, never that assignment improves. Owner
decision, not a silent edit.
### A component misassignment worth deciding on (reported, NOT changed)

All 10 OFFICIAL_DOCS rows sit at step 6 / DESTINATION. Only fragment 2 belongs
there — it names where assets end up.

Fragment 1 is a mechanism SPECIFICATION: a rate (half), a trigger (every dollar
earned) and the operations. That is verbatim what `MECHANISM_SPEC`'s
evidenceGoal asks for. Meanwhile `MECHANISM_SPEC` holds **only SOCIAL /
CLAIMED evidence — 112 rows** — and SOCIAL establishes nothing ever (D-074), so
the component is INSUFFICIENT_EVIDENCE in all 17 jobs while the best
specification sentence in the corpus sits filed elsewhere.

The cost is concrete. `MECHANISM_SPEC` admits OFFICIAL_DOCS, requires no live
state and no freshness window, and is not token-state sensitive. The row's
officiality is **CONFIRMED** — via the human-approved `SOURCE_ROUTE` for
`pump.fun/pump-token` — so D-074's PARTIALLY_SUPPORTED cap would not apply.
Correctly filed, that one sentence would plausibly carry MECHANISM_SPEC to
SUPPORTED.

Fragment 3 reads as DURABILITY_BASIS ("for one year" is a time limit) or
MECHANISM_SPEC. Fragment 4 asserts that execution records exist — but
`EXECUTION_EVIDENCE` admits only ONCHAIN_VERIFIABLE and OFFICIAL_REPORT, so an
OFFICIAL_DOCS sentence cannot establish it wherever it is filed. That one is
correctly powerless, not misfiled.

**Nothing was reassigned.** Evidence rows carry the component S4 chose at
extraction time; moving them is a decision about how extraction targets
components, not a row edit.
## Mechanism binding: what the documents actually bind

Three OFFICIAL_DOCS Evidence rows exist for this case, all officiality
**CONFIRMED**, all `SUPPORTS` + `DIRECT`, and all filed at **step 6 /
DESTINATION**. Quoting fragments, not summaries — a summary is a model
restatement, the fragment is the document's own words:

| evidence | fragment |
|---|---|
| `082b505f-…` | "Half of every dollar Pump.fun earns buys $PUMP on the open market, then burns it forever." |
| `7fbdba56-…` | "Burn addresses / 99mRw3…pm4F3c / 9jHrTC…6KVCXM" |
| `e929d144-…` | same heading and the same two addresses |

Both burn addresses are CONFIRMED documentary locators on those rows.

### The bridge that exists, and the one that does not

**Exists — actor ↔ burn role.** The project's own documentation publishes
`99mRw3…` under the heading "Burn addresses". That binds the address to the
project's published burn mechanism, at destination-role level. It is why this
sequence is more than an anonymous acquisition followed by a destruction.

**Does not exist — actor ↔ acquisition.** No documentary statement says this
address buys, or that purchases it makes are the protocol's. The claim sentence
describes the mechanism and **names no address**; the locators attached to that
row mean those addresses appear literally somewhere in the DOCUMENT, which is
what the locator validator checks — not that the sentence names them.

So joining "the documents call it the burn address" to "it bought" in order to
reach "the protocol bought back" is affirming the consequent. *The mechanism
burns at X* does not entail *everything X does is the mechanism*.

One further nuance worth keeping: the documented role is a burn DESTINATION —
somewhere tokens end up. The chain shows the address itself acquiring. That is
not a contradiction, and it is not what the label asserts either.

### The strongest permitted statement

> The address Pump.fun's official documentation publishes as a burn address
> executed, in two adjacent transactions, an exchange acquiring 7,723,746,661 raw
> units of the confirmed mint, and then a burn destroying exactly that quantity,
> returning its balance to zero.

Every term there is either a decoded chain fact or an attributed documentary
claim. **Not** buyback, **not** revenue-funded, **not** open-market purchase,
**not** execution of the published mechanism, and not a pattern — one cycle.

### Where reconciliation actually stands

Across the 22 persisted research jobs: `DESTINATION` reaches
`PARTIALLY_SUPPORTED` with `TOKEN_STATE_UNQUALIFIED` (3 jobs) and nothing
higher; `EXECUTION_EVIDENCE` is `INSUFFICIENT_EVIDENCE` /
`MISSING_EXECUTION_EVIDENCE` everywhere; `MECHANISM_SPEC` is
`INSUFFICIENT_EVIDENCE` in all 17 — the claim sentence is filed under
DESTINATION, not under the component that would carry a specification.

And the decisive practical fact: **zero Evidence rows reference any on-chain
artifact.** The 53 ONCHAIN_VERIFIABLE rows are Etherscan pages belonging to
other projects entirely. The whole Solana body of work — exchange, burn,
reciprocal flows, preservation — lives in standalone artifacts and has never
entered Evidence, so there is nothing on the chain side for any composition to
reach.

### Two separate blockers, in order

1. **Evidential.** The actor ↔ acquisition bridge does not exist in any held
   evidence. No composition engine, however good, could conclude buyback from
   what is held.
2. **Architectural.** Even the parts that ARE held cannot be combined: the chain
   facts are not Evidence (standalone-artifact adoption remains undecided), and
   S6 deliberately carries no verdict, proven or confidence field at all — D-103,
   enforced by its own regression test. S6 assembles structure and names gaps; it
   is designed not to make this leap.
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
