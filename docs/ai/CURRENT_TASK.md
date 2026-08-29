# Current task

> Overwrite this file each round. Never append.

## NONE — final network-capability orchestration DESIGNED (D-136 proposed, awaiting ratification)

Offline architecture decision. No live call, no DB mutation, no code changed.

## 1. Final interpretation of the network matrix

| capability | env A (probed) | env B (probed) |
|---|---|---|
| Anthropic (interpret / propose / extract) | **works** | 403 |
| Brave Search | **works** (200, results) | timeout |
| Direct first-party fetch (`docs.raydium.io`) | `BLOCKED_ADDRESS` (our SSRF guard, pre-connection) | **works** |

No single environment satisfies search → fetch → extract. The earlier
assumption that search groups with fetch is **refuted by the probe** — search
groups with the model. The two capability groups are:

- **ENV A — model-side:** interpretation, query proposing, Brave search,
  extraction, and everything after it (S5–S9 are DB-only and run wherever the
  extractor runs).
- **ENV B — source-side:** direct document fetch and the isolated renderer
  (the renderer is a fetch mechanism; its egress proxy already assumes B).

ATLAS names these as **capabilities**, never a VPN. Deployment decides which
process gets which network.

## 2. Minimum number of phases: THREE — and this is provable, not chosen

Adjacent stages alternate environments: search (A) → fetch (B) → extract (A).
A∧B is empty on both boundaries, so no two adjacent stages can merge. Two
phases are impossible; four would be invention. **Three phases, but only TWO
environments and TWO worker roles** — the search role and the extraction role
are the same role.

A two-phase *degraded documentary mode* (skip search; fetch only confirmed
routes) remains legitimate as an explicit mode — but it must never become the
only mechanism: the canonical product keeps live discovery, and phase 1 now
gets the **real model proposer**, which the previous design (drafted before
the Brave probe) wrongly assumed unavailable.

## 3. Exact phase boundaries

```
ADMISSION (Next API, env A): interpretation → job → link      [exists today]
PHASE 1 — SEARCHING  (role A): planning → per-component propose + Brave
          search, recorded as today's QUERY_PROPOSED / CANDIDATE_RETURNED
          trace rows. No fetch, no extraction, no attempts.
PHASE 2 — FETCHING   (role B): safe-http/render fetch of the phase-1
          candidates → seal each via persistAcquiredDocument. No model,
          no search, no attempts, no Evidence.
PHASE 3 — EXTRACTING (role A): the NORMAL controller run, unchanged —
          with replay proposer + replay search + replay fetcher over the
          job's own persisted phase-1/phase-2 outputs, and the LIVE
          extractor. Then S5 → S6 → S7 → S8 → S9, exactly as run-job.ts
          already does.
```

The elegance worth noticing: this generalizes D-128's own pattern. D-128
already proved "record one capability's output, replay it later, byte for
byte" for the fetcher. Phase orchestration is the same move applied to each
capability: every phase runs ONE live capability and replays the persisted
outputs of the phases before it.

## 4. Search → fetch handoff: ALREADY PERSISTED — no new table

I expected to need a candidates table. The repository already refused that
once: `acquisition-ledger.ts` derives job-scoped acquisition memory from
`research_trace_events` (`SEARCH_EXECUTED` / `CANDIDATE_RETURNED` / `FETCH_OK`
/ `FETCH_FAILED`), with the explicit rationale "no new table … the audit asked
for the existing persisted state to be reused if it could safely serve, and it
can."

Verified for the handoff specifically:

- `CANDIDATE_RETURNED` rows carry **patternStep, component and the url**
  (s4-executor.ts:1353–1362) — per-component candidate lists are persisted;
- `QUERY_PROPOSED` rows persist the proposed queries the same way;
- `isLossyTargetRef` (trace-store.ts) exists **precisely** for "a consumer
  that wants to reuse a trace value as an actual URL must exclude these
  first" — the reuse rule is already written down;
- trace writes are mandatory (`TracePersistenceError` throws), so the record
  is reliable, and this is S4-side acquisition state, not an S5/S6/S7 join —
  charter-compatible, same category as the ledger.

