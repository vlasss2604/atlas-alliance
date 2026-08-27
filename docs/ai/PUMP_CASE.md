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

The second address **must enter through normal deterministic documentary
provenance**. Do not hardcode it, do not manually trust it.

A documentary "burn address" label proves none of: that a burn occurred, that
PUMP reached the account, that `Burn`/`BurnChecked` executed, that supply
decreased, or that the economic role is what the label says.

## Established on-chain observations

**The locator itself** — `ACCOUNT_INFO`: exists; owner program
`11111111111111111111111111111111` (System Program); relation
`NOT_TOKEN_PROGRAM_OWNED`; no parsed token account; binding `CONFIRMED`. So the
documented locator is a System-Program-owned account, not an SPL token account.

**Its PUMP token account** — `TOKEN_ACCOUNTS_BY_OWNER` filtered by the confirmed
mint returned exactly one account:
`9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX`, owner `99mRw3…`, balance 0 PUMP
in that bounded observation. **Zero balance proves neither burn nor absence of
historical tokens.**

**History is dense.** A bounded `SIGNATURES_FOR_ADDRESS` (limit 25) on that token
account returned 25/25, one observed window covering roughly 1–2 minutes. Bounded
head windows are for deterministic sampling, not for reaching a date several days
back. Do not add paging to get to a date.

## The persisted transaction

Selected from a persisted 25-signature window by the deterministic rule
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
PUMP was purchased on the open market · the received PUMP was later burned · a
specific PUMP `Burn`/`BurnChecked` for the claimed mechanism · the
acquisition → burn bridge · official cumulative burn totals · Aug 23 record → exact
transactions · circulating-supply reduction attributable to the claimed flow.

## Burn-side strategy (designed, not executed)

The acquisition side is established. The missing thing is a genuine PUMP
`Burn`/`BurnChecked`. This section records the strategy, the reasoning, and the
options that were rejected — so none of it is re-litigated.

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

### Step 0 — offline, zero live calls, do this first

Read-only queries against the local database. No existing script covers this
(`alpha-inspect.ts` is research-job-scoped), so it needs either a small read-only
inspection script or a direct query.

1. Artifact `df2ed321-…` (`TRANSACTION_DETAIL`, slot `441977087`): confirm the
   post-balance recorded for `9Wtcf…`.
2. The `TOKEN_ACCOUNTS_BY_OWNER` artifact: its own `slot`, and the balance it
   recorded for `9Wtcf…`.
3. The 25 rows of `onchain_observed_signatures` under artifact `2e332079-…`:
   `slot`, `block_time`, `err` for each.

**Why it matters.** If the zero-balance observation is at a slot *strictly later*
than `441977087`, then within a known slot interval that account's confirmed-mint
balance went from a known quantity to zero. That establishes a **decrease of a
known size in a known interval** — by transfer out, burn, or close, in some
combination. It is not a burn, and must never be written as one. But it turns
"zero balance proves nothing" into a bounded, recorded fact, and it is what makes
Step 1 justified rather than speculative. If the balance observation is *earlier*,
Step 0 yields nothing and Step 1 rests on a weaker footing — say so plainly.

Step 0 also fixes the exact size of Step 1: 25 signatures, minus the one already
read, minus any with `err = true` (a failed transaction executed nothing). Do not
assume that count — read it.

### Step 1 — exhaustive read of the persisted window (needs authorization)

- **Subject set:** every signature persisted under artifact `2e332079-…` that has
  `err = false` and has not already been read. Declared complete before the first
  call.
- **Intent:** `TRANSACTION_DETAIL`, one per signature, via
  `scripts/onchain-transaction-detail.ts`, which refuses any signature lacking
  persisted provenance.
- **Bound:** that exact count, zero retries, one MantaRay-off window, complete
  output captured the first time. Order `slot DESC, signature ASC` for
  replayability — the order is irrelevant because all of them are read.
- **Stop condition:** after the last one. Finding a burn early does **not** stop
  the run; the remaining reads still happen, so the sample stays complete and the
  result stays interpretable.
- **New capability required:** none.

### Step 2 — the second documented burn address (needs authorization)

Independent of Step 1's outcome, and not a fallback for it.

`9jHrTCwp…` must arrive as a documentary locator through the normal docs recovery
path. It is never typed in, never hardcoded, never trusted because it appears in
this file. Once it is a locator, it is an ordinary subject: `ACCOUNT_INFO` →
classification → (if ordinary) `TOKEN_ACCOUNTS_BY_OWNER` → (if a confirmed-mint
token account exists) `SIGNATURES_FOR_ADDRESS` → one `TRANSACTION_DETAIL`.
Roughly four bounded reads. No new capability.

Worth doing even if it yields no burn: the classification and holdings of the
*second* address the project publishes as a burn address is itself a finding. A
large standing balance would be a retained-not-retired shape, which bears directly
on `DESTINATION`'s "retains, redistributes or retires" clause.

### Rejected, with reasons — do not reopen

- **Paging signature history back to Aug 23.** Prohibited, and hopeless. From the
  observed density (25 signatures ≈ 1–2 minutes), four days is on the order of
  10^5 signatures — an order-of-magnitude estimate from the observed window, not a
  measurement, and decisive either way.
- **`TOKEN_SUPPLY` on the mint.** One observation has no time dimension. Two give
  a net change attributable to nothing. Supply is also a definitional concept, not
  only a chain value.
- **Following the counterparty `FkaLnX17…`.** Counterparty-chasing, and it is not
  a documented address.
- **Re-running the head sample until a burn appears.** The prohibited search
  wearing a deterministic rule as a disguise. One scheduled re-observation is
  sampling; repeating it until the answer changes is not.
- **Decoding program `61DF…`.** Out of scope without explicit authorization.

### What success would and would not establish

A decoded `Burn`/`BurnChecked` of the confirmed mint carries `mechanismState =
LIVE`, `SUPPORTS`, `DIRECT`, class `ONCHAIN_VERIFIABLE` with confirmed entity
binding. It satisfies `EXECUTION_EVIDENCE`'s live-state gate — that component
requires no freshness window — so it can establish step 4.

It would still not establish: that the burned tokens came from a buyback, that the
SOL was protocol revenue, that the published mechanism is what ran, the cumulative
burn totals, the Aug 23 attribution, or circulating-supply semantics. The overall
mechanism claim would remain at best `PARTIALLY_SUPPORTED`.

### The bridge that cannot be built, and why

SPL tokens are **fungible**. There is no on-chain link between the units acquired
and the units burned, and no amount of research can create one — this is a
property of the asset, not a gap in the evidence.

The strongest bridge reachable is *account-level continuity*: the account that
received the acquisition is the account the burn destroyed from, plus quantity
accounting across a known slot interval. That is materially weaker than "the
purchased tokens were burned", and ATLAS must say which one it has.

### If nothing is found

Record `INSUFFICIENT_EVIDENCE` for `EXECUTION_EVIDENCE` and name the missing
bridge. Do not acquire a paging capability to keep looking.

State the sample honestly: a few dozen transactions out of an estimated 10^5 in
the relevant period is a fraction of a percent. **Absence in a bounded sample is
not evidence of absence** — the finding is "no burn in the observed window", never
"no burns occur".

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
