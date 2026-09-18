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

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 7: CROSS-QUESTION / LOGICAL
// CONSISTENCY, THE PURE CHAIN.
//
// Rounds 1–6 asked one question of one evidence world. Round 7 asks EVERY
// question of the SAME world and looks for two individually plausible
// Proofs that contradict each other on the same facts:
//
//   a buyback that becomes a burn, a burn that becomes net deflation, an
//   approval that becomes execution, a transaction that becomes an
//   economic role, a historical execution that becomes current activity,
//   a stronger claim SUPPORTED while its required underlying claim is
//   absent, absence that becomes contradiction.
//
// "Question" here means what ATLAS can actually be asked: the eight
// Pattern v1 intents (S7 requirement sets) plus the per-component
// readings the Proof Map renders (S5 statuses, S6 lifecycle / attributes
// / edges). Questions with no requirement set in Pattern v1 — "does the
// protocol perform buybacks?", "was it approved?", "has it EVER
// executed?", "is there evidence X does NOT happen?" — are read at the
// component level and pinned as unsupported question forms; no new
// semantics are invented to answer them.
//
// The laws asserted are ONLY dependencies Pattern v1 already defines:
//
//   VALUE_CAPTURE            = PRT-1 ∧ PRT-2 ∧ BSE-1     (VC-1..3)
//   PROTOCOL_REVENUE_TO_TOKEN ≡ REWARD_SOURCE ≡ USAGE_TO_TOKEN_LINKAGE
//   TOKEN_UTILITY            = PRT-1 (+ optional recipient)
//   BURN_OR_SUPPLY_EFFECT    = NET_EFFECT established
//   MECHANISM_CURRENT_STATE  = lifecycle CURRENT (rests on CURRENT_STATE)
//   PASSIVE_HOLDER_OUTCOME   = recipientKind PASSIVE_HOLDER
//
// Pure: no DB, no model, no network, no spend. The real S5 reducer over
// the real Pattern v1 contract, the real S6 assembler, S7 evaluator and
// S8 builder. Cross-component chain-fact visibility (BURN -> NET_EFFECT)
// is mirrored exactly as the store selects it. The persisted half is
// adversarial-core-round7-cross-question-db-v1.

const JOB = "dddddddd-0000-4000-8000-000000000007";
const OTHER_JOB = "eeeeeeee-0000-4000-8000-000000000008";
const NOW = new Date("2026-09-17T12:00:00.000Z");
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
    publishedAt: older(1),
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}
// A deterministic, bound chain observation, in the shape the synthesis
// writes it: ONCHAIN_VERIFIABLE, CONFIRMED, entity CONFIRMED, no
// publication date (fetched_at is its temporal basis), a JSON fragment.
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

// The rows a component is reconciled over: its own, plus any chain
// observation whose kind the applicability map declares readable by it —
// exactly the selection component-reconciliation-store.ts makes.
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
const reqShape = (r: ClaimRequirementResult) => JSON.stringify({ ...r, requirementId: "" });
const s5 = (m: Matrix, component: string) => m.PROTOCOL_REVENUE_TO_TOKEN.byComponent.get(component)!;
const flow0 = (m: Matrix) => m.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows[0];
const verdicts = (m: Matrix): Record<Intent, string> => Object.fromEntries(INTENTS.map((i) => [i, m[i].proof.verdict])) as Record<Intent, string>;
const proofShape = (c: ChainResult) =>
  JSON.stringify({
    verdict: c.proof.verdict,
    confidence: c.proof.confidenceScore,
    binding: c.proof.confidenceBindingReasons,
    claim: c.claim.status,
    reasons: c.claim.reasonCodes,
    reqs: c.claim.requirementResults.map((r) => ({ ...r, requirementId: r.requirementId.replace(/^[A-Z]+-/, "") })),
    contextGaps: c.claim.contextGaps,
    gaps: c.proof.gaps,
    cited: c.proof.citedEvidenceIds,
    citations: c.proof.citations,
  });

// ------------------------------------------------------------ THE LAWS
//
// Every dependency below is read off PATTERN_V1_CONTENT.intentRequirements
// and the S7 compound rule; none is invented here. `laws()` is asked of
// every world in every family, so a contradiction between two questions
// anywhere in the round fails a named law rather than a local expectation.
function laws(m: Matrix, label: string): void {
  const PRT = m.PROTOCOL_REVENUE_TO_TOKEN;
  const VC = m.VALUE_CAPTURE;
  const BSE = m.BURN_OR_SUPPLY_EFFECT;
  const TU = m.TOKEN_UTILITY;
  const MCS = m.MECHANISM_CURRENT_STATE;

  // L0 — S5 and S6 are functions of the evidence world alone. Two
  // questions over the same facts share one reduced picture; only S7/S8
  // may differ.
  for (const i of INTENTS) {
    expect(JSON.stringify(m[i].results), `${label}: S5 differs for ${i}`).toBe(JSON.stringify(PRT.results));
    expect(JSON.stringify(m[i].assembly), `${label}: S6 differs for ${i}`).toBe(JSON.stringify(PRT.assembly));
  }
  // L1 — three intents carry the same requirement set and must agree
  // byte for byte.
  expect(proofShape(m.REWARD_SOURCE), `${label}: REWARD_SOURCE != PRT`).toBe(proofShape(PRT));
  expect(proofShape(m.USAGE_TO_TOKEN_LINKAGE), `${label}: USAGE_TO_TOKEN_LINKAGE != PRT`).toBe(proofShape(PRT));
  // L2 — VALUE_CAPTURE is the conjunction of PRT and BSE, atom by atom.
  expect(reqShape(req(VC, "VC-1")), `${label}: VC-1 != PRT-1`).toBe(reqShape(req(PRT, "PRT-1")));
  expect(reqShape(req(VC, "VC-2")), `${label}: VC-2 != PRT-2`).toBe(reqShape(req(PRT, "PRT-2")));
  expect(reqShape(req(VC, "VC-3")), `${label}: VC-3 != BSE-1`).toBe(reqShape(req(BSE, "BSE-1")));
  if (VC.proof.verdict === "SUPPORTED") {
    expect([PRT.proof.verdict, BSE.proof.verdict], `${label}: VC SUPPORTED without both conjuncts`).toEqual(["SUPPORTED", "SUPPORTED"]);
  }
  expect(VC.proof.verdict === "NOT_SUPPORTED", `${label}: refutation law VC=${VC.proof.verdict} PRT=${PRT.proof.verdict} BSE=${BSE.proof.verdict}`).toBe(
    PRT.proof.verdict === "NOT_SUPPORTED" || BSE.proof.verdict === "NOT_SUPPORTED",
  );
  expect(VC.proof.verdict === "INSUFFICIENT_EVIDENCE", `${label}: insufficiency law`).toBe(
    PRT.proof.verdict === "INSUFFICIENT_EVIDENCE" && BSE.proof.verdict === "INSUFFICIENT_EVIDENCE",
  );
  expect(VERDICT_RANK[VC.proof.verdict], `${label}: VC stronger than both conjuncts`).toBeLessThanOrEqual(Math.max(VERDICT_RANK[PRT.proof.verdict], VERDICT_RANK[BSE.proof.verdict]));
  // L3 — TOKEN_UTILITY's only REQUIRED atom is PRT-1.
  expect(reqShape(req(TU, "TU-1")), `${label}: TU-1 != PRT-1`).toBe(reqShape(req(PRT, "PRT-1")));
  if (PRT.proof.verdict === "SUPPORTED") expect(TU.proof.verdict, `${label}: PRT SUPPORTED but TU weaker`).toBe("SUPPORTED");
  // L4 — under Pattern v1 NET_EFFECT can never be SUPPORTED (every typed
  // outcome keeps a limitation), so no supply question is ever SUPPORTED.
  expect(s5(m, "NET_EFFECT").status, `${label}: NET_EFFECT SUPPORTED`).not.toBe("SUPPORTED");
  expect(BSE.proof.verdict, `${label}: BSE SUPPORTED`).not.toBe("SUPPORTED");
  expect(VC.proof.verdict, `${label}: VC SUPPORTED`).not.toBe("SUPPORTED");
  // L5 — "is it current?" rests on CURRENT_STATE alone; a refutation
  // needs an established execution beside a positively non-live state.
  const cs = s5(m, "CURRENT_STATE");
  const ex = s5(m, "EXECUTION_EVIDENCE");
  if (MCS.proof.verdict === "SUPPORTED" || MCS.proof.verdict === "PARTIALLY_SUPPORTED") {
    expect(["SUPPORTED", "PARTIALLY_SUPPORTED"], `${label}: MCS ${MCS.proof.verdict} without CURRENT_STATE`).toContain(cs.status);
    expect(cs.currentState, `${label}: MCS ${MCS.proof.verdict} on state ${cs.currentState}`).toBe("LIVE");
  }
  if (MCS.proof.verdict === "NOT_SUPPORTED") {
    expect(["SUPPORTED", "PARTIALLY_SUPPORTED"], `${label}: MCS refuted without execution`).toContain(ex.status);
    expect(["PAUSED", "DEPRECATED", "REMOVED"], `${label}: MCS refuted on state ${cs.currentState}`).toContain(cs.currentState);
  }
  if (cs.status === "SUPPORTED" && cs.currentState === "LIVE") expect(MCS.proof.verdict, `${label}: fresh official LIVE but MCS=${MCS.proof.verdict}`).toBe("SUPPORTED");
  // L6 — provenance: every citation of every question is a supporting row
  // of S5, never excluded, never contradicting, never foreign; the
  // stronger question cites everything its prerequisite cites.
  const supporting = new Set(PRT.results.flatMap((r) => r.supportingEvidenceIds));
  const excluded = new Set(PRT.results.flatMap((r) => r.excludedEvidence.map((e) => e.evidenceId)));
  const contradicting = new Set(PRT.results.flatMap((r) => r.contradictingEvidenceIds));
  const foreign = new Set(PRT.pool.filter((r) => r.researchJobId !== JOB).map((r) => r.id));
  for (const i of INTENTS) {
    for (const id of m[i].proof.citedEvidenceIds) {
      expect(supporting.has(id), `${label}: ${i} cites non-supporting ${id}`).toBe(true);
      expect(excluded.has(id) || contradicting.has(id) || foreign.has(id), `${label}: ${i} cites excluded/contradicting/foreign ${id}`).toBe(false);
    }
  }
  for (const id of [...supporting, ...contradicting]) expect(foreign.has(id), `${label}: foreign row ${id} admitted`).toBe(false);
  for (const id of PRT.proof.citedEvidenceIds) expect(VC.proof.citedEvidenceIds, `${label}: VC drops PRT citation ${id}`).toContain(id);
  // L7 — confidence: bounded by the verdict ceiling; at an equal verdict
  // the stronger claim never outranks its prerequisite.
  for (const i of INTENTS) {
    const ceiling = m[i].proof.verdict === "SUPPORTED" || m[i].proof.verdict === "NOT_SUPPORTED" ? 80 : 60;
    expect(m[i].proof.confidenceScore, `${label}: ${i} above ceiling`).toBeLessThanOrEqual(ceiling);
  }
  if (VC.proof.verdict === PRT.proof.verdict) expect(VC.proof.confidenceScore, `${label}: VC outranks PRT`).toBeLessThanOrEqual(PRT.proof.confidenceScore);
  if (VC.proof.verdict === BSE.proof.verdict) expect(VC.proof.confidenceScore, `${label}: VC outranks BSE`).toBeLessThanOrEqual(BSE.proof.confidenceScore);
  // L8 — a refutation is a positive finding with provenance, never absence.
  for (const i of INTENTS) {
    if (m[i].proof.verdict !== "NOT_SUPPORTED") continue;
    const refuted = m[i].claim.requirementResults.filter((r) => r.optionality === "REQUIRED" && r.status === "CONTRADICTED");
    expect(refuted.length, `${label}: ${i} NOT_SUPPORTED without a contradicted atom`).toBeGreaterThan(0);
    for (const r of refuted) expect(r.provenance.evidenceIds.length, `${label}: ${i} ${r.requirementId} refuted without provenance`).toBeGreaterThan(0);
  }
}

