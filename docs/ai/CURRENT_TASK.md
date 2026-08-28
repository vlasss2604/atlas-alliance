# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Analysis only. No live call was made this round; only the local Postgres was
read, and nothing was mutated.

### What the owner window achieved

**The chain-to-Evidence path closed end to end for the first time in this
repository** (job `9d488cc6-…`, 2026-08-29). One RPC → artifact → synthesized
fact → Evidence carrying `onchainArtifactId` → reconciliation. That was the
single most valuable thing PUMP left untested, and it is now answered.

The observation itself repeated the earlier characterization at a fresh slot
(`442446081`, `finalized`): exists, System Program owner, `executable false`,
`lamports 7823801354`, `NOT_TOKEN_PROGRAM_OWNED`, binding `CONFIRMED`.
**Nothing new about the account was learned** — what is new is that it is
durable Evidence instead of terminal output.

Persisted, verified in the DB: artifact `84915cd0-…` (`RESEARCH_JOB` origin,
source = the `atlas-onchain://…/info` URI, `sourceType ONCHAIN`); Evidence
`7770000d-…` (step 6 `DESTINATION`, `ONCHAIN_VERIFIABLE` / `CLAIMED`,
`entityBinding CONFIRMED`, `SUPPORTS` / `DIRECT`, `mechanismState null`,
`onchainArtifactId` set). Exactly one of each; no duplicate artifact hash
anywhere. The job reserved **0** on all three budget axes and wrote no trace
rows.

**D-074 held visibly:** this job's `DESTINATION` reconciled to
`PARTIALLY_SUPPORTED` / `["INSUFFICIENT_AUTHORITY"]` — the code emits that
reason exactly when the best establishing row is `CLAIMED`. The ceiling was
observed, not asserted.

**The documentary result is untouched:** job `baf42b79-…` still holds
`SUPPORTED` / `[]`. Reconciliation is job-scoped, so five `DESTINATION`
results now stand side by side, each honest about its own job's Evidence.

**The two statements remain separate.** The docs *state* bought-back RAY is
held at that address; the chain says only that it is a System-Program account.
Neither confirms the other, and `NOT_TOKEN_PROGRAM_OWNED` still does not mean
"owns no RAY token account".

### Next justified bounded intent — unchanged

**`TOKEN_ACCOUNTS_BY_OWNER`**, owner = `DdHDoz94o2WJ…`, mint = the confirmed
RAY mint. It is the question the first read made well-formed, and it is the
only one that can say whether any RAY is held under that address. Not
executed.

Two entrypoints already perform exactly that one read — one RPC, no retry, no
cursor:

- `scripts/onchain-token-accounts.ts` — diagnostic, persists nothing;
- `scripts/onchain-derive-token-accounts.ts` — persists the artifact and the
  derived subjects, but **no Evidence**.

**A gap worth naming before choosing:** there is no persisting-to-Evidence
sibling for `TOKEN_ACCOUNTS_BY_OWNER`, the same gap just closed for
`ACCOUNT_INFO`. `onchain-observe-account.ts` is deliberately single-intent and
cannot issue it. So a run today yields either a diagnostic print or an
artifact + derived subjects — not Evidence, and not a component result.

**An answer of "owns no RAY token account" would be a genuine finding, not a
failure** — and it would still not contradict the documentation.

### Next — the owner's choice

1. **One `TOKEN_ACCOUNTS_BY_OWNER` window** with
   `onchain-derive-token-accounts.ts` (persists artifact + derived subjects,
   so a later read needs no repeat RPC).
2. **First generalize the persisting tool to that intent offline**, so the
   answer can become Evidence and reach `DESTINATION` in one window rather
   than two. Scope decision required: a second single-intent script, or one
   tool with an intent argument — the latter weakens the one-sentence
   guarantee each current script keeps, so a sibling is the safer default.
3. **Stop and consolidate.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- documentary role ≠ chain behaviour · current balance ≠ historical
  acquisition · transfer ≠ buyback · buyback ≠ burn · zero balance ≠ burn ·
  same transaction ≠ causality · token-account owner ≠ institutional actor ·
  chain behaviour cannot assign an institutional role.
- No arbitrary history paging, no counterparty chasing. Stop after one
  bounded read.
- Never relax safe-http or SSRF; never whitelist a reserved range.
- Never loosen `extractionResultSchema` to make model output easier to accept.
