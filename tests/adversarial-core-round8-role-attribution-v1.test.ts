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

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 8: ROLE MANUFACTURE AND
// ATTRIBUTION LAUNDERING.
//
// Round 7 asked EVERY question of ONE world and looked for two Proofs that
// contradict each other. Round 8 asks a different thing entirely: for each
// semantic distinction ATLAS claims to make, can the STRONGER side be
// MANUFACTURED out of parts that individually do not carry it?
//
// Not "is the answer consistent" but "where did this role come from":
//
//   position          -> economic role      (a balance is not a recipient)
//   receipt           -> entitlement        (getting is not being owed)
//   address           -> destination role   (a place is not a purpose)
//   documented        -> executing          (a plan is not an act)
//   approved          -> live               (a vote is not a switch)
//   supply level      -> attributed delta   (a number is not a cause)
//   two sentences     -> one relation       (a sum is not a statement)
//   technical failure -> project reality    (a timeout is not a fact)
//   absence           -> denial             (silence is not a no)
//
// The newly hardened M3/C4 boundaries are attacked hardest, from the side
// they do not defend by construction: composition, pooling, permutation,
// degradation and the existential rule across flows.
//
// Pure: real S5 reducer, real S6 assembler, real S7 evaluator, real S8
// builder, real Pattern v1. No DB, no model, no network, no spend.

