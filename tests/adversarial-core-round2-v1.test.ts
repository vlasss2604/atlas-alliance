import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, componentRequirementsFor } from "../src/server/domain/pattern";
import { evaluateClaimSupport, type ClaimSupportResult } from "../src/server/engine/claim-evaluator";
import {
  reconcileComponent,
  type ComponentReconciliationResult,
  type EvidenceRow,
} from "../src/server/engine/component-reconciler";
import { assembleMechanism, type AssemblyEvidenceProjection, type MechanismAssemblyResult } from "../src/server/engine/mechanism-assembler";
import { buildProof, type ProofDraft } from "../src/server/engine/proof-builder";
import { parseModelPublishedAt } from "../src/server/engine/providers/evidence-extractor-anthropic";

// ADVERSARIAL RESEARCH CORE — ROUND 2.
//
// Round 1 attacked single conditions in each pure stage. Round 2 attacks
// INTERACTIONS and ORDER: the same Evidence in different sequences, mixed
// pools where weak rows sit beside strong ones, timestamps at the exact
// boundaries the rules read, and the S7 -> S8 traceability contract. Every
// case still runs the real S5 -> S6 -> S7 -> S8 chain over the real
// Pattern v1 data. Pure: no DB, no model, no network.
//
// Sections:
//   O  ordering — order artefacts must never change a conclusion, a
//      flow identity, a citation or a confidence band
//   M  mixed pools — weak rows beside strong rows
//   T  temporal boundaries beyond Round 1's future-date fix
//   P  provenance — every positive or partial verdict is auditable
//   X  cross-stage contracts and idempotency of the pure chain

const JOB = "dddddddd-0000-4000-8000-000000000004";
const OTHER_JOB = "eeeeeeee-0000-4000-8000-000000000005";
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
  const id = overrides.id ?? `r${String(seq).padStart(4, "0")}-0000-4000-8000-000000000000`;
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

interface ChainResult {
  results: ComponentReconciliationResult[];
  assembly: MechanismAssemblyResult;
  claim: ClaimSupportResult;
  proof: ProofDraft;
  byComponent: Map<string, ComponentReconciliationResult>;
}

function runChain(intent: string, pool: EvidenceRow[], existing: string[] = pool.map((r) => r.id)): ChainResult {
  const results = ALL_COMPONENTS.map((component) => reconcile(component, pool.filter((r) => r.component === component)));
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
    existingEvidenceIds: existing,
  });
  return { results, assembly, claim, proof: built.proof!, byComponent: new Map(results.map((r) => [r.component, r])) };
}

const exclusionOf = (r: ComponentReconciliationResult, id: string) => r.excludedEvidence.find((e) => e.evidenceId === id)?.reason ?? null;

// Deterministic permutations of a pool (rotations, reversal, interleave) —
// enough distinct orders to catch an order-dependent Map/loop without
// being a random search.
function permutations<T>(xs: T[]): T[][] {
  const out: T[][] = [xs, [...xs].reverse()];
  for (let k = 1; k < xs.length; k++) out.push([...xs.slice(k), ...xs.slice(0, k)]);
  const evens = xs.filter((_, i) => i % 2 === 0);
  const odds = xs.filter((_, i) => i % 2 === 1);
  out.push([...odds, ...evens]);
  return out;
}

// The parts of a chain result that must be order-invariant.
function semanticSnapshot(c: ChainResult) {
  return {
    s5: c.results.map((r) => ({
      c: r.component,
      status: r.status,
      reasonCodes: r.reasonCodes,
      supporting: r.supportingEvidenceIds,
      contradicting: r.contradictingEvidenceIds,
      excluded: r.excludedEvidence,
      currentState: r.currentState,
      temporalBasis: r.temporalBasis,
      tokenState: r.tokenStateMentions,
    })),
    flows: c.assembly.flows.map((f) => ({ id: f.flowId, lifecycle: f.lifecycle, shape: f.shape, attributes: f.attributes, gaps: f.gaps })),
    claim: { status: c.claim.status, reasonCodes: c.claim.reasonCodes, reqs: c.claim.requirementResults },
    proof: { verdict: c.proof.verdict, band: c.proof.confidenceBand, binding: c.proof.confidenceBindingReasons, cited: c.proof.citedEvidenceIds, gaps: c.proof.gaps },
  };
}

