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
import { buildProof, type ProofBuilderInput, type ProofDraft } from "../src/server/engine/proof-builder";

// ROUND 6.6 — FOUNDER SEMANTIC HARDENING: SPANNING SOURCE + BOUNDED
// ENUMERATION, THE PURE CHAIN.
//
// Round 6.5 left two boundaries; the Founder decided both on 2026-09-16:
//
//   1. SAME SOURCE != EXTRA INDEPENDENT CONFIDENCE, and SAME SOURCE !=
//      AUTOMATIC PENALTY. One page's agreeing passages are never
//      independent corroboration; but a page that spans a fork with ONE
//      element below it offers no pairing choice and continues on every
//      branch it spans (one shared provenance). Two shared elements — a
//      genuine pairing choice, audit HIGH-1 — stay unresolved. Cases A–E.
//   2. BOUNDED ENUMERATION != WEAKER TRUTH. The flow cap (MAX_FLOWS 64)
//      remains; when it binds, the lineage continues with the
//      structurally-first slot, FLOW_ENUMERATION_INCOMPLETE stays visible
//      on the flow, on the result and in the Proof, and it never binds the
//      band. Cases F–J.
//
// Real S5 -> S6 -> S7 -> S8 chain over the real Pattern v1 contract. Not an
// adversarial round; does not count toward the two clean rounds. Pure: no
// DB, no model, no network.

const JOB = "dddddddd-0000-4000-8000-000000000066";
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
  const id = overrides.id ?? `r${String(seq).padStart(4, "0")}-0000-4000-8000-000000000066`;
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
}

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



// A twin of the control's row at `component`: same class / officiality /
// state / date, a different extraction unit, from `sourceId`.
function twinFrom(component: string, pool: EvidenceRow[], sourceId: string, fragment?: string): EvidenceRow {
  const o = pool.find((r) => r.component === component)!;
  return row(component, { sourceClass: o.sourceClass, officiality: o.officiality, entityBinding: o.entityBinding, onchainFactKind: o.onchainFactKind, mechanismState: o.mechanismState, publishedAt: o.publishedAt, fragment: fragment ?? o.fragment, sourceId });
}
// The control's rows for `components` re-sourced to ONE page.
function fromOnePage(pool: EvidenceRow[], components: string[], page: string): EvidenceRow[] {
  return pool.map((r) => (components.includes(r.component!) ? { ...r, sourceId: page } : r));
}
const prt2 = (c: ChainResult) => c.claim.requirementResults.find((r) => r.requirementId === "PRT-2")?.status;
const hasGap = (c: ChainResult, kind: string, component?: string) => c.assembly.flows.some((f) => f.gaps.some((g) => g.kind === kind && (component === undefined || g.component === component)));
const everyFlowHas = (c: ChainResult, kind: string, component?: string) => c.assembly.flows.every((f) => f.gaps.some((g) => g.kind === kind && (component === undefined || g.component === component)));
const minusCap = (k: ReturnType<typeof conclusion>) => ({ ...k, gaps: k.gaps.filter((g) => !g.includes("FLOW_ENUMERATION_INCOMPLETE")) });
// A deterministic shuffle (LCG) for the permutation cases.
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function snapshot(c: ChainResult) {
  return { ...conclusion(c), flowIds: c.assembly.flows.map((f) => f.flowId), flowGaps: c.assembly.flows.map((f) => f.gaps.map((g) => `${g.kind}@${g.component}`)), cited: [...c.proof.citedEvidenceIds].sort() };
}

