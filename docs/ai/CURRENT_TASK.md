# Current task

> Overwrite this file each round. Never append.

## NONE — Stage B now requires a real classified interpretation

Offline implementation. No live call, no model call, no RPC, no network. No
change to the engine, S7, S8, S9, D-135, or the normal `run-job.ts` path.

## What changed

`extract-from-document.ts` takes a new **required** argument
`--interpretation-id=<uuid>`, validates it against persisted state, and binds
it to the job it creates. S7 then finds it through its own canonical query and
stops answering `INTENT_NOT_CLASSIFIED` for want of one.

Stage B still **classifies nothing**. The interpreter resolves an Anthropic
gateway, so classification is a model call; the interpretation must be created
upstream through the normal product entrypoint, and the script never imports
the interpreter (pinned by test).

## Validation — all fail closed, all before anything is created

Missing argument · malformed uuid · `INTERPRETATION_NOT_FOUND` ·
`INTERPRETATION_NOT_READY` (status ≠ `READY`) · `INTERPRETATION_ALREADY_USED`
(already linked to another job) · `INTENT_NOT_CLASSIFIED` (`normalized_intent`
absent or `UNKNOWN` — binding one would reproduce the very defect) ·
`INTERPRETATION_NOT_DEEP_RESEARCH` · `INTERPRETATION_INCOMPLETE` (no
`research_task`) · `INTERPRETATION_PROJECT_MISMATCH`.

**Project compatibility comes from persisted relationships**, not the caller:
the interpretation's own `project_slug`/`project_slugs` must include the slug
of the project the document belongs to. An arbitrary unrelated classified
interpretation therefore cannot be bound. No schema gap — the relationship
already exists.

Intent is never inferred from the document, project, component, locator or
Evidence.

## Linking — the production primitive, not a second contract

The guards mirror `start-owner-alpha-research.ts`, and the link is the same
**compare-and-set**: `UPDATE … WHERE id = X AND research_job_id IS NULL`. If
the row is claimed between validation and linking, the update matches nothing
and the run stops **before extraction**, so nothing is spent and the document
stays resumable.

**One guard deliberately not copied:** the product path checks
`interpretations.userId === session.userId`, because it has a session user.
Stage B has none — it used to mint a throwaway user per run. It now creates
the job **for the interpretation's own user** instead, which is strictly
better: the chain Original Question → Interpretation → Job stays genuine, no
synthetic user is minted, and ownership is inherited rather than asserted.

## Ordering — the failure guarantee

Verified by an offset test on the script's own source:

```
validation → link → planning → extraction → consumption
```

Every refusal happens before the job is used, so a validation failure means
**no extraction, no Evidence, no S5/S6/S7/S8, no Proof, and no consumption
mark** — the acquired document stays exactly as resumable as D-128 specifies.
Extraction failure keeps its existing D-128 semantics unchanged.

**On retry safety:** a refused run leaves the interpretation unlinked, so it
can be reused. A run that links and then fails during extraction leaves the
interpretation bound to that job — matching the product contract, where an
interpretation is used once. A retry then needs a fresh interpretation, which
is correct: the same question asked again is a new request, and silently
re-pointing a used interpretation at a second job would break the one-to-one
chain the schema and `start-owner-alpha-research.ts` both enforce.

## S7 reads it normally

No intent is passed into S7 and no engine parameter was added. The script
calls `evaluateAndPersistClaimSupport(db, job.id, …)` exactly as `run-job.ts`
does, and S7's own `loadIntentAndTaskType` reads
`interpretations WHERE research_job_id = job`. Pinned: the script never calls
`evaluateClaimSupport(` directly and never passes an intent.

Test-proven end to end: with a `PROTOCOL_REVENUE_TO_TOKEN` interpretation
linked, S7 returns `intent = "PROTOCOL_REVENUE_TO_TOKEN"` and **no longer**
emits `INTENT_NOT_CLASSIFIED`.

## Downstream unchanged

S5 → S6 → S7 → S8 as before; S8, S9 and D-135 untouched; `run-job.ts` links no
interpretation itself and is unmodified.

## Recorded separately, not fixed

The first real Proof also exposed that an `INSUFFICIENT_EVIDENCE` Proof can
have an **empty layer 6** even when S6 recorded flow-level gaps. Now in
`BACKLOG.md` under Product surface. Deliberately out of scope here.

## Exact future Stage B command shape

```
npx tsx scripts/extract-from-document.ts --document-id=<uuid> --interpretation-id=<uuid> --component=DESTINATION --step=6 --actor=owner --project=raydium --mode=documentary-only
```

**Prerequisites for the next real run**, in order: a raydium interpretation
created through `POST /api/interpretations` (a model call — MantaRay ON; all 8
existing unlinked classified interpretations are `pump_fun`), and a re-acquired
document via Stage A (MantaRay OFF — the previous one is consumed).

### Standing boundaries

- Intent originates upstream from the user's question — never from Evidence,
  the project, the document, or S8.
- Stage B never calls the interpreter and never classifies.
- Never steal an interpretation already linked to another job.
- Validation before creation: a refusal must never leave a job, Evidence, a
  Proof, or a consumed document behind.
