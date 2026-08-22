import { createHash } from "node:crypto";

import type { EvidenceSourceClass } from "./providers/types";
import type { PatternContent } from "../domain/pattern";
import { componentRequirementsFor } from "../domain/pattern";
import type { MechanismState } from "../domain/mechanism-state";
import type {
  ComponentReconciliationResult,
  ComponentReconciliationStatus,
  ResultReasonCode,
} from "./component-reconciler";

// Phase 6, S6 — Mechanism Assembly (phase-6-s6-plan.md, D-098..D-103).
//
// Pure, deterministic, model-free, network-free. Turns S5's
// ComponentReconciliationResult[] (plus the narrow admitted-Evidence
// projection §3.1 the plan approves) into a MechanismAssemblyResult.
// S5 is the sole adjudicator of existence (D-100): this file never
// recomputes a component's status, class admissibility, officiality, or
// authority — it only asks "does an admitted element already exist" and,
// if so, annotates it with a closed-dictionary classification. No
// classifier output is ever allowed to CREATE an element or to feed
// flowId (D-101) — see isEstablished/classify* below and the slot/lineage
// builder, which never reads a classifier result.
//
// No DB access here — persistence lives in mechanism-assembly-store.ts,
// the same separation S5 uses (component-reconciler.ts / -store.ts).

// ---------------------------------------------------------------------
// §3.1 — the narrow, closed set of immutable Evidence fields S6 may read.
// Every other Evidence column (does_not_prove, claim_key, snapshot_ref,
// proofId, relationship, directness, ...) is deliberately absent: S6 has
// no use for them and reading them would be scope creep the plan
// explicitly forbids.
export interface AssemblyEvidenceProjection {
  id: string;
  sourceId: string;
  extractionUnitKey: string | null;
  sourceClass: EvidenceSourceClass | null;
  officiality: "CONFIRMED" | "CLAIMED" | null;
  mechanismState: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  fragment: string;
  summary: string | null;
  retrievedUrl: string;
  contentHash: string;
}

export interface MechanismAssemblyInput {
  researchJobId: string;
  patternVersion: number;
  pattern: PatternContent;
  contractView: { patternVersion: number };
  componentResults: ComponentReconciliationResult[];
  admittedEvidence: AssemblyEvidenceProjection[];
}

// §5.2 — closed dictionaries. Every one carries UNKNOWN as a legitimate,
// non-defect value (D-100): unrecognized is a gap, never a guess.
export type ValueSource =
  | "USER_PAYMENT"
  | "PROTOCOL_ISSUANCE"
  | "TREASURY"
  | "EXTERNAL_INCENTIVE"
  | "FEES"
  | "COLLATERAL_RETURN"
  | "BURN_LINKED_ISSUANCE"
  | "MARKET_PURCHASE"
  | "UNKNOWN";

export type DestinationKind =
  | "BURN"
  | "BUYBACK_HOLD"
  | "TREASURY"
  | "DISTRIBUTION"
  | "LP"
  | "NONE"
  | "UNKNOWN";

export type RecipientKind =
  | "PASSIVE_HOLDER"
  | "STAKER"
  | "NODE_OPERATOR"
  | "TREASURY"
  | "LP"
  | "EXTERNAL"
  | "NONE"
  | "UNKNOWN";

export type FlowDirection = "INBOUND" | "OUTBOUND" | "RETURN" | "UNKNOWN";

export interface FlowAttributes {
  valueSource: ValueSource;
  direction: FlowDirection;
  recipientKind: RecipientKind;
  destinationKind: DestinationKind;
  tokenState: string | null;
  assetSymbol: string | null;
}

// §12 — exactly the S5 reason codes that can qualify a PARTIALLY_SUPPORTED
// element. Not a new vocabulary.
export type NodeQualification =
  | "INSUFFICIENT_AUTHORITY"
  | "INDIRECT_ONLY"
  | "STATE_NOT_FULLY_LIVE"
  | "TOKEN_STATE_UNQUALIFIED";

const NODE_QUALIFICATION_CODES = new Set<ResultReasonCode>([
  "INSUFFICIENT_AUTHORITY",
  "INDIRECT_ONLY",
  "STATE_NOT_FULLY_LIVE",
  "TOKEN_STATE_UNQUALIFIED",
]);

export interface Provenance {
  componentResults: { step: number; component: string }[];
  evidenceIds: string[];
}

export type MechanismNodeKind = "VALUE_SOURCE" | "MECHANISM" | "DESTINATION";

export interface MechanismNode {
  kind: MechanismNodeKind;
  component: string;
  componentStatus: ComponentReconciliationStatus;
  qualifications: NodeQualification[];
  attributes: Record<string, never>; // reserved by the plan §5.1; no node-level attributes defined in v1
  provenance: Provenance;
}