// ====================================================================
describe("Decision 1 — SAME SOURCE != EXTRA CONFIDENCE, SAME SOURCE != AUTOMATIC PENALTY", () => {
  it("A. one official page carries two agreeing passages for two compatible components (SOURCE_OF_VALUE and FLOW_PATH): one source provenance, one flow, the same conclusion and band as the two-page control — no corroboration bonus, no penalty for spanning components — for every intent", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      const onePage = runChain(intent, fromOnePage(base, ["SOURCE_OF_VALUE", "FLOW_PATH"], "page-P"));
      expect(conclusion(onePage), intent).toEqual(conclusion(control));
      expect(onePage.assembly.flows.length, intent).toBe(control.assembly.flows.length);
      expect(onePage.proof.citedEvidenceIds, intent).toEqual(control.proof.citedEvidenceIds);
      const sov = onePage.assembly.flows[0].lineage.find((s) => s.component === "SOURCE_OF_VALUE")!;
      const fp = onePage.assembly.flows[0].lineage.find((s) => s.component === "FLOW_PATH")!;
      expect(new Set([...sov.evidenceIds, ...fp.evidenceIds].map((id) => onePage.pool.find((r) => r.id === id)!.sourceId)), intent).toEqual(new Set(["page-P"]));
      provenanceHolds(onePage);
    }
    // And every component from ONE page: still one flow, still the control.
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const docs = ALL_COMPONENTS.filter((c) => base.find((r) => r.component === c)!.sourceClass === "OFFICIAL_DOCS");
    const all = runChain("PROTOCOL_REVENUE_TO_TOKEN", fromOnePage(base, docs, "page-P"));
    expect(conclusion(all)).toEqual(conclusion(control));
    expect(all.assembly.flows.length).toBe(1);
  });

  it("B. the same page yields several duplicate / near-identical agreeing fragments: exact duplicates reduce to one representative (DUPLICATE_UNIT) and equal the single fragment; near-identical distinct fragments are distinct slots (D-101) whose flows all continue with the page's one element below — never a confidence multiplication, the same conclusion as the minimal equivalent source", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const sov = base.find((r) => r.component === "SOURCE_OF_VALUE")!;
    // Exact duplicates: same extraction unit, same content hash.
    const dupes = Array.from({ length: 4 }, () => ({ ...sov, id: row("SOURCE_OF_VALUE").id, extractionUnitKey: sov.extractionUnitKey, contentHash: sov.contentHash }));
    const d = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base, ...dupes]);
    expect(d.byComponent.get("SOURCE_OF_VALUE")!.supportingEvidenceIds.length).toBe(1);
    for (const x of dupes) expect(d.byComponent.get("SOURCE_OF_VALUE")!.excludedEvidence.find((e) => e.evidenceId === x.id)?.reason).toBe("DUPLICATE_UNIT");
    expect(conclusion(d)).toEqual(conclusion(control));
    expect(d.assembly.flows.length).toBe(control.assembly.flows.length);
    expect(d.proof.citedEvidenceIds).toEqual(control.proof.citedEvidenceIds);
    // Near-identical distinct fragments from ONE page, plus that page's own
    // DESTINATION: three slots, three flows, one shared DESTINATION element
    // on each, the control's conclusion and band.
    const page = "page-P";
    const near = [
      { ...sov, sourceId: page },
      twinFrom("SOURCE_OF_VALUE", base, page, "protocol fees paid by users are the revenue"),
      twinFrom("SOURCE_OF_VALUE", base, page, "the revenue comes from protocol fees paid by users"),
    ];
    const dest = { ...base.find((r) => r.component === "DESTINATION")!, sourceId: page };
    const n = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...base.filter((r) => r.component !== "SOURCE_OF_VALUE" && r.component !== "DESTINATION"), ...near, dest]);
    expect(n.byComponent.get("SOURCE_OF_VALUE")!.supportingEvidenceIds.length).toBe(3);
    expect(n.assembly.flows.length).toBe(3);
    expect(n.assembly.flows.every((f) => f.lineage.find((s) => s.component === "DESTINATION")?.evidenceIds[0] === dest.id)).toBe(true);
    expect(hasGap(n, "BRANCH_ATTRIBUTION_UNRESOLVED")).toBe(false);
    expect(conclusion(n)).toEqual(conclusion(control));
    expect(prt2(n)).toBe(prt2(control));
    provenanceHolds(n);
  });

  it("C. the same source genuinely leaves branch attribution ambiguous (two allocations AND two destinations on one page — audit HIGH-1): the pairing is not guessed, DESTINATION stays BRANCH_ATTRIBUTION_UNRESOLVED on both branches, the claim weakens for that named reason and never merges", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const page = "page-P";
    const mech = base.find((r) => r.component === "MECHANISM_SPEC")!;
    const pool = [
      ...base.filter((r) => r.component !== "MECHANISM_SPEC" && r.component !== "DESTINATION"),
      { ...mech, sourceId: page, fragment: "fifty percent of fees fund the buyback" },
      twinFrom("MECHANISM_SPEC", base, page, "thirty percent of fees go to treasury operations"),
      row("DESTINATION", { sourceId: page, fragment: "bought back tokens are sent to the burn address" }),
      row("DESTINATION", { sourceId: page, fragment: "the treasury share is held in the treasury wallet" }),
    ];
    for (const p of [pool, [...pool].reverse()]) {
      const c = runChain("PROTOCOL_REVENUE_TO_TOKEN", p);
      expect(c.assembly.flows.length).toBe(2);
      expect(c.assembly.flows.every((f) => !f.lineage.some((s) => s.component === "DESTINATION"))).toBe(true);
      expect(everyFlowHas(c, "BRANCH_ATTRIBUTION_UNRESOLVED", "DESTINATION")).toBe(true);
      expect(prt2(c)).toBe("UNSATISFIED");
      noStrongerThan(c, control, "HIGH-1 shape");
      expect(c.proof.verdict).not.toBe("NOT_SUPPORTED");
      provenanceHolds(c);
    }
  });

  it("D. two truly independent authoritative sources for the same element: the existing independent-source semantics stand — two slots, two flows, both cited, the control's conclusion — and the same-page shape gives exactly the same conclusion, differing only in provenance (independence is never a bonus, sharing never a penalty)", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      for (const component of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION"]) {
        const original = base.find((r) => r.component === component)!;
        const independent = runChain(intent, [...base, twinFrom(component, base, `independent-${component}`)]);
        const samePage = runChain(intent, [...base, twinFrom(component, base, original.sourceId)]);
        const label = `${intent} / ${component}`;
        expect(independent.assembly.flows.length, label).toBe(2);
        expect(samePage.assembly.flows.length, label).toBe(2);
        expect(conclusion(independent), label).toEqual(conclusion(control));
        expect(conclusion(samePage), label).toEqual(conclusion(control));
        expect(hasGap(independent, "BRANCH_ATTRIBUTION_UNRESOLVED"), label).toBe(false);
        expect(hasGap(samePage, "BRANCH_ATTRIBUTION_UNRESOLVED"), label).toBe(false);
        if (control.proof.citedEvidenceIds.includes(original.id)) {
          expect(independent.proof.citedEvidenceIds.length, label).toBe(control.proof.citedEvidenceIds.length + 1);
          expect(samePage.proof.citedEvidenceIds.length, label).toBe(control.proof.citedEvidenceIds.length + 1);
        }
      }
    }
  });

  it("E. the exact Round 6.5 G2 shape — two agreeing SOURCE_OF_VALUE passages and the DESTINATION statement from ONE page: the lineage forks, the one shared DESTINATION element continues on both branches, no BRANCH_ATTRIBUTION_UNRESOLVED, PRT-2 PARTIAL as the control, the same band; a second DESTINATION element from that page restores the genuine ambiguity of case C", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const page = "page-P";
    const spanning = [
      row("SOURCE_OF_VALUE", { fragment: "swap fees generate the revenue", sourceId: page }),
      row("SOURCE_OF_VALUE", { fragment: "lending fees generate the revenue", sourceId: page }),
      row("DESTINATION", { fragment: "fees are distributed to token holders via the distributor", sourceId: page }),
      ...base.filter((r) => r.component !== "SOURCE_OF_VALUE" && r.component !== "DESTINATION"),
    ];
    for (const p of [spanning, [...spanning].reverse(), shuffled(spanning, 7)]) {
      const s = runChain("PROTOCOL_REVENUE_TO_TOKEN", p);
      expect(s.assembly.flows.length).toBe(2);
      expect(s.assembly.flows.every((f) => f.lineage.some((st) => st.component === "DESTINATION"))).toBe(true);
      expect(hasGap(s, "BRANCH_ATTRIBUTION_UNRESOLVED")).toBe(false);
      expect(prt2(s)).toBe("PARTIAL");
      expect(conclusion(s)).toEqual(conclusion(control));
      provenanceHolds(s);
    }
    const u = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...spanning, row("DESTINATION", { fragment: "lending fees are sent to the treasury", sourceId: page })]);
    expect(everyFlowHas(u, "BRANCH_ATTRIBUTION_UNRESOLVED", "DESTINATION")).toBe(true);
    expect(prt2(u)).toBe("UNSATISFIED");
    noStrongerThan(u, control, "two shared elements");
  });
});

