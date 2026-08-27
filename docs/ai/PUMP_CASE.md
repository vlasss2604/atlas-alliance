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
