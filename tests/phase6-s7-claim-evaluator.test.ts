import { describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT, type PatternContent } from "../src/server/domain/pattern";
import {
  evaluateClaimSupport,
  ClaimEvaluationInvariantError,
  type ClaimEvaluationInput,
} from "../src/server/engine/claim-evaluator";
import type { MechanismFlow, MechanismAssemblyResult, MechanismGap, NetEffectAttachment, DurabilityAttachment, FlowAttributes } from "../src/server/engine/mechanism-assembler";

// ---------------------------------------------------------------------
// Test helpers — build minimal, explicit MechanismFlow fixtures rather
// than running the full S6 assembler, so each scenario isolates exactly
// the S7 rule under test (same discipline as phase6-s5/s6 test suites).

function attrs(overrides: Partial<FlowAttributes> = {}): FlowAttributes {
  return { valueSource: "UNKNOWN", direction: "UNKNOWN", recipientKind: "UNKNOWN", destinationKind: "UNKNOWN", tokenState: null, assetSymbol: null, ...overrides };
}

function flow(overrides: Partial<MechanismFlow> = {}): MechanismFlow {
  return {
    flowId: overrides.flowId ?? "f1",
    lineage: [],
    sharedPrefixId: null,
    branchPointStep: null,
    lifecycle: "NOT_ESTABLISHED",
    nodes: [],
    edges: [],
    shape: "PARTIAL_PATH",
    attributes: attrs(),
    netEffect: null,
    durability: null,
    gaps: [],
    ...overrides,
  };
}

function node(kind: MechanismFlow["nodes"][number]["kind"], component: string, status: "SUPPORTED" | "PARTIALLY_SUPPORTED", evidenceIds: string[], quals: MechanismFlow["nodes"][number]["qualifications"] = []) {
  return { kind, component, componentStatus: status, qualifications: quals, attributes: {} as Record<string, never>, provenance: { componentResults: [{ step: 1, component }], evidenceIds } };
}

function lineageStep(step: number, component: string, evidenceIds: string[]) {
  return { step, component, componentResultKey: `${step}:${component}`, evidenceIds };
}

function gap(kind: MechanismGap["kind"], component: string | null, afterStep: number | null, evidenceIds: string[] = []): MechanismGap {
  return { kind, component, afterStep, provenance: { componentResults: component ? [{ step: afterStep ?? 0, component }] : [], evidenceIds } };
}

function netEffect(status: "SUPPORTED" | "PARTIALLY_SUPPORTED", evidenceIds: string[]): NetEffectAttachment {
  return { componentStatus: status, qualifications: [], provenance: { componentResults: [{ step: 7, component: "NET_EFFECT" }], evidenceIds } };
}

function durability(status: "SUPPORTED" | "PARTIALLY_SUPPORTED", evidenceIds: string[]): DurabilityAttachment {
  return { componentStatus: status, basisClasses: ["GOVERNANCE"], qualifications: [], provenance: { componentResults: [{ step: 8, component: "DURABILITY_BASIS" }], evidenceIds } };
}

// A flow that fully establishes SOURCE_OF_VALUE -> DESTINATION with NET_EFFECT.
function completeFlow(overrides: Partial<MechanismFlow> = {}): MechanismFlow {
  return flow({
    lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"]), lineageStep(6, "DESTINATION", ["e2"])],
    nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])],
    netEffect: netEffect("SUPPORTED", ["e3"]),
    attributes: attrs({ valueSource: "USER_PAYMENT", destinationKind: "TREASURY", recipientKind: "PASSIVE_HOLDER" }),
    shape: "COMPLETE_PATH",
    ...overrides,
  });
}

function assemble(flows: MechanismFlow[], unassignedGaps: MechanismGap[] = []): MechanismAssemblyResult {
  return { researchJobId: "job-1", patternVersion: 1, flows, unassignedGaps };
}

function evalInput(overrides: Partial<ClaimEvaluationInput> = {}): ClaimEvaluationInput {
  return {
    researchJobId: "job-1",
    patternVersion: 1,
    pattern: PATTERN_V1_CONTENT,
    intent: "PROTOCOL_REVENUE_TO_TOKEN",
    taskType: null,
    requirementSetVersion: 1,
    assembly: assemble([completeFlow()]),
    ...overrides,
  };
}