**Rules:** lossy refs are dropped fail-closed (a redacted or truncated url
must never be fetched); the fetch phase consults the existing ledger so
already-fetched urls are not re-fetched. **Fallback, named now:** if exactness
or volume ever breaks this, a dedicated `research_acquisition_candidates`
table is the correction — but it is not justified today.

## 5. Fetch → extraction handoff: `acquired_documents`, with ONE honest extension

The seal store is the right vehicle — seal, replay, at-most-once consumption
all exist. But `persistAcquiredDocument` today refuses anything that is not a
`CONFIRMED` + classified route (`AUTHORITY_NOT_CONFIRMED`). The product path
researches beyond official docs: search-discovered pages become SOCIAL /
low-authority Evidence, which the schema's own comment anticipates ("Evidence
authority itself is still computed by the production path at extraction
time").

So the store needs an explicit **admission mode**:

- `OWNER_STRICT` (default, today's behaviour byte-for-byte): both-ends
  CONFIRMED authority — the D-128 owner-resume contract, untouched, pinned so
  the owner scripts cannot take the other mode.
- `PRODUCT_ACQUISITION` (new): seals any document the bounded transport
  produced (SSRF, caps, containment all already enforced upstream), records
  the authority snapshot AS RESOLVED (possibly unclassified), and leaves
  Evidence authority to extraction-time `resolveSourceClass` — exactly where
  it is computed today.

This is an extension beside D-128, not a weakening of it: the strict mode
keeps its gate, and the new mode never grants authority — it only records
what was fetched. Consumption stays per-document: marked when Evidence from
that document persists; a document yielding nothing stays resumable.

## 6. Controller / attempt budget — the constraint that shaped everything

`reservedRecoverySteps = 1` per job, and any second attempt on a component key
is a recovery attempt. Therefore **phases must not be component attempts**:

- Phases 1 and 2 run **outside the controller** (like `runMemoryPlanningStage`
  already does) and create **zero** `research_attempts` rows.
- The controller runs **once**, in phase 3 — every component gets its FIRST
  attempt; the recovery pool is untouched; no duplicate work; no premature
  S6/S7/S8, because projection stays exactly where `run-job.ts` has it.
- Budget axes need no change: phases reserve on the same job counters via
  `reserveJobBudget` (`searchQueries` + proposer model cost in phase 1,
  `sourceOpens` in phase 2, extractor model cost in phase 3). The
  `INTERNAL_ALPHA_V1` envelope is unchanged.

`controller.ts`, `s4-executor.ts`, S5–S9: **zero changes.** If any of them
needs a change, the design has drifted.

## 7. Job state machine (smallest closed form)

New column `research_jobs.acquisition_phase`, closed enum
`SEARCHING → FETCHING → EXTRACTING`, advanced transactionally with the
enqueue of the next phase's queue message (no commit — no message, the
existing transactional-enqueue discipline). `job.state` keeps its existing
enum; phases exist only while `RUNNING`. Failure in any phase maps to the
existing terminal vocabulary; re-delivery of a phase is idempotent (ledger
dedup for search/fetch; the controller's own claim discipline for phase 3).
Users see the existing 5-stage `progressStage` — the phase column is
infrastructure and deliberately not the UI field.

## 8. Worker roles

**Two roles, three queues.** `research` (today's name) becomes the phase-1
queue for role A; `research-fetch` (role B); `research-extract` (role A).
Role = which queues a worker subscribes to; environment = where that worker is
deployed. The Next API server needs env A (interpretation) — which it already
demonstrably has. A missing role stalls a phase **visibly** (job sits in a
named phase), and phase must be surfaced in `alpha-inspect`.

## 9. Failure / resume contract

Everything already listed holds by construction: SSRF and authority checks run
in their existing places; sealed docs + exact replay; no raw-text injection
(the only inputs are rows the bounded paths wrote); at-most-once consumption
per document; failed extraction leaves its documents resumable; Evidence
created once, in one job; one Proof per job (DB-enforced); VERIFIED Proofs
immutable (S8 store, unchanged).

## 10. Migration requirements

One enum + one column (`acquisition_phase`), two queue names, one
`acquired_documents.admission` column (default `OWNER_STRICT`). **No data
migration; no Evidence/Proof schema change.**

## 11. Modules likely involved

`jobs/queue.ts`, `jobs/worker.ts` (phase dispatch), a new
`engine/acquisition-phases.ts` (phase-1 search pass + phase-2 fetch pass +
replay providers derived from trace/sealed rows), `acquired-documents.ts`
(admission mode + multi-document replay set), `db/schema/research.ts` +
`acquired.ts`, `alpha-inspect.ts` (phase visibility). Explicitly untouched:
`controller.ts`, `s4-executor.ts`, S5–S9, S8/S9 stores.

## 12. Minimum first implementation slice (offline, no queues yet)

1. Replay providers: `replayContentFetcher` generalized to a job's sealed
   set; replay SearchGateway/QueryProposer derived from the job's own
   `QUERY_PROPOSED`/`CANDIDATE_RETURNED` rows (lossy refs dropped).
2. `PRODUCT_ACQUISITION` admission on the seal store, with the strict mode
   pinned unchanged.
3. Phase-1/phase-2 passes as plain engine functions.
4. One offline test: a job runs pass 1 (fixture search/proposer), pass 2
   (fixture transport → sealed docs), then the NORMAL controller with replay
   providers + fixture extractor reaches S8 — **first attempts only**, proving
   the recovery pool untouched.

## 13. What NOT to build yet

The queues, the worker roles, the phase column, any UI, any deployment
tooling — all after the offline slice proves the engine shape. And nothing
from the standing exclusion list (destinationKind, owner-user identity,
layer-6 edge, EVM, Promise/Risk).

## 14. Risks

1. **Trace-as-worklist coupling** — trace gains an orchestration consumer;
   mitigated by the lossy-drop rule, the ledger precedent, and the named
   fallback table.
2. **Two-role deployment surface** — a mis-provisioned role stalls jobs;
   mitigated by visible phases.
3. **Cross-phase staleness** — D-128's own rule already answers it: replay
   evaluates exactly what was captured; a fresh look is a new acquisition.
4. **Search-budget shape** — reservations move job-level-early; same
   counters, same ceilings, but trace ordering of reservations shifts and
   tests that assume in-execute ordering may need their expectations updated
   (updated, not weakened).
5. **Env B has no model** — a fetch-phase failure cannot consult anything
   smart; it just records typed failures, which is what it should do.

## 15. Proposed D-136 (PROPOSED — not ratified, not in the register yet)

> **D-136 — Network-capability phase orchestration.** A research job may
> traverse up to three closed phases — `SEARCHING`, `FETCHING`, `EXTRACTING`
> — each running exactly one live external capability and replaying the
> persisted outputs of prior phases (the D-128 record-and-replay pattern,
> generalized). Phases are job-level, run outside the controller, and create
> no component attempts; the controller runs once, in `EXTRACTING`, and
> S5–S9 are unchanged. The search→fetch handoff is the existing trace record
> (`QUERY_PROPOSED`/`CANDIDATE_RETURNED`), with lossy target refs excluded
> fail-closed; the fetch→extract handoff is `acquired_documents` under a new
> explicit `PRODUCT_ACQUISITION` admission that records resolved authority
> without granting any — the `OWNER_STRICT` both-ends mode of D-128 is
> untouched and remains the owner-resume contract. Worker roles subscribe to
> phase queues; the domain names capabilities, never a network product; no
> process changes its own routing. One interpretation, one job, one
> controller run, one Proof.

## 16. Final recommendation

Ratify D-136 and build the offline slice (§12) first. The environment-fix
alternative is now **dead, on evidence**: the probe matrix shows no single
environment exists, so the phased design is no longer the fallback — it is
the only architecture that runs the real product path in this environment
without weakening SSRF. The slice is offline, small, and proves the whole
engine shape before any queue or deployment work is spent.

### Standing boundaries

- Never weaken SSRF, whitelist a reserved range, or special-case a domain.
- No VPN brand in domain logic; no process changes its own routing.
- Phases are never component attempts; the controller runs once.
- `OWNER_STRICT` sealing keeps its both-ends gate, pinned by test.
- A lossy trace ref is never fetched.