// A messy but realistic pool: support and counter-evidence, a superseded
// row still physically present, a duplicate unit, a newer weak row beside
// an older strong row, a stray row from another job, and a chain read.
function messyPool(): EvidenceRow[] {
  return [
    row("SOURCE_OF_VALUE", { fragment: "protocol fees paid by users generate the revenue" }),
    row("SOURCE_OF_VALUE", { sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: "fees go to holders (tweet)" }),
    row("FLOW_PATH", { fragment: "fee revenue is routed to the distributor" }),
    row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 40 * DAY) }),
    row("MECHANISM_SPEC", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 2 * DAY) }),
    row("MECHANISM_SPEC", { extractionUnitKey: "dup-unit", mechanismState: "LIVE" }),
    row("MECHANISM_SPEC", { extractionUnitKey: "dup-unit", mechanismState: "LIVE" }),
    row("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", mechanismState: "APPROVED" }),
    row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", publishedAt: null }),
    row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 2 * DAY) }),
    row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: new Date(NOW.getTime() - 1 * DAY) }),
    row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "REMOVED", publishedAt: new Date(NOW.getTime() - 10 * DAY) }),
    row("DESTINATION", { fragment: "fees are distributed to token holders via the distributor" }),
    row("DESTINATION", { researchJobId: OTHER_JOB, fragment: "fees are burned" }),
    row("RECIPIENT", { fragment: "token holders receive the distributed fees" }),
    row("RECIPIENT", { fragment: "the treasury also receives a share", directness: "INDIRECT" }),
    row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", publishedAt: null }),
    row("DURABILITY_BASIS", { sourceClass: "GOVERNANCE", mechanismState: "APPROVED" }),
  ];
}

// =====================================================================
describe("O. ordering — the same Evidence in any order is the same conclusion", () => {
  const INTENTS = ["PROTOCOL_REVENUE_TO_TOKEN", "VALUE_CAPTURE", "PASSIVE_HOLDER_OUTCOME", "MECHANISM_CURRENT_STATE", "BURN_OR_SUPPLY_EFFECT"];

  it("O1. every permutation of a messy pool yields byte-identical S5, S6 flow ids, S7 and S8 output for every intent", () => {
    const base = messyPool();
    for (const intent of INTENTS) {
      const reference = JSON.stringify(semanticSnapshot(runChain(intent, base)));
      for (const perm of permutations(base)) {
        expect(JSON.stringify(semanticSnapshot(runChain(intent, perm))), intent).toBe(reference);
      }
    }
  });

  it("O2. support-then-counterevidence and counterevidence-then-support reconcile identically, and the conflict is reported, not resolved by arrival", () => {
    const support = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - DAY) });
    const counter = row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "DEPRECATED", publishedAt: new Date(NOW.getTime() - DAY) });
    const a = reconcile("CURRENT_STATE", [support, counter]);
    const b = reconcile("CURRENT_STATE", [counter, support]);
    expect(a).toEqual(b);
    expect(a.status).toBe("CONTRADICTED");
    expect(a.contradictingEvidenceIds.sort()).toEqual([support.id, counter.id].sort());
  });

  it("O3. a superseded row physically present in any position never re-enters the establishing set", () => {
    const older = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 2 * DAY) });
    const newer = row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: new Date(NOW.getTime() - 1 * DAY) });
    const filler = row("CURRENT_STATE", { relationship: "CONTEXT", mechanismState: "LIVE" });
    for (const perm of permutations([older, newer, filler])) {
      const r = reconcile("CURRENT_STATE", perm);
      expect(exclusionOf(r, older.id)).toBe("SUPERSEDED_BY_NEWER");
      expect(r.supportingEvidenceIds).toEqual([newer.id]);
      expect(r.currentState).toBe("PAUSED");
    }
  });

  it("O4. duplicate units keep the same representative whatever the insertion order (representative chosen by the total order, not by arrival)", () => {
    const a = row("MECHANISM_SPEC", { id: "aaaa0000-0000-4000-8000-000000000001", extractionUnitKey: "same", contentHash: "h-a" });
    const b = row("MECHANISM_SPEC", { id: "bbbb0000-0000-4000-8000-000000000002", extractionUnitKey: "same", contentHash: "h-b" });
    const first = reconcile("MECHANISM_SPEC", [a, b]);
    const second = reconcile("MECHANISM_SPEC", [b, a]);
    expect(first.supportingEvidenceIds).toEqual(second.supportingEvidenceIds);
    expect(first.excludedEvidence).toEqual(second.excludedEvidence);
  });

  it("O5. S6 slot identity and flow ids do not depend on the order S5 listed the supporting ids", () => {
    const pool = messyPool();
    const base = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    // Reverse every supporting list before assembly — a store that returned
    // rows in another order must not change the flow's identity.
    const reversed = base.results.map((r) => ({ ...r, supportingEvidenceIds: [...r.supportingEvidenceIds].reverse() }));
    const admitted = new Set(reversed.flatMap((r) => [...r.supportingEvidenceIds, ...r.contradictingEvidenceIds]));
    const assembly = assembleMechanism({
      researchJobId: JOB,
      patternVersion: 1,
      pattern: PATTERN_V1_CONTENT,
      contractView: { patternVersion: 1 },
      componentResults: reversed,
      admittedEvidence: [...pool.filter((r) => admitted.has(r.id)).map(projection)].reverse(),
    });
    expect(assembly.flows.map((f) => f.flowId)).toEqual(base.assembly.flows.map((f) => f.flowId));
  });
});

