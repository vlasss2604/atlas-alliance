# Research Core — Final Validation Panel V1 (FROZEN, preparation only)

Prepared 2026-09-15 at HEAD `9a483c5`, after LIVE RESEARCH MEMORY V1 = PASS
(Lido A2-next `1a326f54` → B `58952f45`). Nothing in this file has been run.
No provider call was made to prepare it; every number below comes from
persisted `atlas_dev` traces or from code.

The panel tests the Research Core, not the answers. A scenario PASSES when
identity, acquisition, authority, source-class handling, the on-chain /
documentary separation, temporal semantics, reducer behaviour and the Proof
boundary are correct — whatever the verdict is. SUPPORTED, PARTIALLY_SUPPORTED,
INSUFFICIENT_EVIDENCE and CONTRADICTED are all acceptable outcomes.

## 0. Facts the panel is built on (verified from code / atlas_dev)

- Live allowlist (`live-executor.ts`): `pump_fun`, `raydium`, `morpho`, `lido`.
  Any other project needs a Founder-approved one-line membership change.
- Live alpha-run classifies the question with the **non-live fake
  interpreter** (`interpreter/fake.ts`): every question naming a known asset
  becomes `DEEP_RESEARCH` with `normalized_intent = PROTOCOL_REVENUE_TO_TOKEN`
  (PRT-1 / PRT-2). Known assets: Pump.fun, Raydium, Morpho, Lido,
  Hyperliquid, Uniswap, Aave, SUI, TAO, Bitcoin. The full 10-component Pattern
  v3 runs regardless of intent, so component-level semantics (NET_EFFECT,
  CURRENT_STATE, governance lifecycle, EXECUTION_EVIDENCE …) are exercised by
  every scenario; only the S7 requirement set is fixed to PRT.
- On-chain environments: `solana/mainnet` (TOKEN_SUPPLY, ACCOUNT_INFO,
  token accounts, signatures, TRANSACTION_DETAIL, burn detection, supply
  delta, subject promotion) and `ethereum/mainnet` (**TOKEN_SUPPLY only**;
  account/transaction intents are refused by `supports()` and fall to the
  documentary path).
- Confirmed state in atlas_dev: Lido (ETH identity, 2 OFFICIAL_DOCS routes,
  VERIFIED Proof `7c7b688c`, ACTIVE Memory FLOW_PATH `dec46015` +
  MECHANISM_SPEC `d27b5a5c`); Raydium (SOL identity, 2 OFFICIAL_DOCS routes,
  2 approved resources); Pump.fun (SOL identity, 2 OFFICIAL_DOCS routes,
  1 approved resource); Morpho (**no identity, no routes**, one orphaned run).
- Only Lido holds a VERIFIED Proof → no second project can seed a Memory
  repeat today (see §4).
- Budget envelope per run: INTERNAL_ALPHA_V1 = 12 searches / 24 opens /
  $2.00 model cap / 900 s. Not to be raised.

## 1. The panel (7 scenarios: 3 Solana, 3 EVM, 1 Memory repeat; 4 holdouts)

Frozen questions are verbatim. Token addresses and route hosts marked
**(owner confirms)** are NOT verified here and must be established through
`confirm-project-identity.ts` / `confirm-source-route.ts` +
`classify-source-route.ts` by the owner before the scenario runs.

### S1 — Raydium buyback vs burn (Solana, KNOWN)
- Project / network: Raydium (RAY) / solana-mainnet. Identity + routes exist.
- Question: **"Does Raydium currently buy back RAY with protocol fees, and is any of the bought-back RAY burned or otherwise removed from circulating supply?"**
- Intent (fake interpreter): PROTOCOL_REVENUE_TO_TOKEN; components that matter: SOURCE_OF_VALUE, DESTINATION, RECIPIENT, EXECUTION_EVIDENCE, NET_EFFECT, CURRENT_STATE.
- Documentary: docs.raydium.io `/ray/ray-buybacks.md`, `/ray/protocol-fees.md` (OFFICIAL_DOCS, confirmed), 2 approved resources.
- On-chain: RAY TOKEN_SUPPLY; documented buyback account → ACCOUNT_INFO → token accounts → signatures → TRANSACTION_DETAIL / burn detection; historical supply interval reuse from earlier Raydium artifacts (origin allowlist).
- Why it earns its place: the one Solana project with the deep promotion chain; asks the buyback ≠ burn boundary explicitly.
- Type: KNOWN (Raydium drove D-146…D-159); the question shape (burn vs buyback net effect) is not the one used for those rounds.
- Failure it exposes: a buyback presented as a burn (SUPPLY_REDUCTION_NOT_ESTABLISHED must stand without a BURN fact); explorer pages bought as chain facts; TOTAL_SUPPLY_DELTA misattributed; entity binding on shared explorers.

