# Current task

> Overwrite this file each round. Never append.

## NONE — D-136 ratified; phased-research Slice 1 implemented and proven offline

Offline round. No live HTTP, no RPC, no browser, no model call.

### What was built

`src/server/engine/acquisition-phases.ts` (new) — reusable job-level engine
primitives, all outside the controller:

- `runSearchPhase` — per-component query proposing + search over the job's own
  work queue, persisted as `QUERY_PROPOSED` / `SEARCH_EXECUTED` /
  `CANDIDATE_RETURNED` trace rows. Reserves `searchQueries` on the existing job
  budget. Creates no attempts, no Evidence, no documents, and fetches nothing.
- `loadFetchTargets` — reads the handoff back through `loadAcquisitionLedger`
  (closed operation set, `sequence`-ordered, deduped, lossy refs dropped
  fail-closed), then drops known-dead and already-fetched urls.
- `runFetchPhase` — refuses non-parseable / non-https targets **before** any
  transport call, reserves `sourceOpens`, records `FETCH_ATTEMPTED` /
  `FETCH_FAILED` / `FETCH_OK`, and seals each document with
  `admission: "PRODUCT_ACQUISITION"`.
- `prepareExtractionReplayFetcher` / `prepareExtractionReplaySearch` /
  `prepareExtractionReplayProposer` — replay providers derived from the job's
  own sealed documents and trace rows. The fetcher refuses any url outside the
  sealed set, so extraction structurally cannot reach the network.

`src/server/engine/acquired-documents.ts` — added the closed admission set
`OWNER_STRICT | PRODUCT_ACQUISITION`. `OWNER_STRICT` is the default by omission
and keeps its both-ends gate byte-for-byte. `PRODUCT_ACQUISITION` means only
"this bounded-transport document may be sealed for later extraction": it is not
OFFICIAL_DOCS, not CONFIRMED authority, not identity, not Evidence, not truth,
not claim support, and a successful fetch never upgrades authority.

### What was proven

`tests/acquisition-phases.test.ts` — 14 tests, all passing. One job goes
SEARCHING → persisted candidate handoff → FETCHING → sealed documents →
EXTRACTING via replay providers → the real `runS4ResearchJob` → S5 → S6 → S7 →
S8 Proof, with **first attempts only** and `reservedRecoverySteps` untouched.
Plus: query dedup, lossy-ref exclusion, already-fetched exclusion, non-https
refused pre-transport, `OWNER_STRICT` unchanged, `PRODUCT_ACQUISITION` granting
no authority, a failed phase fabricating no Proof, and a boundary test that the
phase module names no VPN / MantaRay / proxy / vendor.

`controller.ts`, `s4-executor.ts`, S5, S6, S7, S8, S9: unchanged.

### Property worth remembering

A phase must cover **every** component the controller will later process.
Cover one component only and the rest legitimately have nothing to replay —
correct behaviour, and why the search pass takes the controller's own work
queue (derived exactly as `run-job.ts` derives it) rather than an ad-hoc list.

### Slice 2 (justified, not started)

`research-fetch` and `research-extract` queues; the two worker roles; the
`research_jobs.acquisition_phase` column + migration with transactional
advance-and-enqueue; per-process capability configuration; phase visibility in
`alpha-inspect`. Deployment decides which process has which network; no process
changes its own routing.

### Standing boundaries

- Never weaken SSRF, whitelist a reserved range, or special-case a domain.
- No VPN brand in domain logic; no process changes its own routing.
- Phases are never component attempts; the controller runs once.
- `OWNER_STRICT` sealing keeps its both-ends gate, pinned by test.
- A lossy trace ref is never fetched.
