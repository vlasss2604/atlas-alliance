import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor, type ClaimRequirement, type PatternContent } from "../src/server/domain/pattern";
import { evaluateClaimSupport, type ClaimSupportResult } from "../src/server/engine/claim-evaluator";
import {
  reconcileComponent,
  type AcquisitionBoundary,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { assembleMechanism, type AssemblyEvidenceProjection, type MechanismAssemblyResult } from "../src/server/engine/mechanism-assembler";
import { buildProof, type ProofDraft } from "../src/server/engine/proof-builder";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 6: METAMORPHIC INVARIANTS,
// THE PURE CHAIN.
//
// Rounds 1–5 invented scenarios. Round 6 starts from a valid, complete
// evidence world and TRANSFORMS it — adds something weaker, duplicates
// something, removes something, contradicts something, reorders
// something, ages something — and asks one question of the real
// S5 -> S6 -> S7 -> S8 chain over the real Pattern v1 contract:
//
//   A WEAKER EVIDENCE WORLD MUST NEVER PRODUCE A STRONGER CONCLUSION, and
//   AN IRRELEVANT CHANGE MUST NOT CHANGE SEMANTIC TRUTH.
//
// "Stronger" is read on every axis the Proof exposes: the verdict's
// support rank, the confidence band at an equal verdict, every S5
// status, every S7 requirement status, and the cited set. Every case
// compares a transformed world to its control; none asserts an absolute
// number the control does not itself establish. Pure: no DB, no model,
// no network. The persisted-state half of the round is
// adversarial-core-round6-metamorphic-db-v1.
//
// Families here: 1 adding weak evidence; 2 duplication; 3 removal; 4
// contradiction; 5 order; 6 authority monotonicity; 7 freshness; 11
// REQUIRED vs OPTIONAL; 12 confidence; 13 provenance; 14 fresh review.

const JOB = "dddddddd-0000-4000-8000-000000000006";
const OTHER_JOB = "eeeeeeee-0000-4000-8000-000000000007";
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
  const id = overrides.id ?? `r${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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
// A CONFIRMED row of a non-docs class: a routed governance page or a
// chain read (the classes whose authority is CONFIRMED through a route or
// through being a deterministic read).
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

function runChain(
  intent: string,
  pool: EvidenceRow[],
  opts: { pattern?: PatternContent; boundaries?: Record<string, AcquisitionBoundary> } = {},
): ChainResult {
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

const exclusionOf = (r: ComponentReconciliationResult, id: string) => r.excludedEvidence.find((e) => e.evidenceId === id)?.reason ?? null;

// ---------------------------------------------------------------- orders

// The support ladder. NOT_SUPPORTED is a definite finding but not a
// SUPPORTIVE one, so it sits at the bottom of the support order: a
// transformation that turns a refutation into an open question weakens
// the certainty, and one that turns an open question into support
// strengthens it. Confidence is compared only at an equal verdict —
// D-135 says the band measures how well THE VERDICT is established.
const VERDICT_RANK: Record<string, number> = { NOT_SUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const STATUS_RANK: Record<string, number> = { CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const REQ_RANK: Record<string, number> = { CONTRADICTED: 0, UNSATISFIED: 0, PARTIAL: 1, SATISFIED: 2 };

// The parts of a chain result that carry meaning, with ids kept so that
// two runs over the SAME rows can be compared byte for byte.
function snapshot(c: ChainResult) {
  return {
    verdict: c.proof.verdict,
    confidence: c.proof.confidenceScore,
    binding: c.proof.confidenceBindingReasons,
    claim: c.claim.status,
    reqs: c.claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`),
    s5: c.results.map((r) => ({ c: r.component, status: r.status, reasonCodes: r.reasonCodes, supporting: r.supportingEvidenceIds, contradicting: r.contradictingEvidenceIds, excluded: r.excludedEvidence, currentState: r.currentState })),
    lifecycle: c.assembly.flows.map((f) => f.lifecycle),
    gaps: c.proof.gaps.map((g) => `${g.origin}|${g.kind}|${g.component ?? ""}`).sort(),
    cited: [...c.proof.citedEvidenceIds].sort(),
  };
}
// The same, without ids — for comparing worlds whose rows differ only in
// identity (duplicates, reorderings with fresh ids).
function shape(c: ChainResult) {
  const s = snapshot(c);
  return { ...s, s5: s.s5.map((r) => ({ c: r.c, status: r.status, reasonCodes: r.reasonCodes, currentState: r.currentState, n: r.supporting.length })), gaps: s.gaps.filter((g) => !g.startsWith("COMPONENT_EXCLUSION")), cited: s.cited.length };
}
// The rule for an added row: never stronger on any axis; and when S5
// excluded it, the conclusion is IDENTICAL (an inadmissible row is not a
// change to the evidence world). An admissible-but-weaker row may only
// weaken (H1, H4, D-101 — pinned by name below).
function addedRowRule(t: ChainResult, c: ChainResult, added: EvidenceRow, label: string): void {
  noStrongerThan(t, c, label);
  provenanceHolds(t);
  const s5 = t.byComponent.get(added.component!)!;
  if (s5.excludedEvidence.some((e) => e.evidenceId === added.id)) {
    expect(t.proof.citedEvidenceIds, label).not.toContain(added.id);
    sameConclusion(t, c, label);
  } else expect(s5.supportingEvidenceIds.includes(added.id) || s5.contradictingEvidenceIds.includes(added.id), `${label}: admitted row is neither supporting nor contradicting`).toBe(true);
}

// t is no stronger than c on any axis.
function noStrongerThan(t: ChainResult, c: ChainResult, label = ""): void {
  expect(VERDICT_RANK[t.proof.verdict!], `${label} verdict ${t.proof.verdict} vs ${c.proof.verdict}`).toBeLessThanOrEqual(VERDICT_RANK[c.proof.verdict!]);
  if (t.proof.verdict === c.proof.verdict) {
    expect(t.proof.confidenceScore, `${label} confidence`).toBeLessThanOrEqual(c.proof.confidenceScore);
  }
  for (const r of t.results) {
    const ref = c.byComponent.get(r.component)!;
    expect(STATUS_RANK[r.status], `${label} ${r.component} ${r.status} vs ${ref.status}`).toBeLessThanOrEqual(STATUS_RANK[ref.status]);
  }
  for (const q of t.claim.requirementResults) {
    const ref = c.claim.requirementResults.find((x) => x.requirementId === q.requirementId)!;
    expect(REQ_RANK[q.status], `${label} ${q.requirementId} ${q.status} vs ${ref.status}`).toBeLessThanOrEqual(REQ_RANK[ref.status]);
  }
}
// t and c are the same conclusion: identical on everything but the row
// identities of what was excluded.
function sameConclusion(t: ChainResult, c: ChainResult, label = ""): void {
  const a = snapshot(t);
  const b = snapshot(c);
  expect({ ...a, s5: a.s5.map((r) => ({ ...r, excluded: undefined })), gaps: a.gaps.filter((g) => !g.startsWith("COMPONENT_EXCLUSION")) }, label).toEqual({
    ...b,
    s5: b.s5.map((r) => ({ ...r, excluded: undefined })),
    gaps: b.gaps.filter((g) => !g.startsWith("COMPONENT_EXCLUSION")),
  });
}
function nonNegative(c: ChainResult): void {
  expect(c.proof.verdict).not.toBe("NOT_SUPPORTED");
  for (const r of c.results) expect(r.status).not.toBe("CONTRADICTED");
}
// PROVENANCE (family 13): every cited row is a supporting row of some S5
// result; nothing excluded or contradicting is cited; nothing from another
// job is anywhere in the admitted picture.
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
  for (const r of c.results) {
    // The three S5 sets are disjoint.
    for (const id of r.supportingEvidenceIds) {
      expect(r.contradictingEvidenceIds).not.toContain(id);
      expect(r.excludedEvidence.map((e) => e.evidenceId)).not.toContain(id);
    }
    for (const id of r.contradictingEvidenceIds) expect(r.excludedEvidence.map((e) => e.evidenceId)).not.toContain(id);
  }
}