### S2 — Pump.fun fee destination (Solana, KNOWN / VARIATION)
- Project / network: Pump.fun (PUMP) / solana-mainnet. Identity + routes exist; `fees.pump.fun` route is confirmed but unclassified (owner may classify).
- Question: **"Where do Pump.fun's trading fees go today, and does any of that fee flow currently reach PUMP holders through a buyback or distribution?"**
- Components: SOURCE_OF_VALUE, FLOW_PATH, DESTINATION, RECIPIENT, EXECUTION_EVIDENCE, CURRENT_STATE.
- Documentary: pump.fun `/docs`, `/pump-token` (OFFICIAL_DOCS); on-chain: PUMP supply, documented fee/buyback accounts through the Solana chain (earlier runs produced 12 artifacts in one job).
- Why: the first live target, re-asked as a fee-destination / recipient question rather than the original value-capture question; the wrong-asset trap (D-132: an unrelated "PPF" ERC-20) lives here.
- Type: VARIATION.
- Exposes: recipient kind mis-stated (passive holder vs treasury), documentary locator admission, D-134 entity binding, transfer ≠ buyback.

### S3 — Jupiter buyback destination (Solana, HOLDOUT — needs enablement)
- Project / network: Jupiter (JUP) / solana-mainnet. **Not in the live allowlist; not in the fake interpreter's known assets; no identity; no routes.**
- Question: **"Does Jupiter use protocol fees to buy back JUP, and where does the bought-back JUP end up — is it burned, locked, or redistributed?"**
- Components: SOURCE_OF_VALUE, DESTINATION, RECIPIENT, NET_EFFECT, DURABILITY_BASIS, GOVERNANCE_BASIS.
- Documentary: Jupiter docs / governance hosts **(owner confirms)**; on-chain: JUP mint TOKEN_SUPPLY, documented buyback/lock accounts via ACCOUNT_INFO promotion.
- Why: a Solana project never used to drive any rule; the mechanism (buyback into a lock, not a burn) puts transfer ≠ buyback ≠ burn and destination-kind on a fresh entity.
- Type: HOLDOUT.
- Exposes: false NET_EFFECT reduction from a buyback; DESTINATION resolved to a lock/treasury rather than "holders"; governance-approved vs live.
- Prerequisites (all zero-spend, all Founder/owner): allowlist entry; **one-line addition to the fake interpreter's known-asset list** (product code — see §8); identity confirmation; route confirmation + classification.

### E1 — Morpho fee switch (EVM, HOLDOUT)
- Project / network: Morpho (MORPHO) / ethereum-mainnet. Allowlisted 2026-09-12; **no identity, no routes** (the one earlier run `a34375ba` died mid-DESTINATION on a session interruption and produced no result).
- Question: **"Does Morpho currently collect protocol fees, and does any of that value reach MORPHO token holders today?"**
- Components: SOURCE_OF_VALUE, MECHANISM_SPEC, GOVERNANCE_BASIS, CURRENT_STATE, DESTINATION, DURABILITY_BASIS.
- Documentary: Morpho docs / governance hosts **(owner confirms)**; on-chain: MORPHO TOKEN_SUPPLY only (EVM adapter scope).
- Why: an EVM project whose value-capture mechanism may be documented but not active — the cleanest test of "absence of a mechanism is a valid finding" and of documented vs approved vs executing.
- Type: HOLDOUT.
- Exposes: false SUPPORTED from a documented-but-inactive mechanism; MECHANISM_CURRENT_STATE / STATE_NOT_FULLY_LIVE handling; NO_ADMISSIBLE_ROUTE vs NO_EVIDENCE_FOUND distinction when routes are missing.
- Prerequisites: identity confirmation (token address **owner confirms**); OFFICIAL_DOCS route (and, if the Founder decides, a GOVERNANCE route).