// ====================================================================
const twins = (base: EvidenceRow[], n: number) => ALL_COMPONENTS.slice(0, n).map((c) => twinFrom(c, base, `twin-${c}`));

describe("Decision 2 — BOUNDED ENUMERATION != WEAKER TRUTH", () => {

  it("F. multiplicity below the cap (twins at one to four components): full enumeration — 2^n flows, no FLOW_ENUMERATION_INCOMPLETE anywhere, the control's conclusion, for every intent", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      for (const n of [1, 2, 3, 4]) {
        const t = runChain(intent, [...base, ...twins(base, n)]);
        const label = `${intent} / ${n} twins`;
        expect(t.assembly.flows.length, label).toBe(2 ** n);
        expect(hasGap(t, "FLOW_ENUMERATION_INCOMPLETE"), label).toBe(false);
        expect(t.assembly.unassignedGaps.length, label).toBe(0);
        expect(conclusion(t), label).toEqual(conclusion(control));
      }
    }
  });

  it("G. multiplicity exactly at the boundary: five two-slot components are 32 flows, fully enumerated, no cap gap; the sixth is refused — 32 flows still, every flow continuing with the structurally-first slot and carrying the gap — and both results are deterministic across input order with no downgrade", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const five = [...base, ...twins(base, 5)];
    const six = [...base, ...twins(base, 6)];
    const a = runChain("PROTOCOL_REVENUE_TO_TOKEN", five);
    expect(a.assembly.flows.length).toBe(32);
    expect(hasGap(a, "FLOW_ENUMERATION_INCOMPLETE")).toBe(false);
    expect(conclusion(a)).toEqual(conclusion(control));
    const b = runChain("PROTOCOL_REVENUE_TO_TOKEN", six);
    expect(b.assembly.flows.length).toBe(32);
    expect(everyFlowHas(b, "FLOW_ENUMERATION_INCOMPLETE", ALL_COMPONENTS[5])).toBe(true);
    expect(b.assembly.unassignedGaps.map((g) => `${g.kind}@${g.component}`)).toEqual([`FLOW_ENUMERATION_INCOMPLETE@${ALL_COMPONENTS[5]}`]);
    expect(b.assembly.flows.every((f) => f.lineage.some((s) => s.component === ALL_COMPONENTS[5]))).toBe(true);
    expect(minusCap(conclusion(b))).toEqual(minusCap(conclusion(control)));
    for (const seed of [1, 2, 3]) {
      expect(snapshot(runChain("PROTOCOL_REVENUE_TO_TOKEN", shuffled(five, seed)))).toEqual(snapshot(a));
      expect(snapshot(runChain("PROTOCOL_REVENUE_TO_TOKEN", shuffled(six, seed)))).toEqual(snapshot(b));
    }
  });

  it("H. multiplicity above the cap (twins at every component, 2^10 combinations): enumeration stays bounded at 32, every flow is a complete lineage of established rows, FLOW_ENUMERATION_INCOMPLETE is visible on every flow, on the result and in the Proof, and the conclusion is exactly the control's — verdict, requirements, band, binding — for every intent", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      const t = runChain(intent, [...base, ...twins(base, 10)]);
      const label = intent;
      expect(t.assembly.flows.length, label).toBe(32);
      expect(t.assembly.flows.every((f) => ALL_COMPONENTS.every((c) => f.lineage.some((s) => s.component === c))), label).toBe(true);
      expect(everyFlowHas(t, "FLOW_ENUMERATION_INCOMPLETE"), label).toBe(true);
      expect(t.assembly.unassignedGaps.some((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE"), label).toBe(true);
      expect(t.proof.gaps.some((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE" && g.origin === "CLAIM_CONTEXT"), label).toBe(true);
      expect(t.assembly.flows.every((f) => f.shape === "PARTIAL_PATH"), label).toBe(true);
      expect(minusCap(conclusion(t)), label).toEqual(minusCap(conclusion(control)));
      expect(t.proof.confidenceBindingReasons, label).not.toContain("CLAIM_CONTEXT_GAP");
      noWeakerThan(t, control, label);
      noStrongerThan(t, control, label);
      // The retained slot is the structurally-first one, so every flow's
      // rows are the control's or their twins — never something invented.
      const admitted = new Set(t.results.flatMap((r) => r.supportingEvidenceIds));
      for (const f of t.assembly.flows) for (const s of f.lineage) for (const id of s.evidenceIds) expect(admitted.has(id), label).toBe(true);
      provenanceHolds(t);
    }
  });

  it("H2. the band predicate itself: an enumeration-limit context gap never binds the band, a mechanism context gap still does — on the S8 builder with a SUPPORTED verdict and no other limitation", () => {
    const build = (contextGaps: ProofBuilderInput["claimSupport"] extends infer C ? (C extends { contextGaps: infer G } ? G : never) : never) =>
      buildProof({
        researchJobId: JOB,
        componentResults: [{ step: 6, component: "RECIPIENT", status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["e1"], excludedEvidence: [] }],
        existingEvidenceIds: ["e1"],
        claimSupport: {
          intent: "PASSIVE_HOLDER_OUTCOME",
          status: "SUPPORTED",
          reasonCodes: [],
          requirementResults: [{ requirementId: "X-1", optionality: "REQUIRED", status: "SATISFIED", reasonCodes: [], matchedFlowIds: ["f1"], blockingGaps: [], provenance: { flowIds: ["f1"], componentResultKeys: [{ step: 6, component: "RECIPIENT" }], evidenceIds: ["e1"] } }],
          contextGaps,
        },
      });
    const withCap = build([{ flowId: null, kind: "FLOW_ENUMERATION_INCOMPLETE", component: "CURRENT_STATE", afterStep: 5 }]);
    const withMissing = build([{ flowId: "f2", kind: "MISSING_COMPONENT", component: "CURRENT_STATE", afterStep: 5 }]);
    expect(withCap.proof!.confidenceScore).toBe(80);
    expect(withCap.proof!.confidenceBindingReasons).toEqual(["VERDICT_CEILING"]);
    expect(withCap.proof!.gaps.some((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE" && g.origin === "CLAIM_CONTEXT")).toBe(true);
    expect(withMissing.proof!.confidenceScore).toBe(60);
    expect(withMissing.proof!.confidenceBindingReasons).toEqual(["CLAIM_CONTEXT_GAP"]);
  });

  it("I. above the cap WITH a real contradiction: a fresh official PAUSED beside LIVE at CURRENT_STATE (or MECHANISM_SPEC) is CONTRADICTED in S5, CONTRADICTED_COMPONENT on every flow and in the Proof, the band capped by COMPONENT_CONTRADICTED — the cap hides nothing, and the result is no stronger than the contradicted control", () => {
    for (const intent of INTENTS) {
      const base = world();
      for (const component of ["CURRENT_STATE", "MECHANISM_SPEC"]) {
        const original = base.find((r) => r.component === component)!;
        const counter = row(component, { fragment: "the mechanism is paused", mechanismState: "PAUSED", publishedAt: original.publishedAt });
        const contradictedControl = runChain(intent, [...base, counter]);
        const t = runChain(intent, [...base, ...twins(base, 10), counter]);
        const label = `${intent} / ${component}`;
        expect(t.byComponent.get(component)!.status, label).toBe("CONTRADICTED");
        expect(everyFlowHas(t, "CONTRADICTED_COMPONENT", component), label).toBe(true);
        expect(t.proof.gaps.some((g) => (g.kind === "CONTRADICTED_COMPONENT" || g.kind === "CONFLICTING_STATE") && g.component === component), label).toBe(true);
        expect(everyFlowHas(t, "FLOW_ENUMERATION_INCOMPLETE"), label).toBe(true);
        if (t.proof.verdict !== "NOT_SUPPORTED") expect(t.proof.confidenceScore, label).toBeLessThanOrEqual(40);
        expect(t.proof.verdict, label).toBe(contradictedControl.proof.verdict);
        expect(t.claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`), label).toEqual(contradictedControl.claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`));
        noStrongerThan(t, contradictedControl, label);
        noStrongerThan(t, runChain(intent, base), label);
        provenanceHolds(t);
      }
    }
  });

  it("J. the same above-cap input in six insertion orders: byte-identical flow ids, flow gaps, requirements, verdict, band and citations", () => {
    for (const intent of ["PROTOCOL_REVENUE_TO_TOKEN", "MECHANISM_CURRENT_STATE", "BURN_OR_SUPPLY_EFFECT"]) {
      const base = world();
      const pool = [...base, ...twins(base, 10)];
      const reference = snapshot(runChain(intent, pool));
      for (const seed of [11, 23, 37, 59, 71]) expect(snapshot(runChain(intent, shuffled(pool, seed))), `${intent} seed ${seed}`).toEqual(reference);
      expect(snapshot(runChain(intent, [...pool].reverse())), intent).toEqual(reference);
    }
  });
});

// ====================================================================
describe("No false semantics", () => {
  it("DUPLICATE FRAGMENTS != INDEPENDENT CORROBORATION: for every intent and every documentary component, five near-identical fragments from the control's own page give the control's band and verdict; the same five from five independent pages give the very same — count is never footing", () => {
    for (const intent of INTENTS) {
      const base = world();
      const control = runChain(intent, base);
      for (const component of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION", "RECIPIENT"]) {
        const original = base.find((r) => r.component === component)!;
        const samePage = runChain(intent, [...base, ...Array.from({ length: 4 }, (_, i) => twinFrom(component, base, original.sourceId, `${original.fragment} (${i})`))]);
        const pages = runChain(intent, [...base, ...Array.from({ length: 4 }, (_, i) => twinFrom(component, base, `page-${i}`, `${original.fragment} (${i})`))]);
        const label = `${intent} / ${component}`;
        expect(conclusion(samePage), label).toEqual(conclusion(control));
        expect(conclusion(pages), label).toEqual(conclusion(control));
        expect(samePage.proof.confidenceScore, label).toBe(control.proof.confidenceScore);
        expect(pages.proof.confidenceScore, label).toBe(control.proof.confidenceScore);
      }
    }
  });

  it("SHARED SOURCE != AUTOMATIC ATTRIBUTION FAILURE, and ENUMERATION LIMIT != PROJECT COUNTEREVIDENCE, and REAL CONTRADICTION MAY STILL WEAKEN: the E, H and I relations together on one world", () => {
    const base = world();
    const control = runChain("PROTOCOL_REVENUE_TO_TOKEN", base);
    const page = "page-P";
    // The control's documentary rows all from ONE page, plus an agreeing
    // twin of every component from an independent page each: the page
    // spans every fork with one element per component (no pairing choice),
    // the twins name no branch or their own, enumeration is bounded, and
    // nothing is unresolved: the conclusion is the control's.
    const onePage = fromOnePage(base, ALL_COMPONENTS, page);
    const t = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...onePage, ...twins(base, 10)]);
    expect(t.assembly.flows.length).toBeLessThanOrEqual(64); // MAX_FLOWS
    expect(t.assembly.flows.length).toBeGreaterThan(1);
    expect(hasGap(t, "BRANCH_ATTRIBUTION_UNRESOLVED")).toBe(false);
    expect(t.assembly.flows.every((f) => ALL_COMPONENTS.every((c) => f.lineage.some((s) => s.component === c)))).toBe(true);
    expect(minusCap(conclusion(t))).toEqual(minusCap(conclusion(control)));
    expect(t.proof.confidenceBindingReasons).not.toContain("CLAIM_CONTEXT_GAP");
    // Whereas TWO elements of the page at every component below the first
    // fork is the genuine pairing choice of case C, repeated: unresolved,
    // never merged, never stronger.
    const twoEach = fromOnePage([...base, ...twins(base, 10)], ALL_COMPONENTS, page);
    const u = runChain("PROTOCOL_REVENUE_TO_TOKEN", twoEach);
    expect(u.assembly.flows.length).toBe(2);
    expect(everyFlowHas(u, "BRANCH_ATTRIBUTION_UNRESOLVED")).toBe(true);
    noStrongerThan(u, control, "two elements per component from one page");
    // A real contradiction on that same page still weakens.
    const counter = row("CURRENT_STATE", { fragment: "the mechanism is paused", mechanismState: "PAUSED", sourceId: page, publishedAt: base.find((r) => r.component === "CURRENT_STATE")!.publishedAt });
    const c = runChain("PROTOCOL_REVENUE_TO_TOKEN", [...onePage, ...twins(base, 10), counter]);
    expect(c.byComponent.get("CURRENT_STATE")!.status).toBe("CONTRADICTED");
    expect(everyFlowHas(c, "CONTRADICTED_COMPONENT", "CURRENT_STATE")).toBe(true);
    noStrongerThan(c, control, "contradiction on the shared page");
    expect(c.proof.confidenceScore).toBeLessThanOrEqual(40);
  });
});
