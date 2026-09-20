# Current task

> Overwrite this file each round. Never append.

## RESEARCH RELIABILITY V1 — FINAL OFFLINE ACCEPTANCE (boundary invariant)

Founder brief 2026-09-20: verify the 28 residual benchmark cases are
represented as TECHNICALLY BOUNDED research, never mistakable for a
substantive "checked and not established"; prove the technical /
substantive / configuration distinctions at the persisted-record level;
smallest additive fix only where a case reaches the Proof without a
technical marker. $0, no live Research, no UI, no budget or recovery
change.

### What the audit found (benchmark BOUNDARY AUDIT table, pre-fix)

All 29 residual nodes (28 runs) were AMBIGUOUS: first pass SUCCEEDED /
FAILED, recovery closed SKIPPED / NO_TRACEABLE_FACTS_FOR_COMPONENT, S5
STALE_CURRENT_STATE / NO_EVIDENCE_FOUND, 1–6 known paths still open, and
`proofs.bounded_by` carried no technical code — the record read as
substantive. Two more concrete gaps surfaced by the same audit: a
provider failure closes the attempt with a `<LABEL>_FAILED:<Class>` head
the boundary module did not map (read substantive); and the phased FETCH
phase sealed different documents on two runs of identical code at the
24/24 opens ceiling (S05/OFFICIAL_LATE/PHASED), because each in-flight
url reserved its first open after its own async prologue.

### Changes (additive; verdict, confidence, lifecycle, budgets untouched)

- `research-boundary.ts` — technical codes RECOVERY_BOUND_REACHED (the
  one bounded recovery ran, known admissible paths remain) and
  KNOWN_PATHS_UNEXPLORED (paths remain, no recovery ever ran), with
  `remainingPaths` by kind on the entry; provider-failure heads mapped by
  label (`technicalCodeForAttemptHead`: CONTENT_FETCHER →
  SOURCE_UNAVAILABLE, SEARCH_GATEWAY → SEARCH_UNAVAILABLE, QUERY_PROPOSER
  → NO_QUERIES_PROPOSED, EVIDENCE_EXTRACTOR → EXTRACTION_NOT_COMPLETED).
- `targeted-recovery.ts` — `auditRemainingKnownPaths` (the planner in
  audit mode over every component with an S5 row, plus whether its
  recovery ran); the planner's queue parameter narrowed to
  `{ step, component }`.
- `proof-store.ts` / `proof-builder.ts` — the audit read is passed into
  `deriveResearchBoundary` at Proof build (`remainingPaths`, optional).
- `acquisition-phases.ts` — the FETCH phase reserves each url's first
  source open in start order through a per-phase prologue chain (the
  SEARCH phase's existing rule); transport, seal and trace still overlap.
- Benchmark — BOUNDARY AUDIT table and counts; the acceptance assertion
  "ambiguous / no boundary marker = 0"; the MAJOR-technical rule now
  requires the corpus to carry the fact (`scenario.mustEstablish`): a
  node with no fact ending RECOVERY_BOUND_REACHED is the record telling
  the truth. `onchain-budget-reservation-v1` source pin re-pinned to the
  four reservations against the capped ceiling.
- Tests — `tests/research-boundary-recovery-bound-v1.test.ts` (10):
  recovery exhausted + known paths → RECOVERY_BOUND_REACHED persisted,
  stale finding beside it, verdict/confidence identical with and without
  the marker; projections + DRAFT rebuild leave it byte-identical;
  KNOWN_PATHS_UNEXPLORED / zero paths / SUPPORTED derivation; substantive
  exhaustion ×2 (no marker, NO_EVIDENCE_FOUND stands); NO_ADMISSIBLE_ROUTE
  configuration boundary (persisted + derivation); provider failure →
  SOURCE_UNAVAILABLE (end to end + every label); phased FETCH ceiling
  deterministic at concurrency 4 and 1.

### Verified ($0)

- Benchmark (final): 161 passing; 160 runs; critical attempted 672/672;
  second pass 69 runs; unresolved critical nodes at finalize 159, of
  which after a recovery 58; technical bounded marker 33 (3 of them
  configuration-only NO_ADMISSIBLE_ROUTE: EXECUTION_EVIDENCE under
  CHAIN_EARLY S05/S06/S07); substantive exhausted 126; ambiguous 0;
  runs with a technical boundary on a critical node 31; CRITICAL 0;
  MAJOR 0; MINOR not asserted. Two consecutive post-fix runs produced
  byte-identical per-run tables and audit rows.
- Targeted set (boundary, targeted recovery, fetch-phase suites, parity,
  Round 12/13, memory adoption, founder semantics): 32 files, 492 passing.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors.
- Full suite on the final tree, run alone after every test-pin change:
  5203 passing, 4 skipped, 3 failing (5210, 251 files, 2123 s) — the
  three are the known unchanged catalog (phase1 DoD 1, phase2 DoD 6) and
  renderer (EXECUTABLE_NOT_FOUND vs PROCESS_START_FAILED) cases.

### Status

RESEARCH RELIABILITY V1: see the final decision report of 2026-09-20.
Acquisition / reliability work stops here unless a live run reveals a
concrete generic defect. Next phase: Result Presentation / UX (the
projections do not read `bounded_by` yet; no live batch before the
result surface is polished and Founder-approved).
