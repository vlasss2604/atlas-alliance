# Current task

> Overwrite this file each round. Never append.

## NONE — awaiting owner direction

Next-case selection ran offline. **Decision: B — ARCHITECTURE FIRST**, with one
correction to the premise. No research started, no code changed.

### The premise needs correcting first

The task supposed the blocker might be artifact → Evidence semantics. **It is
not. That path exists and is fully wired**, verified by reading it:
`onchain-acquisition.ts` stores the artifact, calls `synthesizeOnchainFacts`
("MANY facts, ONE artifact"), and inserts Evidence with `onchainArtifactId` set,
`sourceClass: ONCHAIN_VERIFIABLE`, `officiality: CLAIMED` and
**`entityBinding: CONFIRMED`**.

That also sharpens the closure finding: the 53 existing `ONCHAIN_VERIFIABLE` rows
carry `entityBinding = UNVERIFIED` and a null artifact id, so they demonstrably
did **not** come from this path — they are explorer pages read as documents.

**The real wall is chain coverage.** `onchain-transport.ts` returns `null` with
the comment `v1: Solana only`, and the Solana adapter gates every intent on
`chain === "solana" && network === "mainnet"`.

### What repository memory actually holds

Three projects are seeded. Verified per project:

| project | chain | jobs | evidence | routes | identity |
|---|---|---|---|---|---|
| `pump_fun` | solana | 26 | 401 | 6 | CONFIRMED |
| `hyperliquid` | (its own L1) | 0 | 0 | 0 | none |
| `uniswap` | ethereum | 0 | 0 | 0 | none |

Both non-PUMP projects are **completely unstarted**, and the repository holds
**no documentary knowledge whatever** about either — no route, no fragment, no
identity. Anything said about their mechanisms is general knowledge, not
something ATLAS has read.

**Neither can test the production on-chain path**, because both are non-Solana.
`SUPPORTED_CHAINS` admits ethereum and six other EVM chains **for identity**, but
no transport exists for any of them — so a confirmed Ethereum project degrades
silently to documentary-only. That asymmetry is a real capability boundary, not
a defect: S4 treats a missing retriever as a configuration boundary and falls
through to the normal path.

### The smallest architecture question, and it is a fork

**Does ATLAS add an EVM read transport, or does it choose Solana projects until
Pattern v1 is mature?**

Three consequences, and the owner's answer decides the next several cases:

1. **Add EVM transport** — the largest option. It unlocks Uniswap-class cases
   (real on-chain governance, a fee switch, proposal → execution), which stress
   Pattern components PUMP never touched. Cost is a second chain adapter with its
   own encoding, method allowlist and validation, plus everything D-134 identity
   means on EVM.
2. **Stay Solana-only** — cheapest, but **no Solana TVC candidate exists in
   repository memory**, so it requires the owner to name a project. I will not
   browse for one or invent one.
3. **Run Uniswap now as a documentary/governance case**, accepting that the
   on-chain half stays untested. Genuinely valuable — it would exercise
   `GOVERNANCE_BASIS` and the *proposal ≠ execution* rule, neither of which PUMP
   ever reached — but it does not answer the question this selection was for.

### If it helps: what each candidate would and would not prove

**Uniswap — fee switch / governance-approved distribution.** Mechanism type A+C,
maximally different from PUMP. Documentation and governance records are
authoritative and plausibly static-fetchable. Stresses `GOVERNANCE_BASIS`,
`MECHANISM_SPEC`, `SOURCE_OF_VALUE`, `FLOW_PATH`, `RECIPIENT`,
`DURABILITY_BASIS`. **Cannot** produce on-chain Evidence today. Cost: MEDIUM
documentary, and the actor-identity risk is *lower* than PUMP's because
governance proposals name contracts explicitly. Expected failure mode: proposal
records that describe intent without observable execution — exactly the rule
worth testing, and a legitimate `INSUFFICIENT_EVIDENCE`.

**Hyperliquid — assistance-fund purchases.** Closest in shape to PUMP
(buy-side), so it scores worst on mechanism diversity, and its own L1 is not in
`SUPPORTED_CHAINS` at all. Cost: HIGH, value: lowest of the two.

### Standing boundaries

- No live calls without a separate authorized window; no retries.
- Never relax safe-http or SSRF, never whitelist a reserved range, never
  special-case a domain, never add anti-bot evasion or spoof a user agent.
- Do not edit or re-run the old DESTINATION rows.