const JOB = "88888888-0000-4000-8000-000000000008";
const OTHER_JOB = "99999999-0000-4000-8000-000000000009";
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
  const id = overrides.id ?? `b${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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

// ====================================================================
describe("A. POSITION IS NOT A ROLE — an address, a balance and a transaction cannot become an economic role", () => {
  it("A1. a bound on-chain balance establishes DESTINATION (where the tokens are) and its KIND stays unknown, so the destination-dependent question cannot be SUPPORTED off chain position alone", () => {
    const m = ask([...base(), chain("DESTINATION", { onchainFactKind: "TOKEN_ACCOUNT_BALANCE" })], { identity: IDENTITY });
    laws(m, "A1");
    expect(["SUPPORTED", "PARTIALLY_SUPPORTED"]).toContain(s5(m, "DESTINATION").status);
    expect(flow0(m).attributes.destinationKind).toBe("UNKNOWN");
    expect(req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status).not.toBe("SATISFIED");
    expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN).not.toBe("SUPPORTED");
    expect(verdicts(m).VALUE_CAPTURE).not.toBe("SUPPORTED");
  });

  it("A2. the chain read cannot lend its role to the documentary one, and cannot take it away: adding a bound balance to a world with a classifiable destination leaves the classifiable flow exactly as it was (chain UP is never weaker than chain DOWN)", () => {
    const down = ask([...base(), destHolders()], { identity: IDENTITY });
    const up = ask([...base(), destHolders(), chain("DESTINATION", { onchainFactKind: "TOKEN_ACCOUNT_BALANCE" })], { identity: IDENTITY });
    laws(up, "A2");
    for (const i of INTENTS) {
      expect(VERDICT_RANK[verdicts(up)[i]], `${i}: chain UP weaker than chain DOWN`).toBeGreaterThanOrEqual(VERDICT_RANK[verdicts(down)[i]]);
    }
    expect(req(up.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status).toBe("SATISFIED");
    // And the role never crossed: the opaque branch keeps its own gap.
    const opaqueFlows = up.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows.filter((f) => f.attributes.destinationKind === "UNKNOWN");
    expect(opaqueFlows.length).toBeGreaterThan(0);
    for (const f of opaqueFlows) expect(f.gaps.some((g) => g.kind === "DESTINATION_UNRESOLVED")).toBe(true);
  });

  it("A3. a balance reading can never carry RECIPIENT at all, so no amount of chain position produces a holder outcome", () => {
    const m = ask([...base(), chain("RECIPIENT", { onchainFactKind: "TOKEN_ACCOUNT_BALANCE" })], { identity: IDENTITY });
    laws(m, "A3");
    expect(s5(m, "RECIPIENT").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(m).attributes.recipientKind).toBe("UNKNOWN");
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).not.toBe("NOT_SUPPORTED"); // absence is not denial
  });
});

// ====================================================================
describe("B. TWO STATEMENTS ARE NOT ONE RELATION — composition may not manufacture a relation neither part states", () => {
  it("B1. holder entitlement is not assembled across statements: 'holders receive the fees' + 'the protocol is entitled to a pro rata share' is not 'holding entitles holders'", () => {
    const other = row("RECIPIENT", { fragment: "the protocol is entitled to a pro rata share of trading fees", sourceId: "src-protocol" });
    const m = ask([...base(), destHolders(), rcptBare(), other], { identity: IDENTITY });
    laws(m, "B1");
    const holderFlows = m.PASSIVE_HOLDER_OUTCOME.assembly.flows.filter((f) => f.attributes.recipientKind === "PASSIVE_HOLDER");
    expect(holderFlows.length).toBeGreaterThan(0);
    for (const f of holderFlows) expect(f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED")).toBe(true);
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).not.toBe("SUPPORTED");
  });

  it("B2. the entitlement of a DIFFERENT actor is not holder entitlement, whichever actor is named: staker, node operator, LP and treasury entitlement sentences never establish the passive-holder bridge", () => {
    for (const other of [
      "stakers are entitled to a pro rata share of the fees",
      "node operators are entitled to a pro rata share of the fees",
      "liquidity providers are entitled to a pro rata share of the fees",
      "the treasury is entitled to a pro rata share of the fees",
    ]) {
      const m = ask([...base(), destHolders(), rcptBare(), row("RECIPIENT", { fragment: other, sourceId: `src-${other.slice(0, 6)}` })], { identity: IDENTITY });
      laws(m, `B2:${other}`);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, other).not.toBe("SUPPORTED");
      const holderFlows = m.PASSIVE_HOLDER_OUTCOME.assembly.flows.filter((f) => f.attributes.recipientKind === "PASSIVE_HOLDER");
      for (const f of holderFlows) expect(f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED"), other).toBe(true);
    }
  });

  it("B3. a destination KIND is likewise not assembled from a different component's words: 'burned' appearing in the mechanism spec, the flow path or the recipient text never classifies the destination", () => {
    for (const component of ["MECHANISM_SPEC", "FLOW_PATH", "RECIPIENT"]) {
      const m = ask(
        [...base(), destOpaque(), row(component, { fragment: "the mechanism description mentions that tokens are burned", sourceId: `src-${component}` })],
        { identity: IDENTITY },
      );
      laws(m, `B3:${component}`);
      for (const f of m.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows) {
        expect(f.attributes.destinationKind, `${component} leaked into destinationKind`).toBe("UNKNOWN");
      }
      expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN, component).not.toBe("SUPPORTED");
    }
  });
});

// ====================================================================
describe("C. APPROVED AND DOCUMENTED ARE NOT LIVE — a role stated in a proposal is not a role in effect", () => {
  it("C1. an entitlement stated by a PROPOSAL does not produce a live holder outcome: the recipient is capped PROPOSED_STATE_ONLY and the claim cannot be SUPPORTED", () => {
    const proposed = row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees", mechanismState: "PROPOSED" });
    const m = ask([...base(), destHolders(), proposed], { identity: IDENTITY });
    laws(m, "C1");
    expect(s5(m, "RECIPIENT").reasonCodes).toContain("PROPOSED_STATE_ONLY");
    expect(s5(m, "RECIPIENT").status).toBe("PARTIALLY_SUPPORTED");
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).not.toBe("SUPPORTED");
    // And it is never weaker than the same world with no recipient at all.
    const none = ask([...base(), destHolders()], { identity: IDENTITY });
    expect(VERDICT_RANK[verdicts(m).PASSIVE_HOLDER_OUTCOME]).toBeGreaterThanOrEqual(VERDICT_RANK[verdicts(none).PASSIVE_HOLDER_OUTCOME]);
  });

  it("C2. the live world is never weaker than the proposed one over the same sentence — a lifecycle rung never inverts", () => {
    const text = "token holders are entitled to a pro rata share of the distributed fees";
    const proposed = ask([...base(), destHolders(), row("RECIPIENT", { fragment: text, mechanismState: "PROPOSED" })], { identity: IDENTITY });
    const live = ask([...base(), destHolders(), row("RECIPIENT", { fragment: text, mechanismState: "LIVE" })], { identity: IDENTITY });
    noStronger(proposed, live, "proposed vs live");
  });
});

// ====================================================================
describe("D. MORE UNCERTAINTY IS NEVER A STRONGER CONCLUSION", () => {
  it("D1. inadmissible rows on every component never strengthen any question, and never raise the band, in the role-gated worlds", () => {
    for (const world of [full(), [...base(), destOpaque(), rcptBare()], [...base(), destHolders(), rcptBare()]]) {
      const control = ask(world, { identity: IDENTITY });
      const tweets = ALL_COMPONENTS.map((c) => row(c, { sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: "everyone knows holders are entitled to a pro rata share and it is all burned" }));
      const t = ask([...world, ...tweets], { identity: IDENTITY });
      laws(t, "D1");
      noStronger(t, control, "social rows added");
      // None of it is cited, and none of it resolved a role.
      for (const tw of tweets) expect(t.PROTOCOL_REVENUE_TO_TOKEN.proof.citedEvidenceIds).not.toContain(tw.id);
    }
  });

  it("D2. a FOREIGN job's rows — including a perfect entitlement sentence and a burn destination — never reach any question", () => {
    const control = ask([...base(), destOpaque(), rcptBare()], { identity: IDENTITY });
    const foreign = [
      row("RECIPIENT", { researchJobId: OTHER_JOB, fragment: "token holders are entitled to a pro rata share of the distributed fees" }),
      row("DESTINATION", { researchJobId: OTHER_JOB, fragment: "bought back tokens are burned" }),
    ];
    const t = ask([...base(), destOpaque(), rcptBare(), ...foreign], { identity: IDENTITY });
    laws(t, "D2");
    expect(shapeOf(t)).toBe(shapeOf(control));
  });

  it("D3. a technical acquisition failure is not a project fact: a refused/failed boundary on the recipient leaves the holder question unanswered, never answered 'no', and never stronger than the clean world", () => {
    const control = ask([...base(), destHolders(), rcptEntitled()], { identity: IDENTITY });
    const degraded = ask([...base(), destHolders()], {
      identity: IDENTITY,
      boundaries: { RECIPIENT: "EXTRACTION_NOT_COMPLETED" },
    });
    laws(degraded, "D3");
    expect(verdicts(degraded).PASSIVE_HOLDER_OUTCOME).not.toBe("NOT_SUPPORTED");
    expect(verdicts(degraded).PASSIVE_HOLDER_OUTCOME).not.toBe("SUPPORTED");
    noStronger(degraded, control, "recipient acquisition failed");
  });
});

// ====================================================================
describe("E. ORDER AND DUPLICATION ARE NOT EVIDENCE", () => {
  it("E1. every role-gated world is invariant under input permutation — 24 permutations of each, byte-identical claim shape", () => {
    const worlds = [full(), [...base(), destOpaque(), rcptBare()], [...base(), destBurn(), rcptEntitled()], [...base(), destOpaque(), rcptEntitled()]];
    for (const world of worlds) {
      const control = shapeOf(ask(world, { identity: IDENTITY }));
      for (let k = 0; k < 24; k++) {
        const permuted = [...world];
        for (let i = permuted.length - 1; i > 0; i--) {
          const j = (i * 7 + k * 13 + 3) % (i + 1);
          [permuted[i], permuted[j]] = [permuted[j], permuted[i]];
        }
        expect(shapeOf(ask(permuted, { identity: IDENTITY })), `permutation ${k}`).toBe(control);
      }
    }
  });

  it("E2. duplicating the SAME statement from mirror sources multiplies structure, never truth: the verdict, the band and every requirement status are the control's", () => {
    for (const [label, world, dup] of [
      ["entitlement", full(), () => row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees", contentHash: "same-r", sourceId: `m${seq}` })],
      ["opaque destination", [...base(), destOpaque(), rcptBare()], () => row("DESTINATION", { fragment: "fees are sent to the protocol multisig at 0x1234", contentHash: "same-d", sourceId: `m${seq}` })],
    ] as const) {
      const control = ask(world as EvidenceRow[], { identity: IDENTITY });
      const mirrors = Array.from({ length: 4 }, () => dup());
      const t = ask([...(world as EvidenceRow[]), ...mirrors], { identity: IDENTITY });
      laws(t, `E2:${label}`);
      for (const i of INTENTS) {
        expect(verdicts(t)[i], `${label}: ${i}`).toBe(verdicts(control)[i]);
        expect(t[i].proof.confidenceScore, `${label}: ${i} band`).toBe(control[i].proof.confidenceScore);
      }
    }
  });
});

// ====================================================================
describe("F. THE EXISTENTIAL RULE IS NOT CHERRY-PICKING", () => {
  it("F1. a satisfying flow and a role-less flow coexist without leaking: the satisfied atom names ONLY the flow that satisfies it, and the role-less flow keeps its own gap", () => {
    const m = ask([...base(), destHolders(), destOpaque(), rcptEntitled()], { identity: IDENTITY });
    laws(m, "F1");
    const prt2 = req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2");
    expect(prt2.status).toBe("SATISFIED");
    const classifiable = m.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows.filter((f) => f.attributes.destinationKind !== "UNKNOWN").map((f) => f.flowId);
    const opaque = m.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows.filter((f) => f.attributes.destinationKind === "UNKNOWN").map((f) => f.flowId);
    expect(opaque.length).toBeGreaterThan(0);
    for (const id of prt2.matchedFlowIds) expect(classifiable, "a role-less flow satisfied a role-dependent atom").toContain(id);
    for (const id of opaque) expect(prt2.matchedFlowIds).not.toContain(id);
  });

  it("F2. a compound claim never takes its atoms from different flows: VALUE_CAPTURE SUPPORTED requires one flow that satisfies every required atom", () => {
    // Two disjoint mechanisms: a burn flow with a supply reading, and a
    // holder-distribution flow. No single flow carries everything.
    const m = ask(
      [
        ...sovProven(),
        flowPath(),
        specLive(),
        csLive(),
        destBurn(),
        destHolders(),
        rcptEntitled(),
        chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" }),
      ],
      { identity: IDENTITY },
    );
    laws(m, "F2");
    if (verdicts(m).VALUE_CAPTURE === "SUPPORTED") {
      const sets = ["VC-1", "VC-2", "VC-3"].map((id) => new Set(req(m.VALUE_CAPTURE, id).matchedFlowIds));
      const common = sets.reduce((acc, s) => new Set([...acc].filter((x) => s.has(x))));
      expect(common.size, "VC SUPPORTED with no common flow").toBeGreaterThan(0);
    }
    // And it is never stronger than its weakest conjunct.
    expect(VERDICT_RANK[verdicts(m).VALUE_CAPTURE]).toBeLessThanOrEqual(
      Math.min(VERDICT_RANK[verdicts(m).PROTOCOL_REVENUE_TO_TOKEN], VERDICT_RANK[verdicts(m).BURN_OR_SUPPLY_EFFECT]),
    );
  });
});

// ====================================================================
describe("G. SUPPLY IS NOT ATTRIBUTION, AND A ROLE-LESS DESTINATION DOES NOT BECOME ONE", () => {
  it("G1. a supply reading beside an opaque destination never turns the destination into a burn, and never answers the supply question", () => {
    const m = ask([...base(), destOpaque(), chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" })], { identity: IDENTITY });
    laws(m, "G1");
    for (const f of m.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows) expect(f.attributes.destinationKind).toBe("UNKNOWN");
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).not.toBe("SUPPORTED");
    expect(verdicts(m).VALUE_CAPTURE).not.toBe("SUPPORTED");
  });

  it("G2. NET_EFFECT never becomes SUPPORTED under Pattern v1, so no role gate can be bypassed by routing the claim through the supply question", () => {
    for (const world of [full(), [...base(), destBurn(), rcptEntitled()], [...full(), chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" })]]) {
      const m = ask(world, { identity: IDENTITY });
      expect(s5(m, "NET_EFFECT").status).not.toBe("SUPPORTED");
      expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).not.toBe("SUPPORTED");
      expect(verdicts(m).VALUE_CAPTURE).not.toBe("SUPPORTED");
    }
  });
});

// ====================================================================
describe("H. THE WHOLE MATRIX — a combinatorial sweep over the role dimensions", () => {
  it("H1. 486 worlds x 8 intents: no law is violated, and no question is ever SUPPORTED while the role its atom depends on is unresolved", () => {
    const DEST = [
      { name: "dest:none", rows: () => [] },
      { name: "dest:holders", rows: () => [destHolders()] },
      { name: "dest:opaque", rows: () => [destOpaque()] },
    ];
    const RCPT = [
      { name: "rcpt:none", rows: () => [] },
      { name: "rcpt:bare", rows: () => [rcptBare()] },
      { name: "rcpt:entitled", rows: () => [rcptEntitled()] },
    ];
    const SPEC = [
      { name: "spec:none", rows: () => [] },
      { name: "spec:live", rows: () => [specLive()] },
      { name: "spec:proposed", rows: () => [row("MECHANISM_SPEC", { fragment: "proposal: allocate 50% of protocol fees to the token", mechanismState: "PROPOSED" })] },
    ];
    const CS = [
      { name: "cs:none", rows: () => [] },
      { name: "cs:live", rows: () => [csLive()] },
      { name: "cs:paused", rows: () => [row("CURRENT_STATE", { fragment: "the allocation mechanism is paused", mechanismState: "PAUSED" })] },
    ];
    const EXEC = [
      { name: "exec:none", rows: () => [] },
      { name: "exec:burn", rows: () => [chain("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE" })] },
    ];
    const NET = [
      { name: "net:none", rows: () => [] },
      { name: "net:supply", rows: () => [chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" })] },
    ];

    let worlds = 0;
    for (const d of DEST)
      for (const r of RCPT)
        for (const sp of SPEC)
          for (const cs of CS)
            for (const ex of EXEC)
              for (const ne of NET) {
                const label = [d, r, sp, cs, ex, ne].map((x) => x.name).join(" ");
                const m = ask([...sovProven(), flowPath(), ...d.rows(), ...r.rows(), ...sp.rows(), ...cs.rows(), ...ex.rows(), ...ne.rows()], { identity: IDENTITY });
                worlds += 1;
                laws(m, label);

                // R8-L1 in its role form, over every flow the claim matched.
                const prt2 = req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2");
                if (prt2.status === "SATISFIED") {
                  for (const id of prt2.matchedFlowIds) {
                    const f = m.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows.find((x) => x.flowId === id)!;
                    expect(f.attributes.destinationKind, `${label}: PRT-2 SATISFIED on an unresolved destination role`).not.toBe("UNKNOWN");
                  }
                }
                const pho = req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1");
                if (pho.status === "SATISFIED") {
                  for (const id of pho.matchedFlowIds) {
                    const f = m.PASSIVE_HOLDER_OUTCOME.assembly.flows.find((x) => x.flowId === id)!;
                    expect(f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED"), `${label}: PHO-1 SATISFIED on an unresolved entitlement bridge`).toBe(false);
                  }
                }
                // A world with no recipient statement never answers the
                // holder question either way.
                if (r.name === "rcpt:none") {
                  expect(["INSUFFICIENT_EVIDENCE"], `${label}: holder question answered with no recipient`).toContain(verdicts(m).PASSIVE_HOLDER_OUTCOME);
                }
                // A bare recipient never fully establishes it.
                if (r.name === "rcpt:bare") {
                  expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, `${label}: bare recipient SUPPORTED`).not.toBe("SUPPORTED");
                }
                // An opaque destination never fully satisfies the relation.
                if (d.name === "dest:opaque") {
                  expect(req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status, `${label}: opaque destination SATISFIED`).not.toBe("SATISFIED");
                }
              }
    expect(worlds).toBe(3 * 3 * 3 * 3 * 2 * 2);
  });

  it("H2. the role dimensions are monotone: over the same surrounding world, entitled >= bare >= none for the holder question, and classifiable >= opaque >= none for the revenue question", () => {
    for (const extra of [[], [csLive()], [chain("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE" })], [csLive(), specLive()]]) {
      const surround = [...sovProven(), flowPath(), ...extra];
      const rNone = ask([...surround, destHolders()], { identity: IDENTITY });
      const rBare = ask([...surround, destHolders(), rcptBare()], { identity: IDENTITY });
      const rEnt = ask([...surround, destHolders(), rcptEntitled()], { identity: IDENTITY });
      expect(VERDICT_RANK[verdicts(rBare).PASSIVE_HOLDER_OUTCOME]).toBeGreaterThanOrEqual(VERDICT_RANK[verdicts(rNone).PASSIVE_HOLDER_OUTCOME]);
      expect(VERDICT_RANK[verdicts(rEnt).PASSIVE_HOLDER_OUTCOME]).toBeGreaterThanOrEqual(VERDICT_RANK[verdicts(rBare).PASSIVE_HOLDER_OUTCOME]);

      const dNone = ask([...surround, rcptEntitled()], { identity: IDENTITY });
      const dOpaque = ask([...surround, destOpaque(), rcptEntitled()], { identity: IDENTITY });
      const dKnown = ask([...surround, destHolders(), rcptEntitled()], { identity: IDENTITY });
      expect(VERDICT_RANK[verdicts(dOpaque).PROTOCOL_REVENUE_TO_TOKEN]).toBeGreaterThanOrEqual(VERDICT_RANK[verdicts(dNone).PROTOCOL_REVENUE_TO_TOKEN]);
      expect(VERDICT_RANK[verdicts(dKnown).PROTOCOL_REVENUE_TO_TOKEN]).toBeGreaterThanOrEqual(VERDICT_RANK[verdicts(dOpaque).PROTOCOL_REVENUE_TO_TOKEN]);
    }
  });
});

// ====================================================================
describe("I. THE GATES ARE QUESTION-LOCAL, AND THEIR LIMITS ARE NAMED", () => {
  const rich = () => [
    ...base(),
    destHolders(),
    confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", fragment: "the allocation proposal passed the token holder vote", mechanismState: "APPROVED" }),
    chain("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE" }),
    chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" }),
    confirmed("DURABILITY_BASIS", { sourceClass: "GOVERNANCE", fragment: "the allocation can be revoked by a governance vote", mechanismState: "APPROVED" }),
  ];

  it("I1. the entitlement bridge is the holder question's business and nobody else's: over a rich world, bare and entitled recipients differ in the holder question alone — every other verdict, requirement and band is byte-identical", () => {
    const bare = ask([...rich(), rcptBare()], { identity: IDENTITY });
    const ent = ask([...rich(), rcptEntitled()], { identity: IDENTITY });
    laws(bare, "I1 bare");
    laws(ent, "I1 ent");
    for (const i of INTENTS) {
      if (i === "PASSIVE_HOLDER_OUTCOME") continue;
      expect(verdicts(bare)[i], `${i} verdict moved`).toBe(verdicts(ent)[i]);
      expect(bare[i].proof.confidenceScore, `${i} band moved`).toBe(ent[i].proof.confidenceScore);
      // TU-2 is the SAME recipient-role atom under another intent, so the
      // generic gate reaches it too — correctly. It is OPTIONAL, so it binds
      // nothing: TOKEN_UTILITY's verdict and band above are unmoved. Every
      // requirement that is not a recipient-role atom is byte-identical.
      const shape = (m: Matrix) =>
        m[i].claim.requirementResults
          .filter((r) => r.requirementId !== "TU-2")
          .map((r) => `${r.requirementId}:${r.status}:${[...r.reasonCodes].sort().join("|")}`);
      expect(shape(bare), `${i} requirements moved`).toEqual(shape(ent));
    }
    // The optional recipient atom moves exactly as PHO-1 does, and binds nothing.
    expect(req(bare.TOKEN_UTILITY, "TU-2").status).toBe("PARTIAL");
    expect(req(bare.TOKEN_UTILITY, "TU-2").reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(req(bare.TOKEN_UTILITY, "TU-2").optionality).toBe("OPTIONAL");
    expect(req(ent.TOKEN_UTILITY, "TU-2").status).toBe("SATISFIED");
    // And the holder question moved in the safe direction only.
    expect(VERDICT_RANK[verdicts(bare).PASSIVE_HOLDER_OUTCOME]).toBeLessThan(VERDICT_RANK[verdicts(ent).PASSIVE_HOLDER_OUTCOME]);
    expect(bare.PASSIVE_HOLDER_OUTCOME.proof.confidenceScore).toBeLessThanOrEqual(ent.PASSIVE_HOLDER_OUTCOME.proof.confidenceScore);
  });

  it("I2. the same holds for the destination role: an opaque destination changes the destination-dependent questions and leaves the holder and lifecycle questions exactly where they were", () => {
    const known = ask([...rich(), rcptEntitled()], { identity: IDENTITY });
    const opaque = ask([...rich().filter((r) => r.component !== "DESTINATION"), destOpaque(), rcptEntitled()], { identity: IDENTITY });
    laws(opaque, "I2");
    for (const i of ["PASSIVE_HOLDER_OUTCOME", "MECHANISM_CURRENT_STATE", "BURN_OR_SUPPLY_EFFECT"] as const) {
      expect(verdicts(opaque)[i], `${i} moved`).toBe(verdicts(known)[i]);
    }
    expect(VERDICT_RANK[verdicts(opaque).PROTOCOL_REVENUE_TO_TOKEN]).toBeLessThan(VERDICT_RANK[verdicts(known).PROTOCOL_REVENUE_TO_TOKEN]);
  });

  it("I3 (FIXED, Founder review of Round 8). EXPLICIT NEGATION IS NOT THE POSITIVE BRIDGE: a sentence denying holder entitlement no longer satisfies it, and a denial about something else or in another sentence still does not suppress a real one. The destination dictionary's own negation limit (H3) is untouched and still pinned", () => {
    for (const fragment of [
      "token holders are not entitled to any share of protocol revenue",
      "token holders have no entitlement to protocol revenue",
      "token holders never receive any pro rata share of the fees",
      "token holders shall not, under any circumstances, be entitled to the fees",
    ]) {
      const m = ask([...base(), destHolders(), row("RECIPIENT", { fragment })], { identity: IDENTITY });
      laws(m, `I3:${fragment}`);
      const holderFlows = m.PASSIVE_HOLDER_OUTCOME.assembly.flows.filter((f) => f.attributes.recipientKind === "PASSIVE_HOLDER");
      expect(holderFlows.length, fragment).toBeGreaterThan(0);
      for (const f of holderFlows) expect(f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED"), fragment).toBe(true);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, fragment).toBe("PARTIALLY_SUPPORTED");
      // A denial is ABSENCE of the bridge, not a refutation of the
      // recipient. No negation grammar was added anywhere else.
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, fragment).not.toBe("NOT_SUPPORTED");
    }
    // Scoped: a denial in its own sentence leaves a real statement alone.
    const scoped = ask(
      [...base(), destHolders(), row("RECIPIENT", { fragment: "fees are not charged on transfers. token holders are entitled to a pro rata share of the distributed fees." })],
      { identity: IDENTITY },
    );
    expect(verdicts(scoped).PASSIVE_HOLDER_OUTCOME).toBe("SUPPORTED");
    // H3 itself is untouched: the DESTINATION dictionary still has no
    // negation grammar, and that remains the documented Founder boundary.
    const d = ask([...base(), row("DESTINATION", { fragment: "these tokens are not burned" })], { identity: IDENTITY });
    expect(d.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows[0].attributes.destinationKind).toBe("BURN");
  });

  it("I4 (BOUNDARY, MINOR — Founder decision open). the holder-entitlement dictionary still has no TENSE grammar: 'may in future be entitled' and 'were previously entitled' satisfy the positive bridge. ATLAS bounds tense through mechanism_state and the lifecycle machinery instead (round7-5 C1/C2: a PROPOSED recipient row caps at PROPOSED_STATE_ONLY), so reading prose tense in a classifier would be a NEW semantic rule rather than an implication of the approved one. Pinned, not decided", () => {
    for (const fragment of [
      "token holders may in future be entitled to a pro rata share of the fees",
      "token holders were previously entitled to a pro rata share of the fees",
    ]) {
      const m = ask([...base(), destHolders(), row("RECIPIENT", { fragment })], { identity: IDENTITY });
      laws(m, `I4:${fragment}`);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, fragment).toBe("SUPPORTED");
      // The lifecycle machinery is what actually bounds it: the same
      // sentence recorded as a PROPOSAL cannot reach SUPPORTED.
      const proposed = ask([...base(), destHolders(), row("RECIPIENT", { fragment, mechanismState: "PROPOSED" })], { identity: IDENTITY });
      expect(s5(proposed, "RECIPIENT").reasonCodes, fragment).toContain("PROPOSED_STATE_ONLY");
      expect(verdicts(proposed).PASSIVE_HOLDER_OUTCOME, fragment).not.toBe("SUPPORTED");
    }
  });
});
