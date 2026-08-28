# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Offline implementation only. **No live call of any kind**; the local Postgres
was read but never mutated, and no existing Raydium row was touched.

### What was built

`scripts/onchain-observe-token-accounts.ts` — the Evidence-writing sibling for
`TOKEN_ACCOUNTS_BY_OWNER`, alongside the diagnostic `onchain-token-accounts.ts`
and the standalone-persisting `onchain-derive-token-accounts.ts`. A separate
entrypoint per intent, deliberately **not** an `--intent` argument on the
existing tool: one script, one sentence, one test.

**Never run live.**

```
SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-observe-token-accounts.ts <OWNER_ADDRESS> <projectSlug> <COMPONENT> <STEP>
```

The mint is never an argument — it travels as `projectAnchor` from the ACTIVE
identity, so this cannot be pointed at an arbitrary token.

### The gate this one adds

`TOKEN_ACCOUNTS_BY_OWNER` is **promotion-only** in production: asking which
token accounts an address owns is well-formed only once something established
the address is *not itself* a token account. The tool enforces that from
**persisted state** — a stored `ACCOUNT_INFO` artifact for the exact subject
and anchor whose normalized result says `NOT_TOKEN_PROGRAM_OWNED`. Missing
that, it refuses and names the sibling to run first. The owner path cannot ask
earlier than the research path would.

For `DdHDoz94o2WJ…` that prerequisite is already satisfied by artifact
`84915cd0-…`.

### Zero-result semantics — the part that matters most

`synthesizeOnchainFacts` returns **nothing** for an empty answer ("absence is
not a fact"), so a zero result persists the artifact and **no Evidence**. That
is correct and was not worked around. An empty answer is **not** "holds no
RAY", **not** "the documentation is false", **not** "no buyback occurred", and
**not** "the address never held RAY". The script prints that limit explicitly
and cannot author a negative — it writes no fact text at all.

Non-zero: **one fact per account**, never a summed total the chain never
reported, each `CONTEXT` (not support), each pinned to its own slot, with
production's own limits attached ("does not establish how any balance got
there… never a history and never a purpose").

### Hard live footprint (asserted by test)

1 owner subject · 1 mint from identity · 1 `TOKEN_ACCOUNTS_BY_OWNER` intent ·
**max 1 RPC** · 0 retries · 0 pagination · 0 `ACCOUNT_INFO` · 0 signatures ·
0 transaction history · 0 promoted follow-ups · 0 other locators · 0 search ·
0 docs fetch · 0 model calls. Returned accounts are recorded as derived
subjects through the existing path and **never read in this window**.

### Evidence, reconciliation, D-074

One `persistOnchainArtifactAndFacts` call; the script authors nothing — no
`.insert(evidence)`, no classification, no fact text. So Evidence is
`ONCHAIN_VERIFIABLE` / **`CLAIMED`** / `DIRECT` / validated binding /
`onchainArtifactId` set, from production. Reconciliation runs once, after
persistence, **scoped to its own job** — job `baf42b79-…`'s documentary
`SUPPORTED` / `[]` cannot be touched. D-074 holds by construction.

### Idempotency — verified, with an honest nuance

A later run at another slot is a separate observation because **each run
creates its own job**: `extractionUnitKey` = `jobId + artifactHash + step +
component + fragment`. The nuance, confirmed rather than assumed: the
`TOKEN_ACCOUNTS_BY_OWNER` fragment is per-account (`{owner, mint, account}`)
and carries no slot, and `artifactHash` is content-addressed on the normalized
result — so an unchanged balance produces an identical fragment *and* hash at
two slots. Job scoping is what separates them; the statement text carries the
slot, and nothing claims continuity between two observations.

### Reported, not fixed: owner identity

**Every owner-tooling run creates a NEW `users` row** (answer B to the
question about the `+1 user` delta). Verified read-only: 15 users, one with 19
jobs (seeded/alpha), recent owner jobs each with their own.
`extract-from-document.ts` and both observe-* tools all do
`db.insert(users).values({})`. Nothing is broken — attribution is correct and
quota logic is DEMO-only — but "the owner" is not one stable identity.
Recorded in `BACKLOG.md`; deliberately not changed here, since a stable owner
identity is an identity decision, not a side effect of an on-chain task.

### Next — the owner's choice

1. **Run the command below** in an authorized window — the first answer to
   whether any RAY is held under the documented address.
   ```
   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-observe-token-accounts.ts DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz raydium DESTINATION 6
   ```
   Expect one of two honest outcomes: accounts returned → one `CONTEXT` fact
   per account plus derived subjects; **zero returned → an artifact and no
   Evidence**, which is a real observation and not a negative finding.
2. **Settle owner identity first** (BACKLOG) — small, offline.
3. **Stop and consolidate.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- documentary role ≠ chain behaviour · current balance ≠ historical
  acquisition · transfer ≠ buyback · buyback ≠ burn · zero balance ≠ burn ·
  zero result ≠ "holds none" · same transaction ≠ causality · token-account
  owner field ≠ institutional actor · chain behaviour cannot assign an
  institutional role.
- No arbitrary history paging, no counterparty chasing. Stop after one
  bounded read.
- Never relax safe-http or SSRF; never whitelist a reserved range.
- Never loosen `extractionResultSchema` to make model output easier to accept.
