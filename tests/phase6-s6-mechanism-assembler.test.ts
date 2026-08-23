import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, type PatternContent } from "../src/server/domain/pattern";
import type { ComponentReconciliationResult } from "../src/server/engine/component-reconciler";
import {
  assembleMechanism,
  MechanismAssemblyInvariantError,
  type AssemblyEvidenceProjection,
  type MechanismAssemblyInput,
} from "../src/server/engine/mechanism-assembler";

function ev(id: string, sourceId: string, fragment: string, overrides: Partial<AssemblyEvidenceProjection> = {}): AssemblyEvidenceProjection {
  return {
    id,
    sourceId,
    extractionUnitKey: null,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CONFIRMED",
    mechanismState: "LIVE",
    publishedAt: new Date("2025-01-01T00:00:00.000Z"),
    fetchedAt: new Date("2025-01-01T00:00:00.000Z"),
    fragment,
    summary: null,
    retrievedUrl: "https://example.com",
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

function cr(
  step: number,
  component: string,
  status: ComponentReconciliationResult["status"],
  supportingEvidenceIds: string[],
  overrides: Partial<ComponentReconciliationResult> = {},
): ComponentReconciliationResult {
  return {
    step,
    component,
    status,
    reasonCodes: [],
    supportingEvidenceIds,
    contradictingEvidenceIds: [],
    excludedEvidence: [],
    currentState: null,
    temporalBasis: null,
    tokenStateMentions: [],
    requiresFreshEvidence: false,
    ...overrides,
  };
}

function assemble(
  componentResults: ComponentReconciliationResult[],
  admittedEvidence: AssemblyEvidenceProjection[],
  overrides: Partial<MechanismAssemblyInput> = {},
) {
  return assembleMechanism({
    researchJobId: "job-1",
    patternVersion: 1,
    pattern: PATTERN_V1_CONTENT,
    contractView: { patternVersion: 1 },
    componentResults,
    admittedEvidence,
    ...overrides,
  });
}

// A complete, linear, gap-free chain — the baseline every other scenario
// perturbs. Reused across many tests to isolate exactly one change.
function completeChainEvidence(): AssemblyEvidenceProjection[] {
  return [
    ev("e1", "s1", "protocol fees paid by users"),
    ev("e2", "s2", "fees flow to allocation mechanism"),
    ev("e3", "s3", "allocation mechanism specifies buyback"),
    ev("e4", "s3g", "governed by DAO vote"),
    ev("e5", "s4", "buyback executed on-chain"),
    ev("e6", "s5", "mechanism is LIVE"),
    ev("e7", "s6d", "tokens sent to treasury"),
    ev("e8", "s6r", "token holders benefit"),
    ev("e9", "s7", "net supply reduced"),
    ev("e10", "s8", "locked by governance contract"),
  ];
}
function completeChainResults(overrides: Partial<Record<string, Partial<ComponentReconciliationResult>>> = {}): ComponentReconciliationResult[] {
  const base: Record<string, ComponentReconciliationResult> = {
    SOURCE_OF_VALUE: cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["e1"]),
    FLOW_PATH: cr(2, "FLOW_PATH", "SUPPORTED", ["e2"]),
    MECHANISM_SPEC: cr(3, "MECHANISM_SPEC", "SUPPORTED", ["e3"]),
    GOVERNANCE_BASIS: cr(3, "GOVERNANCE_BASIS", "SUPPORTED", ["e4"]),
    EXECUTION_EVIDENCE: cr(4, "EXECUTION_EVIDENCE", "SUPPORTED", ["e5"]),
    CURRENT_STATE: cr(5, "CURRENT_STATE", "SUPPORTED", ["e6"], {
      currentState: "LIVE",
      temporalBasis: { basisField: "published_at", at: "2025-01-01T00:00:00.000Z" },
    }),
    DESTINATION: cr(6, "DESTINATION", "SUPPORTED", ["e7"]),
    RECIPIENT: cr(6, "RECIPIENT", "SUPPORTED", ["e8"]),
    NET_EFFECT: cr(7, "NET_EFFECT", "SUPPORTED", ["e9"]),
    DURABILITY_BASIS: cr(8, "DURABILITY_BASIS", "SUPPORTED", ["e10"]),
  };
  for (const [k, v] of Object.entries(overrides)) {
    base[k] = { ...base[k], ...v };
  }
  return Object.values(base);
}

describe("S6 acceptance scenarios (phase-6-s6-plan.md §26)", () => {
  it("A. complete linear chain -> one flow, COMPLETE_PATH, no gaps, provenance everywhere", () => {
    const r = assemble(completeChainResults(), completeChainEvidence());
    expect(r.flows.length).toBe(1);
    const flow = r.flows[0];
    expect(flow.shape).toBe("COMPLETE_PATH");
    expect(flow.gaps).toEqual([]);
    expect(flow.nodes.length).toBe(3);
    expect(flow.edges.length).toBe(2);
    for (const n of flow.nodes) expect(n.provenance.evidenceIds.length).toBeGreaterThan(0);
    for (const e of flow.edges) expect(e.provenance.evidenceIds.length).toBeGreaterThan(0);
  });

  it("B. DESTINATION missing -> gap DESTINATION_UNRESOLVED; no destination node; burn never appears from nowhere", () => {
    const results = completeChainResults({ DESTINATION: cr(6, "DESTINATION", "INSUFFICIENT_EVIDENCE", []) });
    const r = assemble(results, completeChainEvidence());
    const flow = r.flows[0];
    expect(flow.nodes.find((n) => n.kind === "DESTINATION")).toBeUndefined();
    expect(flow.gaps.some((g) => g.kind === "DESTINATION_UNRESOLVED")).toBe(true);
    expect(flow.attributes.destinationKind).toBe("UNKNOWN");
  });

  it("C. buyback + destination TREASURY -> destinationKind=TREASURY; BURN absent; NET_EFFECT not invented", () => {
    const evidence = [
      ...completeChainEvidence().filter((e) => e.id !== "e7"),
      ev("e7", "s6d", "buyback proceeds sent to treasury"),
    ];
    const results = completeChainResults({ NET_EFFECT: cr(7, "NET_EFFECT", "INSUFFICIENT_EVIDENCE", []) });
    const r = assemble(results, evidence);
    const flow = r.flows[0];
    expect(flow.attributes.destinationKind).toBe("TREASURY");
    expect(flow.netEffect).toBeNull();
    expect(flow.gaps.some((g) => g.kind === "NET_EFFECT_UNRESOLVED")).toBe(true);
  });

  it("D. RECIPIENT established from 'veCRV holders' -> tokenState='vecrv' preserved, no generalization to CRV", () => {
    const evidence = [...completeChainEvidence().filter((e) => e.id !== "e8"), ev("e8", "s6r", "veCRV holders benefit")];
    const results = completeChainResults({
      RECIPIENT: cr(6, "RECIPIENT", "SUPPORTED", ["e8"], { tokenStateMentions: ["vecrv"] }),
    });
    const r = assemble(results, evidence);
    expect(r.flows[0].attributes.tokenState).toBe("vecrv");
  });

  it("E. one asset, two different valueSource -> two flows, different flowId, no merge", () => {
    const evidenceA = [ev("a1", "sA", "paid by customers")];
    const evidenceB = [ev("b1", "sB", "protocol issuance emission subsidy")];
    // Two independent, single-slot jobs modelled as two separate assemblies
    // sharing nothing structurally — the real cross-flow case is exercised
    // by the branching tests (M, AM-AO) where both live in ONE call.
    const rA = assemble([cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["a1"])], evidenceA);
    const rB = assemble([cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["b1"])], evidenceB);
    expect(rA.flows[0].flowId).not.toBe(rB.flows[0].flowId);
    expect(rA.flows[0].attributes.valueSource).toBe("USER_PAYMENT");
    expect(rB.flows[0].attributes.valueSource).toBe("PROTOCOL_ISSUANCE");
  });

  it("F. BTC: user-payment fee vs protocol-issuance subsidy -> distinct flows via distinct provenance", () => {
    const evidence = [
      ev("f1", "sFee", "paid by customers"),
      ev("f2", "sSub", "block reward subsidy issued by protocol"),
    ];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["f1", "f2"])];
    const r = assemble(results, evidence);
    // Same structural slot (both ids share the SOURCE_OF_VALUE component,
    // no extractionUnitKey/contentHash overlap) -> distinct structuralUnitKey
    // per row -> 2 slots -> 2 flows, forked at step 1.
    expect(r.flows.length).toBe(2);
    const sources = r.flows.map((f) => f.attributes.valueSource).sort();
    expect(sources).toEqual(["PROTOCOL_ISSUANCE", "USER_PAYMENT"]);
  });

  it("G. RENDER: burn-on-payment vs emission reward to node operator -> distinct flows, recipientKind differs", () => {
    const sourceEvidence = [ev("g1", "sBurn", "customer payment fees"), ev("g2", "sReward", "emission reward issued to node operator")];
    const recipientEvidence = [ev("g3", "sBurn", "burned by protocol"), ev("g4", "sReward", "node operator receives reward")];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["g1", "g2"]),
      cr(6, "RECIPIENT", "SUPPORTED", ["g3", "g4"]),
    ];
    const r = assemble(results, [...sourceEvidence, ...recipientEvidence]);
    expect(r.flows.length).toBe(2);
    const byValueSource = new Map(r.flows.map((f) => [f.attributes.valueSource, f]));
    expect(byValueSource.get("PROTOCOL_ISSUANCE")?.attributes.recipientKind).toBe("NODE_OPERATOR");
  });

  it("H. FIL: collateral return -> direction=RETURN, valueSource=COLLATERAL_RETURN, never a reward, PASSIVE_HOLDER never appears", () => {
    const evidence = [ev("h1", "sH", "collateral returned to provider")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["h1"])];
    const r = assemble(results, evidence);
    expect(r.flows[0].attributes.direction).toBe("RETURN");
    expect(r.flows[0].attributes.valueSource).toBe("COLLATERAL_RETURN");
    expect(r.flows[0].attributes.recipientKind).not.toBe("PASSIVE_HOLDER");
  });

  it("I. execution in 2025 LIVE + mechanism DEPRECATED in 2026 -> lifecycle=HISTORICAL, no current live path fabricated", () => {
    const evidence = [
      ...completeChainEvidence(),
    ];
    const results = completeChainResults({
      CURRENT_STATE: cr(5, "CURRENT_STATE", "SUPPORTED", ["e6"], {
        currentState: "DEPRECATED",
        temporalBasis: { basisField: "published_at", at: "2026-01-01T00:00:00.000Z" },
      }),
    });
    const r = assemble(results, evidence);
    expect(r.flows[0].lifecycle).toBe("HISTORICAL");
  });

  it("J. component PARTIALLY_SUPPORTED -> element present WITH qualification AND gap PARTIAL_COMPONENT", () => {
    const results = completeChainResults({
      DESTINATION: cr(6, "DESTINATION", "PARTIALLY_SUPPORTED", ["e7"], { reasonCodes: ["INSUFFICIENT_AUTHORITY"] }),
    });
    const r = assemble(results, completeChainEvidence());
    const flow = r.flows[0];
    const destNode = flow.nodes.find((n) => n.kind === "DESTINATION")!;
    expect(destNode).toBeDefined();
    expect(destNode.qualifications).toContain("INSUFFICIENT_AUTHORITY");
    expect(flow.gaps.some((g) => g.kind === "PARTIAL_COMPONENT" && g.component === "DESTINATION")).toBe(true);
  });

  it("K. component CONTRADICTED -> gap CONTRADICTED_COMPONENT with both id sets, no winner, no node", () => {
    const evidence = [...completeChainEvidence(), ev("e7b", "s6d2", "tokens burned", { sourceId: "s6d2" })];
    const results = completeChainResults({
      DESTINATION: cr(6, "DESTINATION", "CONTRADICTED", [], { contradictingEvidenceIds: ["e7", "e7b"] }),
    });
    const r = assemble(results, evidence);
    const flow = r.flows[0];
    expect(flow.nodes.find((n) => n.kind === "DESTINATION")).toBeUndefined();
    const gap = flow.gaps.find((g) => g.kind === "CONTRADICTED_COMPONENT");
    expect(gap).toBeDefined();
    expect(gap!.provenance.evidenceIds.sort()).toEqual(["e7", "e7b"].sort());
  });

  it("L. component INSUFFICIENT_EVIDENCE -> gap MISSING_COMPONENT (generic component, e.g. FLOW_PATH)", () => {
    const results = completeChainResults({ FLOW_PATH: cr(2, "FLOW_PATH", "INSUFFICIENT_EVIDENCE", []) });
    const r = assemble(results, completeChainEvidence());
    expect(r.flows[0].gaps.some((g) => g.kind === "MISSING_COMPONENT" && g.component === "FLOW_PATH")).toBe(true);
  });

  it("M. branching at distribution stage into three -> three flows, shared sharedPrefixId, different flowId, branchPointStep=3", () => {
    const evidence = [
      ev("m1", "s1", "protocol fees"),
      ev("m2", "s2", "flow to mechanism"),
      ev("mA", "sA", "50 percent buyback"),
      ev("mB", "sB", "30 percent treasury"),
      ev("mC", "sC", "20 percent operations"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["m1"]),
      cr(2, "FLOW_PATH", "SUPPORTED", ["m2"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["mA", "mB", "mC"]),
    ];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(3);
    const prefixIds = new Set(r.flows.map((f) => f.sharedPrefixId));
    expect(prefixIds.size).toBe(1);
    expect([...prefixIds][0]).not.toBeNull();
    const flowIds = new Set(r.flows.map((f) => f.flowId));
    expect(flowIds.size).toBe(3);
    for (const f of r.flows) expect(f.branchPointStep).toBe(3);
  });

  it("O. incompatible token states on adjacent components -> gap TOKEN_STATE_MISMATCH, states kept separate, not merged/chosen", () => {
    const evidence = [...completeChainEvidence().filter((e) => !["e7", "e8"].includes(e.id)), ev("e7", "s6d", "crv sent to treasury"), ev("e8", "s6r", "veCRV holders benefit")];
    const results = completeChainResults({
      DESTINATION: cr(6, "DESTINATION", "SUPPORTED", ["e7"], { tokenStateMentions: ["crv"] }),
      RECIPIENT: cr(6, "RECIPIENT", "SUPPORTED", ["e8"], { tokenStateMentions: ["vecrv"] }),
    });
    const r = assemble(results, evidence);
    const flow = r.flows[0];
    expect(flow.gaps.some((g) => g.kind === "TOKEN_STATE_MISMATCH")).toBe(true);
    expect(flow.attributes.tokenState).toBeNull();
  });

  it("P. reverse input array order -> byte-identical result", () => {
    const evidence = completeChainEvidence();
    const results = completeChainResults();
    const r1 = assemble(results, evidence);
    const r2 = assemble([...results].reverse(), [...evidence].reverse());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("Q. duplicate S5 result for the same (job, step, component) -> system failure, not a silent row pick", () => {
    const results = [...completeChainResults(), cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])];
    expect(() => assemble(results, completeChainEvidence())).toThrow(MechanismAssemblyInvariantError);
  });

  it("S. 'burn' label in MECHANISM_SPEC text without established NET_EFFECT -> no supply-reduction edge; gap NET_EFFECT_UNRESOLVED", () => {
    const evidence = [...completeChainEvidence().filter((e) => e.id !== "e3"), ev("e3", "s3", "mechanism burns tokens on distribution")];
    const results = completeChainResults({ NET_EFFECT: cr(7, "NET_EFFECT", "INSUFFICIENT_EVIDENCE", []) });
    const r = assemble(results, evidence);
    expect(r.flows[0].netEffect).toBeNull();
    expect(r.flows[0].gaps.some((g) => g.kind === "NET_EFFECT_UNRESOLVED")).toBe(true);
  });

  it("T. principal return -> not a reward; no OUTBOUND acquisition edge implied (see H)", () => {
    const evidence = [ev("t1", "sT", "returned principal to depositor")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["t1"])];
    const r = assemble(results, evidence);
    expect(r.flows[0].attributes.direction).toBe("RETURN");
    expect(r.flows[0].attributes.direction).not.toBe("OUTBOUND");
  });

  it("U. structurally incomplete path -> valid result with gaps, not a failure", () => {
    const results = completeChainResults({ DESTINATION: cr(6, "DESTINATION", "INSUFFICIENT_EVIDENCE", []) });
    const r = assemble(results, completeChainEvidence());
    expect(r.flows[0].shape).toBe("PARTIAL_PATH");
    expect(r.flows.length).toBe(1);
  });

  it("V. valueSource not recognised by the closed dictionary -> UNKNOWN + gap FLOW_IDENTITY_UNRESOLVED, no merge with anything", () => {
    const evidence = [ev("v1", "sV", "some unrelated economic activity happens here")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["v1"])];
    const r = assemble(results, evidence);
    expect(r.flows[0].attributes.valueSource).toBe("UNKNOWN");
    expect(r.flows[0].gaps.some((g) => g.kind === "FLOW_IDENTITY_UNRESOLVED")).toBe(true);
  });

  it("W. patternVersion disagrees with contractView -> system failure", () => {
    expect(() =>
      assemble(completeChainResults(), completeChainEvidence(), { contractView: { patternVersion: 2 } }),
    ).toThrow(MechanismAssemblyInvariantError);
  });

  it("X. component with no componentRequirements entry in Pattern -> PatternConfigurationError, not a silent gap", () => {
    const brokenPattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      componentRequirements: Object.fromEntries(
        Object.entries(PATTERN_V1_CONTENT.componentRequirements ?? {}).filter(([k]) => k !== "DESTINATION"),
      ),
    };
    expect(() => assemble(completeChainResults(), completeChainEvidence(), { pattern: brokenPattern })).toThrow(
      /Pattern is missing componentRequirements/,
    );
  });

  it("Y. repeated run from identical frozen inputs -> identical result, no accumulation", () => {
    const r1 = assemble(completeChainResults(), completeChainEvidence());
    const r2 = assemble(completeChainResults(), completeChainEvidence());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("Z. RECIPIENT not established -> recipientKind=UNKNOWN + gap RECIPIENT_UNRESOLVED; PASSIVE_HOLDER never inferred from absence", () => {
    const results = completeChainResults({ RECIPIENT: cr(6, "RECIPIENT", "INSUFFICIENT_EVIDENCE", []) });
    const r = assemble(results, completeChainEvidence());
    expect(r.flows[0].attributes.recipientKind).toBe("UNKNOWN");
    expect(r.flows[0].gaps.some((g) => g.kind === "RECIPIENT_UNRESOLVED")).toBe(true);
  });

  it("I2. CURRENT_STATE itself LIVE, but ANOTHER lineage component reports a newer DEPRECATED -> lifecycle=HISTORICAL, not CURRENT", () => {
    const evidence = [...completeChainEvidence(), ev("e5b", "s4b", "mechanism superseded", { sourceId: "s4" })];
    const results = completeChainResults({
      EXECUTION_EVIDENCE: cr(4, "EXECUTION_EVIDENCE", "SUPPORTED", ["e5"], {
        currentState: "DEPRECATED",
        temporalBasis: { basisField: "published_at", at: "2026-06-01T00:00:00.000Z" },
      }),
      CURRENT_STATE: cr(5, "CURRENT_STATE", "SUPPORTED", ["e6"], {
        currentState: "LIVE",
        temporalBasis: { basisField: "published_at", at: "2025-01-01T00:00:00.000Z" },
      }),
    });
    const r = assemble(results, evidence);
    expect(r.flows[0].lifecycle).toBe("HISTORICAL");
  });

  it("N. same asset, different recipient/action -> flows do not merge", () => {
    const evidence = [
      ev("n1", "s1", "protocol fees paid by users"),
      ev("nA", "sA", "distributed to holders"),
      ev("nB", "sB", "sent to node operator"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["n1"]),
      cr(6, "RECIPIENT", "SUPPORTED", ["nA", "nB"]),
    ];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    const kinds = r.flows.map((f) => f.attributes.recipientKind).sort();
    expect(kinds).toEqual(["NODE_OPERATOR", "PASSIVE_HOLDER"]);
  });

  it("R. a node/edge without provenance is an invariant violation, not silent emptiness", () => {
    // Constructed defensively: supportingEvidenceIds referencing an id NOT
    // present in admittedEvidence is exactly the "dangling reference"
    // system failure (§21 п.5) — an element can never be materialized
    // with empty/invalid provenance.
    const results = completeChainResults({ SOURCE_OF_VALUE: cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ghost-id"]) });
    expect(() => assemble(results, completeChainEvidence())).toThrow(MechanismAssemblyInvariantError);
  });
});

describe("S6 §6.5 — Same Asset != Same Economic Flow, asset symbol discipline", () => {
  it("AH. assetSymbol not structurally available -> null; assembly still valid", () => {
    const r = assemble(completeChainResults(), completeChainEvidence());
    expect(r.flows[0].attributes.assetSymbol).toBeNull();
  });

  it("AI. two flows share an identical (never-parsed) assetSymbol -> still do not merge (symbol plays no role in flowId)", () => {
    const evidence = [ev("ai1", "sAI1", "protocol fees paid by users CRV"), ev("ai2", "sAI2", "protocol fees paid by users CRV")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ai1", "ai2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    expect(r.flows[0].attributes.assetSymbol).toBeNull();
    expect(r.flows[1].attributes.assetSymbol).toBeNull();
  });
});

describe("S6 §16 — buyback/treasury/distribution never auto-become burn (mutations 3, 5)", () => {
  it("BUYBACK_HOLD destination text never classifies as BURN", () => {
    const evidence = [ev("bh1", "sBH", "tokens bought back and held in reserve")];
    const results = [cr(6, "DESTINATION", "SUPPORTED", ["bh1"])];
    const r = assemble(results, evidence);
    expect(r.flows[0].attributes.destinationKind).toBe("BUYBACK_HOLD");
    expect(r.flows[0].attributes.destinationKind).not.toBe("BURN");
  });

  it("TREASURY destination text never classifies as DISTRIBUTION", () => {
    const evidence = [ev("tr1", "sTR", "sent to the protocol treasury")];
    const results = [cr(6, "DESTINATION", "SUPPORTED", ["tr1"])];
    const r = assemble(results, evidence);
    expect(r.flows[0].attributes.destinationKind).toBe("TREASURY");
    expect(r.flows[0].attributes.destinationKind).not.toBe("DISTRIBUTION");
  });
});

describe("S6 §13.2b — classifier defects never change flow count (D-101 inversion)", () => {
  it("AS. classifier returns the SAME value for all candidates -> flow count still driven by structure, not collapsed", () => {
    const evidence = [ev("as1", "sAS1", "market purchase buyback"), ev("as2", "sAS2", "market purchase buyback")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["as1", "as2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    expect(r.flows[0].attributes.valueSource).toBe(r.flows[1].attributes.valueSource);
  });

  it("AT. classifier returns UNKNOWN for all candidates -> flow count still driven by structure, not collapsed", () => {
    const evidence = [ev("at1", "sAT1", "nothing recognisable"), ev("at2", "sAT2", "still nothing recognisable")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["at1", "at2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    expect(r.flows.every((f) => f.attributes.valueSource === "UNKNOWN")).toBe(true);
  });
});

describe("S6 acceptance scenarios D-099/D-101 extensions (§26 AA-AU)", () => {
  it("AA. two flows, all semantic attributes identical, different provenance -> two different flowId, no merge", () => {
    const evidence = [ev("aa1", "sAA1", "protocol fees paid by users"), ev("aa2", "sAA2", "protocol fees paid by users")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["aa1", "aa2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    expect(r.flows[0].flowId).not.toBe(r.flows[1].flowId);
    expect(r.flows[0].attributes).toEqual(r.flows[1].attributes);
  });

  it("AB. both flows entirely UNKNOWN attributes -> two different flowId, unrelated flows not collapsed", () => {
    const evidence = [ev("ab1", "sAB1", "unrecognised activity"), ev("ab2", "sAB2", "another unrecognised activity")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ab1", "ab2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    expect(r.flows[0].flowId).not.toBe(r.flows[1].flowId);
    expect(r.flows.every((f) => f.attributes.valueSource === "UNKNOWN")).toBe(true);
  });

  it("AC. classification of one Evidence unit changes, provenance unchanged -> flowId unchanged, only attributes change", () => {
    const evidenceBuyback = [ev("ac1", "sAC", "market purchase buyback of tokens")];
    const evidenceUnknown = [ev("ac1", "sAC", "unrelated economic text")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ac1"])];
    const r1 = assemble(results, evidenceBuyback);
    const r2 = assemble(results, evidenceUnknown);
    expect(r1.flows[0].flowId).toBe(r2.flows[0].flowId);
    expect(r1.flows[0].attributes.valueSource).not.toBe(r2.flows[0].attributes.valueSource);
  });

  it("AD. branch at distribution, NET_EFFECT shares no provenance with either branch -> BRANCH_ATTRIBUTION_UNRESOLVED on each, no inherited net effect", () => {
    const evidence = [
      ev("ad1", "s1", "protocol fees"),
      ev("adA", "sA", "buyback allocation"),
      ev("adB", "sB", "treasury allocation"),
      ev("adN", "sUnrelated", "net supply reduced"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ad1"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["adA", "adB"]),
      cr(7, "NET_EFFECT", "SUPPORTED", ["adN"]),
    ];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    for (const f of r.flows) {
      expect(f.netEffect).toBeNull();
      expect(f.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED" && g.component === "NET_EFFECT")).toBe(true);
    }
  });

  it("AE. branch at distribution, NET_EFFECT shares sourceId with ONE branch -> attaches only there", () => {
    const evidence = [
      ev("ae1", "s1", "protocol fees"),
      ev("aeA", "sA", "buyback allocation"),
      ev("aeB", "sB", "treasury allocation"),
      ev("aeN", "sA", "net supply reduced"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ae1"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["aeA", "aeB"]),
      cr(7, "NET_EFFECT", "SUPPORTED", ["aeN"]),
    ];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    const withNetEffect = r.flows.filter((f) => f.netEffect !== null);
    expect(withNetEffect.length).toBe(1);
  });

  it("AK. several Evidence ids with identical slotKey (same extractionUnitKey) -> one slot, aggregated provenance, not several flows", () => {
    const evidence = [
      ev("ak1", "s1", "protocol fees part one", { extractionUnitKey: "unit-x" }),
      ev("ak2", "s2", "protocol fees part two", { extractionUnitKey: "unit-x" }),
    ];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ak1", "ak2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(1);
    expect(r.flows[0].lineage[0].evidenceIds.sort()).toEqual(["ak1", "ak2"]);
  });

  it("AL. two Evidence units of one component, both UNKNOWN classification, different provenance -> two slots -> two flows", () => {
    const evidence = [ev("al1", "sAL1", "unrecognised text one"), ev("al2", "sAL2", "unrecognised text two")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["al1", "al2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
  });

  it("AM. two structurally distinct branches, BOTH classified BUYBACK -> two distinct slots/flows, label match never merges", () => {
    const evidence = [
      ev("am1", "s1", "protocol fees"),
      ev("amA", "sA", "buyback executed via market purchase"),
      ev("amB", "sB", "buyback executed via market purchase"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["am1"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["amA", "amB"]),
    ];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
    expect(r.flows[0].flowId).not.toBe(r.flows[1].flowId);
  });

  it("AN. two structurally distinct branches with identical semantic tuple -> two distinct flows (semantic tuple is not identity)", () => {
    const evidence = [
      ev("an1", "s1", "protocol fees paid by users"),
      ev("anA", "sA", "distributed to holders"),
      ev("anB", "sB", "distributed to holders"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["an1"]),
      cr(6, "RECIPIENT", "SUPPORTED", ["anA", "anB"]),
    ];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
  });

  it("AO. two branches, both UNKNOWN, different lineage provenance -> two distinct flows", () => {
    const evidence = [ev("ao1", "sAO1", "x"), ev("ao2", "sAO2", "y")];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ao1", "ao2"])];
    const r = assemble(results, evidence);
    expect(r.flows.length).toBe(2);
  });

  it("AQ. classification change only (BUYBACK -> UNKNOWN), structure/provenance unchanged -> flowId unchanged", () => {
    const withBuyback = assemble(
      [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["aq1"])],
      [ev("aq1", "sAQ", "market purchase buyback")],
    );
    const withUnknown = assemble(
      [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["aq1"])],
      [ev("aq1", "sAQ", "unrelated text")],
    );
    expect(withBuyback.flows[0].flowId).toBe(withUnknown.flows[0].flowId);
  });

  it("AR. structural provenance of the branch changes -> flowId may change / a distinct branch appears", () => {
    const evidenceA = [ev("ar1", "sA", "protocol fees paid by users")];
    const evidenceB = [ev("ar1", "sB", "protocol fees paid by users")];
    const rA = assemble([cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ar1"])], evidenceA);
    const rB = assemble([cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ar1"])], evidenceB);
    // Same evidence id, different sourceId does not change flowId directly
    // (sourceId is not a flowId input) — but a genuinely different
    // evidenceIds set does. This test documents that sourceId ALONE
    // (branch attribution input) is not a flowId input either.
    expect(rA.flows[0].flowId).toBe(rB.flows[0].flowId);
    const evidenceC = [ev("ar2", "sA", "protocol fees paid by users")];
    const rC = assemble([cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["ar2"])], evidenceC);
    expect(rA.flows[0].flowId).not.toBe(rC.flows[0].flowId);
  });
});

describe("S6 D-103 — no top-level verdict/sufficiency field", () => {
  it("MechanismAssemblyResult and MechanismFlow never carry a verdict/sufficient/proven/confidence/claim field", () => {
    const r = assemble(completeChainResults(), completeChainEvidence());
    const banned = /verdict|sufficient|\bproven\b|confidence|claim/i;
    const json = JSON.stringify(r, (key, value) => {
      if (banned.test(key)) throw new Error(`forbidden field name found: ${key}`);
      return value;
    });
    expect(json).toBeTruthy();
    expect(Object.keys(r)).not.toContain("verdict");
    expect(Object.keys(r.flows[0])).not.toContain("verdict");
    expect(Object.keys(r.flows[0])).not.toContain("sufficient");
  });
});
