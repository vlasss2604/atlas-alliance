# Current task

> Overwrite this file each round. Never append.

## PUMP BURN-SIDE STRATEGY PREPARATION

**Mode:** Opus 5 · High · single-agent · **offline only**.

### Objective

Design — do not execute — the **smallest bounded, deterministic strategy** for
obtaining burn-side evidence in the PUMP case.

Acquisition-side evidence exists: a real transaction with an exact reciprocal
SOL/PUMP flow and zero decoded burns. What is missing is a genuine PUMP
`Burn`/`BurnChecked` bound to the claimed mechanism, and after that the
acquisition-to-burn bridge.

The deliverable is a written strategy: which typed intent, on which subject,
reached through which deterministic provenance path, bounded how, and what each
possible outcome would and would not establish — including the outcome where the
answer is that no bounded strategy exists.

### Boundaries

- Offline. No HTTP, no RPC, no browser, no external research.
- Inspect only what the strategy question needs: the typed intents, the promotion
  rules, burn decoding, and the relevant Pattern component contracts.
- Prefer a generic research rule over anything PUMP-specific. If the strategy
  needs a capability the engine lacks, say so and stop — do not build it in the
  same breath.
- No production behaviour changes in this task.

### Prohibited

- No live calls of any kind. Executing the strategy is a **separately authorized**
  task.
- Do not page dense signature history backward toward a date.
- Do not inspect arbitrary transactions because an earlier one showed no burn.
- Do not chase counterparties.
- Do not hardcode or manually trust the second documented burn address. It may
  only enter through normal deterministic documentary provenance.
- No broad architecture audit. Do not start a second task afterwards.

### Expected first inspection

`onchain-subject-promotion.ts` (which component may reach which intent, and why),
burn decoding in the Solana adapter and `onchain-facts.ts`, and the
`EXECUTION_EVIDENCE` component contract in `src/server/domain/pattern.ts`.

Read `PUMP_CASE.md` for the established case facts before proposing anything.

### Definition of done

A written, bounded strategy with its stop conditions and its honest limits —
plus an explicit statement of what would still be unproven if it succeeded.
Naming a missing bridge is a successful outcome.
