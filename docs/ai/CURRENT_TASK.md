# Current task

> Overwrite this file each round. Never append.

## C2 — MINIMAL RELIABILITY FIX: EVIDENCE-STATE RECOVERY ELIGIBILITY AND ROUTE EXPLORATION ACCOUNTING

Founder decision 2026-09-20: C1 DEFERRED (no search-budget or envelope
change); C2 APPROVED only for the two verified bounded completion/recovery
defects. Offline, $0, no live Research, no UI, no project-specific logic,
no new terminal state, no schema change. Verdict, confidence, freshness,
admissibility and Proof-layer rules untouched.

### What changed (three source files, one new test file, one report split)

- `src/server/engine/controller.ts` — on a targeted pass
  (`targetedRecovery` set) the pending set and the job-locked claim are
  gated by the one-recovery maximum (`maxAttempt <= 1`) instead of by the
  first attempt's technical status (`succeededKeys`). A critical component
  whose first attempt SUCCEEDED technically but whose Evidence S5 excluded
  now gets its one bounded second look; a component that already has an
  attempt numbered above 1 is never claimed again, even on a redelivered
  scoped cycle. First-pass behaviour is unchanged.
- `src/server/engine/acquisition-ledger.ts` — `exploredRoutesByComponent`
  (`step:component` → domains) from SEARCH_EXECUTED rows that are status
  OK, carry a spent unit (`budget_amount` > 0), are attributed to a
  component and use the code-owned `site:<domain>` form
  (`routeScopedQueryDomain`); `routeExploredForComponent(...)`.
- `src/server/engine/targeted-recovery.ts` — ROUTE_UNEXPLORED is not
  planned for a route this component's scoped search already ran against
  and answered, zero results included. FAILED / SKIPPED / replayed / other
  component / other host never count.
- `tests/benchmark-economics-reliability-v1.test.ts` — the REPORT splits
  the C2 audit count into "no recovery ever ran for the node" (the defect)
  and "paths left after the one bounded recovery" (the ceiling by design).
- `tests/targeted-recovery-eligibility-c2-v1.test.ts` — 10 pins: A (first
  attempt SUCCEEDED, Evidence stale, sealed route documents unread →
  recovery runs, resolves on fresh Evidence only, stale rows stay
  excluded, resolved critical components get no second attempt); A2 (at
  most one recovery even when the recovery closes SUCCEEDED on stale
  Evidence; a re-walk of the same scope claims nothing); B (executed
  scoped search with zero results → route explored, component not
  planned again); provider failure, budget refusal, replay, unconfirmed
  host / other component / unattributed row → route still unexplored;
  end-to-end unphased: no second scoped search of an already-empty route.
  Nine of the ten fail on the pre-fix source (the control case passes by
  construction).

### Verified ($0)

- Benchmark: 161 passing; 672/672 critical nodes attempted; second pass
  in 69 runs (63 before); technical boundary on a critical node in 3 runs
  (EXECUTION_EVIDENCE, CHAIN_EARLY, NO_ADMISSIBLE_ROUTE — configuration
  boundary); CRITICAL 0; MAJOR 0; S5 parity phased = unphased. Search
  calls over the matrix 1718 → 1699; avg modelled cost $0.185 → $0.186.
  Audit "unexplored at finalize" 48 → 28; ROUTE_UNEXPLORED 0; nodes with
  no recovery attempt 0; the 28 are residue after the one bounded
  recovery (SEALED_UNEXTRACTED / UNOPENED_CANDIDATE beyond its 3-open /
  3-extraction bound), i.e. the one-recovery maximum the Founder kept.
- Targeted suites (targeted-second-pass, eligibility-c2, boundary record,
  acquisition-phases, site-local expansion, D-152 ledger, founder
  semantics 5.5, adversarial round 3 DB, s10 closure, phased replay
  regression, memory adoption ×2, perf parity, Round 12/13 ×4): 17 files,
  201 passing.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors.
- Full suite, run alone: 5192 passing, 4 skipped, 4 failing (5200, 250
  files, 2230 s). Three are the known pre-existing catalog / renderer
  cases. The fourth, `research-memory-controlled-reuse-acceptance-v1`,
  pinned exactly one attempt per component; its fixture facts carry no
  publication date, so CURRENT_STATE closes MISSING_CURRENT_STATE after
  a completed attempt with sealed route pages unread — the approved
  change now gives it one paths-only recovery (proposer 1, search 1,
  fetch 1, extract 1 + 3) in the fresh, control and Memory Researches
  alike, so every Memory-vs-control comparison holds. Re-pinned with the
  recovery explicit (`recoveryAttemptsOf` = `5:CURRENT_STATE:#2`);
  passes alone after the re-pin.

### Next
- Founder review of the residual 28 (one-recovery ceiling residue); any
  change there is a new decision, not this task.
- Founder-initiated UI rerun of the Aave question under the $0.50 cap
  (not before approval). Jupiter identity still BLOCKED.
- Any other environment running the phased workers needs 0055/0056
  applied first.
