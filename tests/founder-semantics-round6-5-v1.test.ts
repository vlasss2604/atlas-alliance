import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor, type PatternContent } from "../src/server/domain/pattern";
import { evaluateClaimSupport, type ClaimSupportResult } from "../src/server/engine/claim-evaluator";
import {
  reconcileComponent,
  type AcquisitionBoundary,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { assembleMechanism, type AssemblyEvidenceProjection, type MechanismAssemblyResult } from "../src/server/engine/mechanism-assembler";
import { buildProof, type ProofDraft } from "../src/server/engine/proof-builder";
import { computeProofConfidence } from "../src/server/engine/proof-confidence";

// ROUND 6.5 — FOUNDER SEMANTIC HARDENING, THE PURE CHAIN.
//
// Round 6 (metamorphic) closed NOT CLEAN on three boundaries the Founder
// decided on 2026-09-16. This suite pins the decided semantics over the
// REAL S5 -> S6 -> S7 -> S8 chain and the real Pattern v1 contract:
//
//   2. EXCLUDED EVIDENCE != CONFIDENCE (H5). Adding only excluded /
//      inadmissible rows to a control never leaves the Proof stronger than
//      the control on verdict, support, confidence or citations. Cases
//      C, D, E.
//   3. MORE AGREEING ADMISSIBLE EVIDENCE != WEAKER PROOF (D-101
//      over-splitting). A second admissible, agreeing row at a fork point
//      never weakens the claim merely because the lineage forks; a weaker
//      result needs a real semantic reason the existing rules already
//      define (contradiction, temporal incompatibility, identity, scope).
//      Cases F, G, H, I.
//
// Decision 1 (F8b, TECHNICAL FAILURE != STRONGER PROJECT REALITY) lives in
// the executor and is pinned in founder-semantics-round6-5-db-v1.
//
// Not an adversarial round; does not count toward the two clean rounds.
// Pure: no DB, no model, no network.

const JOB = "dddddddd-0000-4000-8000-000000000065";
const OTHER_JOB = "eeeeeeee-0000-4000-8000-000000000066";
const NOW = new Date("2026-09-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const FRESHNESS = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };

const STEP_OF: Record<string, number> = {
  SOURCE_OF_VALUE: 1,
  FLOW_PATH: 2,
  MECHANISM_SPEC: 3,
  GOVERNANCE_BASIS: 3,
  EXECUTION_EVIDENCE: 4,
  CURRENT_STATE: 5,
  DESTINATION: 6,
  RECIPIENT: 6,
  NET_EFFECT: 7,
  DURABILITY_BASIS: 8,
};
const ALL_COMPONENTS = Object.keys(STEP_OF);
const INTENTS = [
  "PROTOCOL_REVENUE_TO_TOKEN",
  "PASSIVE_HOLDER_OUTCOME",
  "REWARD_SOURCE",
  "BURN_OR_SUPPLY_EFFECT",
  "MECHANISM_CURRENT_STATE",
  "USAGE_TO_TOKEN_LINKAGE",
  "VALUE_CAPTURE",
  "TOKEN_UTILITY",
] as const;

let seq = 0;
function row(component: string, overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = overrides.id ?? `r${String(seq).padStart(4, "0")}-0000-4000-8000-000000000065`;
  const sourceClass = overrides.sourceClass ?? "OFFICIAL_DOCS";
  const confirmedByClass = sourceClass === "OFFICIAL_DOCS" || sourceClass === "OFFICIAL_REPORT";
  return {
    id,
    researchJobId: JOB,
    sourceId: overrides.sourceId ?? `src-${id}`,
    evidenceContractVersion: 2,
    patternStep: STEP_OF[component],
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: "protocol fees paid by users are distributed to token holders",
    summary: null,
    mechanismState: null,
    sourceClass,
    officiality: confirmedByClass ? "CONFIRMED" : "CLAIMED",
    entityBinding: sourceClass === "ONCHAIN_VERIFIABLE" ? "CONFIRMED" : null,
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: new Date(NOW.getTime() - 1 * DAY),
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}
const confirmed = (component: string, o: Partial<EvidenceRow>): EvidenceRow => row(component, { officiality: "CONFIRMED", ...o });

function projection(r: EvidenceRow): AssemblyEvidenceProjection {
  return {
    id: r.id,
    sourceId: r.sourceId,
    extractionUnitKey: r.extractionUnitKey,
    sourceClass: r.sourceClass,
    officiality: r.officiality,
    mechanismState: r.mechanismState,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    fragment: r.fragment,
    summary: r.summary,
    retrievedUrl: `https://docs.example-project.test/${r.id}`,
    contentHash: r.contentHash,
  };
}

interface ChainResult {
  results: ComponentReconciliationResult[];
  assembly: MechanismAssemblyResult;
  claim: ClaimSupportResult;
  proof: ProofDraft;
  byComponent: Map<string, ComponentReconciliationResult>;
  pool: EvidenceRow[];
}

function runChain(intent: string, pool: EvidenceRow[], opts: { pattern?: PatternContent; boundaries?: Record<string, AcquisitionBoundary> } = {}): ChainResult {
  const pattern = opts.pattern ?? PATTERN_V1_CONTENT;
  const results = ALL_COMPONENTS.map((component) =>
    reconcileComponent({
      jobId: JOB,
      item: { step: STEP_OF[component], component },
      requirements: { component, ...componentRequirementsFor(pattern, component) },
      evidence: pool.filter((r) => r.component === component),
      confirmedIdentity: null,
      acquisitionBoundary: opts.boundaries?.[component] ?? null,
      now: NOW,
      freshnessPolicyDays: FRESHNESS,
    }),
  );
  const admitted = new Set(results.flatMap((r) => [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds]));
  const assembly = assembleMechanism({
    researchJobId: JOB,
    patternVersion: 1,
    pattern,
    contractView: { patternVersion: 1 },
    componentResults: results,
    admittedEvidence: pool.filter((r) => admitted.has(r.id)).map(projection),
  });
  const claim = evaluateClaimSupport({ researchJobId: JOB, patternVersion: 1, pattern, intent, taskType: null, requirementSetVersion: 1, assembly });
  const built = buildProof({
    researchJobId: JOB,
    claimSupport: { intent, status: claim.status, reasonCodes: claim.reasonCodes, requirementResults: claim.requirementResults, contextGaps: claim.contextGaps },
    componentResults: results.map((r) => ({ step: r.step, component: r.component, status: r.status, reasonCodes: r.reasonCodes, supportingEvidenceIds: r.supportingEvidenceIds, excludedEvidence: r.excludedEvidence })),
    existingEvidenceIds: pool.map((r) => r.id),
  });
  return { results, assembly, claim, proof: built.proof!, byComponent: new Map(results.map((r) => [r.component, r])), pool };
}

const VERDICT_RANK: Record<string, number> = { NOT_SUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const STATUS_RANK: Record<string, number> = { CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const REQ_RANK: Record<string, number> = { CONTRADICTED: 0, UNSATISFIED: 0, PARTIAL: 1, SATISFIED: 2 };

// The conclusion, without row identities: what the Founder's relations
// compare.
function conclusion(c: ChainResult) {
  return {
    verdict: c.proof.verdict,
    confidence: c.proof.confidenceScore,
    binding: c.proof.confidenceBindingReasons,
    claim: c.claim.status,
    reqs: c.claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`),
    s5: c.results.map((r) => ({ c: r.component, status: r.status, reasonCodes: r.reasonCodes, currentState: r.currentState })),
    lifecycle: [...new Set(c.assembly.flows.map((f) => f.lifecycle))].sort(),
    gaps: [...new Set(c.proof.gaps.filter((g) => !g.origin.startsWith("COMPONENT_EXCLUSION")).map((g) => `${g.origin}|${g.kind}|${g.component ?? ""}`))].sort(),
  };
}
// The same, with every absence-shaped diagnostic folded into one word:
// NO_EVIDENCE_FOUND, the acquisition boundaries and the four exclusion-
// shaped codes all say "nothing establishes this component" — WHY is
// diagnostic (Founder decision 2: excluded evidence may stay visible in
// the audit surface), and it is exactly what an inadmissible addition is
// allowed to change.
const ABSENCE_SHAPED = new Set(["NO_EVIDENCE_FOUND", "SEARCH_BUDGET_EXHAUSTED", "NO_ADMISSIBLE_ROUTE", "EXTRACTION_NOT_COMPLETED", "ALL_EVIDENCE_EXCLUDED", "MISSING_CURRENT_STATE", "STALE_CURRENT_STATE", "MISSING_EXECUTION_EVIDENCE"]);
const fold = (code: string) => (ABSENCE_SHAPED.has(code) ? "ABSENCE" : code);
function strength(c: ChainResult) {
  const k = conclusion(c);
  return {
    ...k,
    binding: [...new Set(k.binding.map(fold))].sort(),
    s5: k.s5.map((r) => ({ ...r, reasonCodes: [...new Set(r.reasonCodes.map(fold))].sort() })),
    gaps: [...new Set(k.gaps.map((g) => { const [o, kind, comp] = g.split("|"); return `${o}|${fold(kind)}|${comp}`; }))].sort(),
  };
}
// t is no stronger than c on any axis (the Round 6 relation).
function noStrongerThan(t: ChainResult, c: ChainResult, label = ""): void {
  expect(VERDICT_RANK[t.proof.verdict!], `${label} verdict ${t.proof.verdict} vs ${c.proof.verdict}`).toBeLessThanOrEqual(VERDICT_RANK[c.proof.verdict!]);
  if (t.proof.verdict === c.proof.verdict) expect(t.proof.confidenceScore, `${label} confidence`).toBeLessThanOrEqual(c.proof.confidenceScore);
  for (const r of t.results) expect(STATUS_RANK[r.status], `${label} ${r.component}`).toBeLessThanOrEqual(STATUS_RANK[c.byComponent.get(r.component)!.status]);
  for (const q of t.claim.requirementResults) {
    const ref = c.claim.requirementResults.find((x) => x.requirementId === q.requirementId)!;
    expect(REQ_RANK[q.status], `${label} ${q.requirementId} ${q.status} vs ${ref.status}`).toBeLessThanOrEqual(REQ_RANK[ref.status]);
  }
}
// t is no WEAKER than c on any axis (the Round 6.5 relation for agreeing
// admissible additions).
function noWeakerThan(t: ChainResult, c: ChainResult, label = ""): void {
  expect(VERDICT_RANK[t.proof.verdict!], `${label} verdict ${t.proof.verdict} vs ${c.proof.verdict}`).toBeGreaterThanOrEqual(VERDICT_RANK[c.proof.verdict!]);
  if (t.proof.verdict === c.proof.verdict) expect(t.proof.confidenceScore, `${label} confidence`).toBeGreaterThanOrEqual(c.proof.confidenceScore);
  for (const r of t.results) expect(STATUS_RANK[r.status], `${label} ${r.component}`).toBeGreaterThanOrEqual(STATUS_RANK[c.byComponent.get(r.component)!.status]);
  for (const q of t.claim.requirementResults) {
    const ref = c.claim.requirementResults.find((x) => x.requirementId === q.requirementId)!;
    expect(REQ_RANK[q.status], `${label} ${q.requirementId} ${q.status} vs ${ref.status}`).toBeGreaterThanOrEqual(REQ_RANK[ref.status]);
  }
}
function provenanceHolds(c: ChainResult): void {
  const supporting = new Set(c.results.flatMap((r) => r.supportingEvidenceIds));
  const excluded = new Set(c.results.flatMap((r) => r.excludedEvidence.map((e) => e.evidenceId)));
  const contradicting = new Set(c.results.flatMap((r) => r.contradictingEvidenceIds));
  for (const id of c.proof.citedEvidenceIds) {
    expect(supporting.has(id), `cited ${id} not supporting`).toBe(true);
    expect(excluded.has(id), `cited ${id} excluded`).toBe(false);
    expect(contradicting.has(id), `cited ${id} contradicting`).toBe(false);
  }
  const foreign = new Set(c.pool.filter((r) => r.researchJobId !== JOB).map((r) => r.id));
  for (const id of [...supporting, ...contradicting, ...c.proof.citedEvidenceIds]) expect(foreign.has(id), `foreign ${id} admitted`).toBe(false);
}
const older = (days: number) => new Date(NOW.getTime() - days * DAY);
const exclusionOf = (r: ComponentReconciliationResult, id: string) => r.excludedEvidence.find((e) => e.evidenceId === id)?.reason ?? null;

// THE CONTROL — the Round 6 world: a coherent, fully sourced fee -> holders
// mechanism (SOURCE_OF_VALUE at the D-158 partial rung, NET_EFFECT at the
// B1 rung).
function world(): EvidenceRow[] {
  return [
    row("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users generate the revenue" }),
    row("FLOW_PATH", { fragment: "fee revenue is routed from the fee collector to the distributor contract" }),
    row("MECHANISM_SPEC", { fragment: "50% of protocol fees are distributed to token holders weekly", mechanismState: "LIVE" }),
    confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", fragment: "the proposal to distribute fees passed", mechanismState: "APPROVED" }),
    confirmed("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null }),
    row("CURRENT_STATE", { fragment: "the fee distribution is live", mechanismState: "LIVE" }),
    row("DESTINATION", { fragment: "fees are distributed to token holders via the distributor" }),
    row("RECIPIENT", { fragment: "token holders receive the distributed fees" }),
    confirmed("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", publishedAt: null }),
    confirmed("DURABILITY_BASIS", { sourceClass: "GOVERNANCE", fragment: "the distribution can be revoked by a governance vote", mechanismState: "APPROVED" }),
  ];
}
// The Round 6 F12b world: a single-atom SUPPORTED Proof (PASSIVE_HOLDER_
// OUTCOME) with seven components holding nothing — the shape that exposed
// H5.
function singleAtomWorld(): EvidenceRow[] {
  return [
    row("RECIPIENT", { fragment: "token holders receive the distributed fees" }),
    confirmed("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null }),
    row("CURRENT_STATE", { mechanismState: "LIVE" }),
  ];
}
const SINGLE_ATOM_HOLDING = ["RECIPIENT", "EXECUTION_EVIDENCE", "CURRENT_STATE"];

// Case E's catalogue — every class of row S5 excludes, each with the
// exclusion reason it must be recorded under.
function excludedRowsFor(component: string): { label: string; row: EvidenceRow; reason: string }[] {
  const state = ["MECHANISM_SPEC", "EXECUTION_EVIDENCE", "CURRENT_STATE"].includes(component) ? "LIVE" : component.endsWith("_BASIS") ? "APPROVED" : null;
  const at = older(2);
  return [
    { label: "wrong project (another job's row)", row: row(component, { researchJobId: OTHER_JOB, mechanismState: state, publishedAt: at }), reason: "FOREIGN_JOB" },
    { label: "wrong chain (explorer page bound UNVERIFIED)", row: row(component, { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", entityBinding: "UNVERIFIED", onchainFactKind: "BURN", mechanismState: state, publishedAt: null }), reason: "ENTITY_NOT_CONFIRMED" },
    { label: "stale documentary", row: row(component, { mechanismState: state, publishedAt: older(200) }), reason: component === "CURRENT_STATE" ? "STALE_FOR_CURRENT_STATE" : "" },
    { label: "wrong source class (social)", row: row(component, { sourceClass: "SOCIAL", officiality: "CLAIMED", mechanismState: state, publishedAt: at }), reason: "CLASS_NOT_ADMISSIBLE" },
    { label: "wrong source class (research media)", row: row(component, { sourceClass: "RESEARCH_MEDIA", officiality: "CLAIMED", mechanismState: state, publishedAt: at }), reason: "CLASS_NOT_ADMISSIBLE" },
    { label: "wrong source class (data provider)", row: row(component, { sourceClass: "DATA_PROVIDER", officiality: "CLAIMED", mechanismState: state, publishedAt: at }), reason: "CLASS_NOT_ADMISSIBLE" },
    { label: "unconfirmed entity (chain observation, no binding)", row: row(component, { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", entityBinding: null, onchainFactKind: "BURN", mechanismState: state, publishedAt: null }), reason: "ENTITY_NOT_CONFIRMED" },
    { label: "superseded route (source with no class any more)", row: row(component, { sourceClass: null, officiality: "CLAIMED", mechanismState: state, publishedAt: at }), reason: "CLASS_NOT_ADMISSIBLE" },
  ];
}

// ====================================================================
describe("Decision 2 — EXCLUDED EVIDENCE != CONFIDENCE (H5)", () => {
  it("C. control Proof + ONE excluded row: the band never rises — the Round 6 F12b shape (20 -> 80 on a social post) now reads 20 -> 20, the exclusion is recorded, nothing is cited, and the conclusion is the control's", () => {
    const base = singleAtomWorld();
    const control = runChain("PASSIVE_HOLDER_OUTCOME", base);
    expect(control.proof.verdict).toBe("SUPPORTED");
    expect(control.proof.confidenceScore).toBe(20);
    for (const component of ALL_COMPONENTS.filter((c) => !SINGLE_ATOM_HOLDING.includes(c))) {
      const tweet = row(component, { sourceClass: "SOCIAL", officiality: "CLAIMED" });
      const t = runChain("PASSIVE_HOLDER_OUTCOME", [...base, tweet]);
      expect(t.byComponent.get(component)!.reasonCodes, component).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
      expect(exclusionOf(t.byComponent.get(component)!, tweet.id), component).toBe("CLASS_NOT_ADMISSIBLE");
      expect(t.proof.confidenceScore, component).toBeLessThanOrEqual(control.proof.confidenceScore);
      expect(strength(t), component).toEqual(strength(control));
      expect(t.proof.citedEvidenceIds).toEqual(control.proof.citedEvidenceIds);
      // Visible in the audit surface, absent from the strength.
      expect(t.proof.gaps.some((g) => g.component === component && g.kind === "ALL_EVIDENCE_EXCLUDED")).toBe(true);
      expect(t.proof.confidenceBindingReasons).toContain("ALL_EVIDENCE_EXCLUDED");
      provenanceHolds(t);
    }
  });

  it("D. control Proof + MANY excluded rows (every empty component, five social posts each): the band never rises, the conclusion is the control's", () => {
    const base = singleAtomWorld();
    const control = runChain("PASSIVE_HOLDER_OUTCOME", base);
    const tweets = ALL_COMPONENTS.filter((c) => !SINGLE_ATOM_HOLDING.includes(c)).flatMap((c) =>
      Array.from({ length: 5 }, (_, i) => row(c, { sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: `post ${i} about ${c}` })),
    );
    const t = runChain("PASSIVE_HOLDER_OUTCOME", [...base, ...tweets]);
    expect(t.proof.verdict).toBe("SUPPORTED");
    expect(t.proof.confidenceScore).toBe(20);
    expect(strength(t)).toEqual(strength(control));
    expect(t.proof.citedEvidenceIds).toEqual(control.proof.citedEvidenceIds);
    for (const tw of tweets) expect(t.proof.citedEvidenceIds).not.toContain(tw.id);
    provenanceHolds(t);
    // And over the full control world, for every intent: the same many
    // excluded rows on every component change nothing.
    for (const intent of INTENTS) {
      const full = world();
      const c = runChain(intent, full);
      const many = ALL_COMPONENTS.flatMap((comp) => Array.from({ length: 3 }, () => row(comp, { sourceClass: "SOCIAL", officiality: "CLAIMED", publishedAt: older(2) })));
      const w = runChain(intent, [...full, ...many]);
      expect(strength(w), intent).toEqual(strength(c));
      expect(w.proof.citedEvidenceIds.length, intent).toBe(c.proof.citedEvidenceIds.length);
    }
  });

  it("E. excluded rows of every class — wrong project, wrong chain, stale, wrong source class, unconfirmed entity, superseded route — one at a time and all at once, on every empty component: none raises the band, each is recorded under its reason, the conclusion is the control's", () => {
    const base = singleAtomWorld();
    const control = runChain("PASSIVE_HOLDER_OUTCOME", base);
    const empties = ALL_COMPONENTS.filter((c) => !SINGLE_ATOM_HOLDING.includes(c));
    // CURRENT_STATE holds a fresh row in this world; the stale and other
    // excluded classes are also offered beside it (a component that HAS
    // support must not gain from excluded neighbours either).
    const actuallyExcluded: EvidenceRow[] = [];
    for (const component of [...empties, "CURRENT_STATE"]) {
      for (const k of excludedRowsFor(component)) {
        const t = runChain("PASSIVE_HOLDER_OUTCOME", [...base, k.row]);
        const s5 = t.byComponent.get(component)!;
        const label = `${component} / ${k.label}`;
        if (k.row.researchJobId !== JOB) {
          expect(s5.supportingEvidenceIds, label).not.toContain(k.row.id);
        } else if (s5.supportingEvidenceIds.includes(k.row.id)) {
          // Admitted, not excluded: "stale" is a freshness-gate notion and
          // only CURRENT_STATE carries one in Pattern v1, so a 200-day-old
          // official statement is admissible elsewhere; and DATA_PROVIDER
          // is an establishing class for NET_EFFECT. An admissible row on
          // an EMPTY component legitimately establishes it — not this
          // decision's subject (the full-world loop below covers admitted
          // additions under Round 6's relation).
          continue;
        } else {
          // The class gate runs first: a chain observation offered to a
          // component whose Pattern admits no ONCHAIN_VERIFIABLE is refused
          // on class before its binding is ever asked.
          // A stale row beside a fresh state-bearing one is recorded under
          // supersession (D-093 runs first), as case I pins.
          expect([k.reason, "CLASS_NOT_ADMISSIBLE", "SUPERSEDED_BY_NEWER"], label).toContain(exclusionOf(s5, k.row.id));
          actuallyExcluded.push(k.row);
        }
        expect(t.proof.confidenceScore, label).toBeLessThanOrEqual(control.proof.confidenceScore);
        expect(strength(t), label).toEqual(strength(control));
        expect(t.proof.citedEvidenceIds, label).toEqual(control.proof.citedEvidenceIds);
        provenanceHolds(t);
      }
    }
    expect(actuallyExcluded.length).toBeGreaterThan(30);
    const t = runChain("PASSIVE_HOLDER_OUTCOME", [...base, ...actuallyExcluded]);
    expect(t.proof.confidenceScore).toBe(control.proof.confidenceScore);
    expect(strength(t)).toEqual(strength(control));
    expect(t.proof.citedEvidenceIds).toEqual(control.proof.citedEvidenceIds);
  });

  it("E2. the stale-only shapes by name: a stale current-state row alone (STALE_CURRENT_STATE), undated rows alone (MISSING_CURRENT_STATE) and excluded execution rows alone (MISSING_EXECUTION_EVIDENCE) sit exactly where bare absence sits — never above it, never below it", () => {
    const base = world().filter((r) => r.component !== "CURRENT_STATE" && r.component !== "EXECUTION_EVIDENCE");
    for (const intent of INTENTS) {
      const absent = runChain(intent, base);
      const shapes: { label: string; rows: EvidenceRow[]; code: string }[] = [
        { label: "stale current state", rows: [row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: older(200) })], code: "STALE_CURRENT_STATE" },
        { label: "undated current state", rows: [row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: null })], code: "MISSING_CURRENT_STATE" },
        { label: "unbound execution observation", rows: [row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", entityBinding: "UNVERIFIED", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null })], code: "MISSING_EXECUTION_EVIDENCE" },
      ];
      for (const s of shapes) {
        const t = runChain(intent, [...base, ...s.rows]);
        const comp = s.rows[0].component!;
        expect(t.byComponent.get(comp)!.reasonCodes, `${intent} ${s.label}`).toEqual([s.code]);
        expect(absent.byComponent.get(comp)!.reasonCodes, `${intent} ${s.label}`).toEqual(["NO_EVIDENCE_FOUND"]);
        expect(t.proof.verdict, `${intent} ${s.label}`).toBe(absent.proof.verdict);
        expect(t.proof.confidenceScore, `${intent} ${s.label}`).toBe(absent.proof.confidenceScore);
        expect(t.claim.requirementResults.map((r) => r.status), `${intent} ${s.label}`).toEqual(absent.claim.requirementResults.map((r) => r.status));
      }
    }
  });

  it("E3. the comparative rule at the band function itself: for every verdict, an exclusion-shaped absence scores exactly what bare absence scores, alone and beside every other cap", () => {
    const EXCLUSION_SHAPED = ["ALL_EVIDENCE_EXCLUDED", "MISSING_CURRENT_STATE", "STALE_CURRENT_STATE", "MISSING_EXECUTION_EVIDENCE"] as const;
    const OTHER = ["INSUFFICIENT_AUTHORITY", "INDIRECT_ONLY", "STATE_NOT_FULLY_LIVE", "MECHANICAL_PROVENANCE_NOT_ESTABLISHED", "CONFLICTING_STATE", "PROPOSED_STATE_ONLY"] as const;
    for (const verdict of ["SUPPORTED", "NOT_SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const) {
      for (const code of EXCLUSION_SHAPED) {
        const absence = computeProofConfidence({ verdict, hasRequiredBlockingGap: false, hasClaimContextGap: false, componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }] });
        const excluded = computeProofConfidence({ verdict, hasRequiredBlockingGap: false, hasClaimContextGap: false, componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: [code] }] });
        expect(excluded.score, `${verdict} ${code}`).toBe(absence.score);
        expect(excluded.bindingReasons, `${verdict} ${code}`).toEqual([code]);
        for (const other of OTHER) {
          const a = computeProofConfidence({ verdict, hasRequiredBlockingGap: false, hasClaimContextGap: false, componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] }, { status: "PARTIALLY_SUPPORTED", reasonCodes: [other] }] });
          const b = computeProofConfidence({ verdict, hasRequiredBlockingGap: false, hasClaimContextGap: false, componentResults: [{ status: "INSUFFICIENT_EVIDENCE", reasonCodes: [code] }, { status: "PARTIALLY_SUPPORTED", reasonCodes: [other] }] });
          expect(b.score, `${verdict} ${code} + ${other}`).toBe(a.score);
        }
      }
    }
  });
});

// ====================================================================
describe("Decision 3 — MORE AGREEING ADMISSIBLE EVIDENCE != WEAKER PROOF (D-101 over-splitting)", () => {
  // A second row that agrees with the control's row at `component`: same
  // class, same officiality, same state, same date, a different source and
  // a different extraction unit. S5 cannot tell them apart in strength; S6
  // makes them two slots.
  function agreeingTwin(component: string, pool: EvidenceRow[]): EvidenceRow {
    const original = pool.find((r) => r.component === component)!;
    return row(component, {
      sourceClass: original.sourceClass,
      officiality: original.officiality,
      entityBinding: original.entityBinding,
      onchainFactKind: original.onchainFactKind,
      mechanismState: original.mechanismState,
      publishedAt: original.publishedAt,
      fragment: original.fragment,
      sourceId: `another-source-${component}`,
    });
  }

  it("F. one admissible supporting row -> a second admissible AGREEING row at the same component, for every component and every intent: the conclusion is never weaker on any axis — verdict, confidence, every S5 status, every requirement — the lineage may fork but no BRANCH_ATTRIBUTION_UNRESOLVED appears, and the added row is cited beside the original", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      for (const component of ALL_COMPONENTS) {
        const twin = agreeingTwin(component, base);
        const t = runChain(intent, [...base, twin]);
        const label = `${intent} / ${component}`;
        noWeakerThan(t, control, label);
        expect(conclusion(t), label).toEqual(conclusion(control));
        expect(t.byComponent.get(component)!.supportingEvidenceIds, label).toContain(twin.id);
        expect(t.proof.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED"), label).toBe(false);
        expect(t.assembly.flows.length, label).toBeGreaterThanOrEqual(control.assembly.flows.length);
        // Every flow is the unforked flow with one slot: no flow carries a
        // gap the control's flow does not.
        const controlGapKinds = new Set(control.assembly.flows.flatMap((f) => f.gaps.map((g) => `${g.kind}@${g.component}`)));
        for (const f of t.assembly.flows) for (const g of f.gaps) expect(controlGapKinds.has(`${g.kind}@${g.component}`), `${label} new gap ${g.kind}@${g.component}`).toBe(true);
        // Cited: the control's rows plus the twin, when the component is
        // cited at all.
        if (control.proof.citedEvidenceIds.includes(base.find((r) => r.component === component)!.id)) {
          expect(t.proof.citedEvidenceIds, label).toContain(twin.id);
        }
        for (const id of control.proof.citedEvidenceIds) expect(t.proof.citedEvidenceIds, label).toContain(id);
        provenanceHolds(t);
      }
      // Twins at two, three and five components at once (a fork under a
      // fork under a fork): still the control's conclusion.
      for (const n of [2, 3, 5]) {
        const some = runChain(intent, [...base, ...ALL_COMPONENTS.slice(0, n).map((c) => agreeingTwin(c, base))]);
        noWeakerThan(some, control, `${intent} / ${n} twins`);
        expect(conclusion(some), `${intent} / ${n} twins`).toEqual(conclusion(control));
        expect(some.proof.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED"), `${intent} / ${n} twins`).toBe(false);
        expect(some.assembly.flows.length, `${intent} / ${n} twins`).toBe(2 ** n);
      }
    }
  });

  it("F2. DECIDED (Round 6.6, Founder decision 2) — the flow-enumeration cap under multiplicity: twins at every component would be 2^10 structural flows; the cap (MAX_FLOWS 64) refuses the sixth fork at 32 flows, every flow continues with the structurally-first slot and carries FLOW_ENUMERATION_INCOMPLETE, and the claim is exactly the control's — bounded enumeration is never weaker truth. The full pin is founder-semantics-round6-6-v1 (F–J)", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const all = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base, ...ALL_COMPONENTS.map((c) => agreeingTwin(c, base))]);
    noStrongerThan(all, control, "all twins");
    noWeakerThan(all, control, "all twins");
    expect(all.assembly.flows.length).toBe(32);
    expect(all.assembly.unassignedGaps.some((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE")).toBe(true);
    expect(all.assembly.flows.every((f) => f.gaps.some((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE"))).toBe(true);
    expect(all.assembly.flows.every((f) => ALL_COMPONENTS.every((c) => f.lineage.some((st) => st.component === c)))).toBe(true);
    expect(control.claim.requirementResults.find((r) => r.requirementId === "PRT-2")?.status).toBe("PARTIAL");
    expect(all.claim.requirementResults.find((r) => r.requirementId === "PRT-2")?.status).toBe("PARTIAL");
    // The conclusion is the control's; the ONLY difference is the visible
    // diagnostic that enumeration stopped (at CURRENT_STATE, the sixth
    // two-slot component), which binds nothing.
    const minusCap = (k: ReturnType<typeof conclusion>) => ({ ...k, gaps: k.gaps.filter((g) => !g.includes("FLOW_ENUMERATION_INCOMPLETE")) });
    expect(minusCap(conclusion(all))).toEqual(minusCap(conclusion(control)));
    expect(all.proof.gaps.some((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE" && g.origin === "CLAIM_CONTEXT" && g.component === "CURRENT_STATE")).toBe(true);
    expect(all.proof.confidenceBindingReasons).not.toContain("CLAIM_CONTEXT_GAP");
    provenanceHolds(all);
  });

  it("G. the exact Round 6 F1c fork shapes — a second official SOURCE_OF_VALUE page, a second official FLOW_PATH page, a weak CLAIMED governance row for SOURCE_OF_VALUE, four more distinct burns at EXECUTION_EVIDENCE: the lineage still forks (D-101 slot identity is untouched), no row after the fork is BRANCH_ATTRIBUTION_UNRESOLVED, and the claim is exactly the control's (PARTIAL stays PARTIAL, never UNSATISFIED)", () => {
    const base = world();
    const cases: { label: string; intent: string; rows: EvidenceRow[]; downstream: string }[] = [
      { label: "second official SOURCE_OF_VALUE page", intent: "PROTOCOL_REVENUE_TO_TOKEN", rows: [row("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users generate the revenue", sourceId: "another-official-page" })], downstream: "DESTINATION" },
      { label: "second official FLOW_PATH page", intent: "PROTOCOL_REVENUE_TO_TOKEN", rows: [row("FLOW_PATH", { sourceId: "another-official-page" })], downstream: "DESTINATION" },
      { label: "weak CLAIMED governance row for SOURCE_OF_VALUE", intent: "PROTOCOL_REVENUE_TO_TOKEN", rows: [row("SOURCE_OF_VALUE", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", publishedAt: older(2) })], downstream: "DESTINATION" },
      { label: "four more distinct burns at EXECUTION_EVIDENCE", intent: "BURN_OR_SUPPLY_EFFECT", rows: Array.from({ length: 4 }, () => confirmed("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null })), downstream: "NET_EFFECT" },
    ];
    for (const k of cases) {
      const control = runChain(k.intent, base);
      const t = runChain(k.intent, [...base, ...k.rows]);
      noWeakerThan(t, control, k.label);
      noStrongerThan(t, control, k.label);
      expect(conclusion(t), k.label).toEqual(conclusion(control));
      // Structure: the fork is real and honest — more flows, each of the
      // control's shape; the row after the fork sits on every branch.
      expect(t.assembly.flows.length, k.label).toBeGreaterThan(control.assembly.flows.length);
      expect(t.proof.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED"), k.label).toBe(false);
      for (const f of t.assembly.flows) expect(f.lineage.some((s) => s.component === k.downstream), `${k.label}: ${k.downstream} missing on a branch`).toBe(true);
      expect(t.claim.requirementResults.some((r) => r.status === "UNSATISFIED"), k.label).toBe(control.claim.requirementResults.some((r) => r.status === "UNSATISFIED"));
      for (const r of k.rows) expect(t.byComponent.get(r.component!)!.supportingEvidenceIds, k.label).toContain(r.id);
      provenanceHolds(t);
    }
    // The control itself: PRT-2 is PARTIAL (D-158), which is what the
    // fork used to turn into UNSATISFIED.
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    expect(control.claim.requirementResults.find((r) => r.requirementId === "PRT-2")?.status).toBe("PARTIAL");
    // Five mirror sources of one passage (Round 6 F2b): five slots, five
    // flows, one conclusion — unchanged by this decision.
    const mirrors = Array.from({ length: 4 }, (_, i) => row("DESTINATION", { fragment: "fees are distributed to token holders via the distributor", contentHash: "same-hash", sourceId: `mirror-${i}` }));
    const m = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base, ...mirrors]);
    expect(conclusion(m)).toEqual(conclusion(control));
    expect(m.assembly.flows.length).toBe(control.assembly.flows.length * 5);
  });

  it("G2. the fork is never a merge and never a cartesian invention: a row that names ONE branch attaches there only; a second row that names the other branch attaches there only; and (DECIDED, Round 6.6) a row a single source spans across the fork continues on every branch it spans when it is ONE element — two shared slots (audit HIGH-1) stay BRANCH_ATTRIBUTION_UNRESOLVED", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    // Fork at SOURCE_OF_VALUE between page A (the control's) and page B;
    // DESTINATION from page A and from page B: each branch gets its own.
    const sovA = base.find((r) => r.component === "SOURCE_OF_VALUE")!;
    const sovB = row("SOURCE_OF_VALUE", { fragment: sovA.fragment, sourceId: "page-B" });
    const destA = row("DESTINATION", { sourceId: sovA.sourceId, fragment: "page A: fees go to the distributor" });
    const destB = row("DESTINATION", { sourceId: "page-B", fragment: "page B: fees go to the distributor" });
    const named = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base.filter((r) => r.component !== "DESTINATION"), sovB, destA, destB]);
    expect(named.assembly.flows.length).toBe(2);
    for (const f of named.assembly.flows) {
      const sov = f.lineage.find((s) => s.component === "SOURCE_OF_VALUE")!;
      const dest = f.lineage.find((s) => s.component === "DESTINATION")!;
      // Never crossed: A's destination sits under A, B's under B.
      expect(dest.evidenceIds).toEqual(sov.evidenceIds.includes(sovA.id) ? [destA.id] : [destB.id]);
    }
    expect(named.proof.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED")).toBe(false);
    expect(conclusion(named)).toEqual(conclusion(control));
    // DECIDED (Round 6.6, Founder decision 1): two agreeing SOURCE_OF_VALUE
    // passages from ONE page and that page's own DESTINATION row. The page
    // spans the fork; its one DESTINATION element offers no pairing choice,
    // so both branches continue with it (one shared provenance, never an
    // independent corroboration) and the claim is exactly the control's.
    // The full pin is founder-semantics-round6-6-v1 (A–E).
    const pageP = "page-P";
    const spanning = [
      row("SOURCE_OF_VALUE", { fragment: "swap fees generate the revenue", sourceId: pageP }),
      row("SOURCE_OF_VALUE", { fragment: "lending fees generate the revenue", sourceId: pageP }),
      row("DESTINATION", { fragment: "fees are distributed to token holders via the distributor", sourceId: pageP }),
      ...base.filter((r) => r.component !== "SOURCE_OF_VALUE" && r.component !== "DESTINATION"),
    ];
    const s = runChain("PROTOCOL_REVENUE_TO_TOKEN", spanning);
    expect(s.assembly.flows.length).toBe(2);
    expect(s.assembly.flows.every((f) => f.lineage.some((st) => st.component === "DESTINATION"))).toBe(true);
    expect(s.proof.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED")).toBe(false);
    expect(conclusion(s)).toEqual(conclusion(control));
    // Two shared slots from that page (HIGH-1's shape) still refuse to pair.
    const twoShared = [...spanning, row("DESTINATION", { fragment: "lending fees are sent to the treasury", sourceId: pageP })];
    const u = runChain("PROTOCOL_REVENUE_TO_TOKEN", twoShared);
    expect(u.assembly.flows.every((f) => f.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED" && g.component === "DESTINATION"))).toBe(true);
    expect(u.claim.requirementResults.find((r) => r.requirementId === "PRT-2")?.status).toBe("UNSATISFIED");
    noStrongerThan(u, control, "two shared slots");
    provenanceHolds(s);
    provenanceHolds(u);
  });

  it("H. actual CONTRADICTORY evidence still weakens, and visibly: a fresh official PAUSED beside the control's LIVE at CURRENT_STATE or MECHANISM_SPEC is CONTRADICTED in S5, a CONTRADICTED_COMPONENT gap on the flow, a COMPONENT_CONTRADICTED binding on the band — in both arrival orders, and not silenced by an agreeing twin arriving with it", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      for (const component of ["CURRENT_STATE", "MECHANISM_SPEC"]) {
        const original = base.find((r) => r.component === component)!;
        const counter = row(component, { fragment: "the mechanism is paused", mechanismState: "PAUSED", publishedAt: original.publishedAt });
        for (const pool of [[...base, counter], [counter, ...base]]) {
          const t = runChain(intent, pool);
          const label = `${intent} / ${component}`;
          noStrongerThan(t, control, label);
          expect(t.byComponent.get(component)!.status, label).toBe("CONTRADICTED");
          expect(t.byComponent.get(component)!.contradictingEvidenceIds, label).toContain(counter.id);
          expect(t.assembly.flows.every((f) => f.gaps.some((g) => g.kind === "CONTRADICTED_COMPONENT" && g.component === component)), label).toBe(true);
          // On the Proof: as the requirement's blocking gap when the claim
          // needs the component, and always as the S5 reason itself.
          expect(t.proof.gaps.some((g) => (g.kind === "CONTRADICTED_COMPONENT" || g.kind === "CONFLICTING_STATE") && g.component === component), label).toBe(true);
          if (t.proof.verdict !== "NOT_SUPPORTED") {
            expect(t.proof.confidenceScore, label).toBeLessThanOrEqual(40);
            if (t.proof.confidenceScore === 40) expect(t.proof.confidenceBindingReasons, label).toContain("COMPONENT_CONTRADICTED");
          }
          expect(t.proof.citedEvidenceIds, label).not.toContain(counter.id);
          provenanceHolds(t);
        }
        // An agreeing twin beside the counter-row does not outvote it.
        const twin = agreeingTwin(component, base);
        const t = runChain(intent, [...base, twin, counter]);
        expect(t.byComponent.get(component)!.status, `${intent} / ${component} + twin`).toBe("CONTRADICTED");
        noStrongerThan(t, control, `${intent} / ${component} + twin`);
      }
    }
  });

  it("I. stale / conflicting current-state evidence keeps the existing temporal semantics: a stale LIVE beside a fresh PAUSED is STALE_FOR_CURRENT_STATE and PAUSED stands; an OLDER PAUSED beside a NEWER LIVE is SUPERSEDED_BY_NEWER and equals the control; an EQUAL-dated PAUSED is a conflict; the freshness boundary is inclusive and one millisecond past it is stale", () => {
    const base = world();
    const control = runChain("MECHANISM_CURRENT_STATE", base);
    const live = base.find((r) => r.component === "CURRENT_STATE")!;
    // Stale LIVE beside fresh PAUSED (the control's LIVE removed).
    const freshPaused = row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: live.publishedAt });
    const staleLive = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: older(200) });
    const a = runChain("MECHANISM_CURRENT_STATE", [...base.filter((r) => r.id !== live.id), freshPaused, staleLive]);
    // Recorded under the FIRST rule that removes it: the newer PAUSED
    // supersedes it (D-093) before the freshness window is asked; alone it
    // would be STALE_FOR_CURRENT_STATE (see the window below).
    expect(["STALE_FOR_CURRENT_STATE", "SUPERSEDED_BY_NEWER"]).toContain(exclusionOf(a.byComponent.get("CURRENT_STATE")!, staleLive.id));
    expect(a.byComponent.get("CURRENT_STATE")!.status).toBe("SUPPORTED");
    expect(a.byComponent.get("CURRENT_STATE")!.currentState).toBe("PAUSED");
    expect(a.proof.citedEvidenceIds).not.toContain(staleLive.id);
    // Older PAUSED beside the control's newer LIVE: superseded, control.
    const olderPaused = row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: older(2) });
    const b = runChain("MECHANISM_CURRENT_STATE", [...base, olderPaused]);
    expect(exclusionOf(b.byComponent.get("CURRENT_STATE")!, olderPaused.id)).toBe("SUPERSEDED_BY_NEWER");
    expect(conclusion(b)).toEqual(conclusion(control));
    // Equal-dated PAUSED: a conflict, in both id orders.
    const equalPaused = row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: live.publishedAt });
    for (const pool of [[...base, equalPaused], [equalPaused, ...base]]) {
      const c = runChain("MECHANISM_CURRENT_STATE", pool);
      expect(c.byComponent.get("CURRENT_STATE")!.status).toBe("CONTRADICTED");
      noStrongerThan(c, control, "equal-dated conflict");
    }
    // The window: HIGH_CHANGE = 3 days, inclusive; one ms past is stale.
    const atBoundary = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - FRESHNESS.HIGH_CHANGE * DAY) });
    const pastBoundary = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - FRESHNESS.HIGH_CHANGE * DAY - 1) });
    const d = runChain("MECHANISM_CURRENT_STATE", [...base.filter((r) => r.id !== live.id), atBoundary]);
    const e = runChain("MECHANISM_CURRENT_STATE", [...base.filter((r) => r.id !== live.id), pastBoundary]);
    expect(d.byComponent.get("CURRENT_STATE")!.status).toBe("SUPPORTED");
    expect(e.byComponent.get("CURRENT_STATE")!.reasonCodes).toEqual(["STALE_CURRENT_STATE"]);
    expect(VERDICT_RANK[e.proof.verdict!]).toBeLessThanOrEqual(VERDICT_RANK[d.proof.verdict!]);
    // And the stale row alone reads exactly as absence (Decision 2).
    const absent = runChain("MECHANISM_CURRENT_STATE", base.filter((r) => r.id !== live.id));
    expect(e.proof.verdict).toBe(absent.proof.verdict);
    expect(e.proof.confidenceScore).toBe(absent.proof.confidenceScore);
  });
});

// ====================================================================
describe("No false semantics", () => {
  it("EXCLUDED EVIDENCE != CONFIDENCE: over every intent and every component of the full control, every excluded class added alone leaves verdict, support, confidence and citations exactly the control's", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      for (const component of ALL_COMPONENTS) {
        for (const k of excludedRowsFor(component)) {
          const t = runChain(intent, [...base, k.row]);
          const label = `${intent} / ${component} / ${k.label}`;
          if (t.byComponent.get(component)!.supportingEvidenceIds.includes(k.row.id)) {
            // Admitted, not excluded (see case E): Round 6's relation only.
            noStrongerThan(t, control, label);
          } else {
            expect(strength(t), label).toEqual(strength(control));
            expect(t.proof.citedEvidenceIds, label).toEqual(control.proof.citedEvidenceIds);
          }
        }
      }
    }
  });

  it("MORE AGREEING ADMISSIBLE EVIDENCE != WEAKER PROOF, and CONTRADICTION may weaken where the existing semantics say so: the agreeing twin of every row keeps the control's conclusion, the contradicting counterpart of every state-bearing row is CONTRADICTED, and neither is ever NOT_SUPPORTED by absence", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      for (const component of ALL_COMPONENTS) {
        const original = base.find((r) => r.component === component)!;
        const twin = row(component, { sourceClass: original.sourceClass, officiality: original.officiality, entityBinding: original.entityBinding, onchainFactKind: original.onchainFactKind, mechanismState: original.mechanismState, publishedAt: original.publishedAt, fragment: original.fragment, sourceId: `twin-${component}` });
        expect(conclusion(runChain(intent, [...base, twin])), `${intent} / ${component} twin`).toEqual(conclusion(control));
        if (original.mechanismState === "LIVE") {
          const counter = row(component, { sourceClass: original.sourceClass, officiality: original.officiality, entityBinding: original.entityBinding, onchainFactKind: original.onchainFactKind, mechanismState: "PAUSED", publishedAt: original.publishedAt, sourceId: `counter-${component}` });
          const t = runChain(intent, [...base, counter]);
          if (component === "EXECUTION_EVIDENCE") {
            // The live-state gate refuses a PAUSED row outright, and D-094
            // says the contradiction threshold IS the establishment
            // threshold: a row that cannot establish cannot contradict.
            expect(exclusionOf(t.byComponent.get(component)!, counter.id), `${intent} / ${component} counter`).toBe("NOT_CURRENT_STATE_BEARING");
            expect(strength(t), `${intent} / ${component} counter`).toEqual(strength(control));
          } else {
            expect(t.byComponent.get(component)!.status, `${intent} / ${component} counter`).toBe("CONTRADICTED");
          }
          noStrongerThan(t, control, `${intent} / ${component} counter`);
        }
      }
    }
  });
});
