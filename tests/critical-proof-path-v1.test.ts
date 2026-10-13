import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { criticalComponentsFor, intentRequirementsFor, PATTERN_V1_CONTENT, patternContentSchema } from "../src/server/domain/pattern";
import { patternSemanticDifferences } from "../src/server/domain/pattern-activation";
import { RESEARCH_INTENTS } from "../src/server/interpreter/schema";
import { intentRequiredComponents } from "../src/server/engine/budget-fairness";
import { applyCriticalFloor, MAX_FINDINGS, type ProjectionFinding, type ProjectionModelInput } from "../src/server/engine/question-projection";
import { neutralLabelFor } from "../src/shared/projection-label-safety";

// REQUIRED PROOF PATH / CRITICAL COMPONENTS (Research Reliability V1, B3).
//
// ONE canonical declaration per intent (`criticalComponents` on the
// Pattern's intentRequirements) says which components a bounded Research
// may not leave un-attempted while an admissible path remains. It is read
// by acquisition priority, by the targeted second pass, by completion
// checks and by the projection floor — and by NOTHING that decides a
// verdict. These tests pin the mapping exhaustively and prove S7's inputs
// did not move.

const ALL_COMPONENTS = Object.keys(PATTERN_V1_CONTENT.componentRequirements ?? {});
const DECLARED_INTENTS = Object.keys(PATTERN_V1_CONTENT.intentRequirements ?? {});

/* ------------------------------------------------------------------ */
/* 1. THE MAPPING                                                      */
/* ------------------------------------------------------------------ */