// =====================================================================
describe("M. mixed pools — weak rows beside strong rows", () => {
  it("M1. valid support beside every kind of invalid support: the strong row alone establishes, nothing degrades it, and every weak row is excluded with its own reason", () => {
    const strong = row("MECHANISM_SPEC", { mechanismState: "LIVE" });
    const social = row("MECHANISM_SPEC", { sourceClass: "SOCIAL", officiality: "CLAIMED", mechanismState: "LIVE" });
    const inferred = row("MECHANISM_SPEC", { directness: "INFERRED", mechanismState: "LIVE" });
    const context = row("MECHANISM_SPEC", { relationship: "CONTEXT", mechanismState: "LIVE" });
    const stray = row("MECHANISM_SPEC", { researchJobId: OTHER_JOB, mechanismState: "LIVE" });
    const legacy = row("MECHANISM_SPEC", { evidenceContractVersion: 1, mechanismState: "LIVE" });
    const r = reconcile("MECHANISM_SPEC", [social, inferred, strong, context, stray, legacy]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).toEqual([]);
    expect(r.supportingEvidenceIds).toEqual([strong.id]);
    expect(exclusionOf(r, social.id)).toBe("CLASS_NOT_ADMISSIBLE");
    expect(exclusionOf(r, inferred.id)).toBe("DIRECTNESS_INSUFFICIENT");
    expect(exclusionOf(r, context.id)).toBe("RELATIONSHIP_NOT_SUPPORTING");
    expect(exclusionOf(r, stray.id)).toBe("WRONG_PROJECT");
    expect(exclusionOf(r, legacy.id)).toBe("LEGACY_CONTRACT_VERSION");
  });

  it("M2. DIRECT beside INDIRECT: both support, INDIRECT_ONLY is not raised, and the indirect row cannot become the state basis over the direct one", () => {
    const direct = row("CURRENT_STATE", { mechanismState: "LIVE" });
    const indirect = row("CURRENT_STATE", { directness: "INDIRECT", mechanismState: "LIVE" });
    const r = reconcile("CURRENT_STATE", [indirect, direct]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).toEqual([]);
    expect(r.supportingEvidenceIds.sort()).toEqual([direct.id, indirect.id].sort());
  });

  it("M3. CONFIRMED beside CLAIMED with EQUAL dates: the class tie-break puts the confirmed row first, so no authority cap is raised", () => {
    const at = new Date(NOW.getTime() - 3 * DAY);
    const confirmed = row("MECHANISM_SPEC", { publishedAt: at });
    const claimed = row("MECHANISM_SPEC", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", publishedAt: at });
    const r = reconcile("MECHANISM_SPEC", [claimed, confirmed]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).toEqual([]);
  });

  it("M4. current beside stale for CURRENT_STATE: the stale row is excluded and only the current one carries state", () => {
    const stale = row("CURRENT_STATE", { mechanismState: "DEPRECATED", publishedAt: new Date(NOW.getTime() - 30 * DAY) });
    const current = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 1 * DAY) });
    const r = reconcile("CURRENT_STATE", [stale, current]);
    // Two honest reasons apply (it is stale, and the newer row supersedes
    // it); supersession is recorded first. Either way it is out.
    expect(["STALE_FOR_CURRENT_STATE", "SUPERSEDED_BY_NEWER"]).toContain(exclusionOf(r, stale.id));
    expect(r.supportingEvidenceIds).toEqual([current.id]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.currentState).toBe("LIVE");
  });

  it("M5. a chain supply read (no stated state) beside a documented DEPRECATED state cannot override it: the component reports DEPRECATED", () => {
    const docs = row("CURRENT_STATE", { mechanismState: "DEPRECATED", publishedAt: new Date(NOW.getTime() - 1 * DAY) });
    const chain = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_SUPPLY", mechanismState: null, publishedAt: null });
    const r = reconcile("CURRENT_STATE", [chain, docs]);
    expect(r.status).toBe("SUPPORTED");
    expect(r.currentState).toBe("DEPRECATED");
    expect(exclusionOf(r, docs.id)).toBeNull();
  });

  it("M6. an unbound chain read beside a bound one: only the bound row establishes, and the foreign one is not silently merged", () => {
    const bound = row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE" });
    const foreign = row("EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", mechanismState: "LIVE", entityBinding: "UNVERIFIED" });
    const r = reconcile("EXECUTION_EVIDENCE", [foreign, bound]);
    expect(r.supportingEvidenceIds).toEqual([bound.id]);
    expect(exclusionOf(r, foreign.id)).toBe("ENTITY_NOT_CONFIRMED");
  });

  it("M7. many weak rows never outvote one strong contradicting row: a DIRECT official counter-statement still produces CONTRADICTED", () => {
    const supports = Array.from({ length: 5 }, (_, i) => row("CURRENT_STATE", { mechanismState: "LIVE", contentHash: `w${i}`, publishedAt: new Date(NOW.getTime() - DAY) }));
    const counter = row("CURRENT_STATE", { relationship: "CONTRADICTS", mechanismState: "REMOVED", publishedAt: new Date(NOW.getTime() - DAY) });
    const r = reconcile("CURRENT_STATE", [...supports, counter]);
    expect(r.status).toBe("CONTRADICTED");
  });
});

