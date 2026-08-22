import type { PatternContent, ClaimRequirement } from "../domain/pattern";
import { intentRequirementsFor } from "../domain/pattern";
import type { MechanismAssemblyResult, MechanismFlow, MechanismGapKind } from "./mechanism-assembler";

// Phase 6, S7 — Claim-Level Support (phase-6-s7-plan.md, D-105..D-111).
//
// Pure, deterministic, model-free, network-free. Consumes the frozen S6
// MechanismAssemblyResult and a CORE-authored IntentRequirementSet
// (Pattern.intentRequirements, D-105) and produces a ClaimSupportResult.
// S7 never re-adjudicates S5/S6: existence, classification, gaps, and
// lifecycle are read verbatim from S6's output — this file only asks
// "do the atoms this intent requires hold on some coherent S6 flow?"
//
// S7 v1 is INTENT-SUFFICIENCY JUDGMENT (§3.3), not arbitrary natural-
// language claim verification: research_task free text is never read
// here, by construction — this module's input type has no field for it.

export type ClaimSupportStatus = "SUPPORTED" | "PARTIALLY_SUPPORTED" | "NOT_SUPPORTED" | "INSUFFICIENT_EVIDENCE";
export type ClaimRequirementStatus = "SATISFIED" | "PARTIAL" | "CONTRADICTED" | "UNSATISFIED";

// §20 — the closed, 20-member reason code vocabulary. No free text, no
// dynamically constructed codes.
export type ClaimReasonCode =
  | "REQUIRED_COMPONENT_MISSING"
  | "REQUIRED_ATOM_UNSATISFIED"
  | "REQUIRED_PATH_PARTIAL"
  | "REQUIRED_PATH_CONTRADICTED"
  | "REQUIRED_RELATIONSHIP_UNRESOLVED"
  | "TOKEN_STATE_MISMATCH"
  | "ACTOR_MISMATCH"
  | "DESTINATION_MISMATCH"
  | "TEMPORAL_SCOPE_MISMATCH"
  | "NET_EFFECT_NOT_ESTABLISHED"
  | "DURABILITY_NOT_ESTABLISHED"
  | "FLOW_IDENTITY_UNRESOLVED"
  | "BRANCH_ATTRIBUTION_UNRESOLVED"
  | "FLOW_ENUMERATION_INCOMPLETE"
  | "NUMERIC_VALUE_NOT_ESTABLISHED"
  | "QUANTIFIER_NOT_ESTABLISHED"
  | "STRENGTH_NOT_ESTABLISHED"
  | "CLAIM_PROPOSITION_NOT_STRUCTURED"
  | "INTENT_NOT_CLASSIFIED"
  | "NO_RELEVANT_FLOW";

export interface MechanismGapRef {
  flowId: string | null;
  kind: MechanismGapKind;
  component: string | null;
  afterStep: number | null;
}

export interface ClaimProvenance {
  flowIds: string[];
  componentResultKeys: { step: number; component: string }[];
  evidenceIds: string[];
}

export interface ClaimRequirementResult {
  requirementId: string;
  optionality: "REQUIRED" | "OPTIONAL";
  status: ClaimRequirementStatus;
  reasonCodes: ClaimReasonCode[];
  matchedFlowIds: string[];
  blockingGaps: MechanismGapRef[];
  provenance: ClaimProvenance;
}

// D-110 — deliberately no confidence/probability field anywhere in this
// schema; checked by a dedicated regression test, same discipline as
// S6's D-103 test.
export interface ClaimSupportResult {
  researchJobId: string;
  patternVersion: number;
  intent: string;
  requirementSetVersion: number;
  status: ClaimSupportStatus;
  reasonCodes: ClaimReasonCode[];
  requirementResults: ClaimRequirementResult[];
  contextGaps: MechanismGapRef[];
}

export interface ClaimEvaluationInput {
  researchJobId: string;
  patternVersion: number;
  pattern: PatternContent;
  intent: string;
  taskType: string | null;
  requirementSetVersion: number;
  assembly: MechanismAssemblyResult;
}

// §25 — closed system-failure vocabulary. Everything else is a
// successful ClaimSupportResult (SUPPORTED/PARTIALLY_SUPPORTED/
// NOT_SUPPORTED/INSUFFICIENT_EVIDENCE are ALL success, never a failure).
export class ClaimEvaluationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimEvaluationInvariantError";
  }
}