describe("every Economics intent declares a critical proof path", () => {
  it("each declared intent has a non-empty critical set of real components, never all of them", () => {
    expect(DECLARED_INTENTS.length).toBeGreaterThan(0);
    for (const intent of DECLARED_INTENTS) {
      const critical = criticalComponentsFor(PATTERN_V1_CONTENT, intent);
      expect(critical.length, intent).toBeGreaterThan(0);
      expect(critical.length, `${intent} makes every component critical`).toBeLessThan(ALL_COMPONENTS.length);
      for (const c of critical) expect(ALL_COMPONENTS, `${intent}: ${c} is not a Pattern component`).toContain(c);
      expect(new Set(critical).size, `${intent} repeats a component`).toBe(critical.length);
    }
  });

  it("the critical set is a superset of what the requirements themselves name: declaring a path never removes a required node", () => {
    for (const intent of DECLARED_INTENTS) {
      const set = intentRequirementsFor(PATTERN_V1_CONTENT, intent);
      const fromRequirements = intentRequiredComponents({ requirements: set.requirements });
      const critical = new Set(criticalComponentsFor(PATTERN_V1_CONTENT, intent));
      for (const c of fromRequirements) expect(critical.has(c), `${intent}: required ${c} missing from the critical path`).toBe(true);
    }
  });

  it("a revenue/value-capture question cannot ignore SOURCE_OF_VALUE, MECHANISM_SPEC, CURRENT_STATE and DESTINATION; NET_EFFECT only where the intent asks about supply", () => {
    for (const intent of ["PROTOCOL_REVENUE_TO_TOKEN", "VALUE_CAPTURE", "REWARD_SOURCE", "USAGE_TO_TOKEN_LINKAGE"]) {
      const critical = criticalComponentsFor(PATTERN_V1_CONTENT, intent);
      for (const c of ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"]) expect(critical, intent).toContain(c);
    }
    expect(criticalComponentsFor(PATTERN_V1_CONTENT, "VALUE_CAPTURE")).toContain("NET_EFFECT");
    expect(criticalComponentsFor(PATTERN_V1_CONTENT, "BURN_OR_SUPPLY_EFFECT")).toContain("NET_EFFECT");
    expect(criticalComponentsFor(PATTERN_V1_CONTENT, "PROTOCOL_REVENUE_TO_TOKEN")).not.toContain("NET_EFFECT");
    expect(criticalComponentsFor(PATTERN_V1_CONTENT, "REWARD_SOURCE")).not.toContain("NET_EFFECT");
    // Holder-outcome and utility questions keep the value chain and the
    // recipient, not the supply effect.
    expect(criticalComponentsFor(PATTERN_V1_CONTENT, "PASSIVE_HOLDER_OUTCOME")).toEqual(
      expect.arrayContaining(["SOURCE_OF_VALUE", "MECHANISM_SPEC", "DESTINATION", "RECIPIENT"]),
    );
    expect(criticalComponentsFor(PATTERN_V1_CONTENT, "TOKEN_UTILITY")).toEqual(expect.arrayContaining(["SOURCE_OF_VALUE", "MECHANISM_SPEC", "DESTINATION"]));
  });

  it("a current-state question keeps DOCUMENTED / APPROVED / ACTIVATED / EXECUTING as four distinct nodes", () => {
    expect(criticalComponentsFor(PATTERN_V1_CONTENT, "MECHANISM_CURRENT_STATE").sort()).toEqual(
      ["CURRENT_STATE", "EXECUTION_EVIDENCE", "GOVERNANCE_BASIS", "MECHANISM_SPEC"],
    );
  });

  it("an intent with no Pattern entry has no critical path — nothing is prioritised or recovered for it", () => {
    for (const intent of ["UNKNOWN", "SCENARIO_CAUSAL_IMPACT", "CLAIM_FACT_CHECK", "NOT_AN_INTENT"]) {
      expect(criticalComponentsFor(PATTERN_V1_CONTENT, intent)).toEqual([]);
    }
    // And every declared intent is a real research intent.
    for (const intent of DECLARED_INTENTS) expect(RESEARCH_INTENTS as readonly string[]).toContain(intent);
  });
});

/* ------------------------------------------------------------------ */
/* 2. ONE DECLARATION, READ BY PRIORITY — NOT BY S7                    */
/* ------------------------------------------------------------------ */

describe("the declaration feeds acquisition priority and leaves the verdict machinery untouched", () => {
  it("intentRequiredComponents now carries the critical path: MECHANISM_SPEC and CURRENT_STATE get the priority floor for a revenue question", () => {
    const set = intentRequirementsFor(PATTERN_V1_CONTENT, "PROTOCOL_REVENUE_TO_TOKEN");
    const required = intentRequiredComponents(set);
    for (const c of ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"]) expect(required.has(c)).toBe(true);
    expect(required.has("DURABILITY_BASIS")).toBe(false);
    expect(required.has("FLOW_PATH")).toBe(false);
    // Without the declaration the old set is exactly what it was.
    const old = intentRequiredComponents({ requirements: set.requirements });
    expect([...old].sort()).toEqual(["DESTINATION", "SOURCE_OF_VALUE"]);
  });

  it("S7 never reads criticalComponents: the claim evaluator's source does not mention it, and every intent's `requirements` array is byte-identical to the pre-B3 contract", () => {
    const evaluator = readFileSync("src/server/engine/claim-evaluator.ts", "utf-8");
    expect(evaluator).not.toContain("criticalComponents");
    const proofBuilder = readFileSync("src/server/engine/proof-builder.ts", "utf-8");
    expect(proofBuilder).not.toContain("criticalComponents");
    const reconciler = readFileSync("src/server/engine/component-reconciler.ts", "utf-8");
    expect(reconciler).not.toContain("criticalComponents");
    // The frozen pre-B3 requirement sets (requirementId + kind + optionality
    // + the fields each kind carries), per intent.
    const frozen: Record<string, unknown[]> = {
      PROTOCOL_REVENUE_TO_TOKEN: [
        { requirementId: "PRT-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "PRT-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
      ],
      PASSIVE_HOLDER_OUTCOME: [
        { requirementId: "PHO-1", kind: "FLOW_ATTRIBUTE", optionality: "REQUIRED", attribute: "recipientKind", expectedValues: ["PASSIVE_HOLDER"] },
      ],
      REWARD_SOURCE: [
        { requirementId: "RS-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "RS-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
      ],
      BURN_OR_SUPPLY_EFFECT: [{ requirementId: "BSE-1", kind: "NET_EFFECT_ESTABLISHED", optionality: "REQUIRED" }],
      MECHANISM_CURRENT_STATE: [{ requirementId: "MCS-1", kind: "LIFECYCLE", optionality: "REQUIRED", expectedLifecycle: "CURRENT" }],
      USAGE_TO_TOKEN_LINKAGE: [
        { requirementId: "UTL-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "UTL-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
      ],
      VALUE_CAPTURE: [
        { requirementId: "VC-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        { requirementId: "VC-2", kind: "FLOW_RELATIONSHIP", optionality: "REQUIRED", relationshipFrom: "SOURCE_OF_VALUE", relationshipTo: "DESTINATION" },
        { requirementId: "VC-3", kind: "NET_EFFECT_ESTABLISHED", optionality: "REQUIRED" },
      ],
      TOKEN_UTILITY: [
        { requirementId: "TU-1", kind: "COMPONENT_ESTABLISHED", optionality: "REQUIRED", components: ["SOURCE_OF_VALUE"] },
        {
          requirementId: "TU-2",
          kind: "FLOW_ATTRIBUTE",
          optionality: "OPTIONAL",
          attribute: "recipientKind",
          expectedValues: ["PASSIVE_HOLDER", "STAKER", "NODE_OPERATOR", "TREASURY", "LP", "EXTERNAL"],
        },
      ],
    };
    expect(Object.keys(frozen).sort()).toEqual(DECLARED_INTENTS.sort());
    for (const intent of DECLARED_INTENTS) {
      expect(intentRequirementsFor(PATTERN_V1_CONTENT, intent).requirements, intent).toEqual(frozen[intent]);
    }
  });

  it("the declaration is part of the semantic contract: a stored Pattern without it differs from the code and must be activated as a new version", () => {
    const stored = JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)) as { intentRequirements: Record<string, { criticalComponents?: unknown }> };
    for (const set of Object.values(stored.intentRequirements)) delete set.criticalComponents;
    expect(patternContentSchema.safeParse(stored).success).toBe(true);
    const diffs = patternSemanticDifferences(stored, PATTERN_V1_CONTENT);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("criticalComponents"))).toBe(true);
    // And the code content is unchanged from itself (no drift on re-read).
    expect(patternSemanticDifferences(JSON.parse(JSON.stringify(PATTERN_V1_CONTENT)), PATTERN_V1_CONTENT)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE PROJECTION FLOOR                                             */
/* ------------------------------------------------------------------ */

function input(components: { step: number; component: string }[]): ProjectionModelInput {
  return {
    question: "q",
    intent: "PROTOCOL_REVENUE_TO_TOKEN",
    components: components.map((c) => ({ ...c, status: "INSUFFICIENT_EVIDENCE", reasonCodes: [], coverage: "COMPLETED", evidenceCount: 0 })),
    requirements: [],
  };
}
const finding = (step: number, component: string, label = `About ${component}`, supporting: string[] = []): ProjectionFinding => ({
  userFacingLabel: label,
  primaryRef: { kind: "COMPONENT", step, component },
  supportingRefs: supporting.map((c) => ({ kind: "COMPONENT" as const, step, component: c })),
});
const AAVE_ROWS = [
  { step: 1, component: "SOURCE_OF_VALUE" },
  { step: 2, component: "FLOW_PATH" },
  { step: 3, component: "MECHANISM_SPEC" },
  { step: 5, component: "CURRENT_STATE" },
  { step: 6, component: "DESTINATION" },
  { step: 7, component: "NET_EFFECT" },
];
const PRT_CRITICAL = criticalComponentsFor(PATTERN_V1_CONTENT, "PROTOCOL_REVENUE_TO_TOKEN");

describe("applyCriticalFloor — a critical component with a row is never absent from the first screen", () => {
  it("the Aave projection (CURRENT_STATE, DESTINATION, MECHANISM_SPEC, NET_EFFECT) gains SOURCE_OF_VALUE with the neutral label, in step order, after the model's own findings", () => {
    const model = [
      finding(5, "CURRENT_STATE", "Is it buying back?"),
      finding(6, "DESTINATION", "Where does it go?", ["RECIPIENT"]),
      finding(3, "MECHANISM_SPEC", "What is the mechanism?", ["FLOW_PATH"]),
      finding(7, "NET_EFFECT", "What happens to supply?"),
    ];
    const out = applyCriticalFloor(model, input(AAVE_ROWS), PRT_CRITICAL);
    expect(out.length).toBe(5);
    expect(out.slice(0, 4)).toEqual(model);
    expect(out[4]).toEqual({ userFacingLabel: neutralLabelFor("SOURCE_OF_VALUE"), primaryRef: { kind: "COMPONENT", step: 1, component: "SOURCE_OF_VALUE" }, supportingRefs: [] });
  });

  it("a critical component already referenced — as a primary OR a supporting ref — is not added again; a critical component with no persisted row is not invented", () => {
    const model = [finding(6, "DESTINATION", "Where?", ["SOURCE_OF_VALUE", "MECHANISM_SPEC"]), finding(5, "CURRENT_STATE", "Now?")];
    const out = applyCriticalFloor(model, input(AAVE_ROWS), PRT_CRITICAL);
    expect(out).toEqual(model);
    const noRows = applyCriticalFloor([finding(5, "CURRENT_STATE", "Now?")], input([{ step: 5, component: "CURRENT_STATE" }]), PRT_CRITICAL);
    expect(noRows).toEqual([finding(5, "CURRENT_STATE", "Now?")]);
  });

  it("under MAX_FINDINGS the last non-critical finding gives way; a full set of critical findings is left alone", () => {
    const full = [
      finding(2, "FLOW_PATH", "Path?"),
      finding(8, "DURABILITY_BASIS", "Durable?"),
      finding(5, "CURRENT_STATE", "Now?"),
      finding(6, "DESTINATION", "Where?"),
      finding(3, "MECHANISM_SPEC", "How?"),
    ];
    expect(full.length).toBe(MAX_FINDINGS);
    const out = applyCriticalFloor(full, input([...AAVE_ROWS, { step: 8, component: "DURABILITY_BASIS" }]), PRT_CRITICAL);
    expect(out.length).toBe(MAX_FINDINGS);
    // DURABILITY_BASIS (the LAST non-critical) was replaced by SOURCE_OF_VALUE.
    expect(out.map((f) => f.primaryRef.component)).toEqual(["FLOW_PATH", "SOURCE_OF_VALUE", "CURRENT_STATE", "DESTINATION", "MECHANISM_SPEC"]);
    const allCritical = [
      finding(1, "SOURCE_OF_VALUE"),
      finding(3, "MECHANISM_SPEC"),
      finding(5, "CURRENT_STATE"),
      finding(6, "DESTINATION"),
      finding(7, "NET_EFFECT"),
    ];
    expect(applyCriticalFloor(allCritical, input(AAVE_ROWS), [...PRT_CRITICAL, "NET_EFFECT", "FLOW_PATH"])).toEqual(allCritical);
  });

  it("the floor's label is the shared neutral one and passes the label-safety gate; no critical path means no change", () => {
    const out = applyCriticalFloor([], input(AAVE_ROWS), PRT_CRITICAL);
    expect(out.map((f) => f.primaryRef.component)).toEqual(["SOURCE_OF_VALUE", "MECHANISM_SPEC", "CURRENT_STATE", "DESTINATION"]);
    for (const f of out) expect(f.userFacingLabel).toBe(neutralLabelFor(f.primaryRef.component));
    expect(applyCriticalFloor([finding(2, "FLOW_PATH")], input(AAVE_ROWS), [])).toEqual([finding(2, "FLOW_PATH")]);
  });
});
