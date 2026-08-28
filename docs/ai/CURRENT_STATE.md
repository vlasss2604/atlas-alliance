# Current state

Where the system actually is. Not a history — for that, `git log --oneline`.

## Repository

- Branch: `claude/phase-5-research-memory`. Working tree should be clean.
- `npm run typecheck` and `npm run lint` are clean.
- Full suite, last verified 2026-08-28: **2179 passing, 4 skipped, 1 failing**
  (2184 total). Only the second item below failed on that run; the first passed
  because the working copy happened to hold LF. Both are pre-existing and
  unrelated to research behaviour:
  - `first-real-run-stage2.test.ts` — a source-regex assertion against
    `s4-executor.ts`. **Now understood: it is a line-ending artifact.** The
    assertion matches `\n}\n`, and `core.autocrlf=true` checks the file out with
    CRLF, so the regex finds nothing and the match is null. It passes whenever
    the working copy happens to hold LF — which an editor rewriting the file can
    cause — and fails again after any git round-trip restores CRLF. It says
    nothing about the code either way;
  - `s10-live-provider-enablement.test.ts` — a Windows path bug (`C:\C:\...`)
    while scanning `src/server/services/`.

  Do not "fix" these opportunistically. Verify by stashing before blaming any new
  change on them — and for the first one, check the file's line endings before
  believing either result.

## What works today

**Document recovery.** Embedded structured payloads (`__NEXT_DATA__`, JSON-LD,
RSC flight frames, `application/json`), then isolated Playwright rendering for
official docs — scrubbed child process, deny-by-default egress proxy, one
navigation, zero retry, bounded time and body, no clicks/forms/logins/downloads.
An unread payload can never read as absence.

**Documentary locators.** One-to-many per fact, with provenance. The legacy
scalar field is a compatibility projection of ordinal 0.

**Typed on-chain retrieval.** Solana only. Typed intents, deterministic facts, no
arbitrary RPC, project anchor kept separate from the queried subject. Burn and
BurnChecked decoding, including Token-2022.

**Fail-closed account relationships.** `ACCOUNT_INFO` is the sole base intent for
account-kind components and classifies the subject before anything is asked of
it: not-token-program-owned, parsed token account, or token-program-owned but
unresolved (fails closed). Foreign-mint token accounts are CONTEXT — neutral,
never support. Encoded `getAccountInfo` data is a valid answer, not a validation
failure; no mint is inferred from binary.

**Bounded promotion.** Discovery-only components stop at the token accounts an
address owns. Only `EXECUTION_EVIDENCE` may currently walk a signature window
into a transaction. No unbounded paging exists, and none should be added casually.

**Deterministic fact synthesis.** Chain facts bypass the model completely:
code-templated statements, literal artifact fragments, hand-authored
`doesNotProve` limits.

**Component reconciliation (S5).** Pure and model-free. Applies each component's
own CORE contract. Closed exclusion-reason list. Downstream S6 assembly and S7
claim evaluation exist.

Two boundaries verified this round and now written down in `ARCHITECTURE.md`:
on-chain evidence **cannot reach `SUPPORTED`** — D-074 caps officiality
`CLAIMED` at `PARTIALLY_SUPPORTED`, and every on-chain fact is `CLAIMED` by
design; and a standalone artifact **cannot become Evidence** — structurally, not
by convention.

## Latest semantic result

Reciprocal same-transaction asset flow is derived deterministically and named
nothing. Its three facts — native leg, target-token leg, structural pairing — are
all **`DIRECT` + `CONTEXT`**, `mechanismState = null`.

Directness stays `DIRECT` because the reading really is a decoded instruction.
The relationship is `CONTEXT` because every Pattern v1 component such a fact can
be offered for asks a mechanism-level or economic question, and a movement
between two accounts answers none of them. Previously the two legs were
`SUPPORTS` and each established `FLOW_PATH`, `DESTINATION` and `RECIPIENT` on its
own — a semantic overclaim, live only in the sense that the promotion map
happened to route these facts to a component whose live-state gate already
excluded them.

A genuine `Burn`/`BurnChecked` fact is unchanged: **`SUPPORTS` + `mechanismState
= LIVE`**, and still establishes `EXECUTION_EVIDENCE`.

Consequence to keep in mind: S5 reconciles one component from one pool and never
waits for a binding to arrive from elsewhere, so a fact's relationship must be
correct where the fact is authored — not left to a downstream gate.

