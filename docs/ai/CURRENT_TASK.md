# Current task

> Overwrite this file each round. Never append.

## ANALYTICAL OUTPUT INTELLIGENCE V1 — deterministic block selection

Offline round. No live HTTP, no RPC, no model call, no Proof, no migration.
Focused tests only.

### What it is

One pure function, `chooseAnalyticalBlocks(input)` in
`src/client/output-plan.ts`, sitting where the result presentation was
missing its rule:

```
QUESTION → RESEARCH → EVIDENCE → PROOF → chooseAnalyticalBlocks → UI
```

Given the structured record of a finished Research it returns which of the
approved result blocks (ANSWER, PROOF_MAP, METRIC, TABLE, CHART, FLOW,
TIMELINE, ENTITY, EVIDENCE_SNAPSHOT, DEEP_PROOF) that record justifies, in
what order, resting on which component results and Evidence rows — and, for
every block it declines, a closed reason. NONE is a decision, not an absence.

### Shape, deliberately small

- No persistence, no service, no orchestration, no model, no agent.
- Input is a structural subset of `ResearchJobDetail` (components, admitted
  Evidence, `mechanism.flows`, verdict, question findings) plus two
  reference carriers the API does not project yet: `quantities` (typed
  on-chain amounts, by Evidence id and fact kind) and `entities` (addresses
  with a claimed role and the component that would establish it).
  `inputFromResearchJobDetail` fills what the payload carries and leaves
  those two EMPTY rather than guessed, so on a real payload today METRIC /
  TABLE / CHART / ENTITY are correctly declined.
- Every state in a plan is a presentation of a persisted status (one map,
  `proofStateOf`, with the ladder's asymmetry). A measurement's state comes
  from its Evidence row's admission, never from the component it bears on.
- The selector performs no arithmetic: every amount in a plan is an amount
  in the input. Unknown stays null. Attribution of a supply change to the
  mechanism is NOT_ESTABLISHED whenever stated — nothing in the record
  establishes causation, and nothing disproves it.
- Intent and question findings ORDER blocks and pick which metrics survive
  the cap; they never admit a block.

### Dev surface

`/dev/output-plan?fixture=A..E` — five invented records (value capture;
supply effect; governance state; sparse; wallet flow) → selector → the
existing blocks via `selected-blocks.tsx`, with the selector's own
selected/declined list printed above. Production-gated like the showcase.

### Known limits

- Quantities and entities are not projected by the job-detail API; a
  later step must project persisted on-chain facts and admitted locators.
- Intent → component relevance lives in the Pattern (CORE, server). The
  client selector uses the question projection's findings for relevance;
  with none, everything is relevant.
- TIMELINE dates come from `publishedAt` / `observedAt` only; a milestone
  with neither is shown undated.
