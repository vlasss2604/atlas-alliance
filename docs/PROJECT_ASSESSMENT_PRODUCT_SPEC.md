# PROJECT ASSESSMENT — future product extension spec

**Status: RECORDED, NOT ACTIVE.** This document records an owner product
decision about a *future* ATLAS PROOF extension — **EVIDENCE → PROMISES →
RISKS** — so that the vision survives outside chat. It is **not** approval to
implement anything in it. No table, engine, adapter, API route, migration or UI
described here exists, and none may be created without a separate scoped owner
task. The current Proof Core roadmap is unchanged and takes precedence.

Owner decision registered as **D-124** in `docs/DECISIONS.md`.

---

## 1. The core product invariant

> **NO CONCLUSION WITHOUT A TRACE.**

Every material user-facing conclusion must be traceable through an appropriate
subset of:

```
SOURCE → EVIDENCE → FACT → COMPONENT → RESULT → PROMISE ASSESSMENT / RISK SIGNAL
```

This applies to the Verdict, to every component state, to promise fulfillment
*and* promise failure, to every risk signal, and to every statement of material
uncertainty. A conclusion that cannot show its chain is not an ATLAS conclusion.

This is the product-level restatement of the research invariants already locked
in `docs/ai/CORE_RULES.md` (source ≠ evidence ≠ fact ≠ proof claim; absence
discipline; establishment rules; research brakes). The extension inherits those
invariants; it never restates or replaces them.

## 2. Dependency direction — the one structural law

```
EXISTING PROOF CORE
        ↓
CONFIRMED PROJECT STATE
        ↓
PROJECT ASSESSMENT
   ↙       ↓       ↘
Evidence  Promises  Risks
 Gaps                ↓
                    Watch
```

**Assessment consumes Proof. Assessment does not manage Proof.**

Forbidden dependency: `Project Assessment → Proof Engine`. The assessment layer
must never control, override, rewrite, re-run, re-weight or independently
replace Proof logic. If an assessment needs research done, it may *request* an
ordinary Proof through the ordinary front door — the same admission, budget,
entitlement and pipeline every Proof gets — and then consume the result. It may
never grow a private research path.

Concretely, in the current codebase this means: nothing in a future assessment
layer imports from `src/server/engine/` execution internals to drive them; it
reads persisted results (`research_component_results`,
`research_mechanism_assembly`, `research_claim_support`, `evidence`, `proofs`,
`proof_gaps`) and project memory, and writes only its own artifacts.

## 3. Mapping onto the EXISTING architecture (verified 2026-08-28)

The future spec deliberately reuses conceptual names — Project, Source,
Evidence, Proof — that already have canonical implementations. **No duplicate
entity may be created for any of them.** Verified against the repository at the
time of recording:

| Future concept | Existing canonical home | Notes |
|---|---|---|
| Project | `projects` (`src/server/db/schema/catalog.ts`) | The catalog. Scope ≠ Entitlement already holds. |
| Project identity | `PROJECT_IDENTITY` in `project_memory_items` | Human-confirmed ACTIVE row; chain + mint. D-133. |
| Source | `sources` + `source-authority.ts` + `SOURCE_ROUTE` memory | Two-axis authority (sourceClass / officiality), route confirmation and classification are separate owner acts. |
| Evidence | `evidence` (+ `evidence_documentary_locators`) | Two-axis authority, entity binding as third axis, validated locators as child rows. |
| Fact / reconciliation | Pattern v1 (`research_patterns` as data) + S5 → `research_component_results` | Closed reason-code and exclusion-reason dictionaries. |
| Mechanism / claim view | S6 `research_mechanism_assembly` (flows + `unassignedGaps`), S7 `research_claim_support` (incl. `contextGaps`) | Derived projections; replay-idempotent by design. |
| Proof | `proofs` (verdict, confidence 0–100, locked 7-layer `layers`) | The 7-layer structure already includes a mandatory "what could change the conclusion" block. |
| Evidence gaps | `proof_gaps` + S6 `unassignedGaps` + S7 `contextGaps` | The Gaps concept already exists in three graded forms; the extension exposes, not reinvents. |
| Verified durable knowledge | `research_memory` (D-041 promotion gate) | Only VERIFIED outcomes become durable memory — unchanged. |
| Bounded research budgets | `budget_demo`, `budget_core`, `INTERNAL_ALPHA_V1` (`src/server/config/product.ts`) | Numeric budgets are already owned by existing architecture. This spec records the product rule only and introduces **no new constants**. |
| Operational trace | `research_trace_events` | TRACE ≠ EVIDENCE (D-115/D-116) — the trace exposed to users in Phase B is the *evidence chain*, never the operational/provider trace. |

**Component states remain exactly** (`component_reconciliation_status`,
D-092):