// =====================================================================
describe("T. temporal boundaries", () => {
  it("T1. publishedAt equal to fetchedAt is a valid basis; one millisecond later is not", () => {
    const equal = row("CURRENT_STATE", { mechanismState: "LIVE", fetchedAt: NOW, publishedAt: NOW });
    expect(reconcile("CURRENT_STATE", [equal]).status).toBe("SUPPORTED");
    const later = row("CURRENT_STATE", { mechanismState: "LIVE", fetchedAt: NOW, publishedAt: new Date(NOW.getTime() + 1) });
    const r = reconcile("CURRENT_STATE", [later]);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(exclusionOf(r, later.id)).toBe("MISSING_PUBLICATION_DATE");
    expect(parseModelPublishedAt(NOW.toISOString(), NOW)).not.toBeNull();
    expect(parseModelPublishedAt(new Date(NOW.getTime() + 1).toISOString(), NOW)).toBeNull();
  });

  it("T2. equal timestamps never supersede: agreeing rows both establish; disagreeing rows are a conflict, never a silent pick", () => {
    const at = new Date(NOW.getTime() - DAY);
    const a = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: at });
    const b = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: at });
    const agree = reconcile("CURRENT_STATE", [a, b]);
    expect(agree.supportingEvidenceIds.sort()).toEqual([a.id, b.id].sort());
    const c = row("CURRENT_STATE", { mechanismState: "PAUSED", publishedAt: at });
    const disagree = reconcile("CURRENT_STATE", [a, c]);
    expect(disagree.status).toBe("CONTRADICTED");
    expect(disagree.excludedEvidence.map((e) => e.reason)).not.toContain("SUPERSEDED_BY_NEWER");
  });

  it("T3. an undated row can neither supersede nor be superseded: beside a dated row it stays in the pool, and a state disagreement between them is reported", () => {
    const dated = row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - DAY) });
    const undated = row("MECHANISM_SPEC", { sourceClass: "GOVERNANCE", officiality: "CLAIMED", mechanismState: "DEPRECATED", publishedAt: null });
    const r = reconcile("MECHANISM_SPEC", [dated, undated]);
    expect(r.excludedEvidence.map((e) => e.reason)).not.toContain("SUPERSEDED_BY_NEWER");
    expect(r.status).toBe("CONTRADICTED");
  });

  it("T4. a stale but authoritative CURRENT_STATE row cannot be rescued by a fresh weak one: the fresh INDIRECT row establishes only partially and the stale row stays excluded", () => {
    const staleStrong = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 20 * DAY) });
    const freshWeak = row("CURRENT_STATE", { mechanismState: "LIVE", directness: "INDIRECT", publishedAt: new Date(NOW.getTime() - DAY) });
    const r = reconcile("CURRENT_STATE", [staleStrong, freshWeak]);
    expect(exclusionOf(r, staleStrong.id)).toBe("STALE_FOR_CURRENT_STATE");
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("INDIRECT_ONLY");
  });

  it("T5. supersession needs a strictly newer, fully establishing row: a newer CONTEXT or INDIRECT row supersedes nothing", () => {
    const older = row("CURRENT_STATE", { mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 2 * DAY) });
    const newerContext = row("CURRENT_STATE", { relationship: "CONTEXT", mechanismState: "REMOVED", publishedAt: new Date(NOW.getTime() - DAY) });
    const newerIndirect = row("CURRENT_STATE", { directness: "INDIRECT", mechanismState: "REMOVED", publishedAt: new Date(NOW.getTime() - DAY) });
    for (const weak of [newerContext, newerIndirect]) {
      const r = reconcile("CURRENT_STATE", [older, weak]);
      expect(exclusionOf(r, older.id), weak.relationship + weak.directness).toBeNull();
      expect(r.supportingEvidenceIds, weak.relationship + weak.directness).toContain(older.id);
    }
  });

  it("T6. a chain read fetched in the future relative to `now` is not a negative-age loophole for staleness — it is accepted as a basis but never dated before its fetch", () => {
    const future = row("CURRENT_STATE", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOKEN_SUPPLY", mechanismState: "LIVE", publishedAt: null, fetchedAt: new Date(NOW.getTime() + DAY) });
    const r = reconcile("CURRENT_STATE", [future]);
    expect(r.temporalBasis?.basisField).toBe("fetched_at");
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
  });
});

