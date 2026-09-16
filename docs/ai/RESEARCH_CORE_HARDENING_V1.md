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
| `tests/adversarial-core-round5-blackbox-v1.test.ts` | Round 5 — the final result, black box: complete Research runs through the REAL S4 executor over deterministic documents (fixture proposer, search, fetcher, extractor; the real EVM adapter over a fixture RPC where a chain is involved), read only at the Proof. Families: strong vs weak authority; documentary vs on-chain (BUYBACK ≠ BURN, point-in-time supply ≠ change, APPROVED ≠ EXECUTING, transaction ≠ mechanism); partial research for every intent; technical failure beside valid Evidence; Memory vs fresh; project / token ambiguity; temporal; misleading language; exclusion pressure; bounded budgets; order independence; the independent review. |

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
- **Owner confirmations are serialized on the project row.** Identity
  confirmation, route confirmation and route classification run their
  check-then-act inside one transaction that locks the project row (the
  attempt claim's own pattern), so a second concurrent call re-reads and is
  refused (`ACTIVE_IDENTITY_EXISTS`, `DUPLICATE_ACTIVE_ROUTE`,
  `ROUTE_NOT_ACTIVE`) instead of producing a second ACTIVE row.

## Documented boundaries — Founder decision pending

Pinned by `adversarial-core-boundaries-v1.test.ts` section H. None is a
false SUPPORTED; each is a place where a different reasonable rule exists.

| Case | Current behaviour | The other reasonable rule |
|---|---|---|
| H1 | The INSUFFICIENT_AUTHORITY cap reads the NEWEST establishing row; an older CONFIRMED row beside a newer CLAIMED one still caps. | Cap only when NO establishing row is CONFIRMED (set-based, like INDIRECT_ONLY). Direction: strengthening. |
| H2 | LIVE beside an undated PROPOSED record of the same component is a state CONFLICT → CONTRADICTED; a required-component conflict → NOT_SUPPORTED (confidence capped LIMITED). | Treat PROPOSED as a lifecycle rung below LIVE (progression), not an incompatibility. |
| H3 | S6's lexical classifiers have no negation grammar ("not burned" → BURN). Accepted S6 audit limitation LOW-3; cannot create structure. | A negation stop-list on the closed dictionaries. |
| H4 | Recency wins over officiality in supersession (D-093 forbids an authority ranking). | Refuse supersession of a CONFIRMED row by a CLAIMED one. |
| H5 | ALL_EVIDENCE_EXCLUDED carries no confidence cap; gaps on the claim's own flow that block no atom are not a context gap. A single-atom SUPPORTED claim can sit at STRONG with every unrelated component unestablished. | Count own-flow non-blocking gaps as a STRONG cap. |
| H6 | An established DEPRECATED current state with no execution record is lifecycle NOT_ESTABLISHED → "is it current?" is INSUFFICIENT_EVIDENCE, not answered "no". | Let an established non-live CURRENT_STATE refute CURRENT without an execution record. |
| — | EXECUTION_EVIDENCE has `freshnessClass: MEDIUM_CHANGE` but `requiresCurrentState: false`, so age is never checked for it; "currently executing" is protected by CURRENT_STATE only. | Apply the freshness window to EXECUTION_EVIDENCE. |
| H7 (`round2` P5) | S8 citations are support-only: a NOT_SUPPORTED verdict from a state CONFLICT cites nothing; the contradicting rows are visible only as CONFLICTING_STATE gaps. | Cite contradicting rows on refutations. |
| — | No owner path supersedes a PROJECT_IDENTITY (`ACTIVE_IDENTITY_EXISTS` refuses a second, also under concurrency; token migration legacy → current has no lifecycle act, only a manual DEPRECATE plus a fresh confirmation); `resolveConfirmedIdentity` takes the oldest valid ACTIVE row if two ever exist, reachable only by direct SQL. Documentary memory verified under the old identity is refused after the replacement (H11, decided). | An identity supersession script mirroring route classification. |
| — (`round3` F1, `round3-5` L) | A Proof of a job planned under an earlier Pattern version cannot be verified once a later version is ACTIVE: `markProofVerified` refuses (`MissingActivePatternError`) and rolls back whole. Founder-confirmed as the safe rule; a product limitation, not a bug. | Verify under the version the job was planned under. |
| F8b (`round6-db`) | **NEW, Round 6, MAJOR-class.** With the chain UP a successful TOKEN_SUPPLY reading closes CURRENT_STATE's acquisition (`ONCHAIN_EVIDENCE_ESTABLISHED` returns before the documentary search); the component holds a supply level with no mechanism state (PARTIALLY_SUPPORTED / INSUFFICIENT_AUTHORITY) and "is it current?" is INSUFFICIENT. With the RPC DOWN the official current-state page is read and the same question is SUPPORTED: a technical failure reads stronger than a working chain, and MCS is unanswerable for every EVM project whose chain works (the live Lido shape). | The local fix — continue the documentary pass when the chain rows carry no state the component requires (`requiresCurrentState` / `requiresLiveMechanismState`) — was implemented and MEASURED: CURRENT_STATE becomes SUPPORTED on both rows, but the documentary row is a second slot beside the chain reading, the lineage forks at CURRENT_STATE under D-101, DESTINATION / RECIPIENT / NET_EFFECT / DURABILITY_BASIS become `BRANCH_ATTRIBUTION_UNRESOLVED`, and PRT-2 drops PARTIAL → UNSATISFIED on the live EVM shape. Two locked policies collide; **Founder decision required** (fix the pre-emption alone and accept the D-101 cost; or fix both under D-104's reopen clause; or keep today's behaviour). The change is reverted; the behaviour is pinned by name. |
| F1c / F2b (`round6`) | D-101 accepted limitation v1 in metamorphic form: a SECOND agreeing admissible row at a fork point (another official SOURCE_OF_VALUE or FLOW_PATH page, a weak CLAIMED governance row for SOURCE_OF_VALUE, four more distinct burn observations at EXECUTION_EVIDENCE) splits the lineage and the claim WEAKENS (PRT-2 / BSE-1 PARTIAL → UNSATISFIED, `BRANCH_ATTRIBUTION_UNRESOLVED`); five mirror sources of one passage are five slots, five identical flows and five citations. Never stronger; the error direction is over-splitting. | Slot identity that recognises one assembled element across sources (D-101 says this needs an extraction contract, not a classifier; D-104's reopen clause names "beta data showing the deferred limitation materially blocks correct assembly" — Round 6 F1c/F2c and the live B run are that data). Founder decision. |
| H1 (`round6` F6a2) | Metamorphic form: an AGREEING CLAIMED explorer row dated the same day as the official row demotes CURRENT_STATE from SUPPORTED to PARTIALLY_SUPPORTED (the cap reads the newest establishing row; the chain class sorts first at an equal date). Weaker, never stronger. | As H1. |
| H4 (`round6` F6c) | Metamorphic form: a NEWER CLAIMED explorer row saying LIVE beside an OLDER CONFIRMED official PAUSED supersedes it and moves "is it current?" from NOT_SUPPORTED to PARTIALLY_SUPPORTED on the weaker source. | As H4. |
| H5 (`round6` F12b, F1b) | Metamorphic form: adding ONLY inadmissible rows (social posts) to components that had nothing lifts a SUPPORTED single-atom Proof from LOW (20) to VERY_STRONG (80) with the same admissible evidence — bare absence caps at LOW, reasoned exclusion caps nothing. By Round 6's own criterion ("a confidence increase must be explained by newly admissible, relevant evidence") this is MAJOR-class; it is the pinned H5 boundary. | Cap ALL_EVIDENCE_EXCLUDED at LOW (or LIMITED) like absence. Founder decision. |
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
  excludes changes nothing but the exclusion record; an admissible-but-
  weaker row may only weaken (H1, H4, D-101 above).
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
  timeout, search budget, permanent 401) — except the F8b boundary above.
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

## Not covered offline (real-provider / live-environment risk)

Tunnel flaps, provider rate limits at scale, real page structure drift,
Brave result quality, RPC provider divergence. These are what a live canary
is for; nothing deterministic in the Core is known open.