const EMPTY_PROVENANCE: ClaimProvenance = { flowIds: [], componentResultKeys: [], evidenceIds: [] };

function sortedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function gapRef(flowId: string | null, gap: { kind: MechanismGapKind; component: string | null; afterStep: number | null }): MechanismGapRef {
  return { flowId, kind: gap.kind, component: gap.component, afterStep: gap.afterStep };
}

// The Pattern-step components a flow's lineage carries, as a lookup by
// component name. Used only to ask "is this component an established
// element ON THIS flow" — never to recompute its status (read verbatim).
function lineageComponentStatus(flow: MechanismFlow, component: string): "SUPPORTED" | "PARTIALLY_SUPPORTED" | null {
  const node = flow.nodes.find((n) => n.component === component);
  if (node) return node.componentStatus === "PARTIALLY_SUPPORTED" ? "PARTIALLY_SUPPORTED" : "SUPPORTED";
  if (component === "NET_EFFECT" && flow.netEffect) return flow.netEffect.componentStatus === "PARTIALLY_SUPPORTED" ? "PARTIALLY_SUPPORTED" : "SUPPORTED";
  if (component === "DURABILITY_BASIS" && flow.durability) return flow.durability.componentStatus === "PARTIALLY_SUPPORTED" ? "PARTIALLY_SUPPORTED" : "SUPPORTED";
  // GOVERNANCE_BASIS / RECIPIENT / FLOW_PATH / EXECUTION_EVIDENCE /
  // CURRENT_STATE are not their own node in S6's model (§4) — check the
  // lineage step directly for a positional match instead.
  const step = flow.lineage.find((s) => s.component === component);
  return step ? "SUPPORTED" : null;
}

function gapsForComponentOnFlow(flow: MechanismFlow, component: string): MechanismGapRef[] {
  return flow.gaps.filter((g) => g.component === component).map((g) => gapRef(flow.flowId, g));
}

// A CONTRADICTED_COMPONENT gap's own S6 provenance carries the
// contradicting evidence ids (§18 of the S6 plan: "both id sets"). This
// is what makes a CONTRADICTED atom's own provenance invariant (§22)
// satisfiable without S7 inventing or re-deriving anything.
function gapEvidenceIds(flow: MechanismFlow, kinds: MechanismGapKind[], component?: string): string[] {
  const ids: string[] = [];
  for (const g of flow.gaps) {
    if (!kinds.includes(g.kind)) continue;
    if (component !== undefined && g.component !== component) continue;
    ids.push(...g.provenance.evidenceIds);
  }
  return sortedIds(ids);
}

// Fallback provenance for a FLOW_ATTRIBUTE/LIFECYCLE verdict: S6 does not
// expose which single lineage step's text produced a given classification
// or lifecycle value, so the whole flow's established evidence anchors
// the claim ("this flow, as a whole, is what carries this attribute").
function allFlowEvidenceIds(flow: MechanismFlow): string[] {
  const ids: string[] = [];
  for (const step of flow.lineage) ids.push(...step.evidenceIds);
  return sortedIds(ids);
}

function evidenceIdsForComponentsOnFlow(flow: MechanismFlow, components: string[]): string[] {
  const ids: string[] = [];
  for (const step of flow.lineage) {
    if (components.includes(step.component)) ids.push(...step.evidenceIds);
  }
  if (components.includes("NET_EFFECT") && flow.netEffect) ids.push(...flow.netEffect.provenance.evidenceIds);
  if (components.includes("DURABILITY_BASIS") && flow.durability) ids.push(...flow.durability.provenance.evidenceIds);
  return sortedIds(ids);
}

interface FlowVerdict {
  status: ClaimRequirementStatus;
  reasonCodes: ClaimReasonCode[];
  blockingGaps: MechanismGapRef[];
  evidenceIds: string[];
  componentResultKeys: { step: number; component: string }[];
}