// =====================================================================
describe("P. provenance — every positive or partial verdict is auditable", () => {
  const POSITIVE_POOLS: [string, () => EvidenceRow[]][] = [
    ["PROTOCOL_REVENUE_TO_TOKEN", messyPool],
    ["VALUE_CAPTURE", messyPool],
    ["PASSIVE_HOLDER_OUTCOME", messyPool],
    ["MECHANISM_CURRENT_STATE", () => [row("CURRENT_STATE", { mechanismState: "LIVE" })]],
    ["BURN_OR_SUPPLY_EFFECT", messyPool],
    ["TOKEN_UTILITY", messyPool],
    ["REWARD_SOURCE", messyPool],
    ["USAGE_TO_TOKEN_LINKAGE", messyPool],
  ];

  it("P1. across every intent and a messy pool, a SUPPORTED or PARTIALLY_SUPPORTED Proof cites at least one supporting row of a component the claim rests on", () => {
    for (const [intent, mk] of POSITIVE_POOLS) {
      const c = runChain(intent, mk());
      if (c.proof.verdict === "SUPPORTED" || c.proof.verdict === "PARTIALLY_SUPPORTED") {
        expect(c.proof.citedEvidenceIds.length, `${intent} ${c.proof.verdict}`).toBeGreaterThan(0);
        for (const id of c.proof.citedEvidenceIds) {
          expect(c.byComponent.values().some((r) => r.supportingEvidenceIds.includes(id)), intent).toBe(true);
        }
      }
    }
  });

  it("P2. a cited id must exist as Evidence of THIS job: a supporting id that vanished is never cited, and the Proof says so rather than pointing at nothing", () => {
    const pool = [row("CURRENT_STATE", { mechanismState: "LIVE" })];
    const intact = runChain("MECHANISM_CURRENT_STATE", pool);
    expect(intact.proof.citedEvidenceIds).toEqual([pool[0].id]);
    const vanished = runChain("MECHANISM_CURRENT_STATE", pool, []);
    expect(vanished.proof.citedEvidenceIds).toEqual([]);
    expect(vanished.proof.layers.layers[2].lines).toContain("No evidence row is cited in support of this conclusion.");
  });

  it("P3. an excluded row is never cited even when the same passage also exists as an admitted row (duplicate lineage is one citation)", () => {
    const a = row("CURRENT_STATE", { id: "aaaa0000-0000-4000-8000-000000000011", extractionUnitKey: "same-passage", mechanismState: "LIVE" });
    const b = row("CURRENT_STATE", { id: "bbbb0000-0000-4000-8000-000000000012", extractionUnitKey: "same-passage", mechanismState: "LIVE" });
    const c = runChain("MECHANISM_CURRENT_STATE", [b, a]);
    const excludedId = c.byComponent.get("CURRENT_STATE")!.excludedEvidence[0].evidenceId;
    expect(c.proof.citedEvidenceIds).toHaveLength(1);
    expect(c.proof.citedEvidenceIds).not.toContain(excludedId);
  });

  it("P4. a NET_SUPPLY refutation keeps the burn as cited support while the delta stays uncited (refuting rows are recorded as contradiction, never as support)", () => {
    const burn = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "BURN", publishedAt: null });
    const up = row("NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "TOTAL_SUPPLY_DELTA", relationship: "CONTRADICTS", publishedAt: null });
    const c = runChain("BURN_OR_SUPPLY_EFFECT", [burn, up]);
    expect(c.claim.status).toBe("NOT_SUPPORTED");
    expect(c.proof.citedEvidenceIds).toEqual([burn.id]);
    expect(c.proof.gaps.some((g) => g.kind === "NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL")).toBe(true);
  });

  it("P5. [documented boundary H7] a refutation resting on a state CONFLICT cites nothing: citations are support-only by S8 design, so the contradicting rows are visible only as gaps", () => {
    const live = row("SOURCE_OF_VALUE", { mechanismState: "LIVE", publishedAt: null });
    const removed = row("SOURCE_OF_VALUE", { relationship: "CONTRADICTS", mechanismState: "REMOVED", publishedAt: null });
    const c = runChain("PROTOCOL_REVENUE_TO_TOKEN", [live, removed, row("DESTINATION"), row("RECIPIENT")]);
    expect(c.claim.status).toBe("NOT_SUPPORTED");
    expect(c.proof.citedEvidenceIds).toEqual([]);
    expect(c.proof.gaps.some((g) => g.kind === "CONFLICTING_STATE" && g.component === "SOURCE_OF_VALUE")).toBe(true);
    expect(c.proof.confidenceScore).toBeLessThanOrEqual(40);
  });
});

