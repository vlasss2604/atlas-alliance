# Current task

> Overwrite this file each round. Never append.

## NONE — dynamic on-chain reactivation V1 + production fact applicability

Offline round. No live HTTP, no RPC, no model call, no Proof, no migration.
Cloud-safe focused tests only.

### PART A — the applicability map was unreachable in production

`onchainFactAppliesToComponent` was right; `loadEvidenceRows` was scoped to
`(job, step, component)`, so a BURN filed at EXECUTION_EVIDENCE was never
offered to NET_EFFECT. The loader now selects a union of the component's own
Evidence plus this job's Evidence whose persisted `onchain_fact_kind` the
closed map declares relevant, with the job predicate outside the union. The
kind list is derived from the same map (`applicableFactKindsForComponent`),
never restated. Documentary rows carry a NULL kind and cannot cross. The map
is still exactly `BURN -> NET_EFFECT`.

### PART B — one bounded reactivation, after the controller

`onchain-reactivation.ts`, called from `run-job.ts` between
`runResearchController` and `reconcileOutstandingComponents`.

Eligible iff: a terminal attempt exists; no on-chain operation was ever
issued for `(job, component)`; and `selectOnchainIntents` now returns an
intent with the locators THIS job has admitted by now. The unit is only
`runStructuredOnchainAcquisition` — no attempt row, no query, no search, no
fetch, no render, no model call.

One-shot is derived from trace (`FETCH_ATTEMPTED` /
`CANDIDATE_SKIPPED_BUDGET` with a canonical on-chain `target_ref`), written
before the call, so a failure consumes the opportunity and a redelivery
repeats nothing. No schema field was added for it.

### PART C — the floor is one authorised chain deep

`ONCHAIN_RESERVED_SOURCE_OPENS = 1 + MAX_PROMOTION_DEPTH` (4), derived from
the promotion rules, capped at half the ceiling, inside an unchanged total
(24 for INTERNAL_ALPHA_V1). Capacity is held while any work-queue component
admits on-chain acquisition and has not had its opportunity — `pendingComponents`
emptiness is no longer a release condition, and a component with no locator
YET keeps the floor because the read it unblocks is what the floor is for.

### PART D — the chain proved offline

late locator → ACCOUNT_INFO → TOKEN_ACCOUNTS_BY_OWNER → SIGNATURES_FOR_ADDRESS
→ TRANSACTION_DETAIL → one BURN Evidence row at EXECUTION_EVIDENCE →
NET_EFFECT reads it through typed applicability →
`SUPPLY_REDUCTION_NOT_ESTABLISHED` clears, `NET_SUPPLY_CHANGE_NOT_ESTABLISHED`
remains, status `PARTIALLY_SUPPORTED`, never `SUPPORTED`.

### Accepted limitation

A reactivated acquisition is indistinguishable in the audit from an ordinary
on-chain one (same operation types, same reason codes, null attempt id).
Labelling it needs a new trace enum value, i.e. a migration — deliberately
not done.

### Standing boundaries

- Applicability grants visibility, never admission.
- Reactivation is newly-unblocked work, never a retry.
- A failure consumes the opportunity; there is no free retry in V1.
- Every RPC still spends one unit of the one canonical sourceOpens ledger.
- No Pattern change, no Research Memory, no historical locator reuse.
