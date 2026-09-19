# Current task

> Overwrite this file each round. Never append.

## AAVE LIVE ACCEPTANCE — POSTMORTEM, TWO GENERIC FIXES, ONE RESULT OBJECT

Offline, $0 spend (no Anthropic, Brave, RPC or live Research). Semantic
core hardening stays complete; no verdict, admissibility, lifecycle,
Memory, confidence or Proof rule changed. Migrations through 0054 are
applied to `atlas_dev`.

### What failed (job `2b0f00e4`, the first Founder-initiated UI Research)

Interpreter: READY / DEEP_RESEARCH / Aave / PROTOCOL_REVENUE_TO_TOKEN
(0.95). SEARCH phase: 10 proposer calls, 13 queries, 12 searches (all of
the envelope), 60 candidates — none of them `aave.com/docs/ecosystem/aave`,
because the proposer saw only project + step + component and proposed
label-restating queries. FETCH phase: 19 opens, 16 sealed (3 failed).
EXTRACTING phase: every documentary component MODEL_CALL_SKIPPED
(SEARCH_QUERY_BUDGET_EXHAUSTED) → attempt SKIPPED / SEARCH_BUDGET_EXHAUSTED;
zero EXTRACT_ATTEMPTED rows; the only Evidence is two TOKEN_SUPPLY reads
(CURRENT_STATE, NET_EFFECT → PARTIALLY_SUPPORTED / INSUFFICIENT_AUTHORITY);
S7 PRT-1/PRT-2 UNSATISFIED; Proof INSUFFICIENT_EVIDENCE confidence 20;
actual model cost $0.066 (proposer only), 42 s wall.

### What changed

- `src/server/engine/s4-executor.ts` — the spent-search-axis close applies
  to a METERED gateway only; a replay is bounded by what was searched.
- `src/server/engine/acquisition-phases.ts` — the SEARCH phase threads
  `researchTask` / `intent` / `evidenceGoal` into the proposer target.
- `tests/phased-replay-search-axis-regression-v1.test.ts` (new),
  `tests/acquisition-phases.test.ts` (parity pin).
- Result surface: one Research object — `app/(app)/research/[id]/page.tsx`,
  `src/client/components/result-first-screen.tsx` (new: ProofMap,
  KeyEvidence, NotEstablished), `src/client/research-model.ts`
  (PROOF_MAP_STATUS, splitMainLimitation, keyEvidenceFrom, KeyFinding.state);
  `tests/ui-first-screen-v1.test.ts` (new), `tests/ui-verification-tab.test.ts`
  and `tests/ui-result-briefing.test.ts` re-pinned. See CURRENT_STATE.

### Next

- Founder review; then one Founder-initiated UI rerun of the same Aave
  question under the $0.50 cap (not before approval).
- Jupiter identity still BLOCKED (developers.jup.ag and jup.ag carry no JUP
  mint; `vote.jup.ag` is the next candidate, needs host approval).