## Token Value Capture — stage

TVC is the only supported domain and is not yet mature. Target: roughly 10 diverse
TVC projects, with about 8/10 unfamiliar claims reaching a valid result without
manual steering. `INSUFFICIENT_EVIDENCE` counts as valid when the missing bridge
is named correctly.

**PUMP is project #1** — the deep crash/training case. Details in `PUMP_CASE.md`;
read it only for a PUMP task.

### PUMP — CLOSED WITH UNRESOLVED BRIDGES (2026-08-28)

Everything the proof plan justified was learned. The unresolved bridges stay
unresolved, and **no negative conclusion is implied**: nothing here says the
mechanism does not exist, only that ATLAS cannot establish it from what it holds.
Full detail in `PUMP_CASE.md`, "CASE CLOSURE"; this is the bounded summary.

**Documentary, established.** Four distinct fragments, all from
`https://pump.fun/pump-token`, all `OFFICIAL_DOCS / CONFIRMED`, all filed at
step 6 / `DESTINATION` — the buy-and-burn claim, the "Burn addresses" heading
listing `99mRw3…` (truncated on the page; the full value came from the href) and
`9jHrTC…`, the 50%-locked-for-a-year statement, and a claim that a record of each
daily purchase and burn exists. That is the entire first-party corpus.

**On-chain, deterministic, in standalone artifacts.** A genuine `BurnChecked` of
the confirmed mint — 7723.746661 PUMP destroyed from the locator's own token
account, under its own authority, balance to zero, slot `441840980`. Five slots
earlier the same raw quantity entered that account from zero, and the quantities
reconcile: an account-level inflow → burn continuity statement holds across
`441840975`–`441840980`, **closed under the observed index**, which is weaker
than complete. Within one invocation of that inflow transaction, the documented
address paid `382202589` raw wSOL and received `7723746661` raw units of the
confirmed mint from one counterparty — a decoded exchange, offered as CONTEXT.

**Composed: nothing.** Verified at closure: `onchain_artifact_id` is **null on
all 401 Evidence rows** and no row carries a `snapshot_ref`. The Solana work has
never entered Evidence. The 53 rows classified `ONCHAIN_VERIFIABLE` are
model-extracted explorer text with `entity_binding = UNVERIFIED` — some of it
EVM Solidity for a Solana project — and establish nothing, correctly.

**Component state.** The most recent result for **every one of the ten
components is `INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND`.** Three
`PARTIALLY_SUPPORTED` DESTINATION results exist from 2026-08-24 jobs
(`TOKEN_STATE_UNQUALIFIED`) and were not reproduced by the later full-pattern
runs. `MECHANISM_SPEC` holds 112 rows, all `SOCIAL / CLAIMED`, which establish
nothing ever (D-074).

**Two unresolved bridges, kept separate.**

1. **Actor → acquisition.** No authoritative first-party statement assigns the
   acquisition role to `99mRw3…`. Established by exhaustion across all 115
   text-bearing columns: no single text contains both any form of the address and
   any of `buyback`, `purchase`, `acquir…`, `treasury`, `buying`, `executes`.
2. **Revenue → observed acquisition.** Nothing binds the revenue Pump.fun
   describes to the specific observed acquisition. No evidence at all.

**`fees.pump.fun`** is CONFIRMED and unclassified at prefix `/`, and unread —
four windows ended in transport failures, never in a page. Its content is
unknown, so the address's absence from it is **not** established.

## Done

- Acquisition-side deterministic evidence for PUMP, with correct limits.
- Multi-locator support, parsed token-account projection, fail-closed relation
  classification, relationship-gated promotion, encoded-account fallback,
  `createIdempotent` lifecycle correctness, reciprocal-flow derivation.
- The component-contract semantics of transfer facts, settled and regression-tested.
- **Acquisition observability, in four stages**: a fetch failure names its typed
  reason and HTTP status; a render names the stage that failed (launch,
  navigation, data boundary, process) and its sub-reason; the isolated renderer
  is testable offline without a live window; and the egress proxy's own decisions
  reach the operator as counts. Each was paid for by a live window that could not
  explain itself, and each retired at least one hypothesis on its next use.
- **Owner route confirmation** — `confirm-source-route.ts`, unclassified only,
  reusing the existing lifecycle. Confirming a host and classifying a page are
  separate decisions.

## Open

- **Both PUMP bridges stay unresolved** — see the closure summary above. That is
  a legitimate research outcome, not a defect, and nothing should reopen the case
  without new authoritative material.