// ---------------------------------------------------------------- worlds

// THE CONTROL: a coherent, fully sourced fee -> holders mechanism. Official
// docs (CONFIRMED) for the documentary components, routed governance
// (CONFIRMED) for the two governance components, deterministic chain
// reads (CONFIRMED, bound) for execution and net effect. SOURCE_OF_VALUE
// sits at the D-158 partial rung (no machine provenance is offered) and
// NET_EFFECT at the B1 rung (a burn, no measured interval) — the two
// LIMITED caps every real Research carries; the control is what it is,
// and the relations below are all relative to it.
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
const without = (pool: EvidenceRow[], ...components: string[]) => pool.filter((r) => !components.includes(r.component!));
const older = (days: number) => new Date(NOW.getTime() - days * DAY);

// Every kind of row that must never strengthen anything: weaker, foreign,
// inadmissible, unbound, stale, non-supporting, legacy. Dated BEFORE the
// control's rows so the recency rule (H4) is not what is under test here.
function weakRowsFor(component: string): { label: string; row: EvidenceRow }[] {
  const state = ["MECHANISM_SPEC", "EXECUTION_EVIDENCE", "CURRENT_STATE"].includes(component) ? "LIVE" : component.endsWith("_BASIS") ? "APPROVED" : null;
  const at = older(2);
  return [
    { label: "research media", row: row(component, { sourceClass: "RESEARCH_MEDIA", officiality: "CLAIMED", mechanismState: state, publishedAt: at }) },
    { label: "public social", row: row(component, { sourceClass: "SOCIAL", officiality: "CLAIMED", mechanismState: state, publishedAt: at }) },
    { label: "data provider", row: row(component, { sourceClass: "DATA_PROVIDER", officiality: "CLAIMED", mechanismState: state, publishedAt: at }) },
    { label: "weak CLAIMED governance", row: row(component, { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: state, publishedAt: at }) },
    { label: "stale documentary", row: row(component, { mechanismState: state, publishedAt: older(200) }) },
    { label: "same-ticker foreign project", row: row(component, { researchJobId: OTHER_JOB, mechanismState: state, publishedAt: at }) },
    { label: "wrong-chain explorer", row: row(component, { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", entityBinding: "UNVERIFIED", onchainFactKind: "BURN", mechanismState: state, publishedAt: null }) },
    { label: "INFERRED", row: row(component, { directness: "INFERRED", mechanismState: state, publishedAt: at }) },
    { label: "CONTEXT", row: row(component, { relationship: "CONTEXT", mechanismState: state, publishedAt: at }) },
    { label: "LIMITS", row: row(component, { relationship: "LIMITS", mechanismState: state, publishedAt: at }) },
    { label: "legacy contract", row: row(component, { evidenceContractVersion: 1, mechanismState: state, publishedAt: at }) },
    { label: "wrong component", row: row(component, { component: component === "DESTINATION" ? "RECIPIENT" : "DESTINATION", patternStep: STEP_OF[component], mechanismState: state, publishedAt: at }) },
  ];
}

// ====================================================================
describe("F1. adding weak, foreign, inadmissible or irrelevant evidence must not strengthen", () => {
  it("F1a. every weak row kind, added to every component of the control, one at a time and all at once, for every intent: the conclusion is identical — verdict, confidence, requirements, S5 statuses and codes, supporting sets, citations, lifecycle", () => {
    const base = world();
    for (const intent of INTENTS) {
      const control = runChain(intent, base);
      for (const component of ALL_COMPONENTS) {
        for (const w of weakRowsFor(component)) {
          addedRowRule(runChain(intent, [...base, w.row]), control, w.row, `${intent} ${component} + ${w.label}`);
        }
      }
      // Every INADMISSIBLE row at once (those S5 excluded one at a time):
      // identical conclusion.
      const inadmissible = ALL_COMPONENTS.flatMap((c) => weakRowsFor(c).map((w) => w.row)).filter((r) => runChain(intent, [...base, r]).byComponent.get(r.component!)!.excludedEvidence.some((e) => e.evidenceId === r.id));
      expect(inadmissible.length).toBeGreaterThan(ALL_COMPONENTS.length * 8);
      const everything = runChain(intent, [...base, ...inadmissible]);
      for (const r of inadmissible) expect(everything.byComponent.get(r.component!)!.supportingEvidenceIds, `${intent} admitted ${r.sourceClass}`).not.toContain(r.id);
      sameConclusion(everything, control, `${intent} + everything inadmissible`);
      provenanceHolds(everything);
    }
  });

  it("F1b. the same weak rows added to a PARTIAL world (documentary only, no chain reads): nothing weak lifts EXECUTION_EVIDENCE or NET_EFFECT, and the partial conclusion is identical", () => {
    const base = world();
    const docsOnly = without(base, "EXECUTION_EVIDENCE", "NET_EFFECT");
    for (const intent of INTENTS) {
      const control = runChain(intent, docsOnly);
      expect(control.byComponent.get("EXECUTION_EVIDENCE")!.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
      // Weak rows for the two EMPTY components are the one place the
      // control changes: from bare absence to reasoned exclusion (H5,
      // pinned as F12b below). Everything with support is untouched.
      const inadmissible = ALL_COMPONENTS.filter((c) => c !== "EXECUTION_EVIDENCE" && c !== "NET_EFFECT").flatMap((c) => weakRowsFor(c).map((w) => w.row)).filter((r) => runChain(intent, [...docsOnly, r]).byComponent.get(r.component!)!.excludedEvidence.some((e) => e.evidenceId === r.id));
      const t = runChain(intent, [...docsOnly, ...inadmissible]);
      sameConclusion(t, control, intent);
      // Documentary "execution" and "net effect" claims (docs / governance /
      // social saying it ran or supply fell) never establish either.
      const docsClaims = [
        row("EXECUTION_EVIDENCE", { fragment: "the distributor has paid out every week since launch", mechanismState: "LIVE" }),
        confirmed("EXECUTION_EVIDENCE", { sourceClass: "GOVERNANCE", fragment: "the distributor has paid out every week", mechanismState: "LIVE" }),
        row("NET_EFFECT", { sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: "supply has fallen 3% this quarter" }),
      ];
      const u = runChain(intent, [...docsOnly, ...docsClaims]);
      expect(u.byComponent.get("EXECUTION_EVIDENCE")!.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(u.byComponent.get("NET_EFFECT")!.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(u.proof.verdict).toBe(control.proof.verdict);
      expect(u.claim.requirementResults).toEqual(control.claim.requirementResults);
      for (const d of docsClaims) expect(u.proof.citedEvidenceIds).not.toContain(d.id);
      // The ONE axis that moves is the band, and only through H5: the two
      // empty components became reasoned exclusions (ALL_EVIDENCE_EXCLUDED,
      // no cap) instead of bare absence (LOW). Pinned as F12b; the rest of
      // the conclusion is identical.
      expect(u.byComponent.get("EXECUTION_EVIDENCE")!.reasonCodes).toEqual(["MISSING_EXECUTION_EVIDENCE"]);
      expect(u.byComponent.get("NET_EFFECT")!.reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
      expect(u.proof.confidenceScore).toBeGreaterThanOrEqual(control.proof.confidenceScore);
      expect(u.proof.confidenceScore).toBeLessThanOrEqual(40);
    }
  });

  it("F1c. DECIDED (Round 6.5, Founder decision 3) — a SECOND agreeing admissible row at a fork point (another official page for SOURCE_OF_VALUE or FLOW_PATH; a weak CLAIMED governance row for SOURCE_OF_VALUE; four more distinct burn observations at EXECUTION_EVIDENCE) still splits the lineage (D-101 slot identity untouched), but the rows after the fork name no branch and continue the trunk on every branch: no BRANCH_ATTRIBUTION_UNRESOLVED, and the claim is exactly the control's. The full pin is founder-semantics-round6-5-v1 (F, G, G2)", () => {
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
      noStrongerThan(t, control, k.label);
      provenanceHolds(t);
      // The structure still forks — and every branch carries the row after
      // the fork.
      expect(t.assembly.flows.length, k.label).toBeGreaterThan(control.assembly.flows.length);
      expect(t.proof.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED"), k.label).toBe(false);
      for (const f of t.assembly.flows) expect(f.lineage.some((s) => s.component === k.downstream), k.label).toBe(true);
      // The conclusion is the control's: verdict, band, requirements, S5.
      expect(t.proof.verdict, k.label).toBe(control.proof.verdict);
      expect(t.proof.confidenceScore, k.label).toBe(control.proof.confidenceScore);
      expect(t.claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`), k.label).toEqual(control.claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`));
      expect(t.results.map((r) => [r.component, r.status, r.reasonCodes]), k.label).toEqual(control.results.map((r) => [r.component, r.status, r.reasonCodes]));
      nonNegative(t);
    }
    // The same addition at a slot that is NOT upstream of anything the
    // claim needs (a second official DESTINATION page): identical too.
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const t = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base, row("DESTINATION", { sourceId: "another-official-page" })]);
    expect(t.claim.requirementResults.map((r) => r.status)).toEqual(control.claim.requirementResults.map((r) => r.status));
    expect(t.proof.verdict).toBe(control.proof.verdict);
    expect(t.proof.confidenceScore).toBe(control.proof.confidenceScore);
  });
});

// ====================================================================
describe("F2. duplication must not create confidence", () => {
  it("F2a. the same passage five times from the same source (same extraction unit): one representative supports, the rest are DUPLICATE_UNIT, the conclusion equals one row", () => {
    const base = world();
    for (const intent of INTENTS) {
      const control = runChain(intent, base);
      const dup = base.flatMap((r) => [r, ...Array.from({ length: 4 }, (_, i) => ({ ...r, id: `${r.id.slice(0, -1)}${i + 1}`, contentHash: `${r.contentHash}-${i}` }))]);
      const t = runChain(intent, dup);
      expect(shape(t)).toEqual(shape(control));
      for (const r of t.results) if (r.status !== "INSUFFICIENT_EVIDENCE") expect(r.supportingEvidenceIds.length).toBe(control.byComponent.get(r.component)!.supportingEvidenceIds.length);
      expect(t.proof.citedEvidenceIds.length).toBe(control.proof.citedEvidenceIds.length);
      provenanceHolds(t);
    }
  });

  it("F2b. the same passage from five MIRROR sources (same content hash, distinct source ids): verdict, confidence, requirements and S5 statuses equal one source; what multiplies is structure — five slots, five identical flows, five citations for one passage (BOUNDARY, see report)", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const mirrors = Array.from({ length: 4 }, (_, i) => row("DESTINATION", { fragment: "fees are distributed to token holders via the distributor", contentHash: "same-hash", sourceId: `mirror-${i}` }));
    const t = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base, ...mirrors]);
    expect(t.proof.verdict).toBe(control.proof.verdict);
    expect(t.proof.confidenceScore).toBe(control.proof.confidenceScore);
    expect(t.claim.requirementResults.map((r) => r.status)).toEqual(control.claim.requirementResults.map((r) => r.status));
    expect(t.results.map((r) => [r.component, r.status, r.reasonCodes])).toEqual(control.results.map((r) => [r.component, r.status, r.reasonCodes]));
    // THE BOUNDARY (Round 6, F2b): slot identity is the extraction unit
    // (D-101 §13.2), and the unit is per source, so five sources saying
    // one sentence are five slots — five flows of identical shape and a
    // Proof citing five rows for one passage. Nothing downstream reads
    // the count (S7 is existential over flows, confidence never counts),
    // so the conclusion is unchanged. Whether a byte-identical document
    // on another URL should collapse into one slot is a Founder question;
    // a decision either way fails this test by name.
    expect(t.assembly.flows.length).toBe(control.assembly.flows.length * 5);
    expect(t.proof.citedEvidenceIds.length).toBe(control.proof.citedEvidenceIds.length + 4);
    provenanceHolds(t);
  });

  it("F2c. on-chain duplicates: five identical burn observations (same unit) reduce to one; five DISTINCT burns establish exactly what one does — no stronger execution, no stronger net effect", () => {
    const base = world();
    const control = runChain("BURN_OR_SUPPLY_EFFECT", base);
    const sameUnit = Array.from({ length: 4 }, (_, i) => confirmed("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null, extractionUnitKey: control.pool.find((r) => r.component === "EXECUTION_EVIDENCE")!.extractionUnitKey, contentHash: `b-${i}` }));
    const t1 = runChain("BURN_OR_SUPPLY_EFFECT", [...base, ...sameUnit]);
    expect(shape(t1)).toEqual(shape(control));
    const distinct = Array.from({ length: 4 }, () => confirmed("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null }));
    const distinctNet = Array.from({ length: 4 }, () => confirmed("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", publishedAt: null }));
    // Distinct NET_EFFECT burns (the terminal slot): the same conclusion.
    const t2 = runChain("BURN_OR_SUPPLY_EFFECT", [...base, ...distinctNet]);
    expect(t2.proof.verdict).toBe(control.proof.verdict);
    expect(t2.proof.confidenceScore).toBe(control.proof.confidenceScore);
    expect(t2.byComponent.get("NET_EFFECT")!.reasonCodes).toEqual(control.byComponent.get("NET_EFFECT")!.reasonCodes);
    noStrongerThan(t2, control);
    // Distinct EXECUTION burns (a fork point): weaker, never stronger — the
    // D-101 boundary pinned in F1c.
    const t3 = runChain("BURN_OR_SUPPLY_EFFECT", [...base, ...distinct, ...distinctNet]);
    noStrongerThan(t3, control);
    expect(t3.byComponent.get("EXECUTION_EVIDENCE")!.status).toBe(control.byComponent.get("EXECUTION_EVIDENCE")!.status);
    expect(t3.byComponent.get("NET_EFFECT")!.status).toBe(control.byComponent.get("NET_EFFECT")!.status);
  });

  it("F2d. a duplicate of a WEAK row is still weak: five CLAIMED copies of the same governance statement never reach the CONFIRMED rung", () => {
    const base = world();
    const pool = without(base, "GOVERNANCE_BASIS");
    const one = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...pool, row("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: "APPROVED" })]);
    const five = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...pool, ...Array.from({ length: 5 }, () => row("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: "APPROVED" }))]);
    expect(one.byComponent.get("GOVERNANCE_BASIS")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(five.byComponent.get("GOVERNANCE_BASIS")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(five.byComponent.get("GOVERNANCE_BASIS")!.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
    expect(five.results.map((r) => [r.component, r.status, r.reasonCodes])).toEqual(one.results.map((r) => [r.component, r.status, r.reasonCodes]));
    noStrongerThan(five, one);
  });
});

// ====================================================================
describe("F3. removing evidence must not strengthen", () => {
  it("F3a. removing any one component's rows from the control, for every intent: never stronger on any axis, never negative", () => {
    const base = world();
    for (const intent of INTENTS) {
      const control = runChain(intent, base);
      for (const c of ALL_COMPONENTS) {
        const t = runChain(intent, without(base, c));
        noStrongerThan(t, control, `${intent} - ${c}`);
        nonNegative(t);
        expect(t.byComponent.get(c)!.reasonCodes).toContain("NO_EVIDENCE_FOUND");
        provenanceHolds(t);
      }
    }
  });

  it("F3b. removing the strongest authority row where a weaker one also supports: the component drops to the weaker rung, never above it", () => {
    const base = world();
    const explorer = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", mechanismState: "LIVE", publishedAt: older(2) });
    const both = runChain("MECHANISM_CURRENT_STATE", [...base, explorer]);
    const weakOnly = runChain("MECHANISM_CURRENT_STATE", [...without(base, "CURRENT_STATE"), explorer]);
    expect(both.byComponent.get("CURRENT_STATE")!.status).toBe("SUPPORTED");
    expect(weakOnly.byComponent.get("CURRENT_STATE")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(weakOnly.byComponent.get("CURRENT_STATE")!.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
    noStrongerThan(weakOnly, both);
  });

  it("F3c. removing one side of a conflict: removing the contradicting row restores the control exactly; removing the SUPPORTING row leaves a lone counter-row that establishes nothing, and neither removal produces a stronger conclusion than the pair", () => {
    const base = world();
    const counter = row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "PAUSED", fragment: "distribution paused", publishedAt: older(1) });
    for (const intent of ["PROTOCOL_REVENUE_TO_TOKEN", "MECHANISM_CURRENT_STATE", "PASSIVE_HOLDER_OUTCOME"]) {
      const control = runChain(intent, base);
      const pair = runChain(intent, [...base, counter]);
      expect(pair.byComponent.get("CURRENT_STATE")!.status).toBe("CONTRADICTED");
      const minusCounter = runChain(intent, base);
      sameConclusion(minusCounter, control);
      const minusSupport = runChain(intent, [...without(base, "CURRENT_STATE"), counter]);
      expect(minusSupport.byComponent.get("CURRENT_STATE")!.status).toBe("INSUFFICIENT_EVIDENCE");
      expect(minusSupport.byComponent.get("CURRENT_STATE")!.supportingEvidenceIds).toEqual([]);
      // A lone counter-row is not a positive state, so "is it current?"
      // is open, not answered — and never SUPPORTED.
      expect(VERDICT_RANK[minusSupport.proof.verdict!]).toBeLessThanOrEqual(VERDICT_RANK[control.proof.verdict!]);
      if (intent === "MECHANISM_CURRENT_STATE") expect(minusSupport.proof.verdict).toBe("INSUFFICIENT_EVIDENCE");
      noStrongerThan(minusSupport, control, intent);
      provenanceHolds(minusSupport);
    }
  });

  it("F3d. removing the attribution / measurement row: a measured decrease removed leaves the burn alone (NOT_ESTABLISHED); a non-decrease removed lifts the contradiction — the supply claim is never SUPPORTED either way", () => {
    const base = world();
    const decrease = confirmed("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA", publishedAt: null });
    const notReduced = confirmed("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS", publishedAt: null });
    const measured = runChain("BURN_OR_SUPPLY_EFFECT", [...base, decrease]);
    const unmeasured = runChain("BURN_OR_SUPPLY_EFFECT", base);
    expect(measured.byComponent.get("NET_EFFECT")!.reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"]);
    expect(unmeasured.byComponent.get("NET_EFFECT")!.reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]);
    expect(unmeasured.proof.confidenceScore).toBe(measured.proof.confidenceScore);
    expect(measured.proof.verdict).not.toBe("SUPPORTED");
    expect(unmeasured.proof.verdict).not.toBe("SUPPORTED");
    const contradicted = runChain("BURN_OR_SUPPLY_EFFECT", [...base, notReduced]);
    expect(contradicted.proof.verdict).toBe("NOT_SUPPORTED");
    expect(contradicted.byComponent.get("NET_EFFECT")!.contradictingEvidenceIds).toContain(notReduced.id);
    expect(unmeasured.proof.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(unmeasured.proof.confidenceScore).toBeLessThanOrEqual(40);
  });

  it("F3e. removing the identity-confirming binding: a chain read that loses its CONFIRMED binding establishes nothing, and nothing else in the Proof gets stronger", () => {
    const base = world();
    const control = runChain("BURN_OR_SUPPLY_EFFECT", base);
    const unbound = base.map((r) => (r.sourceClass === "ONCHAIN_VERIFIABLE" ? { ...r, entityBinding: "UNVERIFIED" as const } : r));
    const t = runChain("BURN_OR_SUPPLY_EFFECT", unbound);
    expect(t.byComponent.get("EXECUTION_EVIDENCE")!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(t.byComponent.get("NET_EFFECT")!.status).toBe("INSUFFICIENT_EVIDENCE");
    noStrongerThan(t, control);
    nonNegative(t);
  });
});

// ====================================================================
describe("F4. adding contradiction must not disappear", () => {
  const conflicts: { label: string; component: string; row: () => EvidenceRow; expectContradicted: boolean }[] = [
    { label: "CURRENT_STATE conflict (paused)", component: "CURRENT_STATE", row: () => row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "PAUSED", publishedAt: older(1) }), expectContradicted: true },
    { label: "MECHANISM_SPEC state conflict (deprecated)", component: "MECHANISM_SPEC", row: () => row("MECHANISM_SPEC", { relationship: "CONTRADICTS", mechanismState: "DEPRECATED", publishedAt: older(1) }), expectContradicted: true },
    { label: "governance lifecycle conflict (removed)", component: "GOVERNANCE_BASIS", row: () => confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", relationship: "CONTRADICTS", mechanismState: "REMOVED", publishedAt: older(1) }), expectContradicted: true },
    { label: "supply non-decrease against the burn", component: "NET_EFFECT", row: () => confirmed("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS", publishedAt: null }), expectContradicted: true },
    // A destination "conflict" carries no machine-readable state: under
    // D-094 a relationship label is not itself a fact, so it is recorded
    // as a non-supporting row, never as a contradiction, and never lost.
    { label: "destination prose disagreement (no state)", component: "DESTINATION", row: () => row("DESTINATION", { relationship: "CONTRADICTS", fragment: "fees are not sent to holders; they accrue to the treasury", publishedAt: older(1) }), expectContradicted: false },
  ];

  it("F4a. each admissible contradiction added to the control stays visible in S5, in the flow gaps, in the Proof gaps and in the confidence binding reasons — for every intent, and in every arrival order", () => {
    const base = world();
    for (const k of conflicts) {
      for (const intent of INTENTS) {
        const control = runChain(intent, base);
        const counter = k.row();
        const orders = [[...base, counter], [counter, ...base]];
        const first = runChain(intent, orders[0]);
        const second = runChain(intent, orders[1]);
        expect(snapshot(second), `${k.label} order`).toEqual(snapshot(first));
        const s5 = first.byComponent.get(k.component)!;
        if (k.expectContradicted) {
          expect(s5.status, `${k.label} ${intent}`).toBe("CONTRADICTED");
          expect(s5.contradictingEvidenceIds).toContain(counter.id);
          expect(first.proof.gaps.some((g) => g.component === k.component && (g.kind === "CONFLICTING_STATE" || g.kind === "NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL" || g.kind === "CONTRADICTED_COMPONENT"))).toBe(true);
          expect(first.proof.confidenceScore).toBeLessThanOrEqual(40);
          const bindsOnConflict = first.proof.confidenceBindingReasons.some((b) => ["COMPONENT_CONTRADICTED", "CONFLICTING_STATE", "NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL", "REQUIRED_BLOCKING_GAP"].includes(b));
          // Either the conflict binds the band, or a cap the control already
          // carried binds at the same level — never a band above the control.
          expect(bindsOnConflict || first.proof.confidenceScore <= control.proof.confidenceScore).toBe(true);
        } else {
          expect(s5.status).toBe(control.byComponent.get(k.component)!.status);
          expect(exclusionOf(s5, counter.id)).toBe("RELATIONSHIP_NOT_SUPPORTING");
        }
        expect(first.proof.citedEvidenceIds).not.toContain(counter.id);
        noStrongerThan(first, control, `${k.label} ${intent}`);
        provenanceHolds(first);
      }
    }
  });

  it("F4b. a contradiction is not silenced by MORE positive rows arriving after it: ten later agreeing official rows beside one counter-row still leave the component CONTRADICTED", () => {
    const base = world();
    const counter = row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "PAUSED", publishedAt: older(1) });
    const pile = Array.from({ length: 10 }, () => row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: older(1) }));
    const t = runChain("MECHANISM_CURRENT_STATE", [counter, ...base, ...pile]);
    expect(t.byComponent.get("CURRENT_STATE")!.status).toBe("CONTRADICTED");
    expect(t.byComponent.get("CURRENT_STATE")!.contradictingEvidenceIds).toContain(counter.id);
    expect(t.proof.verdict).not.toBe("SUPPORTED");
  });

  it("F4c. a NEWER positive row does supersede an OLDER counter-row (recency, D-093): the conflict resolves by time, is recorded as SUPERSEDED_BY_NEWER, and the result equals the control — a stale disagreement is not a live one", () => {
    const base = world();
    const control = runChain("MECHANISM_CURRENT_STATE", base);
    const oldCounter = row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "PAUSED", publishedAt: older(20) });
    const t = runChain("MECHANISM_CURRENT_STATE", [...base, oldCounter]);
    expect(exclusionOf(t.byComponent.get("CURRENT_STATE")!, oldCounter.id)).toBe("SUPERSEDED_BY_NEWER");
    sameConclusion(t, control);
  });
});

// ====================================================================
describe("F5. order invariance", () => {
  function permutations<T>(xs: T[]): T[][] {
    const out: T[][] = [xs, [...xs].reverse()];
    for (let k = 1; k < xs.length; k += 3) out.push([...xs.slice(k), ...xs.slice(0, k)]);
    out.push([...xs.filter((_, i) => i % 2 === 1), ...xs.filter((_, i) => i % 2 === 0)]);
    return out;
  }

  it("F5a. the control plus every weak row, a duplicate, a conflict and a foreign row, in every permutation, for every intent: byte-identical snapshot", () => {
    const base = world();
    const rich = [
      ...base,
      ...ALL_COMPONENTS.flatMap((c) => weakRowsFor(c).slice(0, 4).map((w) => w.row)),
      row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "PAUSED", publishedAt: older(1) }),
      { ...base[6], id: "dddd0000-0000-4000-8000-000000000099" },
    ];
    for (const intent of INTENTS) {
      const reference = JSON.stringify(snapshot(runChain(intent, rich)));
      for (const perm of permutations(rich)) expect(JSON.stringify(snapshot(runChain(intent, perm))), intent).toBe(reference);
    }
  });

  it("F5b. same-timestamp rows with swapped ids: two agreeing rows keep the same conclusion whichever id sorts first; two DISAGREEING rows at one instant are a conflict in both id orders, never a winner chosen by id", () => {
    const base = world();
    const at = older(1);
    const pool = without(base, "CURRENT_STATE");
    const idA = "aaaa0000-0000-4000-8000-000000000001";
    const idB = "bbbb0000-0000-4000-8000-000000000002";
    const agree1 = runChain("MECHANISM_CURRENT_STATE", [...pool, row("CURRENT_STATE", { id: idA, mechanismState: "LIVE", publishedAt: at, contentHash: "h1" }), row("CURRENT_STATE", { id: idB, mechanismState: "LIVE", publishedAt: at, contentHash: "h2" })]);
    const agree2 = runChain("MECHANISM_CURRENT_STATE", [...pool, row("CURRENT_STATE", { id: idB, mechanismState: "LIVE", publishedAt: at, contentHash: "h1" }), row("CURRENT_STATE", { id: idA, mechanismState: "LIVE", publishedAt: at, contentHash: "h2" })]);
    expect(shape(agree2)).toEqual(shape(agree1));
    expect(agree1.byComponent.get("CURRENT_STATE")!.currentState).toBe("LIVE");
    const dis1 = runChain("MECHANISM_CURRENT_STATE", [...pool, row("CURRENT_STATE", { id: idA, mechanismState: "LIVE", publishedAt: at }), row("CURRENT_STATE", { id: idB, mechanismState: "PAUSED", publishedAt: at })]);
    const dis2 = runChain("MECHANISM_CURRENT_STATE", [...pool, row("CURRENT_STATE", { id: idB, mechanismState: "LIVE", publishedAt: at }), row("CURRENT_STATE", { id: idA, mechanismState: "PAUSED", publishedAt: at })]);
    expect(dis1.byComponent.get("CURRENT_STATE")!.status).toBe("CONTRADICTED");
    expect(shape(dis2)).toEqual(shape(dis1));
    // Undated rows at the same (absent) instant behave the same way (on a
    // component that admits undated rows; an undated CURRENT_STATE row is
    // never current, F7a).
    const noSpec = without(base, "MECHANISM_SPEC");
    const und1 = runChain("MECHANISM_CURRENT_STATE", [...noSpec, row("MECHANISM_SPEC", { id: idA, mechanismState: "LIVE", publishedAt: null }), row("MECHANISM_SPEC", { id: idB, mechanismState: "DEPRECATED", publishedAt: null })]);
    const und2 = runChain("MECHANISM_CURRENT_STATE", [...noSpec, row("MECHANISM_SPEC", { id: idB, mechanismState: "LIVE", publishedAt: null }), row("MECHANISM_SPEC", { id: idA, mechanismState: "DEPRECATED", publishedAt: null })]);
    expect(und1.byComponent.get("MECHANISM_SPEC")!.status).toBe("CONTRADICTED");
    expect(shape(und2)).toEqual(shape(und1));
  });

  it("F5c. fetch time is not publication time: the same rows fetched in a different order (different fetchedAt) are the same conclusion", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const refetched = base.map((r, i) => ({ ...r, fetchedAt: new Date(NOW.getTime() - i * 60_000) }));
    sameConclusion(runChain("PROTOCOL_REVENUE_TO_TOKEN", refetched), control);
    sameConclusion(runChain("PROTOCOL_REVENUE_TO_TOKEN", [...refetched].reverse()), control);
  });
});

