import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import { evaluateClaimSupport, type ClaimSupportResult } from "../src/server/engine/claim-evaluator";
import {
  reconcileComponent,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import {
  assembleMechanism,
  type AssemblyEvidenceProjection,
  type MechanismAssemblyResult,
} from "../src/server/engine/mechanism-assembler";
import { buildProof } from "../src/server/engine/proof-builder";
import { computeProofConfidence } from "../src/server/engine/proof-confidence";
import { parseModelPublishedAt } from "../src/server/engine/providers/evidence-extractor-anthropic";

// ADVERSARIAL RESEARCH CORE V1 — the pure reducer chain under attack.
//
// Every case here runs the REAL S5 reducer over the REAL Pattern v1
// contract, feeds its output to the REAL S6 assembler, the REAL S7 claim
// evaluator and the REAL S8 proof builder, and asks one question of the
// result: did weak, wrong, stale, foreign, technical or merely documented
// evidence strengthen a conclusion it must not strengthen?
//
// The invariants under test are the product's own (CORE_RULES.md):
//   BUYBACK != BURN, BURN != NET DEFLATION, POINT-IN-TIME SUPPLY != SUPPLY
//   CHANGE, ABSENCE != EVIDENCE OF ABSENCE, DOCUMENTED != APPROVED !=
//   ACTIVATED != EXECUTING, ADDRESS EXISTS != ECONOMIC ROLE, NOT_ESTABLISHED
//   != CONTRADICTED, DISCOVERY != AUTHORITY, TECHNICAL FAILURE != PROJECT
//   REALITY. REALITY STOPS WHERE THE EVIDENCE STOPS.
//
// No database, no model, no network: these stages are pure by contract,
// so an in-memory row is exactly what production hands them.

const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_JOB = "bbbbbbbb-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
// The production defaults (src/server/config/product.ts).
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
function nextId(): string {
  seq += 1;
  return `e${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
}

function row(component: string, overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  const id = overrides.id ?? nextId();
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

function reconcile(
  component: string,
  evidence: EvidenceRow[],
  extra: { acquisitionBoundary?: "SEARCH_BUDGET_EXHAUSTED" | "NO_ADMISSIBLE_ROUTE" | null } = {},
): ComponentReconciliationResult {
  return reconcileComponent({
    jobId: JOB,
    item: { step: STEP_OF[component], component },
    requirements: { component, ...componentRequirementsFor(PATTERN_V1_CONTENT, component) },
    evidence,
    confirmedIdentity: null,
    acquisitionBoundary: extra.acquisitionBoundary ?? null,
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

// Reconcile EVERY Pattern component from one evidence pool (rows are read
// only by their own component, exactly as the store feeds the reducer),
// then run S6 -> S7 -> S8. This is the production shape end to end minus
// persistence.
function runChain(intent: string, pool: EvidenceRow[], boundaries: Record<string, "SEARCH_BUDGET_EXHAUSTED" | "NO_ADMISSIBLE_ROUTE"> = {}) {
  const results: ComponentReconciliationResult[] = ALL_COMPONENTS.map((component) =>
    reconcile(
      component,
      pool.filter((r) => r.component === component && r.patternStep === STEP_OF[component]),
      { acquisitionBoundary: boundaries[component] ?? null },
    ),
  );
  const admittedIds = new Set(results.flatMap((r) => [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds]));
  const assembly: MechanismAssemblyResult = assembleMechanism({
    researchJobId: JOB,
    patternVersion: 1,
    pattern: PATTERN_V1_CONTENT,
    contractView: { patternVersion: 1 },
    componentResults: results,
    admittedEvidence: pool.filter((r) => admittedIds.has(r.id)).map(projection),
  });
  const claim: ClaimSupportResult = evaluateClaimSupport({
    researchJobId: JOB,
    patternVersion: 1,
    pattern: PATTERN_V1_CONTENT,
    intent,
    taskType: null,
    requirementSetVersion: 1,
    assembly,
  });
  const proof = buildProof({
    researchJobId: JOB,
    claimSupport: {
      intent,
      status: claim.status,
      reasonCodes: claim.reasonCodes,
      requirementResults: claim.requirementResults,
      contextGaps: claim.contextGaps,
    },
    componentResults: results.map((r) => ({
      step: r.step,
      component: r.component,
      status: r.status,
      reasonCodes: r.reasonCodes,
      supportingEvidenceIds: r.supportingEvidenceIds,
      excludedEvidence: r.excludedEvidence,
    })),
    existingEvidenceIds: pool.map((r) => r.id),
  });
  return { results, assembly, claim, proof: proof.proof!, byComponent: new Map(results.map((r) => [r.component, r])) };
}

const exclusionOf = (r: ComponentReconciliationResult, id: string) => r.excludedEvidence.find((e) => e.evidenceId === id)?.reason ?? null;

// A coherent, fully documented mechanism: fees -> holders, everything
// CONFIRMED official docs, plus a governance approval and current state.
// The baseline the attacks below perturb.
function documentedMechanismPool(overrides: Partial<Record<string, Partial<EvidenceRow>>> = {}): EvidenceRow[] {
  const mk = (component: string, o: Partial<EvidenceRow>) => row(component, { ...o, ...(overrides[component] ?? {}) });
  return [
    mk("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users generate the revenue" }),
    mk("FLOW_PATH", { fragment: "fee revenue is routed from the fee collector to the distributor contract" }),
    mk("MECHANISM_SPEC", { fragment: "50% of protocol fees are distributed to token holders weekly", mechanismState: "LIVE" }),
    mk("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", fragment: "the proposal to distribute fees passed", mechanismState: "APPROVED" }),
    mk("CURRENT_STATE", { fragment: "the fee distribution is live", mechanismState: "LIVE" }),
    mk("DESTINATION", { fragment: "fees are distributed to token holders via the distributor" }),
    mk("RECIPIENT", { fragment: "token holders receive the distributed fees" }),
    mk("DURABILITY_BASIS", { sourceClass: "GOVERNANCE", fragment: "the distribution can be revoked by a governance vote", mechanismState: "APPROVED" }),
  ];
}

// =====================================================================
describe("A. identity and authority cannot drift at S5", () => {
  it("A1. a foreign-mint chain read (binding UNVERIFIED) establishes nothing and is never a contradiction", () => {
    const foreign = row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "UNVERIFIED", onchainFactKind: "BURN", mechanismState: "LIVE" });
    const r = reconcile("EXECUTION_EVIDENCE", [foreign]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(exclusionOf(r, foreign.id)).toBe("ENTITY_NOT_CONFIRMED");
    expect(r.reasonCodes).toEqual(["MISSING_EXECUTION_EVIDENCE"]);
    expect(r.contradictingEvidenceIds).toEqual([]);
  });

  it("A2. any number of agreeing SOCIAL rows establish nothing (DISCOVERY != AUTHORITY)", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row("MECHANISM_SPEC", { sourceClass: "SOCIAL", officiality: "CLAIMED", contentHash: `h${i}` }));
    const r = reconcile("MECHANISM_SPEC", rows);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["ALL_EVIDENCE_EXCLUDED"]);
    for (const x of rows) expect(exclusionOf(r, x.id)).toBe("CLASS_NOT_ADMISSIBLE");
  });

  it("A3. an admissible-class row with CLAIMED officiality can establish but never reach SUPPORTED", () => {
    const claimed = row("MECHANISM_SPEC", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: "LIVE" });
    const r = reconcile("MECHANISM_SPEC", [claimed]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
  });

  it("A4. a row from another job is WRONG_PROJECT, whatever it says", () => {
    const stray = row("MECHANISM_SPEC", { researchJobId: OTHER_JOB, mechanismState: "LIVE" });
    const r = reconcile("MECHANISM_SPEC", [stray]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(exclusionOf(r, stray.id)).toBe("WRONG_PROJECT");
  });

  it("A5. a row filed under another component is WRONG_COMPONENT even when its text answers this one", () => {
    const misfiled = row("DESTINATION", { fragment: "50% of protocol fees are distributed to holders" });
    const r = reconcile("MECHANISM_SPEC", [misfiled]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(exclusionOf(r, misfiled.id)).toBe("WRONG_COMPONENT");
  });

  it("A6. a legacy-contract row (version 1) is excluded before any other rule runs", () => {
    const legacy = row("MECHANISM_SPEC", { evidenceContractVersion: 1, mechanismState: "LIVE" });
    const r = reconcile("MECHANISM_SPEC", [legacy]);
    expect(exclusionOf(r, legacy.id)).toBe("LEGACY_CONTRACT_VERSION");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// =====================================================================
describe("B. economic reading of chain facts at S5 (typed, never lexical)", () => {
  it("B1. ADDRESS EXISTS != ECONOMIC ROLE: an ACCOUNT_INFO row labelled SUPPORTS cannot establish DESTINATION or RECIPIENT", () => {
    for (const component of ["DESTINATION", "RECIPIENT"]) {
      const acct = row(component, { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "ACCOUNT_INFO", fragment: "account is owned by the token program" });
      const r = reconcile(component, [acct]);
      expect(r.status, component).toBe("INSUFFICIENT_EVIDENCE");
      expect(exclusionOf(r, acct.id), component).toBe("FACT_KIND_CANNOT_ESTABLISH");
    }
  });

  it("B2. WHERE != WHO: a holding balance may establish DESTINATION but never RECIPIENT", () => {
    const bal = (component: string) => row(component, { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_ACCOUNT_BALANCE" });
    const dest = reconcile("DESTINATION", [bal("DESTINATION")]);
    expect(dest.status).toBe("PARTIALLY_SUPPORTED"); // CLAIMED by design (D-074)
    expect(dest.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
    const recip = reconcile("RECIPIENT", [bal("RECIPIENT")]);
    expect(recip.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(recip.excludedEvidence[0].reason).toBe("FACT_KIND_CANNOT_ESTABLISH");
  });

  it("B3. TRANSACTION HAPPENED != CLAIMED MECHANISM EXECUTED: TRANSACTION_DETAIL and DECODED_EXCHANGE cannot establish EXECUTION_EVIDENCE", () => {
    for (const kind of ["TRANSACTION_DETAIL", "DECODED_EXCHANGE", "RECIPROCAL_ASSET_FLOW", "TOKEN_TRANSFER"] as const) {
      const tx = row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: kind, mechanismState: "LIVE" });
      const r = reconcile("EXECUTION_EVIDENCE", [tx]);
      expect(r.status, kind).toBe("INSUFFICIENT_EVIDENCE");
      expect(exclusionOf(r, tx.id), kind).toBe("FACT_KIND_CANNOT_ESTABLISH");
    }
  });

  it("B4. POINT-IN-TIME SUPPLY != SUPPLY CHANGE: a TOKEN_SUPPLY reading at NET_EFFECT is capped, never SUPPORTED", () => {
    const supply = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_SUPPLY" });
    const r = reconcile("NET_EFFECT", [supply]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes[0]).toBe("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  });

  it("B5. BURN != NET DEFLATION: a deterministic BURN alone leaves net change unestablished", () => {
    const burn = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN" });
    const r = reconcile("NET_EFFECT", [burn]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes[0]).toBe("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  });

  it("B6. MEASUREMENT != CAUSAL ATTRIBUTION: burn + measured decrease is still not SUPPORTED", () => {
    const burn = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN" });
    const delta = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA" });
    const r = reconcile("NET_EFFECT", [burn, delta]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes[0]).toBe("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
  });

  it("B7. a delta with no burn is not a supply-reduction finding (a number about a token is not a finding about a mechanism)", () => {
    const delta = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA" });
    const r = reconcile("NET_EFFECT", [delta]);
    expect(r.status).not.toBe("SUPPORTED");
    expect(r.reasonCodes).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
  });

  it("B8. burn + measured NON-decrease contradicts the net-reduction claim but keeps the burn as support", () => {
    const burn = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN" });
    const up = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS" });
    const r = reconcile("NET_EFFECT", [burn, up]);
    expect(r.status).toBe("CONTRADICTED");
    expect(r.reasonCodes).toEqual(["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"]);
    expect(r.supportingEvidenceIds).toEqual([burn.id]);
    expect(r.contradictingEvidenceIds).toEqual([up.id]);
  });

  it("B9. BUYBACK != BURN: a purchase (TOKEN_TRANSFER / DECODED_EXCHANGE) offered for NET_EFFECT is not a supply reduction", () => {
    for (const kind of ["TOKEN_TRANSFER", "DECODED_EXCHANGE"] as const) {
      const buy = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: kind, fragment: "bought back 1,000,000 tokens and burned them" });
      const r = reconcile("NET_EFFECT", [buy]);
      expect(r.status, kind).not.toBe("SUPPORTED");
      expect(r.reasonCodes, kind).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    }
  });
});

// =====================================================================
describe("C. lifecycle: documented != approved != activated != executing", () => {
  it("C1. a governance PROPOSAL alone caps GOVERNANCE_BASIS with both lifecycle codes", () => {
    const proposal = row("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", officiality: "CONFIRMED", mechanismState: "PROPOSED" });
    const r = reconcile("GOVERNANCE_BASIS", [proposal]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["PROPOSED_STATE_ONLY", "APPROVAL_NOT_ESTABLISHED"]));
  });

  it("C2. a governance record with no stated state fails closed on approval (UNKNOWN is not APPROVED)", () => {
    const r = reconcile("GOVERNANCE_BASIS", [row("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", officiality: "CONFIRMED", mechanismState: null })]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["APPROVAL_NOT_ESTABLISHED"]);
  });

  it("C3. an official report describing a PROPOSED mechanism cannot establish EXECUTION_EVIDENCE", () => {
    const r = reconcile("EXECUTION_EVIDENCE", [row("EXECUTION_EVIDENCE", { sourceClass: "OFFICIAL_REPORT", mechanismState: "PROPOSED" })]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["MISSING_EXECUTION_EVIDENCE"]);
    expect(r.excludedEvidence[0].reason).toBe("NOT_CURRENT_STATE_BEARING");
  });

  it("C4. a mechanism spec described as PROPOSED, and nothing past it, is a proposal — PARTIAL with PROPOSED_STATE_ONLY", () => {
    const r = reconcile("MECHANISM_SPEC", [row("MECHANISM_SPEC", { mechanismState: "PROPOSED" })]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["PROPOSED_STATE_ONLY"]);
  });

  it("C5. a newer official statement that the mechanism is DEPRECATED supersedes an older LIVE one — the component reports the newer state, not the favourable one", () => {
    const older = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 2 * DAY) });
    const newer = row("CURRENT_STATE", { mechanismState: "DEPRECATED", publishedAt: new Date(NOW.getTime() - 1 * DAY) });
    const r = reconcile("CURRENT_STATE", [older, newer]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.currentState).toBe("DEPRECATED");
    expect(exclusionOf(r, older.id)).toBe("SUPERSEDED_BY_NEWER");
  });
});

// =====================================================================
describe("D. freshness and the temporal basis", () => {
  it("D1. CURRENT_STATE from a 10-day-old official page (HIGH_CHANGE = 3 days) is STALE, not current", () => {
    const stale = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 10 * DAY) });
    const r = reconcile("CURRENT_STATE", [stale]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["STALE_CURRENT_STATE"]);
  });

  it("D2. CURRENT_STATE from an undated official page has no temporal basis and cannot prove present state", () => {
    const undated = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: null });
    const r = reconcile("CURRENT_STATE", [undated]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["MISSING_CURRENT_STATE"]);
    expect(exclusionOf(r, undated.id)).toBe("MISSING_PUBLICATION_DATE");
  });

  it("D3. a publication date AFTER the fetch is impossible provenance: it must not make a row current, and must not let it supersede a genuinely dated row", () => {
    // A model hallucinates "publishedAt: tomorrow" on a page fetched today.
    const fetched = new Date(NOW.getTime() - 5 * DAY);
    const future = row("CURRENT_STATE", {
      mechanismState: "LIVE",
      fetchedAt: fetched,
      publishedAt: new Date(NOW.getTime() + 30 * DAY),
    });
    const r1 = reconcile("CURRENT_STATE", [future]);
    expect(r1.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(exclusionOf(r1, future.id)).toBe("MISSING_PUBLICATION_DATE");

    // The same impossible date offered to supersede an honestly dated row.
    const honest = row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 3 * DAY) });
    const fabricated = row("MECHANISM_SPEC", {
      mechanismState: "DEPRECATED",
      fetchedAt: fetched,
      publishedAt: new Date(NOW.getTime() + 30 * DAY),
    });
    const r2 = reconcile("MECHANISM_SPEC", [honest, fabricated]);
    // The impossible date buys no supersession: the honest row is not
    // pushed aside, and the two DIRECT statements are reported as the
    // conflict they are rather than resolved in the fabricated row's
    // favour. (At the extractor boundary the date would already be null.)
    expect(exclusionOf(r2, honest.id)).toBeNull();
    expect(r2.status).toBe("CONTRADICTED");
    expect(r2.contradictingEvidenceIds).toEqual(expect.arrayContaining([honest.id, fabricated.id]));
  });

  it("D4. an on-chain observation's temporal basis is its fetch time — a fresh chain read establishes current state (capped as CLAIMED)", () => {
    const read = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_SUPPLY", publishedAt: null, mechanismState: "LIVE" });
    const r = reconcile("CURRENT_STATE", [read]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
    expect(r.temporalBasis?.basisField).toBe("fetched_at");
  });
});

// =====================================================================
describe("E. support, counter-evidence, duplicates and absence at S5", () => {
  it("E1. an official LIVE statement and an official DEPRECATED counter-statement with no dates is a CONTRADICTION, not a choice", () => {
    const a = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: null });
    // A chain read carries fetch time as its basis; give the docs row a date
    // so the freshness gate admits both, but no ordering between them.
    const b = row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "DEPRECATED", publishedAt: null });
    const both = reconcile("CURRENT_STATE", [
      { ...a, publishedAt: new Date(NOW.getTime() - DAY) },
      { ...b, publishedAt: new Date(NOW.getTime() - DAY) },
    ]);
    expect(both.status).toBe("CONTRADICTED");
    expect(both.reasonCodes).toEqual(["CONFLICTING_STATE"]);
    expect(both.supportingEvidenceIds).toEqual([]);
    expect(both.currentState).toBeNull();
  });

  it("E2. a CONTRADICTS row with no machine-readable state can neither fabricate nor suppress a conflict", () => {
    const support = row("MECHANISM_SPEC", { mechanismState: "LIVE" });
    const vague = row("MECHANISM_SPEC", { relationship: "CONTRADICTS", mechanismState: "definitely not live" });
    const r = reconcile("MECHANISM_SPEC", [support, vague]);
    expect(r.status).toBe("SUPPORTED");
    expect(exclusionOf(r, vague.id)).toBe("RELATIONSHIP_NOT_SUPPORTING");
  });

  it("E3. the same extracted unit twice is one unit — a duplicate never becomes a second supporter", () => {
    const a = row("MECHANISM_SPEC", { extractionUnitKey: "same-unit" });
    const b = row("MECHANISM_SPEC", { extractionUnitKey: "same-unit" });
    const r = reconcile("MECHANISM_SPEC", [a, b]);
    expect(r.supportingEvidenceIds).toHaveLength(1);
    expect(r.excludedEvidence.map((e) => e.reason)).toEqual(["DUPLICATE_UNIT"]);
  });

  it("E4. INDIRECT support alone is at most partial; INFERRED establishes nothing", () => {
    const indirect = reconcile("MECHANISM_SPEC", [row("MECHANISM_SPEC", { directness: "INDIRECT" })]);
    expect(indirect.status).toBe("PARTIALLY_SUPPORTED");
    expect(indirect.reasonCodes).toEqual(["INDIRECT_ONLY"]);
    const inferred = reconcile("MECHANISM_SPEC", [row("MECHANISM_SPEC", { directness: "INFERRED" })]);
    expect(inferred.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(inferred.excludedEvidence[0].reason).toBe("DIRECTNESS_INSUFFICIENT");
  });

  it("E5. CONTEXT and LIMITS rows never establish, however authoritative", () => {
    for (const relationship of ["CONTEXT", "LIMITS"] as const) {
      const r = reconcile("MECHANISM_SPEC", [row("MECHANISM_SPEC", { relationship })]);
      expect(r.status, relationship).toBe("INSUFFICIENT_EVIDENCE");
      expect(r.excludedEvidence[0].reason, relationship).toBe("RELATIONSHIP_NOT_SUPPORTING");
    }
  });

  it("E6. a documented revenue source without machine-owned causal provenance is PARTIAL (REVENUE DOCUMENTED != SOURCE PROVEN)", () => {
    const r = reconcile("SOURCE_OF_VALUE", [row("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users generate the revenue" })]);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]);
  });

  it("E7. an exhausted search budget is a bounded-research boundary, never absence and never contradiction", () => {
    const r = reconcile("DESTINATION", [], { acquisitionBoundary: "SEARCH_BUDGET_EXHAUSTED" });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["SEARCH_BUDGET_EXHAUSTED"]);
    expect(r.contradictingEvidenceIds).toEqual([]);
  });

  it("E8. an ONCHAIN_VERIFIABLE row that is really a scraped explorer page (no kind, no binding) cannot establish", () => {
    const scraped = row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", entityBinding: "UNVERIFIED", onchainFactKind: null, mechanismState: "LIVE" });
    const r = reconcile("EXECUTION_EVIDENCE", [scraped]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(exclusionOf(r, scraped.id)).toBe("ENTITY_NOT_CONFIRMED");
  });
});

// =====================================================================
describe("F. the full chain: nothing strengthens a Proof beyond its evidence", () => {
  it("F1. a documented mechanism with no execution record: PRT is at most PARTIAL and confidence is LIMITED (DOCUMENTED != EXECUTING)", () => {
    const { claim, proof, byComponent } = runChain("PROTOCOL_REVENUE_TO_TOKEN", documentedMechanismPool());
    const execution = byComponent.get("EXECUTION_EVIDENCE")!;
    expect(execution.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(execution.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    expect(claim.status).not.toBe("SUPPORTED");
    expect(proof.verdict).toBe(claim.status);
    // Bare absence on any component is the weakest footing there is.
    expect(proof.confidenceScore).toBe(20);
    expect(proof.gaps.some((g) => g.kind === "NO_EVIDENCE_FOUND" && g.component === "EXECUTION_EVIDENCE")).toBe(true);
  });

  it("F2. NET_EFFECT partial on a supply code alone flows through S6 as a qualified attachment — a valid research outcome is never a technical failure", () => {
    // A CONFIRMED official report asserting a supply reduction: admissible
    // for NET_EFFECT, CONFIRMED (so no authority code), no typed kind (so
    // the supply gate caps it). S5 emits PARTIALLY_SUPPORTED with exactly
    // one code, and S6 must carry that, not throw.
    const pool = [
      ...documentedMechanismPool(),
      row("NET_EFFECT", { sourceClass: "OFFICIAL_REPORT", officiality: "CONFIRMED", fragment: "1,000,000 tokens were burned reducing total supply" }),
    ];
    const netEffect = reconcile("NET_EFFECT", pool.filter((r) => r.component === "NET_EFFECT"));
    expect(netEffect.status).toBe("PARTIALLY_SUPPORTED");
    expect(netEffect.reasonCodes).toEqual(["SUPPLY_REDUCTION_NOT_ESTABLISHED"]);

    const { claim, assembly } = runChain("BURN_OR_SUPPLY_EFFECT", pool);
    const flow = assembly.flows[0];
    expect(flow.netEffect?.componentStatus).toBe("PARTIALLY_SUPPORTED");
    expect(flow.netEffect?.qualifications).toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    expect(claim.status).toBe("PARTIALLY_SUPPORTED");
    expect(claim.requirementResults[0].reasonCodes).toContain("REQUIRED_PATH_PARTIAL");
  });

  it("F3. a burn-only NET_EFFECT keeps BURN_OR_SUPPLY_EFFECT partial and confidence LIMITED", () => {
    // Execution is established by the same deterministic burn, so no
    // bare-absence code masks the supply cap under test.
    const pool = [
      ...documentedMechanismPool(),
      row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" }),
      row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN" }),
    ];
    const { claim, proof } = runChain("BURN_OR_SUPPLY_EFFECT", pool);
    expect(claim.status).toBe("PARTIALLY_SUPPORTED");
    expect(proof.confidenceScore).toBeLessThanOrEqual(40);
    expect(proof.confidenceBindingReasons).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  });

  it("F4. a PARTIALLY_SUPPORTED recipient (INDIRECT only) cannot make PASSIVE_HOLDER_OUTCOME fully SUPPORTED", () => {
    const pool = documentedMechanismPool({ RECIPIENT: { directness: "INDIRECT" } });
    const { claim, byComponent } = runChain("PASSIVE_HOLDER_OUTCOME", pool);
    expect(byComponent.get("RECIPIENT")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(claim.status).not.toBe("SUPPORTED");
    expect(claim.requirementResults[0].status).toBe("PARTIAL");
  });

  it("F5. a PARTIALLY_SUPPORTED current state (CLAIMED chain read) cannot make MECHANISM_CURRENT_STATE fully SUPPORTED", () => {
    const pool = documentedMechanismPool({
      CURRENT_STATE: { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_SUPPLY", officiality: "CLAIMED", publishedAt: null, mechanismState: "LIVE" },
    });
    const { claim, byComponent, assembly } = runChain("MECHANISM_CURRENT_STATE", pool);
    expect(byComponent.get("CURRENT_STATE")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(assembly.flows[0].lifecycle).toBe("CURRENT");
    expect(claim.status).not.toBe("SUPPORTED");
    expect(claim.requirementResults[0].status).toBe("PARTIAL");
  });

  it("F6. NOT_ESTABLISHED != CONTRADICTED: a missing source of value yields INSUFFICIENT_EVIDENCE with LOW confidence, never NOT_SUPPORTED", () => {
    const pool = documentedMechanismPool().filter((r) => r.component !== "SOURCE_OF_VALUE");
    const { claim, proof } = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    expect(claim.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(proof.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(proof.confidenceScore).toBe(20);
  });

  it("F7. TECHNICAL FAILURE != PROJECT REALITY: a search budget that ran out on the required component reads as a bounded gap at LOW confidence", () => {
    const pool = documentedMechanismPool().filter((r) => r.component !== "SOURCE_OF_VALUE");
    const { claim, proof } = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool, { SOURCE_OF_VALUE: "SEARCH_BUDGET_EXHAUSTED" });
    expect(claim.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(proof.verdict).not.toBe("NOT_SUPPORTED");
    expect(proof.confidenceScore).toBe(20);
    expect(proof.gaps.some((g) => g.kind === "SEARCH_BUDGET_EXHAUSTED" && g.component === "SOURCE_OF_VALUE")).toBe(true);
  });

  it("F8. a positively contradicted required component yields NOT_SUPPORTED, and the unresolved conflict caps confidence at LIMITED", () => {
    const pool = [
      ...documentedMechanismPool({ SOURCE_OF_VALUE: { mechanismState: "LIVE", publishedAt: null } }),
      row("SOURCE_OF_VALUE", { relationship: "CONTRADICTS", mechanismState: "REMOVED", publishedAt: null, fragment: "the fee was removed" }),
    ];
    const { claim, proof, byComponent } = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    expect(byComponent.get("SOURCE_OF_VALUE")!.status).toBe("CONTRADICTED");
    expect(claim.status).toBe("NOT_SUPPORTED");
    expect(proof.confidenceScore).toBeLessThanOrEqual(40);
    expect(proof.citedEvidenceIds).not.toContain(pool[pool.length - 1].id);
  });

  it("F9. citations contain only supporting rows; excluded and contradicting rows are never cited", () => {
    const social = row("DESTINATION", { sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: "fees go to holders" });
    const pool = [...documentedMechanismPool(), social];
    const { proof, byComponent } = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    expect(exclusionOf(byComponent.get("DESTINATION")!, social.id)).toBe("CLASS_NOT_ADMISSIBLE");
    expect(proof.citedEvidenceIds).not.toContain(social.id);
    for (const id of proof.citedEvidenceIds) {
      expect(byComponent.values().some((r) => r.supportingEvidenceIds.includes(id))).toBe(true);
    }
  });

  it("F10. the confidence table is closed: an unknown reason code fails to LOW rather than being ignored", () => {
    const c = computeProofConfidence({
      verdict: "SUPPORTED",
      hasRequiredBlockingGap: false,
      hasClaimContextGap: false,
      componentResults: [{ status: "PARTIALLY_SUPPORTED", reasonCodes: ["SOME_FUTURE_CODE"] }],
    });
    expect(c.score).toBe(20);
    expect(c.bindingReasons).toEqual(["UNKNOWN_REASON_CODE"]);
  });

  it("F11. an open verdict never reaches VERY_STRONG, and a NOT_SUPPORTED verdict resting on CONFLICTING_STATE never exceeds LIMITED", () => {
    for (const verdict of ["PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"] as const) {
      const c = computeProofConfidence({ verdict, hasRequiredBlockingGap: false, hasClaimContextGap: false, componentResults: [] });
      expect(c.score, verdict).toBeLessThanOrEqual(60);
    }
    const contradicted = computeProofConfidence({
      verdict: "NOT_SUPPORTED",
      hasRequiredBlockingGap: false,
      hasClaimContextGap: false,
      componentResults: [{ status: "CONTRADICTED", reasonCodes: ["CONFLICTING_STATE"] }],
    });
    expect(contradicted.score).toBeLessThanOrEqual(40);
  });
});

// =====================================================================
describe("G. regressions from the defects this suite found", () => {
  it("G1. every supply qualification S5 can attach alone to NET_EFFECT is carried by S6 as a qualification, never rejected as 'no basis code'", () => {
    const supplyOnlyCodes = [
      "SUPPLY_REDUCTION_NOT_ESTABLISHED",
      "NET_SUPPLY_CHANGE_NOT_ESTABLISHED",
      "NET_SUPPLY_CHANGE_NOT_ATTRIBUTED",
      "CONFLICTING_SUPPLY_DELTA",
    ] as const;
    for (const code of supplyOnlyCodes) {
      const net = row("NET_EFFECT", { sourceClass: "OFFICIAL_REPORT", officiality: "CONFIRMED" });
      const results = ALL_COMPONENTS.map((component) =>
        component === "NET_EFFECT"
          ? { ...reconcile("NET_EFFECT", [net]), reasonCodes: [code] as ComponentReconciliationResult["reasonCodes"] }
          : reconcile(component, []),
      );
      const assembly = assembleMechanism({
        researchJobId: JOB,
        patternVersion: 1,
        pattern: PATTERN_V1_CONTENT,
        contractView: { patternVersion: 1 },
        componentResults: results,
        admittedEvidence: [projection(net)],
      });
      expect(assembly.flows[0].netEffect?.qualifications, code).toEqual([code]);
    }
  });

  it("G2. the extractor refuses a model publication date later than the document's fetch time, keeps every earlier one, and still refuses garbage", () => {
    const fetchedAt = new Date("2026-09-15T12:00:00.000Z");
    expect(parseModelPublishedAt("2026-09-16T00:00:00.000Z", fetchedAt)).toBeNull();
    expect(parseModelPublishedAt("2030-01-01", fetchedAt)).toBeNull();
    expect(parseModelPublishedAt("2026-09-15T12:00:00.000Z", fetchedAt)?.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    expect(parseModelPublishedAt("2024-11-21", fetchedAt)?.toISOString()).toBe("2024-11-21T00:00:00.000Z");
    expect(parseModelPublishedAt("unknown", fetchedAt)).toBeNull();
    expect(parseModelPublishedAt(null, fetchedAt)).toBeNull();
    // Without a bound (legacy callers) parseability is still the only test.
    expect(parseModelPublishedAt("2030-01-01")).not.toBeNull();
  });
});
