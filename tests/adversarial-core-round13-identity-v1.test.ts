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

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 13: IDENTITY, PROVENANCE AND
// ISOLATION UNDER COMPOSITION.
//
//   CAN ATLAS ASSEMBLE A STRONGER PROOF BY COMBINING EVIDENCE THAT IS
//   INDIVIDUALLY VALID BUT BELONGS TO THE WRONG IDENTITY?
//
// Rounds 4 and 5.5 asked whether ONE foreign row binds: same ticker, same
// contract, same host, same hex address on another chain. Each is refused.
// That leaves the composition untested, and composition is where an
// isolation rule usually breaks: no single foreign row is enough to matter,
// so nothing trips a per-row check, while together they supply exactly the
// components the local world is missing.
//
// This round is therefore a JIGSAW ATTACK. The local world is deliberately
// incomplete, and every hole is offered a piece that is perfectly good
// evidence — for somebody else:
//
//     local     revenue source
//     foreign B buyback mechanism
//     foreign C execution event
//     ---------------------------------
//     must NOT become a value-capture path
//
//     unbound reading  burn
//     unbound reading  supply delta
//     ---------------------------------
//     must NOT become NET_EFFECT
//
//     local     holders named as recipient
//     foreign B the holding -> entitlement bridge
//     ---------------------------------
//     must NOT become PASSIVE_HOLDER_OUTCOME
//
// The law each world asserts is the strongest available: the mixed world
// is not merely "no stronger" than the isolated control — it is BYTE
// IDENTICAL to it. A piece that belongs to another identity contributes
// nothing at all, including nothing to the band, the gaps or the citations.
//
// Pure: real S5 reducer, real S6 assembler, real S7 evaluator, real S8
// builder, real Pattern v1. No DB, no model, no network, no spend. The
// persisted half is adversarial-core-round13-identity-db-v1.