// A world with nothing negative in it (no non-live state, no disagreeing
// state, no non-decrease interval, no non-holder recipient) must not
// refute any question.
function nonNegative(m: Matrix, label: string): void {
  for (const i of INTENTS) expect(m[i].proof.verdict, `${label}: ${i} refuted`).not.toBe("NOT_SUPPORTED");
  for (const r of m.PROTOCOL_REVENUE_TO_TOKEN.results) expect(r.status, `${label}: ${r.component} contradicted`).not.toBe("CONTRADICTED");
}

// Only the questions named may change between two worlds; every other
// question reads identically (verdict, requirements, citations, band).
function onlyTheseChange(before: Matrix, after: Matrix, allowed: readonly Intent[], label: string): void {
  for (const i of INTENTS) {
    if (allowed.includes(i)) continue;
    expect(verdicts(after)[i], `${label}: ${i} moved ${verdicts(before)[i]} -> ${verdicts(after)[i]}`).toBe(verdicts(before)[i]);
    expect(after[i].claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`), `${label}: ${i} requirements moved`).toEqual(
      before[i].claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`),
    );
  }
}

// ---------------------------------------------------------- SOV SUPPORTED
//
// SOURCE_OF_VALUE reaches SUPPORTED only with a confirmed identity and a
// provenance-bearing chain observation whose invoking program a human
// confirmed for the activity the support names (D-158). Synthetic program
// ids, a fictional activity, the registry overlay seam — no real project.
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

// ----------------------------------------------------------------- worlds