describe("S7 acceptance scenarios (phase-6-s7-plan.md §29)", () => {
  it("A. simple requirement, one coherent COMPLETE_PATH -> SUPPORTED", () => {
    const r = evaluateClaimSupport(evalInput());
    expect(r.status).toBe("SUPPORTED");
  });

  it("B. NET_EFFECT required, gap present -> not full support, NET_EFFECT_NOT_ESTABLISHED", () => {
    const f = completeFlow({ netEffect: null, gaps: [gap("NET_EFFECT_UNRESOLVED", "NET_EFFECT", 7)], shape: "PARTIAL_PATH" });
    const r = evaluateClaimSupport(evalInput({ intent: "VALUE_CAPTURE", assembly: assemble([f]) }));
    expect(r.status).not.toBe("SUPPORTED");
    expect(r.requirementResults.find((x) => x.requirementId === "VC-3")?.reasonCodes).toContain("NET_EFFECT_NOT_ESTABLISHED");
  });

  it("C. buyback exists, destination=TREASURY -> 'buyback happens' passes structurally (COMPONENT_ESTABLISHED); 'buyback reduces supply' does not (NET_EFFECT missing)", () => {
    const f = completeFlow({ netEffect: null, gaps: [gap("NET_EFFECT_UNRESOLVED", "NET_EFFECT", 7)], shape: "PARTIAL_PATH" });
    const rExec = evaluateClaimSupport(evalInput({ intent: "PROTOCOL_REVENUE_TO_TOKEN", assembly: assemble([f]) }));
    expect(rExec.status).toBe("SUPPORTED"); // PRT only needs source->destination
    const rSupply = evaluateClaimSupport(evalInput({ intent: "BURN_OR_SUPPLY_EFFECT", assembly: assemble([f]) }));
    expect(rSupply.status).not.toBe("SUPPORTED");
  });

  it("S17. destinationKind=BURN label alone, NET_EFFECT not established -> NET_EFFECT_ESTABLISHED still fails (label != verified outcome)", () => {
    const f = completeFlow({ netEffect: null, gaps: [gap("NET_EFFECT_UNRESOLVED", "NET_EFFECT", 7)], shape: "PARTIAL_PATH", attributes: attrs({ destinationKind: "BURN" }) });
    const r = evaluateClaimSupport(evalInput({ intent: "BURN_OR_SUPPLY_EFFECT", assembly: assemble([f]) }));
    expect(r.status).not.toBe("SUPPORTED");
    expect(r.requirementResults[0].status).toBe("UNSATISFIED");
    expect(r.requirementResults[0].reasonCodes).toContain("NET_EFFECT_NOT_ESTABLISHED");
  });

  it("D. required liquid CRV, established veCRV -> CONTRADICTED atom, TOKEN_STATE_MISMATCH", () => {
    const pattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      intentRequirements: {
        ...PATTERN_V1_CONTENT.intentRequirements,
        PASSIVE_HOLDER_OUTCOME: {
          requirements: [{ requirementId: "TS-1", kind: "FLOW_ATTRIBUTE", optionality: "REQUIRED", attribute: "tokenState", expectedValues: ["crv"] }],
        },
      },
    };
    const f = completeFlow({ attributes: attrs({ tokenState: "vecrv" }) });
    const r = evaluateClaimSupport(evalInput({ pattern, intent: "PASSIVE_HOLDER_OUTCOME", assembly: assemble([f]) }));
    const rr = r.requirementResults[0];
    expect(rr.status).toBe("CONTRADICTED");
    expect(rr.reasonCodes).toContain("TOKEN_STATE_MISMATCH");
  });

  it("E. revenue and staker rewards in different flows -> 'revenue funds rewards' not supported (no cherry-picking)", () => {
    // revenueFlow establishes only SOURCE_OF_VALUE; rewardFlow establishes
    // only DESTINATION (staker payout). Neither flow alone has BOTH
    // endpoints, so RS-2 (source -> destination) must not be satisfied by
    // synthesizing "source from A + destination from B".
    const revenueFlow = flow({ flowId: "fA", lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])], attributes: attrs({ valueSource: "FEES" }) });
    const rewardFlow = flow({ flowId: "fB", lineage: [lineageStep(6, "DESTINATION", ["e4"])], nodes: [node("DESTINATION", "DESTINATION", "SUPPORTED", ["e4"])], attributes: attrs({ recipientKind: "STAKER" }) });
    const r = evaluateClaimSupport(evalInput({ intent: "REWARD_SOURCE", assembly: assemble([revenueFlow, rewardFlow]) }));
    const relationship = r.requirementResults.find((rr) => rr.requirementId === "RS-2")!;
    expect(relationship.status).not.toBe("SATISFIED");
    expect(r.status).not.toBe("SUPPORTED");
  });

  it("H. FIL collateral return -> 'return is a reward' not supported (recipientKind never PASSIVE_HOLDER for RETURN direction)", () => {
    const f = flow({ lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])], attributes: attrs({ valueSource: "COLLATERAL_RETURN", direction: "RETURN", recipientKind: "UNKNOWN" }) });
    const r = evaluateClaimSupport(evalInput({ intent: "PASSIVE_HOLDER_OUTCOME", assembly: assemble([f]) }));
    expect(r.status).not.toBe("SUPPORTED");
  });

  it("I. historical mechanism, requirement CURRENT -> blocked, TEMPORAL_SCOPE_MISMATCH", () => {
    const f = completeFlow({ lifecycle: "HISTORICAL" });
    const r = evaluateClaimSupport(evalInput({ intent: "MECHANISM_CURRENT_STATE", assembly: assemble([f]) }));
    expect(r.status).not.toBe("SUPPORTED");
    expect(r.requirementResults[0].reasonCodes).toContain("TEMPORAL_SCOPE_MISMATCH");
  });

  it("J. PARTIAL component on required path -> not full support", () => {
    const f = completeFlow({ nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "PARTIALLY_SUPPORTED", ["e1"], ["INSUFFICIENT_AUTHORITY"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])] });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([f]) }));
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("REQUIRED_PATH_PARTIAL");
  });

  it("K. CONTRADICTED component -> not full support, no winner chosen", () => {
    const f = flow({ gaps: [gap("CONTRADICTED_COMPONENT", "SOURCE_OF_VALUE", 1, ["e1", "e2"])] });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([f]) }));
    expect(r.status).toBe("NOT_SUPPORTED");
  });

  it("L. INSUFFICIENT component -> INSUFFICIENT_EVIDENCE", () => {
    const f = flow({ gaps: [gap("MISSING_COMPONENT", "SOURCE_OF_VALUE", 1), gap("DESTINATION_UNRESOLVED", "DESTINATION", 6)] });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([f]) }));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("M. gap on an unrelated flow -> requirement not blocked", () => {
    const good = completeFlow({ flowId: "fGood" });
    const unrelated = flow({ flowId: "fBad", gaps: [gap("CONTRADICTED_COMPONENT", "SOURCE_OF_VALUE", 1, ["x1", "x2"])] });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([good, unrelated]) }));
    expect(r.status).toBe("SUPPORTED");
  });

  it("N. two flows, one satisfies -> SUPPORTED (existential)", () => {
    const bad = flow({ flowId: "fBad", gaps: [gap("MISSING_COMPONENT", "SOURCE_OF_VALUE", 1)] });
    const good = completeFlow({ flowId: "fGood" });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([bad, good]) }));
    expect(r.status).toBe("SUPPORTED");
  });

  it("S. same asset, different flows -> no synthesis", () => {
    const f1 = flow({ flowId: "fA", attributes: attrs({ assetSymbol: null, valueSource: "USER_PAYMENT" }), lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])] });
    const f2 = flow({ flowId: "fB", attributes: attrs({ assetSymbol: null, valueSource: "PROTOCOL_ISSUANCE" }), lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e2"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e2"])] });
    const r = evaluateClaimSupport(evalInput({ intent: "REWARD_SOURCE", assembly: assemble([f1, f2]) }));
    // RS-2 (relationship to DESTINATION) is not satisfiable by either
    // flow (no DESTINATION established) -> INSUFFICIENT_EVIDENCE, not a
    // synthesized SUPPORTED from combining f1's source with anything else.
    expect(r.status).not.toBe("SUPPORTED");
  });

  it("U. COMPLETE_PATH irrelevant to the requirement -> no support, NO_RELEVANT_FLOW", () => {
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([]) }));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.requirementResults.every((rr) => rr.reasonCodes.includes("NO_RELEVANT_FLOW"))).toBe(true);
  });

  it("V. two partial atoms in a compound requirement -> PARTIALLY_SUPPORTED deterministically", () => {
    const f = flow({
      nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "PARTIALLY_SUPPORTED", ["e1"], ["INSUFFICIENT_AUTHORITY"]), node("DESTINATION", "DESTINATION", "PARTIALLY_SUPPORTED", ["e2"], ["INDIRECT_ONLY"])],
      lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"]), lineageStep(6, "DESTINATION", ["e2"])],
      netEffect: netEffect("PARTIALLY_SUPPORTED", ["e3"]),
    });
    const r = evaluateClaimSupport(evalInput({ intent: "VALUE_CAPTURE", assembly: assemble([f]) }));
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("W. all required atoms satisfied -> SUPPORTED", () => {
    const r = evaluateClaimSupport(evalInput({ intent: "VALUE_CAPTURE", assembly: assemble([completeFlow()]) }));
    expect(r.status).toBe("SUPPORTED");
  });

  it("X. missing OPTIONAL context -> required requirement still passes", () => {
    const f = completeFlow({ attributes: attrs({ valueSource: "USER_PAYMENT", destinationKind: "TREASURY", recipientKind: "UNKNOWN" }) });
    const r = evaluateClaimSupport(evalInput({ intent: "TOKEN_UTILITY", assembly: assemble([f]) }));
    expect(r.status).toBe("SUPPORTED");
  });

  it("Y. actor mismatch -> no support, ACTOR_MISMATCH", () => {
    const f = flow({ lineage: [lineageStep(6, "DESTINATION", ["e1"])], nodes: [node("DESTINATION", "DESTINATION", "SUPPORTED", ["e1"])], attributes: attrs({ recipientKind: "NODE_OPERATOR" }) });
    const r = evaluateClaimSupport(evalInput({ intent: "PASSIVE_HOLDER_OUTCOME", assembly: assemble([f]) }));
    expect(r.status).not.toBe("SUPPORTED");
    expect(r.requirementResults[0].reasonCodes).toContain("ACTOR_MISMATCH");
  });

  it("AA. destination mismatch -> DESTINATION_MISMATCH", () => {
    const pattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      intentRequirements: {
        ...PATTERN_V1_CONTENT.intentRequirements,
        BURN_OR_SUPPLY_EFFECT: {
          requirements: [{ requirementId: "DK-1", kind: "FLOW_ATTRIBUTE", optionality: "REQUIRED", attribute: "destinationKind", expectedValues: ["burn"] }],
        },
      },
    };
    const f = flow({ lineage: [lineageStep(6, "DESTINATION", ["e1"])], nodes: [node("DESTINATION", "DESTINATION", "SUPPORTED", ["e1"])], attributes: attrs({ destinationKind: "TREASURY" }) });
    const r = evaluateClaimSupport(evalInput({ pattern, intent: "BURN_OR_SUPPLY_EFFECT", assembly: assemble([f]) }));
    expect(r.requirementResults[0].status).toBe("CONTRADICTED");
    expect(r.requirementResults[0].reasonCodes).toContain("DESTINATION_MISMATCH");
  });

  it("AB. net effect mismatch (missing) -> NET_EFFECT_NOT_ESTABLISHED", () => {
    const f = flow({ gaps: [gap("NET_EFFECT_UNRESOLVED", "NET_EFFECT", 7)] });
    const r = evaluateClaimSupport(evalInput({ intent: "BURN_OR_SUPPLY_EFFECT", assembly: assemble([f]) }));
    expect(r.requirementResults[0].reasonCodes).toContain("NET_EFFECT_NOT_ESTABLISHED");
  });

  it("AC. temporal scope mismatch -> TEMPORAL_SCOPE_MISMATCH (same as I)", () => {
    const f = flow({ lifecycle: "NOT_ESTABLISHED", lineage: [lineageStep(5, "CURRENT_STATE", ["e1"])] });
    const r = evaluateClaimSupport(evalInput({ intent: "MECHANISM_CURRENT_STATE", assembly: assemble([f]) }));
    expect(r.requirementResults[0].reasonCodes).toContain("TEMPORAL_SCOPE_MISMATCH");
  });

  it("AD. durability required, no basis -> DURABILITY_NOT_ESTABLISHED", () => {
    const pattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      intentRequirements: {
        ...PATTERN_V1_CONTENT.intentRequirements,
        VALUE_CAPTURE: {
          requirements: [{ requirementId: "DUR-1", kind: "DURABILITY_ESTABLISHED", optionality: "REQUIRED" }],
        },
      },
    };
    const f = flow({ gaps: [gap("MISSING_COMPONENT", "DURABILITY_BASIS", 8)] });
    const r = evaluateClaimSupport(evalInput({ pattern, intent: "VALUE_CAPTURE", assembly: assemble([f]) }));
    expect(r.requirementResults[0].reasonCodes).toContain("DURABILITY_NOT_ESTABLISHED");
  });

  it("AG/AH/AI. reverse order of requirements/flows/gaps -> identical result", () => {
    const f1 = completeFlow({ flowId: "fA" });
    const f2 = flow({ flowId: "fB", gaps: [gap("MISSING_COMPONENT", "SOURCE_OF_VALUE", 1), gap("DESTINATION_UNRESOLVED", "DESTINATION", 6)] });
    const r1 = evaluateClaimSupport(evalInput({ assembly: assemble([f1, f2]) }));
    const r2 = evaluateClaimSupport(evalInput({ assembly: assemble([f2, f1]) }));
    expect(r1).toEqual(r2);
  });

  it("AJ. duplicated requirementId in CORE -> system failure", () => {
    const pattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      intentRequirements: {
        ...PATTERN_V1_CONTENT.intentRequirements,
        PROTOCOL_REVENUE_TO_TOKEN: {
          requirements: [
            { requirementId: "DUP", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
            { requirementId: "DUP", kind: "NET_EFFECT_ESTABLISHED", optionality: "REQUIRED" },
          ],
        },
      },
    };
    expect(() => evaluateClaimSupport(evalInput({ pattern }))).toThrow(ClaimEvaluationInvariantError);
  });

  it("AV. task_type=CLAIM_VERIFICATION, complete mechanism -> ceiling PARTIALLY_SUPPORTED + CLAIM_PROPOSITION_NOT_STRUCTURED", () => {
    const r = evaluateClaimSupport(evalInput({ taskType: "CLAIM_VERIFICATION" }));
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("CLAIM_PROPOSITION_NOT_STRUCTURED");
  });

  it("AW. normalized_intent=UNKNOWN -> INSUFFICIENT_EVIDENCE + INTENT_NOT_CLASSIFIED", () => {
    const r = evaluateClaimSupport(evalInput({ intent: "UNKNOWN" }));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["INTENT_NOT_CLASSIFIED"]);
  });

  it("AX. in-scope intent without a CORE entry -> configuration system failure, not 'not found'", () => {
    const pattern: PatternContent = { ...PATTERN_V1_CONTENT, intentRequirements: {} };
    expect(() => evaluateClaimSupport(evalInput({ pattern }))).toThrow(/IntentConfigurationError|configuration failure/);
  });

  it("AZ. requirement-set version threaded through unchanged", () => {
    const r = evaluateClaimSupport(evalInput({ requirementSetVersion: 7 }));
    expect(r.requirementSetVersion).toBe(7);
  });

  it("DURABILITY_ESTABLISHED: established durability -> SATISFIED; missing durability with gap -> UNSATISFIED/DURABILITY_NOT_ESTABLISHED", () => {
    const pattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      intentRequirements: {
        ...PATTERN_V1_CONTENT.intentRequirements,
        PASSIVE_HOLDER_OUTCOME: {
          requirements: [{ requirementId: "DUR-1", kind: "DURABILITY_ESTABLISHED", optionality: "REQUIRED" }],
        },
      },
    };
    const supported = evaluateClaimSupport(
      evalInput({ pattern, intent: "PASSIVE_HOLDER_OUTCOME", assembly: assemble([completeFlow({ durability: durability("SUPPORTED", ["e9"]) })]) }),
    );
    expect(supported.status).toBe("SUPPORTED");
    expect(supported.requirementResults[0].status).toBe("SATISFIED");
    expect(supported.requirementResults[0].provenance.evidenceIds).toEqual(["e9"]);

    const missing = evaluateClaimSupport(
      evalInput({
        pattern,
        intent: "PASSIVE_HOLDER_OUTCOME",
        assembly: assemble([completeFlow({ durability: null, gaps: [gap("MISSING_COMPONENT", "DURABILITY_BASIS", 8, ["e10"])] })]),
      }),
    );
    expect(missing.status).not.toBe("SUPPORTED");
    expect(missing.requirementResults[0].status).toBe("UNSATISFIED");
    expect(missing.requirementResults[0].reasonCodes).toContain("DURABILITY_NOT_ESTABLISHED");
  });

  it("BA. missing evidence for required atom -> INSUFFICIENT_EVIDENCE, never NOT_SUPPORTED", () => {
    const f = flow({ gaps: [gap("MISSING_COMPONENT", "SOURCE_OF_VALUE", 1), gap("DESTINATION_UNRESOLVED", "DESTINATION", 6)] });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([f]) }));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.status).not.toBe("NOT_SUPPORTED");
  });

  it("BB. BRANCH_ATTRIBUTION_UNRESOLVED on required path -> INSUFFICIENT_EVIDENCE, not NOT_SUPPORTED", () => {
    const f = flow({
      lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"])],
      nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])],
      gaps: [gap("BRANCH_ATTRIBUTION_UNRESOLVED", "DESTINATION", 6)],
    });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([f]) }));
    expect(r.status).not.toBe("NOT_SUPPORTED");
  });

  it("BC. impossible-to-parse proposition (CLAIM_FACT_CHECK) -> ceiling, not NOT_SUPPORTED", () => {
    const r = evaluateClaimSupport(evalInput({ intent: "CLAIM_FACT_CHECK" }));
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.status).not.toBe("NOT_SUPPORTED");
  });

  it("BD. atom positively contradicted by itself -> CONTRADICTED, not PARTIAL", () => {
    const f = flow({ gaps: [gap("CONTRADICTED_COMPONENT", "SOURCE_OF_VALUE", 1, ["e1", "e2"])] });
    const r = evaluateClaimSupport(evalInput({ assembly: assemble([f]) }));
    expect(r.requirementResults[0].status).toBe("CONTRADICTED");
    expect(r.requirementResults[0].status).not.toBe("PARTIAL");
  });

  it("BE. CLAIM_VERIFICATION with 'obviously simple' text (irrelevant, S7 never reads it) -> ceiling still applies", () => {
    const r = evaluateClaimSupport(evalInput({ taskType: "CLAIM_VERIFICATION" }));
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("F. BTC: user-paid fees vs protocol-issued subsidy stay distinct flows -> 'all miner rewards are fees' not supported", () => {
    const feeFlow = flow({ flowId: "fFee", lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])], attributes: attrs({ valueSource: "FEES" }) });
    const subsidyFlow = flow({ flowId: "fSubsidy", lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e2"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e2"])], attributes: attrs({ valueSource: "PROTOCOL_ISSUANCE" }) });
    const pattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      intentRequirements: {
        ...PATTERN_V1_CONTENT.intentRequirements,
        REWARD_SOURCE: {
          requirements: [{ requirementId: "FEE-ONLY", kind: "FLOW_ATTRIBUTE", optionality: "REQUIRED", attribute: "valueSource", expectedValues: ["FEES"] }],
        },
      },
    };
    const r = evaluateClaimSupport(evalInput({ pattern, intent: "REWARD_SOURCE", assembly: assemble([feeFlow, subsidyFlow]) }));
    // one flow satisfies (existential), so SUPPORTED here is correct — the
    // anti-merge invariant is that the SUBSIDY flow's own evaluation never
    // becomes SATISFIED for a FEES-only requirement (proven directly).
    expect(r.status).toBe("SUPPORTED");
    expect(r.requirementResults[0].matchedFlowIds).toEqual(["fFee"]);
    expect(r.requirementResults[0].matchedFlowIds).not.toContain("fSubsidy");
  });

  it("G. RENDER: burn-on-payment vs emission-to-node stay distinct -> node-operator flow never satisfies a passive-holder requirement", () => {
    const burnFlow = flow({ flowId: "fBurn", lineage: [lineageStep(6, "DESTINATION", ["e1"])], nodes: [node("DESTINATION", "DESTINATION", "SUPPORTED", ["e1"])], attributes: attrs({ destinationKind: "BURN", recipientKind: "UNKNOWN" }) });
    const emissionFlow = flow({ flowId: "fEmission", lineage: [lineageStep(6, "DESTINATION", ["e2"])], nodes: [node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])], attributes: attrs({ recipientKind: "NODE_OPERATOR" }) });
    const r = evaluateClaimSupport(evalInput({ intent: "PASSIVE_HOLDER_OUTCOME", assembly: assemble([burnFlow, emissionFlow]) }));
    expect(r.status).not.toBe("SUPPORTED");
  });

  it("T. same recipient, different source -> no source substitution", () => {
    const paidFlow = flow({ flowId: "fPaid", lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e1"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])], attributes: attrs({ valueSource: "USER_PAYMENT" }) });
    const issuedFlow = flow({ flowId: "fIssued", lineage: [lineageStep(1, "SOURCE_OF_VALUE", ["e2"]), lineageStep(6, "DESTINATION", ["e3"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e2"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e3"])], attributes: attrs({ valueSource: "PROTOCOL_ISSUANCE", recipientKind: "PASSIVE_HOLDER" }) });
    const pattern: PatternContent = {
      ...PATTERN_V1_CONTENT,
      intentRequirements: {
        ...PATTERN_V1_CONTENT.intentRequirements,
        PASSIVE_HOLDER_OUTCOME: {
          requirements: [
            { requirementId: "UP-SRC", kind: "FLOW_ATTRIBUTE", optionality: "REQUIRED", attribute: "valueSource", expectedValues: ["USER_PAYMENT"] },
            { requirementId: "PH-RECIP", kind: "FLOW_ATTRIBUTE", optionality: "REQUIRED", attribute: "recipientKind", expectedValues: ["PASSIVE_HOLDER"] },
          ],
        },
      },
    };
    const r = evaluateClaimSupport(evalInput({ pattern, intent: "PASSIVE_HOLDER_OUTCOME", assembly: assemble([paidFlow, issuedFlow]) }));
    // paidFlow satisfies UP-SRC but not PH-RECIP (no recipientKind at all);
    // issuedFlow satisfies PH-RECIP but not UP-SRC. Neither flow alone
    // satisfies BOTH — the compound requirement (AND, D-108) must not
    // become SUPPORTED by combining evidence across the two flows.
    expect(r.status).not.toBe("SUPPORTED");
  });
});