export interface MechanismEdge {
  from: MechanismNodeKind;
  to: MechanismNodeKind;
  basisComponent: string;
  basisStatus: ComponentReconciliationStatus;
  executed: boolean;
  qualifications: NodeQualification[];
  provenance: Provenance;
}

// §11.1 — the closed, 11-member gap vocabulary. No free text.
export type MechanismGapKind =
  | "MISSING_COMPONENT"
  | "PARTIAL_COMPONENT"
  | "CONTRADICTED_COMPONENT"
  | "TOKEN_STATE_MISMATCH"
  | "FLOW_IDENTITY_UNRESOLVED"
  | "TEMPORAL_STATE_MISMATCH"
  | "RECIPIENT_UNRESOLVED"
  | "DESTINATION_UNRESOLVED"
  | "NET_EFFECT_UNRESOLVED"
  | "BRANCH_ATTRIBUTION_UNRESOLVED"
  | "FLOW_ENUMERATION_INCOMPLETE";

export interface MechanismGap {
  kind: MechanismGapKind;
  component: string | null;
  afterStep: number | null;
  provenance: Provenance;
}

export interface NetEffectAttachment {
  componentStatus: ComponentReconciliationStatus;
  qualifications: NodeQualification[];
  provenance: Provenance;
}

export interface DurabilityAttachment {
  componentStatus: ComponentReconciliationStatus;
  basisClasses: EvidenceSourceClass[];
  qualifications: NodeQualification[];
  provenance: Provenance;
}

export interface LineageStep {
  step: number;
  component: string;
  componentResultKey: string;
  evidenceIds: string[];
}

export type FlowLifecycle = "CURRENT" | "HISTORICAL" | "NOT_ESTABLISHED";
export type FlowShape = "COMPLETE_PATH" | "PARTIAL_PATH";

export interface MechanismFlow {
  flowId: string;
  lineage: LineageStep[];
  sharedPrefixId: string | null;
  branchPointStep: number | null;
  lifecycle: FlowLifecycle;
  nodes: MechanismNode[];
  edges: MechanismEdge[];
  shape: FlowShape;
  attributes: FlowAttributes;
  netEffect: NetEffectAttachment | null;
  durability: DurabilityAttachment | null;
  gaps: MechanismGap[];
}

// D-103 — deliberately no verdict/sufficient/proven/confidence/claim
// field anywhere in this type, checked by a dedicated regression test.
export interface MechanismAssemblyResult {
  researchJobId: string;
  patternVersion: number;
  flows: MechanismFlow[];
  unassignedGaps: MechanismGap[];
}