// COMPONENT_ESTABLISHED — every referenced component must be an
// established element on THIS flow (D-108: never combine across flows,
// automatic here since a single flow is evaluated at a time).
function evaluateComponentEstablished(req: ClaimRequirement, flow: MechanismFlow): FlowVerdict | null {
  const components = req.components ?? [];
  let anyRelevant = false;
  let worst: ClaimRequirementStatus = "SATISFIED";
  const reasonCodes = new Set<ClaimReasonCode>();
  const blockingGaps: MechanismGapRef[] = [];
  for (const component of components) {
    const status = lineageComponentStatus(flow, component);
    const gaps = gapsForComponentOnFlow(flow, component);
    if (status === null && gaps.length === 0) continue; // not relevant to this flow at all
    anyRelevant = true;
    if (status === "PARTIALLY_SUPPORTED") {
      if (worst === "SATISFIED") worst = "PARTIAL";
      reasonCodes.add("REQUIRED_PATH_PARTIAL");
    } else if (status === "SUPPORTED") {
      // contributes nothing to worst
    } else {
      // status === null: not established on this flow — check WHY via gaps.
      const contradicted = gaps.some((g) => g.kind === "CONTRADICTED_COMPONENT");
      if (contradicted) {
        worst = "CONTRADICTED";
        reasonCodes.add("REQUIRED_PATH_CONTRADICTED");
      } else if (worst !== "CONTRADICTED") {
        worst = "UNSATISFIED";
        reasonCodes.add("REQUIRED_COMPONENT_MISSING");
      }
      blockingGaps.push(...gaps);
    }
  }
  if (!anyRelevant) return null;
  const establishedEvidenceIds = evidenceIdsForComponentsOnFlow(flow, components);
  const evidenceIds =
    worst === "CONTRADICTED"
      ? sortedIds([...establishedEvidenceIds, ...gapEvidenceIds(flow, ["CONTRADICTED_COMPONENT"])])
      : establishedEvidenceIds;
  return {
    status: worst,
    reasonCodes: [...reasonCodes],
    blockingGaps,
    evidenceIds,
    componentResultKeys: components.map((c) => ({ step: stepOfComponent(flow, c), component: c })).filter((k) => k.step !== -1),
  };
}

function stepOfComponent(flow: MechanismFlow, component: string): number {
  const step = flow.lineage.find((s) => s.component === component);
  if (step) return step.step;
  const gap = flow.gaps.find((g) => g.component === component);
  return gap?.afterStep ?? -1;
}