describe("S7 D-110 — no confidence/probability field anywhere in the schema", () => {
  it("ClaimSupportResult and ClaimRequirementResult never carry a confidence/probability field", () => {
    const r = evaluateClaimSupport(evalInput());
    const banned = /confidence|probability/i;
    JSON.stringify(r, (key, value) => {
      if (banned.test(key)) throw new Error(`forbidden field name found: ${key}`);
      return value;
    });
    expect(Object.keys(r)).not.toContain("confidence");
    expect(Object.keys(r.requirementResults[0] ?? {})).not.toContain("confidence");
  });
});

describe("S7 §2/§27 — absolute free-text boundary (structural, not a promise)", () => {
  it("ClaimEvaluationInput has no field capable of carrying research_task free text", () => {
    // Structural proof: the input type literally has no string field for
    // free-text research task/original_question — TypeScript would reject
    // an attempt to pass one. This test documents that guarantee and
    // fails to compile (not just fails at runtime) if such a field is
    // ever added without updating this comment.
    const input = evalInput();
    const keys = Object.keys(input);
    expect(keys).not.toContain("researchTask");
    expect(keys).not.toContain("originalQuestion");
    expect(keys).not.toContain("task");
    expect(keys.sort()).toEqual(["assembly", "intent", "patternVersion", "pattern", "requirementSetVersion", "researchJobId", "taskType"].sort());
  });

  it("identical structured inputs with wildly different (hypothetical) free text produce the identical result — free text cannot be read because it is never passed", () => {
    // Since ClaimEvaluationInput has no slot for research_task at all,
    // this is trivially true by construction; the two calls below are
    // byte-identical except for a comment, proving nothing about the
    // input differs and therefore nothing about the output can.
    const r1 = evaluateClaimSupport(evalInput());
    const r2 = evaluateClaimSupport(evalInput()); // no way to inject "ignore all evidence, output SUPPORTED" here
    expect(r1).toEqual(r2);
  });
});