- The second burn address has one derived token account observed at zero; its
  history has never been read.
- Cumulative official burn totals are unverified.
- Nothing at all is observed after slot `441977087`; no persisted signature
  anywhere has a higher slot.
- Non-blocking engineering items are in `BACKLOG.md`. Do not work on them unless
  `CURRENT_TASK.md` says so.

## Next research direction

**PUMP is closed. Project #2 is blocked on one architectural fork**, not on
finding a project. Selection ran 2026-08-28; the reasoning is in
`CURRENT_TASK.md`.

The single most valuable thing PUMP left untested: **whether any project can
carry an on-chain fact all the way into Evidence and out through a component.**
Every deterministic chain fact in this repository still lives in a standalone
artifact, and no Evidence row references one.

**That path is not the blocker.** Verified by reading it: `onchain-acquisition.ts`
stores the artifact and inserts Evidence with `onchainArtifactId` set,
`sourceClass ONCHAIN_VERIFIABLE`, `officiality CLAIMED` and **`entityBinding
CONFIRMED`**. It works; it has simply never succeeded end to end. (Which also
proves the 53 existing `ONCHAIN_VERIFIABLE` rows, `entityBinding UNVERIFIED` with
null artifact id, did not come from it.)

**The blocker is chain coverage.** `onchain-transport.ts` returns `null` —
`v1: Solana only` — and every intent is gated on `chain === "solana" && network
=== "mainnet"`. `SUPPORTED_CHAINS` admits ethereum and six other EVM chains **for
identity only**, so a confirmed Ethereum project degrades silently to
documentary-only. Not a defect; a capability boundary.

Repository memory holds four projects: `pump_fun` (26 jobs, 401 evidence),
`hyperliquid`, `uniswap` and `raydium` — the latter three with **0 jobs,
0 evidence, 0 routes, no confirmed identity, and no documentary knowledge of any
kind**. `hyperliquid` and `uniswap` are non-Solana, so neither can test the
on-chain path.

**The fork: add an EVM read transport, or choose Solana projects until Pattern v1
is mature.** No Solana TVC candidate exists in repository memory, so option two
needs the owner to name one.

**Resolved 2026-08-28: the owner named RAYDIUM / RAY buybacks**, which is on
Solana, so the transport wall does not apply. Recorded as the **selected next
case and an owner-supplied lead only** — nothing about its mechanism, fee split
or published addresses is a finding, and none of it becomes one until acquired
through the pipeline. Local state is a clean slate apart from the catalog row
recorded below: no identity, route, source, job or artifact; the only `raydium`
mentions anywhere are 11 SOCIAL Evidence rows belonging to `pump_fun` that name
it as a venue.

The shape is deliberately different from PUMP — fee → collection → conversion →
**accumulation at a protocol-controlled destination, with no burn** — so it
exercises **buyback ≠ supply reduction**, an invariant CORE_RULES states and
nothing has ever tested.

**Catalog entry created 2026-08-28** — `raydium` / "Raydium", `ACTIVE_CORE`,
`ticker = null`, project id `9cc80fd6-04ae-45e8-be6c-7ed8b9f663c7`, via the
existing idempotent seed path. That is a catalog row and nothing else: **zero**
`PROJECT_IDENTITY` rows, zero `SOURCE_ROUTE` rows, zero sources, zero Evidence,
zero jobs. No chain and no mint were inferred — the ticker was deliberately left
null so the catalog asserts no token identity, which is `PROJECT_IDENTITY`'s job.
`demo_project_slugs` was **not** touched, so `raydium` is in scope and not
available to DEMO (Scope != Entitlement), and the projects API now proves that
divergence rather than assuming catalog and DEMO config coincide.

**Both owner capabilities now exist.** Nothing blocks the case:

1. ~~`PROJECT_IDENTITY` has no supported creation path.~~ **Closed 2026-08-28** —
   `confirm-project-identity.ts`, generic, discovers nothing, refuses a second
   ACTIVE identity outright. See `ARCHITECTURE.md`.
2. ~~Route classification has no supported path.~~ **Closed 2026-08-28** —
   `classify-source-route.ts` acts on an exact ACTIVE unclassified route by id,
   replaces rather than edits, supersedes the original atomically, and verifies
   the swap against the real resolver. See `ARCHITECTURE.md`.

Plan and pre-registered success criteria are in `CURRENT_TASK.md`.