// FLOW_RELATIONSHIP — source and destination must BOTH be established on
// the SAME flow (D-108's coherent-flow rule — trivially enforced since
// this function is called once per flow, never synthesizing across flows).
function evaluateFlowRelationship(req: ClaimRequirement, flow: MechanismFlow): FlowVerdict | null {
  const from = req.relationshipFrom!;
  const to = req.relationshipTo!;
  const fromStatus = lineageComponentStatus(flow, from);
  const toStatus = lineageComponentStatus(flow, to);
  const fromGaps = gapsForComponentOnFlow(flow, from);
  const toGaps = gapsForComponentOnFlow(flow, to);
  if (fromStatus === null && toStatus === null && fromGaps.length === 0 && toGaps.length === 0) return null;

  const branchUnresolved = [...fromGaps, ...toGaps].some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED");
  const contradicted = [...fromGaps, ...toGaps].some((g) => g.kind === "CONTRADICTED_COMPONENT");
  const unresolvedRelationship = [...fromGaps, ...toGaps].some((g) => g.kind === "DESTINATION_UNRESOLVED" || g.kind === "RECIPIENT_UNRESOLVED");

  if (fromStatus !== null && toStatus !== null) {
    const status: ClaimRequirementStatus = fromStatus === "PARTIALLY_SUPPORTED" || toStatus === "PARTIALLY_SUPPORTED" ? "PARTIAL" : "SATISFIED";
    return {
      status,
      reasonCodes: status === "PARTIAL" ? ["REQUIRED_PATH_PARTIAL"] : [],
      blockingGaps: [],
      evidenceIds: evidenceIdsForComponentsOnFlow(flow, [from, to]),
      componentResultKeys: [
        { step: stepOfComponent(flow, from), component: from },
        { step: stepOfComponent(flow, to), component: to },
      ],
    };
  }

  if (contradicted) {
    return {
      status: "CONTRADICTED",
      reasonCodes: ["REQUIRED_PATH_CONTRADICTED"],
      blockingGaps: [...fromGaps, ...toGaps].filter((g) => g.kind === "CONTRADICTED_COMPONENT"),
      evidenceIds: gapEvidenceIds(flow, ["CONTRADICTED_COMPONENT"]),
      componentResultKeys: [],
    };
  }
  if (branchUnresolved) {
    return {
      status: "UNSATISFIED",
      reasonCodes: ["BRANCH_ATTRIBUTION_UNRESOLVED"],
      blockingGaps: [...fromGaps, ...toGaps].filter((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED"),
      evidenceIds: [],
      componentResultKeys: [],
    };
  }
  if (unresolvedRelationship) {
    return {
      status: "UNSATISFIED",
      reasonCodes: ["REQUIRED_RELATIONSHIP_UNRESOLVED"],
      blockingGaps: [...fromGaps, ...toGaps].filter((g) => g.kind === "DESTINATION_UNRESOLVED" || g.kind === "RECIPIENT_UNRESOLVED"),
      evidenceIds: [],
      componentResultKeys: [],
    };
  }
  return {
    status: "UNSATISFIED",
    reasonCodes: ["REQUIRED_COMPONENT_MISSING"],
    blockingGaps: [...fromGaps, ...toGaps],
    evidenceIds: [],
    componentResultKeys: [],
  };
}

const ATTRIBUTE_MISMATCH_CODE: Record<string, ClaimReasonCode> = {
  tokenState: "TOKEN_STATE_MISMATCH",
  recipientKind: "ACTOR_MISMATCH",
  destinationKind: "DESTINATION_MISMATCH",
  valueSource: "REQUIRED_ATOM_UNSATISFIED",
  direction: "REQUIRED_ATOM_UNSATISFIED",
};

// FLOW_ATTRIBUTE — exact normalized equality only (D-096/D-101 discipline
// inherited verbatim: no semantic equivalence, no alias inference). A
// positively established value outside expectedValues is a positive
// incompatibility (CONTRADICTED); an unestablished (UNKNOWN/null)
// attribute is absence, never incompatibility (UNSATISFIED, §12).
function evaluateFlowAttribute(req: ClaimRequirement, flow: MechanismFlow): FlowVerdict | null {
  const attribute = req.attribute!;
  const expected = new Set((req.expectedValues ?? []).map((v) => v.toLowerCase()));
  const raw = flow.attributes[attribute];
  const value = raw === null ? null : String(raw);
  const isUnestablished = value === null || value.toUpperCase() === "UNKNOWN";
  const code = ATTRIBUTE_MISMATCH_CODE[attribute] ?? "REQUIRED_ATOM_UNSATISFIED";
  const evidenceIds = allFlowEvidenceIds(flow);

  if (evidenceIds.length === 0) return null; // nothing established on this flow at all — not a candidate

  if (isUnestablished) {
    return {
      status: "UNSATISFIED",
      reasonCodes: ["REQUIRED_ATOM_UNSATISFIED"],
      blockingGaps: [],
      evidenceIds: [],
      componentResultKeys: [],
    };
  }
  if (expected.has(value.toLowerCase())) {
    return { status: "SATISFIED", reasonCodes: [], blockingGaps: [], evidenceIds, componentResultKeys: [] };
  }
  return { status: "CONTRADICTED", reasonCodes: [code], blockingGaps: [], evidenceIds, componentResultKeys: [] };
}

// NET_EFFECT_ESTABLISHED — consumed verbatim from S6/S5; never
// recomputed from a destinationKind/mechanism label (§17, mutations 5/6/26).
function evaluateNetEffectEstablished(_req: ClaimRequirement, flow: MechanismFlow): FlowVerdict | null {
  const gaps = gapsForComponentOnFlow(flow, "NET_EFFECT");
  if (flow.netEffect) {
    const status: ClaimRequirementStatus = flow.netEffect.componentStatus === "PARTIALLY_SUPPORTED" ? "PARTIAL" : "SATISFIED";
    return {
      status,
      reasonCodes: status === "PARTIAL" ? ["REQUIRED_PATH_PARTIAL"] : [],
      blockingGaps: [],
      evidenceIds: sortedIds(flow.netEffect.provenance.evidenceIds),
      componentResultKeys: [{ step: 7, component: "NET_EFFECT" }],
    };
  }
  if (gaps.length === 0) return null;
  const contradicted = gaps.some((g) => g.kind === "CONTRADICTED_COMPONENT");
  return {
    status: contradicted ? "CONTRADICTED" : "UNSATISFIED",
    reasonCodes: [contradicted ? "REQUIRED_PATH_CONTRADICTED" : "NET_EFFECT_NOT_ESTABLISHED"],
    blockingGaps: gaps,
    evidenceIds: contradicted ? gapEvidenceIds(flow, ["CONTRADICTED_COMPONENT"], "NET_EFFECT") : [],
    componentResultKeys: [],
  };
}

// LIFECYCLE — consumed verbatim from S6's already-computed value; never
// re-derived from currentState/temporalBasis directly (§14, no S6
// re-adjudication). HISTORICAL is itself a positive structural fact
// (S6 only reaches it when execution was established AND a deprecated/
// paused state or newer-conflict was positively found, per S6's
// computeLifecycle) — a CURRENT requirement against it is therefore a
// positive incompatibility (CONTRADICTED), while NOT_ESTABLISHED is
// genuine absence (UNSATISFIED). This is the one place the plan's §14
// summary table and §18 point 3's normative NOT_SUPPORTED condition
// could be read two ways; this file resolves it by keeping "HISTORICAL
// is a positive fact" internally consistent rather than silently
// treating every temporal mismatch the same.
function evaluateLifecycle(req: ClaimRequirement, flow: MechanismFlow): FlowVerdict | null {
  const expected = req.expectedLifecycle!;
  const actual = flow.lifecycle;
  const evidenceIds = allFlowEvidenceIds(flow);
  if (evidenceIds.length === 0) return null; // nothing established on this flow at all — not a candidate
  const satisfied = expected === "CURRENT" ? actual === "CURRENT" : actual === "CURRENT" || actual === "HISTORICAL";
  if (satisfied) {
    return { status: "SATISFIED", reasonCodes: [], blockingGaps: [], evidenceIds, componentResultKeys: [] };
  }
  if (expected === "CURRENT" && actual === "HISTORICAL") {
    return {
      status: "CONTRADICTED",
      reasonCodes: ["TEMPORAL_SCOPE_MISMATCH"],
      blockingGaps: [],
      evidenceIds,
      componentResultKeys: [{ step: 5, component: "CURRENT_STATE" }],
    };
  }
  return {
    status: "UNSATISFIED",
    reasonCodes: ["TEMPORAL_SCOPE_MISMATCH"],
    blockingGaps: [],
    evidenceIds: [],
    componentResultKeys: [],
  };
}

// DURABILITY_ESTABLISHED — REQUIRED only when CORE explicitly marks it so
// (§15); absence never blocks an unrelated intent's other atoms.
function evaluateDurabilityEstablished(_req: ClaimRequirement, flow: MechanismFlow): FlowVerdict | null {
  const gaps = gapsForComponentOnFlow(flow, "DURABILITY_BASIS");
  if (flow.durability) {
    const status: ClaimRequirementStatus = flow.durability.componentStatus === "PARTIALLY_SUPPORTED" ? "PARTIAL" : "SATISFIED";
    return {
      status,
      reasonCodes: status === "PARTIAL" ? ["REQUIRED_PATH_PARTIAL"] : [],
      blockingGaps: [],
      evidenceIds: sortedIds(flow.durability.provenance.evidenceIds),
      componentResultKeys: [{ step: 8, component: "DURABILITY_BASIS" }],
    };
  }
  if (gaps.length === 0) return null;
  return { status: "UNSATISFIED", reasonCodes: ["DURABILITY_NOT_ESTABLISHED"], blockingGaps: gaps, evidenceIds: [], componentResultKeys: [] };
}

const VERDICT_RANK: Record<ClaimRequirementStatus, number> = { SATISFIED: 0, PARTIAL: 1, CONTRADICTED: 2, UNSATISFIED: 3 };

function evaluateRequirement(req: ClaimRequirement, assembly: MechanismAssemblyResult): ClaimRequirementResult {
  const perFlow: { flow: MechanismFlow; verdict: FlowVerdict }[] = [];
  for (const flow of assembly.flows) {
    let verdict: FlowVerdict | null;
    switch (req.kind) {
      case "COMPONENT_ESTABLISHED":
        verdict = evaluateComponentEstablished(req, flow);
        break;
      case "FLOW_RELATIONSHIP":
        verdict = evaluateFlowRelationship(req, flow);
        break;
      case "FLOW_ATTRIBUTE":
        verdict = evaluateFlowAttribute(req, flow);
        break;
      case "NET_EFFECT_ESTABLISHED":
        verdict = evaluateNetEffectEstablished(req, flow);
        break;
      case "LIFECYCLE":
        verdict = evaluateLifecycle(req, flow);
        break;
      case "DURABILITY_ESTABLISHED":
        verdict = evaluateDurabilityEstablished(req, flow);
        break;
    }
    if (verdict) perFlow.push({ flow, verdict });
  }

  // §9/§11 — existential across relevant flows, best tier wins. A flow
  // that SATISFIES the atom is sufficient regardless of what any other,
  // unrelated flow shows (no cherry-picking WITHIN one flow's own
  // verdict — each verdict above is already computed against exactly
  // one flow's own lineage/gaps, never synthesized from two).
  if (perFlow.length === 0) {
    return {
      requirementId: req.requirementId,
      optionality: req.optionality,
      status: "UNSATISFIED",
      reasonCodes: ["NO_RELEVANT_FLOW"],
      matchedFlowIds: [],
      blockingGaps: [],
      provenance: EMPTY_PROVENANCE,
    };
  }

  const bestRank = Math.min(...perFlow.map((p) => VERDICT_RANK[p.verdict.status]));
  const winners = perFlow.filter((p) => VERDICT_RANK[p.verdict.status] === bestRank);

  const matchedFlowIds = sortedIds(winners.map((w) => w.flow.flowId));
  const reasonCodes = [...new Set(winners.flatMap((w) => w.verdict.reasonCodes))].sort();
  const blockingGaps = winners.flatMap((w) => w.verdict.blockingGaps);
  const evidenceIds = sortedIds(winners.flatMap((w) => w.verdict.evidenceIds));
  const componentResultKeys = winners
    .flatMap((w) => w.verdict.componentResultKeys)
    .filter((k, i, arr) => arr.findIndex((o) => o.step === k.step && o.component === k.component) === i)
    .sort((a, b) => a.step - b.step || (a.component < b.component ? -1 : 1));

  const status = winners[0].verdict.status;
  if ((status === "SATISFIED" || status === "PARTIAL" || status === "CONTRADICTED") && evidenceIds.length === 0) {
    throw new ClaimEvaluationInvariantError(`requirement ${req.requirementId} is ${status} without provenance`);
  }

  return {
    requirementId: req.requirementId,
    optionality: req.optionality,
    status,
    reasonCodes,
    matchedFlowIds,
    blockingGaps,
    provenance: { flowIds: matchedFlowIds, componentResultKeys, evidenceIds },
  };
}

function contextGapsFor(assembly: MechanismAssemblyResult, relevantFlowIds: Set<string>): MechanismGapRef[] {
  const refs: MechanismGapRef[] = [];
  for (const flow of assembly.flows) {
    if (relevantFlowIds.has(flow.flowId)) continue;
    for (const gap of flow.gaps) refs.push(gapRef(flow.flowId, gap));
  }
  for (const gap of assembly.unassignedGaps) refs.push(gapRef(null, gap));
  return refs.sort(compareGapRefs);
}

function compareGapRefs(a: MechanismGapRef, b: MechanismGapRef): number {
  const aAfter = a.afterStep ?? -1;
  const bAfter = b.afterStep ?? -1;
  if (aAfter !== bAfter) return aAfter - bAfter;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const aComp = a.component ?? "";
  const bComp = b.component ?? "";
  return aComp < bComp ? -1 : aComp > bComp ? 1 : 0;
}

function baseResult(input: ClaimEvaluationInput): Omit<ClaimSupportResult, "status" | "reasonCodes" | "requirementResults" | "contextGaps"> {
  return { researchJobId: input.researchJobId, patternVersion: input.patternVersion, intent: input.intent, requirementSetVersion: input.requirementSetVersion };
}

// §6/D-106 — the 3 out-of-scope intents are handled BEFORE any CORE
// lookup is attempted; they deliberately have no intentRequirements
// entry, and that absence is not a configuration error for them.
const CEILING_INTENTS = new Set(["CLAIM_FACT_CHECK"]);
const UNCLASSIFIED_INTENTS = new Set(["UNKNOWN", "SCENARIO_CAUSAL_IMPACT"]);

export function evaluateClaimSupport(input: ClaimEvaluationInput): ClaimSupportResult {
  const { intent, taskType, pattern, assembly } = input;

  if (UNCLASSIFIED_INTENTS.has(intent)) {
    return { ...baseResult(input), status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["INTENT_NOT_CLASSIFIED"], requirementResults: [], contextGaps: [] };
  }
  if (CEILING_INTENTS.has(intent)) {
    return {
      ...baseResult(input),
      status: "PARTIALLY_SUPPORTED",
      reasonCodes: ["CLAIM_PROPOSITION_NOT_STRUCTURED"],
      requirementResults: [],
      contextGaps: [],
    };
  }

  const requirementSet = intentRequirementsFor(pattern, intent); // throws IntentConfigurationError

  const seen = new Set<string>();
  for (const req of requirementSet.requirements) {
    if (seen.has(req.requirementId)) {
      throw new ClaimEvaluationInvariantError(`duplicate requirementId "${req.requirementId}" in CORE intentRequirements for ${intent}`);
    }
    seen.add(req.requirementId);
  }

  const requirementResults = requirementSet.requirements
    .map((req) => evaluateRequirement(req, assembly))
    .sort((a, b) => (a.requirementId < b.requirementId ? -1 : 1));

  const required = requirementResults.filter((r) => r.optionality === "REQUIRED");
  const relevantFlowIds = new Set(requirementResults.flatMap((r) => r.matchedFlowIds));
  const contextGaps = contextGapsFor(assembly, relevantFlowIds);

  let status: ClaimSupportStatus;
  const reasonCodes = new Set<ClaimReasonCode>();

  // D-108, extended to the whole compound requirement (not just one
  // relational atom): SUPPORTED requires every REQUIRED atom satisfied
  // AND at least one flow that satisfies ALL of them in common. Without
  // this, "source established on flow A" + "recipient established on
  // flow B" as two independent FLOW_ATTRIBUTE atoms could each report
  // SATISFIED while describing two unrelated mechanisms — exactly the
  // cherry-picking §9/D-108 forbids, just spread across atoms instead of
  // within one relational atom. In the normal case (one real coherent
  // mechanism) this costs nothing: a flow that already satisfies every
  // atom on its own trivially appears in every atom's matchedFlowIds.
  const allSatisfied = required.length === 0 || required.every((r) => r.status === "SATISFIED");
  const commonFlowExists =
    required.length === 0 ||
    required.every((r) => r.matchedFlowIds.length > 0) &&
      required
        .map((r) => new Set(r.matchedFlowIds))
        .reduce((acc, set) => new Set([...acc].filter((id) => set.has(id))))
        .size > 0;

  if (allSatisfied && commonFlowExists) {
    status = "SUPPORTED";
  } else if (allSatisfied && !commonFlowExists) {
    status = "PARTIALLY_SUPPORTED";
    reasonCodes.add("REQUIRED_ATOM_UNSATISFIED");
  } else if (required.some((r) => r.status === "CONTRADICTED")) {
    status = "NOT_SUPPORTED";
    for (const r of required) if (r.status === "CONTRADICTED") r.reasonCodes.forEach((c) => reasonCodes.add(c));
  } else if (required.every((r) => r.status === "SATISFIED" || r.status === "PARTIAL") && required.some((r) => r.status === "PARTIAL")) {
    status = "PARTIALLY_SUPPORTED";
    reasonCodes.add("REQUIRED_PATH_PARTIAL");
  } else if (required.some((r) => r.status === "SATISFIED" || r.status === "PARTIAL")) {
    status = "PARTIALLY_SUPPORTED";
    reasonCodes.add("REQUIRED_ATOM_UNSATISFIED");
  } else {
    status = "INSUFFICIENT_EVIDENCE";
    for (const r of required) r.reasonCodes.forEach((c) => reasonCodes.add(c));
  }

  // §3.2/D-106 — structural ceiling for CLAIM_VERIFICATION task_type
  // (and any CORE-declared per-intent ceiling), applied AFTER normal
  // evaluation, capping only when it would otherwise exceed the ceiling.
  // Never lifts a lower status up to the ceiling.
  const ceilingApplies = taskType === "CLAIM_VERIFICATION" || requirementSet.ceiling === "PARTIALLY_SUPPORTED";
  if (ceilingApplies && status === "SUPPORTED") {
    status = "PARTIALLY_SUPPORTED";
    reasonCodes.add("CLAIM_PROPOSITION_NOT_STRUCTURED");
  }

  return { ...baseResult(input), status, reasonCodes: [...reasonCodes].sort(), requirementResults, contextGaps };
}
