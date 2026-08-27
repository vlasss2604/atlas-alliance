# Current state

Where the system actually is. Not a history — for that, `git log --oneline`.

## Repository

- **Last production-behaviour commit: `d04dff9`** — "A transfer is not a
  mechanism, wherever it is offered". The commit that adds this document set is
  documentation-only and sits directly on top of it.
- Branch: `claude/phase-5-research-memory`. Working tree should be clean.
- `npm run typecheck` and `npm run lint` are clean.
- Full suite: **1806 passing, 4 skipped, 2 failing**. Both failures are
  pre-existing and unrelated to research behaviour:
  - `first-real-run-stage2.test.ts` — a source-regex assertion no longer matching
    the current shape of `s4-executor.ts`;
  - `s10-live-provider-enablement.test.ts` — a Windows path bug (`C:\C:\...`)
    while scanning `src/server/services/`.

  Do not "fix" these opportunistically. Verify by stashing before blaming any new
  change on them.

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

Abbreviated PUMP position:

- Official buyback-and-burn claim and both official burn addresses were recovered
  through documentary provenance and are CONFIRMED locators.
- The first locator is System-Program-owned and owns exactly one confirmed-PUMP
  token account; the second owns exactly one as well. Both were observed at zero.
- **A genuine `BurnChecked` of the confirmed mint is established as a chain
  fact**: 7723.746661 PUMP destroyed from the locator's own token account, under
  the locator's own authority, balance to zero, at slot `441840980`.
- **That burn's own interval is closed under the observed index** — deliberately
  weaker than "complete". The transaction five slots earlier moved exactly the
  same raw quantity INTO the same account from a balance of zero, the window
  lists nothing further between them, and the quantities reconcile. An
  account-level inflow → burn continuity statement holds across
  `441840975`–`441840980`, from persisted rows with no further chain read.
  Its ceiling: "nothing further was listed" is not "nothing else happened" —
  ATLAS holds no contract for what the RPC address-signature index covers, and
  models address lookup tables nowhere. The inflow is also a transfer and nothing
  more: not a buyback, not a purchase, not revenue-funded, and one cycle is not a
  policy.
- **That inflow transaction now produces the reciprocal flow.** It carries the
  shape — the documented address pays out native SOL, the counterparty's account
  pays in the project's token — routed through a transient wrapped-SOL account
  the payer creates and closes in the same transaction. That account is in no
  balance metadata, so the flow used to be underivable; its owner now resolves
  from the same-transaction instructions that establish ownership by protocol
  definition. Legs and pairing stay DIRECT + CONTEXT.
- A separate transaction at slot `441977087` contains an exact reciprocal
  SOL/PUMP flow and zero burns. It is **later** than the burn, so the two are
  different cycles.
- Nothing about buyback, purchase, revenue funding, causality or supply reduction
  is proven, and no acquisition → burn bridge exists.
- **The inflow transaction was re-read once, and the opaque material is now
  captured.** Artifact `bff0290c-…` (2026-08-27, one `getTransaction`, zero
  retries) carries five preserved unparsed instructions including both
  unidentified programs, with their accounts, blobs and positions. Its
  `raw_response_hash` is identical to the earlier reads, so the observations
  agree byte for byte.
- **Same program invocation is now established for that transaction.** All three
  token movements and the `CAMMCzo5…` instruction share `parentIndex = 5`, and
  outer instruction 5 is a `JUP6LkbZ…` instruction — so the opposing legs are
  CPIs of one invocation, not merely two movements in one transaction. That rung
  was previously not establishable.
- **The exchange is decoded.** The venue instruction's own method reproduces
  `sha256("global:swap_v2")[0..8]` exactly, and an event emitted in the same
  invocation states both mints and both amounts — each corroborated against a
  transfer the transaction independently records. So: within outer instruction 5,
  the documented address paid `382202589` raw wSOL and received `7723746661`
  raw units of the confirmed mint from the same counterparty. Account roles were
  never read from array position; the ordering contract is not available locally.