### E2 — Uniswap fee switch lifecycle (EVM, HOLDOUT — needs enablement)
- Project / network: Uniswap (UNI) / ethereum-mainnet. **Not allowlisted; known to the fake interpreter; no identity; no routes.**
- Question: **"Has the Uniswap protocol fee switch been turned on so that protocol fees currently accrue to UNI holders, or is that still only proposed or approved?"**
- Components: GOVERNANCE_BASIS, MECHANISM_SPEC, CURRENT_STATE, EXECUTION_EVIDENCE, DESTINATION, RECIPIENT.
- Documentary: Uniswap docs + governance forum/portal **(owner confirms)**; on-chain: UNI TOKEN_SUPPLY only.
- Why: the sharpest governance-ladder question available (PROPOSED ≠ APPROVED ≠ IMPLEMENTING ≠ LIVE) on a project that never drove the lifecycle rule.
- Type: HOLDOUT.
- Exposes: PROPOSED_STATE_ONLY / APPROVAL_NOT_ESTABLISHED caps; a governance-portal (CLAIMED) page strengthening a conclusion; temporal semantics of "currently".
- Prerequisites: allowlist entry; identity confirmation; OFFICIAL_DOCS route; **GOVERNANCE route decision (see §7-2)**.

### E3 — Aave buyback destination (EVM, HOLDOUT, optional)
- Project / network: Aave (AAVE) / ethereum-mainnet. **Not allowlisted; known to the fake interpreter; no identity; no routes.**
- Question: **"Does Aave currently use protocol revenue to buy back AAVE, and does the bought-back AAVE go to a treasury or reserve rather than being burned?"**
- Components: SOURCE_OF_VALUE, DESTINATION, RECIPIENT, NET_EFFECT, EXECUTION_EVIDENCE, DURABILITY_BASIS.
- Documentary: Aave docs / governance hosts **(owner confirms)**; on-chain: AAVE TOKEN_SUPPLY only.
- Why: an EVM buyback-to-reserve mechanism, the EVM counterpart of S1/S3, on a project never used for implementation.
- Type: HOLDOUT (optional — include if the Founder wants three EVM scenarios).
- Exposes: buyback ≠ burn on EVM without account-level chain reads (EXECUTION_EVIDENCE must stay INSUFFICIENT / NO_ADMISSIBLE_ROUTE unless an OFFICIAL_REPORT route is confirmed — never SUPPORTED from a forum post).
- Prerequisites: allowlist; identity; routes.

### M1 — Raydium Memory repeat (Solana, MEMORY REPEAT; depends on S1)
- Runs only after S1 has produced a Proof that the owner verifies and after a
  controlled promotion of its safe candidates (verify → OBSERVED → ACTIVE, all
  zero-spend), then `memory_enabled=true` for this one run.
- Question: **"What happens to the RAY that Raydium's protocol fees are used to buy back — is it held, redistributed, or destroyed?"**
- Why: a second question on the same verified mechanism from a different project than Lido, on the Solana chain, so Memory robustness is checked where the on-chain promotion chain also runs.
- Type: MEMORY REPEAT.
- Exposes: Memory suppressing fresh-only work (CURRENT_STATE / NET_EFFECT must stay fresh); adoption of a candidate the new question's routes/identity no longer admit; false lineage forks; confidence uplift from Memory.
- If S1 yields no safely promotable candidate, M1 is dropped and the panel
  records "no second verified project available" — Lido is NOT substituted.

## 2. What each scenario exercises (existing paths only)

| Scenario | Chain | Type | On-chain path | Documentary path | Memory |
|---|---|---|---|---|---|
| S1 Raydium | Solana | KNOWN | supply + account chain + burn/delta | confirmed docs + seeds | off |
| S2 Pump.fun | Solana | VARIATION | supply + fee/buyback accounts | confirmed docs + seed | off |
| S3 Jupiter | Solana | HOLDOUT | supply + lock/buyback accounts | to be confirmed | off |
| E1 Morpho | EVM | HOLDOUT | TOKEN_SUPPLY | to be confirmed | off |
| E2 Uniswap | EVM | HOLDOUT | TOKEN_SUPPLY | to be confirmed (+ governance decision) | off |
| E3 Aave | EVM | HOLDOUT (optional) | TOKEN_SUPPLY | to be confirmed | off |
| M1 Raydium repeat | Solana | MEMORY REPEAT | as S1 | as S1 | on (this run only) |

