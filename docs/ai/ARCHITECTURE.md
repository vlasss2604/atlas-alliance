# Architecture — conceptual map

Shape only. This document tells you where a concept lives; the source and the
tests tell you how it works. Do not reproduce enums or schemas here.

## What a research run does

A user question becomes a bounded proof plan, not an open-ended crawl.

```
question → interpretation → Pattern boundary → per-component acquisition
        → sources → evidence → facts → component reconciliation
        → mechanism assembly → claim evaluation → Proof / Verdict
```

Each stage is allowed to say "not established". That is the design.

- Interpretation — `src/server/interpreter/`
- Orchestration — `src/server/engine/controller.ts`, `run-job.ts`, `s4-executor.ts`
- Providers (fetch, render, search, extract, chain) — `src/server/engine/providers/`

## Pattern and components

Research is structured by **Pattern v1 — Token Value Capture**, eight steps, in
`src/server/domain/pattern.ts`. Steps decompose into named components
(`SOURCE_OF_VALUE`, `FLOW_PATH`, `MECHANISM_SPEC`, `GOVERNANCE_BASIS`,
`EXECUTION_EVIDENCE`, `CURRENT_STATE`, `DESTINATION`, `RECIPIENT`, `NET_EFFECT`,
`DURABILITY_BASIS`).

Each component carries **human-authored CORE data**: which source classes may
establish it, whether it needs a current-state or live-mechanism-state basis, its
freshness class, and a one-sentence `evidenceGoal` stating the proposition it must
resolve. The Pattern is CORE — changed by a human, with regression, never by a run.

**Read the component's contract before deciding what may establish it.** The
component names are not self-explanatory and reasoning from them is exactly how
overclaims get in.

## Source → evidence → fact

- **Source class and officiality** are computed from provenance, never asserted:
  `src/server/engine/source-authority.ts`.
- **Entity binding** is a separate axis: chain data must be bound to *this*
  project's confirmed identity (`src/server/domain/project-identity.ts`) or it can
  establish nothing, without being reclassified.
- **Documentary locators** — addresses recovered from documents — are one-to-many
  per fact and carry their own provenance: `documentary-locator*.ts`.
- Document recovery is staged: embedded structured payloads first
  (`__NEXT_DATA__`, JSON-LD, RSC flight frames, `application/json`), then isolated
  rendering only for official docs. The renderer is a scrubbed child process
  behind a deny-by-default egress proxy: `rendered-docs-*.ts`,
  `render-egress-proxy.ts`, `renderer-env.ts`.

## Deterministic on-chain facts

Chain reads use **typed intents only** — no arbitrary RPC. Intents:
`TOKEN_SUPPLY`, `ACCOUNT_INFO`, `TOKEN_ACCOUNTS_BY_OWNER`,
`SIGNATURES_FOR_ADDRESS`, `TRANSACTION_DETAIL`, `TOKEN_ACCOUNT_BALANCE`.
See `providers/onchain-*.ts`.

Chain facts **bypass the model entirely**. `src/server/engine/onchain-facts.ts`
synthesizes statements by code template over validated values, with a literal
fragment of the artifact's canonical JSON as support, and a hand-authored
`doesNotProve` sentence stating what the observation does not establish. There is
no seam for a model in that path.

Reciprocal same-transaction asset flow is derived purely in
`onchain-transaction-flow.ts` and deliberately named nothing: it is co-occurrence,
not exchange.

## Bounded promotion

An intent chain is **evidence-dependent**, not planned up front. Every
account-kind chain starts at `ACCOUNT_INFO`, which establishes *what the subject
is*; only then does promotion decide the next meaningful question
(`onchain-subject-promotion.ts`).

Promotion is gated per component, on purpose. Discovery-only components stop at
the token accounts an address owns; only the component that asks whether a
mechanism *ran* may walk a signature into a transaction. An unresolvable
relationship fails closed rather than guessing.

The philosophy: a bounded window is for deterministic sampling, never for
searching for a dated event.

## Component reconciliation (S5)

`src/server/engine/component-reconciler.ts` turns one component's evidence into a
machine-readable outcome. Pure, deterministic, model-free, network-free.

It applies the component's own contract: admissible class, entity binding,
state/freshness gates, then relationship and directness, then deduplication,
supersession and contradiction. Every exclusion carries a closed-list reason.
Outcome is `SUPPORTED` / `PARTIALLY_SUPPORTED` / `CONTRADICTED` /
`INSUFFICIENT_EVIDENCE`.

It reconciles **one component from one pool**. It never waits for a binding to
arrive from another component — which is why a fact's relationship label must be
correct where the fact is authored.

Two consequences worth knowing before you reason about outcomes:

- **`SUPPORTED` is out of reach for on-chain evidence.** D-074 (LOCKED) caps any
  component whose best establishing element carries officiality `CLAIMED`, and
  every on-chain fact is written `CLAIMED` by design — a canonical chain read is
  not the project's own published claim. The ceiling is `PARTIALLY_SUPPORTED`
  with `INSUFFICIENT_AUTHORITY`. Officiality `CONFIRMED` comes only from a
  human-approved `SOURCE_ROUTE` matched by hostname, and an
  `atlas-onchain://` URI has no hostname. Established and `SUPPORTED` are not
  the same thing.
- **A standalone artifact cannot become Evidence.** `evidence.source_id` is NOT
  NULL and a standalone artifact has no source row, so it is unrepresentable
  rather than merely disallowed. Evidence is written only by
  `persistOnchainArtifactAndFacts`, which requires a job.

Downstream: `mechanism-assembler.ts` (S6) composes the chain,
`claim-evaluator.ts` (S7) evaluates claim requirements.

## Research Memory

Direction, not a finished system: retrieval before fresh research, freshness
policy, and only VERIFIED outcomes becoming durable memory.
`src/server/memory/` — retrieval gateway, planner, lifecycle, verification, blind
evaluation, golden scenarios. See `docs/ARI_LEARNING_LOOP.md` for the intended
evolution. No LLM weights are ever trained.

## Public v1 research areas

1. **Token Value Capture** — the only mature domain; current focus.
2. Governance → Execution
3. Supply / Emissions / Unlocks
4. Treasury / Rewards / Incentives

Areas 2–4 inherit the same discipline once TVC is mature. Do not expand scope
without approval.

## Going deeper

For implementation detail: read the source, read the tests beside it, and use
`git show` on the commit that introduced the behaviour. Commit messages here carry
the reasoning.
