# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Offline preparation only. **Nothing was executed, nothing was changed** apart
from this file. The first Raydium on-chain read is **READY**, in a
characterization-only form; the step after it is **BLOCKED** by a structural
property worth understanding before authorizing anything.

### The prepared read (one subject, one intent, one RPC)

```
SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-account-check.ts DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz raydium
```

`scripts/onchain-account-check.ts` — the real supported entrypoint, read and
verified this round. Exactly one `ACCOUNT_INFO` intent → one
`getAccountInfo(jsonParsed, finalized)` → **one HTTPS POST**. The transport
performs **zero retries** by construction. No pagination, no signatures, no
transaction history, no counterparty discovery, no search, no model call, no
documentary fetch. The address is checked against `resolveOnchainSubject`
**before** the retriever is constructed, and the DB pool is closed **before**
the RPC runs — so the call happens with no open handle to ATLAS data.

**It writes nothing.** That is deliberate in the script, and it is also the
reason the chain does not continue — see the blocker.

### What it can establish

Whether the account exists; which program owns it; and — only if the node
parses it as an SPL token account — whether its mint is RAY, plus the parsed
owner and balance at the observed slot. That is the technical prerequisite
that decides whether a later `TOKEN_ACCOUNTS_BY_OWNER` read is even
meaningful.

### What it cannot establish, and must never be read as

That a buyback happened, that revenue funded anything, that RAY was burned or
permanently removed, that the balance has any history, or that the address
holds any institutional role. **Documentary role ≠ chain fact; chain fact ≠
economic causality.** A balance is a position at a moment, never a history and
never a purpose.

### The blocker for artifact → Evidence

`persistOnchainArtifactAndFacts` requires a `jobId` — `evidence.research_job_id`
is NOT NULL — so **on-chain Evidence can only be created inside a research
job**. Every owner on-chain script is either diagnostic-only or persists an
artifact plus derived subjects, never Evidence. `ACCOUNT_INFO` has **no
persisting sibling at all** (the pairs exist for `TOKEN_ACCOUNTS_BY_OWNER`,
`SIGNATURES_FOR_ADDRESS` and `TRANSACTION_DETAIL`).

The only path that writes on-chain Evidence today is the S4 executor, and it
would **not** be one bounded read: for DESTINATION it selects `ACCOUNT_INFO`
for the first `MAX_ONCHAIN_INTENTS_PER_ATTEMPT = 2` non-anchor subjects — and
raydium now has **four** admitted locators — plus up to
`MAX_PROMOTED_INTENTS_PER_ATTEMPT = 3` promoted intents, alongside search,
documentary fetch and model calls. Up to five RPC reads across two addresses,
not one.

**Do not widen a script to close this gap in the same window as a live read.**
Closing it is its own offline task, and its shape is an owner decision.

### Also worth knowing before any on-chain DESTINATION Evidence

`DESTINATION` is `tokenStateSensitive: true` with `requiredTokenState: null`
(pattern.ts). The gate downgrades to `TOKEN_STATE_UNQUALIFIED` whenever a
token-state qualifier — `locked`, `staked`, `vested`, `wrapped`, `escrowed`,
`vote-escrowed` — appears in the establishing rows' text. Raydium's current
`SUPPORTED` result carries empty reason codes because none appears. An
`ACCOUNT_INFO` fact's synthesized text contains no such word either, so it
would not itself trigger the downgrade. The gate is a text-detection
downgrade, not a chain-fact requirement — **do not weaken it**.

### Expected shape if that Evidence were ever created

Artifact `ACCOUNT_INFO` (canonical URI, raw + artifact hashes, slot,
finality). Facts: one existence/owner-program fact, plus one token-relation
fact if parsed. Evidence would carry `sourceClass ONCHAIN_VERIFIABLE`,
`entityBinding CONFIRMED`, `directness DIRECT`, `mechanismState null`,
`onchainArtifactId` set — and **`officiality CLAIMED`**. **D-074 is
unchanged**: on-chain Evidence is CLAIMED by design and therefore cannot
independently exceed `PARTIALLY_SUPPORTED`. A foreign-mint token account
would be authored as `CONTEXT`, never support.

### Next — the owner's choice

1. **Run the prepared characterization read** (command above), in an ordinary
   PowerShell window under the established manual live-window procedure. One
   RPC, nothing persisted. Then stop and report.
2. **First close the artifact→Evidence gap offline** — an `ACCOUNT_INFO`
   persisting sibling scoped to one subject, mirroring
   `onchain-derive-token-accounts.ts`. Needs an owner decision about job
   provenance, since Evidence requires a job.
3. **Stop.**

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- token-account owner ≠ wallet · transfer ≠ burn · transfer ≠ buyback · same
  transaction ≠ causality · zero balance ≠ burn or history · current balance ≠
  historical acquisition · documentary label ≠ chain behaviour · chain
  behaviour cannot assign an institutional role.
- No arbitrary history paging, no counterparty chasing. **Stop after the one
  bounded read.**
- Never relax safe-http or SSRF; never whitelist a reserved range.
- Never loosen `extractionResultSchema` to make model output easier to accept.
