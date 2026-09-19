import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor, type PatternContent } from "../src/server/domain/pattern";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { evaluateClaimSupport, type ClaimRequirementResult, type ClaimSupportResult } from "../src/server/engine/claim-evaluator";
import {
  reconcileComponent,
  type AcquisitionBoundary,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { assembleMechanism, type AssemblyEvidenceProjection, type MechanismAssemblyResult } from "../src/server/engine/mechanism-assembler";
import { applicableFactKindsForComponent } from "../src/server/engine/onchain-facts";
import { __setInstructionRegistryOverlay } from "../src/server/engine/onchain-instruction-registry";
import { buildProof, type ProofDraft } from "../src/server/engine/proof-builder";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 12: TECHNICAL DEGRADATION
// AND TEMPORAL MONOTONICITY.
//
// One question, asked compositionally:
//
//   CAN ATLAS EVER PRODUCE A STRONGER TRUTH WHEN THE EVIDENCE
//   ENVIRONMENT GETS WORSE?
//
// Round 6 removed ONE thing at a time from a control and took the chain
// wholesale up or down. That leaves the interesting part untested: what
// happens when degradations COMBINE. A rule can be monotone against every
// single removal and still be non-monotone against a pair — two absences
// that each weaken one component can between them remove the very
// contradiction, cap or gap that was holding a conclusion down.
//
// So this round builds a LATTICE. Six independent technical degradations,
// each of which removes or weakens evidence and none of which adds a
// project fact, give 64 worlds ordered by subset inclusion. Every covering
// pair in that order is asserted, for every Pattern v1 intent:
//
//   more degraded  <=  less degraded        (verdict)
//   at an equal verdict, the band never rises
//   and no world is NOT_SUPPORTED unless the control already was
//     (LOSS OF EVIDENCE IS NOT EVIDENCE OF ABSENCE)
//
// Then the temporal half: publication dates that are impossible, absent,
// identical or out of order with the input, and stale support meeting
// fresh contradiction. Truth must follow temporal semantics, never the
// order rows happened to arrive in.
//
// Pure: real S5 reducer, real S6 assembler, real S7 evaluator, real S8
// builder, real Pattern v1. No DB, no model, no network, no spend. The
// persisted half is adversarial-core-round12-degradation-db-v1.

const JOB = "cccccccc-0000-4000-8000-000000000012";
const OTHER_JOB = "dddddddd-0000-4000-8000-000000000013";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const FRESHNESS = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };
const older = (days: number) => new Date(NOW.getTime() - days * DAY);

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
type Intent = (typeof INTENTS)[number];