// ====================================================================
describe("F6. authority monotonicity", () => {
  it("F6a. weak first, strong added: a CLAIMED explorer page alone is PARTIAL; adding the CONFIRMED official statement of the same state lifts the component to SUPPORTED and nothing else moves — strengthening is explained by the new admissible row alone", () => {
    const base = world();
    const explorer = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", mechanismState: "LIVE", publishedAt: older(2) });
    const weak = runChain("MECHANISM_CURRENT_STATE", [...without(base, "CURRENT_STATE"), explorer]);
    const strong = runChain("MECHANISM_CURRENT_STATE", [...base, explorer]);
    expect(weak.byComponent.get("CURRENT_STATE")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(strong.byComponent.get("CURRENT_STATE")!.status).toBe("SUPPORTED");
    expect(weak.claim.status).toBe("PARTIALLY_SUPPORTED");
    expect(strong.claim.status).toBe("SUPPORTED");
    noStrongerThan(weak, strong);
    for (const c of ALL_COMPONENTS) if (c !== "CURRENT_STATE") expect(strong.byComponent.get(c)).toEqual(weak.byComponent.get(c));
  });

  it("F6a2. BOUNDARY H1 IN METAMORPHIC FORM — the same agreeing CLAIMED explorer row dated the SAME DAY as the official statement: the authority cap reads the newest establishing row, the chain class sorts first at an equal date, and the component DROPS from SUPPORTED to PARTIALLY_SUPPORTED on an agreeing weaker row. Weaker, never stronger (pinned pending the Founder's H1 decision)", () => {
    const base = world();
    const control = runChain("MECHANISM_CURRENT_STATE", base);
    const sameDay = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", mechanismState: "LIVE", publishedAt: older(1) });
    const t = runChain("MECHANISM_CURRENT_STATE", [...base, sameDay]);
    expect(control.byComponent.get("CURRENT_STATE")!.status).toBe("SUPPORTED");
    expect(t.byComponent.get("CURRENT_STATE")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(t.byComponent.get("CURRENT_STATE")!.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
    expect(t.byComponent.get("CURRENT_STATE")!.supportingEvidenceIds).toHaveLength(2);
    noStrongerThan(t, control);
  });

  it("F6b. strong first, weaker conflicting material added, dated no later than the official row: the official statement stands — an older CLAIMED disagreement is superseded, a same-day CLAIMED disagreement loses the class tie-break — and the conclusion equals the control", () => {
    const base = world();
    const control = runChain("MECHANISM_CURRENT_STATE", base);
    const olderClaimed = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", mechanismState: "PAUSED", publishedAt: older(2) });
    const t1 = runChain("MECHANISM_CURRENT_STATE", [...base, olderClaimed]);
    expect(exclusionOf(t1.byComponent.get("CURRENT_STATE")!, olderClaimed.id)).toBe("SUPERSEDED_BY_NEWER");
    sameConclusion(t1, control);
    const sameDayClaimed = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", mechanismState: "PAUSED", publishedAt: older(1) });
    const t2 = runChain("MECHANISM_CURRENT_STATE", [...base, sameDayClaimed]);
    noStrongerThan(t2, control);
    expect(t2.proof.verdict).not.toBe("SUPPORTED");
    expect(t2.byComponent.get("CURRENT_STATE")!.status).toBe("CONTRADICTED");
  });

  it("F6c. BOUNDARY H4 IN METAMORPHIC FORM — a NEWER CLAIMED page (explorer over HTTP, bound) saying LIVE, added beside an OLDER CONFIRMED official statement saying PAUSED: recency supersedes officiality (D-093 forbids an authority ranking), the official row is excluded, and 'is it current?' moves from NOT_SUPPORTED to PARTIALLY_SUPPORTED on the weaker source (pinned pending the Founder's H4 decision)", () => {
    const base = world();
    const paused = base.map((r) => (r.component === "CURRENT_STATE" ? { ...r, mechanismState: "PAUSED", publishedAt: older(2) } : r));
    const control = runChain("MECHANISM_CURRENT_STATE", paused);
    expect(control.proof.verdict).toBe("NOT_SUPPORTED");
    const newerClaimed = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", officiality: "CLAIMED", mechanismState: "LIVE", publishedAt: older(1) });
    const t = runChain("MECHANISM_CURRENT_STATE", [...paused, newerClaimed]);
    const official = paused.find((r) => r.component === "CURRENT_STATE")!;
    expect(exclusionOf(t.byComponent.get("CURRENT_STATE")!, official.id)).toBe("SUPERSEDED_BY_NEWER");
    expect(t.byComponent.get("CURRENT_STATE")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(t.byComponent.get("CURRENT_STATE")!.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
    expect(t.proof.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(t.proof.confidenceScore).toBeLessThanOrEqual(40);
    // What the rule does NOT do: an unbound explorer page, an INDIRECT row,
    // a CONTEXT / LIMITS row or a foreign row never supersedes anything.
    for (const weak of [
      { ...newerClaimed, id: "cccc0000-0000-4000-8000-000000000001", entityBinding: "UNVERIFIED" as const },
      row("CURRENT_STATE", { directness: "INDIRECT", mechanismState: "LIVE", publishedAt: older(1) }),
      row("CURRENT_STATE", { relationship: "CONTEXT", mechanismState: "LIVE", publishedAt: older(1) }),
      row("CURRENT_STATE", { researchJobId: OTHER_JOB, mechanismState: "LIVE", publishedAt: older(1) }),
    ]) {
      const u = runChain("MECHANISM_CURRENT_STATE", [...paused, weak]);
      expect(exclusionOf(u.byComponent.get("CURRENT_STATE")!, official.id)).toBeNull();
      expect(VERDICT_RANK[u.proof.verdict!]).toBeLessThanOrEqual(VERDICT_RANK[control.proof.verdict!] + (u.proof.verdict === "INSUFFICIENT_EVIDENCE" ? 1 : 0));
      expect(u.proof.verdict).not.toBe("PARTIALLY_SUPPORTED");
      expect(u.proof.verdict).not.toBe("SUPPORTED");
    }
  });

  it("F6d. deterministic on-chain vs documentary: documentary 'it executed' and 'supply fell' never establish execution or net effect; a measured non-decrease refutes a documentary net-reduction claim and the refutation is not softened by the prose", () => {
    const base = world();
    const prose = [
      row("EXECUTION_EVIDENCE", { fragment: "the distributor executes every week", mechanismState: "LIVE" }),
      row("NET_EFFECT", { sourceClass: "OFFICIAL_REPORT", fragment: "1,000,000 tokens were burned reducing total supply" }),
    ];
    const docsOnly = runChain("BURN_OR_SUPPLY_EFFECT", [...without(base, "EXECUTION_EVIDENCE", "NET_EFFECT"), ...prose]);
    expect(docsOnly.byComponent.get("EXECUTION_EVIDENCE")!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(docsOnly.byComponent.get("NET_EFFECT")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(docsOnly.byComponent.get("NET_EFFECT")!.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(docsOnly.proof.verdict).not.toBe("SUPPORTED");
    const notReduced = confirmed("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS", publishedAt: null });
    const chain = runChain("BURN_OR_SUPPLY_EFFECT", [...base, ...prose, notReduced]);
    expect(chain.proof.verdict).toBe("NOT_SUPPORTED");
    const chainNoProse = runChain("BURN_OR_SUPPLY_EFFECT", [...base, notReduced]);
    expect(chain.proof.verdict).toBe(chainNoProse.proof.verdict);
    expect(chain.proof.confidenceScore).toBe(chainNoProse.proof.confidenceScore);
  });

  it("F6e. current official vs stale official of the same class: the newer statement decides, the older is SUPERSEDED — and an older LIVE never revives a newer PAUSED", () => {
    const base = world();
    const control = runChain("MECHANISM_CURRENT_STATE", base);
    const oldPaused = row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: older(2) });
    const a = runChain("MECHANISM_CURRENT_STATE", [...base, oldPaused]);
    sameConclusion(a, control);
    const nowPaused = base.map((r) => (r.component === "CURRENT_STATE" ? { ...r, mechanismState: "PAUSED" } : r));
    const pausedControl = runChain("MECHANISM_CURRENT_STATE", nowPaused);
    const oldLive = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: older(2) });
    const b = runChain("MECHANISM_CURRENT_STATE", [...nowPaused, oldLive]);
    sameConclusion(b, pausedControl);
    expect(b.proof.verdict).toBe("NOT_SUPPORTED");
  });
});

// ====================================================================
describe("F7. freshness monotonicity", () => {
  it("F7a. the same CURRENT_STATE row aged across the HIGH_CHANGE window (fresh, at the boundary, one ms past it, clearly stale): eligibility only ever falls, the answer to 'is it current?' never gets stronger with age, and 'undated' is weaker than any dated row", () => {
    const base = world();
    const ages = [0.5 * DAY, 3 * DAY - 1, 3 * DAY, 3 * DAY + 1, 10 * DAY, 100 * DAY];
    let previous: ChainResult | null = null;
    for (const age of ages) {
      const w = base.map((r) => (r.component === "CURRENT_STATE" ? { ...r, publishedAt: new Date(NOW.getTime() - age) } : r));
      const t = runChain("MECHANISM_CURRENT_STATE", w);
      if (previous) noStrongerThan(t, previous, `age ${age}`);
      nonNegative(t);
      previous = t;
    }
    const fresh = runChain("MECHANISM_CURRENT_STATE", base);
    const atBoundary = runChain("MECHANISM_CURRENT_STATE", base.map((r) => (r.component === "CURRENT_STATE" ? { ...r, publishedAt: new Date(NOW.getTime() - 3 * DAY) } : r)));
    const pastBoundary = runChain("MECHANISM_CURRENT_STATE", base.map((r) => (r.component === "CURRENT_STATE" ? { ...r, publishedAt: new Date(NOW.getTime() - 3 * DAY - 1) } : r)));
    expect(atBoundary.proof.verdict).toBe(fresh.proof.verdict);
    expect(pastBoundary.byComponent.get("CURRENT_STATE")!.reasonCodes).toEqual(["STALE_CURRENT_STATE"]);
    expect(pastBoundary.proof.verdict).toBe("INSUFFICIENT_EVIDENCE");
    const undated = runChain("MECHANISM_CURRENT_STATE", base.map((r) => (r.component === "CURRENT_STATE" ? { ...r, publishedAt: null } : r)));
    expect(undated.byComponent.get("CURRENT_STATE")!.reasonCodes).toEqual(["MISSING_CURRENT_STATE"]);
    noStrongerThan(undated, fresh);
  });

  it("F7b. a stale LIVE row beside a fresh PAUSED row never revives the mechanism; a stale PAUSED row beside a fresh LIVE row never contradicts it — age only removes, never adds", () => {
    const base = world();
    const freshPaused = base.map((r) => (r.component === "CURRENT_STATE" ? { ...r, mechanismState: "PAUSED" } : r));
    const c1 = runChain("MECHANISM_CURRENT_STATE", freshPaused);
    const t1 = runChain("MECHANISM_CURRENT_STATE", [...freshPaused, row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: older(30) })]);
    sameConclusion(t1, c1);
    const c2 = runChain("MECHANISM_CURRENT_STATE", base);
    const t2 = runChain("MECHANISM_CURRENT_STATE", [...base, row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "PAUSED", publishedAt: older(30) })]);
    sameConclusion(t2, c2);
  });
});

