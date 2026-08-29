# Current task

> Overwrite this file each round. Never append.

## NONE — D-140: fair SEARCHING and a proposer that pays for itself

Offline round. No live HTTP, no RPC, no real model call, no worker started,
no live Proof.

### The defect

The first real phased run had 10 components in the frozen work queue and 12
search units. `runSearchPhase` walked Pattern order taking 2 each, so the
first six consumed everything and DESTINATION, RECIPIENT, NET_EFFECT and
DURABILITY_BASIS searched nothing. That is D-130's defect in a module D-130
never reached. Separately, 20 real Anthropic proposer calls reserved 0 model
budget, and 8 of them generated queries no component could ever search.

### The fix — D-130's allocator, unchanged

`runSearchPhase` now reads the live reserved counter, the components pending
after this one, and `plan.intentRequired` from `loadAcquisitionPlan`, then
asks `componentSearchAllowance`. No second allocation algorithm exists in the
phase (asserted by reading its source).

Measured on the same real 10/12 shape:

```
SOURCE_OF_VALUE 1   FLOW_PATH 1   MECHANISM_SPEC 1   GOVERNANCE_BASIS 1
EXECUTION_EVIDENCE 1   CURRENT_STATE 1   DESTINATION 1   RECIPIENT 1
NET_EFFECT 2   DURABILITY_BASIS 2          total 12, starved 0
```

NET_EFFECT gets the full cap because the job's intent requires it — D-130's
priority rule doing exactly what it was written for. The last component is
uncapped by design, so the reservation layer stays the only authority on
exhaustion.

### Truthful metering

A real proposer call reserves on the job's own `modelCostMicro` axis via
`reserveJobBudget`, at `calculateMaxAuthorizedCostMicro` of the role's
profile (production catalogue by `query_proposer_model`; injectable in
tests). One envelope, no new ceiling, no raised limit. The worker resolves
the proposer exactly as `s4-executor`'s preflight does, so the
`MODEL_CALL_ATTEMPTED` row carries real tokens and real cost.

A component with zero allowance makes **no proposer call** and writes **no**
`QUERY_PROPOSED` rows — only a `MODEL_CALL_SKIPPED` with the existing
`SEARCH_QUERY_BUDGET_EXHAUSTED` code. The proposer is also asked for exactly
`allowance` queries, never more than the component can search.

D-137 holds on both sides: charged once in SEARCHING, free on replay in
EXTRACTING — pinned by a test that runs both over one job.

### Unchanged

`maxSearchQueries` 12, `maxSourceOpens` 24, `maxModelCostMicro` 2,000,000;
`budget-fairness.ts` itself; controller, attempts, recovery; D-136 queues;
D-137 replay contract; D-138 admission; D-139 sweep; S5–S9.

### Standing boundaries

- Coverage is bounded, not universal: fewer units than components still means
  honest partial coverage, never a pretence that everyone got a share.
- The phase owns no allocator and no budget of its own.
- The budget default is expensive; a provider that says nothing pays.
- Capability is declared, never discovered.
- Phases are never component attempts; the controller runs once.
- A lossy trace ref is never fetched.
