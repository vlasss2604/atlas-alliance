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

## 10. Execution readiness (2026-09-15, Founder decisions applied)

Founder decisions: (1) the panel does NOT let the fake interpreter choose the
intent — the owner supplies it explicitly with `alpha-run --intent=<X>`
(commit `5eef1b9`: validated against the code contract's in-scope intents,
recorded on the interpretation row as `owner_intent_override`, printed in
the audit banner, absent from every product path); (2) GOVERNANCE keeps its
existing admissibility; an official governance route may be CONFIRMED only
through the ordinary lifecycle after owner verification; (3) allowlist /
known-asset enablement only AFTER identity is confirmed; (4) M1 stays
conditional on human verification + controlled promotion of S1.

### 10.1 Frozen intent per scenario (existing intents only)

| Scenario | `--intent` | Requirement set (S7) | Intent-required components |
|---|---|---|---|
| S1 Raydium | `VALUE_CAPTURE` | VC-1 SOURCE_OF_VALUE, VC-2 flow SOURCE_OF_VALUE→DESTINATION, VC-3 NET_EFFECT | SOURCE_OF_VALUE, DESTINATION, NET_EFFECT |
| S2 Pump.fun | `PROTOCOL_REVENUE_TO_TOKEN` | PRT-1, PRT-2 | SOURCE_OF_VALUE, DESTINATION |
| S3 Jupiter | `VALUE_CAPTURE` | VC-1..3 | SOURCE_OF_VALUE, DESTINATION, NET_EFFECT |
| E1 Morpho | `PROTOCOL_REVENUE_TO_TOKEN` | PRT-1, PRT-2 | SOURCE_OF_VALUE, DESTINATION |
| E2 Uniswap | `MECHANISM_CURRENT_STATE` | MCS-1 LIFECYCLE=CURRENT | CURRENT_STATE |
| E3 Aave | `VALUE_CAPTURE` | VC-1..3 | SOURCE_OF_VALUE, DESTINATION, NET_EFFECT |
| M1 Raydium repeat | `BURN_OR_SUPPLY_EFFECT` | BSE-1 NET_EFFECT_ESTABLISHED | NET_EFFECT (fresh-only — Memory may inform, never satisfy) |

Every value is a key of `intentRequirements` in `domain/pattern.ts`; no new
intent. The full 10-component Pattern still runs for every scenario; the
intent decides S7's requirement set and which components are
intent-required for fair-share budgeting.

### 10.2 Identity table

| Project | Key / network | Symbol | Token mint / contract | Official domain | Identity | Allowlist | Fake-interpreter asset | Catalog row |
|---|---|---|---|---|---|---|---|---|
| Raydium | `raydium` / solana-mainnet | RAY | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` (stored, ACTIVE identity) | docs.raydium.io (confirmed routes) | **CONFIRMED** | yes | yes | yes |
| Pump.fun | `pump_fun` / solana-mainnet | PUMP | `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` (stored, ACTIVE identity) | pump.fun (confirmed routes) | **CONFIRMED** | yes | yes | yes |
| Jupiter | — | JUP | **OWNER CONFIRMATION REQUIRED** (nothing stored) | **OWNER CONFIRMATION REQUIRED** | none | no | **no** | no |
| Morpho | `morpho` / ethereum-mainnet | MORPHO | **OWNER CONFIRMATION REQUIRED.** The already-sealed official page docs.morpho.org/learn/governance/morpho-token/ (hash `71ecbd74…`) names a *legacy* MORPHO token contract `0x9994E35Db50125E0DF82e4c2dde62496CE330999` and a *wrapper* contract `0x9D03bb2092270648d7480049d0E58d2FcF0E5123`, and points to `/get-started/resources/addresses/#morpho-token` for the canonical list. Which contract is "the MORPHO token" for identity (legacy vs wrapped) is the owner's call, verified on that addresses page. | docs.morpho.org (candidate; no route yet) | none | yes | yes | yes (ticker null) |
| Uniswap | `uniswap` / ethereum-mainnet | UNI | **OWNER CONFIRMATION REQUIRED** (nothing stored) | **OWNER CONFIRMATION REQUIRED** (docs + governance surfaces) | none | no | yes | yes (ticker UNI) |
| Aave | — / ethereum-mainnet | AAVE | **OWNER CONFIRMATION REQUIRED** (nothing stored) | **OWNER CONFIRMATION REQUIRED** | none | no | yes | no |

No address or host above is asserted by ATLAS; the two Morpho addresses are
quoted from the project's own stored documentation with their provenance.

### 10.3 Route readiness

