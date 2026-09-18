import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import { evaluateClaimSupport } from "../src/server/engine/claim-evaluator";
import {
  reconcileComponent,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  assembleMechanism,
  classifyDestinationKind,
  classifyRecipientKind,
  type AssemblyEvidenceProjection,
} from "../src/server/engine/mechanism-assembler";
import { buildProof } from "../src/server/engine/proof-builder";

// ADVERSARIAL RESEARCH CORE V1 — DOCUMENTED BOUNDARIES.
//
// Every case here PASSES against the current Core, and that is the point:
// each pins a behaviour that an adversarial reading found to sit on a
// policy line where more than one reasonable rule exists. None of them is
// a defect that engineering may fix alone (CORE_RULES.md: research
// semantics are a human decision), so instead of changing the rule the
// suite records exactly what the Core does today. If a Founder decision
// later moves the line, the failing case here is the notice.
//
// Section H = boundaries awaiting a decision. Section N = attacks that
// held and are worth keeping as regressions. Pure: no DB, no model, no
// network.

const JOB = "cccccccc-0000-4000-8000-000000000003";
const NOW = new Date("2026-09-15T12:00:00.000Z");
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

let seq = 0;
function row(component: string, overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  seq += 1;
  const id = overrides.id ?? `b${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
  const sourceClass = overrides.sourceClass ?? "OFFICIAL_DOCS";
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
    officiality: sourceClass === "OFFICIAL_DOCS" || sourceClass === "OFFICIAL_REPORT" ? "CONFIRMED" : "CLAIMED",
    entityBinding: sourceClass === "ONCHAIN_VERIFIABLE" ? "CONFIRMED" : null,
    onchainFactKind: null,
    fetchedAt: NOW,
    publishedAt: new Date(NOW.getTime() - 1 * DAY),
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

function reconcile(component: string, evidence: EvidenceRow[]): ComponentReconciliationResult {
  return reconcileComponent({
    jobId: JOB,
    item: { step: STEP_OF[component], component },
    requirements: { component, ...componentRequirementsFor(PATTERN_V1_CONTENT, component) },
    evidence,
    confirmedIdentity: null,
    now: NOW,
    freshnessPolicyDays: FRESHNESS,
  });
}

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

function runChain(intent: string, pool: EvidenceRow[]) {
  const results = ALL_COMPONENTS.map((component) =>
    reconcile(component, pool.filter((r) => r.component === component)),
  );
  const admitted = new Set(results.flatMap((r) => [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds]));
  const assembly = assembleMechanism({
    researchJobId: JOB,
    patternVersion: 1,
    pattern: PATTERN_V1_CONTENT,
    contractView: { patternVersion: 1 },
    componentResults: results,
    admittedEvidence: pool.filter((r) => admitted.has(r.id)).map(projection),
  });
  const claim = evaluateClaimSupport({
    researchJobId: JOB,
    patternVersion: 1,
    pattern: PATTERN_V1_CONTENT,
    intent,
    taskType: null,
    requirementSetVersion: 1,
    assembly,
  });
  const built = buildProof({
    researchJobId: JOB,
    claimSupport: { intent, status: claim.status, reasonCodes: claim.reasonCodes, requirementResults: claim.requirementResults, contextGaps: claim.contextGaps },
    componentResults: results.map((r) => ({ step: r.step, component: r.component, status: r.status, reasonCodes: r.reasonCodes, supportingEvidenceIds: r.supportingEvidenceIds, excludedEvidence: r.excludedEvidence })),
    existingEvidenceIds: pool.map((r) => r.id),
  });
  return { results, assembly, claim, proof: built.proof!, byComponent: new Map(results.map((r) => [r.component, r])) };
}

const exclusionOf = (r: ComponentReconciliationResult, id: string) => r.excludedEvidence.find((e) => e.evidenceId === id)?.reason ?? null;

// =====================================================================
describe("H. documented boundaries — current behaviour, Founder decision pending", () => {
  it("H1. the authority cap reads the NEWEST establishing row, not the best-authority one: a newer CLAIMED row beside an older CONFIRMED row still yields INSUFFICIENT_AUTHORITY", () => {
    // Both DIRECT SUPPORTS, both state UNKNOWN (so no supersession), the
    // CLAIMED governance row published later. The finding could rest on the
    // CONFIRMED row; the reducer caps anyway. Direction: weakening only.
    const confirmed = row("MECHANISM_SPEC", { publishedAt: new Date(NOW.getTime() - 90 * DAY) });
    const claimedNewer = row("MECHANISM_SPEC", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", publishedAt: new Date(NOW.getTime() - 2 * DAY) });
    const r = reconcile("MECHANISM_SPEC", [confirmed, claimedNewer]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
    expect(r.supportingEvidenceIds).toEqual(expect.arrayContaining([confirmed.id, claimedNewer.id]));
  });

  it("H2. a LIVE mechanism beside an undated PROPOSED record of the same component is a state CONFLICT — and a required-component conflict makes the claim NOT_SUPPORTED (at LIMITED)", () => {
    // Docs: fees are collected (LIVE). Governance forum: a fee-related
    // proposal (PROPOSED). With no dates on either, supersession cannot
    // order them and the reducer reports CONTRADICTED. Whether a proposal
    // to CHANGE a live mechanism should conflict with it is a semantics
    // decision (lifecycle progression vs. incompatibility). What the Core
    // guarantees today: the conflict is visible and confidence is capped.
    const live = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: null });
    const proposed = row("SOURCE_OF_VALUE", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: "PROPOSED", publishedAt: null });
    const pool = [
      live,
      proposed,
      row("DESTINATION", { fragment: "fees are distributed to token holders" }),
      row("RECIPIENT", { fragment: "token holders" }),
    ];
    const { byComponent, claim, proof } = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    expect(byComponent.get("SOURCE_OF_VALUE")!.status).toBe("CONTRADICTED");
    expect(claim.status).toBe("NOT_SUPPORTED");
    expect(proof.confidenceScore).toBeLessThanOrEqual(40);
    expect(proof.gaps.some((g) => g.kind === "CONFLICTING_STATE")).toBe(true);
  });

  it("H3. S6's closed lexical classifiers have no negation grammar: 'fees are NOT burned' still classifies destinationKind BURN (accepted S6 audit limitation LOW-3)", () => {
    expect(classifyDestinationKind("collected fees are not burned; they are held")).toBe("BURN");
    expect(classifyRecipientKind("no token holder receives anything")).toBe("PASSIVE_HOLDER");
  });

  it("H4. recency wins over officiality in supersession: a newer CLAIMED governance record with a state supersedes an older CONFIRMED official statement (D-093 forbids an authority ranking)", () => {
    const officialOlder = row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 30 * DAY) });
    const governanceNewer = row("MECHANISM_SPEC", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: "DEPRECATED", publishedAt: new Date(NOW.getTime() - 1 * DAY) });
    const r = reconcile("MECHANISM_SPEC", [officialOlder, governanceNewer]);
    expect(exclusionOf(r, officialOlder.id)).toBe("SUPERSEDED_BY_NEWER");
    expect(r.supportingEvidenceIds).toEqual([governanceNewer.id]);
    expect(r.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
  });

  it("H5 (DECIDED, Round 6.5): reasoned exclusion is exclusion-shaped absence and caps like absence — a SUPPORTED single-atom claim sits at LOW while every unrelated component holds only excluded (SOCIAL) evidence, exactly where it sits with those components empty", () => {
    // PASSIVE_HOLDER_OUTCOME asks only recipientKind. RECIPIENT is a
    // CONFIRMED official statement that also states the holding ->
    // entitlement bridge (Founder decision M3, Round 7.5: naming holders
    // alone no longer fully establishes the outcome, and this pin is about
    // the confidence band under exclusion, not about that bridge);
    // execution and current state are fresh
    // chain reads (CLAIMED, so STRONG cap). Every other component saw only
    // a SOCIAL page, so it is ALL_EVIDENCE_EXCLUDED — which used to cap
    // nothing (this test pinned STRONG / 60) and, by Founder decision 2
    // (2026-09-16, EXCLUDED EVIDENCE != CONFIDENCE), now caps exactly as
    // bare absence does: the control with those SOCIAL rows removed is
    // NO_EVIDENCE_FOUND on the same components, and an inadmissible
    // addition may never leave the Proof stronger than that control.
    const social = (component: string) => row(component, { sourceClass: "SOCIAL", officiality: "CLAIMED" });
    const pool = [
      row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" }),
      row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" }),
      row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_SUPPLY", mechanismState: "LIVE", publishedAt: null }),
      ...["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "GOVERNANCE_BASIS", "DESTINATION", "NET_EFFECT", "DURABILITY_BASIS"].map(social),
    ];
    const { claim, proof, byComponent } = runChain("PASSIVE_HOLDER_OUTCOME", pool);
    expect(claim.status).toBe("SUPPORTED");
    expect(byComponent.get("SOURCE_OF_VALUE")!.reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    expect(proof.confidenceScore).toBe(20);
    expect(proof.confidenceBindingReasons).toContain("ALL_EVIDENCE_EXCLUDED");
    // The unestablished components ARE on the record — as layer-6 gaps.
    expect(proof.gaps.some((g) => g.component === "SOURCE_OF_VALUE")).toBe(true);
    expect(proof.gaps.some((g) => g.component === "MECHANISM_SPEC")).toBe(true);
    // The control: the same claim with those components EMPTY.
    const control = runChain("PASSIVE_HOLDER_OUTCOME", pool.filter((r) => r.sourceClass !== "SOCIAL"));
    expect(control.claim.status).toBe("SUPPORTED");
    expect(control.proof.confidenceScore).toBe(20);
    expect(proof.citedEvidenceIds).toEqual(control.proof.citedEvidenceIds);
  });

  it("H6. an established DEPRECATED current state with no execution record is NOT_ESTABLISHED lifecycle, so 'is it current?' is INSUFFICIENT rather than answered 'no'", () => {
    const pool = [
      row("MECHANISM_SPEC", { mechanismState: "DEPRECATED" }),
      row("CURRENT_STATE", { mechanismState: "DEPRECATED", fragment: "the fee distribution was deprecated" }),
    ];
    const { assembly, claim } = runChain("MECHANISM_CURRENT_STATE", pool);
    expect(assembly.flows[0].lifecycle).toBe("NOT_ESTABLISHED");
    expect(claim.status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// =====================================================================
describe("N. attacks that held — kept as regressions", () => {
  it("N1. an attribute the text never names is absence, never incompatibility: recipient 'users' -> UNSATISFIED, not CONTRADICTED", () => {
    const pool = [
      row("RECIPIENT", { fragment: "fees are shared with active users of the platform" }),
      row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" }),
    ];
    const { claim, assembly } = runChain("PASSIVE_HOLDER_OUTCOME", pool);
    expect(assembly.flows[0].attributes.recipientKind).toBe("UNKNOWN");
    expect(claim.requirementResults[0].status).toBe("UNSATISFIED");
    expect(claim.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("N2. a positively different recipient (treasury) is a real incompatibility: NOT_SUPPORTED, and the refutation is cited in the Proof", () => {
    const treasury = row("RECIPIENT", { fragment: "all protocol fees accrue to the treasury" });
    const pool = [treasury, row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" })];
    const { claim, proof } = runChain("PASSIVE_HOLDER_OUTCOME", pool);
    expect(claim.status).toBe("NOT_SUPPORTED");
    expect(claim.reasonCodes).toContain("ACTOR_MISMATCH");
    expect(proof.citedEvidenceIds).toContain(treasury.id);
    expect(proof.citations.some((c) => c.component === "RECIPIENT")).toBe(true);
  });

  it("N2b. a SUPPORTED attribute claim cites the rows it rests on — a Proof never says 'no evidence is cited' about a verdict evidence produced", () => {
    // The recipient row states the holding -> entitlement bridge, so the
    // claim is SUPPORTED (Founder decision M3, Round 7.5) and the citation
    // this pin is about is exercised. The bare-recipient world is PARTIAL
    // and cites the same row — pinned in founder-semantics-round7-5-v1.
    const holders = row("RECIPIENT", { fragment: "token holders are entitled to a pro rata share of the distributed fees" });
    const pool = [holders, row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" })];
    const { claim, proof } = runChain("PASSIVE_HOLDER_OUTCOME", pool);
    expect(claim.status).toBe("SUPPORTED");
    expect(proof.citedEvidenceIds).toEqual([holders.id]);

    const bare = runChain("PASSIVE_HOLDER_OUTCOME", [row("RECIPIENT", { fragment: "token holders receive the distributed fees" }), ...pool.slice(1)]);
    expect(bare.claim.status).toBe("PARTIALLY_SUPPORTED");
    expect(bare.proof.citedEvidenceIds.length).toBe(1);
  });

  it("N2c. a lifecycle verdict cites CURRENT_STATE (and the execution record when HISTORICAL)", () => {
    const current = row("CURRENT_STATE", { mechanismState: "LIVE", fragment: "the fee distribution is live" });
    const live = runChain("MECHANISM_CURRENT_STATE", [current]);
    expect(live.claim.status).toBe("SUPPORTED");
    expect(live.proof.citedEvidenceIds).toEqual([current.id]);

    const executed = row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" });
    const deprecated = row("CURRENT_STATE", { mechanismState: "DEPRECATED", fragment: "the programme was deprecated" });
    const historical = runChain("MECHANISM_CURRENT_STATE", [executed, deprecated]);
    expect(historical.claim.status).toBe("NOT_SUPPORTED");
    expect(historical.proof.citedEvidenceIds).toEqual(expect.arrayContaining([executed.id, deprecated.id]));
  });

  it("N3. a lifecycle that is HISTORICAL (executed, now deprecated) positively refutes 'current' — and rests on CURRENT_STATE", () => {
    const pool = [
      row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" }),
      row("CURRENT_STATE", { mechanismState: "DEPRECATED", fragment: "the buyback programme was deprecated" }),
    ];
    const { assembly, claim } = runChain("MECHANISM_CURRENT_STATE", pool);
    expect(assembly.flows[0].lifecycle).toBe("HISTORICAL");
    expect(claim.status).toBe("NOT_SUPPORTED");
    expect(claim.requirementResults[0].reasonCodes).toEqual(["TEMPORAL_SCOPE_MISMATCH"]);
  });

  it("N4. a partial basis never softens a positive incompatibility: an INDIRECT-only treasury recipient still CONTRADICTS a passive-holder claim", () => {
    const pool = [
      row("RECIPIENT", { fragment: "all protocol fees accrue to the treasury", directness: "INDIRECT" }),
      row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" }),
    ];
    const { claim, byComponent } = runChain("PASSIVE_HOLDER_OUTCOME", pool);
    expect(byComponent.get("RECIPIENT")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(claim.requirementResults[0].status).toBe("CONTRADICTED");
  });

  it("N5. the compound VALUE_CAPTURE claim cannot be assembled from two unrelated flows (no cherry-picking across branches)", () => {
    // Two documents describe two destinations from one source: the S6 walk
    // forks DESTINATION into two branches; NET_EFFECT (burn-only, partial)
    // attaches by provenance to neither branch uniquely.
    const sov = row("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users generate the revenue" });
    const destA = row("DESTINATION", { sourceId: "doc-a", fragment: "half of the fees are distributed to token holders" });
    const destB = row("DESTINATION", { sourceId: "doc-b", fragment: "half of the fees are sent to the treasury" });
    const pool = [sov, destA, destB, row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", sourceId: "chain" })];
    const { claim, assembly } = runChain("VALUE_CAPTURE", pool);
    expect(assembly.flows.length).toBeGreaterThanOrEqual(2);
    expect(claim.status).not.toBe("SUPPORTED");
  });

  it("N6. an admitted CONTEXT chain observation for DESTINATION is neither support nor refutation — absence stays absence", () => {
    const holding = row("DESTINATION", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_ACCOUNT_BALANCE", relationship: "CONTEXT" });
    const r = reconcile("DESTINATION", [holding]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    expect(exclusionOf(r, holding.id)).toBe("RELATIONSHIP_NOT_SUPPORTING");
  });

  it("N7. the S6 assembler refuses an impossible S5 shape instead of guessing (SUPPORTED with no support)", () => {
    const bad = { ...reconcile("MECHANISM_SPEC", [row("MECHANISM_SPEC")]), supportingEvidenceIds: [] as string[] };
    expect(() =>
      assembleMechanism({
        researchJobId: JOB,
        patternVersion: 1,
        pattern: PATTERN_V1_CONTENT,
        contractView: { patternVersion: 1 },
        componentResults: [bad, ...ALL_COMPONENTS.filter((c) => c !== "MECHANISM_SPEC").map((c) => reconcile(c, []))],
        admittedEvidence: [],
      }),
    ).toThrow(/no supportingEvidenceIds/);
  });
});
