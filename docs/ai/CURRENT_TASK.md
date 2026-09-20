# Current task

> Overwrite this file each round. Never append.

## RESULT PRESENTATION V1 — ONE RESULT, SIMPLE SURFACE (awaiting Founder visual review)

Acquisition, search, recovery, budgets, Evidence/admissibility, verdict and
confidence semantics, Pattern data: untouched. $0, no live Research. The
completed result was redesigned around six sections (answer, research
table, proof map, key evidence, what is not established, full evidence &
audit) so a serious user understands the answer in 5–20 seconds.

### What changed

- `src/client/result-surface.ts` — the pure surface model: status
  vocabulary, boundary kinds (technical / configuration / substantive from
  `proofs.bounded_by`, legacy fallback from reason codes + coverage), the
  research table (projection rows + paper-vs-reality rows, supporting
  checks folded as chips), the proof chain, key evidence, the boundary
  groups, the 2–4 sentence answer, freshness, on-chain translation,
  `FORBIDDEN_SURFACE_TOKENS`.
- `src/client/components/research-result.tsx` — the one component; inline
  evidence inspection (row → evidence cards → details), no navigation.
- `app/(app)/research/[id]/page.tsx` — renders it when finished; live
  state unchanged. `result-first-screen.tsx` and its test removed.
- `app/(app)/dev/result-states/page.tsx` + `result-surface-fixtures.ts` —
  eight invented states, production-gated.
- `services/proof-view.ts` / `client/api.ts` — `boundedBy` on the Proof
  read model (copied, nullable).
- Vocabulary unified at the source: Confirmed / Partially confirmed / Not
  established / Contradicted (`research-model.ts`, `result-blocks/types.ts`).
- Tests: `tests/ui-result-surface-v1.test.ts` (30: status mapping, the
  three boundary kinds incl. legacy fallback and both real Aave shapes,
  projection rows and order, evidence linkage, no excluded evidence on
  the first screen, freshness, on-chain translation, no raw codes / JSON,
  contradiction preserved, confirmed never manufactured, failed run,
  structure); 11 older suites re-pinned to the component and vocabulary.

### Verified ($0)

- Presentation + projection-safety + Round 9/12/13 set: 25 files, 548
  passing. `npx tsc --noEmit` clean; lint 0 errors.
- Screenshots (390×844 and 1120 wide) of all eight fixture states and
  both persisted Aave results on the running dev server: every page
  renders, no console errors (the Next dev overlay's hydration note on
  the Telegram `<html style>` is pre-existing).
- Full suite not rerun: no shared production behaviour outside the
  presentation helpers and the Proof read model changed.

### Founder review — open these (dev server on :3000, dev auth bypass)

- http://localhost:3000/research/cbe59f48-edbd-4153-b5e6-dc2082c9e105 — the
  persisted Aave result (documentary checks excluded as inadmissible,
  execution outside supported routes, two on-chain partials).
- http://localhost:3000/research/2b0f00e4-b736-4e57-8b35-b77bb6ee7ced — the
  earlier Aave run (search-limit bounded everywhere).
- http://localhost:3000/dev/result-states?state=1 … 8 — the eight states.

STOP here until the Founder approves the surface. No live batch before.