// ====================================================================
describe("F11. REQUIRED vs OPTIONAL composition", () => {
  const withRequirements = (intent: string, requirements: ClaimRequirement[]): PatternContent => ({
    ...PATTERN_V1_CONTENT,
    intentRequirements: { ...PATTERN_V1_CONTENT.intentRequirements, [intent]: { requirements } },
  });
  const OPTIONALS: ClaimRequirement[] = [
    { requirementId: "OPT-A", kind: "FLOW_ATTRIBUTE", optionality: "OPTIONAL", attribute: "recipientKind", expectedValues: ["PASSIVE_HOLDER", "STAKER", "TREASURY", "LP", "EXTERNAL", "NODE_OPERATOR"] },
    { requirementId: "OPT-B", kind: "COMPONENT_ESTABLISHED", optionality: "OPTIONAL", components: ["FLOW_PATH"] },
    { requirementId: "OPT-C", kind: "COMPONENT_ESTABLISHED", optionality: "OPTIONAL", components: ["GOVERNANCE_BASIS"] },
    { requirementId: "OPT-D", kind: "LIFECYCLE", optionality: "OPTIONAL", expectedLifecycle: "CURRENT" },
    { requirementId: "OPT-E", kind: "COMPONENT_ESTABLISHED", optionality: "OPTIONAL", components: ["DESTINATION"] },
  ];

  it("F11a. for every intent: adding many satisfied OPTIONAL atoms never lifts the verdict or the band above the REQUIRED-only result; with one REQUIRED basis removed, no number of OPTIONAL atoms brings SUPPORTED back; weak support for the missing basis is at most PARTIAL; a contradiction on a REQUIRED basis is never SUPPORTED", () => {
    const base = world();
    for (const intent of INTENTS) {
      const required = PATTERN_V1_CONTENT.intentRequirements![intent].requirements;
      const enriched = withRequirements(intent, [...required, ...OPTIONALS]);
      const control = runChain(intent, base);
      const withOptional = runChain(intent, base, { pattern: enriched });
      expect(VERDICT_RANK[withOptional.proof.verdict!], intent).toBeLessThanOrEqual(VERDICT_RANK[control.proof.verdict!]);
      if (withOptional.proof.verdict === control.proof.verdict) expect(withOptional.proof.confidenceScore).toBeLessThanOrEqual(control.proof.confidenceScore);
      expect(withOptional.claim.requirementResults.filter((r) => r.optionality === "OPTIONAL").some((r) => r.status === "SATISFIED"), intent).toBe(true);

      // Every load-bearing component: the one whose removal moves the
      // verdict below the control.
      for (const c of ALL_COMPONENTS) {
        const missing = runChain(intent, without(base, c), { pattern: enriched });
        const missingPlain = runChain(intent, without(base, c));
        expect(VERDICT_RANK[missing.proof.verdict!], `${intent} - ${c} + optionals`).toBeLessThanOrEqual(VERDICT_RANK[missingPlain.proof.verdict!]);
        if (VERDICT_RANK[missingPlain.proof.verdict!] < VERDICT_RANK[control.proof.verdict!]) {
          expect(missing.proof.verdict).not.toBe("SUPPORTED");
          // Weak (CLAIMED / social) support for the missing basis: at most PARTIAL.
          const weakBack = runChain(intent, [...without(base, c), row(c, { sourceClass: c.endsWith("_BASIS") ? "GOVERNANCE" : "SOCIAL", officiality: "CLAIMED", mechanismState: control.pool.find((r) => r.component === c)!.mechanismState })], { pattern: enriched });
          expect(weakBack.proof.verdict, `${intent} weak ${c}`).not.toBe("SUPPORTED");
          expect(VERDICT_RANK[weakBack.proof.verdict!]).toBeLessThanOrEqual(VERDICT_RANK[control.proof.verdict!]);
          // A contradiction on the basis: never SUPPORTED.
          const state = control.pool.find((r) => r.component === c)!.mechanismState;
          if (state) {
            const conflicted = runChain(intent, [...base, row(c, { relationship: "CONTRADICTS", mechanismState: state === "APPROVED" ? "REMOVED" : "PAUSED", sourceClass: c.endsWith("_BASIS") ? "GOVERNANCE" : "OFFICIAL_DOCS", officiality: "CONFIRMED" })], { pattern: enriched });
            expect(conflicted.proof.verdict, `${intent} conflict ${c}`).not.toBe("SUPPORTED");
          }
        }
      }
    }
  });

  it("F11b. Round 2 Z1 from the metamorphic side: a requirement set that is all OPTIONAL is not a proposition — the fully sourced control world, which SUPPORTS the intent's real requirements, cannot SUPPORT an optional-only set", () => {
    const base = world();
    for (const intent of INTENTS) {
      const optionalOnly = withRequirements(intent, OPTIONALS);
      const t = runChain(intent, base, { pattern: optionalOnly });
      expect(t.claim.status, intent).not.toBe("SUPPORTED");
      expect(t.claim.reasonCodes).toContain("CLAIM_PROPOSITION_NOT_STRUCTURED");
      expect(t.proof.verdict).not.toBe("SUPPORTED");
    }
  });
});

