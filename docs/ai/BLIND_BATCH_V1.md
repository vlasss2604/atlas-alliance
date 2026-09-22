# Blind Live Acceptance Batch V1 (FROZEN — preparation only, nothing run)

> 2026-09-22 Founder decision: **5 CORE runs + 1 OPTIONAL** (not "4 vs 6").
> Zero-spend preparation approved; live spend NOT yet approved; Project 1 is
> not launched. §11 records what was prepared and what the Founder still
> has to supply or decide.

Prepared 2026-09-21 at HEAD `6b4f836` (git clean). No provider, search, model
or RPC call was made to prepare it. Every figure below is read from
`atlas_dev` (persisted traces), from code, or is marked as an estimate.
**LIVE CALLS MADE: 0. SPEND: $0.** Founder approval is required before any
live spend.

The batch tests the generic Research system on projects never used to drive
a rule. A run PASSES when identity, acquisition, authority, source-class
handling, the documentary / on-chain separation, temporal semantics, the
reducer and the Proof boundary are correct — whatever the verdict.

## 0. Environment facts the batch is built on (verified)

- Live allowlist (`live-executor.ts`): `pump_fun`, `raydium`, `morpho`,
  `lido`, `jupiter`, `aave`. Any other slug needs a one-line, Founder-approved
  membership change.
- The fake (non-live) Interpreter used by `alpha-run.ts` in BOTH modes knows:
  Pump.fun, Raydium, Morpho, Lido, Jupiter, Hyperliquid, Uniswap, Aave, SUI,
  TAO, Bitcoin. A question naming any other project returns
  CLARIFICATION_REQUIRED and creates no Research: a new project needs a
  one-line known-asset entry (a fixture list — the only code change any
  scenario needs). `--intent=<EXISTING_INTENT>` exists for the S7 requirement
  set (owner-only, auditable).
- Catalog (`projects`): aave, hyperliquid, jupiter, lido, morpho, pump_fun,
  raydium, uniswap. A new project needs a catalog row.
- On-chain environments implemented: `solana/mainnet` (full chain:
  TOKEN_SUPPLY, ACCOUNT_INFO, token accounts, signatures, TRANSACTION_DETAIL,
  burn detection, supply delta) and `ethereum/mainnet` (**TOKEN_SUPPLY
  only**). Identities may be confirmed on solana, ethereum, bsc, polygon,
  arbitrum, base, optimism, avalanche, but only the two environments above
  admit chain acquisition; any other chain runs documentary-only and its
  chain facts finalize as NO_ADMISSIBLE_ROUTE (a configuration boundary).
- Confirmed identities: aave (ETH), lido (ETH), pump_fun (SOL), raydium (SOL).
  Jupiter: 3 routes confirmed (jup.ag, dev.jup.ag, developers.jup.ag), **no
  identity, routes unclassified**. Morpho: 1 route, no identity. Uniswap,
  Hyperliquid: nothing.
- Budget envelope per live run: INTERNAL_ALPHA_V1 = 12 searches / 24 opens /
  $2.00 model cap / 900 s / 1 recovery step (`product.ts`, unchanged).
- Pattern v4 ACTIVE. Live-run history: pump_fun 54 jobs, raydium 40, lido 11,
  aave 2, morpho 1; jupiter, uniswap, hyperliquid 0.

## 1. Candidate pool (screened for chain, environment, identity, category, prior use)

"Prior use" = used to drive or tune a rule, or run live. "Prior knowledge in
repo" = any project-specific mention in code/docs/tests (incidental mentions
— a swap-venue address in a decoding test, "bonding curve", "holesky" — are
noted as incidental, not project logic). No candidate has project-specific
logic anywhere in the engine.

