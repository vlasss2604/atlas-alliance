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

// ROUND 7.5 — FOUNDER SEMANTICS M3 AND C4.
//
// Two decisions, one shape: A COMPONENT CAN BE ESTABLISHED WHILE THE
// ECONOMIC ROLE IT MUST PLAY IS UNKNOWN, and a requirement whose meaning
// depends on that role may not be satisfied from the role-less fact.
//
//   M3  RECIPIENT = "holders" says holders received something. It does
//       not say that PASSIVE HOLDING is what entitled them. Without a
//       holding -> entitlement/receipt link, PASSIVE_HOLDER_OUTCOME must
//       not become fully established.
//
//   C4  A destination ADDRESS is a place, not an economic role. An
//       established destination whose kind S6 cannot recognise cannot
//       independently satisfy a destination-dependent requirement
//       (PRT-2 / RS-2 / UTL-2 / VC-2). WHERE != WHO.
//
// Both fail closed to PARTIAL: the component stays established, its rows
// stay admissible and cited, the limitation is a visible blocking gap,
// and SUPPORTED is unreachable. Neither weakens a recipient- or
// destination-based fact that is independently valid — a mismatch against
// a different role is still a real refutation, and existence questions
// read exactly as before.
//
// Pure: real S5 reducer, real S6 assembler, real S7 evaluator, real S8
// builder over the real Pattern v1 contract. No DB, no model, no network,
// no spend.

