# Research Core hardening — adversarial offline coverage

What the Core is proven to refuse, where that proof lives, and which policy
lines are pinned but not decided. Current state only; history is in git.

## The adversarial suites

The first three are pure (no DB, no model, no network) and run the REAL S5
reducer over the REAL Pattern v1 contract, then the REAL S6 assembler, S7
evaluator and S8 proof builder — the production chain minus persistence.
The fourth is the persistence: every case runs the real lifecycle function
over Postgres (`atlas_test`), with a fixture WorkExecutor that writes
ordinary Evidence rows through the real authority resolvers and never
touches a provider.

| File | Job |
|---|---|
| `tests/adversarial-core-reducers-v1.test.ts` | Tries to make weak, wrong, stale, foreign, technical or merely documented evidence strengthen a conclusion. Sections A–G: identity/authority, typed chain facts, lifecycle, freshness, support/counter-evidence/absence, full-chain Proof, regressions for defects the suite found. |
| `tests/adversarial-core-boundaries-v1.test.ts` | Section N: attacks that held, kept as regressions. Section H: **documented boundaries** — behaviour that sits on a policy line; each case pins what the Core does today so a later Founder decision fails a named test rather than drifting. |
| `tests/adversarial-core-round2-v1.test.ts` | Round 2 — interactions and order: the same Evidence in every permutation (byte-identical S5/S6 flow ids/S7/S8), mixed pools (weak rows beside strong), temporal boundaries (`publishedAt == fetchedAt`, equal timestamps, undated vs dated), S7→S8 traceability, cross-stage idempotency, and a fresh pass on the Pattern→S7 contract, memory-candidate admission and projection labels. |
| `tests/adversarial-core-round3-db-v1.test.ts` | Round 3 — the DB-backed stateful Core, attacked by changing the world BETWEEN two correct operations: A verification → candidates (concurrent verification, vanished rows, rollback); B promotion (repeat, race, forbidden transitions, one live row per observation, duplicate ACTIVE state); C adoption after a route withdrawal, a re-classification, an identity replacement, a Pattern change, a freshness crossing, competing states, a Proof downgrade, a memory switch-off; D identity lifecycle and historical chain readings; E route resolver determinism, supersession, classification rollback; F Pattern activation against existing jobs and memory; G attempt/job terminal states, retry after partial work, the crash window after S8; I cross-project contamination; J the H7 audit path over persisted rows; K the health axis. |
| `tests/founder-semantics-round3-5-v1.test.ts` | Round 3.5 — the Founder-approved semantics pinned over the real store: freshness re-checked at adoption (H8), VERIFIED terminal (H9), verification only of a successful bounded job (H10), documentary memory bound to its token identity (H11), the memory kill switch re-read at adoption, the Pattern version boundary; plus the cross-state attacks (stale + switch, identity + fresh, identity + route, regression attempt over ACTIVE memory, failed-job Proof with eligible Evidence) and the no-false-conclusion assertions. Not an adversarial round; does not count toward the two clean rounds. |
| `tests/adversarial-core-round4-sequences-v1.test.ts` | Round 4 — ATLAS as a long-lived stateful system: long legal sequences in two orders (route replaced, Pattern activated, memory aged, memory disabled, identity replaced between planning and adoption); concurrent pairs (verify ∥ review, two workers claiming one job, adoption ∥ adoption, Pattern activation ∥ verification); cross-project (shared host, ticker, documents, source rows); cross-chain (same-address explorer pages on other EVM chains, an identity that moved chains); the Round 3.5 rules combined with other failures; an independent audit walk Proof → S7 → S6 → S5 → Evidence → source / memory origin; crash and retry windows (Evidence written then attempt left STARTED, lease, reclaim, convergence); legacy data (pre-H10 VERIFIED Proof of a FAILED job, domain-wide unclassified route, contract-version-1 Evidence, identity_key NULL); the health axis at adoption. |
| `tests/founder-semantics-round5-5-v1.test.ts` | Round 5.5 — the Founder decisions on the three Round 5 boundaries, pinned over the real S4 executor and store: A SAME TICKER ≠ SAME PROJECT (unrouted binding needs the confirmed name, slug or token contract; routed sources unchanged; GOVERNANCE not route-only; the Round 5 B1 attack equals its control); B TECHNICAL FAILURE ≠ PROJECT REALITY (a 401 / 403 / 404 on a generation call is capability-fatal for the extractor and the proposer alike, like count_tokens'; transient retry and document-local failures unchanged); C NO EVIDENCE ≠ NOT EXTRACTED (`EXTRACTION_NOT_COMPLETED`, diagnostic only). Not an adversarial round; does not count toward the two clean rounds. |
| `tests/adversarial-core-round6-metamorphic-v1.test.ts` | Round 6 — metamorphic invariants over the pure chain: start from a complete, fully sourced control world and TRANSFORM it — add weak / foreign / inadmissible / stale rows (F1), duplicate a passage from the same or mirror sources and duplicate chain observations (F2), remove any component, the strongest authority row, one side of a conflict, the measurement or the binding (F3), add every admissible contradiction in every arrival order (F4), permute rows and swap same-timestamp ids (F5), weak-then-strong and strong-then-weaker authority (F6), age a current-state row across the freshness window (F7), enrich with OPTIONAL atoms / remove a REQUIRED basis (F11), attack the band independently of the verdict (F12), provenance under every transformation (F13), the fresh review (F14). Relation: a transformed world is never stronger than its control on verdict, band, S5, S7 or citations; an inadmissible addition is identical. |
| `tests/adversarial-core-round6-metamorphic-db-v1.test.ts` | Round 6 — the same relations over the persisted Research (real S4 executor, lifecycle, Postgres): duplication through search / provider / mirror / Memory (F2), discovery and fetch order (F5), routed vs unrouted and same-ticker foreign (F6), the technical-failure ladder incl. RPC down (F8), Memory A–H (F9), project / chain substitution (F10), verification audit metadata across later Researches (F13). |
| `tests/founder-semantics-round6-5-v1.test.ts` | Round 6.5 — the Founder decisions on Round 6's H5 and D-101 boundaries, pinned over the pure chain: Decision 2 EXCLUDED EVIDENCE ≠ CONFIDENCE (C one excluded row, D many, E every excluded class — wrong project, wrong chain, stale, wrong class, unconfirmed entity, superseded route — one at a time and all at once; E2 the stale-only shapes by name; E3 the comparative rule at the band function); Decision 3 MORE AGREEING ADMISSIBLE EVIDENCE ≠ WEAKER PROOF (F an agreeing twin at every component for every intent, twins at 2 / 3 / 5 components; G the exact Round 6 F1c fork shapes; G2 a row that names one branch attaches there only, and the retained outcome-2 boundary; H contradiction still weakens, visibly, in both orders; I the temporal semantics intact); the no-false-semantics pins; F2 the enumeration-cap boundary. Not an adversarial round; does not count toward the two clean rounds. |
| `tests/founder-semantics-round6-5-db-v1.test.ts` | Round 6.5 — Founder decision 1 TECHNICAL FAILURE ≠ STRONGER PROJECT REALITY over the real S4 executor, lifecycle and Postgres with a fixture EVM RPC: A RPC UP vs DOWN for the state, revenue and supply intents (down never stronger); B CURRENT_STATE on EVM — the TOKEN_SUPPLY reading AND the official page, both supporting, SUPPORTED / LIVE, the attempt naming why the pass went on; B2 the live EVM revenue shape (the fork, no false attribution, PRT-2 PARTIAL as with the RPC down); B3 the pass finds nothing → the attempt still closes SUCCEEDED on the reading; B4 bounded research preserved (NET_EFFECT still closes on its reading, never more opens with the chain working). |
| `tests/founder-semantics-round6-6-v1.test.ts` | Round 6.6 — the Founder decisions on Round 6.5's two residual boundaries, over the pure chain: Decision 1 SAME SOURCE ≠ EXTRA CONFIDENCE / ≠ AUTOMATIC PENALTY (A one page, two compatible components; B exact duplicates and near-identical fragments; C the genuine pairing choice — HIGH-1 — stays unresolved; D independent sources unchanged and equal to the same-page shape; E the exact G2 shape); Decision 2 BOUNDED ENUMERATION ≠ WEAKER TRUTH (F below the cap; G at the boundary, deterministic; H above the cap — 32 flows, complete lineages, the diagnostic visible on flow / result / Proof, the control's conclusion and band; H2 the S8 predicate; I above the cap with a real contradiction; J six insertion orders byte-identical); the four named invariants. Not an adversarial round; does not count toward the two clean rounds. |
| `tests/adversarial-core-round5-blackbox-v1.test.ts` | Round 5 — the final result, black box: complete Research runs through the REAL S4 executor over deterministic documents (fixture proposer, search, fetcher, extractor; the real EVM adapter over a fixture RPC where a chain is involved), read only at the Proof. Families: strong vs weak authority; documentary vs on-chain (BUYBACK ≠ BURN, point-in-time supply ≠ change, APPROVED ≠ EXECUTING, transaction ≠ mechanism); partial research for every intent; technical failure beside valid Evidence; Memory vs fresh; project / token ambiguity; temporal; misleading language; exclusion pressure; bounded budgets; order independence; the independent review. |
| `tests/adversarial-core-round7-cross-question-v1.test.ts` | Round 7 — cross-question / logical consistency over the pure chain: EVERY Pattern v1 intent asked of the SAME evidence world. The implication laws Pattern v1 itself defines (L0 S5/S6 intent-independent; L1 PRT ≡ REWARD_SOURCE ≡ USAGE_TO_TOKEN_LINKAGE; L2 VALUE_CAPTURE = PRT ∧ BSE atom by atom, refutation / insufficiency laws; L3 TOKEN_UTILITY's REQUIRED atom is PRT-1; L4 no supply question is ever SUPPORTED; L5 "is it current?" rests on CURRENT_STATE and is refuted only by execution + a non-live state; L6 provenance and cross-job leakage; L7 confidence ceilings and the stronger claim never outranking its prerequisite; L8 a refutation always has provenance) over a 2,880-world combinatorial battery (A), then per family: buyback / burn / net effect (B), revenue / fees / value capture (C), governance lifecycle (D), documentation vs execution (E), transaction vs economic role (F), supply consistency incl. the burn × delta × attribution grid (G), historical vs current (H), NOT_ESTABLISHED vs CONTRADICTED (I), Proof consistency (J), confidence consistency (K), six holdout worlds A–F (L), the independent review's boundaries (M). |
| `tests/adversarial-core-round7-cross-question-db-v1.test.ts` | Round 7 — the same questions of the SAME DOCUMENTS through the real S4 executor, lifecycle and Postgres: one job per intent (eight jobs per document set), the persisted S5 / S6 shapes identical across jobs, the persisted laws, own-job-only citations and no shared Evidence row; the complete documentary world, approved-not-activated, executed-then-paused (persisted HISTORICAL refutation citing that job's state and execution rows), and the chain-up world (the level beside the page, the supply question at the B1 rung). |
| `tests/founder-semantics-round7-5-v1.test.ts` | Round 7.5 — the Founder decisions M3 and C4 over the pure chain. M3 (six cases + the composition case): recipient identity alone never fully establishes the holder outcome; a stated holding → entitlement/receipt relation does; non-holder recipients keep their full `ACTOR_MISMATCH` refutation; inadmissible evidence and an entitlement sentence filed under another component buy nothing; order and duplication are inert; a state-bearing conflict is still the only contradiction; and the bridge must be carried by ONE statement, not assembled from two. C4 (six cases): an established destination of unrecognised kind cannot satisfy the relationship atom, a recognised kind is untouched, the unresolved role poisons no destination-independent question, an unknown destination never strengthens anything, order and duplication are inert, and two established destinations remain two flows under the existing existential rule. Not an adversarial round; does not count toward the two clean rounds. |
| `tests/adversarial-core-round8-role-attribution-v1.test.ts` | Round 8 — ROLE MANUFACTURE AND ATTRIBUTION LAUNDERING over the pure chain: for each distinction ATLAS makes, can the stronger side be built from parts that individually do not carry it? A position is not a role (a bound balance establishes DESTINATION and never its kind, never RECIPIENT; chain UP is never weaker than chain DOWN); B two statements are not one relation (entitlement never crosses actors, a destination kind never crosses components); C approved and documented are not live; D more uncertainty is never a stronger conclusion (inadmissible rows, foreign rows, a failed acquisition boundary); E order and duplication are not evidence (24 permutations per world, mirror sources); F the existential rule is not cherry-picking (a role-less flow never satisfies a role-dependent atom; a compound claim needs one common flow); G supply is not attribution; H a 486-world × 8-intent sweep over the role dimensions with the role laws asserted per world, and the dimensions proven monotone; I the gates are question-local, and I3 names their inherited limit. |
| `tests/adversarial-core-round8-role-memory-db-v1.test.ts` | Round 8 — the persisted half: a role is not inheritable through Research Memory. Research A establishes a recipient that only NAMES holders and a destination that is only an ADDRESS, is bounded, is VERIFIED by the canonical act and its observations promoted to ACTIVE; A's verdict, confidence and S5 status are then deliberately corrupted; Research B adopts those same observations and is bounded for the same reason, citing only its own rows. The mirror case proves adoption does not LOSE a role either. |
| `tests/adversarial-core-round9-output-boundary-v1.test.ts` | Round 9 — THE OUTPUT BOUNDARY, the last hop from the persisted record to the sentence a reader actually reads. A the projection label guard (the status-word rule holds; the surface it does not cover is measured and pinned rather than assumed away; a resolved finding carries a label and canonical keys and no status); B reference closure (invented / drifted / requirement-shaped refs rejected, a vanished row's finding dropped rather than re-pointed, all-dropped returns null, cross-job leakage, self-support and duplicates, both count bounds, and the model's input carries no fragments, urls or evidence ids); C the page never outruns the record (WHAT STOOD UP holds only checks that stood, and a partly-established one stands in only when nothing was established; counts index the checks and never score them, a blocked check is NOT CHECKED; a contradiction is never manufactured from a gap; nothing is lost or double-counted); D a weaker record never makes a stronger page (a six-rung degradation ladder, permutation invariance, no reassuring summary with nothing standing); E the ladder's RealityState maps into the reader's four ProofState words by one total function and an unrecognised status never becomes positive; F **the defect this round found** — an S5-EXCLUDED reading rendered as an ESTABLISHED measurement. |
| `tests/adversarial-core-round9-label-safety-db-v1.test.ts` | Round 9, persisted — STORAGE IS NOT TRUSTED. A real job is researched, its projection row is then overwritten with claim-shaped labels (the legacy and the tampered case at once), and the rendered page is read back through the same loaders the detail route uses: every unsafe label is neutralised to its component's canonical name, every pointer survives, every status is the persisted one, and a safe label is passed through unchanged. A corrupted reference is dropped rather than re-pointed. |
| `tests/adversarial-core-round10-tenancy-entitlement-db-v1.test.ts` | Round 10 — AUTHORIZATION, TENANCY AND ENTITLEMENT UNDER COMPOSITION: whose record is it, and when was the right to it decided? A one account's finished research is unreachable from another at every loader (job, proof, snapshot), an evidence id from another job cannot be read through a job you do own, a Proof's owner never drifts from its job's owner (asserted over the whole table), and a job carries only its own project's research; B the DEMO quota ledger (the finding below); C an idempotency key is per account, never a global name; D entitlement is frozen at start — a downgrade never destroys a finished Proof and an upgrade grants nothing retroactively; E whole-table invariants: no orphan proof, evidence or component result, and no component result citing another job's evidence. |
| `tests/demo-quota-lifetime-consumption-v1.test.ts` | Founder decision Q1 — what spends a DEMO lifetime slot. A three evidence worlds run end to end all consume, and the rule is shown verdict-blind over a real job's real persisted Proof across the whole verdict enum; B a technical terminal with no Proof releases (driven through the real phased terminal writer), a cancellation releases, and the pinned boundary that a DOCUMENT-LOCAL provider failure which still finalises with a bounded Proof DOES consume; C exactly once under replay, under a late stale RELEASED, and under concurrent completion, with no completed Proof left RESERVED anywhere; D the limit now binds, a released slot is genuinely reusable, and accounts are isolated; E a paid entitlement takes no reservation at all and idempotency is unchanged. |

Every canonical invariant in `CORE_RULES.md` has at least one case: BUYBACK ≠
BURN, BURN ≠ NET DEFLATION, POINT-IN-TIME SUPPLY ≠ SUPPLY CHANGE, ABSENCE ≠
EVIDENCE OF ABSENCE, DOCUMENTED ≠ APPROVED ≠ ACTIVATED ≠ EXECUTING, ADDRESS
EXISTS ≠ ECONOMIC ROLE, WHERE ≠ WHO, TRANSACTION HAPPENED ≠ MECHANISM
EXECUTED, MEASUREMENT ≠ ATTRIBUTION, NOT_ESTABLISHED ≠ CONTRADICTED, DISCOVERY
≠ AUTHORITY, TECHNICAL FAILURE ≠ PROJECT REALITY, SAME TICKER ≠ SAME PROJECT,
NO EVIDENCE ≠ NOT EXTRACTED.

## Known live incidents and their permanent regressions

| Incident | Regression |
|---|---|
| PUMP foreign-mint burn safety | `onchain-foreign-mint-burn.test.ts`, `source-identity-hardening.test.ts` |
| Lido stale DURABILITY_BASIS Pattern (semantic drift) | `pattern-semantic-drift-activation-v1.test.ts` |
| Explorer / documentary search-slot conflict | `acquisition-graceful-degradation-v1.test.ts` |
| Extraction MAX_TOKENS_TRUNCATED → compact retry | `acquisition-graceful-degradation-v1.test.ts` |
| Empty first source / useful second source | `documentary-candidate-continuation-v1.test.ts` |
| Search budget exhaustion as a bounded boundary | `bounded-search-finalization-v1.test.ts` |
| Research Memory live reuse | `research-memory-controlled-reuse-acceptance-v1.test.ts`, `research-memory-*-v1.test.ts` |
| NET_EFFECT boundary (burn ≠ net deflation, delta ≠ attribution) | `adversarial-core-reducers-v1.test.ts` B4–B9, `net-supply-*`, `post-budget-evidence-backed-reconciliation.test.ts` |
| Morpho stale redirect (official path 301s off the confirmed prefix) | `rendered-page-http-status.test.ts` §4, `rendered-docs-stage1.test.ts` |
| Morpho large renderer envelope truncation | `renderer-child-envelope-flush.test.ts` |
| Model-authored publication date after fetch time | `adversarial-core-reducers-v1.test.ts` D3, G2 |
| NET_EFFECT partial on a supply code alone crashing S6 | `adversarial-core-reducers-v1.test.ts` F2, G1 |
| Attribute / lifecycle atoms reaching SUPPORTED from a partial component | `adversarial-core-reducers-v1.test.ts` F4, F5 |
| Attribute / lifecycle verdicts citing no Evidence | `adversarial-core-boundaries-v1.test.ts` N2, N2b, N2c |
| Contradicted NET_EFFECT / flow-relationship verdicts citing no Evidence | `adversarial-core-round2-v1.test.ts` P4 |
| All-OPTIONAL requirement set → vacuous SUPPORTED | `adversarial-core-round2-v1.test.ts` Z1 |
| Repeated promotion of an ACTIVE memory row rewrote `promoted_by` / `promoted_at` | `adversarial-core-round3-db-v1.test.ts` B1 |
| Two concurrent owner confirmations (identity, route, classification) both went ACTIVE | `adversarial-core-round3-db-v1.test.ts` D2 |
| Same-address explorer page on ANOTHER EVM chain bound CONFIRMED (bscscan / polygonscan / Optimism for an Ethereum identity) | `adversarial-core-round4-sequences-v1.test.ts` X1, X2 |
| Memory health (D-059) decided at plan time only; a row marked QUESTIONABLE / REVERIFY / STALE before adoption was materialized | `adversarial-core-round4-sequences-v1.test.ts` M1 |
| A bare ticker bound an UNROUTED document to the project: another project sharing the ticker had its public governance proposal admitted CLAIMED and lifted the confidence cap 20 → 40 | `founder-semantics-round5-5-v1.test.ts` A1–A9, `adversarial-core-round5-blackbox-v1.test.ts` F6c, `phase6-s4-executor.test.ts` HIGH-A D |
| A permanent provider rejection (401 / 403 / 404) of the generation call was document-local: a mid-run credential rejection left every later component NO_EVIDENCE_FOUND on a SUCCEEDED, verifiable job | `founder-semantics-round5-5-v1.test.ts` B1–B8, `adversarial-core-round5-blackbox-v1.test.ts` F4b', `transient-extractor-resilience-v1.test.ts` 5b |
| "Acquired, not extracted" read as NO_EVIDENCE_FOUND | `founder-semantics-round5-5-v1.test.ts` C1–C5 |
| With the chain UP a state-less TOKEN_SUPPLY reading closed CURRENT_STATE's acquisition and the official current-state page was never read; with the RPC DOWN it was, and the state question read stronger (Round 6 F8b) | `founder-semantics-round6-5-db-v1.test.ts` A, B, B2, B3, B4; `adversarial-core-round6-metamorphic-db-v1.test.ts` F8b |
| Adding ONLY excluded rows to empty components lifted a SUPPORTED Proof from LOW (20) to VERY_STRONG (80); a stale current-state row alone lifted the band above bare absence (Round 6 F12b / F1b, H5) | `founder-semantics-round6-5-v1.test.ts` C, D, E, E2, E3; `proof-confidence.test.ts` 4, 7, 11; `adversarial-core-boundaries-v1.test.ts` H5 |
| A second agreeing admissible row at a fork point made every later row BRANCH_ATTRIBUTION_UNRESOLVED and the claim PARTIAL → UNSATISFIED on multiplicity alone (Round 6 F1c / F2c, D-101 accepted limitation v1) | `founder-semantics-round6-5-v1.test.ts` F, G, G2; `phase6-s6-audit-fixes.test.ts` MEDIUM-1; `phase6-s6-mechanism-assembler.test.ts` AD |
| One page spanning a fork with ONE element below it (two agreeing SOURCE_OF_VALUE passages + the page's DESTINATION) made the element BRANCH_ATTRIBUTION_UNRESOLVED on both branches and PRT-2 UNSATISFIED (Round 6.5 G2) | `founder-semantics-round6-6-v1.test.ts` A, B, C, D, E; `founder-semantics-round6-5-v1.test.ts` G2; `phase6-s6-mechanism-assembler.test.ts` AD |
| The flow-enumeration cap dropped the capped component from every lineage, so twins at every component turned PRT-2 PARTIAL → UNSATISFIED and the result-level cap gap capped the band as a claim context gap (Round 6.5 F2) | `founder-semantics-round6-6-v1.test.ts` F, G, H, H2, I, J; `founder-semantics-round6-5-v1.test.ts` F2 |

## Semantics the hardening pass fixed (now current behaviour)

- **S6 qualification set = every partial-basis code S5 can emit.** The four
  NET_EFFECT supply codes are qualifications. A PARTIALLY_SUPPORTED result
  whose only code is a supply code is a valid outcome, never an invariant
  error.
- **S7 FLOW_ATTRIBUTE and LIFECYCLE atoms propagate PARTIAL** from the
  code-owned basis components their value was classified from
  (`ATTRIBUTE_BASIS_COMPONENTS`, `lifecycleBasisComponents` in
  `claim-evaluator.ts`), exactly as the other four atom kinds already did. A
  positive incompatibility stays CONTRADICTED. Those atoms also name their
  basis components in `componentResultKeys`, so S8 cites the rows the verdict
  rests on.
- **Every S7 verdict names the components it rests on** — including the
  contradicted NET_EFFECT and FLOW_RELATIONSHIP branches — so S8 cites the
  support S5 kept (a measured non-decrease keeps its burn). Refuting rows
  are never cited; they appear as gaps (boundary H7 below).
- **A requirement set with no REQUIRED atom is not a proposition.** S7
  returns INSUFFICIENT_EVIDENCE / CLAIM_PROPOSITION_NOT_STRUCTURED instead
  of the vacuous SUPPORTED the compound rule would otherwise yield.
- **A model publication date later than the document's fetch time is not a
  date.** Refused at the extractor boundary (`parseModelPublishedAt(raw,
  notAfter)`) and ignored by the reducer's temporal basis for rows written by
  any other path. Never clamped to fetch time.
- **Promotion is recorded once.** `promoteToActive` reads the row `FOR
  UPDATE`; an already-ACTIVE row returns as it is, so a repeat by another
  admin never replaces the audit of the first decision, and two admins
  racing produce one promotion.
- **Memory must be fresh at adoption, not only at planning (H8).**
  `adoptReusedMemory` applies the planner's own `isStale` (same window,
  same config, the row's own `stale_after`) to the persisted row at the
  moment it would become Evidence; a row that crossed its window since
  planning is refused `MEMORY_STALE`, stays ACTIVE, and the component is
  ordinary fresh work. Stale is never a contradiction.
- **VERIFIED is terminal (H9).** `markProofReviewed` refuses a VERIFIED
  Proof (`VERIFIED_IS_TERMINAL`) and the database guard
  `proof_verification_status_guard` (migration 0052) refuses any regression
  from VERIFIED, direct SQL included. Re-verifying is a no-op on the row.
  Verdict and confidence are untouched by the rule.
- **Only a Proof of a successful bounded job is verifiable (H10).**
  `markProofVerified` reads the job under the Proof's row lock and refuses
  (`JOB_NOT_SUCCESSFUL`) unless the job ended SUCCEEDED or
  BUDGET_LIMIT_REACHED (`VERIFIABLE_JOB_STATES`). A DRAFT written by S8
  before a crash or sweep stays persisted for audit and is never verified;
  no candidate is written. A failed Research is not a negative finding.
- **Documentary memory is bound to its token identity (H11).** The
  candidate writer records `research_memory.identity_key`
  (`identityBindingKey`: chain and token address, never a row id) from the
  identity confirmed at verification; adoption refuses a row whose key
  differs from today's (`IDENTITY_CHANGED`). A deprecate + re-confirmation
  of the same token is not a replacement. NULL means "verified under no
  identity": eligible while the project has none, refused once it has one.
  Never backfilled — that would be the automatic rebinding the rule
  forbids; an owner re-establishes by retiring the old row and verifying a
  new Research (`round3-5` H shows the path).
- **A VERIFIED Proof records its verification event.** `proofs.verified_by`
  (the ADMIN actor) and `proofs.verified_at` are written on the one
  transition into VERIFIED (migration 0054) and never rewritten by a
  repeat; the database guard requires both and an ADMIN actor on the
  transition (D-065 for Proofs). Proofs verified before the columns
  existed keep NULL. Nothing that decides research reads them.
- **Entity binding requires the explorer of the identity's chain.**
  `computeEntityBinding` binds CONFIRMED only when the URL's host (www
  stripped, exact) is one of the code-owned mainnet explorers of the
  confirmed chain (`urlHostIsExplorerOfChain`) AND the URL names the
  address. An EVM address is the same string on every EVM chain, so the
  host decides the chain; `optimistic.etherscan.io` is Optimism's, not
  Ethereum's; a host the map does not list binds nothing. Chain artifact
  rows bind through onchain-binding.ts, never through a URL.
- **Memory health is re-checked at adoption (D-059).** A row whose health
  is not OK at the moment of adoption is refused `MEMORY_HEALTH_NOT_OK`
  (DEPRECATED health stays `MEMORY_NOT_ACTIVE`); it stays as it is and the
  component is fresh work.
- **The memory kill switch is re-read at adoption.** `memory_enabled`
  false at the moment of adoption returns every reused component to fresh
  work (`MEMORY_DISABLED`) with nothing written; the preparation read-back
  (`loadEffectiveJobContractView`) agrees. The Research is not cancelled,
  Memory is not touched, the code default stays false.
- **An unrouted document binds on a strong anchor, never the bare ticker
  (Founder decision A, Round 5.5).** `documentNamesProject` in
  `s4-executor.ts` accepts the confirmed project name and the canonical
  slug (the exact consecutive-token rule, unchanged);
  `documentNamesConfirmedToken` accepts the confirmed token contract / mint
  literally present and identifier-bounded (`literallyPresent`; base58
  case-significant, EVM case-insensitive). The ticker is no longer a
  candidate. A CONFIRMED route still binds without any text anchor, so
  routed official sources are untouched; GOVERNANCE keeps its public-
  platform class, so a public governance page with a strong anchor is
  still usable CLAIMED. A refusal that the ticker alone would have passed
  adds `WRONG_PROJECT_TICKER_ONLY` to the attempt's observations.
- **A permanent provider rejection of a generation call is capability-fatal
  (Founder decision B, Round 5.5).** `PERMANENT_PROVIDER_REJECTIONS`
  (token-gate.ts: AUTHENTICATION_FAILED / PERMISSION_DENIED / NOT_FOUND —
  401 / 403 / 404) is read by `reserveAndCallWithRetry` off the typed
  extractor error's closed diagnostic or the typed proposer error's
  trusted status, before the transient check: the outcome is `fatal` /
  `PROVIDER_REJECTED_PERMANENTLY`, one call, never softened by the N=2
  document counter, thrown as `CapabilityFatalError` → job FAILED /
  SYSTEM_OR_PROVIDER_FAILURE, no S7, no Proof. INVALID_REQUEST (400 /
  422), the output classes and an oversized input stay document-local;
  429 / 5xx / no-response keep the one retry. count_tokens is unchanged
  (every permanent failure already fatal). Evidence extracted before the
  rejection stays persisted.
- **Read but not inspected is `EXTRACTION_NOT_COMPLETED` (Founder decision
  C, Round 5.5).** `acquisitionBoundaryFromAttempt` maps a FAILED /
  `EVIDENCE_EXTRACTOR_UNAVAILABLE` attempt (every fetched document failed
  extraction locally) and the oversized-only shape (now SKIPPED /
  `EXTRACTION_NOT_COMPLETED` instead of NO_TRACEABLE_FACTS) to the third
  acquisition boundary. Same INSUFFICIENT_EVIDENCE status, same LOW cap as
  bare absence; a document that was never opened, or was read and said
  nothing, is still NO_EVIDENCE_FOUND; a component with any Evidence is
  reduced exactly as before.
- **A chain read closes a component's acquisition only when its rows carry
  what the component reports (Founder decision 1, Round 6.5).**
  `loadAcquisitionPlan` exposes `reportsMechanismState`
  (`requiresCurrentState || requiresLiveMechanismState`, the reconciler's own
  predicate for a state-carrying component); at step 0b `s4-executor.ts`
  returns `ONCHAIN_EVIDENCE_ESTABLISHED` only when that is false or at
  least one persisted chain row normalizes to a known mechanism state.
  Otherwise the rows stay, the attempt records
  `ONCHAIN_EVIDENCE_WITHOUT_MECHANISM_STATE`, and the documentary pass runs
  exactly as it would with no chain — same search, open and model bounds,
  the explorer-page guard still in force. A documentary close that means
  "nothing more was found / read" (SKIPPED on a bounded reason, FAILED on a
  document-local one) is folded by `closeDocumentaryPass` into SUCCEEDED /
  `ONCHAIN_EVIDENCE_ESTABLISHED; documentary pass <status>: <reason>` — the
  component IS established by persisted rows, and must not read as
  unestablished to the controller (a recovery retry of finished work).
  Budget and capability failures are thrown, not returned, and stay thrown.
  Components whose reading carries state (EXECUTION_EVIDENCE: BURN rows are
  LIVE) or that report none (NET_EFFECT, FLOW_PATH, DESTINATION, ...) keep
  the pre-emption unchanged. Generic: Pattern data and row state only.
- **Exclusion-shaped absence caps like absence (Founder decision 2, Round
  6.5).** `ALL_EVIDENCE_EXCLUDED`, `MISSING_EXECUTION_EVIDENCE`,
  `MISSING_CURRENT_STATE` and `STALE_CURRENT_STATE` — the four codes the
  reconciler's single "rows offered, every one excluded" branch emits — cap
  at LOW in `proof-confidence.ts`. The invariant is comparative: the control
  with the excluded rows removed is the zero-Evidence return, always an
  absence code, always LOW; so the cap is the control's, by identity, not a
  chosen number. The diagnostics stay as they are (S5 reason codes, the
  exclusion record, the Proof's gaps); only the band no longer reads them
  as footing. D-135's "reasoned exclusion imposes no cap" clause is
  superseded by this decision.
- **A row that names no branch continues the trunk on every branch (Founder
  decision 3, Round 6.5).** In `assembleMechanism` a row of a forked
  lineage whose source shares nothing with the post-fork part of ANY branch
  (§13.4 outcome 3, and the prefix-only source of audit MEDIUM-1) is no
  longer BRANCH_ATTRIBUTION_UNRESOLVED: it attaches to every branch, as it
  would have in the unforked lineage, and its source is never added to a
  branch's post-fork provenance (it distinguishes none; a later row from
  that source names no branch either). Each branch's flow is the single-slot
  world's flow; S7 is existential over flows; so the claim is never
  stronger than the strongest single-slot world and never weaker than the
  control. Unchanged: outcome 1 (a row that names ONE branch attaches there
  only), outcome 2 (a row a single source spans across the fork — audit
  HIGH-1 — stays unresolved: a scope the source defines and the assembler
  does not guess), slot identity (D-101: the lineage still forks, one slot
  per structural unit), the enumeration cap. D-101's "accepted limitation
  v1" is reopened under D-104's clause for exactly this: Round 6 was the
  beta data showing the deferred limitation materially blocks correct
  assembly.
- **One shared element below a fork continues on every branch its source
  spans (Founder decision 1, Round 6.6).** In `assembleMechanism`, rows a
  single source spans across the fork (they pass this branch and a
  sibling) are ambiguous only when they form two or more slots on this
  branch — a pairing choice the source's own structure decides (audit
  HIGH-1) — and then stay `BRANCH_ATTRIBUTION_UNRESOLVED` with none of them
  attached. One shared slot offers no choice: it attaches on every branch
  the source spans, with the one shared provenance, and the branches stay
  distinct. Never an independent corroboration (S7 is existential,
  confidence never counts); never a merge. D-101 slot identity and the
  §13.4 outcomes 1 and 2 are otherwise unchanged; exact duplicates still
  reduce to one representative in S5 (`DUPLICATE_UNIT`), near-identical
  distinct fragments are still distinct slots.
- **When the enumeration cap binds, the lineage continues with the
  structurally-first slot (Founder decision 2, Round 6.6).** `MAX_FLOWS`
  and its formula are unchanged. Where the cap used to leave the component
  OFF the lineage (every claim needing it UNSATISFIED), it now attaches the
  first slot of the structural sort (deterministic under any input order),
  opens no fork, and records the positioned `FLOW_ENUMERATION_INCOMPLETE`
  gap on the flow plus the result-level gap, exactly as before. The flow
  is a real lineage of established rows — one of the flows full
  enumeration would have listed. In S8, `hasClaimContextGap` no longer
  reads `FLOW_ENUMERATION_INCOMPLETE` (it stays in the Proof's gaps under
  CLAIM_CONTEXT, never binds the band): an enumeration limit is not
  unresolved state in the mechanism. A CONTRADICTED component is handled
  before the cap and stays visible on every flow.
- **Owner confirmations are serialized on the project row.** Identity
  confirmation, route confirmation and route classification run their
  check-then-act inside one transaction that locks the project row (the
  attempt claim's own pattern), so a second concurrent call re-reads and is
  refused (`ACTIVE_IDENTITY_EXISTS`, `DUPLICATE_ACTIVE_ROUTE`,
  `ROUTE_NOT_ACTIVE`) instead of producing a second ACTIVE row.

### Round 9 — a relationship label is not an admission (CRITICAL-class, fixed)

`relationship` is what the EXTRACTOR said a row was for. S5 then decides
whether the row is admissible and records what it refused in the
component's `excludedEvidence` — exclusion never rewrites the row, so a
reading refused for an unconfirmed entity binding, a withdrawn route,
supersession or a foreign job still reads `relationship: "SUPPORTS"`.

`output-plan.ts` admitted on that label alone, and `PlanComponent` carries
no excluded set, so the presentation layer could not see a refusal. An
EXCLUDED on-chain TOKEN_SUPPLY reading was therefore rendered as a METRIC
tile with `state: "ESTABLISHED"` — byte-identical to the admitted twin —
and excluded rows could appear in the evidence snapshot. The detail route
already enforces the matching invariant for a finding's evidence lists
("something a component excluded can never be presented as that
component's support"); the numbers were chosen without it.

Fixed by POSITIVE, COMPONENT-SCOPED admission (`admittedFor`): a row must
be in that component result's supporting or contradicting set, both of
which are already in the payload and are kept disjoint from the excluded
set by S5. No new field, no API change. Component-scoped on purpose — a
reading may support CURRENT_STATE while NET_EFFECT excludes it, and a
NET_EFFECT tile quoting it would still attribute a number to a component
that refused it. Pinned in `adversarial-core-round9-output-boundary-v1` F.

### Round 9.5 — the label is the only route by which free text becomes a claim (fixed)

Three Founder decisions, one mechanism. `shared/projection-label-safety.ts`
is now the single guard on user-visible projection copy, called on the
WRITE path (`validateProjection` rejects), the API READ path
(`resolveProjectionFindings` neutralises) and the RENDERER
(`safeClaimLabel` neutralises). Storage is never trusted: a legacy row
written before the rule, or a corrupted one, is neutralised on the way out.

Five closed axes, each named after what it refuses — STATUS, CERTAINTY,
MAGNITUDE (including any stated number; a digit inside a word such as
`ERC-20` is a name and passes), DIRECTION, and the per-component ECONOMIC
ENVELOPE that already existed. A refusal degrades to the component's own
canonical copy, never to a reworded guess. The lists are closed, as every
dictionary in ATLAS is: a novel magnitude word outside them passes, and
that limit is stated rather than hidden.

`I4` in the same round: explicit non-actuality no longer satisfies the
holder-entitlement bridge. A closed list of possibility, conditionality and
intention markers, read inside the matched phrase's own clause within a
bounded window, and judged per clause — a clause with any defeated
occurrence establishes nothing. `will` and `can` are deliberately absent: a
scheduled mechanism's actuality is `mechanism_state`'s decision, not this
classifier's. Conservative where it cannot tell: a clause carrying explicit
proposal language is refused even where a reader could tell the proposal
had passed, because governance approval is represented structurally.

## Documented boundaries — Founder decision pending

Pinned by `adversarial-core-boundaries-v1.test.ts` section H. None is a
false SUPPORTED; each is a place where a different reasonable rule exists.

| Case | Current behaviour | The other reasonable rule |
|---|---|---|
| H1 | The INSUFFICIENT_AUTHORITY cap reads the NEWEST establishing row; an older CONFIRMED row beside a newer CLAIMED one still caps. | Cap only when NO establishing row is CONFIRMED (set-based, like INDIRECT_ONLY). Direction: strengthening. |
| H2 | LIVE beside an undated PROPOSED record of the same component is a state CONFLICT → CONTRADICTED; a required-component conflict → NOT_SUPPORTED (confidence capped LIMITED). | Treat PROPOSED as a lifecycle rung below LIVE (progression), not an incompatibility. |
| H3 | S6's lexical classifiers have no negation grammar ("not burned" → BURN). Accepted S6 audit limitation LOW-3; cannot create structure. | A negation stop-list on the closed dictionaries. |
| I3 (`round8`) | **MINOR, inherited from H3.** The M3 holder-entitlement dictionary has no negation and no tense grammar either: "token holders are not entitled to any share", "may in future be entitled" and "were previously entitled" all satisfy the bridge. NOT a regression — every one of those worlds answered SUPPORTED before the gate existed — so the gate raises the bar in the ordinary case and is defeated exactly where every other closed classifier is. Pinned in `adversarial-core-round8-role-attribution-v1` I3. | As H3: a negation stop-list on the closed dictionaries. |
| Q1 (`round10`) | **DECIDED AND FIXED (Founder decision Q1).** A DEMO lifetime slot is CONSUMED when the Research completed AND produced a durable Proof; the VERDICT does not enter into it, because INSUFFICIENT_EVIDENCE and NOT_SUPPORTED are legitimate ATLAS outcomes and the work was done. Technical terminals (FAILED, CANCELLED, a crash before the Proof, a completion with no Proof) RELEASE. `demoTerminalOutcome` is the rule, `resolveDemoReservationForTerminal` applies it, and `resolveDemoReservation` now matches only a reservation still in RESERVED — so the first terminal handling decides and every replay, retry, duplicate event and concurrent completion is a no-op, rather than the database trigger raising on CONSUMED -> RELEASED. Pinned in `demo-quota-lifetime-consumption-v1`; `round10` B1b flipped. | — |
| I4 (`round9`) | **DECIDED AND FIXED (Founder decision).** Was:  The holder-entitlement dictionary has no TENSE grammar: "may in future be entitled" and "were previously entitled" satisfy the positive bridge. ATLAS bounds tense through `mechanism_state` and the lifecycle machinery instead (a PROPOSED recipient row caps at `PROPOSED_STATE_ONLY` and cannot reach SUPPORTED), so reading prose tense in a classifier would be a NEW semantic rule rather than an implication of the approved one. Pinned in `adversarial-core-round8-role-attribution-v1` I4. | Add a tense stop-list, or leave tense to `mechanism_state` as today. |
| A2 (`round9`) | **DECIDED AND FIXED (Founder decision).** Was:  The projection label guard is a closed status-word list, so a model-authored `userFacingLabel` may still assert a magnitude, a certainty or a yes/no answer ("50% of all fees reach the token", "holders definitely receive value"). Documented as deliberate where the guard was written: a label is a POINTER PLUS A NAME, `resolveProjectionFindings` returns it beside canonical component keys and NO status, and the reader's status, reason, coverage and evidence all still come from the canonical row. Measured and pinned rather than assumed away. | Constrain labels further (a noun-phrase or question-form rule), or keep the pointer-plus-name contract. |
| A3 (`round9`) | **DECIDED AND FIXED (Founder decision).** Was:  The label guard is enforced on the WRITE path only: `resolveProjectionFindings` re-checks references, not copy, so a stored finding whose label is a status word still resolves. Reachable only by writing the projection row directly. | Re-apply the label rule on read. |
| H4 | Recency wins over officiality in supersession (D-093 forbids an authority ranking). | Refuse supersession of a CONFIRMED row by a CLAIMED one. |
| H5 | **DECIDED (Round 6.5, Founder decision 2).** ALL_EVIDENCE_EXCLUDED and the other exclusion-shaped absences cap at LOW, like bare absence; a single-atom SUPPORTED claim with every unrelated component excluded sits at LOW, exactly where it sits with them empty. The second half of the original note — gaps on the claim's own flow that block no atom are not a context gap — is unchanged. | — |
| H6 | An established DEPRECATED current state with no execution record is lifecycle NOT_ESTABLISHED → "is it current?" is INSUFFICIENT_EVIDENCE, not answered "no". | Let an established non-live CURRENT_STATE refute CURRENT without an execution record. |
| — | EXECUTION_EVIDENCE has `freshnessClass: MEDIUM_CHANGE` but `requiresCurrentState: false`, so age is never checked for it; "currently executing" is protected by CURRENT_STATE only. | Apply the freshness window to EXECUTION_EVIDENCE. |
| H7 (`round2` P5) | S8 citations are support-only: a NOT_SUPPORTED verdict from a state CONFLICT cites nothing; the contradicting rows are visible only as CONFLICTING_STATE gaps. | Cite contradicting rows on refutations. |
| — | No owner path supersedes a PROJECT_IDENTITY (`ACTIVE_IDENTITY_EXISTS` refuses a second, also under concurrency; token migration legacy → current has no lifecycle act, only a manual DEPRECATE plus a fresh confirmation); `resolveConfirmedIdentity` takes the oldest valid ACTIVE row if two ever exist, reachable only by direct SQL. Documentary memory verified under the old identity is refused after the replacement (H11, decided). | An identity supersession script mirroring route classification. |
| — (`round3` F1, `round3-5` L) | A Proof of a job planned under an earlier Pattern version cannot be verified once a later version is ACTIVE: `markProofVerified` refuses (`MissingActivePatternError`) and rolls back whole. Founder-confirmed as the safe rule; a product limitation, not a bug. | Verify under the version the job was planned under. |
| F8b (`round6-db`) | **DECIDED (Round 6.5, Founder decision 1).** A chain read closes a component only when its rows carry what the component reports; a state-less TOKEN_SUPPLY reading no longer suppresses CURRENT_STATE's documentary pass. With the chain UP the official page is read beside the reading, the component is SUPPORTED / LIVE, "is it current?" is answered as with the RPC down, and the RPC-down world is never stronger. The D-101 cost the round measured (the fork at CURRENT_STATE) is removed by decision 3: the page rows continue the trunk on both branches, the reading attaches to its own, PRT-2 stays PARTIAL. Pinned in `founder-semantics-round6-5-db-v1`. | — |
| F1c / F2b (`round6`) | **DECIDED (Round 6.5, Founder decision 3).** A row that names no branch continues the trunk on every branch; a second agreeing admissible row at a fork point still splits the lineage (slot identity untouched — F2b's five mirrors are still five slots, five flows, five citations) and no longer weakens the claim: no BRANCH_ATTRIBUTION_UNRESOLVED, the control's verdict, band and requirements. Pinned in `founder-semantics-round6-5-v1` F, G, G2. **Outcome 2 decided (Round 6.6, Founder decision 1):** one shared element below the fork continues on every branch the source spans; two shared elements (HIGH-1) stay unresolved. Pinned in `founder-semantics-round6-6-v1` A–E. | — |
| H1 (`round6` F6a2) | Metamorphic form: an AGREEING CLAIMED explorer row dated the same day as the official row demotes CURRENT_STATE from SUPPORTED to PARTIALLY_SUPPORTED (the cap reads the newest establishing row; the chain class sorts first at an equal date). Weaker, never stronger. | As H1. |
| H4 (`round6` F6c) | Metamorphic form: a NEWER CLAIMED explorer row saying LIVE beside an OLDER CONFIRMED official PAUSED supersedes it and moves "is it current?" from NOT_SUPPORTED to PARTIALLY_SUPPORTED on the weaker source. | As H4. |
| H5 (`round6` F12b, F1b) | **DECIDED (Round 6.5, Founder decision 2)** — see H5 above. 20 → 20 on inadmissible rows alone; the stale-only shapes (`STALE_CURRENT_STATE`, `MISSING_CURRENT_STATE`, `MISSING_EXECUTION_EVIDENCE`) sit exactly where bare absence sits. Pinned in `founder-semantics-round6-5-v1` C, D, E, E2, E3. | — |
| F2 (`round6-5`) | **DECIDED (Round 6.6, Founder decision 2).** The cap stays (`MAX_FLOWS` 64, sixth two-slot fork refused at 32 flows); when it binds the lineage continues with the structurally-first slot, `FLOW_ENUMERATION_INCOMPLETE` stays visible on flow, result and Proof, never binds the band, and the claim is exactly the control's. Deterministic across input order; a real contradiction still weakens. Pinned in `founder-semantics-round6-6-v1` F–J. | — |
| M1 (`round7`) | Structural intents carry no lifecycle atom: a mechanism positively refuted as current (HISTORICAL — executed, now PAUSED) still reads PROTOCOL_REVENUE_TO_TOKEN / PASSIVE_HOLDER_OUTCOME / TOKEN_UTILITY SUPPORTED over the same facts. Consistent with Pattern v1's requirement sets (no LIFECYCLE atom in them); pinned so a present-tense dependency is a named decision. | Add a LIFECYCLE (or "not HISTORICAL") atom to the present-tense intents. |
| M2 (`round7`) | **HALF RESOLVED (Round 7.5).** The destination half is closed by C4: `DESTINATION_UNRESOLVED` on an ESTABLISHED destination now blocks `PRT-2`, so it reaches the Proof as a `REQUIREMENT_BLOCKING` gap. The source half stands and stays **MINOR**: `FLOW_IDENTITY_UNRESOLVED` on an established source with no recognised value source blocks no atom (`PRT-1` asks establishment, not identity), so it is recorded in the assembly (API-visible engine state) and reaches no Proof gap list. Verdict and band are unaffected. | Carry matched-flow non-blocking S6 gaps into the Proof's layer 6 under their own origin, without binding the band. |
| M3 (`round7`) | **DECIDED (Round 7.5, Founder decision M3).** RECIPIENT identity alone is not entitlement. `classifyHolderEntitlement` (S6) is a closed dictionary for the HOLDING -> entitlement/receipt bridge (`entitled to`, `pro rata`, `per token held`, `by holding`, `accrues to holders`, `no action required`, …), read over the RECIPIENT component's own admitted text. `recipientKind = PASSIVE_HOLDER` with no match leaves a positioned `RECIPIENT_UNRESOLVED` gap on the ESTABLISHED recipient; S7 reads it and caps the attribute atom at PARTIAL (`REQUIRED_RELATIONSHIP_UNRESOLVED`), so PASSIVE_HOLDER_OUTCOME is PARTIALLY_SUPPORTED, never SUPPORTED. A non-holder recipient is untouched — `ACTOR_MISMATCH` is still a full refutation. Pinned in `founder-semantics-round7-5-v1` (M3 1–6). | — |
| M4 (`round7`) | A self-contradicting measurement record (two supply intervals, opposite directions) is a limitation (PARTIALLY_SUPPORTED, `CONFLICTING_SUPPLY_DELTA`) where a self-contradicting state record is CONTRADICTED; adding a favourable interval to a refuted NET question lifts it from NOT_SUPPORTED to PARTIALLY_SUPPORTED. Decided when B2 shipped (`net-effect-measured-supply` 14: a second interval is reachable only through corruption, surfaced rather than resolved). | Treat conflicting intervals as CONTRADICTED, like conflicting states. |
| C4 (`round7`) | **DECIDED (Round 7.5, Founder decision C4).** ADDRESS EXISTS != ECONOMIC ROLE ESTABLISHED. S6 already records `DESTINATION_UNRESOLVED` on an ESTABLISHED destination whose kind the closed dictionary does not recognise; S7's `FLOW_RELATIONSHIP` now reads it and caps the atom at PARTIAL (`REQUIRED_RELATIONSHIP_UNRESOLVED`, blocking gap), so PRT-2 / RS-2 / UTL-2 / VC-2 can no longer be SATISFIED off an opaque address and the revenue question is PARTIALLY_SUPPORTED. PARTIAL and **not** UNSATISFIED on purpose: UNSATISFIED carries no component keys and would have dropped the citation of every established destination row, which the decision forbids, and would have collapsed an unrecognised kind into the same verdict as a genuinely unpairable branch (Round 6.6 HIGH-1). Two established destinations are still two flows and S7's existential rule is unchanged. Pinned in `founder-semantics-round7-5-v1` (C4 1–6). | — |
| H7 (`round3` J1, J2) || H7 (`round3` J1, J2) | Kept. The audit path is complete in persisted state: a REQUIRED-component conflict leaves the refuting row ids in the S7 requirement's provenance and a `CONTRADICTED_COMPONENT` blocking gap; the S5 row holds `contradictingEvidenceIds`; the Proof's layer 6 names the code and component. A lifecycle requirement over a contradicted CURRENT_STATE is UNSATISFIED / INSUFFICIENT_EVIDENCE (never negative) and carries no component keys — its basis is the code-owned CURRENT_STATE. | Cite contradicting rows on refutations; name the basis on the unsatisfied lifecycle branch. |

## Observed, not defects (Round 4)

- **Authority is as-of each row's own moment.** A row adopted or acquired
  while a route was CONFIRMED keeps CONFIRMED inside that job if the route
  is withdrawn before the Proof; rows acquired after the withdrawal are
  CLAIMED. The same holds for identity binding. A job mixes as-of states
  exactly as fresh acquisition always has.
- **Proofs carry no persisted verification actor or time.** D-055's audit
  is the ADMIN role check plus the script's printed confirmation;
  `research_memory` records `promoted_by` / `promoted_at`, `proofs` records
  nothing. There is nothing to rewrite, and nothing to audit from the row.
  A Founder decision, not a defect under the current design.
- **After an identity replacement, Memory of the old identity is frozen
  until an owner retires it**: a new verification of the same passage
  dedups against the live old row and never rebinds it (H11, by design).

## Observed, not defects (Round 5)

- **Explorer pages opened over HTTP are CLAIMED** (D-074): a token page
  binds CONFIRMED when it names the address on the right chain, and still
  establishes only PARTIALLY_SUPPORTED (INSUFFICIENT_AUTHORITY). Only a
  chain read is CONFIRMED authority.
- **The job-wide query ledger** never repeats a query string inside one
  job; an explorer locator searched once serves every later on-chain
  eligible component from the same candidates. Targeting replaces the
  proposer's queries and bounds by their count, so a proposer returning
  one query leaves one slot.
- **Citations are intent-scoped**: a SUPPORTED component the intent does
  not rest on is not cited, whatever its strength.
- **A publication date later than the fetch is not a date** — a fixture
  that dates its facts at extraction time reproduces Round 1 D3/G2
  (MISSING_PUBLICATION_DATE, and an undated LIVE beside a dated APPROVED
  is H2's conflict).

## Observed, not defects (Round 6)

- **Every inadmissible addition is identical.** Over every intent, every
  component and twelve kinds of weak row (research media, social, data
  provider, CLAIMED governance, stale, foreign job, unbound explorer,
  INFERRED, CONTEXT, LIMITS, legacy contract, wrong component), a row S5
  excludes changes nothing but the exclusion record — since Round 6.5 not
  the band either; an admissible-but-weaker row may only weaken (H1, H4),
  and an admissible AGREEING row never does (decision 3).
- **Duplicates never corroborate.** Same-unit copies reduce to one
  representative; distinct copies of a CLAIMED row stay CLAIMED; the
  search returning a URL twice, the provider returning every fact twice
  and Memory beside an identical fresh copy each yield one row per
  (source, passage) and the control's Proof.
- **Removal never strengthens; a lone counter-row establishes nothing;
  removing the measured interval or the binding only weakens.**
- **Every state-bearing contradiction stays visible** in S5, the flow
  gaps, the Proof gaps and the binding reasons, in both arrival orders and
  under ten later agreeing rows; a stale counter-row is superseded (D-093);
  a prose-only "contradiction" with no state is a non-supporting row
  (D-094), traceable in S5's exclusions, never a conflict.
- **Order invariance holds** over rich pools, same-timestamp id swaps,
  fetch-time shifts, and reversed discovery / fetch order through the real
  executor; an equal-instant disagreement is a conflict in both id orders.
- **Freshness is monotone**: at the HIGH_CHANGE boundary inclusive the row
  is current, one millisecond past it STALE_CURRENT_STATE, undated
  MISSING_CURRENT_STATE; a stale LIVE never revives a fresh PAUSED and a
  stale PAUSED never contradicts a fresh LIVE.
- **Technical degradation never strengthens** across the ladder
  (document-local failure, recovered 429, exhausted transient, fetch
  timeout, search budget, permanent 401, and — since Round 6.5 — an RPC
  down beside a working chain).
- **Memory is monotone**: valid ACTIVE Memory, the same observation
  verified twice, Memory beside an identical fresh copy, stale / unhealthy
  / other-identity Memory and the switch flipped between planning and
  adoption all yield the no-Memory control's Proof; the verified Proof's
  actor, time and memory rows are byte-identical after later Researches.
- **Substitution fails closed**: chain, address, wrapper, other-chain
  explorer and no-identity variants all bind UNVERIFIED; a renamed project
  no longer binds its old name; the ticker never binds.
- **The contradiction exemption cannot lift a refutation**: NOT_SUPPORTED
  with an unrelated unresolved conflict still carries CONFLICTING_STATE's
  LIMITED cap.

## Observed, not defects (Round 7)

- **One reduced picture per evidence world.** S5 and S6 are functions of
  the evidence alone; every intent asked of the same facts shares them byte
  for byte, in memory and as persisted rows across eight jobs over one
  document set. Only S7 / S8 differ between questions.
- **The conjunction is exactly its conjuncts.** VALUE_CAPTURE's atoms are
  PRT-1 / PRT-2 / BSE-1 verbatim; it is NOT_SUPPORTED iff a conjunct is,
  INSUFFICIENT iff both are, never stronger than either; PRT, REWARD_SOURCE
  and USAGE_TO_TOKEN_LINKAGE are one requirement set and agree byte for
  byte; TOKEN_UTILITY's REQUIRED atom is PRT-1. Over 56,700 exploratory
  worlds and the 2,880 pinned ones, no law was violated.
- **No supply question is ever SUPPORTED under Pattern v1**, and no Proof
  of any intent exceeds LIMITED (40): NET_EFFECT keeps a limitation in
  every typed outcome (SUPPLY_REDUCTION_NOT_ESTABLISHED, NET_SUPPLY_CHANGE_
  NOT_ESTABLISHED, NET_SUPPLY_CHANGE_NOT_ATTRIBUTED, CONFLICTING_SUPPLY_
  DELTA, NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL), each capping at LIMITED,
  and its absence caps at LOW; confidence is job-wide. STRONG and
  VERY_STRONG are unreachable until attribution exists.
- **BUYBACK ≠ BURN ≠ NET EFFECT, cross-question.** A documentary "burned"
  destination classifies BURN lexically and reaches no verdict (no v1
  intent reads `destinationKind`); every question answers exactly as in the
  buyback-only world. One typed BURN establishes execution and the
  gross-reduction rung only; a reading, a decrease, a non-decrease and two
  disagreeing intervals each move NET_EFFECT to their own code and nothing
  else — the revenue, holder and current questions never move with the
  supply record.
- **DOCUMENTED ≠ APPROVED ≠ ACTIVATED ≠ EXECUTING, cross-question.**
  Proposed-only caps every structural component and answers nothing;
  approved establishes GOVERNANCE_BASIS and leaves "is it current?"
  INSUFFICIENT even with a fresh official APPROVED state; a fresh official
  LIVE answers "is it current?" without any execution (the lifecycle atom
  rests on CURRENT_STATE by definition) while no edge reads executed; a
  burn strengthens the supply questions only. A GOVERNANCE record filed at
  CURRENT_STATE is inadmissible by class.
- **TRANSACTION ≠ MECHANISM ≠ ROLE, cross-question.** Production-shaped
  transfers, owner listings and transaction details are CONTEXT or
  kind-refused and strengthen no question; a single bound balance carries
  DESTINATION (a position) and never RECIPIENT, and neither "did revenue
  fund it?" nor "did holders receive?" moves.
- **HISTORICAL ≠ CURRENT, cross-question.** Execution alone leaves "is it
  current?" INSUFFICIENT; a stale LIVE page changes nothing; a fresh LIVE
  strengthens only that question; a fresh PAUSED beside an execution
  refutes it (citing state and execution) and moves nothing else; a
  two-year-old OFFICIAL_REPORT of execution reads the same HISTORICAL as a
  chain burn (EXECUTION_EVIDENCE has no freshness window, boundary "—"). A
  burn READ today beside a page PUBLISHED yesterday still reads HISTORICAL:
  a chain row's temporal basis is its read time, not the event's, so
  nothing licenses "the burn is newer than the pause".
- **NOT_ESTABLISHED ≠ CONTRADICTED, cross-question.** Every absence shape
  for CURRENT_STATE (none, stale, undated, wrong class) is INSUFFICIENT at
  LOW; a lone CONTRADICTS row is absence; the only attribute refutation in
  v1 (a positively different recipient) is positive and cited; "is it
  inactive?" and "is there evidence X does not happen?" are unsupported
  question forms and no negation grammar was added (H3 unchanged).

## Observed, not defects (Round 8)

- **A role gate is question-local.** Over a rich world, a bare versus an
  entitled recipient differ in the holder question alone: every other
  verdict, band and requirement is byte-identical. The one other atom that
  moves is `TU-2`, which is the SAME recipient-role atom under another
  intent — correctly gated, and OPTIONAL, so it binds nothing.
- **An unresolved role makes a flow `PARTIAL_PATH`.** `shape` is literally
  `gaps.length === 0`, so a holder flow with no stated entitlement and a
  destination flow of unrecognised kind both read PARTIAL_PATH. A
  presentation consequence of the two decisions, symmetric between them,
  pinned as S6 scenario A2.
- **Two established destinations are still two flows.** S7's existential
  rule is untouched by C4: a classifiable destination satisfies the
  relationship atom on its own flow while the opaque one keeps its own gap
  and is not among the atom's matched flows. Adding the opaque row never
  strengthens the world it was added to.
- **Memory remembers observations, not verdicts.** A bounded Proof still
  produces candidates; the memory row carries the passage's own statement
  and no status. Adoption re-runs S5/S6/S7 over the adopted rows, so a role
  that was never established is never inherited — proven with A's
  conclusions corrupted on disk before B ran.

## Not covered offline (real-provider / live-environment risk)

Tunnel flaps, provider rate limits at scale, real page structure drift,
Brave result quality, RPC provider divergence. These are what a live canary
is for; nothing deterministic in the Core is known open.