```
SUPPORTED · PARTIALLY_SUPPORTED · CONTRADICTED · INSUFFICIENT_EVIDENCE
```

`NOT_APPLICABLE` is deliberately absent from component states and **must not be
introduced** — D-092 records why: it would become a place to hide missing
evidence rather than report it honestly.

One mapping honesty note: a separate, older Proof-level `verdict` enum (Phase 1)
does contain `NOT_SUPPORTED` and `NOT_APPLICABLE`. That enum is pre-existing and
untouched by this spec. The constraint above is about **component reconciliation
states**; nothing in the future extension may leak `NOT_APPLICABLE` from the
verdict enum into component semantics.

## 4. Future phase order

Adapted to what already exists. Phases are sequential intent, not scheduled
work; none is authorized by this document.

### PHASE A — PROOF CORE *(current roadmap — active now)*
Evidence, provenance, component reconciliation, mechanism state, Pattern,
Memory, bounded research. Everything else waits for this.

### PHASE B — RESEARCH TRACE *(first mandatory post-core product layer)*
Expose, for every user-visible Proof step:

```
Component → Evidence → Result → Explanation
```

Every user-visible Proof step must be expandable back to source and evidence.
**The data already exists at rest** — `research_component_results` carries
`supportingEvidenceIds`, `contradictingEvidenceIds` and `excludedEvidence`
(closed reasons) per (job, step, component), and D-123 already built a bounded
owner-facing read of S7/S6/Evidence. Phase B is therefore an *exposure and
product-language* problem, not a data-model problem.

### PHASE C — PROJECT MEMORY / PROOF ASSOCIATION
**Do NOT create a second Project entity.** Extend the current `projects` +
`PROJECT_IDENTITY` architecture so Proofs and future assessments accumulate
against the canonical project. (Proofs already carry `projectId`; this phase is
about accumulation and presentation, not new keys.)

### PHASE D — PROMISE v0
Minimal Promise model (see §7). Promise is **not** an independent research
engine.

### PHASE E — PROJECT ASSESSMENT v0
One post-Proof layer containing: Evidence Summary · Evidence Gaps · Promise
Summary · Risk Signals · Watch Items.

### PHASE F — RISK v0
A small deterministic / strongly constrained rule set only. **No general
autonomous AI Risk Engine.**

### PHASE G — EXTERNAL SOURCE ADAPTERS
X, governance forums, official blogs, etc. **Adapters discover candidates. They
do not establish truth by themselves.** Everything an adapter surfaces enters
the same authority/evidence discipline as any other source, or it establishes
nothing.

## 5. Research trace (Phase B contract)

The future user result must expose the actual component path:

```
CLAIM
 ↓
COMPONENT 1 → RESULT → EVIDENCE → SOURCE → EXPLANATION
COMPONENT 2 → RESULT → …
 ↓
VERDICT
```

Rules:

- A component that reaches `INSUFFICIENT_EVIDENCE` must **still be
  represented** — an unanswered question is part of the result, not a rendering
  omission.
- One component failing to establish does **not** stop the rest of the Pattern.
- No infinite research loops — the existing stopping architecture (§6) is the
  guarantee, and Phase B adds no research behaviour at all.

## 6. Bounded research (product rule, not new constants)

The existing stopping philosophy is preserved verbatim:

```
SEARCH → EVALUATE → ENOUGH EVIDENCE?
                       YES → reconcile
                       NO  → INSUFFICIENT_EVIDENCE
        → NEXT COMPONENT
```

`INSUFFICIENT_EVIDENCE` is a valid, successful outcome when the missing bridge
is named correctly (CLAUDE.md; CORE_RULES "Research brakes"). Numeric budgets
already exist and are owned by existing architecture (`budget_demo`,
`budget_core`, `INTERNAL_ALPHA_V1`); this spec introduces **no new numbers**
and records only the rule: research stops when the question is answered or the
bounded budget is spent, and the stop is reported honestly.

## 7. Promise model (Phase D)

A **Promise** is a tracked public commitment — not marketing language.

Conceptual future fields (schema deliberately **not frozen** now):

- `id`, `projectId` (the canonical project — never a new entity)
- `statement`
- source reference (through the existing source/authority discipline)
- `announcedAt`, `promisedBy`, `deadline` (if any)
- `verificationCriteria`
- `lifecycleState`
- `linkedProofIds`
- `latestAssessment`

**Lifecycle and assessment are separate concepts** and must remain so:

- Candidate lifecycle vocabulary: `DETECTED → TRACKING → DUE → CLOSED`
- Candidate assessment vocabulary: `FULFILLED · PARTIALLY_FULFILLED · BROKEN ·
  INSUFFICIENT_EVIDENCE`

