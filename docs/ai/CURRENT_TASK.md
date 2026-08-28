# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Offline implementation only. **No live call of any kind was made**, and no
existing Raydium row was touched (verified after: 4 Evidence rows, 0 with an
artifact id, 0 raydium on-chain artifacts, document still consumed).

### What was built

`scripts/onchain-observe-account.ts` — the persisting sibling of the
diagnostic `onchain-account-check.ts`, following the same two-entrypoint
convention as `onchain-token-accounts.ts` / `onchain-derive-token-accounts.ts`
(two scripts, not a `--persist` flag, so each keeps a one-sentence guarantee).

**Never run live yet.** The earlier diagnostic result must NOT be imported
from terminal output; a persisting run performs its own fresh bounded read.

### The job-ownership decision (the real question in this task)

Option **A — the tool creates one owner-attributed job.** Evidence requires a
job (`evidence.research_job_id` NOT NULL), so an Evidence-writing entrypoint
must create one; option B (borrow an existing job id) would attach a chain
observation to a job that did other work and is easier to misuse.

The precedent is `extract-from-document.ts`, which already creates an
owner-attributed job with `skipEnqueue`. The job here is **truthful**: its
`originalQuestion` and `normalizedTask` describe exactly one bounded on-chain
observation — no document fetch, no search, no model call is claimed — and
those budget axes are set to zero.

This does **not** contradict `onchain-derive-token-accounts.ts`, which
deliberately refuses to create a job: that script writes no Evidence, so a job
there would exist purely to satisfy a foreign key and would assert an
operation that did not happen. Here the job *is* the operation.

### CLI contract

```
SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-observe-account.ts <ADDRESS> <projectSlug> <COMPONENT> <STEP>
```

Four arguments, nothing else — no mint, no endpoint, no RPC method, no source
authority, no Evidence classification, no fact text. Extra arguments are
refused. Fails closed on: unknown project, project not in the internal-alpha
live allowlist, `internal_alpha_enabled` false, unknown component, component
not establishable by `ONCHAIN_VERIFIABLE` per the ACTIVE Pattern, no ACTIVE
`PROJECT_IDENTITY`, non-Solana chain, step outside 1..8, subject not
`ELIGIBLE`, containment refusal. Binding is validated before persistence.

### Hard live footprint (asserted by test)

1 subject · 1 `ACCOUNT_INFO` intent · **max 1 RPC** · 0 retries · 0 pagination
· 0 signatures · 0 transaction history · 0 `TOKEN_ACCOUNTS_BY_OWNER` · 0
promoted intents · 0 other admitted locators · 0 search · 0 documentary fetch
· 0 model calls · never invokes the S4 loop.

### What it authors: nothing

One call to `persistOnchainArtifactAndFacts` does artifact + facts + Evidence.
The script contains no `.insert(evidence)`, no `.insert(onchainArtifacts)`,
and no assignment of `sourceClass` / `officiality` / `entityBinding` /
`relationship` / `directness` / `summary` / `doesNotProve` — pinned by test.
So Evidence is `ONCHAIN_VERIFIABLE` / **`CLAIMED`** / `DIRECT` / binding from
`validateOnchainBinding` / `onchainArtifactId` set, decided by production
code. **D-074 holds by construction**: a chain read cannot independently
exceed the authority ceiling.

### Reconciliation and the existing documentary result

`reconcileAndPersistComponent` runs once, only after Evidence is persisted,
and is **scoped to its own job**. It therefore cannot rewrite the
documentary-only `SUPPORTED` that Raydium's `DESTINATION` already carries from
job `baf42b79-…`. A chain observation's own reconciliation would be judged on
its own Evidence — which, being `CLAIMED`, caps at `PARTIALLY_SUPPORTED`.

### Idempotency / re-running later

Each run creates its own job, so a later read at a NEW slot writes a NEW
artifact and NEW Evidence: nothing is overwritten and two slots are never
claimed to be the same state. `uq_onchain_artifacts_job_artifact` is per
(job, artifactHash); within one job `extraction_unit_key` makes a repeat
insert a no-op.

### The `NOT_TOKEN_PROGRAM_OWNED` brake

For the already-observed shape, the production synthesizer emits **exactly one
fact** — existence and owning program — and deliberately says nothing about
holdings. `NOT_TOKEN_PROGRAM_OWNED` ≠ "owns no RAY token accounts" and
contradicts no document; a System-Program account may own token accounts.
That remains a separate bounded `TOKEN_ACCOUNTS_BY_OWNER` intent this script
cannot issue. Pinned by a test that runs the real synthesizer on that exact
result.

### The exact future owner command (NOT executed)

```
SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-observe-account.ts DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz raydium DESTINATION 6
```

Expected on success: one artifact at a fresh slot, one Evidence row
(`ONCHAIN_VERIFIABLE` / `CLAIMED` / `DIRECT`, `onchainArtifactId` set), and a
`DESTINATION` reconciliation for that new job only.

### Next — the owner's choice

1. **Run the command above** in an authorized window — makes the first
   Raydium on-chain fact durable Evidence.
2. **One `TOKEN_ACCOUNTS_BY_OWNER` window** instead — asks whether the address
   owns any RAY token account at all (`onchain-token-accounts.ts` diagnostic,
   or `onchain-derive-token-accounts.ts` persisting).
3. **Stop.**

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
