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
  in the input. Unknown stays null. The proposition shown beside a supply
  measurement is the persisted NET_EFFECT component state, copied exactly;
  with no NET_EFFECT result there is no claim. Causal attribution has no
  upstream proposition in V1 and is never stated by the selector.
- Intent and question findings ORDER blocks and pick which metrics survive
  the cap; they never admit a block.

### Dev surface

`/dev/output-plan?fixture=A..E` — five invented records (value capture;
supply effect; governance state; sparse; wallet flow) → selector → the
existing blocks via `selected-blocks.tsx`, with the selector's own
selected/declined list printed above. Production-gated like the showcase.

`/dev/output-plan?job=<uuid>` — a REAL completed Research through the same
selector. The bridge (`real-job-plan.tsx`) reads the job through
`api.getResearchJob`, the production endpoint with the production session,
so ownership and admission are enforced exactly where they always were; the
answer prose is the existing `researchAnswer` / `resultBriefing`
derivation. It adds no server route and no query. A real record is a
HISTORICAL run whose statuses were reduced by the semantics in force when
it ran — the banner says so, because a stale status rendered confidently is
what this product must not ship. Verified on
`8be4e607-5a72-4cfa-b45f-88842b10155c` (Raydium, 2026-09-08): the plan is
ANSWER → PROOF_MAP → EVIDENCE_SNAPSHOT → DEEP_PROOF, everything else
declined. No selector change was needed.

### Known limits

- Quantities and entities are not projected by the job-detail API; a
  later step must project persisted on-chain facts and admitted locators.
- Intent → component relevance lives in the Pattern (CORE, server). The
  client selector uses the question projection's findings for relevance;
  with none, everything is relevant.
- TIMELINE dates come from `publishedAt` / `observedAt` only; a milestone
  with neither is shown undated. ACTIVATED is omitted: no V1 component has
  activation as its proposition, and CURRENT_STATE (live now) is not it.