// =====================================================================
describe("X. cross-stage contracts and idempotency of the pure chain", () => {
  it("X1. running the chain twice over the same inputs is byte-identical (no clock, no randomness, no hidden state)", () => {
    const pool = messyPool();
    const a = JSON.stringify(semanticSnapshot(runChain("VALUE_CAPTURE", pool)));
    const b = JSON.stringify(semanticSnapshot(runChain("VALUE_CAPTURE", pool)));
    expect(a).toBe(b);
  });

  it("X2. every PARTIALLY_SUPPORTED S5 result the chain produces is carried by S6 as a qualified attachment or an explicit gap — never dropped, never an invariant error", () => {
    const c = runChain("VALUE_CAPTURE", messyPool());
    // The messy pool forks at RECIPIENT (two sources), so a later chain row
    // may be attributable to neither branch: that is a positioned gap, not
    // an attachment, and is exactly as visible.
    for (const r of c.results) {
      if (r.status !== "PARTIALLY_SUPPORTED") continue;
      for (const flow of c.assembly.flows) {
        const node = flow.nodes.find((n) => n.component === r.component);
        const attachment = r.component === "NET_EFFECT" ? flow.netEffect : r.component === "DURABILITY_BASIS" ? flow.durability : null;
        const quals = node?.qualifications ?? attachment?.qualifications ?? null;
        const gapped = flow.gaps.some((g) => g.component === r.component && (g.kind === "PARTIAL_COMPONENT" || g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED"));
        if (quals !== null) expect(quals.length, r.component).toBeGreaterThan(0);
        expect(quals !== null || gapped, `${r.component} on ${flow.flowId}`).toBe(true);
      }
    }
  });

  it("X3. S7 never references a component result S5 did not produce, and every provenance key resolves to a real (step, component)", () => {
    const c = runChain("VALUE_CAPTURE", messyPool());
    const keys = new Set(c.results.map((r) => `${r.step}:${r.component}`));
    for (const req of c.claim.requirementResults) {
      for (const k of req.provenance.componentResultKeys) expect(keys.has(`${k.step}:${k.component}`), req.requirementId).toBe(true);
      for (const id of req.provenance.evidenceIds) {
        expect(c.results.some((r) => r.supportingEvidenceIds.includes(id) || r.contradictingEvidenceIds.includes(id)), req.requirementId).toBe(true);
      }
    }
  });

  it("X4. a state conflict on one component never leaks into a sibling component's establishment (WRONG_COMPONENT is scope, not sympathy)", () => {
    const pool = [
      row("MECHANISM_SPEC", { mechanismState: "LIVE", publishedAt: null }),
      row("MECHANISM_SPEC", { relationship: "CONTRADICTS", mechanismState: "REMOVED", publishedAt: null }),
      row("GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", mechanismState: "APPROVED" }),
    ];
    const c = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    expect(c.byComponent.get("MECHANISM_SPEC")!.status).toBe("CONTRADICTED");
    expect(c.byComponent.get("GOVERNANCE_BASIS")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(c.byComponent.get("GOVERNANCE_BASIS")!.reasonCodes).toEqual(["INSUFFICIENT_AUTHORITY"]);
  });

  it("X5. the confidence band is a function of persisted closed state only: the same S5/S7 rows give the same band regardless of which rows still exist as Evidence", () => {
    const pool = messyPool();
    const all = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool);
    const fewer = runChain("PROTOCOL_REVENUE_TO_TOKEN", pool, pool.slice(0, 3).map((r) => r.id));
    expect(fewer.proof.confidenceScore).toBe(all.proof.confidenceScore);
    expect(fewer.proof.verdict).toBe(all.proof.verdict);
  });
});
