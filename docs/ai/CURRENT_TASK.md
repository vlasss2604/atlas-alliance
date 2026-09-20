# Current task

> Overwrite this file each round. Never append.

## RESEARCH RELIABILITY V1 — ACQUISITION PARITY, BOUNDARY RECORD, SITE-LOCAL EXPANSION, TARGETED SECOND PASS, CRITICAL PROOF PATHS, BENCHMARK

Offline, $0 spend (no Anthropic, Brave, RPC or live Research). No verdict,
admissibility, lifecycle, Memory, confidence or Proof-layer rule changed.
Two additive, nullable migrations (0055 `proofs.bounded_by`, 0056
`research_jobs.acquisition_scope`), applied to `atlas_dev` this round
(`DATABASE_URL=… npm run db:migrate`; the script does not read
`.env.local` on its own).

### What this round closed (the last open item of the task)

The permanent benchmark (`tests/benchmark-economics-reliability-v1.test.ts`,
10 scenario families × 12 adversarial variants unphased + 4 phased, S5
parity between the runtimes) had ten failures left, all in the
SITE_LOCAL_ONLY variant: the unphased walk missed an official page that
the phased pipeline found. Cause, read from the trace of S03: the
bounded site-local expansion ran inside MECHANISM_SPEC's own attempt,
ranked the index's links by overlap with the whole question, and the
four slots went to pages of LATER components (their search had not run
yet, so they were unknown and competed); in the phased FETCH phase those
pages were already known and only the two hidden ones competed. Where in
the walk the index was read decided which page a component got.

Generic rule now (`site-local-expansion.ts`): links are ranked PER
component against that component's own vocabulary (its name and its
evidence goal, each term weighted by 1 / the number of components whose
vocabulary carries it — the rule the targeted second pass already used
for its paths, now one shared helper); every pending component (critical
first, step order) takes its ONE best page when the match is worth at
least one term unique to it (`MIN_SPECIFIC_FOR_PICK`); the route cap
(`MAX_SITE_LOCAL_PER_ROUTE`) bounds only the task-overlap fill. Component
picks are bounded by the work queue, so the admitted set no longer
depends on walk position. Each admitting component's CANDIDATE_RETURNED
rows are recorded in its own relevance order, and an unphased attempt
appends the candidates in its own order, so the +1 continuation opens
the page most relevant to the component that read the index. The
executor passes its walk position (`pendingComponents`, `forComponent`).

### What the full suite then showed, and what changed for it

The uncommitted work had never been run against the whole suite. Nine
files failed; six were consequences of B2/B3 on pinned semantics:

- `component-reconciliation-store.ts` — a document-local boundary
  (EXTRACTION_NOT_COMPLETED) now outlives a later attempt that closes
  without Evidence and without a boundary of its own; the targeted second
  pass reads OTHER documents and never the failed one, so "read, not
  inspected" (Round 5.5, decision C) stays truthful. Pinned by the
  existing `founder-semantics-round5-5-v1` B5/B6/B6b/C1/C4; C3 re-pinned
  to the three extra extractions the second pass makes on sealed
  documents (and given a 120 s timeout: three full Researches).
