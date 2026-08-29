# Current task

> Overwrite this file each round. Never append.

## NONE — first claim-aware Proof analysed; two blockers, not one

Analysis only. No live call, no DB mutation, no code changed.
*(Note: the round's prompt named `c04bf03` as HEAD; it was already `9b1b43b`.)*

## The Proof, verified

`9c5f7683-…` for job `f8e1d880-…`: `PRIVATE` / `DRAFT`,
`INSUFFICIENT_EVIDENCE`, confidence **40 = LIMITED** (bounded by
`REQUIRED_BLOCKING_GAP`), seven layers with layer 5 empty, `researchCutoff`
null, **0 bound Evidence**. S9 projects it unchanged.

**This is the first Proof where a claim was actually evaluated** — S7 ran two
real requirements instead of short-circuiting on an unclassified intent.

## `PROTOCOL_REVENUE_TO_TOKEN` — the exact requirements

| # | id | kind | target | result | persisted reason | blocking gap |
|---|---|---|---|---|---|---|
| 1 | `PRT-1` | `COMPONENT_ESTABLISHED` | `SOURCE_OF_VALUE` | **UNSATISFIED** | `REQUIRED_COMPONENT_MISSING` | `MISSING_COMPONENT` @ `SOURCE_OF_VALUE`, afterStep 1 |
| 2 | `PRT-2` | `FLOW_RELATIONSHIP` | `SOURCE_OF_VALUE` → `DESTINATION` | **UNSATISFIED** | `REQUIRED_RELATIONSHIP_UNRESOLVED` | `DESTINATION_UNRESOLVED` @ `DESTINATION`, afterStep 6 |

Both REQUIRED, both with `evidenceIds: []` in provenance.

## Why `DESTINATION = SUPPORTED` is not enough

The flow's lineage holds **exactly one element** — step 6 `DESTINATION`. The
claim is not "is there a destination"; it is "**does protocol revenue reach
the token**", which the Pattern encodes as a *source* plus a *path from source
to destination*. One endpoint is not a chain.

`evaluateFlowRelationship` is explicit: it returns `SATISFIED` only when
`fromStatus !== null && toStatus !== null`. Here `from` (`SOURCE_OF_VALUE`) is
absent from the lineage, so the relationship cannot even be assessed.

**Component supported ≠ relationship resolved.** S5 said "this component's
evidence establishes it." S7 asks "do the components form the mechanism the
claim needs." Those are different questions, and D-103 fixes that boundary.

## The finding that changes the milestone: there are TWO blockers

`DESTINATION` **is** in the lineage, yet S6 still emitted
`DESTINATION_UNRESOLVED`. The reason is not absence — it is the second branch
of the assembler:

```
if (!lineageStepFor(l, "DESTINATION"))      → absent          (not taken)
else if (destinationKind === "UNKNOWN")     → UNRESOLVED      (taken)
```

`classifyDestinationKind` is a **literal phrase dictionary**. `BUYBACK_HOLD`
matches only `"buyback and hold"`, `"bought back and held"`, `"held in
reserve"`. The persisted Evidence says:

> "Bought-back RAY is **held at the address** DdHDoz94o2WJ…"

Semantically that is buyback-and-hold. Lexically it matches none of the three
phrases, so the kind is `UNKNOWN` and the gap fires — **with the supporting
evidence id attached to it**.

**Consequence:** `PRT-2` would still fail *even if `SOURCE_OF_VALUE` were
established*, because the `unresolvedRelationship` branch is checked before
the generic fallback. Establishing more components fixes `PRT-1`; it does not
by itself fix `PRT-2`.

I am **not** proposing to add a phrase to make this case pass. Tuning a
classifier dictionary until one document classifies is fitting the answer to
the question. Whether the dictionary is too literal is a real, separate
research-quality decision — recorded in `BACKLOG.md`, not decided here.

## Why `boundEvidence = 0` — correct

S8 cites through `requirementResults[].provenance.evidenceIds`. Both
requirements are `UNSATISFIED` and both carry `evidenceIds: []` — the
evaluator deliberately returns no evidence on its unsatisfied branches.
So there is nothing to cite, and both Evidence rows correctly keep
`proof_id = NULL`.

Binding the `SUPPORTS` row anyway would assert it supports a claim the engine
just recorded as unsatisfied.

## Is D-128's single-component contract the main limitation?

**For multi-component intents, yes — but it is not the only one.** Every
research intent except `TOKEN_UTILITY` needs ≥ 2 components, and a Stage B run
yields exactly one. That bounds what the two-window route can demonstrate.

It is not sufficient on its own, per the `destinationKind` finding above.

## Next major milestone — the honest answer is **C**

**The production path already solves multi-component.** `run-job.ts` +
`controller.ts` take one job, walk a work queue of many components, run S4 per
component, then project S5→S6→S7→S8 **once**. That is precisely the
"one intent, one job, many component Evidence units, one projection" shape
requested — it exists, it is tested, and it is the path a real user takes.

D-128 is a **workaround for a network constraint**, not a research
architecture. Growing it into a multi-component orchestrator would duplicate
the controller in a script: a second work queue, a second stopping rule, a
second projection trigger — exactly the "another Proof pipeline" the last few
rounds were careful to avoid.

**So the milestone I recommend is: make the product path runnable** — the
environment/network work, not more script surface. That yields a real Proof
through `POST /api/research-jobs`, with many components, in one job.

**If** the network cannot be fixed and D-128 must be extended, then **B**, not
A: multiple Stage B extractions attach to the **same** research job, and a
**separate explicit finalize step** runs S6/S7/S8 once. B is better than A
because it keeps each document sealed and independently consumed, preserves
one-intent/one-job, and makes projection an explicit act rather than something
that fires after every partial. Note this would require changing what I built
last round, where S6/S7/S8 run at the end of *every* Stage B — with several
units per job those would re-run repeatedly (idempotent, so no duplicate rows,
but a premature intermediate Proof each time).

## Layer 6 — the BACKLOG issue did NOT reproduce here

Layer 6 is **populated**, with both gaps:

```
MISSING_COMPONENT at component SOURCE_OF_VALUE
DESTINATION_UNRESOLVED at component DESTINATION
```

The two S7 reason codes appear in **layer 4** ("Claim-level reasons:
REQUIRED_COMPONENT_MISSING, REQUIRED_RELATIONSHIP_UNRESOLVED"), which is
where claim-level limitations belong.

So the recorded issue is narrower than first written: layer 6 is empty **only
when `requirementResults` is empty** — i.e. when no claim was evaluated at all
(the `INTENT_NOT_CLASSIFIED` case). BACKLOG updated to say so.

**When to address it: after.** It did not manifest on a claim-aware Proof, and
the multi-component question is far more consequential.

## Fable needed?

**No.** This is correctness-critical engine/architecture work — Opus, High,
single-agent, per the working style. Nothing here is a parallelisable bulk
task.

### Standing boundaries

- Never tune a classifier dictionary to make one document pass.
- Component supported ≠ relationship resolved ≠ claim supported.
- No second Proof pipeline, no second work queue in a script.
- Never bind Evidence to a claim the engine recorded as unsatisfied.