All names are **provisional until implementation**.

### Promise candidates

Automated external-source discovery (Phase G) initially produces a
**PROMISE_CANDIDATE**, never a confirmed Promise. Confirmation is a separate
act, same discipline as route confirmation vs classification.

A verifiable commitment:

> "Starting next month, 50% of protocol revenue will be used for buybacks."

Non-verifiable marketing language:

> "We are building the future of DeFi."

The latter is **not** a Promise and must not be tracked as one.

### Promise verification

**A Promise does not prove itself.** Assessment consumes Proof Engine results:

```
PROMISE → VERIFICATION CRITERIA → LINKED PROOF / COMPONENT RESULTS → ASSESSMENT
```

A Promise implementation may request/associate an ordinary Proof later, through
the ordinary front door, but must never grow a parallel research engine.

## 8. Evidence Summary and Evidence Gaps (Phase E)

Project Assessment eventually exposes, **separately**:

- **WHAT IS PROVEN** — established results with their traces.
- **WHAT IS NOT PROVEN** — named gaps.

The second must never convert absence of evidence into a negative fact
(CORE_RULES "Absence"). Preferred wording patterns:

- "insufficient evidence"
- "not confirmed by available evidence"
- "remains unconfirmed"
- "sufficient evidence was not found"

Forbidden inference, recorded as the canonical example:

> NO EVIDENCE OF BUYBACK → ~~"BUYBACK DOES NOT EXIST"~~

## 9. Risk signals (Phase F)

Risk lives **inside** Project Assessment. A RiskSignal may derive **only**
from:

- confirmed facts
- contradictions
- material Evidence gaps
- Promise history
- established mechanism state

**No autonomous risk research loop in v0.** Every RiskSignal must carry an
`explanationTrace` back to facts / evidence / proofs — the §1 invariant applied
to risk.

### No magic risk score

Explicitly forbidden in v0:

> ~~PROJECT RISK SCORE: N/100~~

No pseudo-precision. Show concrete named risks and their causal trace instead.

### Initial risk families (future categories only — not implementation)

1. Evidence / Transparency Risk
2. Promise Execution Risk
3. Dilution / Supply Risk
4. Supply Return Risk
5. Governance / Mechanism Change Risk
6. Revenue Durability / Concentration Risk

### Materiality

Not every `INSUFFICIENT_EVIDENCE` result becomes a RiskSignal:

```
INSUFFICIENT_EVIDENCE
        ↓
MATERIAL TO CLAIM / MECHANISM?
   NO               YES
   ↓                 ↓
Evidence Gap      Risk candidate
```

Materiality must itself be traceable and constrained. **Do not invent a
universal severity scoring system** — that is the risk-score mistake wearing a
different name.

## 10. Watch items (Phase E output)

Watch items are Project Assessment outputs — **not a separate Trigger Engine in
v0**. Candidate event kinds:

- promise deadline
- unlock
- governance vote
- mechanism expiry
- planned burn
- vesting event

They describe events capable of changing the **proven** project state. They are
**not trading alerts**. (The existing Proof layer's mandatory "what could
change the conclusion" block is the conceptual ancestor.)

## 11. Product invariants recorded here

### No investment advice

ATLAS must not output: `BUY`, `SELL`, `HOLD`, `INVEST`, `AVOID`, `SAFE`,
`GOOD PROJECT`, `BAD PROJECT`, price targets, ROI forecasts, or trading
signals.

> **ATLAS shows the evidence-backed state of reality and associated risks.
> The human makes the capital decision.**

### Evidence coverage ≠ project quality

- **High evidence coverage** means the project/mechanism is *observable*. It
  does **not** mean the economics are good.
- **Low evidence coverage** means ATLAS cannot confirm critical elements. It
  does **not** automatically mean the project is bad, fraudulent or deceptive.

Future UI must keep Evidence Coverage and Risk Signals **visually and
semantically separate**.

## 12. Testing vision (pre-rollout gate)

Before Project Assessment production rollout: a diverse benchmark set of **at
least 10 projects** — mature/transparent, medium evidence coverage, young, and
extremely sparse. (Not selected and not researched by this document.)

Tests must verify:

- complete component traversal
- bounded stopping
- no invented Evidence
- `CONTRADICTED` vs `INSUFFICIENT_EVIDENCE` correctness
- traceability of the Verdict
- traceability of every Risk
- gaps do not automatically become high risk
- no investment advice in any output
- a simple user explanation remains possible

## 13. What this document does NOT authorize

No Promise tables, no Risk tables, no Watch tables, no ProjectAssessment
tables, no new engines, no X/external adapters, no UI, no migrations, no API
routes, and no change to current Raydium / Proof research behaviour. Any step
out of this list is a new scoped owner task with its own decision entry.