const JOB = "eeeeeeee-0000-4000-8000-000000000013";
// Three distinct foreign identities. Each one is a real, complete research
// job of its own — its rows are admissible evidence THERE and nowhere else.
const FOREIGN_B = "ffffffff-0000-4000-8000-0000000000b0";
const FOREIGN_C = "ffffffff-0000-4000-8000-0000000000c0";
const FOREIGN_D = "ffffffff-0000-4000-8000-0000000000d0";
const OTHER_JOB = FOREIGN_B;
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
  const id = overrides.id ?? `d${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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


// ------------------------------------------------- THE FOREIGN PIECES
//
// Every piece below is well-formed, official, confirmed, recent, direct —
// everything a local row is — and belongs to another job. `foreign` is the
// only thing that differs, and it is the only thing that may matter.
const foreign = (job: string, component: string, o: Partial<EvidenceRow> = {}): EvidenceRow =>
  row(component, { researchJobId: job, sourceId: `src-${job}-${component}`, ...o });

// A chain reading that was never bound to the token this research is about
// — the shape a reading of ANOTHER asset has once the binding is computed.
const unbound = (component: string, o: Partial<EvidenceRow>): EvidenceRow =>
  chain(component, { entityBinding: null, ...o });

const govApproved = () =>
  confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", fragment: "the allocation proposal passed the token holder vote", mechanismState: "APPROVED" });
const burnExecuted = () => chain("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE" });
const supplyRead = () => chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" });

// Asserted everywhere below: adding foreign pieces changes NOTHING. Not
// the verdict, not the band, not one requirement, gap or citation.
function identical(mixed: Matrix, isolated: Matrix, label: string): void {
  expect(shapeOf(mixed), `${label}: foreign evidence changed the answer`).toBe(shapeOf(isolated));
  for (const intent of INTENTS) {
    expect(mixed[intent].proof.citedEvidenceIds, `${label}: ${intent} citations moved`).toEqual(isolated[intent].proof.citedEvidenceIds);
    expect(mixed[intent].proof.confidenceScore, `${label}: ${intent} band moved`).toBe(isolated[intent].proof.confidenceScore);
  }
}

// No foreign row may appear anywhere a reader or an auditor would see it.
function citesNothingForeign(m: Matrix, pool: EvidenceRow[], label: string): void {
  const foreignIds = new Set(pool.filter((r) => r.researchJobId !== JOB).map((r) => r.id));
  for (const intent of INTENTS) {
    for (const id of m[intent].proof.citedEvidenceIds) {
      expect(foreignIds.has(id), `${label}: ${intent} cited a foreign row`).toBe(false);
    }
    for (const req of m[intent].claim.requirementResults) {
      for (const id of req.provenance.evidenceIds) {
        expect(foreignIds.has(id), `${label}: ${intent} ${req.requirementId} rests on a foreign row`).toBe(false);
      }
    }
  }
  // And S5 never admitted one in the first place.
  for (const r of m.PROTOCOL_REVENUE_TO_TOKEN.results) {
    for (const id of [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds]) {
      expect(foreignIds.has(id), `${label}: ${r.component} admitted a foreign row`).toBe(false);
    }
  }
}

// ====================================================================
describe("A. THE JIGSAW — pieces from different identities may not complete a mechanism", () => {
  it("A1. REVENUE HERE, MECHANISM THERE, EXECUTION ELSEWHERE: a local revenue source plus another project's buyback mechanism plus a third project's execution event is exactly the local world alone", () => {
    const local = [...sovProven(), rcptEntitled()];
    const pieces = [
      foreign(FOREIGN_B, "MECHANISM_SPEC", { fragment: "50% of protocol fees are used to buy back the token on the open market", mechanismState: "LIVE" }),
      foreign(FOREIGN_C, "EXECUTION_EVIDENCE", { fragment: "the buyback executed in every epoch since launch", mechanismState: "LIVE" }),
      foreign(FOREIGN_D, "DESTINATION", { fragment: "bought back tokens are burned" }),
    ];
    const isolated = ask(local, { identity: IDENTITY });
    const mixed = ask([...local, ...pieces], { identity: IDENTITY });
    laws(mixed, "A1");
    identical(mixed, isolated, "A1 three-identity jigsaw");
    citesNothingForeign(mixed, [...local, ...pieces], "A1");
    // The path those pieces would have completed is still not there.
    expect(verdicts(mixed).VALUE_CAPTURE).not.toBe("SUPPORTED");
    expect(verdicts(mixed).PROTOCOL_REVENUE_TO_TOKEN).not.toBe("SUPPORTED");
  });

  it("A2. BURN ON ONE ASSET, SUPPLY DELTA ON ANOTHER: two readings that were never bound to this token do not make a net effect between them", () => {
    const local = [...sovProven(), flowPath(), specLive(), destBurn()];
    const pieces = [
      unbound("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE" }),
      unbound("NET_EFFECT", { onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "SUPPORTS" }),
    ];
    const isolated = ask(local, { identity: IDENTITY });
    const mixed = ask([...local, ...pieces], { identity: IDENTITY });
    laws(mixed, "A2");
    identical(mixed, isolated, "A2 unbound burn + unbound delta");
    expect(verdicts(mixed).BURN_OR_SUPPLY_EFFECT).not.toBe("SUPPORTED");
    expect(verdicts(mixed).VALUE_CAPTURE).not.toBe("SUPPORTED");
    // Neither reading established anything on its own component either.
    for (const c of ["EXECUTION_EVIDENCE", "NET_EFFECT"]) {
      expect(mixed.PROTOCOL_REVENUE_TO_TOKEN.byComponent.get(c)!.status, c).toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("A3. HOLDERS HERE, THE ENTITLEMENT BRIDGE THERE: another project's entitlement sentence does not complete this project's passive-holder outcome", () => {
    const local = [...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcptBare()];
    const bridge = foreign(FOREIGN_B, "RECIPIENT", {
      fragment: "token holders are entitled to a pro rata share of the distributed fees",
    });
    const isolated = ask(local, { identity: IDENTITY });
    const mixed = ask([...local, bridge], { identity: IDENTITY });
    laws(mixed, "A3");
    identical(mixed, isolated, "A3 foreign entitlement bridge");
    citesNothingForeign(mixed, [...local, bridge], "A3");
    // The bridge is still unresolved, exactly as with no foreign row.
    const holderFlows = mixed.PASSIVE_HOLDER_OUTCOME.assembly.flows.filter((f) => f.attributes.recipientKind === "PASSIVE_HOLDER");
    expect(holderFlows.length).toBeGreaterThan(0);
    for (const f of holderFlows) expect(f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED")).toBe(true);
    expect(verdicts(mixed).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
  });

  it("A4. THE FULL JIGSAW: every component this research lacks, offered by a different foreign identity at once — the local Proof is byte identical to having offered none of them", () => {
    const local = [...sovProven()];
    const holes = ["FLOW_PATH", "MECHANISM_SPEC", "GOVERNANCE_BASIS", "EXECUTION_EVIDENCE", "CURRENT_STATE", "DESTINATION", "RECIPIENT", "NET_EFFECT", "DURABILITY_BASIS"];
    const jobs = [FOREIGN_B, FOREIGN_C, FOREIGN_D];
    const pieces = holes.map((c, i) =>
      foreign(jobs[i % jobs.length], c, {
        mechanismState: ["MECHANISM_SPEC", "EXECUTION_EVIDENCE", "CURRENT_STATE"].includes(c) ? "LIVE" : null,
        sourceClass: c === "GOVERNANCE_BASIS" || c === "DURABILITY_BASIS" ? "GOVERNANCE" : "OFFICIAL_DOCS",
      }),
    );
    const isolated = ask(local, { identity: IDENTITY });
    const mixed = ask([...local, ...pieces], { identity: IDENTITY });
    laws(mixed, "A4");
    identical(mixed, isolated, "A4 full jigsaw");
    citesNothingForeign(mixed, [...local, ...pieces], "A4");
    // Whatever the local world supports on its own it still supports — and
    // nothing else becomes supported. TOKEN_UTILITY rests on the LOCAL
    // source of value (TU-1 = PRT-1), so it is SUPPORTED in both worlds;
    // the law is that the two worlds agree, not that nothing holds.
    for (const intent of INTENTS) {
      expect(verdicts(mixed)[intent], intent).toBe(verdicts(isolated)[intent]);
    }
    expect(verdicts(mixed).VALUE_CAPTURE).not.toBe("SUPPORTED");
    expect(verdicts(mixed).PROTOCOL_REVENUE_TO_TOKEN).not.toBe("SUPPORTED");
    expect(verdicts(mixed).PASSIVE_HOLDER_OUTCOME).not.toBe("SUPPORTED");
    // Every offered component is still unestablished here.
    for (const c of holes) {
      expect(mixed.PROTOCOL_REVENUE_TO_TOKEN.byComponent.get(c)!.status, c).toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("A5. THE JIGSAW CANNOT BE COMPLETED BY VOLUME: five foreign identities offering the SAME missing component, and the same pieces duplicated, are still nothing", () => {
    const local = [...sovProven(), rcptEntitled()];
    const many = Array.from({ length: 5 }, (_, i) =>
      foreign(`ffffffff-0000-4000-8000-00000000${String(i).padStart(4, "0")}`, "DESTINATION", { fragment: "bought back tokens are burned" }),
    );
    const isolated = ask(local, { identity: IDENTITY });
    const mixed = ask([...local, ...many, ...many.map((r) => ({ ...r, id: `${r.id.slice(0, -1)}9` }))], { identity: IDENTITY });
    laws(mixed, "A5");
    identical(mixed, isolated, "A5 volume");
  });

  it("A6. ORDER DOES NOT ADMIT: every permutation of a mixed-identity pool gives the identical answer, and it is the isolated answer", () => {
    const local = [...sovProven(), flowPath(), rcptEntitled()];
    const pieces = [
      foreign(FOREIGN_B, "DESTINATION", { fragment: "bought back tokens are burned" }),
      foreign(FOREIGN_C, "MECHANISM_SPEC", { fragment: "50% of protocol fees buy back the token", mechanismState: "LIVE" }),
      unbound("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" }),
    ];
    const isolated = shapeOf(ask(local, { identity: IDENTITY }));
    const pool = [...local, ...pieces];
    for (let k = 0; k < 12; k++) {
      const permuted = [...pool];
      for (let i = permuted.length - 1; i > 0; i--) {
        const j = (i * 7 + k * 5 + 1) % (i + 1);
        [permuted[i], permuted[j]] = [permuted[j], permuted[i]];
      }
      expect(shapeOf(ask(permuted, { identity: IDENTITY })), `permutation ${k}`).toBe(isolated);
    }
  });
});

// ====================================================================
describe("B. A FOREIGN PIECE CANNOT EVEN WEAKEN — isolation is total, not partial", () => {
  it("B1. a foreign CONTRADICTION does not refute this project: another identity's contradicting rows leave the local answer exactly where it was", () => {
    const local = [...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcptEntitled(), burnExecuted()];
    const attacks = [
      foreign(FOREIGN_B, "CURRENT_STATE", { fragment: "the allocation mechanism is deprecated", mechanismState: "DEPRECATED" }),
      foreign(FOREIGN_C, "CURRENT_STATE", { relationship: "CONTRADICTS", fragment: "the mechanism was removed", mechanismState: "REMOVED" }),
      foreign(FOREIGN_D, "NET_EFFECT", { relationship: "CONTRADICTS", fragment: "supply did not fall" }),
    ];
    const isolated = ask(local, { identity: IDENTITY });
    const mixed = ask([...local, ...attacks], { identity: IDENTITY });
    laws(mixed, "B1");
    identical(mixed, isolated, "B1 foreign contradictions");
    expect(verdicts(mixed).MECHANISM_CURRENT_STATE).toBe(verdicts(isolated).MECHANISM_CURRENT_STATE);
  });

  it("B2. a foreign piece is RECORDED AS REFUSED, and recording it changes nothing that matters: the verdict, band, requirements and citations are the isolated world's, and the only difference anywhere is an exclusion diagnostic naming WRONG_PROJECT — never a new blocking gap", () => {
    const local = [...sovProven(), rcptEntitled()];
    const pieces = [foreign(FOREIGN_B, "DESTINATION"), foreign(FOREIGN_C, "NET_EFFECT")];
    const isolated = ask(local, { identity: IDENTITY });
    const mixed = ask([...local, ...pieces], { identity: IDENTITY });
    laws(mixed, "B2");
    identical(mixed, isolated, "B2 foreign rows recorded");

    for (const intent of INTENTS) {
      // Context gaps — the unmatched-flow picture — are untouched.
      expect(JSON.stringify(mixed[intent].claim.contextGaps), `${intent} context gaps`).toBe(
        JSON.stringify(isolated[intent].claim.contextGaps),
      );
      // The Proof's gap list differs ONLY by exclusion-shaped diagnostics.
      const added = mixed[intent].proof.gaps.filter(
        (g) => !isolated[intent].proof.gaps.some((h) => h.kind === g.kind && h.component === g.component && h.origin === g.origin),
      );
      for (const g of added) {
        expect(["ALL_EVIDENCE_EXCLUDED", "WRONG_PROJECT"], `${intent}: a foreign row created gap ${g.kind}`).toContain(g.kind);
        expect(["COMPONENT_REASON", "COMPONENT_EXCLUSION"], `${intent}: ${g.kind} reached a blocking origin`).toContain(g.origin);
      }
      // No foreign row ever becomes a REQUIREMENT_BLOCKING gap.
      for (const g of mixed[intent].proof.gaps) {
        if (g.origin !== "REQUIREMENT_BLOCKING") continue;
        expect(
          isolated[intent].proof.gaps.some((h) => h.kind === g.kind && h.component === g.component && h.origin === g.origin),
          `${intent}: foreign evidence created a blocking gap ${g.kind}@${g.component}`,
        ).toBe(true);
      }
    }
    // The refusal really is recorded, and it names the right reason —
    // ATLAS says "I saw this and it belongs to another project".
    const destination = mixed.PROTOCOL_REVENUE_TO_TOKEN.byComponent.get("DESTINATION")!;
    expect(destination.excludedEvidence.map((e) => e.reason)).toContain("WRONG_PROJECT");
    expect(destination.status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ====================================================================
describe("C. PROVENANCE CLOSURE — no truth without a traceable local lineage", () => {
  it("C1. across every mixed-identity world, each non-unsatisfied requirement cites only this job's admitted rows, names the components it rests on, and cites nothing the reducer excluded", () => {
    const worlds: [string, EvidenceRow[]][] = [
      ["local only", [...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcptEntitled(), burnExecuted(), supplyRead(), govApproved()]],
      ["+ foreign components", [...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcptEntitled(), foreign(FOREIGN_B, "NET_EFFECT"), foreign(FOREIGN_C, "EXECUTION_EVIDENCE")]],
      ["+ unbound readings", [...sovProven(), flowPath(), specLive(), destHolders(), rcptEntitled(), unbound("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" })]],
      ["+ social noise", [...sovProven(), rcptEntitled(), ...ALL_COMPONENTS.map((c) => row(c, { sourceClass: "SOCIAL", officiality: "CLAIMED" }))]],
    ];
    for (const [label, pool] of worlds) {
      const m = ask(pool, { identity: IDENTITY });
      laws(m, label);
      const supporting = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.results.flatMap((r) => r.supportingEvidenceIds));
      const contradicting = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.results.flatMap((r) => r.contradictingEvidenceIds));
      const excluded = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.results.flatMap((r) => r.excludedEvidence.map((e) => e.evidenceId)));
      const own = new Set(pool.filter((r) => r.researchJobId === JOB).map((r) => r.id));
      for (const intent of INTENTS) {
        for (const req of m[intent].claim.requirementResults) {
          if (req.status === "UNSATISFIED") continue;
          expect(req.provenance.evidenceIds.length, `${label}: ${intent} ${req.requirementId} has no lineage`).toBeGreaterThan(0);
          expect(req.provenance.componentResultKeys.length, `${label}: ${intent} ${req.requirementId} names no component`).toBeGreaterThan(0);
          for (const id of req.provenance.evidenceIds) {
            expect(own.has(id), `${label}: ${intent} ${req.requirementId} cites a foreign row`).toBe(true);
            expect(supporting.has(id) || contradicting.has(id), `${label}: ${intent} cites a row S5 never admitted`).toBe(true);
            expect(excluded.has(id), `${label}: ${intent} cites an EXCLUDED row`).toBe(false);
          }
        }
        for (const id of m[intent].proof.citedEvidenceIds) {
          expect(own.has(id), `${label}: ${intent} Proof cites a foreign row`).toBe(true);
          expect(excluded.has(id), `${label}: ${intent} Proof cites an excluded row`).toBe(false);
        }
      }
    }
  });
});