const sov = () => row("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users on Orbitswap generate the revenue" });
const sovProven = () => [sov(), provenanceRow()];
const flowPath = () => row("FLOW_PATH", { fragment: "fee revenue is routed from the fee collector to the allocation contract" });
const specLive = () => row("MECHANISM_SPEC", { fragment: "50% of protocol fees are allocated to the token each epoch", mechanismState: "LIVE" });
const govApproved = () => confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", fragment: "the allocation proposal passed the token holder vote", mechanismState: "APPROVED" });
const govProposed = () => confirmed("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", fragment: "proposal: allocate 50% of protocol fees to the token", mechanismState: "PROPOSED" });
const burnExecuted = () => chain("EXECUTION_EVIDENCE", { onchainFactKind: "BURN", mechanismState: "LIVE" });
const reportExecuted = (days = 400) => row("EXECUTION_EVIDENCE", { sourceClass: "OFFICIAL_REPORT", fragment: "the epoch allocation was executed on schedule", mechanismState: "LIVE", publishedAt: older(days) });
const csLive = (days = 1) => row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE", publishedAt: older(days) });
const csPaused = () => row("CURRENT_STATE", { fragment: "the allocation mechanism is paused", mechanismState: "PAUSED" });
const csApproved = () => row("CURRENT_STATE", { fragment: "the allocation has been approved and awaits activation", mechanismState: "APPROVED" });
const csSupply = () => chain("CURRENT_STATE", { onchainFactKind: "TOKEN_SUPPLY" });
const destBurn = () => row("DESTINATION", { fragment: "bought back tokens are burned" });
const destTreasury = () => row("DESTINATION", { fragment: "bought back tokens are held in the protocol treasury" });
const destHolders = () => row("DESTINATION", { fragment: "fees are distributed to holders through the distributor" });
const destOpaque = () => row("DESTINATION", { fragment: "fees are sent to the protocol multisig at 0x1234" });
const rcptHolders = () => row("RECIPIENT", { fragment: "token holders receive the distributed fees" });
const rcptTreasury = () => row("RECIPIENT", { fragment: "the treasury receives the bought back tokens" });
const netSupply = () => chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY" });
const netDeltaDown = () => chain("NET_EFFECT", { onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "SUPPORTS" });
const netDeltaNotDown = () => chain("NET_EFFECT", { onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS" });
const netReport = () => row("NET_EFFECT", { sourceClass: "OFFICIAL_REPORT", fragment: "total supply decreased by 5% after the burn" });
const durability = () => confirmed("DURABILITY_BASIS", { sourceClass: "GOVERNANCE", fragment: "the allocation can be revoked by a governance vote", mechanismState: "APPROVED" });

// The documentary buyback mechanism: fees -> buyback -> treasury. Nothing
// is burned, nothing is measured, nothing is executed on chain.
const buybackDocs = () => [sov(), flowPath(), row("MECHANISM_SPEC", { fragment: "50% of protocol fees are used to buy back the token on the open market", mechanismState: "LIVE" }), destTreasury(), rcptTreasury()];
// The documentary fee -> holders mechanism.
const holderDocs = () => [sov(), flowPath(), specLive(), destHolders(), rcptHolders()];
const withState = (rows: EvidenceRow[], mechanismState: string) => rows.map((r) => ({ ...r, mechanismState }));

// ====================================================================
describe("A. same facts, every question — the implication laws over a combinatorial battery", () => {
  it("A1. 2,880 worlds x 8 intents: no world violates L0–L8; a world without a negative fact never refutes anything", () => {
    type Toggle = { name: string; rows: () => EvidenceRow[]; negative?: boolean };
    const SOV: Toggle[] = [
      { name: "sov:docs", rows: () => [sov()] },
      { name: "sov:proven", rows: sovProven },
    ];
    const SPEC: Toggle[] = [
      { name: "spec:none", rows: () => [] },
      { name: "spec:live", rows: () => [specLive()] },
    ];
    const EXEC: Toggle[] = [
      { name: "exec:none", rows: () => [] },
      { name: "exec:burn", rows: () => [burnExecuted()] },
    ];
    const CS: Toggle[] = [
      { name: "cs:none", rows: () => [] },
      { name: "cs:live", rows: () => [csLive()] },
      { name: "cs:paused", rows: () => [csPaused()], negative: true },
      { name: "cs:live-stale", rows: () => [csLive(10)] },
      { name: "cs:conflict", rows: () => [csLive(), csPaused()], negative: true },
      { name: "cs:supply", rows: () => [csSupply()] },
    ];
    const DEST: Toggle[] = [
      { name: "dest:none", rows: () => [] },
      { name: "dest:burn", rows: () => [destBurn()] },
      { name: "dest:treasury", rows: () => [destTreasury()] },
      { name: "dest:holders", rows: () => [destHolders()] },
    ];
    const RCPT: Toggle[] = [
      { name: "rcpt:none", rows: () => [] },
      { name: "rcpt:holders", rows: () => [rcptHolders()] },
      { name: "rcpt:treasury", rows: () => [rcptTreasury()], negative: true },
    ];
    const NET: Toggle[] = [
      { name: "net:none", rows: () => [] },
      { name: "net:supply", rows: () => [netSupply()] },
      { name: "net:delta-down", rows: () => [netDeltaDown()] },
      { name: "net:delta-not-down", rows: () => [netDeltaNotDown()], negative: true },
      { name: "net:report", rows: () => [netReport()] },
    ];
    let worlds = 0;
    for (const s of SOV)
      for (const sp of SPEC)
        for (const e of EXEC)
          for (const c of CS)
            for (const d of DEST)
              for (const r of RCPT)
                for (const n of NET) {
                  const toggles = [s, sp, e, c, d, r, n];
                  const label = toggles.map((t) => t.name).join(" ");
                  const pool = [flowPath(), govApproved(), durability(), ...toggles.flatMap((t) => t.rows())];
                  const m = ask(pool, { identity: IDENTITY });
                  laws(m, label);
                  if (!toggles.some((t) => t.negative)) nonNegative(m, label);
                  worlds += 1;
                }
    expect(worlds).toBe(2 * 2 * 2 * 6 * 4 * 3 * 5);
  }, 120_000);

  it("A2. foreign rows (another job, an unbound chain read of another asset) added to every component change no question's answer — no cross-job / cross-project / cross-chain leakage into any related Proof", () => {
    const base = [...holderDocs(), govApproved(), burnExecuted(), csLive(), netSupply(), durability()];
    const control = ask(base, { identity: IDENTITY });
    const foreign = ALL_COMPONENTS.flatMap((c) => [
      row(c, { researchJobId: OTHER_JOB, mechanismState: "LIVE", fragment: "the other project burns 100% of its fees" }),
      chain(c, { onchainFactKind: c === "NET_EFFECT" || c === "EXECUTION_EVIDENCE" ? "BURN" : "TOKEN_SUPPLY", entityBinding: "UNVERIFIED", mechanismState: "LIVE" }),
    ]);
    const attacked = ask([...base, ...foreign], { identity: IDENTITY });
    laws(attacked, "A2");
    for (const i of INTENTS) {
      expect(attacked[i].proof.verdict).toBe(control[i].proof.verdict);
      expect(attacked[i].proof.confidenceScore).toBe(control[i].proof.confidenceScore);
      expect(attacked[i].claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`)).toEqual(control[i].claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`));
      expect(attacked[i].proof.citedEvidenceIds).toEqual(control[i].proof.citedEvidenceIds);
      for (const f of foreign) expect(attacked[i].proof.citedEvidenceIds).not.toContain(f.id);
    }
    for (const f of foreign) {
      const r = attacked.PROTOCOL_REVENUE_TO_TOKEN.byComponent.get(f.component!)!;
      expect(r.excludedEvidence.map((e) => e.evidenceId)).toContain(f.id);
    }
  });
});

// ====================================================================
describe("B. buyback / burn / net effect over one evidence world", () => {
  it("B1. buyback only (docs: fees -> open-market buyback -> treasury): 'does revenue reach the token?' is answered from the docs, 'are tokens burned / does supply fall / is it net deflationary?' is not answered at all, and nothing says burn", () => {
    const m = ask(buybackDocs());
    laws(m, "B1");
    for (const r of m.PROTOCOL_REVENUE_TO_TOKEN.results) expect(r.status).not.toBe("CONTRADICTED");
    expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN).toBe("PARTIALLY_SUPPORTED"); // D-158: SOV documentary only
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
    expect(req(m.BURN_OR_SUPPLY_EFFECT, "BSE-1").reasonCodes).toEqual(["NET_EFFECT_NOT_ESTABLISHED"]);
    expect(s5(m, "NET_EFFECT").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(m).attributes.destinationKind).toBe("TREASURY");
    expect(flow0(m).attributes.valueSource).toBe("FEES");
    // "do holders receive?" is positively refuted by the treasury recipient
    // — a buyback-and-hold is not a holder distribution.
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("NOT_SUPPORTED");
  });

  it("B2. buyback + burn in the docs, no chain observation: the destination reads BURN lexically, and that word alone reaches no verdict — every question answers exactly as in the buyback-only world (BUYBACK != BURN, DOCUMENTED BURN != SUPPLY EFFECT)", () => {
    const buyback = ask(buybackDocs());
    const burned = ask([...buybackDocs().filter((r) => r.component !== "DESTINATION"), destBurn()]);
    laws(burned, "B2");
    expect(flow0(burned).attributes.destinationKind).toBe("BURN");
    expect(verdicts(burned)).toEqual(verdicts(buyback));
    for (const i of INTENTS) expect(burned[i].claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`)).toEqual(buyback[i].claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`));
    expect(s5(burned, "NET_EFFECT").status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("B3. burn executed on chain (one BURN at EXECUTION_EVIDENCE): 'has it executed?' is established, 'did supply fall?' is measured-nothing — BURN_OR_SUPPLY_EFFECT is PARTIALLY_SUPPORTED with NET_SUPPLY_CHANGE_NOT_ESTABLISHED, never SUPPORTED; the same burn read by NET_EFFECT is one row, cited once", () => {
    const docs = [...buybackDocs().filter((r) => r.component !== "DESTINATION"), destBurn()];
    const before = ask(docs);
    const burn = burnExecuted();
    const m = ask([...docs, burn]);
    laws(m, "B3");
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("SUPPORTED");
    expect(flow0(m).edges.every((e) => e.executed)).toBe(true);
    expect(s5(m, "NET_EFFECT").status).toBe("PARTIALLY_SUPPORTED");
    expect(s5(m, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]);
    expect(s5(m, "NET_EFFECT").supportingEvidenceIds).toEqual([burn.id]);
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
    expect(m.BURN_OR_SUPPLY_EFFECT.proof.citedEvidenceIds).toEqual([burn.id]);
    // Only the supply questions and the compound claim strengthen; the
    // revenue and holder questions read exactly as before the burn.
    onlyTheseChange(before, m, ["BURN_OR_SUPPLY_EFFECT", "VALUE_CAPTURE"], "B3");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("B4. burn + ONE supply observation: a level is not a change — the reading is admitted as support and the supply question stays at the burn's rung (NET_SUPPLY_CHANGE_NOT_ESTABLISHED), identical to the burn-alone verdict", () => {
    const docs = [...buybackDocs().filter((r) => r.component !== "DESTINATION"), destBurn()];
    const burnAlone = ask([...docs, burnExecuted()]);
    const m = ask([...docs, burnExecuted(), netSupply()]);
    laws(m, "B4");
    expect(s5(m, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]);
    expect(verdicts(m)).toEqual(verdicts(burnAlone));
  });

  it("B5. burn + negative supply delta, no attribution: the measurement is established, the cause is not — NET_SUPPLY_CHANGE_NOT_ATTRIBUTED, still PARTIALLY_SUPPORTED at LIMITED, never SUPPORTED; 'did the burn cause it?' cannot be answered yes by any question", () => {
    const docs = [...holderDocs(), govApproved(), csLive(), durability()];
    const m = ask([...docs, burnExecuted(), netDeltaDown()], { identity: IDENTITY });
    laws(m, "B5");
    expect(s5(m, "NET_EFFECT").status).toBe("PARTIALLY_SUPPORTED");
    expect(s5(m, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"]);
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
    expect(m.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore).toBeLessThanOrEqual(40);
    expect(m.BURN_OR_SUPPLY_EFFECT.proof.confidenceBindingReasons).toContain("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
    expect(verdicts(m).VALUE_CAPTURE).toBe("PARTIALLY_SUPPORTED");
  });

  it("B6. burn + zero / positive delta: the NET question is refuted (NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL) while the burn stays established and cited — BURN_OR_SUPPLY_EFFECT and VALUE_CAPTURE are NOT_SUPPORTED, the revenue and current-state questions are untouched", () => {
    const docs = [...holderDocs(), govApproved(), csLive(), durability()];
    const before = ask([...docs, burnExecuted()], { identity: IDENTITY });
    const burn = burnExecuted();
    const delta = netDeltaNotDown();
    const m = ask([...docs, burn, delta], { identity: IDENTITY });
    laws(m, "B6");
    expect(s5(m, "NET_EFFECT").status).toBe("CONTRADICTED");
    expect(s5(m, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"]);
    expect(s5(m, "NET_EFFECT").supportingEvidenceIds).toEqual([burn.id]);
    expect(s5(m, "NET_EFFECT").contradictingEvidenceIds).toEqual([delta.id]);
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("SUPPORTED");
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("NOT_SUPPORTED");
    expect(verdicts(m).VALUE_CAPTURE).toBe("NOT_SUPPORTED");
    expect(m.BURN_OR_SUPPLY_EFFECT.proof.citedEvidenceIds).toEqual([burn.id]);
    onlyTheseChange(before, m, ["BURN_OR_SUPPLY_EFFECT", "VALUE_CAPTURE"], "B6");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("SUPPORTED");
  });

  it("B7. a negative delta WITHOUT a burn: 'supply drifted down' is not 'the mechanism reduced supply' — SUPPLY_REDUCTION_NOT_ESTABLISHED, the same rung as a single supply reading, never NOT_ATTRIBUTED, never stronger than the burn-plus-delta world", () => {
    const docs = [...holderDocs(), govApproved(), csLive(), durability()];
    const deltaOnly = ask([...docs, netDeltaDown()], { identity: IDENTITY });
    const readingOnly = ask([...docs, netSupply()], { identity: IDENTITY });
    const burnAndDelta = ask([...docs, burnExecuted(), netDeltaDown()], { identity: IDENTITY });
    laws(deltaOnly, "B7");
    expect(s5(deltaOnly, "NET_EFFECT").reasonCodes).toEqual(["SUPPLY_REDUCTION_NOT_ESTABLISHED"]);
    expect(s5(readingOnly, "NET_EFFECT").reasonCodes).toEqual(["SUPPLY_REDUCTION_NOT_ESTABLISHED"]);
    expect(verdicts(deltaOnly)).toEqual(verdicts(readingOnly));
    expect(VERDICT_RANK[verdicts(deltaOnly).BURN_OR_SUPPLY_EFFECT]).toBeLessThanOrEqual(VERDICT_RANK[verdicts(burnAndDelta).BURN_OR_SUPPLY_EFFECT]);
    expect(deltaOnly.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore).toBeLessThanOrEqual(burnAndDelta.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore);
  });

  it("B8. an official report asserting 'supply decreased' is prose: it supports NET_EFFECT at the no-gross-reduction rung and nothing more — the supply question is PARTIALLY_SUPPORTED with SUPPLY_REDUCTION_NOT_ESTABLISHED, exactly as with a bare reading, and BUYBACK support never implies it", () => {
    const m = ask([...buybackDocs(), netReport()]);
    laws(m, "B8");
    expect(s5(m, "NET_EFFECT").status).toBe("PARTIALLY_SUPPORTED");
    expect(s5(m, "NET_EFFECT").reasonCodes).toEqual(["SUPPLY_REDUCTION_NOT_ESTABLISHED"]);
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
    expect(m.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore).toBeLessThanOrEqual(40);
    const withoutReport = ask(buybackDocs());
    expect(verdicts(withoutReport).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("B9. the burn / supply ladder is strictly ordered across worlds: no burn < burn alone <= burn + reading <= burn + measured decrease, and burn + measured non-decrease is the refutation — every step named by its own code, no step ever SUPPORTED", () => {
    const docs = [...holderDocs(), govApproved(), csLive(), durability()];
    const worlds = {
      none: ask(docs, { identity: IDENTITY }),
      burn: ask([...docs, burnExecuted()], { identity: IDENTITY }),
      burnReading: ask([...docs, burnExecuted(), netSupply()], { identity: IDENTITY }),
      burnDecrease: ask([...docs, burnExecuted(), netDeltaDown()], { identity: IDENTITY }),
      burnNotReduced: ask([...docs, burnExecuted(), netDeltaNotDown()], { identity: IDENTITY }),
    };
    for (const [k, m] of Object.entries(worlds)) laws(m, `B9 ${k}`);
    const bse = (k: keyof typeof worlds) => worlds[k].BURN_OR_SUPPLY_EFFECT.proof.verdict;
    expect(bse("none")).toBe("INSUFFICIENT_EVIDENCE");
    expect(bse("burn")).toBe("PARTIALLY_SUPPORTED");
    expect(bse("burnReading")).toBe("PARTIALLY_SUPPORTED");
    expect(bse("burnDecrease")).toBe("PARTIALLY_SUPPORTED");
    expect(bse("burnNotReduced")).toBe("NOT_SUPPORTED");
    expect(s5(worlds.none, "NET_EFFECT").reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    expect(s5(worlds.burn, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]);
    expect(s5(worlds.burnReading, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]);
    expect(s5(worlds.burnDecrease, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"]);
    expect(s5(worlds.burnNotReduced, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"]);
    // The revenue question is the same in all five worlds: a supply
    // outcome is not a revenue finding (the Proof's job-wide gap list and
    // row ids differ; the verdict, requirements and citation count do not).
    const prt = Object.values(worlds).map((m) => `${m.PROTOCOL_REVENUE_TO_TOKEN.proof.verdict}|${m.PROTOCOL_REVENUE_TO_TOKEN.claim.requirementResults.map((r) => `${r.requirementId}:${r.status}`).join(",")}|${m.PROTOCOL_REVENUE_TO_TOKEN.proof.citedEvidenceIds.length}`);
    expect(new Set(prt).size).toBe(1);
  });
});

// ====================================================================
describe("C. revenue / fees / value capture over one evidence world", () => {
  it("C1. revenue alone (SOURCE_OF_VALUE only, documentary): 'does the protocol generate revenue?' (TU-1) is the one atom that holds; where fees go, whether they reach the token, whether holders receive value, whether the mechanism is active — all unestablished, none refuted", () => {
    const m = ask([sov()]);
    laws(m, "C1");
    nonNegative(m, "C1");
    expect(req(m.TOKEN_UTILITY, "TU-1").status).toBe("PARTIAL"); // documentary only (D-158)
    expect(verdicts(m).TOKEN_UTILITY).toBe("PARTIALLY_SUPPORTED");
    expect(req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status).toBe("UNSATISFIED");
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("C2. revenue with machine provenance (SOURCE_OF_VALUE SUPPORTED): the revenue atom is fully established and STILL implies no buyback, no distribution, no value capture, no current execution — each narrower mechanism needs its own Evidence", () => {
    const m = ask(sovProven(), { identity: IDENTITY });
    laws(m, "C2");
    nonNegative(m, "C2");
    expect(s5(m, "SOURCE_OF_VALUE").status).toBe("SUPPORTED");
    expect(req(m.TOKEN_UTILITY, "TU-1").status).toBe("SATISFIED");
    expect(verdicts(m).TOKEN_UTILITY).toBe("SUPPORTED");
    expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN).toBe("PARTIALLY_SUPPORTED");
    expect(req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status).toBe("UNSATISFIED");
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).VALUE_CAPTURE).toBe("PARTIALLY_SUPPORTED");
    expect(m.TOKEN_UTILITY.proof.confidenceScore).toBe(20);
  });

  it("C3. the complete documentary + mechanical world: revenue -> token SUPPORTED, holders SUPPORTED, current SUPPORTED, and the compound value-capture claim is still PARTIAL because net effect is never established — the strongest question is exactly its conjuncts, never more", () => {
    const m = ask([...sovProven(), flowPath(), specLive(), govApproved(), burnExecuted(), csLive(), destHolders(), rcptHolders(), netSupply(), durability()], { identity: IDENTITY });
    laws(m, "C3");
    expect(verdicts(m)).toEqual({
      PROTOCOL_REVENUE_TO_TOKEN: "SUPPORTED",
      // Round 7.5 (Founder decision M3): the recipient sentence names
      // holders and never links HOLDING to entitlement, so the holder
      // question is bounded at PARTIALLY_SUPPORTED; every other question
      // in this world is unchanged.
      PASSIVE_HOLDER_OUTCOME: "PARTIALLY_SUPPORTED",
      REWARD_SOURCE: "SUPPORTED",
      BURN_OR_SUPPLY_EFFECT: "PARTIALLY_SUPPORTED",
      MECHANISM_CURRENT_STATE: "SUPPORTED",
      USAGE_TO_TOKEN_LINKAGE: "SUPPORTED",
      VALUE_CAPTURE: "PARTIALLY_SUPPORTED",
      TOKEN_UTILITY: "SUPPORTED",
    });
    expect(m.VALUE_CAPTURE.claim.reasonCodes).toEqual(["REQUIRED_PATH_PARTIAL"]);
    // Round 7.5 (M3): the holder question additionally carries its own
    // REQUIRED blocking gap (the unresolved holding -> entitlement
    // bridge), so it binds on one more reason than the rest. Every other
    // question is exactly where Round 7 left it.
    const others = INTENTS.filter((i) => i !== "PASSIVE_HOLDER_OUTCOME");
    for (const i of others) expect(m[i].proof.confidenceScore, i).toBe(40);
    for (const i of others) expect(m[i].proof.confidenceBindingReasons, i).toEqual(["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]);
    expect(m.PASSIVE_HOLDER_OUTCOME.proof.confidenceBindingReasons).toEqual(["NET_SUPPLY_CHANGE_NOT_ESTABLISHED", "REQUIRED_BLOCKING_GAP"]);
    expect(m.PASSIVE_HOLDER_OUTCOME.proof.confidenceScore).toBeLessThanOrEqual(40);
  });

  it("C4 (DECIDED, Round 7.5): 'where do fees go?' with an established destination S6 cannot classify (a multisig address) no longer reads the same as a treasury — the destination stays established and cited, the relationship atom drops to PARTIAL on REQUIRED_RELATIONSHIP_UNRESOLVED, and the revenue question can no longer be SUPPORTED. WHERE != WHO", () => {
    const opaque = ask([...sovProven(), flowPath(), destOpaque()], { identity: IDENTITY });
    const treasury = ask([...sovProven(), flowPath(), destTreasury()], { identity: IDENTITY });
    laws(opaque, "C4");
    // Nothing about the destination is withdrawn.
    expect(s5(opaque, "DESTINATION").status).toBe("SUPPORTED");
    expect(flow0(opaque).attributes.destinationKind).toBe("UNKNOWN");
    expect(flow0(opaque).gaps.some((g) => g.kind === "DESTINATION_UNRESOLVED" && g.provenance.evidenceIds.length > 0)).toBe(true);
    // The role-dependent atom is bounded, and says why.
    const prt2 = req(opaque.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2");
    expect(prt2.status).toBe("PARTIAL");
    expect(prt2.reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(prt2.blockingGaps.map((g) => g.kind)).toEqual(["DESTINATION_UNRESOLVED"]);
    // Still cited — the decision forbids invalidating the rows themselves.
    expect(prt2.provenance.componentResultKeys.map((k) => k.component)).toContain("DESTINATION");
    expect(prt2.provenance.evidenceIds.length).toBeGreaterThan(0);
    // The two worlds now read differently, and the opaque one is weaker.
    expect(req(treasury.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status).toBe("SATISFIED");
    expect(VERDICT_RANK[verdicts(opaque).PROTOCOL_REVENUE_TO_TOKEN]).toBeLessThan(VERDICT_RANK[verdicts(treasury).PROTOCOL_REVENUE_TO_TOKEN]);
    expect(verdicts(opaque).PROTOCOL_REVENUE_TO_TOKEN).toBe("PARTIALLY_SUPPORTED");
  });

  it("C5. holders vs treasury: the same revenue world with a treasury recipient refutes 'do holders receive value?' and leaves 'does revenue reach the token?' untouched; with a holder recipient both hold — the two questions never disagree about the recipient they share", () => {
    const base = [...sovProven(), flowPath(), specLive(), destHolders()];
    const holders = ask([...base, rcptHolders()], { identity: IDENTITY });
    const treasury = ask([...base, rcptTreasury()], { identity: IDENTITY });
    laws(holders, "C5 holders");
    laws(treasury, "C5 treasury");
    // Round 7.5 (M3): "holders receive" is bounded at PARTIAL; "the
    // treasury receives, not holders" is still a full refutation from
    // recipient identity alone — the decision weakens no independently
    // valid recipient fact.
    expect(verdicts(holders).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    expect(verdicts(treasury).PASSIVE_HOLDER_OUTCOME).toBe("NOT_SUPPORTED");
    expect(req(treasury.PASSIVE_HOLDER_OUTCOME, "PHO-1").reasonCodes).toEqual(["ACTOR_MISMATCH"]);
    expect(verdicts(holders).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    expect(verdicts(treasury).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    onlyTheseChange(holders, treasury, ["PASSIVE_HOLDER_OUTCOME", "TOKEN_UTILITY"], "C5");
    // TOKEN_UTILITY's recipient atom is OPTIONAL: the treasury is an
    // accepted utility recipient, so the verdict stays SUPPORTED.
    expect(verdicts(treasury).TOKEN_UTILITY).toBe("SUPPORTED");
  });

  it("C6. 'is the value-capture mechanism active today?' is a CURRENT_STATE question: the complete revenue world without a fresh current-state row leaves it INSUFFICIENT while every structural question holds; adding the fresh official row answers it and moves nothing else", () => {
    const base = [...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()];
    const before = ask(base, { identity: IDENTITY });
    const after = ask([...base, csLive()], { identity: IDENTITY });
    laws(before, "C6 before");
    laws(after, "C6 after");
    expect(verdicts(before).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    expect(verdicts(before).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(after).MECHANISM_CURRENT_STATE).toBe("SUPPORTED");
    onlyTheseChange(before, after, ["MECHANISM_CURRENT_STATE"], "C6");
  });
});

// ====================================================================
describe("D. governance lifecycle over one evidence world", () => {
  it("D1. proposed only: every structural component is capped PROPOSED_STATE_ONLY, governance authorisation is APPROVAL_NOT_ESTABLISHED, no question is SUPPORTED, none is refuted, 'is it current?' is unanswered — PROPOSED != APPROVED", () => {
    const m = ask([...withState(holderDocs(), "PROPOSED"), govProposed()]);
    laws(m, "D1");
    nonNegative(m, "D1");
    for (const c of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "DESTINATION", "RECIPIENT"]) expect(s5(m, c).reasonCodes).toContain("PROPOSED_STATE_ONLY");
    expect(s5(m, "GOVERNANCE_BASIS").reasonCodes).toEqual(["PROPOSED_STATE_ONLY", "APPROVAL_NOT_ESTABLISHED"]);
    for (const i of INTENTS) expect(m[i].proof.verdict).not.toBe("SUPPORTED");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(m).lifecycle).toBe("NOT_ESTABLISHED");
  });

  it("D2. approved, not activated: governance authorisation is established, the structural questions hold, and 'is it activated / current / executing?' stays unanswered whether or not a fresh official page says APPROVED — APPROVED != ACTIVATED", () => {
    const base = [...withState(holderDocs(), "APPROVED"), govApproved()];
    const m = ask(base);
    const withApprovedState = ask([...base, csApproved()]);
    laws(m, "D2");
    laws(withApprovedState, "D2 + state");
    nonNegative(withApprovedState, "D2 + state");
    expect(s5(m, "GOVERNANCE_BASIS").status).toBe("SUPPORTED");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(withApprovedState, "CURRENT_STATE").status).toBe("SUPPORTED");
    expect(s5(withApprovedState, "CURRENT_STATE").currentState).toBe("APPROVED");
    expect(flow0(withApprovedState).lifecycle).toBe("NOT_ESTABLISHED");
    expect(verdicts(withApprovedState).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(req(withApprovedState.MECHANISM_CURRENT_STATE, "MCS-1").reasonCodes).toEqual(["TEMPORAL_SCOPE_MISMATCH"]);
    onlyTheseChange(m, withApprovedState, [], "D2");
  });

  it("D3. activated (fresh official LIVE), nothing executed: 'is it current?' is SUPPORTED on the current-state row alone (the lifecycle atom rests on CURRENT_STATE by definition), 'has it executed?' stays unestablished and no edge reads executed — ACTIVATED != EXECUTING is visible at the component level", () => {
    const m = ask([...withState(holderDocs(), "LIVE"), govApproved(), csLive()]);
    laws(m, "D3");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("SUPPORTED");
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(m).edges.every((e) => !e.executed)).toBe(true);
    expect(flow0(m).lifecycle).toBe("CURRENT");
    expect(m.MECHANISM_CURRENT_STATE.proof.citedEvidenceIds).toEqual(s5(m, "CURRENT_STATE").supportingEvidenceIds);
  });

  it("D4. executing (fresh LIVE + a burn): the execution edge reads executed, NET_EFFECT reads the burn, and the current-state question is exactly as in D3 — execution strengthens the supply questions only", () => {
    const activated = ask([...withState(holderDocs(), "LIVE"), govApproved(), csLive()]);
    const executing = ask([...withState(holderDocs(), "LIVE"), govApproved(), csLive(), burnExecuted()]);
    laws(executing, "D4");
    expect(flow0(executing).edges.every((e) => e.executed)).toBe(true);
    onlyTheseChange(activated, executing, ["BURN_OR_SUPPLY_EFFECT", "VALUE_CAPTURE"], "D4");
    expect(verdicts(executing).MECHANISM_CURRENT_STATE).toBe("SUPPORTED");
  });

  it("D5. a governance APPROVED record cannot stand in for current state: filed at CURRENT_STATE it is inadmissible by class (MISSING_CURRENT_STATE), and no question moves", () => {
    const base = [...holderDocs(), govApproved()];
    const before = ask(base);
    const after = ask([...base, confirmed("CURRENT_STATE", { sourceClass: "GOVERNANCE", fragment: "the proposal passed", mechanismState: "APPROVED" })]);
    laws(after, "D5");
    expect(s5(after, "CURRENT_STATE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(after, "CURRENT_STATE").reasonCodes).toEqual(["MISSING_CURRENT_STATE"]);
    onlyTheseChange(before, after, [], "D5");
    expect(verdicts(after)).toEqual(verdicts(before));
  });

  it("D6. IMPLEMENTING is not LIVE: a fresh official 'being rolled out' establishes the current state as IMPLEMENTING and 'is it current?' is unanswered, not refuted", () => {
    const m = ask([...holderDocs(), row("CURRENT_STATE", { fragment: "the allocation is being rolled out", mechanismState: "IMPLEMENTING" })]);
    laws(m, "D6");
    nonNegative(m, "D6");
    expect(s5(m, "CURRENT_STATE").currentState).toBe("IMPLEMENTING");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ====================================================================
describe("E. documentation vs execution over one evidence world", () => {
  it("E1. official documentation describes a LIVE mechanism end to end, nothing executes: the documentary questions hold (revenue, holders), the execution component is empty, no edge is executed, the lifecycle is NOT_ESTABLISHED, the supply question is unanswered", () => {
    const m = ask([...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()], { identity: IDENTITY });
    laws(m, "E1");
    nonNegative(m, "E1");
    expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED"); // Round 7.5, M3
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(m).edges.every((e) => !e.executed)).toBe(true);
    expect(flow0(m).lifecycle).toBe("NOT_ESTABLISHED");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("E2. a docs page saying 'it executed last week' is not execution evidence: OFFICIAL_DOCS is not an establishing class for EXECUTION_EVIDENCE (MISSING_EXECUTION_EVIDENCE), and the picture is the E1 picture", () => {
    const docs = [...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()];
    const before = ask(docs, { identity: IDENTITY });
    const after = ask([...docs, row("EXECUTION_EVIDENCE", { fragment: "the distribution executed last week", mechanismState: "LIVE" })], { identity: IDENTITY });
    laws(after, "E2");
    expect(s5(after, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(after, "EXECUTION_EVIDENCE").reasonCodes).toEqual(["MISSING_EXECUTION_EVIDENCE"]);
    expect(verdicts(after)).toEqual(verdicts(before));
    expect(flow0(after).edges.every((e) => !e.executed)).toBe(true);
  });

  it("E3. deterministic execution evidence added (one bound BURN): exactly the execution-dependent readings strengthen — EXECUTION_EVIDENCE established, edges executed, NET_EFFECT at the burn rung, BURN_OR_SUPPLY_EFFECT and VALUE_CAPTURE to PARTIAL — and the current-state question does NOT move", () => {
    const docs = [...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()];
    const before = ask(docs, { identity: IDENTITY });
    const after = ask([...docs, burnExecuted()], { identity: IDENTITY });
    laws(after, "E3");
    expect(s5(after, "EXECUTION_EVIDENCE").status).toBe("SUPPORTED");
    expect(flow0(after).edges.every((e) => e.executed)).toBe(true);
    expect(verdicts(after).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
    onlyTheseChange(before, after, ["BURN_OR_SUPPLY_EFFECT", "VALUE_CAPTURE"], "E3");
    expect(verdicts(after).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(after).lifecycle).toBe("NOT_ESTABLISHED");
  });

  it("E4. 'is execution visible on-chain?': an OFFICIAL_REPORT establishes EXECUTION_EVIDENCE exactly as a chain burn does for the execution edge, but only the typed BURN reaches NET_EFFECT — the report world leaves the supply question unanswered where the burn world answers it partially", () => {
    const docs = [...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()];
    const report = ask([...docs, reportExecuted(5)], { identity: IDENTITY });
    const burn = ask([...docs, burnExecuted()], { identity: IDENTITY });
    laws(report, "E4 report");
    expect(s5(report, "EXECUTION_EVIDENCE").status).toBe("SUPPORTED");
    expect(flow0(report).edges.every((e) => e.executed)).toBe(true);
    expect(s5(report, "NET_EFFECT").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(report).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(burn).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
    onlyTheseChange(report, burn, ["BURN_OR_SUPPLY_EFFECT", "VALUE_CAPTURE"], "E4");
  });
});

// ====================================================================
describe("F. transaction vs economic role over one evidence world", () => {
  // Production-shaped chain observations: transfers, owner listings and
  // signatures are CONTEXT (a movement is never self-establishing);
  // ACCOUNT_INFO, a single balance and a supply level are SUPPORTS but
  // typed as to what they may establish.
  const txWorld = () => [
    sov(),
    chain("FLOW_PATH", { onchainFactKind: "TOKEN_TRANSFER", relationship: "CONTEXT" }),
    chain("EXECUTION_EVIDENCE", { onchainFactKind: "TOKEN_TRANSFER", relationship: "CONTEXT" }),
    chain("EXECUTION_EVIDENCE", { onchainFactKind: "TRANSACTION_DETAIL" }),
    chain("DESTINATION", { onchainFactKind: "ACCOUNT_INFO" }),
    chain("RECIPIENT", { onchainFactKind: "ACCOUNT_INFO" }),
    chain("RECIPIENT", { onchainFactKind: "TOKEN_ACCOUNTS_BY_OWNER", relationship: "CONTEXT" }),
  ];

  it("F1. a real transaction, a confirmed address, tokens moved, no source-of-value attribution: 'did tokens move?' is on the record as CONTEXT, and NO question strengthens — TRANSACTION HAPPENED != MECHANISM EXECUTED, ADDRESS EXISTS != ECONOMIC ROLE, MONEY MOVED != SOURCE OF VALUE PROVEN", () => {
    const control = ask([sov()]);
    const m = ask(txWorld());
    laws(m, "F1");
    nonNegative(m, "F1");
    expect(verdicts(m)).toEqual(verdicts(control));
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "DESTINATION").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "RECIPIENT").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "FLOW_PATH").status).toBe("INSUFFICIENT_EVIDENCE");
    const reasons = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.results.flatMap((r) => r.excludedEvidence.map((e) => e.reason)));
    // A transaction detail carries no mechanism state, so EXECUTION_EVIDENCE's
    // live-state gate refuses it before the kind gate would.
    expect(reasons).toEqual(new Set(["RELATIONSHIP_NOT_SUPPORTING", "FACT_KIND_CANNOT_ESTABLISH", "NOT_CURRENT_STATE_BEARING"]));
    expect(flow0(m).edges).toEqual([]);
    for (const i of INTENTS) for (const r of txWorld()) expect(m[i].proof.citedEvidenceIds).not.toContain(r.id);
  });

  it("F2. even mislabelled SUPPORTS, a transfer / exchange / transaction detail cannot carry EXECUTION_EVIDENCE, and an account observation cannot carry DESTINATION or RECIPIENT — the claimed buyback did not become executed, the address did not become a role", () => {
    const before = ask([sov()]);
    const m = ask([
      sov(),
      chain("EXECUTION_EVIDENCE", { onchainFactKind: "TOKEN_TRANSFER", mechanismState: "LIVE" }),
      chain("EXECUTION_EVIDENCE", { onchainFactKind: "DECODED_EXCHANGE", mechanismState: "LIVE" }),
      chain("EXECUTION_EVIDENCE", { onchainFactKind: "TRANSACTION_DETAIL", mechanismState: "LIVE" }),
      chain("DESTINATION", { onchainFactKind: "ACCOUNT_INFO" }),
      chain("RECIPIENT", { onchainFactKind: "TOKEN_ACCOUNT_BALANCE" }),
    ]);
    laws(m, "F2");
    expect(s5(m, "EXECUTION_EVIDENCE").reasonCodes).toEqual(["MISSING_EXECUTION_EVIDENCE"]);
    expect(s5(m, "DESTINATION").reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    expect(s5(m, "RECIPIENT").reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    expect(verdicts(m)).toEqual(verdicts(before));
  });

  it("F3. a single bound balance reading DOES carry DESTINATION (where the tokens are) and never RECIPIENT (who benefits): 'did protocol revenue fund it?' and 'did holders receive value?' stay unanswered while 'where did value land?' is a position — the two step-6 questions never collapse into one", () => {
    const m = ask([sov(), flowPath(), chain("DESTINATION", { onchainFactKind: "TOKEN_ACCOUNT_BALANCE" }), chain("RECIPIENT", { onchainFactKind: "TOKEN_ACCOUNT_BALANCE" })]);
    laws(m, "F3");
    nonNegative(m, "F3");
    expect(s5(m, "DESTINATION").status).toBe("SUPPORTED");
    expect(s5(m, "RECIPIENT").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(m).attributes.destinationKind).toBe("UNKNOWN");
    expect(flow0(m).attributes.recipientKind).toBe("UNKNOWN");
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("INSUFFICIENT_EVIDENCE");
    expect(req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status).toBe("PARTIAL"); // SOV documentary only
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ====================================================================
describe("G. supply consistency — every combination, every supply question", () => {
  const base = () => [...sovProven(), flowPath(), specLive(), govApproved(), csLive(), destHolders(), rcptHolders(), durability()];

  it("G1. 'what is current total supply?' vs 'did total supply change?': one reading filed at CURRENT_STATE establishes the level (no mechanism state, so 'is it current?' is NOT answered by it) and the same reading at NET_EFFECT is a limitation, not a change", () => {
    const docs = [...holderDocs(), govApproved(), durability()];
    const m = ask([...docs, csSupply(), netSupply()], { identity: IDENTITY });
    laws(m, "G1");
    nonNegative(m, "G1");
    expect(s5(m, "CURRENT_STATE").status).toBe("SUPPORTED");
    expect(s5(m, "CURRENT_STATE").currentState).toBeNull();
    expect(flow0(m).lifecycle).toBe("NOT_ESTABLISHED");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "NET_EFFECT").reasonCodes).toEqual(["SUPPLY_REDUCTION_NOT_ESTABLISHED"]);
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
  });

  it("G2. two comparable readings without a materialized delta are two levels: the supply question reads exactly as with one reading", () => {
    const one = ask([...base(), netSupply()], { identity: IDENTITY });
    const two = ask([...base(), netSupply(), netSupply()], { identity: IDENTITY });
    laws(two, "G2");
    expect(verdicts(two)).toEqual(verdicts(one));
    expect(s5(two, "NET_EFFECT").reasonCodes).toEqual(["SUPPLY_REDUCTION_NOT_ESTABLISHED"]);
    expect(s5(two, "NET_EFFECT").supportingEvidenceIds.length).toBe(2);
  });

  it("G3. the 2x2x2 of {burn, decrease, attribution-evidence}: attribution is a capability nobody has built, so no cell reaches SUPPORTED; every cell's code is the NET_EFFECT reducer's own; the refutation cell is the only negative one", () => {
    const cells: Record<string, EvidenceRow[]> = {
      "no burn, no delta": [],
      "no burn, decrease": [netDeltaDown()],
      "no burn, non-decrease": [netDeltaNotDown()],
      "burn, no delta": [burnExecuted()],
      "burn, decrease": [burnExecuted(), netDeltaDown()],
      "burn, non-decrease": [burnExecuted(), netDeltaNotDown()],
      "burn, both directions": [burnExecuted(), netDeltaDown(), netDeltaNotDown()],
    };
    const expected: Record<string, [string, string[]]> = {
      "no burn, no delta": ["INSUFFICIENT_EVIDENCE", ["NO_EVIDENCE_FOUND"]],
      "no burn, decrease": ["PARTIALLY_SUPPORTED", ["SUPPLY_REDUCTION_NOT_ESTABLISHED"]],
      // A non-decrease alone is a CONTRADICTS row with nothing to contradict:
      // it is excluded as non-supporting, never a finding.
      "no burn, non-decrease": ["INSUFFICIENT_EVIDENCE", ["ALL_EVIDENCE_EXCLUDED"]],
      "burn, no delta": ["PARTIALLY_SUPPORTED", ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]],
      "burn, decrease": ["PARTIALLY_SUPPORTED", ["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"]],
      "burn, non-decrease": ["CONTRADICTED", ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"]],
      "burn, both directions": ["PARTIALLY_SUPPORTED", ["CONFLICTING_SUPPLY_DELTA"]],
    };
    for (const [name, rows] of Object.entries(cells)) {
      const m = ask([...base(), ...rows], { identity: IDENTITY });
      laws(m, `G3 ${name}`);
      const net = s5(m, "NET_EFFECT");
      expect([net.status, net.reasonCodes], name).toEqual(expected[name]);
      expect(verdicts(m).BURN_OR_SUPPLY_EFFECT, name).toBe(net.status === "CONTRADICTED" ? "NOT_SUPPORTED" : net.status === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT_EVIDENCE" : "PARTIALLY_SUPPORTED");
      expect(m.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore, name).toBeLessThanOrEqual(40);
      // The revenue question never moves with the supply record.
      expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN, name).toBe("SUPPORTED");
      expect(verdicts(m).MECHANISM_CURRENT_STATE, name).toBe("SUPPORTED");
    }
  });

  it("G4. the approved NET_EFFECT semantics re-pinned across questions: no supply conclusion is ever stronger than its basis — burn alone < measured decrease in code only, both PARTIAL; a burn without an interval never reads as unchanged supply; a measured non-decrease refutes the NET question and keeps the burn", () => {
    const burnOnly = ask([...base(), burnExecuted()], { identity: IDENTITY });
    const measured = ask([...base(), burnExecuted(), netDeltaDown()], { identity: IDENTITY });
    const notReduced = ask([...base(), burnExecuted(), netDeltaNotDown()], { identity: IDENTITY });
    expect(verdicts(burnOnly).BURN_OR_SUPPLY_EFFECT).toBe(verdicts(measured).BURN_OR_SUPPLY_EFFECT);
    expect(burnOnly.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore).toBe(measured.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore);
    expect(s5(burnOnly, "NET_EFFECT").status).not.toBe("CONTRADICTED");
    expect(s5(notReduced, "EXECUTION_EVIDENCE").status).toBe("SUPPORTED");
    expect(notReduced.BURN_OR_SUPPLY_EFFECT.proof.citedEvidenceIds.length).toBe(1);
    expect(verdicts(notReduced).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
  });
});

// ====================================================================
describe("H. historical vs current over one evidence world", () => {
  const docs = () => [...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()];

  it("H1. historical execution proven, current execution not: 'has it ever executed?' is established (EXECUTION_EVIDENCE, executed edges), 'is it active now / executing now?' is INSUFFICIENT — never SUPPORTED, never refuted", () => {
    const m = ask([...docs(), burnExecuted()], { identity: IDENTITY });
    laws(m, "H1");
    nonNegative(m, "H1");
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("SUPPORTED");
    expect(flow0(m).edges.every((e) => e.executed)).toBe(true);
    expect(flow0(m).lifecycle).toBe("NOT_ESTABLISHED");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("H2. a stale LIVE page beside the proven execution answers nothing about now: STALE_CURRENT_STATE, the historical question unchanged, the current question still INSUFFICIENT at the bare-absence band", () => {
    const before = ask([...docs(), burnExecuted()], { identity: IDENTITY });
    const m = ask([...docs(), burnExecuted(), csLive(10)], { identity: IDENTITY });
    laws(m, "H2");
    expect(s5(m, "CURRENT_STATE").reasonCodes).toEqual(["STALE_CURRENT_STATE"]);
    expect(verdicts(m)).toEqual(verdicts(before));
    expect(m.MECHANISM_CURRENT_STATE.proof.confidenceScore).toBe(before.MECHANISM_CURRENT_STATE.proof.confidenceScore);
  });

  it("H3. fresh current-state evidence added to the historical world: only the current question strengthens, to SUPPORTED, resting on the current-state row", () => {
    const before = ask([...docs(), burnExecuted()], { identity: IDENTITY });
    const cs = csLive();
    const m = ask([...docs(), burnExecuted(), cs], { identity: IDENTITY });
    laws(m, "H3");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("SUPPORTED");
    expect(m.MECHANISM_CURRENT_STATE.proof.citedEvidenceIds).toEqual([cs.id]);
    onlyTheseChange(before, m, ["MECHANISM_CURRENT_STATE"], "H3");
  });

  it("H4. executed then paused (fresh official PAUSED): the lifecycle is HISTORICAL — 'has it executed?' yes, 'is it current?' positively refuted (NOT_SUPPORTED, TEMPORAL_SCOPE_MISMATCH, citing both the state and the execution) — and the structural questions read exactly as with the mechanism live", () => {
    const live = ask([...docs(), burnExecuted(), csLive()], { identity: IDENTITY });
    const paused = ask([...docs(), burnExecuted(), csPaused()], { identity: IDENTITY });
    laws(paused, "H4");
    expect(flow0(paused).lifecycle).toBe("HISTORICAL");
    expect(verdicts(paused).MECHANISM_CURRENT_STATE).toBe("NOT_SUPPORTED");
    expect(req(paused.MECHANISM_CURRENT_STATE, "MCS-1").reasonCodes).toEqual(["TEMPORAL_SCOPE_MISMATCH"]);
    expect(paused.MECHANISM_CURRENT_STATE.proof.citations.map((c) => c.component).sort()).toEqual(["CURRENT_STATE", "EXECUTION_EVIDENCE"]);
    onlyTheseChange(live, paused, ["MECHANISM_CURRENT_STATE"], "H4");
    expect(verdicts(paused).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    expect(verdicts(paused).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED"); // Round 7.5, M3
  });

  it("H5. a two-year-old OFFICIAL_REPORT of execution beside a fresh PAUSED page reads the same HISTORICAL picture as a chain burn would — the execution component has no freshness window (documented boundary), and only CURRENT_STATE decides 'now'", () => {
    const report = ask([...docs(), reportExecuted(700), csPaused()], { identity: IDENTITY });
    const burn = ask([...docs(), burnExecuted(), csPaused()], { identity: IDENTITY });
    laws(report, "H5");
    expect(flow0(report).lifecycle).toBe("HISTORICAL");
    expect(verdicts(report).MECHANISM_CURRENT_STATE).toBe("NOT_SUPPORTED");
    expect(verdicts(report).MECHANISM_CURRENT_STATE).toBe(verdicts(burn).MECHANISM_CURRENT_STATE);
  });

  it("H6. a chain BURN read today beside a PAUSED page published yesterday still reads HISTORICAL: a chain row's temporal basis is its READ time, not the event's, so nothing licenses 'the burn is newer than the pause' — observed, not a defect", () => {
    const m = ask([...docs(), burnExecuted(), csPaused()], { identity: IDENTITY });
    expect(s5(m, "EXECUTION_EVIDENCE").temporalBasis?.basisField).toBe("fetched_at");
    expect(new Date(s5(m, "EXECUTION_EVIDENCE").temporalBasis!.at).getTime()).toBeGreaterThan(new Date(s5(m, "CURRENT_STATE").temporalBasis!.at).getTime());
    expect(flow0(m).lifecycle).toBe("HISTORICAL");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("NOT_SUPPORTED");
  });

  it("H7. a state-less chain reading at CURRENT_STATE beside a proven execution never makes the mechanism current: 'is it current?' stays INSUFFICIENT with the level established", () => {
    const m = ask([...docs(), burnExecuted(), csSupply()], { identity: IDENTITY });
    laws(m, "H7");
    expect(s5(m, "CURRENT_STATE").status).toBe("SUPPORTED");
    expect(flow0(m).lifecycle).toBe("NOT_ESTABLISHED");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ====================================================================
describe("I. positive / negative boundaries — NOT_ESTABLISHED != CONTRADICTED", () => {
  const docs = () => [...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()];

  it("I1. 'is it active?' vs 'is it inactive?': the second is not a supported question form; the record that would answer it (a fresh official PAUSED) makes 'is it active?' INSUFFICIENT without an execution record (H6) and NOT_SUPPORTED with one — and in neither case is anything else refuted", () => {
    const noExec = ask([...docs(), csPaused()], { identity: IDENTITY });
    const withExec = ask([...docs(), burnExecuted(), csPaused()], { identity: IDENTITY });
    laws(noExec, "I1 no exec");
    laws(withExec, "I1 exec");
    expect(s5(noExec, "CURRENT_STATE").currentState).toBe("PAUSED");
    expect(verdicts(noExec).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(withExec).MECHANISM_CURRENT_STATE).toBe("NOT_SUPPORTED");
    for (const i of INTENTS) if (i !== "MECHANISM_CURRENT_STATE") expect(verdicts(withExec)[i]).not.toBe("NOT_SUPPORTED");
  });

  it("I2. absence never becomes contradiction: removing every CURRENT_STATE row, or offering only stale / undated / class-inadmissible rows, yields INSUFFICIENT_EVIDENCE for 'is it current?' with an absence code — never NOT_SUPPORTED", () => {
    const shapes: Record<string, EvidenceRow[]> = {
      none: [],
      stale: [csLive(10)],
      undated: [row("CURRENT_STATE", { fragment: "live", mechanismState: "LIVE", publishedAt: null })],
      governance: [confirmed("CURRENT_STATE", { sourceClass: "GOVERNANCE", fragment: "live", mechanismState: "LIVE" })],
      social: [row("CURRENT_STATE", { sourceClass: "SOCIAL", fragment: "live", mechanismState: "LIVE" })],
    };
    for (const [name, rows] of Object.entries(shapes)) {
      const m = ask([...docs(), burnExecuted(), ...rows], { identity: IDENTITY });
      laws(m, `I2 ${name}`);
      expect(verdicts(m).MECHANISM_CURRENT_STATE, name).toBe("INSUFFICIENT_EVIDENCE");
      expect(s5(m, "CURRENT_STATE").status, name).toBe("INSUFFICIENT_EVIDENCE");
      expect(["NO_EVIDENCE_FOUND", "STALE_CURRENT_STATE", "MISSING_CURRENT_STATE"], name).toContain(s5(m, "CURRENT_STATE").reasonCodes[0]);
      expect(m.MECHANISM_CURRENT_STATE.proof.confidenceScore, name).toBe(20);
    }
  });

  it("I3. a lone CONTRADICTS-labelled row establishes nothing: 'the mechanism is paused' labelled against the claim is excluded as non-supporting and the world reads as if the row were absent — a counter-row without a counterpart is absence, not refutation", () => {
    const absent = ask([...docs(), burnExecuted()], { identity: IDENTITY });
    const counter = ask([...docs(), burnExecuted(), row("CURRENT_STATE", { relationship: "CONTRADICTS", fragment: "the allocation is paused", mechanismState: "PAUSED" })], { identity: IDENTITY });
    laws(counter, "I3");
    expect(s5(counter, "CURRENT_STATE").reasonCodes).toEqual(["MISSING_CURRENT_STATE"]);
    expect(verdicts(counter)).toEqual(verdicts(absent));
    // The same passage labelled SUPPORTS (the state IS paused) is the
    // positive finding I1 pins: the label is not the fact, the state is.
    const supports = ask([...docs(), burnExecuted(), csPaused()], { identity: IDENTITY });
    expect(verdicts(supports).MECHANISM_CURRENT_STATE).toBe("NOT_SUPPORTED");
  });

  it("I4. 'is there evidence X does NOT happen?' has no negation semantics: 'bought back tokens are not burned' still classifies destinationKind BURN (H3), reaches no verdict, and no question reads it as either a burn or a refutation", () => {
    const negated = ask([...docs(), row("DESTINATION", { fragment: "bought back tokens are not burned; they are held" })], { identity: IDENTITY });
    const plain = ask([...docs(), destTreasury()], { identity: IDENTITY });
    laws(negated, "I4");
    nonNegative(negated, "I4");
    // Two DESTINATION rows fork the lineage; the negated one classifies BURN
    // on its branch — an accepted lexical limitation with no consumer.
    expect(negated.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows.some((f) => f.attributes.destinationKind === "BURN")).toBe(true);
    expect(verdicts(negated)).toEqual(verdicts(plain));
    expect(s5(negated, "NET_EFFECT").status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("I5. a positive recipient mismatch is the ONE attribute refutation in Pattern v1, and it is positive: 'holders' absent (UNSATISFIED) vs 'treasury' present (CONTRADICTED) are different findings with different bands", () => {
    const absent = ask([...sovProven(), flowPath(), destHolders()], { identity: IDENTITY });
    const mismatch = ask([...sovProven(), flowPath(), destHolders(), rcptTreasury()], { identity: IDENTITY });
    expect(req(absent.PASSIVE_HOLDER_OUTCOME, "PHO-1").status).toBe("UNSATISFIED");
    expect(verdicts(absent).PASSIVE_HOLDER_OUTCOME).toBe("INSUFFICIENT_EVIDENCE");
    expect(req(mismatch.PASSIVE_HOLDER_OUTCOME, "PHO-1").status).toBe("CONTRADICTED");
    expect(verdicts(mismatch).PASSIVE_HOLDER_OUTCOME).toBe("NOT_SUPPORTED");
    expect(mismatch.PASSIVE_HOLDER_OUTCOME.proof.citedEvidenceIds).toEqual(s5(mismatch, "RECIPIENT").supportingEvidenceIds);
  });
});

// ====================================================================
describe("J. Proof consistency across related questions", () => {
  const world = () => [...sovProven(), flowPath(), specLive(), govApproved(), burnExecuted(), csLive(), destHolders(), rcptHolders(), netDeltaDown(), durability()];

  it("J1. component states agree with every final claim: a SATISFIED atom rests only on established components, a CONTRADICTED atom only on a contradicted component / positive mismatch / HISTORICAL lifecycle, and every cited row is a supporting row of the component the citation names", () => {
    const worlds = [world(), [...world().filter((r) => r.component !== "NET_EFFECT"), netDeltaNotDown()], [...world().filter((r) => r.component !== "CURRENT_STATE"), csPaused()], [...world().filter((r) => r.component !== "RECIPIENT"), rcptTreasury()]];
    for (const [n, pool] of worlds.entries()) {
      const m = ask(pool, { identity: IDENTITY });
      laws(m, `J1 ${n}`);
      for (const i of INTENTS) {
        const c = m[i];
        for (const r of c.claim.requirementResults) {
          for (const k of r.provenance.componentResultKeys) {
            const s = c.byComponent.get(k.component)!;
            if (r.status === "SATISFIED" || r.status === "PARTIAL") expect(["SUPPORTED", "PARTIALLY_SUPPORTED"], `${i} ${r.requirementId} ${k.component}`).toContain(s.status);
          }
          if (r.status === "SATISFIED") for (const k of r.provenance.componentResultKeys) expect(c.byComponent.get(k.component)!.status, `${i} ${r.requirementId}`).toBe("SUPPORTED");
        }
        for (const cit of c.proof.citations) {
          const s = c.byComponent.get(cit.component)!;
          for (const id of cit.evidenceIds) expect(s.supportingEvidenceIds, `${i} cites ${id} at ${cit.component}`).toContain(id);
        }
      }
    }
  });

  it("J2. a stronger question never loses a gap its prerequisite carries: every REQUIRED blocking gap and every component-reason gap in the PRT Proof is in the VALUE_CAPTURE Proof over the same facts, and VALUE_CAPTURE's own extra gaps are NET_EFFECT's", () => {
    const pools = [world(), world().filter((r) => r.component !== "NET_EFFECT" && r.component !== "EXECUTION_EVIDENCE"), world().filter((r) => r.component !== "DESTINATION")];
    for (const [n, pool] of pools.entries()) {
      const m = ask(pool, { identity: IDENTITY });
      const key = (g: ProofDraft["gaps"][number]) => `${g.origin}|${g.kind}|${g.component}|${g.afterStep}`;
      const vc = new Set(m.VALUE_CAPTURE.proof.gaps.map(key));
      for (const g of m.PROTOCOL_REVENUE_TO_TOKEN.proof.gaps) expect(vc.has(key(g)), `${n}: VC lost ${key(g)}`).toBe(true);
      const prt = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.proof.gaps.map(key));
      for (const g of m.VALUE_CAPTURE.proof.gaps) if (!prt.has(key(g))) expect(g.component, `${n}: VC extra gap ${key(g)}`).toBe("NET_EFFECT");
    }
  });

  it("J3. excluded Evidence never becomes support in any related Proof, in either arrival order, and the exclusion record is the same for every question", () => {
    const weak = [
      row("DESTINATION", { sourceClass: "SOCIAL", fragment: "everything is burned" }),
      row("CURRENT_STATE", { sourceClass: "RESEARCH_MEDIA", fragment: "live", mechanismState: "LIVE" }),
      chain("NET_EFFECT", { onchainFactKind: "BURN", entityBinding: "UNVERIFIED" }),
      row("SOURCE_OF_VALUE", { directness: "INFERRED", fragment: "fees" }),
    ];
    const a = ask([...world(), ...weak], { identity: IDENTITY });
    const b = ask([...weak, ...world()], { identity: IDENTITY });
    for (const m of [a, b]) {
      laws(m, "J3");
      for (const i of INTENTS) for (const w of weak) expect(m[i].proof.citedEvidenceIds).not.toContain(w.id);
      for (const i of INTENTS) expect(JSON.stringify(m[i].results.map((r) => r.excludedEvidence))).toBe(JSON.stringify(m.PROTOCOL_REVENUE_TO_TOKEN.results.map((r) => r.excludedEvidence)));
    }
    expect(verdicts(a)).toEqual(verdicts(b));
  });

  it("J4. related conclusions trace to one evidence world: the union of every question's citations is a subset of S5's supporting set, S5's supporting set is a subset of the pool, and no id outside the pool appears anywhere in any Proof", () => {
    const pool = world();
    const m = ask(pool, { identity: IDENTITY });
    const ids = new Set(pool.map((r) => r.id));
    const supporting = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.results.flatMap((r) => r.supportingEvidenceIds));
    for (const id of supporting) expect(ids.has(id)).toBe(true);
    for (const i of INTENTS) {
      for (const id of m[i].proof.citedEvidenceIds) expect(supporting.has(id)).toBe(true);
      for (const c of m[i].proof.citations) for (const id of c.evidenceIds) expect(ids.has(id)).toBe(true);
      for (const r of m[i].claim.requirementResults) for (const id of r.provenance.evidenceIds) expect(ids.has(id)).toBe(true);
    }
  });

  it("J5. the Proof Map cell of every component is the persisted S5 status and nothing stronger: no question's Proof names a component as cited that S5 did not establish, and the layer-3 counts are the requirement results", () => {
    const m = ask(world(), { identity: IDENTITY });
    for (const i of INTENTS) {
      for (const c of m[i].proof.citations) expect(["SUPPORTED", "PARTIALLY_SUPPORTED"]).toContain(m[i].byComponent.get(c.component)!.status);
      const layer3 = m[i].proof.layers.layers[2].lines[0];
      const rr = m[i].claim.requirementResults;
      expect(layer3).toContain(`${rr.filter((r) => r.status === "SATISFIED").length} satisfied`);
      expect(layer3).toContain(`${rr.filter((r) => r.status === "CONTRADICTED").length} contradicted`);
      expect(m[i].proof.layers.layers[0].lines[0]).toBe(`Verdict: ${m[i].proof.verdict}.`);
    }
  });
});

// ====================================================================
describe("K. confidence consistency across related questions", () => {
  const full = () => [...sovProven(), flowPath(), specLive(), govApproved(), burnExecuted(), csLive(), destHolders(), rcptHolders(), netSupply(), durability()];

  it("K1. the band is a job-wide function of persisted component state plus the verdict ceiling and gap flags: over one world, two questions with the same verdict and the same gap flags carry the same band and the same binding reasons", () => {
    const pools = [full(), full().filter((r) => r.component !== "CURRENT_STATE"), [...full().filter((r) => r.component !== "RECIPIENT"), rcptTreasury()], buybackDocs()];
    for (const [n, pool] of pools.entries()) {
      const m = ask(pool, { identity: IDENTITY });
      const flags = (c: ChainResult) =>
        `${c.proof.verdict}|${c.claim.requirementResults.some((r) => r.optionality === "REQUIRED" && r.blockingGaps.length > 0)}|${c.claim.contextGaps.some((g) => g.kind !== "FLOW_ENUMERATION_INCOMPLETE")}`;
      for (const a of INTENTS) for (const b of INTENTS) {
        if (flags(m[a]) !== flags(m[b])) continue;
        expect(m[a].proof.confidenceScore, `${n}: ${a} vs ${b}`).toBe(m[b].proof.confidenceScore);
        expect(m[a].proof.confidenceBindingReasons, `${n}: ${a} vs ${b}`).toEqual(m[b].proof.confidenceBindingReasons);
      }
    }
  });

  it("K2. no unjustified increase for the stronger question: over 60 worlds, VALUE_CAPTURE never outranks PRT or BSE at an equal verdict, and a question whose REQUIRED atom is missing or refuted never outranks the same question with it present", () => {
    const rows = [burnExecuted, csLive, destHolders, rcptHolders, netDeltaDown, durability];
    let checked = 0;
    for (let mask = 0; mask < 1 << rows.length; mask++) {
      const pool = [...sovProven(), flowPath(), specLive(), govApproved(), ...rows.filter((_, i) => mask & (1 << i)).map((f) => f())];
      const m = ask(pool, { identity: IDENTITY });
      laws(m, `K2 ${mask}`);
      checked += 1;
    }
    expect(checked).toBe(64);
    const present = ask(full(), { identity: IDENTITY });
    const missingDest = ask(full().filter((r) => r.component !== "DESTINATION"), { identity: IDENTITY });
    expect(missingDest.PROTOCOL_REVENUE_TO_TOKEN.proof.confidenceScore).toBeLessThanOrEqual(present.PROTOCOL_REVENUE_TO_TOKEN.proof.confidenceScore);
    const refutedNet = ask([...full().filter((r) => r.component !== "NET_EFFECT"), netDeltaNotDown()], { identity: IDENTITY });
    expect(refutedNet.VALUE_CAPTURE.proof.confidenceScore).toBeLessThanOrEqual(present.VALUE_CAPTURE.proof.confidenceScore);
  });

  it("K3. excluded, technical-absence and optional-only footing never lift a band: adding excluded rows to the complete world changes no question's band; TOKEN_UTILITY's OPTIONAL recipient atom contributes nothing to its band", () => {
    const control = ask(full(), { identity: IDENTITY });
    const excluded = ask([...full(), ...ALL_COMPONENTS.map((c) => row(c, { sourceClass: "SOCIAL", fragment: "everything is great", mechanismState: "LIVE" }))], { identity: IDENTITY });
    for (const i of INTENTS) expect(excluded[i].proof.confidenceScore, i).toBe(control[i].proof.confidenceScore);
    const boundary = ask(full().filter((r) => r.component !== "GOVERNANCE_BASIS"), { identity: IDENTITY, boundaries: { GOVERNANCE_BASIS: "SEARCH_BUDGET_EXHAUSTED" } });
    const absent = ask(full().filter((r) => r.component !== "GOVERNANCE_BASIS"), { identity: IDENTITY });
    for (const i of INTENTS) expect(boundary[i].proof.confidenceScore, i).toBe(absent[i].proof.confidenceScore);
    const withoutRecipient = ask(full().filter((r) => r.component !== "RECIPIENT"), { identity: IDENTITY });
    expect(verdicts(withoutRecipient).TOKEN_UTILITY).toBe("SUPPORTED");
    expect(withoutRecipient.TOKEN_UTILITY.proof.confidenceScore).toBeLessThanOrEqual(control.TOKEN_UTILITY.proof.confidenceScore);
  });

  it("K4. observed, not a defect: under Pattern v1 no Proof of any intent exceeds LIMITED (40), because NET_EFFECT is never SUPPORTED and every one of its outcomes caps at LIMITED or LOW — the complete world sits at 40 for all eight questions", () => {
    const m = ask(full(), { identity: IDENTITY });
    for (const i of INTENTS) expect(m[i].proof.confidenceScore, i).toBe(40);
    const refuted = ask([...full().filter((r) => r.component !== "NET_EFFECT"), netDeltaNotDown()], { identity: IDENTITY });
    for (const i of INTENTS) expect(refuted[i].proof.confidenceScore, i).toBeLessThanOrEqual(40);
  });
});

// ====================================================================
describe("L. fresh holdout worlds — the full question matrix over each", () => {
  it("L-A. revenue + documented buyback, no execution", () => {
    const m = ask([...sovProven(), flowPath(), row("MECHANISM_SPEC", { fragment: "half of protocol fees buy back the token on the open market every week", mechanismState: "LIVE" }), govApproved(), destTreasury(), rcptTreasury(), durability()], { identity: IDENTITY });
    laws(m, "L-A");
    expect(verdicts(m)).toEqual({
      PROTOCOL_REVENUE_TO_TOKEN: "SUPPORTED",
      PASSIVE_HOLDER_OUTCOME: "NOT_SUPPORTED",
      REWARD_SOURCE: "SUPPORTED",
      BURN_OR_SUPPLY_EFFECT: "INSUFFICIENT_EVIDENCE",
      MECHANISM_CURRENT_STATE: "INSUFFICIENT_EVIDENCE",
      USAGE_TO_TOKEN_LINKAGE: "SUPPORTED",
      VALUE_CAPTURE: "PARTIALLY_SUPPORTED",
      TOKEN_UTILITY: "SUPPORTED",
    });
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(flow0(m).attributes.destinationKind).toBe("TREASURY");
    expect(flow0(m).edges.every((e) => !e.executed)).toBe(true);
  });

  it("L-B. executed buyback + treasury destination, no burn", () => {
    const m = ask([...sovProven(), flowPath(), row("MECHANISM_SPEC", { fragment: "half of protocol fees buy back the token on the open market every week", mechanismState: "LIVE" }), govApproved(), reportExecuted(3), csLive(), destTreasury(), rcptTreasury(), durability()], { identity: IDENTITY });
    laws(m, "L-B");
    expect(verdicts(m)).toEqual({
      PROTOCOL_REVENUE_TO_TOKEN: "SUPPORTED",
      PASSIVE_HOLDER_OUTCOME: "NOT_SUPPORTED",
      REWARD_SOURCE: "SUPPORTED",
      BURN_OR_SUPPLY_EFFECT: "INSUFFICIENT_EVIDENCE",
      MECHANISM_CURRENT_STATE: "SUPPORTED",
      USAGE_TO_TOKEN_LINKAGE: "SUPPORTED",
      VALUE_CAPTURE: "PARTIALLY_SUPPORTED",
      TOKEN_UTILITY: "SUPPORTED",
    });
    expect(flow0(m).edges.every((e) => e.executed)).toBe(true);
    expect(s5(m, "NET_EFFECT").status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("L-C. burn + negative supply delta, no attribution", () => {
    const m = ask([sov(), flowPath(), specLive(), burnExecuted(), destBurn(), netDeltaDown()]);
    laws(m, "L-C");
    expect(verdicts(m)).toEqual({
      PROTOCOL_REVENUE_TO_TOKEN: "PARTIALLY_SUPPORTED",
      PASSIVE_HOLDER_OUTCOME: "INSUFFICIENT_EVIDENCE",
      REWARD_SOURCE: "PARTIALLY_SUPPORTED",
      BURN_OR_SUPPLY_EFFECT: "PARTIALLY_SUPPORTED",
      MECHANISM_CURRENT_STATE: "INSUFFICIENT_EVIDENCE",
      USAGE_TO_TOKEN_LINKAGE: "PARTIALLY_SUPPORTED",
      VALUE_CAPTURE: "PARTIALLY_SUPPORTED",
      TOKEN_UTILITY: "PARTIALLY_SUPPORTED",
    });
    expect(s5(m, "NET_EFFECT").reasonCodes).toEqual(["NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"]);
    expect(m.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore).toBe(20);
  });

  it("L-D. governance approved, no activation", () => {
    const m = ask([...withState(holderDocs(), "APPROVED"), govApproved(), durability()]);
    laws(m, "L-D");
    nonNegative(m, "L-D");
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "GOVERNANCE_BASIS").status).toBe("SUPPORTED");
    expect(s5(m, "CURRENT_STATE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN).toBe("PARTIALLY_SUPPORTED");
    expect(verdicts(m).VALUE_CAPTURE).toBe("PARTIALLY_SUPPORTED");
    // The holder question is structural and says nothing about activation;
    // Round 7.5 (M3) bounds it at PARTIAL because the approved recipient
    // sentence names holders without linking holding to entitlement.
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    expect(flow0(m).lifecycle).toBe("NOT_ESTABLISHED");
    expect(flow0(m).edges.every((e) => !e.executed)).toBe(true);
  });

  it("L-E. transaction + confirmed address, no source-of-value attribution", () => {
    const m = ask([
      chain("FLOW_PATH", { onchainFactKind: "TOKEN_TRANSFER", relationship: "CONTEXT" }),
      chain("EXECUTION_EVIDENCE", { onchainFactKind: "TOKEN_TRANSFER", relationship: "CONTEXT" }),
      chain("DESTINATION", { onchainFactKind: "ACCOUNT_TOKEN_RELATION" }),
      chain("DESTINATION", { onchainFactKind: "TOKEN_ACCOUNT_BALANCE" }),
      chain("RECIPIENT", { onchainFactKind: "ACCOUNT_INFO" }),
    ]);
    laws(m, "L-E");
    nonNegative(m, "L-E");
    for (const i of INTENTS) expect(m[i].proof.verdict, i).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "DESTINATION").status).toBe("SUPPORTED"); // a position: where tokens are
    expect(s5(m, "SOURCE_OF_VALUE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "EXECUTION_EVIDENCE").status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5(m, "RECIPIENT").status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("L-F. historical execution, no current-state proof", () => {
    const m = ask([...sovProven(), flowPath(), specLive(), govApproved(), reportExecuted(200), destHolders(), rcptHolders(), durability()], { identity: IDENTITY });
    laws(m, "L-F");
    nonNegative(m, "L-F");
    expect(verdicts(m)).toEqual({
      PROTOCOL_REVENUE_TO_TOKEN: "SUPPORTED",
      // Round 7.5 (Founder decision M3): the recipient sentence names
      // holders and never links HOLDING to entitlement, so the holder
      // question is bounded at PARTIALLY_SUPPORTED; every other question
      // in this world is unchanged.
      PASSIVE_HOLDER_OUTCOME: "PARTIALLY_SUPPORTED",
      REWARD_SOURCE: "SUPPORTED",
      BURN_OR_SUPPLY_EFFECT: "INSUFFICIENT_EVIDENCE",
      MECHANISM_CURRENT_STATE: "INSUFFICIENT_EVIDENCE",
      USAGE_TO_TOKEN_LINKAGE: "SUPPORTED",
      VALUE_CAPTURE: "PARTIALLY_SUPPORTED",
      TOKEN_UTILITY: "SUPPORTED",
    });
    expect(flow0(m).edges.every((e) => e.executed)).toBe(true);
    expect(flow0(m).lifecycle).toBe("NOT_ESTABLISHED");
  });
});

// ====================================================================
describe("M. independent review — two questions ATLAS answers differently from the same facts, pinned as documented boundaries (Founder decision pending, no semantics invented)", () => {
  const docs = () => [...sovProven(), flowPath(), specLive(), govApproved(), destHolders(), rcptHolders(), durability()];

  it("M1. structural intents carry no lifecycle atom: a mechanism positively refuted as current (HISTORICAL) still reads 'revenue reaches the token' SUPPORTED and 'holders receive value' SUPPORTED — consistent with Pattern v1's requirement sets, pinned so a lifecycle dependency is a named decision", () => {
    const m = ask([...docs(), burnExecuted(), csPaused()], { identity: IDENTITY });
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("NOT_SUPPORTED");
    expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    // Round 7.5 (M3) bounds the holder question for its own reason; the
    // boundary M1 pins is that NEITHER question carries a lifecycle atom,
    // so a positively refuted current state still leaves them positive.
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    expect(verdicts(m).TOKEN_UTILITY).toBe("SUPPORTED");
    expect(PATTERN_V1_CONTENT.intentRequirements!.PROTOCOL_REVENUE_TO_TOKEN.requirements.every((r) => r.kind !== "LIFECYCLE")).toBe(true);
    expect(PATTERN_V1_CONTENT.intentRequirements!.PASSIVE_HOLDER_OUTCOME.requirements.every((r) => r.kind !== "LIFECYCLE")).toBe(true);
  });

  it("M2 (HALF RESOLVED, Round 7.5): the destination half now BLOCKS an atom and therefore reaches the Proof — DESTINATION_UNRESOLVED on an established destination is a REQUIREMENT_BLOCKING gap. The source half is unchanged and stays MINOR: FLOW_IDENTITY_UNRESOLVED on an established source blocks nothing and is still API-visible only", () => {
    const opaque = ask([...sovProven(), flowPath(), destOpaque()], { identity: IDENTITY });
    const f = flow0(opaque);
    expect(f.gaps.some((g) => g.kind === "DESTINATION_UNRESOLVED" && g.provenance.evidenceIds.length > 0)).toBe(true);
    // Was `false` before C4: the unresolved destination role is now on the
    // Proof's record because it is the reason PRT-2 cannot be SATISFIED.
    expect(opaque.PROTOCOL_REVENUE_TO_TOKEN.proof.gaps.some((g) => g.kind === "DESTINATION_UNRESOLVED" && g.origin === "REQUIREMENT_BLOCKING")).toBe(true);
    expect(opaque.PROTOCOL_REVENUE_TO_TOKEN.claim.contextGaps).toEqual([]);
    const vague = ask([row("SOURCE_OF_VALUE", { fragment: "the protocol earns money somehow" }), flowPath(), destHolders()]);
    expect(flow0(vague).gaps.some((g) => g.kind === "FLOW_IDENTITY_UNRESOLVED")).toBe(true);
    expect(vague.PROTOCOL_REVENUE_TO_TOKEN.proof.gaps.some((g) => g.kind === "FLOW_IDENTITY_UNRESOLVED")).toBe(false);
    // Neither is stronger than its classifiable twin — the opaque world is
    // now strictly weaker, which is the point of the decision.
    const treasury = ask([...sovProven(), flowPath(), destTreasury()], { identity: IDENTITY });
    for (const i of INTENTS) expect(VERDICT_RANK[verdicts(opaque)[i]], i).toBeLessThanOrEqual(VERDICT_RANK[verdicts(treasury)[i]]);
    expect(opaque.PROTOCOL_REVENUE_TO_TOKEN.proof.confidenceScore).toBeLessThanOrEqual(treasury.PROTOCOL_REVENUE_TO_TOKEN.proof.confidenceScore);
  });

  it("M3 (DECIDED, Round 7.5): one official sentence naming holders no longer answers 'do holders receive value?' SUPPORTED — recipient identity alone is not entitlement, so the single-atom world is bounded at PARTIALLY_SUPPORTED, and stating the holding -> entitlement relation restores it", () => {
    const bare = ask([rcptHolders()]);
    expect(verdicts(bare).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    expect(req(bare.PASSIVE_HOLDER_OUTCOME, "PHO-1").reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(verdicts(bare).PROTOCOL_REVENUE_TO_TOKEN).toBe("INSUFFICIENT_EVIDENCE");

    // The bridge, stated: the same single-atom world is SUPPORTED again.
    const entitled = ask([row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" })]);
    expect(verdicts(entitled).PASSIVE_HOLDER_OUTCOME).toBe("SUPPORTED");
    expect(entitled.PASSIVE_HOLDER_OUTCOME.proof.confidenceScore).toBe(20); // H5 band, unchanged

    // The requirement set itself is untouched CORE data — the decision is
    // a semantic qualification, not a new atom.
    expect(PATTERN_V1_CONTENT.intentRequirements!.PASSIVE_HOLDER_OUTCOME.requirements.map((r) => r.kind)).toEqual(["FLOW_ATTRIBUTE"]);
  });

  it("M4. a self-contradicting measurement record (two intervals, opposite directions) is a limitation (PARTIAL, CONFLICTING_SUPPLY_DELTA) where a self-contradicting state record is CONTRADICTED: adding a favourable interval to a refuted NET question lifts it from NOT_SUPPORTED to PARTIALLY_SUPPORTED — decided semantics (net-effect-measured-supply 14: reachable only through corruption), pinned from the cross-question angle", () => {
    const refuted = ask([...docs(), burnExecuted(), netDeltaNotDown()], { identity: IDENTITY });
    const conflicted = ask([...docs(), burnExecuted(), netDeltaNotDown(), netDeltaDown()], { identity: IDENTITY });
    expect(verdicts(refuted).BURN_OR_SUPPLY_EFFECT).toBe("NOT_SUPPORTED");
    expect(verdicts(conflicted).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
    expect(s5(conflicted, "NET_EFFECT").reasonCodes).toEqual(["CONFLICTING_SUPPLY_DELTA"]);
    expect(conflicted.BURN_OR_SUPPLY_EFFECT.proof.confidenceScore).toBeLessThanOrEqual(40);
    const stateConflict = ask([...docs(), burnExecuted(), csLive(), csPaused()], { identity: IDENTITY });
    expect(s5(stateConflict, "CURRENT_STATE").status).toBe("CONTRADICTED");
  });

  it("M5. the same TOKEN_SUPPLY observation filed at CURRENT_STATE and NET_EFFECT is two Evidence rows: it establishes the level for the first and is a limitation for the second, and neither question reads the other's answer", () => {
    const level = chain("CURRENT_STATE", { onchainFactKind: "TOKEN_SUPPLY", fragment: '{"supply":"1000"}' });
    const change = chain("NET_EFFECT", { onchainFactKind: "TOKEN_SUPPLY", fragment: '{"supply":"1000"}' });
    const m = ask([...docs(), level, change], { identity: IDENTITY });
    laws(m, "M5");
    expect(s5(m, "CURRENT_STATE").supportingEvidenceIds).toEqual([level.id]);
    expect(s5(m, "NET_EFFECT").supportingEvidenceIds).toEqual([change.id]);
    expect(verdicts(m).MECHANISM_CURRENT_STATE).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdicts(m).BURN_OR_SUPPLY_EFFECT).toBe("PARTIALLY_SUPPORTED");
    expect(m.BURN_OR_SUPPLY_EFFECT.proof.citedEvidenceIds).toEqual([change.id]);
  });
});