| Project | ACTIVE classified routes today | Needed for its scenario | Owner action |
|---|---|---|---|
| Raydium | docs.raydium.io `/ray/ray-buybacks.md`, `/ray/protocol-fees.md` (OFFICIAL_DOCS); 2 approved resources | none | — |
| Pump.fun | pump.fun `/docs`, `/pump-token` (OFFICIAL_DOCS); fees.pump.fun `/` confirmed, unclassified; 1 approved resource | optional: classify fees.pump.fun | `classify-source-route` if the owner deems it OFFICIAL_DOCS |
| Morpho | none (26 docs.morpho.org rows in the orphaned run were SOCIAL/CLAIMED for exactly this reason) | OFFICIAL_DOCS route on docs.morpho.org (prefix e.g. `/learn`) | `confirm-source-route` + `classify-source-route OFFICIAL_DOCS` after owner verification |
| Uniswap | none | OFFICIAL_DOCS route on the docs host; GOVERNANCE route on the official governance surface (see 10.4) | confirm + classify after owner verification |
| Aave | none | OFFICIAL_DOCS route; optional GOVERNANCE route | confirm + classify after owner verification |
| Jupiter | none | OFFICIAL_DOCS route | confirm + classify after owner verification |

### 10.4 E2 Uniswap governance readiness

No Uniswap route of any class exists. Candidate official governance
surfaces the owner would verify (a forum, an on-chain voting portal, a
Snapshot space) are NOT named here as facts and are NOT confirmed by ATLAS.
What the existing lifecycle allows once the owner has verified a surface:
`confirm-source-route --project=uniswap --domain=<host> --prefix=<path>` then
`classify-source-route --route=<id> --class=GOVERNANCE`. Only then does a
page under that prefix resolve OFFICIAL/CONFIRMED with class GOVERNANCE;
until then a governance-portal page classifies GOVERNANCE with officiality
CLAIMED (existing semantics, unchanged) and can only cap, never strengthen.
Discovery of candidate surfaces during a run lands as OBSERVED route
candidates for the owner — route discovery ≠ Evidence; documented ≠
approved ≠ activated ≠ executing stays with the reducer's lifecycle caps.

### 10.5 Readiness verdict

- **READY now:** S1 Raydium (`VALUE_CAPTURE`), S2 Pump.fun
  (`PROTOCOL_REVENUE_TO_TOKEN`), M1 Raydium repeat
  (`BURN_OR_SUPPLY_EFFECT`; conditional on S1's verification + promotion).
- **NOT READY — owner confirmation only, no code:** E1 Morpho (identity from
  the stored official page + OFFICIAL_DOCS route); E2 Uniswap (identity,
  allowlist entry, docs route, governance route); E3 Aave (catalog row,
  identity, allowlist, routes).
- **NOT READY — confirmation + one fixture line:** S3 Jupiter (everything
  above plus the fake interpreter known-asset entry, permitted only after
  identity is confirmed).
- No scenario lacks an existing intent; no scenario depends on the fake
  interpreter's choice.

### 10.6 First live batch

Preferred (unchanged): **E1 Morpho + S1 Raydium**. S1 can run today. E1 can
run as soon as the owner confirms the Morpho identity (from the stored
addresses reference) and one OFFICIAL_DOCS route on docs.morpho.org — two
zero-spend commands. If E1 is not confirmed when the batch is approved, the
smallest substitute is **S2 Pump.fun** (READY, Solana, different question
shape); S3 is not a substitute (unresolved identity + fixture work).

Launch commands (owner, Windows live path, Memory OFF):
`alpha-run --mode=live --project=raydium --asset=Raydium --intent=VALUE_CAPTURE --question="<S1 frozen question>"`,
`alpha-run --mode=live --project=morpho --asset=Morpho --intent=PROTOCOL_REVENUE_TO_TOKEN --question="<E1 frozen question>"`.

Cost from persisted traces (current code): S1 $0.25 / **$0.35** / $0.50;
E1 $0.20 / **$0.32** / $0.45; combined expected **≈ $0.67**, upper ≈ $0.95.
**Recommended hard Founder cap for the first batch: $1.00** (two runs, each
stopped if its own actual exceeds $0.50). The full panel is not to be funded
yet.

### 10.7 Stop rules (first batch)

CRITICAL → stop immediately (wrong entity/chain, false SUPPORTED,
inadmissible Evidence admitted, Proof/verdict leakage, technical failure
reported as reality, Memory suppressing fresh-only work). MAJOR → pause the
panel, diagnose offline, rerun only that scenario after a fix with new
approval. MINOR → record and continue. Never rerun a failed scenario
automatically.

### 10.8 Interpreter beta blocker (recorded, not started)

**Final Research Core validation ≠ product Interpreter validation.** Before
private beta a separate acceptance task must prove, with the real
Interpreter (Anthropic gateway, §1 provider approval) on ordinary user
questions: normal user question → correct project resolution → correct
`normalized_intent` → correct Pattern/requirement set — over a frozen set
of user-shaped questions (including clarification and out-of-scope cases),
compared against the same intents this panel supplies by hand. Smallest
shape: an offline golden set for the interpreter schema + one bounded live
Interpreter run per question class, no Research spend.

## 11. Status

Preparation only. No scenario has been run, no credit spent, no product
semantics changed. Memory stays disabled by default.
