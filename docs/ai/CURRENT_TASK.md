# Current task

> Overwrite this file each round. Never append.

## NONE — the product-path unblock is designed, not implemented

Offline analysis/design. No live call, no DB mutation, no code changed.

## 1. The canonical loop, and where it couples

```
POST /api/interpretations → POST /api/research-jobs → worker
  → runMemoryPlanningStage → runS4ResearchJob → controller (work queue)
  → per component: WorkExecutor.execute()
       ├─ queryProposer  (MODEL)
       ├─ searchGateway  (BRAVE)
       ├─ contentFetcher (SOURCE HOST)      ← s4-executor.ts:1468
       └─ evidenceExtractor (MODEL)         ← s4-executor.ts:1643
  → S5 → S6 → S7 → S8 → S9
```

**The coupling is tighter than "same job": it is inside ONE `execute()` call
for ONE component.** Fetch and extract are ~170 lines apart in the same
function, same process, same instant. No boundary exists between them today.

## 2. The landmine that kills the obvious fix

The obvious design — run each component twice, once to fetch and once to
extract — **cannot work**, and the reason is precise:

`controller.ts` treats *any* attempt after the first on a component key as a
**recovery attempt** (`isRecoveryAttempt = maxAttemptByKey.get(key) > 0`),
charged against `budget.reservedRecoverySteps`, which `INTERNAL_ALPHA_V1`
sets to **1 for the entire job**. A two-attempt-per-component scheme would
exhaust the whole recovery pool on the first component and stall.

So the two phases **must not be two attempts of the same work item.** That
single fact determines the architecture.

## 3. Reusable D-128 engine primitives (A) vs owner-script orchestration (B)

`src/server/engine/acquired-documents.ts` is already a clean 209-line
**engine capability**, not script logic:

| primitive | what it gives the product path |
|---|---|
| `persistAcquiredDocument` | seal (`text_sha256`) + authority snapshot |
| `loadAcquiredDocumentForResume` | seal verify · both-ends authority · project scope · consumption check |
| `replayContentFetcher` | exact replay, refuses any other url |
| `markAcquiredDocumentConsumed` | at-most-once |
| `authorityPermitsAcquisition`, `textSha256` | shared predicates |

**Owner-script-only (B), to be reused by nobody:** CLI parsing, job creation,
interpretation binding, the fixture proposer/single-url search gateway, the
S5→S8 projection calls, and all printing. The product path reuses **A** and
copies none of **B**.

## 4. The design — two phases, one job, one controller

**Phase A — `SOURCE_ACQUISITION`** (runs on a source-capable worker):
job-level, **before** the controller. Derives candidate urls
**deterministically** — `buildTargetedQueries` plus the project's confirmed
`SOURCE_ROUTE`s — searches and fetches, and seals each document via
`persistAcquiredDocument`. Writes **no Evidence, no component attempts, no
component results, and makes no model call**.

This is not a new capability: S4 already has a model-free targeting path and
already tolerates skipping the proposer
(`MODEL_QUERIES_UNUSABLE_SKIPPED_PROPOSER`).

**Phase B — `MODEL_EXTRACTION`** (runs on a model-capable worker): **the
normal controller run, unchanged.** The only difference is that
`contentFetcher` is a **replay fetcher over this job's sealed documents**
instead of the network fetcher. Every component therefore gets its **first**
attempt here — the recovery pool is untouched — and S5/S6/S7/S8/S9 behave
exactly as they do today.

**Why this is the minimal correct shape:** the controller is not modified, no
second work queue or stopping rule is introduced, Evidence is created exactly
once in one job, and the D-128 concept moves *underneath* the product path
instead of beside it.

## 5. Process/queue boundaries, stated without a VPN in them

The handoff is the **existing pg-boss queue**: one additional queue name and a
phase recorded on the job. Two **worker roles** consume different queues; each
role is deployed where it has the network access its phase needs.

**ATLAS names capabilities, never a provider or a VPN.** The domain knows
`SOURCE_ACQUISITION` and `MODEL_EXTRACTION`; which process can reach what is a
deployment fact. "MantaRay" must appear nowhere in the codebase, and no
process ever changes its own routing.

## 6. Failure / resume contract — unchanged

Sealed documents, exact replay, both-ends authority, at-most-once consumption
(now per document within one job), no raw-text injection, failed extraction
leaves its document resumable, no fabricated Proof, no duplicated component
work (first attempts only), one Proof per job (DB-enforced).

## 7. Product UX afterwards

Ask question → Start Proof → receive Proof. The user never sees a stage, a
document id, a replay transport, or any network concept. Phase A/B are
infrastructure, invisible above the queue.

## 8. Risks, named rather than smoothed

1. **Brave's network requirement is unknown** — it has never been exercised
   live. Phase A assumes search groups with source fetch. If search needs the
   model network instead, the split line is in the wrong place and the design
   must move it. **This is the assumption most worth testing first, and it is
   cheap to test.**
2. **Deterministic targeting is narrower than model-proposed queries**, so
   Phase A may acquire fewer or worse documents than a single-process run —
   a research-quality regression traded for runnability.
3. **Staleness between phases.** D-128's rule already applies: a resume
   evaluates exactly what was captured, and a fresh look is a new acquisition.
4. **Two worker roles are deployment surface.** A mis-provisioned role stalls
   jobs silently unless the phase is observable.

## 9. Recommendation — and the honest ordering

**Fix the environment first.** One network state that reaches both the docs
host and Anthropic restores the single-process product path with **zero code
change**, and everything above becomes unnecessary. It is strictly smaller
than building a distributed stage machine.

**Build this only if the environment genuinely cannot provide one state.** It
does have independent long-term value — offline reprocessing, provider
outages, rate-limit windows, air-gapped extraction — so it is not wasted work,
but it should be chosen deliberately, not by default.

## 10. Minimum implementation slice (if chosen)

Do **not** start with the queue split. Start with the two halves under one
process, proven offline:

1. A **multi-document replay fetcher** — generalise `replayContentFetcher`
   from one document to a job's sealed set, refusing any url outside it.
2. A **job-level acquisition pass** reusing `persistAcquiredDocument`, behind
   an explicit mode, writing no Evidence and making no model call.
3. An offline test that one job acquires N documents, then runs the **normal
   controller** with the replay fetcher and reaches S8 with **first attempts
   only** — proving the recovery pool is untouched.

Only after that: the job phase column, the second queue name, and the worker
role split. **Migration:** a phase column on `research_jobs` (or a small
companion table) plus a queue name — no data migration.

**Files likely involved:** `acquired-documents.ts` (replay set),
a new job-level acquisition module, `run-job.ts` / `worker.ts` /
`jobs/queue.ts` for the phase and queue, `research.ts` schema for the phase.
`controller.ts`, `s4-executor.ts`, S5/S6/S7/S8/S9 should need **no** change —
if they do, the design has drifted.

**Fable needed?** No. Correctness-critical engine work: Opus, High,
single-agent.

## Deliberately untouched this round

Raydium `destinationKind` near-miss · owner-user fragmentation · layer-6 edge
case · transaction history · EVM · Promise/Risk · UI · the Windows test bug.

### Standing boundaries

- Never weaken SSRF, whitelist a reserved range, or special-case a domain.
- No VPN toggling inside a process; no VPN brand in domain logic.
- No second orchestrator, no second work queue, no second Proof pipeline.
- D-128 stays a bounded capability; the product path reuses it, never copies it.
