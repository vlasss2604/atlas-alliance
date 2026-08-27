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
it, so nothing has been reconciled against `EXECUTION_EVIDENCE`.

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

Every interval between the observed points is unaccounted. The endpoints are
suggestive — fill, burn to zero, fill again — and suggestive is not established.

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

What is missing here is exactly that completeness. Every interval between the
observed points is unaccounted — 342,044 slots before the burn, 136,107 after it,
and everything after slot `441977087`. Two suggestive endpoints with a hole
between them establish nothing about the hole. That is the honest statement of the
gap, and it names what would close it.

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