// ---------------------------------------------------------------------
// §21 — closed system-failure vocabulary. Everything else becomes a gap.
export class MechanismAssemblyInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MechanismAssemblyInvariantError";
  }
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v instanceof Map) throw new Error("unsupported");
    if (Array.isArray(v)) return v;
    if (v !== null && typeof v === "object") {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeFragmentForKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// §13.2 — the ONLY structural inputs to slot identity. No classification,
// no semantic attribute, ever participates here (D-101, mutations 38-44).
function structuralUnitKeyOf(row: AssemblyEvidenceProjection): string {
  if (row.extractionUnitKey !== null) return `unit:${row.extractionUnitKey}`;
  return `hash:${row.contentHash}:${sha256Hex(normalizeFragmentForKey(row.fragment))}`;
}

// ---------------------------------------------------------------------
// §5.3 / D-096-discipline closed lexical classifiers. Every one is a
// closed, code-owned dictionary, token-boundary matched, never a
// substring test, never a model, never a fuzzy match. Unrecognized ->
// UNKNOWN. These NEVER decide existence (§5.3) and NEVER feed flowId
// (§6.3, D-101) — they are called only to fill FlowAttributes on an
// already-established node/edge.

function tokenizeForClassifier(s: string): string[] {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function containsPhrase(tokens: string[], phrase: string): boolean {
  const phraseTokens = tokenizeForClassifier(phrase);
  outer: for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

// CHECK 3 (atlas-core), verbatim dictionary.
const VALUE_SOURCE_PHRASES: [ValueSource, string[]][] = [
  ["COLLATERAL_RETURN", ["collateral return", "collateral returned", "returned collateral", "return of collateral", "principal return", "returned principal"]],
  ["BURN_LINKED_ISSUANCE", ["burn linked issuance", "burn-linked issuance"]],
  ["PROTOCOL_ISSUANCE", ["protocol issuance", "token issuance", "emission", "emitted", "subsidy", "block reward", "inflation"]],
  ["MARKET_PURCHASE", ["market purchase", "open market", "bought back", "buyback"]],
  ["TREASURY", ["treasury funded", "from treasury", "treasury reserve"]],
  ["EXTERNAL_INCENTIVE", ["external incentive", "grant funded", "ecosystem fund"]],
  ["FEES", ["protocol fees", "trading fees", "transaction fees", "fee revenue"]],
  ["USER_PAYMENT", ["user payment", "paid by users", "customer payment", "paid by customers"]],
];

export function classifyValueSource(text: string): ValueSource {
  const tokens = tokenizeForClassifier(text);
  for (const [value, phrases] of VALUE_SOURCE_PHRASES) {
    if (phrases.some((p) => containsPhrase(tokens, p))) return value;
  }
  return "UNKNOWN";
}

// Plan §9.1 dictionary, verbatim. D-100: "burn" text alone never implies
// existence — this is only called on already-established DESTINATION
// text.
const DESTINATION_KIND_PHRASES: [DestinationKind, string[]][] = [
  ["BURN", ["burn", "burned", "burning"]],
  ["BUYBACK_HOLD", ["buyback and hold", "bought back and held", "held in reserve"]],
  ["TREASURY", ["treasury", "protocol treasury"]],
  ["DISTRIBUTION", ["distributed to holders", "distribution to holders", "paid out to holders"]],
  ["LP", ["liquidity pool", "added to liquidity"]],
];

export function classifyDestinationKind(text: string): DestinationKind {
  const tokens = tokenizeForClassifier(text);
  for (const [value, phrases] of DESTINATION_KIND_PHRASES) {
    if (phrases.some((p) => containsPhrase(tokens, p))) return value;
  }
  return "UNKNOWN";
}

// Plan §9.1 dictionary, verbatim. §9 rule 1: PASSIVE_HOLDER only from a
// POSITIVE match here, never from absence.
const RECIPIENT_KIND_PHRASES: [RecipientKind, string[]][] = [
  ["STAKER", ["staker", "stakers", "staking reward"]],
  ["NODE_OPERATOR", ["node operator", "node operators", "validator", "validators", "miner", "miners"]],
  ["TREASURY", ["treasury"]],
  ["LP", ["liquidity provider", "liquidity providers"]],
  ["EXTERNAL", ["external party", "third party"]],
  ["PASSIVE_HOLDER", ["holder", "holders", "token holder", "token holders"]],
];

export function classifyRecipientKind(text: string): RecipientKind {
  const tokens = tokenizeForClassifier(text);
  for (const [value, phrases] of RECIPIENT_KIND_PHRASES) {
    if (phrases.some((p) => containsPhrase(tokens, p))) return value;
  }
  return "UNKNOWN";
}

// §14 — new, minimal vocabulary. RETURN takes priority: a returned
// collateral/principal flow must never read as OUTBOUND/reward (mutation 6).
const DIRECTION_PHRASES: [FlowDirection, string[]][] = [
  ["RETURN", ["collateral return", "collateral returned", "returned collateral", "return of collateral", "principal return", "returned principal"]],
  ["INBOUND", ["paid by users", "paid by customers", "user payment", "customer payment", "fee revenue", "protocol fees"]],
  ["OUTBOUND", ["distributed to", "paid out to", "reward", "rewards", "emission", "emitted", "issued to"]],
];

export function classifyDirection(text: string): FlowDirection {
  const tokens = tokenizeForClassifier(text);
  for (const [value, phrases] of DIRECTION_PHRASES) {
    if (phrases.some((p) => containsPhrase(tokens, p))) return value;
  }
  return "UNKNOWN";
}

// ---------------------------------------------------------------------
// §4 — Pattern v1 -> assembly role mapping. Fixed, not derived: exactly
// which of the ten logical components become nodes/edges/attributes is
// CORE data the plan locks, not something S6 infers from Pattern content.
const NODE_COMPONENTS: Record<string, MechanismNodeKind> = {
  SOURCE_OF_VALUE: "VALUE_SOURCE",
  MECHANISM_SPEC: "MECHANISM",
  DESTINATION: "DESTINATION",
};
// component -> gap kind to use when NOT established (INSUFFICIENT_EVIDENCE
// or entirely absent from componentResults). DESTINATION/RECIPIENT/
// NET_EFFECT get their own specific gap kind instead of the generic
// MISSING_COMPONENT (§11.1, acceptance scenarios B/Z/S); every other
// component uses the generic form tagged with its own name.
const MISSING_GAP_KIND: Record<string, MechanismGapKind> = {
  DESTINATION: "DESTINATION_UNRESOLVED",
  RECIPIENT: "RECIPIENT_UNRESOLVED",
  NET_EFFECT: "NET_EFFECT_UNRESOLVED",
};

const MAX_FLOWS = 64;

function admittedTextOf(row: AssemblyEvidenceProjection): string {
  return `${row.fragment} ${row.summary ?? ""}`;
}

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

interface Slot {
  structuralUnitKey: string;
  evidenceIds: string[]; // sorted
}

// §13.2 — slot partition of one component's admitted supporting Evidence,
// scoped to what this specific lineage may legitimately claim (branch
// attribution, §13.4, applied by the caller before this runs). Grouping
// key is PURELY structural: (step, component, parentBranchPath,
// structuralUnitKey) — no classification of any kind reads here
// (D-101, mutations 38-43).
function partitionIntoSlots(
  step: number,
  component: string,
  parentBranchPathHash: string,
  candidateRows: AssemblyEvidenceProjection[],
): Slot[] {
  const bySlotKey = new Map<string, { structuralUnitKey: string; evidenceIds: string[] }>();
  for (const row of candidateRows) {
    const structuralUnitKey = structuralUnitKeyOf(row);
    const slotKey = canonicalize([step, component, parentBranchPathHash, structuralUnitKey]);
    const existing = bySlotKey.get(slotKey);
    if (existing) {
      existing.evidenceIds.push(row.id);
    } else {
      bySlotKey.set(slotKey, { structuralUnitKey, evidenceIds: [row.id] });
    }
  }
  const slots = [...bySlotKey.values()].map((s) => ({
    structuralUnitKey: s.structuralUnitKey,
    evidenceIds: sortedIds(s.evidenceIds),
  }));
  // §19 — slots sorted structurally: structuralUnitKey, then sorted
  // evidenceIds. Classification never participates in this order.
  slots.sort((a, b) => {
    if (a.structuralUnitKey !== b.structuralUnitKey) return a.structuralUnitKey < b.structuralUnitKey ? -1 : 1;
    return a.evidenceIds.join(",") < b.evidenceIds.join(",") ? -1 : 1;
  });
  return slots;
}

interface WorkingLineage {
  lineage: LineageStep[];
  branchSlotPath: number[];
  branchPointStep: number | null;
  branchSourceIds: Set<string>;
  gaps: MechanismGap[];
  branchAttributionUnresolved: Set<string>; // component names, for dedupe
}

function cloneLineage(l: WorkingLineage): WorkingLineage {
  return {
    lineage: [...l.lineage],
    branchSlotPath: [...l.branchSlotPath],
    branchPointStep: l.branchPointStep,
    branchSourceIds: new Set(l.branchSourceIds),
    gaps: [...l.gaps],
    branchAttributionUnresolved: new Set(l.branchAttributionUnresolved),
  };
}

function provenanceOf(step: number, component: string, evidenceIds: string[]): Provenance {
  return { componentResults: [{ step, component }], evidenceIds: sortedIds(evidenceIds) };
}

function qualificationsOf(reasonCodes: ResultReasonCode[]): NodeQualification[] {
  const quals = reasonCodes.filter((c): c is NodeQualification => NODE_QUALIFICATION_CODES.has(c));
  return [...new Set(quals)].sort();
}

// ---------------------------------------------------------------------
export function assembleMechanism(input: MechanismAssemblyInput): MechanismAssemblyResult {
  // §18a step 1 — contract check.
  if (input.patternVersion !== input.contractView.patternVersion) {
    throw new MechanismAssemblyInvariantError(
      `patternVersion mismatch: input=${input.patternVersion} contractView=${input.contractView.patternVersion}`,
    );
  }
  for (const component of Object.keys(NODE_COMPONENTS).concat([
    "FLOW_PATH",
    "GOVERNANCE_BASIS",
    "EXECUTION_EVIDENCE",
    "CURRENT_STATE",
    "RECIPIENT",
    "NET_EFFECT",
    "DURABILITY_BASIS",
  ])) {
    componentRequirementsFor(input.pattern, component); // throws PatternConfigurationError
  }

  // §18a step 2 — index by (step, component); reject impossible S5 states.
  const byKey = new Map<string, ComponentReconciliationResult>();
  for (const r of input.componentResults) {
    const key = `${r.step}:${r.component}`;
    if (byKey.has(key)) {
      throw new MechanismAssemblyInvariantError(`duplicate component result for ${key}`);
    }
    if (
      r.status !== "SUPPORTED" &&
      r.status !== "PARTIALLY_SUPPORTED" &&
      r.status !== "CONTRADICTED" &&
      r.status !== "INSUFFICIENT_EVIDENCE"
    ) {
      throw new MechanismAssemblyInvariantError(`impossible S5 status "${r.status}" for ${key}`);
    }
    if (r.status === "PARTIALLY_SUPPORTED" && qualificationsOf(r.reasonCodes).length === 0) {
      throw new MechanismAssemblyInvariantError(`PARTIALLY_SUPPORTED without a basis code for ${key}`);
    }
    byKey.set(key, r);
  }

  // §18a step 3 — load admitted Evidence, reject dangling references.
  const evidenceById = new Map<string, AssemblyEvidenceProjection>();
  for (const row of input.admittedEvidence) evidenceById.set(row.id, row);
  const resolveRows = (ids: string[], key: string): AssemblyEvidenceProjection[] =>
    ids.map((id) => {
      const row = evidenceById.get(id);
      if (!row) throw new MechanismAssemblyInvariantError(`dangling evidence reference ${id} for ${key}`);
      return row;
    });

  // §18a steps 4-8 — incremental lineage/slot/branch walk, Pattern-step
  // order. Root starts as a single lineage before anything is evaluated.
  let active: WorkingLineage[] = [
    { lineage: [], branchSlotPath: [], branchPointStep: null, branchSourceIds: new Set(), gaps: [], branchAttributionUnresolved: new Set() },
  ];
  const unassignedGaps: MechanismGap[] = [];
  let enumerationCapped = false;

  for (let step = 1; step <= 8; step++) {
    const components = requiredComponentsForStepSafe(input.pattern, step);
    for (const component of components) {
      const key = `${step}:${component}`;
      const result = byKey.get(key);
      const next: WorkingLineage[] = [];

      for (const l of active) {
        if (!result || result.status === "INSUFFICIENT_EVIDENCE") {
          const clone = cloneLineage(l);
          clone.gaps.push({
            kind: MISSING_GAP_KIND[component] ?? "MISSING_COMPONENT",
            component,
            afterStep: step,
            provenance: { componentResults: [{ step, component }], evidenceIds: [] },
          });
          next.push(clone);
          continue;
        }
        if (result.status === "CONTRADICTED") {
          const clone = cloneLineage(l);
          clone.gaps.push({
            kind: "CONTRADICTED_COMPONENT",
            component,
            afterStep: step,
            provenance: provenanceOf(step, component, [...result.supportingEvidenceIds, ...result.contradictingEvidenceIds]),
          });
          next.push(clone);
          continue;
        }

        // SUPPORTED / PARTIALLY_SUPPORTED — branch attribution (§13.4)
        // first: once a lineage has forked, a downstream component's
        // Evidence attaches to it only if it shares sourceId with
        // something already established on this lineage.
        const allRows = resolveRows(result.supportingEvidenceIds, key);
        const candidateRows =
          l.branchPointStep === null
            ? allRows
            : allRows.filter((r) => l.branchSourceIds.has(r.sourceId));

        if (allRows.length > 0 && candidateRows.length === 0) {
          const clone = cloneLineage(l);
          clone.gaps.push({
            kind: "BRANCH_ATTRIBUTION_UNRESOLVED",
            component,
            afterStep: step,
            provenance: provenanceOf(step, component, result.supportingEvidenceIds),
          });
          next.push(clone);
          continue;
        }
        if (candidateRows.length === 0) {
          // SUPPORTED/PARTIALLY_SUPPORTED with zero supportingEvidenceIds
          // is an impossible S5 state (§21 п.3) — S5 never emits SUPPORTED
          // without at least one supporting id.
          throw new MechanismAssemblyInvariantError(`${key} is ${result.status} with no supportingEvidenceIds`);
        }

        const parentBranchPathHash = sha256Hex(canonicalize(l.lineage));
        const slots = partitionIntoSlots(step, component, parentBranchPathHash, candidateRows);

        if (active.length * slots.length + (active.length - 1) > MAX_FLOWS && slots.length > 1) {
          enumerationCapped = true;
          const clone = cloneLineage(l);
          next.push(clone);
          continue;
        }

        slots.forEach((slot, slotIndex) => {
          const clone = cloneLineage(l);
          clone.lineage.push({ step, component, componentResultKey: key, evidenceIds: slot.evidenceIds });
          for (const id of slot.evidenceIds) {
            const row = evidenceById.get(id)!;
            clone.branchSourceIds.add(row.sourceId);
          }
          if (slots.length > 1) {
            clone.branchPointStep = clone.branchPointStep ?? step;
            clone.branchSlotPath.push(slotIndex);
          }
          if (result.status === "PARTIALLY_SUPPORTED") {
            clone.gaps.push({
              kind: "PARTIAL_COMPONENT",
              component,
              afterStep: step,
              provenance: provenanceOf(step, component, slot.evidenceIds),
            });
          }
          next.push(clone);
        });
      }
      active = next;
    }
  }

  if (enumerationCapped) {
    unassignedGaps.push({
      kind: "FLOW_ENUMERATION_INCOMPLETE",
      component: null,
      afterStep: null,
      provenance: { componentResults: [], evidenceIds: [] },
    });
  }

  // §18a steps 9-13 — materialize nodes/edges/attributes/lifecycle/gaps
  // per final lineage. branchSlotPath is sort-only internal state (§19) —
  // it is not part of the public MechanismFlow schema, so pairs are
  // sorted before the internal WorkingLineage is discarded.
  const flowPairs = active.map((l) => ({ flow: buildFlow(l, byKey, evidenceById), branchSlotPath: l.branchSlotPath }));
  flowPairs.sort(compareFlowPairs);
  const flows: MechanismFlow[] = flowPairs.map((p) => p.flow);

  // §19 — full deterministic ordering.
  unassignedGaps.sort(compareGaps);

  return {
    researchJobId: input.researchJobId,
    patternVersion: input.patternVersion,
    flows,
    unassignedGaps,
  };
}

function requiredComponentsForStepSafe(pattern: PatternContent, step: number): string[] {
  const list = pattern.requiredComponents[String(step)];
  return list ? [...list] : [];
}

function lineageStepFor(l: WorkingLineage, component: string): LineageStep | undefined {
  return l.lineage.find((s) => s.component === component);
}

function resultFor(byKey: Map<string, ComponentReconciliationResult>, step: number, component: string) {
  return byKey.get(`${step}:${component}`);
}

function buildFlow(
  l: WorkingLineage,
  byKey: Map<string, ComponentReconciliationResult>,
  evidenceById: Map<string, AssemblyEvidenceProjection>,
): MechanismFlow {
  const gaps = [...l.gaps];
  const nodes: MechanismNode[] = [];
  const edges: MechanismEdge[] = [];

  const stepOf: Record<string, number> = {
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

  const textFor = (component: string): string => {
    const lineageStep = lineageStepFor(l, component);
    if (!lineageStep) return "";
    return lineageStep.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((r): r is AssemblyEvidenceProjection => !!r)
      .map(admittedTextOf)
      .join(" ");
  };

  for (const [component, kind] of Object.entries(NODE_COMPONENTS)) {
    const step = stepOf[component];
    const lineageStep = lineageStepFor(l, component);
    if (!lineageStep) continue;
    const result = resultFor(byKey, step, component)!;
    nodes.push({
      kind,
      component,
      componentStatus: result.status,
      qualifications: qualificationsOf(result.reasonCodes),
      attributes: {},
      provenance: provenanceOf(step, component, lineageStep.evidenceIds),
    });
  }

  const edgeSpecs: { component: string; from: MechanismNodeKind; to: MechanismNodeKind }[] = [
    { component: "FLOW_PATH", from: "VALUE_SOURCE", to: "MECHANISM" },
    { component: "EXECUTION_EVIDENCE", from: "MECHANISM", to: "DESTINATION" },
  ];
  for (const spec of edgeSpecs) {
    const step = stepOf[spec.component];
    const lineageStep = lineageStepFor(l, spec.component);
    if (!lineageStep) continue;
    const result = resultFor(byKey, step, spec.component)!;
    edges.push({
      from: spec.from,
      to: spec.to,
      basisComponent: spec.component,
      basisStatus: result.status,
      executed: true,
      qualifications: qualificationsOf(result.reasonCodes),
      provenance: provenanceOf(step, spec.component, lineageStep.evidenceIds),
    });
  }

  // §5.2 attributes — classified ONLY over admitted text of already-
  // established components; never decides existence, never fed back
  // into lineage/flowId.
  const valueSourceText = textFor("SOURCE_OF_VALUE");
  const valueSource: ValueSource = valueSourceText ? classifyValueSource(valueSourceText) : "UNKNOWN";

  const destinationText = textFor("DESTINATION");
  const destinationKind: DestinationKind = destinationText ? classifyDestinationKind(destinationText) : "UNKNOWN";
  if (!lineageStepFor(l, "DESTINATION")) {
    gaps.push({
      kind: "DESTINATION_UNRESOLVED",
      component: "DESTINATION",
      afterStep: 6,
      provenance: { componentResults: [{ step: 6, component: "DESTINATION" }], evidenceIds: [] },
    });
  } else if (destinationKind === "UNKNOWN") {
    gaps.push({
      kind: "DESTINATION_UNRESOLVED",
      component: "DESTINATION",
      afterStep: 6,
      provenance: provenanceOf(6, "DESTINATION", lineageStepFor(l, "DESTINATION")!.evidenceIds),
    });
  }

  const recipientText = textFor("RECIPIENT");
  const recipientKind: RecipientKind = recipientText ? classifyRecipientKind(recipientText) : "UNKNOWN";

  const directionText = [textFor("SOURCE_OF_VALUE"), textFor("FLOW_PATH"), textFor("EXECUTION_EVIDENCE")]
    .filter(Boolean)
    .join(" ");
  const direction: FlowDirection = directionText ? classifyDirection(directionText) : "UNKNOWN";

  // §8 — token state carried forward verbatim from S5, never re-derived.
  const recipientResult = resultFor(byKey, 6, "RECIPIENT");
  const destinationResult = resultFor(byKey, 6, "DESTINATION");
  const recipientStates = lineageStepFor(l, "RECIPIENT") ? (recipientResult?.tokenStateMentions ?? []) : [];
  const destinationStates = lineageStepFor(l, "DESTINATION") ? (destinationResult?.tokenStateMentions ?? []) : [];
  const allStates = [...new Set([...recipientStates, ...destinationStates])];
  let tokenState: string | null = null;
  if (allStates.length === 1) {
    tokenState = allStates[0];
  } else if (allStates.length > 1) {
    gaps.push({
      kind: "TOKEN_STATE_MISMATCH",
      component: null,
      afterStep: 6,
      provenance: {
        componentResults: [
          { step: 6, component: "RECIPIENT" },
          { step: 6, component: "DESTINATION" },
        ],
        evidenceIds: sortedIds([
          ...(lineageStepFor(l, "RECIPIENT")?.evidenceIds ?? []),
          ...(lineageStepFor(l, "DESTINATION")?.evidenceIds ?? []),
        ]),
      },
    });
  }

  const attributes: FlowAttributes = {
    valueSource,
    direction,
    recipientKind,
    destinationKind,
    tokenState,
    assetSymbol: null, // §6.5 — never parsed from free text; no structural field in frozen inputs
  };

  if (valueSource === "UNKNOWN" && !lineageStepFor(l, "SOURCE_OF_VALUE")) {
    // already covered by the generic SOURCE_OF_VALUE gap emitted during
    // the walk; nothing additional here.
  } else if (valueSource === "UNKNOWN" && lineageStepFor(l, "SOURCE_OF_VALUE")) {
    gaps.push({
      kind: "FLOW_IDENTITY_UNRESOLVED",
      component: "SOURCE_OF_VALUE",
      afterStep: 1,
      provenance: provenanceOf(1, "SOURCE_OF_VALUE", lineageStepFor(l, "SOURCE_OF_VALUE")!.evidenceIds),
    });
  }

  if (!lineageStepFor(l, "RECIPIENT")) {
    gaps.push({
      kind: "RECIPIENT_UNRESOLVED",
      component: "RECIPIENT",
      afterStep: 6,
      provenance: { componentResults: [{ step: 6, component: "RECIPIENT" }], evidenceIds: [] },
    });
  }

  // §16 net effect.
  const netEffectResult = resultFor(byKey, 7, "NET_EFFECT");
  const netEffectStep = lineageStepFor(l, "NET_EFFECT");
  let netEffect: NetEffectAttachment | null = null;
  if (netEffectStep && netEffectResult) {
    netEffect = {
      componentStatus: netEffectResult.status,
      qualifications: qualificationsOf(netEffectResult.reasonCodes),
      provenance: provenanceOf(7, "NET_EFFECT", netEffectStep.evidenceIds),
    };
  }

  // §17 durability.
  const durabilityResult = resultFor(byKey, 8, "DURABILITY_BASIS");
  const durabilityStep = lineageStepFor(l, "DURABILITY_BASIS");
  let durability: DurabilityAttachment | null = null;
  if (durabilityStep && durabilityResult) {
    const basisClasses = [
      ...new Set(
        durabilityStep.evidenceIds
          .map((id) => evidenceById.get(id)?.sourceClass)
          .filter((c): c is EvidenceSourceClass => c !== null && c !== undefined),
      ),
    ].sort();
    durability = {
      componentStatus: durabilityResult.status,
      basisClasses,
      qualifications: qualificationsOf(durabilityResult.reasonCodes),
      provenance: provenanceOf(8, "DURABILITY_BASIS", durabilityStep.evidenceIds),
    };
  } else {
    gaps.push({
      kind: "MISSING_COMPONENT",
      component: "DURABILITY_BASIS",
      afterStep: 8,
      provenance: { componentResults: [{ step: 8, component: "DURABILITY_BASIS" }], evidenceIds: [] },
    });
  }

  if (!lineageStepFor(l, "GOVERNANCE_BASIS")) {
    gaps.push({
      kind: "MISSING_COMPONENT",
      component: "GOVERNANCE_BASIS",
      afterStep: 3,
      provenance: { componentResults: [{ step: 3, component: "GOVERNANCE_BASIS" }], evidenceIds: [] },
    });
  }

  // §10.1 lifecycle.
  const lifecycle = computeLifecycle(l, byKey);

  gaps.sort(compareGaps);

  const sharedPrefixId =
    l.branchPointStep === null
      ? null
      : sha256Hex(
          canonicalize([
            l.lineage.filter((s) => s.step < l.branchPointStep!),
          ]),
        );

  const flowId = sha256Hex(canonicalize([l.lineage.map((s) => [s.step, s.component, s.evidenceIds]), l.branchSlotPath]));

  return {
    flowId,
    lineage: [...l.lineage].sort((a, b) => a.step - b.step || (a.component < b.component ? -1 : 1)),
    sharedPrefixId,
    branchPointStep: l.branchPointStep,
    lifecycle,
    nodes: nodes.sort((a, b) => stepOf[a.component] - stepOf[b.component] || (a.component < b.component ? -1 : 1)),
    edges: edges.sort((a, b) => (a.basisComponent < b.basisComponent ? -1 : 1)),
    shape: gaps.length === 0 ? "COMPLETE_PATH" : "PARTIAL_PATH",
    attributes,
    netEffect,
    durability,
    gaps,
  };
}

function computeLifecycle(l: WorkingLineage, byKey: Map<string, ComponentReconciliationResult>): FlowLifecycle {
  const currentStateStep = lineageStepFor(l, "CURRENT_STATE");
  const currentStateResult = resultFor(byKey, 5, "CURRENT_STATE");
  const executionEstablished = !!lineageStepFor(l, "EXECUTION_EVIDENCE");

  const relevantStates: { state: MechanismState | null; at: Date | null }[] = [];
  for (const step of l.lineage) {
    const r = resultFor(byKey, step.step, step.component);
    if (r?.currentState) relevantStates.push({ state: r.currentState, at: r.temporalBasis ? new Date(r.temporalBasis.at) : null });
  }

  if (currentStateStep && currentStateResult && (currentStateResult.status === "SUPPORTED" || currentStateResult.status === "PARTIALLY_SUPPORTED")) {
    const cs = currentStateResult.currentState;
    const csAt = currentStateResult.temporalBasis ? new Date(currentStateResult.temporalBasis.at).getTime() : null;
    const csQualifiesLive =
      cs === "LIVE" || (cs === "IMPLEMENTING" && qualificationsOf(currentStateResult.reasonCodes).includes("STATE_NOT_FULLY_LIVE"));
    const newerConflict = relevantStates.some(
      (s) =>
        (s.state === "DEPRECATED" || s.state === "REMOVED") &&
        s.at !== null &&
        csAt !== null &&
        s.at.getTime() > csAt,
    );
    if (csQualifiesLive && !newerConflict) return "CURRENT";
  }

  if (executionEstablished) {
    const cs = currentStateResult?.currentState ?? null;
    const historicalState = cs === "DEPRECATED" || cs === "REMOVED" || cs === "PAUSED";
    const newerConflict = relevantStates.some((s) => s.state === "DEPRECATED" || s.state === "REMOVED");
    if (historicalState || newerConflict) return "HISTORICAL";
  }

  return "NOT_ESTABLISHED";
}

function compareGaps(a: MechanismGap, b: MechanismGap): number {
  const aAfter = a.afterStep ?? -1;
  const bAfter = b.afterStep ?? -1;
  if (aAfter !== bAfter) return aAfter - bAfter;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const aComp = a.component ?? "";
  const bComp = b.component ?? "";
  return aComp < bComp ? -1 : aComp > bComp ? 1 : 0;
}

function compareFlowPairs(
  a: { flow: MechanismFlow; branchSlotPath: number[] },
  b: { flow: MechanismFlow; branchSlotPath: number[] },
): number {
  const aStep = a.flow.branchPointStep ?? -1;
  const bStep = b.flow.branchPointStep ?? -1;
  if (aStep !== bStep) return aStep - bStep;
  const aPath = a.branchSlotPath.join(",");
  const bPath = b.branchSlotPath.join(",");
  if (aPath !== bPath) return aPath < bPath ? -1 : 1;
  return a.flow.flowId < b.flow.flowId ? -1 : a.flow.flowId > b.flow.flowId ? 1 : 0;
}