// ====================================================================
describe("F12. confidence invariants", () => {
  it("F12a. a confidence increase is always explained by a newly ADMISSIBLE, relevant row: over every single-row addition to the control from the weak catalogue, the band never moves; over every admissible CONFIRMED row of the same state it never moves either (nothing was missing)", () => {
    const base = world();
    for (const intent of INTENTS) {
      const control = runChain(intent, base);
      for (const c of ALL_COMPONENTS) {
        for (const w of weakRowsFor(c)) expect(runChain(intent, [...base, w.row]).proof.confidenceScore, `${intent} ${c} ${w.label}`).toBe(control.proof.confidenceScore);
        const same = runChain(intent, [...base, row(c, { mechanismState: control.pool.find((r) => r.component === c)!.mechanismState, sourceClass: control.pool.find((r) => r.component === c)!.sourceClass, officiality: "CONFIRMED", onchainFactKind: control.pool.find((r) => r.component === c)!.onchainFactKind, publishedAt: older(1) })]);
        expect(same.proof.confidenceScore, `${intent} ${c} agreeing`).toBe(control.proof.confidenceScore);
      }
    }
  });

  it("F12b. DECIDED (Round 6.5, Founder decision 2) — adding ONLY inadmissible rows (social posts) to components that had nothing leaves the band exactly where bare absence leaves it: 20 -> 20 on a SUPPORTED verdict, the exclusion recorded, nothing new cited. The full pin is founder-semantics-round6-5-v1 (C, D, E)", () => {
    const supported = [
      row("RECIPIENT", { fragment: "token holders receive the distributed fees" }),
      confirmed("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null }),
      row("CURRENT_STATE", { mechanismState: "LIVE" }),
    ];
    const empty = runChain("PASSIVE_HOLDER_OUTCOME", supported);
    expect(empty.proof.verdict).toBe("SUPPORTED");
    expect(empty.proof.confidenceScore).toBe(20);
    const tweets = ALL_COMPONENTS.filter((c) => !["RECIPIENT", "EXECUTION_EVIDENCE", "CURRENT_STATE"].includes(c)).map((c) => row(c, { sourceClass: "SOCIAL", officiality: "CLAIMED" }));
    const withTweets = runChain("PASSIVE_HOLDER_OUTCOME", [...supported, ...tweets]);
    expect(withTweets.proof.verdict).toBe("SUPPORTED");
    expect(withTweets.proof.citedEvidenceIds).toEqual(empty.proof.citedEvidenceIds);
    for (const t of tweets) expect(withTweets.byComponent.get(t.component!)!.reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    // Excluded evidence is confidence-neutral: the same band as absence.
    expect(withTweets.proof.confidenceScore).toBe(20);
    expect(withTweets.proof.confidenceBindingReasons).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    // The gaps still say every one of those components is unestablished.
    for (const t of tweets) expect(withTweets.proof.gaps.some((g) => g.component === t.component && g.kind === "ALL_EVIDENCE_EXCLUDED")).toBe(true);
  });

  it("F12c. technical boundaries never raise the band: SEARCH_BUDGET_EXHAUSTED, NO_ADMISSIBLE_ROUTE and EXTRACTION_NOT_COMPLETED on an empty component sit exactly where bare absence sits, and never below it either", () => {
    const base = world();
    const pool = without(base, "GOVERNANCE_BASIS");
    const absent = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    for (const boundary of ["SEARCH_BUDGET_EXHAUSTED", "NO_ADMISSIBLE_ROUTE", "EXTRACTION_NOT_COMPLETED"] as const) {
      const t = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool, { boundaries: { GOVERNANCE_BASIS: boundary } });
      expect(t.byComponent.get("GOVERNANCE_BASIS")!.reasonCodes).toEqual([boundary]);
      expect(t.proof.verdict).toBe(absent.proof.verdict);
      expect(t.proof.confidenceScore).toBe(absent.proof.confidenceScore);
      expect(t.claim.requirementResults).toEqual(absent.claim.requirementResults);
      nonNegative(t);
    }
  });

  it("F12d. the contradiction exemption cannot lift a refutation above its other limits: NOT_SUPPORTED with an UNRELATED unresolved conflict still carries that conflict's LIMITED cap through CONFLICTING_STATE", () => {
    const soc = (c: string) => row(c, { sourceClass: "SOCIAL", officiality: "CLAIMED" });
    const pool = [
      row("MECHANISM_SPEC", { mechanismState: "LIVE" }),
      confirmed("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null }),
      row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: older(2) }),
      confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", mechanismState: "APPROVED" }),
      ...["SOURCE_OF_VALUE", "FLOW_PATH", "DESTINATION", "RECIPIENT", "NET_EFFECT", "DURABILITY_BASIS"].map(soc),
    ];
    const govConflict = confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", relationship: "CONTRADICTS", mechanismState: "REMOVED" });
    const refuted = row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: older(1) });
    const clean = runChain("MECHANISM_CURRENT_STATE", [...pool, refuted]);
    expect(clean.proof.verdict).toBe("NOT_SUPPORTED");
    const withUnrelated = runChain("MECHANISM_CURRENT_STATE", [...pool, refuted, govConflict]);
    expect(withUnrelated.proof.verdict).toBe("NOT_SUPPORTED");
    expect(withUnrelated.byComponent.get("GOVERNANCE_BASIS")!.status).toBe("CONTRADICTED");
    expect(withUnrelated.proof.confidenceScore).toBeLessThanOrEqual(40);
    expect(withUnrelated.proof.confidenceScore).toBeLessThanOrEqual(clean.proof.confidenceScore);
  });
});