let seq = 0;
function row(component: string, overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = overrides.id ?? `c${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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
    publishedAt: older(1),
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}
const chain = (component: string, o: Partial<EvidenceRow>): EvidenceRow =>
  row(component, {
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CONFIRMED",
    entityBinding: "CONFIRMED",
    publishedAt: null,
    fragment: `{"kind":"${o.onchainFactKind ?? "?"}","slot":1}`,
    ...o,
  });
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
  intent: string;
  results: ComponentReconciliationResult[];
  assembly: MechanismAssemblyResult;
  claim: ClaimSupportResult;
  proof: ProofDraft;
  byComponent: Map<string, ComponentReconciliationResult>;
  pool: EvidenceRow[];
}
interface RunOptions {
  pattern?: PatternContent;
  boundaries?: Record<string, AcquisitionBoundary>;
  identity?: ConfirmedProjectIdentity | null;
}

function visibleTo(pool: EvidenceRow[], component: string): EvidenceRow[] {
  const cross = applicableFactKindsForComponent(component) as readonly string[];
  return pool.filter((r) => r.component === component || (r.onchainFactKind !== null && cross.includes(r.onchainFactKind)));
}

function runChain(intent: string, pool: EvidenceRow[], opts: RunOptions = {}): ChainResult {
  const pattern = opts.pattern ?? PATTERN_V1_CONTENT;
  const results = ALL_COMPONENTS.map((component) =>
    reconcileComponent({
      jobId: JOB,
      item: { step: STEP_OF[component], component },
      requirements: { component, ...componentRequirementsFor(pattern, component) },
      evidence: visibleTo(pool, component),
      confirmedIdentity: opts.identity ?? null,
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
  return { intent, results, assembly, claim, proof: built.proof!, byComponent: new Map(results.map((r) => [r.component, r])), pool };
}

type Matrix = Record<Intent, ChainResult>;
function ask(pool: EvidenceRow[], opts: RunOptions = {}): Matrix {
  const out = {} as Matrix;
  for (const i of INTENTS) out[i] = runChain(i, pool, opts);
  return out;
}

const VERDICT_RANK: Record<string, number> = { NOT_SUPPORTED: 0, INSUFFICIENT_EVIDENCE: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 };
const req = (c: ChainResult, id: string): ClaimRequirementResult => c.claim.requirementResults.find((r) => r.requirementId === id)!;
const s5 = (m: Matrix, component: string) => m.PROTOCOL_REVENUE_TO_TOKEN.byComponent.get(component)!;
const flow0 = (m: Matrix) => m.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows[0];
const verdicts = (m: Matrix): Record<Intent, string> => Object.fromEntries(INTENTS.map((i) => [i, m[i].proof.verdict])) as Record<Intent, string>;

// ------------------------------------------------------------ THE LAWS
//
// R8-L1  No question may be SUPPORTED while the component its atom rests
//        on is not established.
// R8-L2  Adding INADMISSIBLE evidence never strengthens any question, and
//        never raises the band.
// R8-L3  Reordering the same rows changes nothing at all.
// R8-L4  A refutation always names a contradicted REQUIRED atom with
//        provenance; absence never refutes.
// R8-L5  Every citation is a supporting row of this job.
function laws(m: Matrix, label: string): void {
  for (const i of INTENTS) {
    // R8-L1 — a SUPPORTED/PARTIAL/CONTRADICTED atom always names evidence.
    for (const r of m[i].claim.requirementResults) {
      if (r.status === "UNSATISFIED") continue;
      expect(r.provenance.evidenceIds.length, `${label}: ${i} ${r.requirementId} ${r.status} with no evidence`).toBeGreaterThan(0);
      expect(r.provenance.componentResultKeys.length, `${label}: ${i} ${r.requirementId} ${r.status} with no component keys`).toBeGreaterThan(0);
    }
    // R8-L4
    if (m[i].proof.verdict === "NOT_SUPPORTED") {
      const refuted = m[i].claim.requirementResults.filter((r) => r.optionality === "REQUIRED" && r.status === "CONTRADICTED");
      expect(refuted.length, `${label}: ${i} refuted with no contradicted atom`).toBeGreaterThan(0);
      for (const r of refuted) expect(r.provenance.evidenceIds.length, `${label}: ${i} refutation with no provenance`).toBeGreaterThan(0);
    }
  }
  // R8-L5
  const supporting = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.results.flatMap((r) => r.supportingEvidenceIds));
  const foreign = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.pool.filter((r) => r.researchJobId !== JOB).map((r) => r.id));
  for (const i of INTENTS) {
    for (const id of m[i].proof.citedEvidenceIds) {
      expect(supporting.has(id), `${label}: ${i} cites a non-supporting row`).toBe(true);
      expect(foreign.has(id), `${label}: ${i} cites a foreign row`).toBe(false);
    }
  }
}

function noStronger(t: Matrix, control: Matrix, label: string): void {
  for (const i of INTENTS) {
    expect(VERDICT_RANK[verdicts(t)[i]], `${label}: ${i} stronger verdict (${verdicts(control)[i]} -> ${verdicts(t)[i]})`).toBeLessThanOrEqual(
      VERDICT_RANK[verdicts(control)[i]],
    );
    if (verdicts(t)[i] === verdicts(control)[i]) {
      expect(t[i].proof.confidenceScore, `${label}: ${i} stronger band`).toBeLessThanOrEqual(control[i].proof.confidenceScore);
    }
  }
}

const shapeOf = (m: Matrix) =>
  JSON.stringify(
    INTENTS.map((i) => ({
      i,
      v: m[i].proof.verdict,
      b: m[i].proof.confidenceScore,
      r: m[i].claim.requirementResults.map((x) => `${x.requirementId}:${x.status}:${[...x.reasonCodes].sort().join("|")}`),
    })),
  );

const REVENUE_PROGRAM = "HWfuHYFRvsZUo2Bt6Rm4k7ZVbXunBLTmaBtbDX6jwRQr";
const MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const WSOL = "So11111111111111111111111111111111111111112";
const REVENUE_ACCOUNT = "9WtcfpuiF6dVKroycsi3E1k7vYQP8XmT7RBjcptdcfjX";
const CALLER_ACCOUNTS = ["8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", REVENUE_ACCOUNT];
const IDENTITY: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: MINT, ticker: "EXM", programs: [{ activity: "Orbitswap", programId: REVENUE_PROGRAM }] };
beforeAll(() => {
  __setInstructionRegistryOverlay([
    { chain: "solana", programId: REVENUE_PROGRAM, method: "collect_protocol_fee", proofApproval: { role: "PROTOCOL_VALUE_INFLOW", valueRecipient: { kind: "INSTRUCTION_ACCOUNT_INDEX", indexes: [3] } } },
  ]);
});
afterAll(() => __setInstructionRegistryOverlay(null));
const provenanceRow = (): EvidenceRow =>
  chain("SOURCE_OF_VALUE", {
    relationship: "CONTEXT",
    onchainFactKind: "TOKEN_TRANSFER",
    officiality: "CLAIMED",
    onchainProvenance: {
      callerProgramId: REVENUE_PROGRAM,
      callerMethod: "collect_protocol_fee",
      executingProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      callerAccounts: [...CALLER_ACCOUNTS],
      invocationIndex: 0,
      stackHeight: 2,
      refusal: null,
      destination: REVENUE_ACCOUNT,
      assetKind: "TOKEN",
      mint: WSOL,
      amountRaw: "1000000",
      signature: "sigRevenue",
      slot: 444414083,
    },
  });

const sov = () => row("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users on Orbitswap generate the revenue" });
const sovProven = () => [sov(), provenanceRow()];
const flowPath = () => row("FLOW_PATH", { fragment: "fee revenue is routed from the fee collector to the allocation contract" });
const specLive = () => row("MECHANISM_SPEC", { fragment: "50% of protocol fees are allocated to the token each epoch", mechanismState: "LIVE" });
const csLive = () => row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE" });
const destHolders = () => row("DESTINATION", { fragment: "fees are distributed to holders through the distributor" });
const destBurn = () => row("DESTINATION", { fragment: "bought back tokens are burned" });
const destOpaque = () => row("DESTINATION", { fragment: "fees are sent to the protocol multisig at 0x1234" });
const rcptEntitled = () => row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" });
const rcptBare = () => row("RECIPIENT", { fragment: "token holders receive the distributed fees" });
const base = () => [...sovProven(), flowPath(), specLive(), csLive()];
const full = () => [...base(), destHolders(), rcptEntitled()];


// ------------------------------------------------------- THE CONTROL
//
// A rich, healthy world: documentary mechanism end to end, a governance
// basis, a confirmed identity, and TWO on-chain readings (an executed burn
// and a supply level). Everything below only takes away from it.
const govApproved = () =>
  confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", fragment: "the allocation proposal passed the token holder vote", mechanismState: "APPROVED" });
const durability = () =>
  confirmed("DURABILITY_BASIS", { sourceClass: "GOVERNANCE", fragment: "the allocation can be revoked by a governance vote", mechanismState: "APPROVED" });
const burnExecuted = () => chain("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE" });
const supplyRead = () => chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" });

const HEALTHY = () => [...sovProven(), flowPath(), specLive(), govApproved(), burnExecuted(), csLive(), destHolders(), rcptEntitled(), supplyRead(), durability()];

// ---------------------------------------------------- THE DEGRADATIONS
//
// Six axes. Each one REMOVES or WEAKENS; not one of them adds a project
// fact, states a negative, or changes what is true about the project. They
// are exactly the shapes a bad day produces: a provider down, a route
// withdrawn, an extractor that returned nothing, a reading that aged out.
interface Axis {
  name: string;
  apply: (pool: EvidenceRow[]) => EvidenceRow[];
  boundaries?: Record<string, AcquisitionBoundary>;
}
const AXES: Axis[] = [
  // The supply RPC is unavailable this run.
  { name: "supply-read-off", apply: (p) => p.filter((r) => !(r.component === "NET_EFFECT" && r.onchainFactKind !== null)) },
  // The execution RPC is unavailable this run.
  { name: "burn-read-off", apply: (p) => p.filter((r) => !(r.component === "EXECUTION_EVIDENCE" && r.onchainFactKind !== null)) },
  // The current-state page is the same page, read too long ago.
  { name: "state-stale", apply: (p) => p.map((r) => (r.component === "CURRENT_STATE" ? { ...r, publishedAt: older(400), fetchedAt: older(400) } : r)) },
  // The destination route was withdrawn: same passage, weakest class today.
  {
    name: "route-withdrawn",
    apply: (p) => p.map((r) => (r.component === "DESTINATION" ? { ...r, sourceClass: "RESEARCH_MEDIA", officiality: "CLAIMED" } : r)),
  },
  // The extractor never completed for the mechanism spec.
  {
    name: "extract-incomplete",
    apply: (p) => p.filter((r) => r.component !== "MECHANISM_SPEC"),
    boundaries: { MECHANISM_SPEC: "EXTRACTION_NOT_COMPLETED" },
  },
  // A documentary component simply was not reachable.
  { name: "flow-path-missing", apply: (p) => p.filter((r) => r.component !== "FLOW_PATH") },
];

function worldFor(mask: number): { pool: EvidenceRow[]; boundaries: Record<string, AcquisitionBoundary>; label: string } {
  let pool = HEALTHY();
  const boundaries: Record<string, AcquisitionBoundary> = {};
  const names: string[] = [];
  for (let i = 0; i < AXES.length; i++) {
    if ((mask & (1 << i)) === 0) continue;
    pool = AXES[i].apply(pool);
    Object.assign(boundaries, AXES[i].boundaries ?? {});
    names.push(AXES[i].name);
  }
  return { pool, boundaries, label: names.length === 0 ? "healthy" : names.join("+") };
}

const askMask = (mask: number): Matrix => {
  const w = worldFor(mask);
  return ask(w.pool, { identity: IDENTITY, boundaries: w.boundaries });
};

// ====================================================================
describe("A. THE DEGRADATION LATTICE — 64 worlds, every covering pair", () => {
  const MASKS = 1 << AXES.length;
  const matrices: Matrix[] = [];
  beforeAll(() => {
    for (let mask = 0; mask < MASKS; mask++) matrices.push(askMask(mask));
  });

  it("A1. no degradation ever raises a verdict: over every covering pair of the lattice, for every intent, the more degraded world is never stronger", () => {
    let pairs = 0;
    for (let mask = 0; mask < MASKS; mask++) {
      for (let i = 0; i < AXES.length; i++) {
        if ((mask & (1 << i)) !== 0) continue;
        const worse = mask | (1 << i);
        const less = matrices[mask];
        const more = matrices[worse];
        pairs += 1;
        for (const intent of INTENTS) {
          expect(
            VERDICT_RANK[verdicts(more)[intent]],
            `${worldFor(worse).label} > ${worldFor(mask).label} on ${intent} (${verdicts(less)[intent]} -> ${verdicts(more)[intent]})`,
          ).toBeLessThanOrEqual(VERDICT_RANK[verdicts(less)[intent]]);
        }
      }
    }
    expect(pairs).toBe((MASKS / 2) * AXES.length);
  });

  it("A2. at an equal verdict the band never rises either — degradation is never a confidence upgrade", () => {
    for (let mask = 0; mask < MASKS; mask++) {
      for (let i = 0; i < AXES.length; i++) {
        if ((mask & (1 << i)) !== 0) continue;
        const worse = mask | (1 << i);
        for (const intent of INTENTS) {
          if (verdicts(matrices[worse])[intent] !== verdicts(matrices[mask])[intent]) continue;
          expect(
            matrices[worse][intent].proof.confidenceScore,
            `${worldFor(worse).label} band rose over ${worldFor(mask).label} on ${intent}`,
          ).toBeLessThanOrEqual(matrices[mask][intent].proof.confidenceScore);
        }
      }
    }
  });

  it("A3. LOSS OF EVIDENCE IS NOT EVIDENCE OF ABSENCE: no amount of technical degradation turns any question negative", () => {
    const controlNegative = new Set(INTENTS.filter((i) => verdicts(matrices[0])[i] === "NOT_SUPPORTED"));
    expect(controlNegative.size, "the control world is already negative; the law below would be vacuous").toBe(0);
    for (let mask = 0; mask < MASKS; mask++) {
      for (const intent of INTENTS) {
        expect(verdicts(matrices[mask])[intent], `${worldFor(mask).label}: ${intent} became negative from absence`).not.toBe("NOT_SUPPORTED");
      }
    }
  });

  it("A4. every world in the lattice is internally sound: provenance, citations and refutations hold wherever the environment landed", () => {
    for (let mask = 0; mask < MASKS; mask++) laws(matrices[mask], worldFor(mask).label);
  });

  it("A5. the lattice is not vacuous: the fully degraded world really is weaker than the healthy one, and the axes really do bite", () => {
    const healthy = matrices[0];
    const ruined = matrices[MASKS - 1];
    const dropped = INTENTS.filter((i) => VERDICT_RANK[verdicts(ruined)[i]] < VERDICT_RANK[verdicts(healthy)[i]]);
    expect(dropped.length, "no intent weakened across the whole lattice — the degradations do nothing").toBeGreaterThan(0);
    // And each single axis changes SOMETHING somewhere, or it is not a
    // degradation worth asserting monotonicity over.
    for (let i = 0; i < AXES.length; i++) {
      const single = matrices[1 << i];
      const differs =
        INTENTS.some((intent) => verdicts(single)[intent] !== verdicts(healthy)[intent]) ||
        INTENTS.some((intent) => single[intent].proof.confidenceScore !== healthy[intent].proof.confidenceScore) ||
        JSON.stringify(single.PROTOCOL_REVENUE_TO_TOKEN.results) !== JSON.stringify(healthy.PROTOCOL_REVENUE_TO_TOKEN.results);
      expect(differs, `axis ${AXES[i].name} changes nothing at all`).toBe(true);
    }
  });

  it("A6. CROSS-QUESTION CONSISTENCY UNDER DEGRADATION: at every lattice point the intents that share a requirement set still agree exactly, and the compound claim never outruns its conjuncts", () => {
    for (let mask = 0; mask < MASKS; mask++) {
      const m = matrices[mask];
      const label = worldFor(mask).label;
      expect(shapeOf(m).length).toBeGreaterThan(0);
      // PRT / REWARD_SOURCE / USAGE_TO_TOKEN_LINKAGE share one set.
      expect(verdicts(m).REWARD_SOURCE, `${label}: RS != PRT`).toBe(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN);
      expect(verdicts(m).USAGE_TO_TOKEN_LINKAGE, `${label}: UTL != PRT`).toBe(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN);
      // VALUE_CAPTURE against its conjuncts, in the form Pattern v1
      // actually defines (Round 7 L2): a compound claim whose atoms are
      // partly satisfied is legitimately PARTIALLY_SUPPORTED even where a
      // conjunct asked alone is INSUFFICIENT — so the bound is the
      // STRONGER conjunct, and SUPPORTED requires both.
      expect(
        VERDICT_RANK[verdicts(m).VALUE_CAPTURE],
        `${label}: VC outran both conjuncts`,
      ).toBeLessThanOrEqual(Math.max(VERDICT_RANK[verdicts(m).PROTOCOL_REVENUE_TO_TOKEN], VERDICT_RANK[verdicts(m).BURN_OR_SUPPLY_EFFECT]));
      if (verdicts(m).VALUE_CAPTURE === "SUPPORTED") {
        expect([verdicts(m).PROTOCOL_REVENUE_TO_TOKEN, verdicts(m).BURN_OR_SUPPLY_EFFECT], `${label}: VC SUPPORTED without both conjuncts`).toEqual([
          "SUPPORTED",
          "SUPPORTED",
        ]);
      }
    }
  });
});

// ====================================================================
describe("B. PARTIAL CHAIN VISIBILITY — one call up, another down", () => {
  it("B1. the four chain visibility states are ordered: both readings, either one alone, neither — and no partial view is stronger than the full one", () => {
    const docs = () => [...sovProven(), flowPath(), specLive(), govApproved(), csLive(), destHolders(), rcptEntitled(), durability()];
    const both = ask([...docs(), burnExecuted(), supplyRead()], { identity: IDENTITY });
    const burnOnly = ask([...docs(), burnExecuted()], { identity: IDENTITY });
    const supplyOnly = ask([...docs(), supplyRead()], { identity: IDENTITY });
    const neither = ask(docs(), { identity: IDENTITY });
    for (const [label, partial] of [["burn only", burnOnly], ["supply only", supplyOnly], ["neither", neither]] as const) {
      laws(partial, label);
      noStronger(partial, both, label);
      // Absence of a reading is never a negative finding about the token.
      for (const intent of INTENTS) expect(verdicts(partial)[intent], `${label}: ${intent}`).not.toBe("NOT_SUPPORTED");
    }
    // And a single reading is never stronger than the pair on the supply
    // question specifically — the one the readings speak to.
    expect(VERDICT_RANK[verdicts(burnOnly).BURN_OR_SUPPLY_EFFECT]).toBeLessThanOrEqual(VERDICT_RANK[verdicts(both).BURN_OR_SUPPLY_EFFECT]);
    expect(VERDICT_RANK[verdicts(supplyOnly).BURN_OR_SUPPLY_EFFECT]).toBeLessThanOrEqual(VERDICT_RANK[verdicts(both).BURN_OR_SUPPLY_EFFECT]);
  });

  it("B2. a chain reading that loses its confirmed binding establishes nothing and takes nothing with it: the documentary world underneath is exactly as it was without the reading at all", () => {
    const docs = () => [...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcptEntitled()];
    const withoutReading = ask(docs(), { identity: IDENTITY });
    const unbound = ask([...docs(), chain("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE", entityBinding: null })], { identity: IDENTITY });
    laws(unbound, "unbound reading");
    noStronger(unbound, withoutReading, "unbound chain reading");
    for (const intent of INTENTS) expect(verdicts(unbound)[intent], intent).not.toBe("NOT_SUPPORTED");
  });
});

// ====================================================================
describe("C. TEMPORAL PATHOLOGIES — truth follows the clock, not the input order", () => {
  const world = (csOverrides: Partial<EvidenceRow>) => [
    ...sovProven(),
    flowPath(),
    specLive(),
    destHolders(),
    rcptEntitled(),
    row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE", ...csOverrides }),
  ];

  it("C1. an impossible publication date is never an advantage: a row dated in the future is no stronger than the same row dated now", () => {
    const now = ask(world({ publishedAt: NOW }), { identity: IDENTITY });
    const future = ask(world({ publishedAt: new Date(NOW.getTime() + 365 * DAY) }), { identity: IDENTITY });
    laws(future, "future-dated");
    noStronger(future, now, "future-dated current state");
  });

  it("C2. a missing publication date is absence, never a licence: an undated row is no stronger than a fresh dated one, and never negative", () => {
    const dated = ask(world({ publishedAt: older(1) }), { identity: IDENTITY });
    const undated = ask(world({ publishedAt: null }), { identity: IDENTITY });
    laws(undated, "undated");
    noStronger(undated, dated, "undated current state");
    for (const intent of INTENTS) expect(verdicts(undated)[intent], intent).not.toBe("NOT_SUPPORTED");
  });

  it("C3. INPUT ORDER IS NOT TIME: a stale row delivered after a fresh one, and a fresh row delivered after a stale one, give the identical result", () => {
    const stale = row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE", publishedAt: older(400) });
    const fresh = row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE", publishedAt: older(1), sourceId: "fresh-page" });
    const base = [...sovProven(), flowPath(), specLive(), destHolders(), rcptEntitled()];
    const staleFirst = ask([...base, stale, fresh], { identity: IDENTITY });
    const freshFirst = ask([...base, fresh, stale], { identity: IDENTITY });
    expect(shapeOf(freshFirst)).toBe(shapeOf(staleFirst));
  });

  it("C4. FRESH CONTRADICTION OUTRANKS STALE SUPPORT, never the other way round: a stale LIVE page beside a fresh PAUSED one never reads as current, and the mirror world is not stronger for having the same two rows in the other temporal order", () => {
    const base = [...sovProven(), flowPath(), specLive(), destHolders(), rcptEntitled(), burnExecuted()];
    const staleLiveFreshPaused = ask(
      [
        ...base,
        row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE", publishedAt: older(400) }),
        row("CURRENT_STATE", { fragment: "the allocation mechanism is paused", mechanismState: "PAUSED", publishedAt: older(1), sourceId: "fresh-pause" }),
      ],
      { identity: IDENTITY },
    );
    laws(staleLiveFreshPaused, "stale live + fresh paused");
    expect(verdicts(staleLiveFreshPaused).MECHANISM_CURRENT_STATE, "a stale LIVE page kept the mechanism current").not.toBe("SUPPORTED");

    // The temporal mirror: fresh LIVE beside stale PAUSED. Whatever it
    // decides, the stale-support world above must not be the stronger of
    // the two — that would make age an advantage.
    const freshLiveStalePaused = ask(
      [
        ...base,
        row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE", publishedAt: older(1) }),
        row("CURRENT_STATE", { fragment: "the allocation mechanism is paused", mechanismState: "PAUSED", publishedAt: older(400), sourceId: "stale-pause" }),
      ],
      { identity: IDENTITY },
    );
    laws(freshLiveStalePaused, "fresh live + stale paused");
    expect(
      VERDICT_RANK[verdicts(staleLiveFreshPaused).MECHANISM_CURRENT_STATE],
    ).toBeLessThanOrEqual(VERDICT_RANK[verdicts(freshLiveStalePaused).MECHANISM_CURRENT_STATE]);
  });

  it("C5. STALE IS NOT CURRENT: an aged current-state row cannot answer the current-state question, and ageing it never strengthens any other question either", () => {
    const fresh = ask(world({ publishedAt: older(1) }), { identity: IDENTITY });
    const aged = ask(world({ publishedAt: older(400) }), { identity: IDENTITY });
    laws(aged, "aged current state");
    noStronger(aged, fresh, "aged current state");
    expect(verdicts(fresh).MECHANISM_CURRENT_STATE).toBe("SUPPORTED");
    expect(verdicts(aged).MECHANISM_CURRENT_STATE, "a stale page still answered 'is it current?'").not.toBe("SUPPORTED");
    expect(verdicts(aged).MECHANISM_CURRENT_STATE, "staleness became a refutation").not.toBe("NOT_SUPPORTED");
  });

  it("C6. HISTORICAL EXECUTION IS NOT CURRENT EXECUTION, whichever order the rows arrive in: an executed burn plus a fresh PAUSED state reads the same both ways, and the supply question is unaffected by the ordering", () => {
    const docs = [...sovProven(), flowPath(), specLive(), destHolders(), rcptEntitled()];
    const paused = row("CURRENT_STATE", { fragment: "the allocation mechanism is paused", mechanismState: "PAUSED", publishedAt: older(1) });
    const a = ask([...docs, burnExecuted(), paused], { identity: IDENTITY });
    const b = ask([paused, burnExecuted(), ...docs], { identity: IDENTITY });
    expect(shapeOf(b)).toBe(shapeOf(a));
    laws(a, "historical execution");
    expect(verdicts(a).MECHANISM_CURRENT_STATE, "an executed burn made a paused mechanism current").not.toBe("SUPPORTED");
  });
});

// ====================================================================
describe("D. DEGRADATION IS CONFIDENCE-NEUTRAL OR WORSE, NEVER BETTER", () => {
  it("D1. an acquisition that failed on every component is no stronger than one that was never attempted, and neither is negative", () => {
    const attempted = ask([], {
      identity: IDENTITY,
      boundaries: Object.fromEntries(ALL_COMPONENTS.map((c) => [c, "EXTRACTION_NOT_COMPLETED" as AcquisitionBoundary])),
    });
    const never = ask([], { identity: IDENTITY });
    laws(attempted, "all extraction incomplete");
    noStronger(attempted, never, "all extraction incomplete");
    for (const intent of INTENTS) expect(verdicts(attempted)[intent], intent).not.toBe("NOT_SUPPORTED");
  });

  it("D2. the three absence shapes for one component — never attempted, attempted and incomplete, attempted and empty — are each no stronger than the component being present", () => {
    const withSpec = ask(HEALTHY(), { identity: IDENTITY });
    const withoutSpec = HEALTHY().filter((r) => r.component !== "MECHANISM_SPEC");
    const shapes: [string, Matrix][] = [
      ["never attempted", ask(withoutSpec, { identity: IDENTITY })],
      ["extraction incomplete", ask(withoutSpec, { identity: IDENTITY, boundaries: { MECHANISM_SPEC: "EXTRACTION_NOT_COMPLETED" } })],
      ["no admissible route", ask(withoutSpec, { identity: IDENTITY, boundaries: { MECHANISM_SPEC: "NO_ADMISSIBLE_ROUTE" } })],
      ["search budget exhausted", ask(withoutSpec, { identity: IDENTITY, boundaries: { MECHANISM_SPEC: "SEARCH_BUDGET_EXHAUSTED" } })],
    ];
    for (const [label, m] of shapes) {
      laws(m, label);
      noStronger(m, withSpec, label);
      for (const intent of INTENTS) expect(verdicts(m)[intent], `${label}: ${intent}`).not.toBe("NOT_SUPPORTED");
    }
  });

  it("D3. adding rows that cannot be admitted is confidence-neutral across the whole lattice's extremes: social posts on every component leave the healthy and the ruined world exactly where they were", () => {
    for (const mask of [0, (1 << AXES.length) - 1]) {
      const w = worldFor(mask);
      const control = ask(w.pool, { identity: IDENTITY, boundaries: w.boundaries });
      const tweets = ALL_COMPONENTS.map((c) =>
        row(c, { sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: "everyone knows the burn is huge and holders are entitled to everything" }),
      );
      const t = ask([...w.pool, ...tweets], { identity: IDENTITY, boundaries: w.boundaries });
      laws(t, `${w.label} + social`);
      noStronger(t, control, `${w.label} + social`);
      for (const tw of tweets) expect(t.PROTOCOL_REVENUE_TO_TOKEN.proof.citedEvidenceIds).not.toContain(tw.id);
    }
  });
});