- **It is still CONTEXT and establishes no component.** An exchange is an economic
  fact about two parties, not evidence that a published mechanism ran.
- **Buyback is NOT established, and the missing piece is evidential, not just
  architectural.** The documents bind `99mRw3…` to the BURN role — it is
  published under the heading "Burn addresses" — and describe the mechanism in a
  sentence that names no address. Nothing binds the address to the ACQUISITION
  step. Concluding buyback from "the documents call it the burn address" plus
  "it bought" is affirming the consequent. See `PUMP_CASE.md`.
- **Nothing can be composed today in any case.** Zero Evidence rows reference any
  on-chain artifact — the Solana work has never entered Evidence — and S6 carries
  no verdict, proven or confidence field by design (D-103). Revenue funding is a
  third, wholly separate bridge with no evidence at all.
- **The missing bridge is confirmed by exhaustion.** The entire official corpus is
  four distinct fragments from one page; no document body is stored anywhere, so
  fragments ARE the corpus. The actor appears in exactly one of them, the "Burn
  addresses" heading. Nothing anywhere places it near a buying statement.
- **Open decision: OFFICIAL_DOCS component assignment.** All 10 official rows sit
  at step 6 / DESTINATION, including the mechanism-specification sentence, while
  `MECHANISM_SPEC` holds only SOCIAL evidence and is INSUFFICIENT_EVIDENCE
  everywhere. Correctly filed that sentence could reach SUPPORTED, since its
  officiality is CONFIRMED. Reported, not changed — see `PUMP_CASE.md`.
- The aggregator's OUTER instruction variant matched none of nineteen tested
  method names and is recorded UNSUPPORTED. Nothing depends on it.

## Done

- Acquisition-side deterministic evidence for PUMP, with correct limits.
- Multi-locator support, parsed token-account projection, fail-closed relation
  classification, relationship-gated promotion, encoded-account fallback,
  `createIdempotent` lifecycle correctness, reciprocal-flow derivation.
- The component-contract semantics of transfer facts, settled and regression-tested.

## Open

- The **mechanism** bridge is missing. Account-level continuity holds for one
  26-second cycle at `441840975`–`441840980`, but nothing establishes that
  inflow as a buyback, a market purchase or revenue-funded — and one cycle is not
  a policy. The larger intervals stay unaccounted, and **nothing at all is
  observed after slot `441977087`**; no persisted signature anywhere has a
  higher slot.
- The established burn is a standalone artifact owned by no research job, so it is
  a chain fact and not yet Evidence. Verified offline: were it written as
  production writes on-chain evidence, it WOULD establish `EXECUTION_EVIDENCE` —
  at `PARTIALLY_SUPPORTED` / `INSUFFICIENT_AUTHORITY`, which is the ceiling for
  every on-chain fact. Getting it there requires a live retrieval inside a
  research job; there is no offline adoption path, by design.
- The second burn address has one derived token account observed at zero; its
  history has never been read.
- The Aug 23 daily record was recovered but carries no signature, address or
  explorer identifier. That line of digging is closed.
- Cumulative official burn totals are unverified.
- Non-blocking engineering items are in `BACKLOG.md`. Do not work on them unless
  `CURRENT_TASK.md` says so.

## Next research direction

**Awaiting owner direction.** Step 0 ran offline and changed the picture enough
that no new strategy should be written until the result is reviewed.

What it established (`PUMP_CASE.md`, verified inventory):

- A genuine `BurnChecked` was **already persisted** and nobody had looked. The
  cheapest lesson in the case so far: read what is already stored before planning
  to go and get it.
- Step 1 — exhaustively reading the 25-signature window — is **rejected** for the
  burn-after-acquisition question and was not run. That window ends AT the
  acquisition; its other 24 signatures all precede it, so it cannot say what
  happened afterwards. Structurally, not probabilistically.
- The gap is now precise: forward coverage after slot `441977087`, and complete
  interval accounting between known balance points.

Not by paging signature history backward to a date, not by inspecting arbitrary
transactions, not by counterparty-chasing.