// ====================================================================
describe("F13/F14. provenance under every transformation, and the fresh review", () => {
  it("F13a. across the control and every transformation above: cited rows are supporting rows, excluded and contradicting rows are never cited, foreign rows are never admitted, and the S5 sets stay disjoint", () => {
    const base = world();
    const worlds: EvidenceRow[][] = [
      base,
      [...base, ...ALL_COMPONENTS.flatMap((c) => weakRowsFor(c).map((w) => w.row))],
      [...base, row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "PAUSED", publishedAt: older(1) })],
      [...base, ...Array.from({ length: 4 }, (_, i) => row("DESTINATION", { contentHash: "same-hash", sourceId: `mirror-${i}` }))],
      without(base, "SOURCE_OF_VALUE"),
      [...base, confirmed("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS", publishedAt: null })],
    ];
    for (const intent of INTENTS) for (const w of worlds) provenanceHolds(runChain(intent, w));
  });

  it("F14a. FRESH REVIEW — a row that is admissible for ONE component cannot be made to count for another by filing it under the other's step: a chain burn filed at DESTINATION, an official DESTINATION statement filed at EXECUTION_EVIDENCE, a governance approval filed at CURRENT_STATE — each establishes nothing there and the conclusion equals the control", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const misfiled = [
      confirmed("DESTINATION", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", publishedAt: null }),
      row("EXECUTION_EVIDENCE", { fragment: "fees are distributed to token holders via the distributor", mechanismState: "LIVE" }),
      confirmed("CURRENT_STATE", { sourceClass: "GOVERNANCE", mechanismState: "APPROVED", fragment: "the proposal to distribute fees passed" }),
    ];
    const t = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base, ...misfiled]);
    sameConclusion(t, control);
    for (const m of misfiled) expect(t.proof.citedEvidenceIds).not.toContain(m.id);
  });

  it("F14b. FRESH REVIEW — the same world with every row's publication date moved one year earlier (a consistent, irrelevant shift for the non-current components) changes only the current-state answer: everything not gated on currentness is identical", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const shifted = base.map((r) => (r.publishedAt ? { ...r, publishedAt: new Date(r.publishedAt.getTime() - 365 * DAY) } : r));
    const t = runChain("PROTOCOL_REVENUE_TO_TOKEN", shifted);
    for (const c of ALL_COMPONENTS) {
      if (c === "CURRENT_STATE") {
        expect(t.byComponent.get(c)!.reasonCodes).toEqual(["STALE_CURRENT_STATE"]);
        continue;
      }
      expect([t.byComponent.get(c)!.status, t.byComponent.get(c)!.reasonCodes], c).toEqual([control.byComponent.get(c)!.status, control.byComponent.get(c)!.reasonCodes]);
    }
    noStrongerThan(t, control);
  });
});
