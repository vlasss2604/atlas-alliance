# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

The first Raydium on-chain read was executed by the owner (one window,
MantaRay OFF, 2026-08-28T16:53:13Z) and **succeeded**. Analysis only this
round; nothing was executed here, nothing persisted, no code changed.

### What the read established

`DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz` **exists** on Solana mainnet
at slot **442384428** (`finalized`) and is owned by program
**`11111111111111111111111111111111`** — the System Program. It is
`executable: false` and holds `lamports: 7823801354`.

**Classification: C — NON-TOKEN ACCOUNT.** `tokenAccountRelation` =
`NOT_TOKEN_PROGRAM_OWNED`, which the classifier returns only when the owning
program is not an SPL Token program — an *established* negative, not an
unresolved one. `tokenAccount` is therefore `null`: no mint, no token-account
owner, no token amount, no decimals were obtained, and none may be assumed.

**The address is not a RAY token account.** A System-Program account cannot
hold SPL tokens directly; SPL balances live in separate token accounts that
such an address may *own*.

### What it does not establish

Nothing about buybacks, burns, revenue, control, or role. The synthesized
`doesNotProve` says it exactly: program ownership does not establish who
controls the account, what role it plays, "or whether it is a treasury, a
vault, a burn address or an ordinary holder — those are economic labels, not
chain facts." The documentary role (Raydium's docs *state* bought-back RAY is
held here) remains a documentary claim and **has not become a chain fact**.
The lamport figure is a native SOL position at one slot — not a RAY balance,
not a history, not an acquisition.

### The smallest justified next read

**`TOKEN_ACCOUNTS_BY_OWNER`** on the same address, for the confirmed RAY mint
— technically justified, and the production promotion rule reaches the same
conclusion independently: `NOT_TOKEN_PROGRAM_OWNED` → `ACCOUNT_TO_TOKEN_ACCOUNTS`,
permitted for `DESTINATION`, commented "Established as NOT a token account, so
asking which token accounts it owns is a well-formed question. An answer of
none is itself a finding."

Two owner scripts already perform exactly this one read, both bounded to one
RPC with no retry, no cursor and no second intent:

- `scripts/onchain-token-accounts.ts` — diagnostic, persists nothing;
- `scripts/onchain-derive-token-accounts.ts` — persists the artifact and the
  derived subjects (still **no Evidence**).

Neither is authorized here. **An answer of "owns no RAY token account" would
be a real finding, not a failure** — and it would not contradict the
documentation, which may describe an arrangement this single read cannot see.

### The persistence gap — re-confirmed from current code

`ACCOUNT_INFO` still has **no persisting sibling**. Verified by enumerating
every on-chain script: `onchain-account-check.ts` calls
`persistOnchainArtifact` **zero** times, while the pairs exist for
`TOKEN_ACCOUNTS_BY_OWNER`, `SIGNATURES_FOR_ADDRESS` and `TRANSACTION_DETAIL`.
Confirmed in the DB after the window: **0 raydium on-chain artifacts**, 0
artifacts created since the window opened, 4 raydium Evidence rows all with
`onchain_artifact_id` null, latest `DESTINATION` S5 still `SUPPORTED` /
`[]` from 16:04Z. **The read changed nothing.**

Structural reason it cannot be closed by a script alone:
`persistOnchainArtifactAndFacts` requires a `jobId` because
`evidence.research_job_id` is NOT NULL — on-chain Evidence exists only inside
a research job.

### Smallest persisting tool shape (design only — NOT implemented)

`scripts/onchain-observe-account.ts`, mirroring
`onchain-derive-token-accounts.ts`: owner-supplied exact subject + project
slug → confirmed identity supplies the anchor → `resolveOnchainSubject` gate
**before** the retriever → **exactly one** `ACCOUNT_INFO` →
`validateOnchainBinding` → `persistOnchainArtifactAndFacts` (artifact +
`synthesizeOnchainFacts` → Evidence with `onchainArtifactId`) → reconcile
`DESTINATION`. Structurally incapable of: search, documentary fetch, model
call, enumerating other admitted locators, promoting any intent, a second RPC,
or a retry — asserted by test, not promised in a comment.

The one open design question is **job provenance**: Evidence requires a job,
so the tool must either create a minimal owner-attributed job or take an
existing job id. That is an owner decision, not a default.

Expected result if built and run: `sourceClass ONCHAIN_VERIFIABLE`,
`officiality CLAIMED` (D-074 — cannot independently exceed
`PARTIALLY_SUPPORTED`), `entityBinding CONFIRMED`, `directness DIRECT`,
`mechanismState null`, one existence/owner-program fact.

### Next — the owner's choice

1. **One `TOKEN_ACCOUNTS_BY_OWNER` window** on `DdHDoz94o2WJ…` using
   `onchain-token-accounts.ts` (diagnostic) or
   `onchain-derive-token-accounts.ts` (persists artifact + derived subjects).
   One RPC, no retry. Then stop.
2. **First build the `ACCOUNT_INFO` persisting sibling** offline, so this
   read — and the next — can become Evidence rather than terminal output.
3. **Stop.**

Doing 2 before 1 means the existing `ACCOUNT_INFO` observation would have to
be re-read live to be persisted; doing 1 first spends a window on a question
whose answer cannot yet enter Evidence either. Both orders are defensible;
neither is urgent.

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
