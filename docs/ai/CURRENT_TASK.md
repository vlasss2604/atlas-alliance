# Current task

> Overwrite this file each round. Never append.

## BOUNDED SEARCH FINALIZATION + ROUTE-AWARE ACQUISITION V1 (done this round)

Offline round. Two Founder-approved semantics (2026-09-15). No live/API/RPC
call, no rerun, no Memory change, no budget change, no schema change.

**1. Search-budget exhaustion finalizes boundedly.** `s4-executor.ts`: the
search axis no longer throws. Allowance 0 → proposer skipped
(`SEARCH_QUERY_BUDGET_EXHAUSTED`, amount 0), no query; a mid-attempt refusal
→ recorded, search stage ends, paid candidates still read; close
`SKIPPED / SEARCH_BUDGET_EXHAUSTED` when nothing was established. Job
finalizes WORK_QUEUE_EXHAUSTED on the ordinary path. Model-cost and
source-open denials unchanged (still thrown).

**2. Route-aware documentary acquisition.** `documentaryReachability`
(`acquisition-targeting.ts`) over `CONFIRMED_ROUTE_ONLY_CLASSES`
(`source-authority.ts`: OFFICIAL_DOCS, OFFICIAL_REPORT). Unreachable
component → no proposer, no search, no fetch, close
`SKIPPED / NO_ADMISSIBLE_ROUTE`; seeds still read; mixed components keep
their reachable class; phased search phase applies the same rule.

**S5.** New reason codes `SEARCH_BUDGET_EXHAUSTED` / `NO_ADMISSIBLE_ROUTE`
at the zero-Evidence return only, read off the latest attempt
(`acquisitionBoundaryFromAttempt`); confidence cap = NO_EVIDENCE_FOUND;
UI short forms added.

Tests: `tests/bounded-search-finalization-v1.test.ts` (new, 15);
phase6-s4-executor / s10-final-pre-smoke-closure / post-raydium-cleanup /
acquisition-graceful-degradation updated to the approved semantics.

### Next

- GOVERNANCE route-only: DECIDED (Round 5.5, Founder decision A) — GOVERNANCE
  is NOT globally route-only. snapshot.org-class pages still classify
  GOVERNANCE without a route; an unrouted governance document is admitted
  only when project binding is strong (confirmed project name, canonical
  slug, or confirmed token contract / mint — never the bare ticker). See
  `RESEARCH_CORE_HARDENING_V1.md` and `CORE_RULES.md` ("Same ticker ≠ same
  project").
- With new approval: ONE A2-next + ONE B.
