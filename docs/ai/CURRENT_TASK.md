# Current task

> Overwrite this file each round. Never append.

## NONE — first real Proof exists; the cause of INTENT_NOT_CLASSIFIED is identified

Analysis only. No live call, no DB mutation, no code changed.

## The first real persisted Proof in the project's history

Job `6bc1a1ca-…`, Proof `b192ab99-…`, from document `a0513491-…` (consumed).
Verified read-only: `PRIVATE` / `DRAFT`, verdict `INSUFFICIENT_EVIDENCE`,
confidence **60 = STRONG** (a valid D-135 encoding), all seven layers present
with layer 5 empty, `researchCutoff` null. **S9 projects it with no special
handling** — `loadProofForJob` returns the DTO unchanged and a different
user's read returns `null`, so ownership holds. The resumed path produces the
ordinary canonical Proof, exactly as intended.

## The cause — not guessed from the reason-code name

**S7's persisted `intent` is literally the string `"UNKNOWN"`.**

`claim-support-store.ts`'s `loadIntentAndTaskType` reads
`interpretations WHERE research_job_id = <jobId>`, taking only
`normalized_intent` and `task_type` — never free text. When no row matches it
returns `intent: "UNKNOWN"` as a **deliberate, documented non-failure
default**. `evaluateClaimSupport` then short-circuits: `UNKNOWN` is in
`UNCLASSIFIED_INTENTS`, so it returns `INSUFFICIENT_EVIDENCE` /
`["INTENT_NOT_CLASSIFIED"]` with **empty `requirementResults`** before any CORE
lookup.

**Verified in the database: this job has 0 interpretation rows.** Across the
whole DB, 19 of 45 interpretations are linked to a job, and real classified
values exist (`BURN_OR_SUPPLY_EFFECT`, `PROTOCOL_REVENUE_TO_TOKEN`,
`MECHANISM_CURRENT_STATE`, …). The machinery works; this job simply has none.

## Normal path vs D-128 resumed path — the exact missing object

**Normal:** `POST /api/interpretations` runs the interpreter (a model call)
and persists an `interpretations` row carrying `normalized_intent`. `POST
/api/research-jobs` then takes that `interpretationId`, creates the job, and
**links the interpretation to it** (`interpretations.research_job_id`, set
under a guard in `start-owner-alpha-research.ts`). S7 later finds it.

**Resumed:** Stage B is given a *document id, component and step*. It calls
`createResearchJob` directly. **No interpretation is created, and none is
linked** — so S7's lookup finds nothing.

The missing object is therefore precise: **a persisted, linked
`interpretations` row with a classified `normalized_intent`.** Not planning,
not Evidence, not the plan contract.

**`runMemoryPlanningStage` is not a substitute** (question 3: correct,
insufficient). Planning decides *which components to research* from the
Pattern and memory; interpretation decides *what the user asked*. They are
different stages answering different questions, and S7 reads only the latter.

## Why S5 SUPPORTED did not make S7 SUPPORTED

Because they answer different questions, and D-103 fixes that boundary: S6/S5
say what is *structurally established*; S7 says whether it is *sufficient for
the user's claim*. With no claim, there is nothing to be sufficient for — S7
returned before evaluating any requirement. Component support is not claim
support, and converting one into the other is exactly the overclaim the
architecture forbids.

Worth noting independently: the S6 assembly for this job carries
`MISSING_COMPONENT` gaps for `SOURCE_OF_VALUE` and `FLOW_PATH`. One supported
component out of ten is not a mechanism.

## Why boundEvidence = 0 — correct, not a defect

S8 cites Evidence only through `requirementResults[].provenance`, intersected
with what the component treated as supporting and what exists. S7 returned
`requirementResults: []`, so there is **nothing to cite**, and the single
`OFFICIAL_DOCS / CONFIRMED / SUPPORTS` DESTINATION row correctly stays
`proof_id = NULL`.

Binding it manually because S5 supported it would assert that it supports a
claim **that was never evaluated**. The canonical rule produced the right
answer here.

## One honest quality observation (not this task's fix)

Layer 6 — "what could change this conclusion" — is **empty** on this Proof,
because S8 builds it from requirement blocking gaps, claim context gaps and
non-`SUPPORTED` component reason codes, and this job had none of the three
(its one component was `SUPPORTED`). The S6 flow gaps are not among S8's
sources. An `INSUFFICIENT_EVIDENCE` Proof whose "what would change this" block
is empty reads as less honest than the engine actually is. Recorded as an
observation; **not** fixed here, and not the intent problem.

## Smallest generic fix

**Stage B must consume a real, already-classified interpretation and link it
to the job it creates — the same contract the product path uses.**

Concretely: a new required argument (e.g. `--interpretation-id=<uuid>`) naming
an existing `interpretations` row; Stage B validates it (exists, has a
non-`UNKNOWN` `normalized_intent`, belongs to this project, is not already
linked to another job) and sets `interpretations.research_job_id` to its new
job, mirroring `start-owner-alpha-research.ts`'s guarded linking. Nothing else
changes: S7 then finds the row exactly as it does for a product job.

Answers to the posed questions:

1. **Yes** — Stage B must consume a persisted interpretation.
2. **The resume entrypoint**, not Stage A. Stage A acquires a document; the
   intent belongs to the research request, and Stage B is where the job that
   carries it is created.
3. **Correct** — planning ≠ interpretation, as above.
4. **No.** The interpreter resolves an Anthropic gateway; classification *is*
   a model call. It cannot be reused offline — which is exactly why the fix
   consumes an interpretation created earlier rather than classifying inline.
5. **A new argument is required.** The intent states what the *user asked*; it
   is not recoverable from the document, the project or the Evidence, and
   deriving it from any of those is explicitly forbidden.

**Code change required: yes** — small, in `scripts/extract-from-document.ts`
plus tests. No engine change, no S7/S8/S9 change, no new classification logic,
and no relaxation of anything.

**Files likely involved:** `scripts/extract-from-document.ts`,
`tests/two-stage-acquisition.test.ts`, and read-only reuse of
`start-owner-alpha-research.ts`'s linking pattern.

**Fable needed?** No. This is a small, well-specified change in one owner
script with existing patterns to copy; correctness-critical work stays on
Opus, single-agent, per the working style.

## Practical note for the next run

There are 8 unlinked classified interpretations, but **all are `pump_fun`** —
**none for raydium**. So a raydium interpretation must be created first
through `POST /api/interpretations` (a model call, MantaRay ON) before a Stage
B run could reach a claim-evaluable Proof. The already-consumed document also
means Stage A must re-acquire (MantaRay OFF).

### Standing boundaries

- Intent must originate upstream from the user's question — never from
  Evidence, the project, the document or S8.
- Never convert component support into claim support.
- Never weaken S7 or let S8 guess an intent.
- No hardcoded project, component or claim anywhere.