- `adversarial-core-round3-db-v1` G3 — run 1 now spends the in-process
  recovery attempt (#2); the retry's recovery is #3.
- `s10-final-pre-smoke-closure` A — pinned under a zero recovery reserve
  (`budgetAtStart.reservedRecoverySteps = 0`): with a reserve the first
  pass closes bounded before the hard ceiling by design.
- `research-memory-adoption-hardening-v1`, `research-memory-evidence-adoption-v1`
  — source pins on the phase worker's `items:` updated to the scoped
  expression (both branches still derive from adoption).
- `pattern-semantic-drift-activation-v1` F — the stored atlas_dev v2
  content is now drifted on the D-159 class change PLUS the eight
  `criticalComponents` entries (B3 is Pattern data; see CURRENT_STATE:
  activation is an owner act).

Pre-existing, not touched: `phase1` (1) and `phase2` (6) pin a
four-project seed catalog, while the catalog has carried `jupiter` and
`aave` since commit dca81ae (eight rows); `renderer-launch-diagnosis`
"corrupt browser binary" expects EXECUTABLE_NOT_FOUND and gets
PROCESS_START_FAILED on this machine. Both reproduce in isolation.

### Verified

- `tests/site-local-expansion-v1.test.ts` — 14 passing, including the
  new per-component pins (mid-walk vs pre-walk admit the same hidden
  pages; a shared term never makes a page one component's; one pick per
  component; the task rule under the cap unchanged without components).
- `tests/targeted-second-pass-v1.test.ts`, `tests/acquisition-phases.test.ts`,
  `tests/research-boundary-record-v1.test.ts` (journal pin now finds
  0055 by tag; 0056 appended after it) — passing.
- Benchmark: **161 passing** (160 runs + report), no CRITICAL, no MAJOR,
  S5 parity phased = unphased on every phased variant. Report table
  (`ATLAS_BENCH_REPORT_PATH`): critical nodes attempted 672/672; runs
  needing the targeted second pass 63; runs finalizing with a technical
  boundary on a critical node 3 — all three EXECUTION_EVIDENCE under
  CHAIN_EARLY on NO_ADMISSIBLE_ROUTE, a configuration boundary (no
  confirmed OFFICIAL_REPORT/ONCHAIN route in the fixture project), not a
  path left unread; avg modelled cost $0.185/run, avg modelled latency
  26.3 s (structural estimates from fixture call counts, not live).
- `npx tsc --noEmit` clean; `npm run lint` 0 errors (the remaining
  warnings are pre-existing unused eslint directives in older tests).
- Full suite, run alone after every change above: **5183 passing, 4
  skipped, 3 failing** (5190) — the three are the pre-existing catalog
  and renderer cases named above and in CURRENT_STATE (Repository).

### Pattern activation (Founder decision, 2026-09-20)

`atlas_dev`: v3 ACTIVE (fingerprint `1023fb72a10e7f85`) drifted from the
code contract (`9324e5574a2331cd`) on exactly the eight
`criticalComponents` entries; `activate-pattern-version.ts --apply`
retired v3 (content unchanged) and inserted **v4 ACTIVE**. Verified after:
one ACTIVE row; the planning read (`loadActivePatternVersion` → 4, parsed
through `patternContentSchema`) yields the critical components for the
eight Economics intents and none for UNKNOWN / SCENARIO_CAUSAL_IMPACT /
CLAIM_FACT_CHECK; research_jobs (110), proofs (53), research_plans (86),
project_memory_items (48), evidence (1634), research_component_results
(644), research_claim_support (67) and the v1–v3 rows fingerprint
identical before and after — no Lido / Raydium / pump.fun / Aave record
rewritten. No live Research, $0.

The benchmark gained C1/C2 decision columns (search-bounded critical
nodes on the first pass with their final status; the envelope reserved at
finalize; unresolved critical nodes with a known admissible path still
unexplored at finalize, read through `planTargetedRecovery(…, { audit:
true })` — a measurement flag that only lifts the one-recovery gate and
runs nothing). See CURRENT_STATE for the C1/C2 data.

### After activation — verified, $0

- Regression set (every test importing plan-job, pattern-activation or
  active-pattern, plus the reliability suites): 64 files, 945 passing.
- Benchmark on the code contract (= v4, fingerprint verified): 161
  passing; 672/672 critical nodes attempted; 63 runs used the second
  pass; 3 runs finalize on a configuration boundary (EXECUTION_EVIDENCE,
  CHAIN_EARLY, NO_ADMISSIBLE_ROUTE). C1/C2 data: CURRENT_STATE.

### Next
- Founder decision on the two C2 changes proposed in CURRENT_STATE (not
  implemented).

- Founder review of the Research Reliability V1 semantics in CURRENT_STATE.
- Any other environment running the phased workers needs 0055/0056
  applied first: the phased runtime reads `research_jobs.acquisition_scope`.
- Then the Founder-initiated UI rerun of the Aave question under the
  $0.50 cap (not before approval). Jupiter identity still BLOCKED.
