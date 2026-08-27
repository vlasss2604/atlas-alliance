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
- A separate transaction at slot `441977087` contains an exact reciprocal
  SOL/PUMP flow and zero burns. It is **later** than the burn, so the two are
  different cycles.
- Nothing about buyback, purchase, revenue funding, causality or supply reduction
  is proven, and no acquisition → burn bridge exists.

## Done

- Acquisition-side deterministic evidence for PUMP, with correct limits.
- Multi-locator support, parsed token-account projection, fail-closed relation
  classification, relationship-gated promotion, encoded-account fallback,
  `createIdempotent` lifecycle correctness, reciprocal-flow derivation.
- The component-contract semantics of transfer facts, settled and regression-tested.

## Open

- The **acquisition → burn bridge** for PUMP is missing. A burn exists and an
  acquisition exists; nothing connects them. Every interval between the observed
  points is unaccounted, and **nothing at all is observed after slot
  `441977087`** — no persisted signature anywhere has a higher slot.
- The established burn is a standalone artifact owned by no research job, so it is
  a chain fact and not yet Evidence. Nothing has been reconciled against
  `EXECUTION_EVIDENCE`.
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
