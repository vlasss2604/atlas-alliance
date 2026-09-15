# Research Core hardening — adversarial offline coverage

What the Core is proven to refuse, where that proof lives, and which policy
lines are pinned but not decided. Current state only; history is in git.

## The adversarial suites

All are pure (no DB, no model, no network) and run the REAL S5 reducer over
the REAL Pattern v1 contract, then the REAL S6 assembler, S7 evaluator and
S8 proof builder — the production chain minus persistence.

| File | Job |
|---|---|
| `tests/adversarial-core-reducers-v1.test.ts` | Tries to make weak, wrong, stale, foreign, technical or merely documented evidence strengthen a conclusion. Sections A–G: identity/authority, typed chain facts, lifecycle, freshness, support/counter-evidence/absence, full-chain Proof, regressions for defects the suite found. |
| `tests/adversarial-core-boundaries-v1.test.ts` | Section N: attacks that held, kept as regressions. Section H: **documented boundaries** — behaviour that sits on a policy line; each case pins what the Core does today so a later Founder decision fails a named test rather than drifting. |
| `tests/adversarial-core-round2-v1.test.ts` | Round 2 — interactions and order: the same Evidence in every permutation (byte-identical S5/S6 flow ids/S7/S8), mixed pools (weak rows beside strong), temporal boundaries (`publishedAt == fetchedAt`, equal timestamps, undated vs dated), S7→S8 traceability, cross-stage idempotency, and a fresh pass on the Pattern→S7 contract, memory-candidate admission and projection labels. |

Every canonical invariant in `CORE_RULES.md` has at least one case: BUYBACK ≠
BURN, BURN ≠ NET DEFLATION, POINT-IN-TIME SUPPLY ≠ SUPPLY CHANGE, ABSENCE ≠
EVIDENCE OF ABSENCE, DOCUMENTED ≠ APPROVED ≠ ACTIVATED ≠ EXECUTING, ADDRESS
EXISTS ≠ ECONOMIC ROLE, WHERE ≠ WHO, TRANSACTION HAPPENED ≠ MECHANISM
EXECUTED, MEASUREMENT ≠ ATTRIBUTION, NOT_ESTABLISHED ≠ CONTRADICTED, DISCOVERY
≠ AUTHORITY, TECHNICAL FAILURE ≠ PROJECT REALITY.

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
| — | No owner path supersedes a PROJECT_IDENTITY (`ACTIVE_IDENTITY_EXISTS` refuses a second; token migration legacy → current has no lifecycle act); `resolveConfirmedIdentity` takes the oldest valid ACTIVE row if two ever exist. | An identity supersession script mirroring route classification. |

## Not covered offline (real-provider / live-environment risk)

Tunnel flaps, provider rate limits at scale, real page structure drift,
Brave result quality, RPC provider divergence. These are what a live canary
is for; nothing deterministic in the Core is known open.