Every scenario also exercises: route-aware skip (`NO_ADMISSIBLE_ROUTE`),
bounded search finalization (`SEARCH_BUDGET_EXHAUSTED`), compact extraction
retry, documentary candidate continuation, explorer-open rule, seeds, D-152
component-scoped replay, S5 v3 reducer, S6 assembly, S7 PRT, S8 Proof.

## 3. Cost preparation (from persisted traces; no provider call)

Reference runs under the current code (Lido, 10 components, alpha
envelope): `58eeba58` $0.270 (25 model calls), `1a326f54` $0.396 (29 calls),
`58952f45` with Memory $0.297 (24 calls). Older Solana runs ($0.02–0.11) were
budget-limited early under earlier code and are not representative; under
current code a Solana run reads a similar number of documents plus 2–12 RPC
reads (the RPC endpoints are on existing plans; not metered in the trace).

| Scenario | Searches | Model calls | RPC reads | Model spend (min / expected / upper) |
|---|---|---|---|---|
| S1 Raydium | 11–12 | 22–30 | 4–12 | $0.25 / $0.35 / $0.50 |
| S2 Pump.fun | 11–12 | 22–30 | 4–12 | $0.25 / $0.35 / $0.50 |
| S3 Jupiter | 11–12 | 22–30 | 2–8 | $0.25 / $0.35 / $0.50 |
| E1 Morpho | 10–12 | 20–28 | 1–2 | $0.20 / $0.32 / $0.45 |
| E2 Uniswap | 10–12 | 20–28 | 1–2 | $0.20 / $0.32 / $0.45 |
| E3 Aave (optional) | 10–12 | 20–28 | 1–2 | $0.20 / $0.32 / $0.45 |
| M1 Raydium repeat | 9–11 | 18–26 | 4–12 | $0.20 / $0.30 / $0.45 |

- Minimum live panel cost (6 core scenarios, no E3): **≈ $1.35**
- Expected (6 core): **≈ $2.00**; with E3: **≈ $2.30**
- Conservative upper bound (7 scenarios, each at its upper): **≈ $3.30**
- Hard system bound: $2.00 model cap per run × 7 = $14.00 (never approached; not the planning number).

Per-scenario stop: a run whose actual model cost exceeds $0.50 is reported
before the next scenario is launched.

## 4. Memory scenarios — honest state

Only Lido holds a VERIFIED Proof and ACTIVE Memory. The panel deliberately
does not re-run Lido. A second safe project exists only after S1 (Raydium) is
verified and promoted by a human; M1 depends on that and is dropped otherwise.
Memory acceptance is complete; M1 is a robustness check (Solana, different
question wording), not a development phase. Lido's ACTIVE rows stay in place
and are simply not retrieved by any panel scenario (different projects).

## 5. Recommended execution order and batches

1. **First live batch (smallest):** E1 Morpho (after identity + route
   confirmation) and S1 Raydium — one EVM holdout and one Solana known
   scenario, ≈ $0.70 expected. Both are already allowlisted.
2. S2 Pump.fun.
3. Owner verifies S1's Proof, promotes safe candidates → M1 Raydium repeat
   (`memory_enabled=true` for that run only, reset after).
4. E2 Uniswap (after allowlist + identity + routes + governance decision).
5. S3 Jupiter (after allowlist + known-asset entry + identity + routes).
6. E3 Aave (optional).

Between scenarios: audit persisted results before launching the next one; do
not rerun the whole panel; a MAJOR generic defect is diagnosed offline and only
the affected scenario is rerun after a fix, with new approval.

## 6. Stop conditions

- **CRITICAL (stop the panel):** wrong project/entity or chain/token bound;
  a false SUPPORTED; inadmissible Evidence admitted as establishing;
  Proof/verdict/confidence leakage between jobs; a technical failure
  reported as project reality; Memory suppressing fresh-only work.
