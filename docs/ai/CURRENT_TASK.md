# Current task

> Overwrite this file each round. Never append.

## NONE — D-136 Slice 2 implemented and proven offline: phase queues and worker roles

Offline round. No live HTTP, no RPC, no browser, no model call.

### What was built

**`src/server/jobs/worker-capabilities.ts`** — the whole of what the domain
knows about deployment: a closed capability set (`SEARCH_EXTRACT`, `FETCH`),
the phase → capability map, and an explicit env var
(`ATLAS_WORKER_CAPABILITIES`). Capability is declared, never discovered: no
DNS, no address, no reachability probe, and an unconfigured process serves
no phase at all.

**`src/server/jobs/queue.ts`** — `research` (SEARCHING, and still the
single-process entry queue), `research-fetch`, `research-extract`; one
payload type carrying `{ jobId }` and nothing else; and
`enqueueAcquisitionPhaseInTx`, the transactional send.

**`src/server/jobs/acquisition-phase-worker.ts`** — the three handlers, the
closed refusal vocabulary (`NOT_FOUND`, `NOT_PHASED`, `PHASE_MISMATCH`,
`JOB_NOT_RUNNABLE`, `CAPABILITY_NOT_CONFIGURED`), `advancePhaseAndEnqueue`
(the atomic handoff), `beginAcquisitionPhases` (phased admission),
`finishPhasedJob` (the same terminal write the single-process path uses) and
`readAcquisitionPhase` (operator visibility). It contains no research
logic — every phase body is one call into Slice 1 or into `run-job.ts`.

**Schema** — `research_jobs.acquisition_phase` (+ `acquisition_phase_at`),
nullable, no default, migration `0035`. NULL means "not a phased job".

**Also touched** — `worker.ts` (dispatch by capability; the legacy path is
reached whenever the job has no phase, unchanged), `owner-alpha-routing.ts`
(the EXTRACTING executor, same admission gate, replay acquisition
providers; `live-executor.ts` itself untouched), `engine/job-contract-view.ts`
(the work-queue derivation lifted verbatim out of `run-job.ts` so the search
phase and the controller cannot drift), `alpha-inspect.ts` (phase section),
`tests/phase1-setup.ts` (creates all three queues).

### What was proven

`tests/d136-phase-queues.test.ts` — 28 tests, all passing, all offline.
Including a real end-to-end: two logical roles, three real pg-boss handoffs,
one admission, one Proof, read back through S9 — with first attempts only.

Backward compatibility was checked against the real dev database, not only
a fresh test one: 42 jobs, 2 Proofs, 415 Evidence rows and 4 sealed
documents survived migration `0035` untouched, with all 42 jobs reading
NULL phase.

### Open finding — an owner decision, deliberately not taken here

`s4-executor` reserves `searchQueries`/`sourceOpens` before every provider
call and cannot tell a replay from a live call, so EXTRACTING charges the
acquisition budget a **second** time for work the earlier phases already
paid for. This is a property of the meter, not of the queues (Slice 1 had it
too, in one process), and it is now pinned by a measuring test. The generic
correction is to teach the executor that a replay performs no external call
— a semantic change to a core file, and therefore an owner decision.

Under `INTERNAL_ALPHA_V1` (12 search queries, 24 source opens) this halves
the effective acquisition ceiling for a phased job. It does not affect
correctness, only how quickly a job reaches its ceiling.

### Not built (and not needed yet)

Deployment tooling, any UI, and any widening of admission. `research_enabled`
and `internal_alpha_enabled` remain false.

### Standing boundaries

- Never weaken SSRF, whitelist a reserved range, or special-case a domain.
- No network product in domain logic; no process changes its own routing,
  and no process infers its own capability.
- Phases are never component attempts; the controller runs once.
- `OWNER_STRICT` sealing keeps its both-ends gate, pinned by test.
- A lossy trace ref is never fetched.
- A phased job must never also carry a single-process entry message.