const JOB = "77777777-0000-4000-8000-000000000075";
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
  const id = overrides.id ?? `a${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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

// Every requirement that reached a positive or negative verdict names the
// evidence and the components it rests on; nothing is asserted from
// nowhere, and no citation is invented.
function provenanceHolds(m: Matrix, label: string): void {
  const supporting = new Set(m.PROTOCOL_REVENUE_TO_TOKEN.results.flatMap((r) => r.supportingEvidenceIds));
  for (const i of INTENTS) {
    for (const r of m[i].claim.requirementResults) {
      if (r.status === "UNSATISFIED") continue;
      expect(r.provenance.evidenceIds.length, `${label}: ${i} ${r.requirementId} ${r.status} without evidence`).toBeGreaterThan(0);
      expect(r.provenance.componentResultKeys.length, `${label}: ${i} ${r.requirementId} ${r.status} without component keys`).toBeGreaterThan(0);
      for (const k of r.provenance.componentResultKeys) expect(k.step, `${label}: ${i} ${r.requirementId} unpositioned key`).toBeGreaterThan(0);
    }
    for (const id of m[i].proof.citedEvidenceIds) expect(supporting.has(id), `${label}: ${i} cites non-supporting ${id}`).toBe(true);
  }
}

function noStrongerThan(t: Matrix, control: Matrix, label: string): void {
  for (const i of INTENTS) {
    expect(VERDICT_RANK[verdicts(t)[i]], `${label}: ${i} stronger verdict`).toBeLessThanOrEqual(VERDICT_RANK[verdicts(control)[i]]);
    if (verdicts(t)[i] === verdicts(control)[i]) {
      expect(t[i].proof.confidenceScore, `${label}: ${i} stronger band`).toBeLessThanOrEqual(control[i].proof.confidenceScore);
    }
  }
}

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
const csLive = () => row("CURRENT_STATE", { fragment: "the allocation mechanism is live", mechanismState: "LIVE" });
const destHolders = () => row("DESTINATION", { fragment: "fees are distributed to holders through the distributor" });
const destBurn = () => row("DESTINATION", { fragment: "bought back tokens are burned" });
const destOpaque = () => row("DESTINATION", { fragment: "fees are sent to the protocol multisig at 0x1234" });
const destOpaque2 = () => row("DESTINATION", { fragment: "the remainder is forwarded to contract 0xabcd on settlement" });

// RECIPIENT = holders, and nothing more. The M3 shape: who received is
// established, why holding entitled them is not.
const rcptHoldersBare = () => row("RECIPIENT", { fragment: "token holders receive the distributed fees" });
// The same recipient, with the bridge stated: holding IS the entitlement.
const rcptHoldersEntitled = () => row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" });
const rcptHoldersAutomatic = () => row("RECIPIENT", { fragment: "fees accrue to holders automatically, with no action required" });
const rcptStaker = () => row("RECIPIENT", { fragment: "stakers receive the distributed fees" });
const rcptTreasury = () => row("RECIPIENT", { fragment: "the treasury receives the bought back tokens" });
const social = (component: string) => row(component, { sourceClass: "SOCIAL", fragment: "everyone knows holders are entitled to pro rata revenue, it is sent to the treasury and burned" });

const RECIPIENT_GAP = (c: ChainResult) => flowGapsOf(c).filter((g) => g.kind === "RECIPIENT_UNRESOLVED" && g.component === "RECIPIENT");
const DESTINATION_GAP = (c: ChainResult) => flowGapsOf(c).filter((g) => g.kind === "DESTINATION_UNRESOLVED" && g.component === "DESTINATION");
const flowGapsOf = (c: ChainResult) => c.assembly.flows.flatMap((f) => f.gaps);

// ====================================================================
describe("M3 — RECIPIENT IDENTITY IS NOT ENTITLEMENT", () => {
  // The full documentary world, so nothing but the recipient sentence is
  // ever the reason a verdict moves.
  const worldWith = (rcpt: EvidenceRow) => [...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcpt];

  it("1. RECIPIENT = holders and nothing else: the recipient IS established and IS classified PASSIVE_HOLDER, and PASSIVE_HOLDER_OUTCOME still does not become fully established — PHO-1 is PARTIAL on an unresolved holding -> entitlement bridge", () => {
    const m = ask(worldWith(rcptHoldersBare()), { identity: IDENTITY });

    // Nothing about the recipient is withdrawn.
    expect(s5(m, "RECIPIENT").status).toBe("SUPPORTED");
    expect(flow0(m).attributes.recipientKind).toBe("PASSIVE_HOLDER");

    // The bridge is recorded where S6 records every unresolved role: a
    // positioned gap on an ESTABLISHED component, carrying its own rows.
    const gaps = RECIPIENT_GAP(m.PASSIVE_HOLDER_OUTCOME);
    expect(gaps.length).toBe(1);
    expect(gaps[0].afterStep).toBe(6);
    expect(gaps[0].provenance.evidenceIds.length).toBeGreaterThan(0);

    // And the claim is bounded.
    expect(verdicts(m).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    const pho = req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1");
    expect(pho.status).toBe("PARTIAL");
    expect(pho.reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(pho.blockingGaps.map((g) => g.kind)).toEqual(["RECIPIENT_UNRESOLVED"]);
    // The limitation is visible in the Proof, not only in engine state.
    expect(m.PASSIVE_HOLDER_OUTCOME.proof.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED" && g.origin === "REQUIREMENT_BLOCKING")).toBe(true);
    // Still cited: a bounded verdict is not an uncited one.
    expect(pho.provenance.evidenceIds.length).toBeGreaterThan(0);
    expect(pho.provenance.componentResultKeys).toEqual([{ step: 6, component: "RECIPIENT" }]);
    provenanceHolds(m, "M3-1");
  });

  it("2. RECIPIENT = holders WITH the holding -> entitlement relation stated ('entitled to a pro rata share', 'accrues automatically, no action required'): PASSIVE_HOLDER_OUTCOME may be established, and is", () => {
    for (const rcpt of [rcptHoldersEntitled(), rcptHoldersAutomatic()]) {
      const m = ask(worldWith(rcpt), { identity: IDENTITY });
      expect(flow0(m).attributes.recipientKind, rcpt.fragment).toBe("PASSIVE_HOLDER");
      expect(RECIPIENT_GAP(m.PASSIVE_HOLDER_OUTCOME).length, rcpt.fragment).toBe(0);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, rcpt.fragment).toBe("SUPPORTED");
      expect(req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1").status, rcpt.fragment).toBe("SATISFIED");
      expect(req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1").reasonCodes, rcpt.fragment).toEqual([]);
      provenanceHolds(m, "M3-2");
    }
  });

  it("3. non-holder recipient semantics are untouched: a staker recipient and a treasury recipient still REFUTE the holder question from recipient identity alone, and the staker still satisfies TOKEN_UTILITY's recipient atom", () => {
    for (const rcpt of [rcptStaker(), rcptTreasury()]) {
      const m = ask(worldWith(rcpt), { identity: IDENTITY });
      expect(RECIPIENT_GAP(m.PASSIVE_HOLDER_OUTCOME).length, rcpt.fragment).toBe(0);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, rcpt.fragment).toBe("NOT_SUPPORTED");
      const pho = req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1");
      expect(pho.status, rcpt.fragment).toBe("CONTRADICTED");
      expect(pho.reasonCodes, rcpt.fragment).toEqual(["ACTOR_MISMATCH"]);
      // A refutation keeps its provenance: "the recipient is X, not holders".
      expect(pho.provenance.evidenceIds.length, rcpt.fragment).toBeGreaterThan(0);
      expect(req(m.TOKEN_UTILITY, "TU-2").status, rcpt.fragment).toBe("SATISFIED");
      provenanceHolds(m, "M3-3");
    }
  });

  it("4. inadmissible evidence cannot buy the bridge: a SOCIAL post reciting the entitlement, and an entitlement sentence filed under a DIFFERENT component, both leave PASSIVE_HOLDER_OUTCOME exactly where the bare recipient leaves it", () => {
    const control = ask(worldWith(rcptHoldersBare()), { identity: IDENTITY });
    const withSocial = ask([...worldWith(rcptHoldersBare()), social("RECIPIENT")], { identity: IDENTITY });
    const elsewhere = ask(
      [...worldWith(rcptHoldersBare()), row("MECHANISM_SPEC", { fragment: "holders are entitled to a pro rata share of all protocol fees" })],
      { identity: IDENTITY },
    );
    for (const [label, m] of [["social", withSocial], ["elsewhere", elsewhere]] as const) {
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, label).toBe("PARTIALLY_SUPPORTED");
      expect(req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1").status, label).toBe("PARTIAL");
      // The gap is positioned per flow: an entitlement sentence filed under
      // another component forks the lineage, and EVERY branch still carries
      // the unresolved bridge.
      expect(m.PASSIVE_HOLDER_OUTCOME.assembly.flows.every((f) => f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED")), label).toBe(true);
      noStrongerThan(m, control, label);
      provenanceHolds(m, `M3-4-${label}`);
    }
    // The excluded social row is recorded as excluded, never cited.
    expect(withSocial.PASSIVE_HOLDER_OUTCOME.proof.citedEvidenceIds).not.toContain(social("RECIPIENT").id);
  });

  it("5. ordering and duplication are semantically inert: the same rows in reverse, and the same entitlement sentence filed five times, give the identical verdict, requirement status and band", () => {
    const bare = worldWith(rcptHoldersBare());
    const entitled = worldWith(rcptHoldersEntitled());
    const key = (m: Matrix) => JSON.stringify({ v: verdicts(m), r: INTENTS.map((i) => m[i].claim.requirementResults.map((x) => `${x.requirementId}:${x.status}:${x.reasonCodes.join("|")}`)), b: INTENTS.map((i) => m[i].proof.confidenceScore) });

    expect(key(ask([...bare].reverse(), { identity: IDENTITY }))).toBe(key(ask(bare, { identity: IDENTITY })));
    expect(key(ask([...entitled].reverse(), { identity: IDENTITY }))).toBe(key(ask(entitled, { identity: IDENTITY })));

    // Five mirrors of the ONE entitlement sentence: one truth, not five.
    const mirrors = Array.from({ length: 4 }, (_, i) =>
      row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees", contentHash: "same-entitlement", sourceId: `mirror-${i}` }),
    );
    const many = ask([...entitled, ...mirrors], { identity: IDENTITY });
    expect(verdicts(many).PASSIVE_HOLDER_OUTCOME).toBe("SUPPORTED");
    expect(req(many.PASSIVE_HOLDER_OUTCOME, "PHO-1").status).toBe("SATISFIED");
    expect(many.PASSIVE_HOLDER_OUTCOME.proof.confidenceScore).toBe(ask(entitled, { identity: IDENTITY }).PASSIVE_HOLDER_OUTCOME.proof.confidenceScore);
  });

  it("7. the bridge must be stated by ONE statement: two individually true official sentences — 'token holders receive the fees' and 'the protocol is entitled to a pro rata share' — do not compose into holder entitlement, and the same entitlement wording that DOES name holders still does", () => {
    const holders = row("RECIPIENT", { fragment: "token holders receive the distributed fees" });
    const otherActor = row("RECIPIENT", { fragment: "the protocol is entitled to a pro rata share of trading fees", sourceId: "src-other" });
    const base = [...sovProven(), flowPath(), specLive(), csLive(), destHolders()];

    // Neither sentence says holding entitles holders, so their sum does not.
    const laundered = ask([...base, holders, otherActor], { identity: IDENTITY });
    // Two recipient statements are two slots, so two flows. The branch that
    // names holders carries the unresolved bridge; the branch carrying only
    // the protocol sentence is not a passive-holder flow at all.
    const holderFlows = laundered.PASSIVE_HOLDER_OUTCOME.assembly.flows.filter((f) => f.attributes.recipientKind === "PASSIVE_HOLDER");
    expect(holderFlows.length).toBeGreaterThan(0);
    expect(holderFlows.every((f) => f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED"))).toBe(true);
    expect(verdicts(laundered).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    expect(req(laundered.PASSIVE_HOLDER_OUTCOME, "PHO-1").status).toBe("PARTIAL");

    // A row that names holders AND states the bridge still establishes it,
    // even beside the same unrelated protocol sentence.
    const genuine = ask(
      [...base, row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" }), otherActor],
      { identity: IDENTITY },
    );
    expect(genuine.PASSIVE_HOLDER_OUTCOME.assembly.flows.some((f) => f.gaps.every((g) => g.kind !== "RECIPIENT_UNRESOLVED"))).toBe(true);
    expect(verdicts(genuine).PASSIVE_HOLDER_OUTCOME).toBe("SUPPORTED");

    // And adding the unrelated sentence to the genuine world never weakens
    // it either — the gate reads statements, it does not count them.
    const alone = ask([...base, row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" })], { identity: IDENTITY });
    expect(verdicts(genuine).PASSIVE_HOLDER_OUTCOME).toBe(verdicts(alone).PASSIVE_HOLDER_OUTCOME);
  });

  it("8 (Founder review of Round 8). EXPLICIT NEGATION IS NOT THE POSITIVE BRIDGE: a row that DENIES holder entitlement leaves the bridge unresolved, exactly as a row that never mentions it does", () => {
    const control = ask(worldWith(rcptHoldersBare()), { identity: IDENTITY });
    const negations = [
      "token holders are not entitled to any share of protocol revenue",
      "token holders have no entitlement to protocol revenue",
      "there is no entitlement for token holders",
      "token holders never receive any pro rata share of the fees",
      "token holders receive no pro rata share",
      "token holders shall not, under any circumstances, be entitled to the fees",
    ];
    for (const fragment of negations) {
      const m = ask(worldWith(row("RECIPIENT", { fragment })), { identity: IDENTITY });
      // The recipient is still established and still classified: nothing
      // about WHO receives is withdrawn by this rule.
      expect(s5(m, "RECIPIENT").status, fragment).toBe("SUPPORTED");
      expect(flow0(m).attributes.recipientKind, fragment).toBe("PASSIVE_HOLDER");
      // But the positive bridge is not established.
      expect(RECIPIENT_GAP(m.PASSIVE_HOLDER_OUTCOME).length, fragment).toBe(1);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, fragment).toBe("PARTIALLY_SUPPORTED");
      expect(req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1").status, fragment).toBe("PARTIAL");
      expect(req(m.PASSIVE_HOLDER_OUTCOME, "PHO-1").reasonCodes, fragment).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
      // A denial is ABSENCE of the bridge, never a refutation of the
      // recipient: NOT_SUPPORTED would be a negation grammar, which this is
      // deliberately not (H3 is untouched).
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, fragment).not.toBe("NOT_SUPPORTED");
      // And never stronger than the bare-recipient control.
      noStrongerThan(m, control, `negation: ${fragment}`);
      provenanceHolds(m, "M3-8");
    }
  });

  it("9 (Founder review of Round 8). the negation rule is SCOPED: a denial about someone else, or in another sentence, never suppresses a real holder-entitlement statement; and within one row two clauses about two actors still compose into nothing", () => {
    // A denial elsewhere in the same row does not suppress the bridge.
    for (const fragment of [
      // A denial in its own sentence. (It deliberately names no other
      // dictionary role: a row mentioning the treasury classifies
      // recipientKind TREASURY on first-match-wins, which is the separate,
      // pre-existing rule pinned in round8 B2.)
      "fees are not charged on transfers. token holders are entitled to a pro rata share of the distributed fees.",
      "no fee is charged on transfers and token holders are entitled to a pro rata share",
      "token holders, who hold the token, are entitled to a pro rata share",
      "token holders are entitled to a pro rata share and nothing is withheld",
    ]) {
      const m = ask(worldWith(row("RECIPIENT", { fragment })), { identity: IDENTITY });
      expect(RECIPIENT_GAP(m.PASSIVE_HOLDER_OUTCOME).length, fragment).toBe(0);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, fragment).toBe("SUPPORTED");
      provenanceHolds(m, "M3-9-positive");
    }
    // Two clauses, two actors, one row: the case 7 laundering at clause
    // granularity. Neither clause carries the whole bridge.
    for (const fragment of [
      "token holders receive the distributed fees; the protocol is entitled to a pro rata share of trading fees",
      "token holders benefit from the mechanism. a pro rata share is paid to the foundation.",
    ]) {
      const m = ask(worldWith(row("RECIPIENT", { fragment })), { identity: IDENTITY });
      const holderFlows = m.PASSIVE_HOLDER_OUTCOME.assembly.flows.filter((f) => f.attributes.recipientKind === "PASSIVE_HOLDER");
      expect(holderFlows.length, fragment).toBeGreaterThan(0);
      for (const f of holderFlows) expect(f.gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED"), fragment).toBe(true);
      expect(verdicts(m).PASSIVE_HOLDER_OUTCOME, fragment).not.toBe("SUPPORTED");
      provenanceHolds(m, "M3-9-laundering");
    }
  });

  it("10 (Founder review of Round 8). the negation rule is inert to order, duplication and inadmissible evidence: a denied bridge stays denied however many times it is filed, and no SOCIAL post reciting the entitlement can lift it", () => {
    const denied = () => row("RECIPIENT", { fragment: "token holders are not entitled to any share of protocol revenue" });
    const world = worldWith(denied());
    const control = ask(world, { identity: IDENTITY });
    const key = (m: Matrix) =>
      JSON.stringify({
        v: verdicts(m),
        r: INTENTS.map((i) => m[i].claim.requirementResults.map((x) => `${x.requirementId}:${x.status}:${[...x.reasonCodes].sort().join("|")}`)),
        b: INTENTS.map((i) => m[i].proof.confidenceScore),
      });
    expect(verdicts(control).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");

    // Order.
    expect(key(ask([...world].reverse(), { identity: IDENTITY }))).toBe(key(control));
    // Duplication — five mirrors of the same denial.
    const mirrors = Array.from({ length: 4 }, (_, i) =>
      row("RECIPIENT", { fragment: "token holders are not entitled to any share of protocol revenue", contentHash: "same-denial", sourceId: `deny-${i}` }),
    );
    const many = ask([...world, ...mirrors], { identity: IDENTITY });
    expect(verdicts(many).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    expect(req(many.PASSIVE_HOLDER_OUTCOME, "PHO-1").status).toBe("PARTIAL");
    noStrongerThan(many, control, "duplicated denial");
    // Inadmissible evidence reciting the entitlement.
    const withSocial = ask([...world, social("RECIPIENT")], { identity: IDENTITY });
    expect(verdicts(withSocial).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    noStrongerThan(withSocial, control, "social entitlement post");
    provenanceHolds(withSocial, "M3-10");
  });

  it("6. conflicting recipient evidence stays fail-closed under the existing contradiction rules: an entitlement sentence beside a contradicting recipient row never reaches SUPPORTED, and never reads stronger than the entitlement world alone", () => {
    // A contradiction in ATLAS is state INCOMPATIBILITY, not a relationship
    // label (S5 MEDIUM-1): both rows must bear a normalized state, and the
    // states must differ. Asserted here so the M3 gate is shown NOT to have
    // become a second, weaker route to a contradiction.
    const live = row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees", mechanismState: "LIVE" });
    const entitled = [...sovProven(), flowPath(), specLive(), csLive(), destHolders(), live];
    const control = ask(entitled, { identity: IDENTITY });
    expect(verdicts(control).PASSIVE_HOLDER_OUTCOME).toBe("SUPPORTED");

    const conflict = ask(
      [...entitled, confirmed("RECIPIENT", { relationship: "CONTRADICTS", mechanismState: "REMOVED", fragment: "the distribution to holders was removed" })],
      { identity: IDENTITY },
    );
    expect(s5(conflict, "RECIPIENT").status).toBe("CONTRADICTED");
    expect(verdicts(conflict).PASSIVE_HOLDER_OUTCOME).not.toBe("SUPPORTED");
    noStrongerThan(conflict, control, "recipient conflict");
    provenanceHolds(conflict, "M3-6");

    // And a prose-only disagreement at no stated state still cannot
    // contradict — it is excluded as non-supporting, exactly as before M3.
    const prose = ask(
      [...entitled, confirmed("RECIPIENT", { relationship: "CONTRADICTS", fragment: "the distribution to holders was never activated" })],
      { identity: IDENTITY },
    );
    expect(s5(prose, "RECIPIENT").status).toBe("SUPPORTED");
    expect(verdicts(prose).PASSIVE_HOLDER_OUTCOME).toBe("SUPPORTED");
  });
});

// ====================================================================
describe("C4 — A DESTINATION ADDRESS IS NOT AN ECONOMIC ROLE", () => {
  const base = () => [...sovProven(), flowPath(), specLive(), csLive()];

  it("1. an ESTABLISHED destination whose kind S6 cannot recognise (a multisig address) does not satisfy the destination-dependent relationship: PRT-2 is PARTIAL on DESTINATION_UNRESOLVED and the revenue question is no longer SUPPORTED", () => {
    const m = ask([...base(), destOpaque()], { identity: IDENTITY });

    // The destination is established and its rows are admissible.
    expect(s5(m, "DESTINATION").status).toBe("SUPPORTED");
    expect(flow0(m).attributes.destinationKind).toBe("UNKNOWN");
    expect(DESTINATION_GAP(m.PROTOCOL_REVENUE_TO_TOKEN).length).toBe(1);

    const prt2 = req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2");
    expect(prt2.status).toBe("PARTIAL");
    expect(prt2.reasonCodes).toContain("REQUIRED_RELATIONSHIP_UNRESOLVED");
    expect(prt2.blockingGaps.map((g) => g.kind)).toEqual(["DESTINATION_UNRESOLVED"]);
    expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN).toBe("PARTIALLY_SUPPORTED");

    // NOT globally invalidated: the established destination rows are still
    // the atom's basis and are still cited.
    expect(prt2.provenance.componentResultKeys.map((k) => k.component)).toContain("DESTINATION");
    expect(prt2.provenance.evidenceIds.length).toBeGreaterThan(0);
    expect(m.PROTOCOL_REVENUE_TO_TOKEN.proof.gaps.some((g) => g.kind === "DESTINATION_UNRESOLVED" && g.origin === "REQUIREMENT_BLOCKING")).toBe(true);
    provenanceHolds(m, "C4-1");
  });

  it("2. a recognised destination kind is untouched: burn and holder-distribution destinations still satisfy PRT-2 and still answer the revenue question SUPPORTED", () => {
    for (const dest of [destBurn(), destHolders()]) {
      const m = ask([...base(), dest], { identity: IDENTITY });
      expect(flow0(m).attributes.destinationKind, dest.fragment).not.toBe("UNKNOWN");
      expect(DESTINATION_GAP(m.PROTOCOL_REVENUE_TO_TOKEN).length, dest.fragment).toBe(0);
      expect(req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status, dest.fragment).toBe("SATISFIED");
      expect(req(m.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").reasonCodes, dest.fragment).toEqual([]);
      expect(verdicts(m).PROTOCOL_REVENUE_TO_TOKEN, dest.fragment).toBe("SUPPORTED");
      provenanceHolds(m, "C4-2");
    }
  });

  it("3. an unresolved destination role poisons nothing else: every question that does not depend on the destination role reads exactly as it does with a recognisable destination", () => {
    const opaque = ask([...base(), destOpaque(), rcptHoldersEntitled()], { identity: IDENTITY });
    const known = ask([...base(), destHolders(), rcptHoldersEntitled()], { identity: IDENTITY });
    // Destination-dependent: PRT / RS / UTL / VC move.
    expect(verdicts(opaque).PROTOCOL_REVENUE_TO_TOKEN).toBe("PARTIALLY_SUPPORTED");
    expect(verdicts(known).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    // Destination-independent: the source atom, the recipient atom, the
    // lifecycle atom and the supply atom are byte-identical.
    // Row ids and flow ids are per-pool, so the comparison is over the
    // semantic shape: verdict, reasons, blocking gaps and the components
    // the atom rests on.
    const shape = (c: ChainResult, id: string) => {
      const r = req(c, id);
      return JSON.stringify({
        status: r.status,
        reasonCodes: r.reasonCodes,
        blockingGaps: r.blockingGaps.map((g) => `${g.kind}:${g.component}:${g.afterStep}`),
        keys: r.provenance.componentResultKeys,
        cited: r.provenance.evidenceIds.length,
      });
    };
    const same = (a: ChainResult, b: ChainResult, id: string) => expect(shape(a, id), `${id} moved`).toBe(shape(b, id));
    same(opaque.PROTOCOL_REVENUE_TO_TOKEN, known.PROTOCOL_REVENUE_TO_TOKEN, "PRT-1");
    same(opaque.PASSIVE_HOLDER_OUTCOME, known.PASSIVE_HOLDER_OUTCOME, "PHO-1");
    same(opaque.MECHANISM_CURRENT_STATE, known.MECHANISM_CURRENT_STATE, "MCS-1");
    same(opaque.BURN_OR_SUPPLY_EFFECT, known.BURN_OR_SUPPLY_EFFECT, "BSE-1");
    expect(verdicts(opaque).PASSIVE_HOLDER_OUTCOME).toBe(verdicts(known).PASSIVE_HOLDER_OUTCOME);
    expect(verdicts(opaque).MECHANISM_CURRENT_STATE).toBe(verdicts(known).MECHANISM_CURRENT_STATE);
    provenanceHolds(opaque, "C4-3");
  });

  it("4. an unknown destination never strengthens an otherwise unsupported claim: adding one to a world with no destination at all leaves every verdict no stronger", () => {
    const control = ask(base(), { identity: IDENTITY });
    const withOpaque = ask([...base(), destOpaque()], { identity: IDENTITY });
    noStrongerThan(withOpaque, control, "opaque destination added");
    // And it is not a refutation either: absence of a role is absence.
    for (const i of INTENTS) expect(verdicts(withOpaque)[i], i).not.toBe("NOT_SUPPORTED");
  });

  it("5. ordering and duplication of destination rows are semantically inert: reversed input, and two distinct opaque destination rows, give the identical claim", () => {
    const pool = [...base(), destOpaque()];
    const key = (m: Matrix) => JSON.stringify({ v: verdicts(m), r: INTENTS.map((i) => m[i].claim.requirementResults.map((x) => `${x.requirementId}:${x.status}:${x.reasonCodes.join("|")}`)) });
    expect(key(ask([...pool].reverse(), { identity: IDENTITY }))).toBe(key(ask(pool, { identity: IDENTITY })));

    const twoOpaque = ask([...base(), destOpaque(), destOpaque2()], { identity: IDENTITY });
    for (const f of twoOpaque.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows) {
      expect(f.attributes.destinationKind).toBe("UNKNOWN");
    }
    expect(req(twoOpaque.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2").status).not.toBe("SATISFIED");
    expect(verdicts(twoOpaque).PROTOCOL_REVENUE_TO_TOKEN).not.toBe("SUPPORTED");
  });

  it("6. a recognisable destination beside an unrecognisable one is TWO destinations, and the existing existential rule decides it: the classifiable flow still satisfies the atom on its own rows, the opaque flow still carries its unresolved role, and the world is never STRONGER than the classifiable one alone", () => {
    const known = ask([...base(), destHolders()], { identity: IDENTITY });
    const mixed = ask([...base(), destHolders(), destOpaque()], { identity: IDENTITY });

    // Two established destinations = two flows, one classified, one not.
    const kinds = mixed.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows.map((f) => f.attributes.destinationKind).sort();
    expect(kinds).toEqual(["DISTRIBUTION", "UNKNOWN"]);
    expect(DESTINATION_GAP(mixed.PROTOCOL_REVENUE_TO_TOKEN).length).toBe(1);

    // S7 §9/§11 (unchanged by C4): a flow that satisfies the atom is
    // sufficient regardless of what an unrelated flow shows. The atom is
    // SATISFIED, and it matches ONLY the classifiable flow — the opaque
    // destination contributes nothing and is not cited by the atom.
    const prt2 = req(mixed.PROTOCOL_REVENUE_TO_TOKEN, "PRT-2");
    expect(prt2.status).toBe("SATISFIED");
    expect(prt2.matchedFlowIds.length).toBe(1);
    const opaqueFlow = mixed.PROTOCOL_REVENUE_TO_TOKEN.assembly.flows.find((f) => f.attributes.destinationKind === "UNKNOWN")!;
    expect(prt2.matchedFlowIds).not.toContain(opaqueFlow.flowId);

    // Adding the opaque row never strengthens the world it was added to.
    noStrongerThan(mixed, known, "mixed destinations");
    provenanceHolds(mixed, "C4-6");
  });
});

// ====================================================================
describe("M3 + C4 together — the shared law", () => {
  it("an unknown role is never a known role: the two role-less worlds are each no stronger than their resolved counterpart, and the doubly role-less world is no stronger than either", () => {
    const resolved = ask([...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcptHoldersEntitled()], { identity: IDENTITY });
    const noRecipientRole = ask([...sovProven(), flowPath(), specLive(), csLive(), destHolders(), rcptHoldersBare()], { identity: IDENTITY });
    const noDestRole = ask([...sovProven(), flowPath(), specLive(), csLive(), destOpaque(), rcptHoldersEntitled()], { identity: IDENTITY });
    const neither = ask([...sovProven(), flowPath(), specLive(), csLive(), destOpaque(), rcptHoldersBare()], { identity: IDENTITY });

    noStrongerThan(noRecipientRole, resolved, "recipient role unresolved");
    noStrongerThan(noDestRole, resolved, "destination role unresolved");
    noStrongerThan(neither, noRecipientRole, "neither vs recipient-only");
    noStrongerThan(neither, noDestRole, "neither vs destination-only");

    expect(verdicts(resolved).PROTOCOL_REVENUE_TO_TOKEN).toBe("SUPPORTED");
    expect(verdicts(resolved).PASSIVE_HOLDER_OUTCOME).toBe("SUPPORTED");
    expect(verdicts(neither).PROTOCOL_REVENUE_TO_TOKEN).toBe("PARTIALLY_SUPPORTED");
    expect(verdicts(neither).PASSIVE_HOLDER_OUTCOME).toBe("PARTIALLY_SUPPORTED");
    provenanceHolds(neither, "shared");
  });
});