- **MAJOR (pause, diagnose offline, rerun only that scenario after a fix):**
  an available capability path missed (e.g. a confirmed route never searched,
  an admitted locator never read); a generic acquisition/reducer defect;
  an incorrect component reason; a material branch/provenance failure.
- **MINOR (record, continue):** ranking inefficiency, extra calls without
  semantic damage, presentation, non-material diagnostics.
- Operational: transport unhealthy at the pre-run probe (any provider
  unreachable, or a tunnel flap inside the last 5 minutes) → wait, do not
  launch; a scenario above $0.50 actual → report before continuing; the
  cumulative panel spend above the approved cap → stop.

## 7. Founder decisions needed BEFORE live

1. **Intent classification.** With the fake interpreter every scenario is
   evaluated at S7 as PROTOCOL_REVENUE_TO_TOKEN. Options: (a) accept — the
   panel validates component semantics and Proof bounding, not intent-specific
   requirement sets; (b) approve the live Anthropic Interpreter for the panel
   (a §1 provider-approval change plus alpha-run wiring); (c) approve an
   owner-only `--intent` override in alpha-run (small, auditable). Without a
   decision, option (a) is what the panel would do.
2. **GOVERNANCE as a route-only class.** Today snapshot.org-class portals
   classify GOVERNANCE without a route (officiality CLAIMED). For E2 (and any
   governance-ladder question) decide whether to confirm a GOVERNANCE route on
   the project's forum/portal, or to make GOVERNANCE route-only (semantic
   change, separate task). Either way, no result may be strengthened by a
   CLAIMED governance page — the reducer already caps it.
3. **Allowlist membership** for Jupiter, Uniswap (and Aave if E3 is kept) —
   one line each in `live-executor.ts`, approval only.
4. **Identity + route confirmations** for Morpho, Jupiter, Uniswap (Aave):
   owner-run scripts with owner-verified addresses/hosts; none is asserted
   here.
5. **M1 gate:** human verification + controlled promotion of S1's candidates
   is itself a decision point; the panel must not auto-promote.

## 8. Capability work that could exclude a scenario

- **S3 Jupiter:** the fake interpreter does not know "Jupiter"/"JUP"; without
  a one-line known-asset addition the question returns CLARIFICATION_REQUIRED
  and no Research is created. That is product code (a fixture list) and is
  the only code change any scenario needs. If declined, drop S3 — the panel
  then has no Solana holdout (S1/S2 are KNOWN/VARIATION) and should say so.
- **EVM scenarios:** account-level chain reads are not implemented for EVM;
  EXECUTION_EVIDENCE / RECIPIENT on EVM can only come from documents. This is
  a known scope boundary, not a reason to exclude; expect NO_ADMISSIBLE_ROUTE
  or documentary-only results there and judge them on correctness.
- No scenario requires a new domain, agent, planner or subsystem.

## 9. Latency capture (record only; no optimization in the panel)

Everything below is already persisted or derivable; the live panel records it
per scenario from `research_jobs`, `research_attempts` and
`research_trace_events` timestamps:

- Total Research duration: `finished_at − started_at`.
- Per component: `research_attempts.completed_at − created_at`.
- Query proposal: `MODEL_CALL_ATTEMPTED` (QUERY_PROPOSE) rows — gap from
  attempt start to the row; model-side `actual_*_tokens`.
- Search: `SEARCH_EXECUTED` row timestamps (per query), including refused
  (`SKIPPED`) rows.
- Fetch/open: `FETCH_ATTEMPTED → FETCH_OK/FETCH_FAILED` gaps, split by
  provider (`safe-http`, `isolated-render`, `acquired-document-replay`).
- Extraction: `EXTRACT_ATTEMPTED → MODEL_CALL_ATTEMPTED (EXTRACT)` gaps,
  with compact retries counted separately.
- On-chain: `FETCH_ATTEMPTED` rows with the RPC provider name and the
  `onchain_artifacts.retrieved_at` stamps.
- S5–S8 / finalization: `finished_at − max(research_attempts.completed_at)`;
  question projection `research_question_projections.created_at − finished_at`.
- Wall-clock per phase and the count of transient retries/waits, to separate
  provider latency from ATLAS orchestration.

## 10. Status

Preparation only. No scenario has been run, no credit spent, no product
semantics changed. Tree is clean apart from this document.