| # | Project | Chain | Mechanism category | Why useful | Prior use | Supported env | Prior-knowledge risk | Complexity | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Jupiter (JUP) | Solana | revenue → buyback → lock/treasury; destination | buyback that is NOT a burn on the full Solana chain path; transfer ≠ buyback ≠ burn on a fresh entity | never run; routes prepared 2026-09-19 | yes (solana/mainnet, full) | low — named in the frozen panel and seed only; venue address in a decoding test is incidental | complex | INCLUDE |
| 2 | Uniswap (UNI) | Ethereum | governance ladder: fee switch proposed / approved / executing | sharpest PROPOSED ≠ APPROVED ≠ LIVE case; temporal "currently" | never run | yes (TOKEN_SUPPLY only) | low — seed, demo slugs, interpreter fixtures, a typo example in the prompt | normal | INCLUDE |
| 3 | Jito (JTO) | Solana | governance-approved fee share → DAO treasury / holders | approval state + execution on Solana with docs + chain; recipient kind (treasury vs holders) | never used | yes (solana/mainnet, full) | none (one fake address string in a test) | complex | INCLUDE |
| 4 | Sky, formerly MakerDAO (SKY / MKR) | Ethereum | revenue → buyback → burn; net supply | the canonical EVM buyback-and-burn; the MKR→SKY two-token migration stresses entity binding | never used | yes (TOKEN_SUPPLY only) | none ("holesky" and handoff mentions only) | complex | INCLUDE |
| 5 | Pendle (PENDLE) | Ethereum | revenue → holders (vePENDLE fee distribution) | an executing distribution mechanism, not a buyback; recipient and flow path | never used | yes (TOKEN_SUPPLY only) | none (handoff docs only) | normal | INCLUDE |
| 6 | GMX (GMX) | Arbitrum | fee distribution to stakers + governance-approved buyback | intentional supported-boundary test: identity confirmable, chain acquisition not implemented → documentary-only | never used | identity yes; on-chain **no** | none | normal | RESERVE (optional #6) |
| 7 | Helium (HNT) | Solana | burn + issuance / net supply (burn-and-mint) | net-supply question with emissions; Solana chain path | never used | yes | none | complex | RESERVE |
| 8 | Ethena (ENA) | Ethereum | governance-approved fee switch → sENA distribution | approved-but-executing? on EVM | never used | yes (TOKEN_SUPPLY only) | low–medium — the `atlas-proof` skill uses "fee switch ENA" as a follow-up example (copy, no logic) | normal | RESERVE |
| 9 | Hyperliquid (HYPE) | Hyperliquid L1 / HyperEVM | revenue → buyback (assistance fund) | buyback economics | never run; catalog + known asset | identity **no** (chain not in SUPPORTED_CHAINS), on-chain no | medium — a Home example question names it | normal | EXCLUDE (chain unsupported for identity) |
| 10 | Marinade (MNDE) | Solana | fee distribution | simple flow | never used | yes | none | normal | EXCLUDE (adds no new dimension over Jito/Pendle) |
| 11 | Aerodrome (AERO) | Base | fees → voters (ve) | ve-model flow | never used | identity yes; on-chain no | none | normal | EXCLUDE (boundary case already covered by GMX) |
| 12 | dYdX (DYDX) | own Cosmos chain | fee distribution | — | never used | **no** | none | — | EXCLUDE (unsupported chain, not a boundary the batch needs) |
| — | Pump.fun, Raydium, Lido, Aave, Morpho | — | — | — | tuning / live targets | — | high | — | EXCLUDE (weaken blindness) |
| — | SUI, TAO, Bitcoin | — | — | not Token Value Capture questions; SUI storage fund is a skill example | — | — | high | — | EXCLUDE |

## 2. Final batch — 5 CORE + 1 OPTIONAL — frozen questions, verbatim

| Run | Project | Chain | Question | Categories covered |
|---|---|---|---|---|
| 1 | Jupiter (JUP) | Solana | **"Does Jupiter use protocol fees to buy back JUP, and where does the bought-back JUP end up — is it burned, locked, or redistributed?"** | buyback; destination / value flow; docs + on-chain; Solana |
| 2 | Uniswap (UNI) | Ethereum | **"Has the Uniswap protocol fee switch been turned on so that protocol fees currently accrue to UNI holders, or is that still only proposed or approved?"** | governance / approval state; revenue → holders; EVM |
| 3 | Jito (JTO) | Solana | **"Does the Jito DAO currently receive a share of the tips or fees Jito collects, and does any of that value reach JTO holders — and was that approved by governance?"** | governance-approved → executing; revenue → treasury vs holders; docs + on-chain; Solana |
| 4 | Sky (SKY, formerly MakerDAO) | Ethereum | **"Does Sky use protocol revenue to buy back and burn its token, and does total supply actually decrease as a result?"** | revenue → buyback → burn; burn / supply effect; EVM; entity binding (MKR → SKY) |
| 5 | Pendle (PENDLE) | Ethereum | **"Do Pendle's protocol fees actually reach PENDLE holders today, and through which mechanism?"** | revenue → holders / fee distribution; EVM |
| 6 (optional) | GMX (GMX) | Arbitrum | **"Does GMX currently distribute protocol fees to GMX stakers or use them to buy back GMX, and where do bought-back tokens go?"** | supported-boundary test: documentary-only, chain facts expected NO_ADMISSIBLE_ROUTE |

Coverage: Solana ×2 (3 with Helium reserve), EVM ×3; buyback ×2 (lock vs
burn); destination ×2; burn / supply ×1 (Sky, plus Jupiter's NET_EFFECT);
governance ×2 (Uniswap ladder, Jito approval); revenue → holders ×2
(Pendle executing, Uniswap conditional); docs + on-chain together ×2 (Jupiter,
Jito). The full 10-component Pattern runs on every scenario regardless of
intent, so NET_EFFECT, CURRENT_STATE, EXECUTION_EVIDENCE and the governance
lifecycle are exercised everywhere; only the S7 requirement set follows the
intent.

## 3. Frozen run order and why

**1 Jupiter → 2 Uniswap → 3 Jito → 4 Sky → 5 Pendle → (6 GMX)**

- Chains alternate for the first four (SOL, EVM, SOL, EVM), so a chain-specific
  fault shows on run 1 or 2, not after four runs on one chain.
- No two consecutive runs share a mechanism category: buyback-to-lock →
  governance ladder → approved fee share → buyback-to-burn → fee
  distribution.
- The two most-prepared projects run first (Jupiter has confirmed routes;
  Uniswap has a catalog row and a known-asset entry), so a CRITICAL surfaces
  before prerequisites are spent on the rest.
- The intentional boundary test (GMX) runs last, so a configuration boundary
  can never be mistaken for a generic defect in the middle of the batch.
- The order is frozen now. It is not changed on the basis of any live
  result, and nothing project-specific is adjusted between runs.

## 4. Prerequisites (all zero-spend, all Founder / owner; none asserted here)

| Project | Catalog row | Allowlist line | Known-asset line | Identity (chain + token address — **owner confirms**) | OFFICIAL_DOCS route confirmed + classified |
|---|---|---|---|---|---|
| Jupiter | exists | exists | exists | needed (solana) | 3 routes exist, **classification needed** |
| Uniswap | exists | needed | exists | needed (ethereum) | needed |
| Jito | needed | needed | needed | needed (solana) | needed |
| Sky | needed | needed | needed | needed (ethereum; decide SKY vs MKR as the confirmed token — one identity per project) | needed |
| Pendle | needed | needed | needed | needed (ethereum) | needed |
| GMX (opt.) | needed | needed | needed | needed (arbitrum) | needed |

Tools: `scripts/confirm-project-identity.ts`, `scripts/confirm-source-route.ts`,
`scripts/classify-source-route.ts`; the known-asset entry is a one-line
addition to `interpreter/fake.ts`; the allowlist a one-line addition to
`live-executor.ts`; catalog rows via the seed / an owner insert. GOVERNANCE
routes: as in the panel (§7-2), a CLAIMED governance page never strengthens a
conclusion; whether to confirm a GOVERNANCE route for Uniswap / Jito is a
Founder decision, not assumed.

## 5. Blindness

For every candidate only chain, environment support, identity availability,
mechanism category and prior use were inspected. No answer was researched, no
claim resolved, no verdict pre-learned, no live provider output inspected.
The mechanism categories above are the reason a project is in the batch, not
a prediction of what ATLAS will find; any of SUPPORTED, PARTIALLY_SUPPORTED,
INSUFFICIENT_EVIDENCE and CONTRADICTED is acceptable.

## 6. Cost — from persisted traces only (no call made)

Full 10-component runs under current code (`research_trace_events.actual_cost_micro`, Anthropic model cost only):

| Run | Project | Model $ | Model calls | Searches | Fetches | Seconds |
|---|---|---|---|---|---|---|
| a118fb74 | Lido | 0.181 | 22 | 11 | 23 | 402 |
| b5395f96 | Lido | 0.172 | 19 | 11 | 22 | 348 |
| 1a326f54 | Lido | 0.396 | 29 | 13 | 26 | 430 |
| 58952f45 | Lido (Memory) | 0.297 | 24 | 11 | 23 | 422 |
| cbe59f48 | Aave | 0.198 | 39 | 20 | 47 | 211 |

Benchmark (offline, 160 runs, same envelope): average modelled cost $0.186.

- Normal run (Uniswap, Pendle, GMX): expected **$0.20**, range $0.15–$0.30.
- Complex run (Jupiter, Jito, Sky — deep Solana chain path or two-token /
  heavy documentary corpus): expected **$0.35**, range $0.25–$0.50.
- **5 CORE runs** (3 complex + 2 normal): expected **≈ $1.45**, range
  $1.05–$2.10.
- **6 runs** (core + GMX): expected **≈ $1.65**, range $1.20–$2.40.
- Per-run policy: if one completed run exceeds the **$0.50 expected-run
  ceiling**, STOP before launching the next project and report. An
  in-progress provider call cannot be interrupted exactly at $0.50; the
  per-run system cap ($2.00 model, 12 searches, 24 opens, 900 s) is what
  bounds a run while it is running.
- **Cumulative hard cap: $5.00** (kept). Six runs at their upper bound
  ($2.40) plus one full restart from project 1 after a generic fix ($2.40)
  = $4.80 ≤ $5.00; the recalculation gives no reason to change it.
- Flat-plan usage reported separately from metered model spend: Brave
  search calls (`SEARCH_EXECUTED` rows) and RPC reads (`FETCH_*` rows with
  the RPC provider) are on existing plans and are **not metered in the
  traces**; every "$" above is Anthropic model cost only. Solana runs with
  a deep account chain have not been measured under the current code, so
  their upper bound is an estimate.

## 7. Time — from measured runs only

Completed full runs measured 211 s (Aave, current code) to 430 s (Lido):
**3.5–7.5 minutes each**. The ≤ 60 s (normal) / ≤ 120 s (complex) targets are
not met by any measured live run; the batch records actuals and does not
optimize.

- Active batch time: **5 core runs ≈ 18–38 min; 6 runs ≈ 21–45 min.**
- Elapsed including the between-run audit of the persisted result (no
  fixes, ≈ 10 min each), identity/route confirmation done beforehand:
  **≈ 1–2.2 h for 5 runs, ≈ 1.2–2.6 h for 6.**
- Performance is an acceptance metric, reported separately from quality
  and not redefined during the batch. Per run, from persisted rows only:
  wall-clock (`research_jobs.finished_at − started_at`); acquisition
  duration where available (per component `research_attempts.completed_at
  − created_at`; `SEARCH_EXECUTED` / `FETCH_ATTEMPTED → FETCH_OK|FAILED` /
  `EXTRACT_ATTEMPTED` timestamp gaps); extraction / reasoning duration where
  available (`EXTRACT_ATTEMPTED → MODEL_CALL_ATTEMPTED(EXTRACT)` gaps;
  finalization = `finished_at − max(attempt completed_at)`); model cost
  (`Σ actual_cost_micro`); search / open / extract counts; whether a
  technical boundary was reached (`proofs.bounded_by`); final Research
  quality by the §9 rubric. A semantically clean run that materially
  exceeds ≤ 60 s (normal) / ≤ 120 s (complex) is **not** silently counted
  as fully accepted: quality PASS and performance MISS are reported as two
  separate verdicts.

## 8. Failure and reset policy (frozen)

- NO fixes between runs. The frozen sequence runs as-is.
- CRITICAL (wrong project / entity / chain / token bound; a false
  SUPPORTED; inadmissible Evidence admitted as establishing; verdict or
  confidence leakage between jobs; a technical failure reported as project
  reality; Memory suppressing fresh-only work) or MAJOR (an available
  capability path missed; a generic acquisition / reducer defect; an
  incorrect component reason; a material provenance failure): **stop the
  batch**, classify, add the case to the permanent benchmark
  (`tests/benchmark-economics-reliability-v1.test.ts`), make the smallest
  generic fix, **restart the clean sequence from project 1** under a new
  approval.
- MINOR presentation issue: record it; no redesign during the batch unless
  it blocks comprehension.
- Project-specific weirdness is not automatically a generic defect: it is
  recorded and judged after the batch.
- Operational: any provider unreachable at the pre-run probe → wait, do not
  launch; a run above $0.50 actual → report before continuing; cumulative
  spend above the approved cap → stop.

## 9. Acceptance rubric (per run, recorded after each)

1. What really happens with the money — source of revenue, who pays, where
   value flows, value capture, buyback / burn / distribution.
2. Paper vs reality — documented, approved, activated, executing.
3. Basis for each conclusion — primary source, governance, on-chain, source
   inspectability.
4. What ATLAS could not prove — the boundary explicit and truthful
   (technical / configuration / substantive kept distinct).
5. Freshness — checked date, source recency.
6. Human-readable conclusion — clear in 5–20 seconds.
Also recorded: wall-clock, actual model cost, search / fetch / extract counts,
whether a technical boundary was reached.

## 10. Pre-flight status at preparation (offline checks only)

| Check | Status |
|---|---|
| git clean | yes (0 changes) |
| HEAD | `6b4f836`, branch `claude/phase-5-research-memory` |
| Docker / Postgres | `atlas-postgres` Up; `pg_isready` accepting; 110 research jobs |
| Dev server | :3000 up (pid 11807), `/home` 200 |
| Provider credentials | `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY` present in `.env.local` (presence only; not exercised) |
| Solana endpoint | `SOLANA_MAINNET_RPC_URL` present; `ONCHAIN_RESEARCH_ENABLED` set |
| Ethereum RPC | `ETHEREUM_MAINNET_RPC_URL` present |
| Budgets | INTERNAL_ALPHA_V1 = 12 / 24 / $2.00 / 900 s / 1 recovery — unchanged |
| Hidden live job | none: 0 pending pg-boss tasks (`created` / `retry` / `active`); the 27 `QUEUED` `research_jobs` rows are owner-tool containers from Aug 24 – Sep 13 (document acquisition / on-chain observation / smoke) that were never enqueued and cannot start |
| Background monitors / workers | none (no worker, alpha-run, vitest, poller or playwright process) |
| UI / reliability work in progress | none — all rounds committed |
| Interpreter gateway | `MODEL_GATEWAY` unset (live Anthropic for the product); `alpha-run.ts` uses the fake gateway in both modes, so the batch spends nothing on interpretation |

## 11. Prerequisite status after the 2026-09-22 preparation (zero spend)

Applied (commit on this HEAD), each classified as exactly one permitted class:

| Addition | File / store | Class |
|---|---|---|
| catalog rows `jito`, `sky`, `pendle`, `gmx` (name only, ticker null, ACTIVE_CORE) | `src/server/db/seed.ts` → `projects` (seeded locally, `onConflictDoNothing`) | CATALOG |
| allowlist slugs `uniswap`, `jito`, `sky`, `pendle`, `gmx` | `src/server/engine/live-executor.ts` | ALLOWLIST |
| known-asset names `Jito`, `Sky`, `Pendle`, `GMX` (word-bounded) | `src/server/interpreter/fake.ts` | IDENTITY (name level) |
| allowlist enumeration pin re-pointed | `tests/documentary-only-mode.test.ts` | test pin, no logic |

ANSWER_HINT / EXPECTED_MECHANISM / EXPECTED_DESTINATION / EXPECTED_VERDICT /
PROJECT_SPECIFIC_LOGIC: **zero**. No engine file branches on any slug; the
diff is three fixture lists and their comments.

NOT applied, because every value would have to come from official material
that this task forbids reading (a live HTTP call) and must not come from
memory (reporting discipline: no unverified exact value):

| Project | Identity (chain + token) | OFFICIAL_DOCS route | Governance route |
|---|---|---|---|
| Jupiter | chain solana; **token mint: owner supplies** | 3 routes exist, **classification pending** (route ids `c7f10f9c…`, `cd44ef2f…`, `81237c90…`) | — |
| Uniswap | chain ethereum; **contract: owner supplies** | **host + prefix: owner supplies** | **Founder decision** |
| Jito | chain solana; **mint: owner supplies** | **owner supplies** | **Founder decision** |
| Sky | chain ethereum; **ONE subject: Founder decision (see below)**; contract: owner supplies | **owner supplies** | — |
| Pendle | chain ethereum; **contract: owner supplies** | **owner supplies** | — |
| GMX (optional) | chain arbitrum; **contract: owner supplies** | **owner supplies** | — |

A chain-only identity was deliberately NOT confirmed now: an ACTIVE
identity is never superseded automatically (`ACTIVE_IDENTITY_EXISTS`), so
confirming without the token would block the later confirmation with it.

Exact commands, once the Founder supplies the values (each is offline —
a local DB write, no provider call):

```
npx tsx scripts/confirm-project-identity.ts --project=jupiter --chain=solana   --token=<JUP mint>     --ticker=JUP    --actor=<founder>
npx tsx scripts/classify-source-route.ts    --route-id=<jupiter route id> --class=OFFICIAL_DOCS --actor=<founder>   # per route the Founder deems official docs
npx tsx scripts/confirm-project-identity.ts --project=uniswap --chain=ethereum --token=<UNI contract> --ticker=UNI    --actor=<founder>
npx tsx scripts/confirm-project-identity.ts --project=jito    --chain=solana   --token=<JTO mint>     --ticker=JTO    --actor=<founder>
npx tsx scripts/confirm-project-identity.ts --project=sky     --chain=ethereum --token=<frozen subject contract> --ticker=<SKY|MKR> --actor=<founder>
npx tsx scripts/confirm-project-identity.ts --project=pendle  --chain=ethereum --token=<PENDLE contract> --ticker=PENDLE --actor=<founder>
npx tsx scripts/confirm-project-identity.ts --project=gmx     --chain=arbitrum --token=<GMX contract>  --ticker=GMX    --actor=<founder>   # optional sixth only
npx tsx scripts/confirm-source-route.ts     --project=<slug>  --domain=<official docs host> --prefix=</path> --actor=<founder>
npx tsx scripts/classify-source-route.ts    --route-id=<id returned above> --class=OFFICIAL_DOCS --actor=<founder>
```

**Sky — the identity ambiguity, reported rather than chosen.** The project
now called Sky is the former MakerDAO, and at the identity level it has two
governance tokens: the legacy MKR and the newer SKY introduced with the
rebrand. Which one the frozen question's "its token" and "total supply"
refer to is exactly the kind of fact that can only be settled from
official identity material — reading that material is a live call this
task forbids, and which token the buyback mechanism actually targets is the
economic answer that must stay blind. Identity confirmation takes ONE
token per project, and it decides which supply `TOKEN_SUPPLY` observes.
Options for the Founder: (a) freeze **SKY** — the token the project
currently names as its governance token, matching the question's subject
"Sky"; if the research finds the mechanism acts on the other token, that is
a finding the run reports, not a preparation error; (b) freeze **MKR** — the
legacy token; (c) if both are materially required to phrase the question
truthfully, the question must be re-frozen by the Founder (the only
identity-driven change §3's rule allows). The question text itself is not
literally ambiguous under (a) or (b) and is left unchanged.

**Governance routes (Uniswap, Jito) — Founder decision.** Today a
governance portal classifies GOVERNANCE without a route (officiality
CLAIMED) and the reducer already caps what a CLAIMED page may strengthen.
Options: (a) confirm no GOVERNANCE route for the batch — the accepted
semantics run as they are; (b) confirm a GOVERNANCE route on the project's
official governance host (owner supplies host + prefix). Recommendation on
preparation grounds only: (a), so the batch tests the accepted system
rather than a route decision made the day before.

**LIVE CALLS MADE: 0. SPEND: $0.**
