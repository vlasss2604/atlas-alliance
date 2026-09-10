// ANALYTICAL OUTPUT INTELLIGENCE V1 — DETERMINISTIC BLOCK SELECTION.
//
// WHERE THIS SITS. Between a finished Proof and the screen:
//
//   QUESTION → RESEARCH → EVIDENCE → PROOF → [ANALYTICAL OUTPUT PLAN] → UI
//
// It is the rule the result blocks in `components/result-blocks/` were
// written without: given the structured record of a completed Research,
// which analytical forms does THAT record actually justify? A number is a
// METRIC only when a qualified measurement exists; rows are a TABLE only when
// two of them compare; a diagram is a FLOW only when a movement between
// established stages is on record. Nothing is rendered for decoration.
//
// IT DECIDES AND NAMES; IT NEVER ASSERTS. Every state a planned block carries
// is a presentation of a state the engine already persisted (a component
// result, an admitted Evidence row, an assembled mechanism edge). The planner
// performs no arithmetic on any quantity, reads no prose for numbers, calls
// no model, and cannot make a claim the record did not — see the invariants
// pinned by `tests/ui-output-plan.test.ts`. It also says WHY a block was NOT
// selected, in a closed vocabulary, because "none" is an analytical decision
// and a reader of the plan should be able to see it was taken.
//
// IT LIVES BESIDE `research-model.ts` ON PURPOSE. That module already derives
// the result screen from the canonical detail payload on the client; this is
// the same kind of derivation with a structured output. No persistence, no
// second truth model: the input below is a structural SUBSET of what the
// job-detail API already returns, plus two carriers (`quantities`,
// `entities`) the API does not project yet — see `inputFromResearchJobDetail`.
import type { ResearchJobDetail } from "./api";
import type { ProofState } from "./components/result-blocks/types";

/* ------------------------------------------------------------------ *
 * INPUT — what a completed Research hands the planner
 * ------------------------------------------------------------------ */

// One persisted S5 component result. The same fields as
// `ResearchJobDetail["components"][number]`, with `reasonCodes` narrowed to
// the strings they are at runtime.
export interface PlanComponent {
  step: number;
  component: string;
  status: string;
  reasonCodes: readonly string[];
  supportingEvidenceIds: readonly string[];
  contradictingEvidenceIds: readonly string[];
}

// One Evidence row, as the API projects it. `relationship` is the admission
// vocabulary (SUPPORTS / CONTRADICTS / CONTEXT / LIMITS); only the first two
// are admitted proof of anything.
export interface PlanEvidence {
  id: string;
  patternStep: number | null;
  component: string | null;
  relationship: string;
  directness: string | null;
  sourceClass: string | null;
  officiality: string | null;
  fragment: string;
  summary: string | null;
  doesNotProve: string | null;
  mechanismState: string | null;
  // The DATE OF THE THING, never the date of retrieval. A timeline built on
  // `fetchedAt` would date every milestone to the day the research ran.
  publishedAt: string | null;
  observedAt: string | null;
  fetchedAt: string;
  retrievedUrl: string;
  sourceTitle: string | null;
}

// The structural subset of the engine's `MechanismFlow` (S6) that block
// selection needs: nodes with their component status, edges with their basis
// and whether the movement was EXECUTED, and the NET_EFFECT attachment.
// Everything is a status the assembler already persisted.
export interface PlanFlowNode {
  kind: "VALUE_SOURCE" | "MECHANISM" | "DESTINATION";
  component: string;
  componentStatus: string;
}
export interface PlanFlowEdge {
  from: PlanFlowNode["kind"];
  to: PlanFlowNode["kind"];
  basisComponent: string;
  basisStatus: string;
  // The assembler's own determination. A transfer that HAPPENED and the
  // documented mechanism having RUN are different facts, and this flag is
  // the only thing allowed to say the second one.
  executed: boolean;
}
export interface PlanFlow {
  flowId: string;
  lifecycle: "CURRENT" | "HISTORICAL" | "NOT_ESTABLISHED";
  shape: "COMPLETE_PATH" | "PARTIAL_PATH";
  nodes: readonly PlanFlowNode[];
  edges: readonly PlanFlowEdge[];
  netEffect: { componentStatus: string } | null;
}

// ONE STRUCTURED QUANTITY, BY REFERENCE. Every one points at the Evidence row
// that carries it and names the closed on-chain fact kind it is — a value
// the planner could not trace to a typed fact is not a value it may show.
//
// `amountRaw` is the exact integer string the chain path stores (a signed
// one for TOTAL_SUPPLY_DELTA). NULL MEANS UNKNOWN AND IS NEVER ZERO: a
// period the research did not establish is carried as null and drawn as an
// empty slot, and a zero here is a MEASURED zero.
//
// `position` orders a value inside a series (a period, a slot). A quantity
// with no position is a point measurement and a METRIC candidate; one with
// a position belongs to a series and is a TABLE / CHART candidate. The
// planner never sums a series into a headline: an aggregate is a metric
// only when the record carries it as one, with its own `coverage` saying
// how much of the series it actually observed.
export interface PlanQuantity {
  evidenceId: string;
  // THE DETERMINISTIC OBSERVATION THIS VALUE WAS READ FROM — the stored
  // retrieval artifact, one row per read, carrying its own slot and hash.
  // It is what makes "the same measurement" answerable: two Evidence rows
  // that cite ONE artifact are one observation referenced twice, and two
  // artifacts are two observations however alike their numbers look. Null
  // where the record does not identify one, and a null never matches
  // anything, including another null.
  observationId: string | null;
  factKind: string;
  step: number;
  component: string;
  mint: string;
  decimals: number;
  amountRaw: string | null;
  direction?: "DECREASED" | "UNCHANGED" | "INCREASED";
  position: { key: string; ordinal: number } | null;
  coverage?: { observed: number; expected: number };
}

// AN ADDRESS THE RESEARCH MET, AND THE ROLE SOMEBODY CLAIMED FOR IT. Those
// are two different things and they stay in two fields: `claimedRole` is a
// documentary label; whether it is ESTABLISHED comes only from the
// component result that would establish such a role, and only when this
// entity's own evidence is among what established it.
export interface PlanEntity {
  address: string;
  chain: string;
  claimedRole: string | null;
  roleComponent: string | null;
  evidenceIds: readonly string[];
}

export interface AnalyticalOutputInputV1 {
  question: {
    text: string;
    // The interpreter's closed intent, or null. Orders blocks; never
    // selects them.
    intent: string | null;
    // Components the question projection named as the findings that matter
    // to THIS question. Structured relevance; empty means "everything".
    relevantComponents: readonly string[];
  };
  verdict: string | null;
  confidenceBand: string | null;
  components: readonly PlanComponent[];
  evidence: readonly PlanEvidence[];
  flows: readonly PlanFlow[];
  quantities: readonly PlanQuantity[];
  entities: readonly PlanEntity[];
}

/* ------------------------------------------------------------------ *
 * OUTPUT — the plan
 * ------------------------------------------------------------------ */

export const OUTPUT_PLAN_VERSION = 1;

export const ANALYTICAL_BLOCK_TYPES = [
  "ANSWER",
  "PROOF_MAP",
  "METRIC",
  "TABLE",
  "CHART",
  "FLOW",
  "TIMELINE",
  "ENTITY",
  "EVIDENCE_SNAPSHOT",
  "DEEP_PROOF",
] as const;
export type AnalyticalBlockType = (typeof ANALYTICAL_BLOCK_TYPES)[number];

// WHY A BLOCK WAS NOT SELECTED. Closed, so a test can assert the reason and
// a reader of the plan can see the decision rather than an absence.
export type BlockRejection =
  | "NO_COMPONENT_RESULTS"
  | "NO_ADMITTED_EVIDENCE"
  | "NO_QUALIFIED_MEASUREMENT"
  | "NO_COMPARABLE_ROWS"
  | "INSUFFICIENT_ORDERED_POINTS"
  | "NO_FLOW"
  | "NO_ESTABLISHED_EDGE"
  | "NO_ORDERED_STATE_CHANGE"
  | "NO_ESTABLISHED_ROLE";

export interface ComponentKey {
  step: number;
  component: string;
}

// What a block points back to. Every planned block can name the component
// results and Evidence rows it rests on, so the plan is checkable against
// the record and never a free-standing artifact.
export interface BlockRefs {
  components: ComponentKey[];
  evidenceIds: string[];
}

export type EconomicStep = "SOURCE" | "ALLOCATION" | "EXECUTION" | "EFFECT";
export type FlowStep = EconomicStep | "DESTINATION";

export interface PlannedMetric {
  evidenceId: string;
  observationId: string | null;
  factKind: string;
  component: string;
  step: EconomicStep | null;
  mint: string;
  decimals: number;
  amountRaw: string;
  direction: PlanQuantity["direction"] | null;
  // THE STANDING OF THE MEASUREMENT, AND ONLY OF THE MEASUREMENT. It comes
  // from the admission of the Evidence row that carries it, never from the
  // status of a component — a component grades a proposition, and a sound
  // reading that CONTRADICTS a proposition is still a sound reading.
  state: ProofState;
  coverage: { observed: number; expected: number } | null;
}

// THE CANONICAL PROPOSITION A MEASUREMENT BEARS ON, SHOWN BESIDE IT.
//
// A supply measurement invites the reader to conclude something about net
// effect. The selector does not draw that conclusion: it shows, next to the
// number, the state the ENGINE already persisted for the component that
// proposition belongs to (NET_EFFECT), copied exactly. When the record has
// no such component result, no claim is shown — a missing verdict is
// absent presentation data, never a verdict the selector supplies. Causal
// attribution has no upstream proposition in V1 and is therefore never
// stated here at all.
export interface PlannedClaim {
  component: string;
  state: ProofState;
  evidenceIds: string[];
}

export interface PlannedTableCell {
  evidenceId: string;
  amountRaw: string;
}
export interface PlannedTableRow {
  position: { key: string; ordinal: number };
  // Keyed by fact kind. A null cell is a value the research did not
  // establish — never omitted, never zero.
  cells: Record<string, PlannedTableCell | null>;
  state: ProofState;
}
export interface PlannedSeriesPoint {
  position: { key: string; ordinal: number };
  evidenceId: string | null;
  amountRaw: string | null;
  state: ProofState;
}
export interface PlannedSeries {
  factKind: string;
  points: PlannedSeriesPoint[];
}
export interface PlannedFlowStage {
  step: FlowStep;
  component: string | null;
  state: ProofState;
}
export interface PlannedTimelineEvent {
  kind: "DOCUMENTED" | "APPROVED" | "ACTIVATED" | "EXECUTED";
  component: string;
  date: string | null;
  state: ProofState;
  evidenceIds: string[];
}
export interface PlannedEntity {
  address: string;
  chain: string;
  // The claimed role, promoted to `role` ONLY when its state is established
  // or partly established. An address with an unestablished role is listed
  // with `role: null`, and the claim stays visible as a claim.
  role: string | null;
  claimedRole: string | null;
  roleComponent: string | null;
  state: ProofState;
  evidenceIds: string[];
}

export type PlannedBlock =
  | {
      type: "ANSWER";
      refs: BlockRefs;
      spec: { question: string; verdict: string | null; confidenceBand: string | null };
    }
  | {
      type: "PROOF_MAP";
      refs: BlockRefs;
      spec: { cells: { step: number; component: string; state: ProofState }[] };
    }
  | { type: "METRIC"; refs: BlockRefs; spec: { metrics: PlannedMetric[]; claims: PlannedClaim[] } }
  | {
      type: "TABLE";
      refs: BlockRefs;
      spec: { mint: string; decimals: number; columns: string[]; rows: PlannedTableRow[] };
    }
  | {
      type: "CHART";
      refs: BlockRefs;
      spec: { mint: string; decimals: number; series: PlannedSeries[] };
    }
  | {
      type: "FLOW";
      refs: BlockRefs;
      spec: { flowId: string; lifecycle: PlanFlow["lifecycle"]; stages: PlannedFlowStage[] };
    }
  | { type: "TIMELINE"; refs: BlockRefs; spec: { events: PlannedTimelineEvent[] } }
  | { type: "ENTITY"; refs: BlockRefs; spec: { entities: PlannedEntity[] } }
  | { type: "EVIDENCE_SNAPSHOT"; refs: BlockRefs; spec: { evidenceIds: string[] } }
  | {
      type: "DEEP_PROOF";
      refs: BlockRefs;
      spec: { rows: { step: number; component: string; state: ProofState; sources: number }[] };
    };

export interface RejectedBlock {
  type: AnalyticalBlockType;
  reason: BlockRejection;
}

export interface AnalyticalOutputPlanV1 {
  version: typeof OUTPUT_PLAN_VERSION;
  orderedBlocks: PlannedBlock[];
  rejected: RejectedBlock[];
}

/* ------------------------------------------------------------------ *
 * CLOSED TABLES — every judgement the planner makes is one of these
 * ------------------------------------------------------------------ */

// STATUS → STATE. The same asymmetry `research-model.ts` applies to the
// ladder: only CONTRADICTED is a positive finding of the opposite, and
// INSUFFICIENT_EVIDENCE — or no status at all — is "not established", never
// "not happening".
export function proofStateOf(status: string | null | undefined): ProofState {
  switch (status) {
    case "SUPPORTED":
      return "ESTABLISHED";
    case "PARTIALLY_SUPPORTED":
      return "PARTLY_ESTABLISHED";
    case "CONTRADICTED":
      return "CONTRADICTED";
    default:
      return "NOT_ESTABLISHED";
  }
}

const STANDS = new Set<ProofState>(["ESTABLISHED", "PARTLY_ESTABLISHED"]);

// Which position in the economic chain a component's measure belongs to.
// DESTINATION and RECIPIENT have no chain step: no measure establishes
// where value went, so a quantity filed there is a metric with no step.
const ECONOMIC_STEP_OF_COMPONENT: Record<string, EconomicStep> = {
  SOURCE_OF_VALUE: "SOURCE",
  FLOW_PATH: "SOURCE",
  MECHANISM_SPEC: "ALLOCATION",
  EXECUTION_EVIDENCE: "EXECUTION",
  NET_EFFECT: "EFFECT",
};

// WHICH POSITIONS A MEASUREMENT OF THIS KIND CAN ACTUALLY OCCUPY.
//
// The component above says which QUESTION a reading was admitted for; it
// does not say what the reading MEANS. Those come apart exactly where it
// matters most: a total-supply level is admitted by NET_EFFECT because the
// question "did supply change?" is answered partly from levels — and the
// level itself is not a change. Placing it at EFFECT because of the
// component that consumed it publishes a point-in-time observation as a
// measured outcome, which is the difference between
//
//   TOTAL SUPPLY IS 835.6B      (a state, at one observation)
//   SUPPLY FELL BY 6.7M         (a change, across an interval)
//
// and the product exists to keep those apart. So the kind CONSTRAINS and
// the component SELECTS: a reading takes its component's step only when
// its own kind can carry that step, and otherwise carries none.
//
// TOTAL, NOT PARTIAL — every quantity kind is listed, the empty sets
// included, so a kind added later must declare what it can mean before it
// can appear anywhere on the chain.
//
// THE EMPTY SETS ARE THE POINT. A supply level and an account balance are
// STATES: neither is a movement of value, a destruction of it, or a change
// in anything. They are real, established measurements with no position in
// SOURCE → ALLOCATION → EXECUTION → EFFECT, and they are shown as measures
// without one rather than filed under a stage they do not belong to.
const ECONOMIC_STEPS_A_FACT_KIND_CAN_CARRY: Record<string, readonly EconomicStep[]> = {
  // States, not events.
  TOKEN_SUPPLY: [],
  TOKEN_ACCOUNT_BALANCE: [],
  // A measured change in total supply across an interval. This is the one
  // supply fact that IS an effect.
  TOTAL_SUPPLY_DELTA: ["EFFECT"],
  // A destruction event: the mechanism running. NOT an effect — EFFECT on
  // this chain means the NET change in supply, and a burn is a GROSS
  // reduction. The engine keeps the same two apart with two reason codes:
  // one deterministic BURN clears SUPPLY_REDUCTION_NOT_ESTABLISHED and
  // leaves NET_SUPPLY_CHANGE_NOT_ESTABLISHED standing, because destroying
  // tokens says nothing about what issuance did over the same interval.
  // Letting a burn occupy EFFECT would publish a gross reduction as the net
  // outcome — the exact leap that distinction exists to prevent.
  BURN: ["EXECUTION"],
  // Movements of value.
  DECODED_EXCHANGE: ["EXECUTION"],
  TOKEN_TRANSFER: ["EXECUTION"],
  NATIVE_TRANSFER: ["SOURCE", "EXECUTION"],
};

// The chain position for one measurement, or null when its kind cannot
// carry the position its component would suggest.
function economicStepFor(factKind: string, component: string): EconomicStep | null {
  const candidate = ECONOMIC_STEP_OF_COMPONENT[component];
  if (candidate === undefined) return null;
  const allowed = ECONOMIC_STEPS_A_FACT_KIND_CAN_CARRY[factKind] ?? [];
  return allowed.includes(candidate) ? candidate : null;
}
const ECONOMIC_STEP_ORDER: Record<EconomicStep, number> = {
  SOURCE: 0,
  ALLOCATION: 1,
  EXECUTION: 2,
  EFFECT: 3,
};

// The on-chain fact kinds that ARE a quantity. A signature list, an account
// relation or a decoded instruction set carries no amount to show.
const QUANTITY_FACT_KINDS = new Set([
  "TOKEN_SUPPLY",
  "TOTAL_SUPPLY_DELTA",
  "BURN",
  "TOKEN_TRANSFER",
  "NATIVE_TRANSFER",
  "DECODED_EXCHANGE",
  "TOKEN_ACCOUNT_BALANCE",
]);

// The milestones a timeline dates, each read from exactly one component
// whose proposition IS that milestone. An APPROVED milestone comes from
// GOVERNANCE_BASIS and from nothing else — an established execution says
// nothing about it. ACTIVATED IS DELIBERATELY ABSENT: no component in the
// V1 record has "the mechanism was switched on" as its proposition —
// CURRENT_STATE grades whether the mechanism is live NOW, which is a
// different claim — so the milestone is omitted rather than inferred.
const TIMELINE_KIND_OF_COMPONENT: Record<string, PlannedTimelineEvent["kind"]> = {
  MECHANISM_SPEC: "DOCUMENTED",
  GOVERNANCE_BASIS: "APPROVED",
  EXECUTION_EVIDENCE: "EXECUTED",
};
const TIMELINE_KIND_ORDER: Record<PlannedTimelineEvent["kind"], number> = {
  DOCUMENTED: 0,
  APPROVED: 1,
  ACTIVATED: 2,
  EXECUTED: 3,
};

// Evidence snapshot ranking. Deterministic, from persisted authority
// metadata only: a direct contradiction outranks everything, chain facts
// outrank documents, documents outrank media. No popularity, no counting.
const SOURCE_CLASS_RANK: Record<string, number> = {
  ONCHAIN_VERIFIABLE: 50,
  OFFICIAL_DOCS: 40,
  GOVERNANCE: 35,
  OFFICIAL_REPORT: 30,
  DATA_PROVIDER: 20,
  RESEARCH_MEDIA: 10,
  SOCIAL: 0,
};
export const MAX_EVIDENCE_SNAPSHOTS = 4;
export const MAX_METRICS = 4;
export const MAX_FLOWS = 2;
export const MIN_TABLE_ROWS = 2;
// A chart needs a SHAPE. Two points are an interval, and an interval is
// already a metric and a two-row table; three ordered points is the least a
// trend can be read from.
export const MIN_CHART_POINTS = 3;
export const MIN_CHART_KNOWN_POINTS = 2;
export const MIN_TIMELINE_DATED_EVENTS = 2;

// BLOCK ORDER BY INTENT FAMILY. The spine — ANSWER, PROOF_MAP first;
// ENTITY, TIMELINE, EVIDENCE_SNAPSHOT, DEEP_PROOF last — is fixed. The
// analytical middle is ordered by what the question was about, and this is
// the ONLY thing the intent does: it never makes a block eligible.
const ANALYTICAL_ORDER: Record<"SUPPLY" | "STATE" | "DEFAULT", AnalyticalBlockType[]> = {
  SUPPLY: ["METRIC", "TABLE", "CHART", "FLOW", "TIMELINE", "ENTITY"],
  STATE: ["TIMELINE", "FLOW", "METRIC", "TABLE", "CHART", "ENTITY"],
  DEFAULT: ["METRIC", "FLOW", "TABLE", "CHART", "ENTITY", "TIMELINE"],
};

function orderFamily(intent: string | null): keyof typeof ANALYTICAL_ORDER {
  switch (intent) {
    case "BURN_OR_SUPPLY_EFFECT":
      return "SUPPLY";
    case "MECHANISM_CURRENT_STATE":
      return "STATE";
    default:
      return "DEFAULT";
  }
}

// A canonical integer string, optionally signed. Anything the chain path
// would not have written — decimals, exponents, whitespace, "+" — is refused
// rather than coerced.
const CANONICAL_INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ *
 * THE PLANNER
 * ------------------------------------------------------------------ */

export function chooseAnalyticalBlocks(input: AnalyticalOutputInputV1): AnalyticalOutputPlanV1 {
  const ctx = buildContext(input);
  const rejected: RejectedBlock[] = [];
  const planned = new Map<AnalyticalBlockType, PlannedBlock[]>();

  const consider = (type: AnalyticalBlockType, out: PlannedBlock[] | BlockRejection) => {
    if (typeof out === "string") rejected.push({ type, reason: out });
    else planned.set(type, out);
  };

  consider("ANSWER", [answerBlock(input)]);
  consider("PROOF_MAP", proofMapBlock(ctx));
  consider("METRIC", metricBlock(ctx));
  const series = seriesGroups(ctx);
  consider("TABLE", tableBlocks(series));
  consider("CHART", chartBlocks(series));
  consider("FLOW", flowBlocks(ctx));
  consider("TIMELINE", timelineBlock(ctx));
  consider("ENTITY", entityBlock(ctx));
  consider("EVIDENCE_SNAPSHOT", evidenceSnapshotBlock(ctx));
  consider("DEEP_PROOF", deepProofBlock(ctx));

  const order: AnalyticalBlockType[] = [
    "ANSWER",
    "PROOF_MAP",
    ...ANALYTICAL_ORDER[orderFamily(input.question.intent)],
    "EVIDENCE_SNAPSHOT",
    "DEEP_PROOF",
  ];
  const orderedBlocks = order.flatMap((t) => planned.get(t) ?? []);
  return { version: OUTPUT_PLAN_VERSION, orderedBlocks, rejected };
}

interface Context {
  input: AnalyticalOutputInputV1;
  componentByName: Map<string, PlanComponent>;
  evidenceById: Map<string, PlanEvidence>;
  relevant: Set<string>;
}

function buildContext(input: AnalyticalOutputInputV1): Context {
  return {
    input,
    componentByName: new Map(input.components.map((c) => [c.component, c])),
    evidenceById: new Map(input.evidence.map((e) => [e.id, e])),
    relevant: new Set(input.question.relevantComponents),
  };
}

function sortedComponents(ctx: Context): PlanComponent[] {
  return [...ctx.input.components].sort(
    (a, b) => a.step - b.step || byString(a.component, b.component),
  );
}

function keyOf(c: PlanComponent): ComponentKey {
  return { step: c.step, component: c.component };
}

// Admitted means SUPPORTS or CONTRADICTS. CONTEXT and LIMITS rows are read
// and kept, and they establish nothing.
function isAdmitted(e: PlanEvidence | undefined): e is PlanEvidence {
  return e !== undefined && (e.relationship === "SUPPORTS" || e.relationship === "CONTRADICTS");
}

// THE STANDING OF A MEASUREMENT: how the row carrying it was admitted. A
// direct read is established; an indirect one is partly so; a row that was
// not admitted, or does not exist, carries no measurement the plan may show.
function measurementState(ctx: Context, evidenceId: string): ProofState | null {
  const e = ctx.evidenceById.get(evidenceId);
  if (!isAdmitted(e)) return null;
  return e.directness === "DIRECT" ? "ESTABLISHED" : "PARTLY_ESTABLISHED";
}

/* ----------------------------- ANSWER ----------------------------- */

function answerBlock(input: AnalyticalOutputInputV1): PlannedBlock {
  return {
    type: "ANSWER",
    refs: { components: [], evidenceIds: [] },
    // Copied, never recomputed. A null verdict is carried as null.
    spec: {
      question: input.question.text,
      verdict: input.verdict,
      confidenceBand: input.confidenceBand,
    },
  };
}

/* --------------------------- PROOF MAP ---------------------------- */

// Coverage understanding: one cell per persisted component result, in
// Pattern order. Eligible whenever the run assessed anything at all.
function proofMapBlock(ctx: Context): PlannedBlock[] | BlockRejection {
  const comps = sortedComponents(ctx);
  if (comps.length === 0) return "NO_COMPONENT_RESULTS";
  return [
    {
      type: "PROOF_MAP",
      refs: { components: comps.map(keyOf), evidenceIds: [] },
      spec: {
        cells: comps.map((c) => ({
          step: c.step,
          component: c.component,
          state: proofStateOf(c.status),
        })),
      },
    },
  ];
}

/* ---------------------------- METRICS ----------------------------- */

// A METRIC is a POINT measurement that the record qualifies on every axis:
// a typed quantity kind, an exact value, a known unit domain, an admitted
// Evidence row to stand on, and a component result to belong to. A series
// value is not a metric (it is a row); an unknown value is not a metric
// (it is not a value); a value the planner would have to compute is not a
// metric (the planner computes nothing).
function metricBlock(ctx: Context): PlannedBlock[] | BlockRejection {
  const candidates: PlannedMetric[] = [];
  for (const q of ctx.input.quantities) {
    if (q.position !== null) continue;
    if (!QUANTITY_FACT_KINDS.has(q.factKind)) continue;
    if (q.amountRaw === null || !CANONICAL_INTEGER.test(q.amountRaw)) continue;
    if (!Number.isInteger(q.decimals) || q.decimals < 0 || q.mint.length === 0) continue;
    if (!ctx.componentByName.has(q.component)) continue;
    const admitted = measurementState(ctx, q.evidenceId);
    if (admitted === null) continue;
    const coverage = q.coverage ?? null;
    if (coverage !== null && (coverage.expected <= 0 || coverage.observed > coverage.expected)) continue;
    candidates.push({
      evidenceId: q.evidenceId,
      observationId: q.observationId,
      factKind: q.factKind,
      component: q.component,
      step: economicStepFor(q.factKind, q.component),
      mint: q.mint,
      decimals: q.decimals,
      amountRaw: q.amountRaw,
      direction: q.direction ?? null,
      // An aggregate that observed less than it set out to is partly
      // established as a total, however sound each observed part.
      state:
        coverage !== null && coverage.observed < coverage.expected
          ? "PARTLY_ESTABLISHED"
          : admitted,
      coverage,
    });
  }
  if (candidates.length === 0) return "NO_QUALIFIED_MEASUREMENT";

  // Relevance decides WHICH metrics survive the cap; the chain decides the
  // ORDER they are shown in. The strip is read as SOURCE → ALLOCATION →
  // EXECUTION → EFFECT whatever the question, because that order is the
  // argument the numbers make, and relevance never admits a metric.
  const rank = (m: PlannedMetric) => (m.step === null ? 4 : ECONOMIC_STEP_ORDER[m.step]);
  const relevance = (m: PlannedMetric) =>
    ctx.relevant.size === 0 || ctx.relevant.has(m.component) ? 0 : 1;
  const stable = (a: PlannedMetric, b: PlannedMetric) =>
    rank(a) - rank(b) || byString(a.factKind, b.factKind) || byString(a.evidenceId, b.evidenceId);
  // ONE OBSERVATION, ONE HEADLINE.
  //
  // The same reading is admitted by more than one component whenever two
  // propositions rest on it — a total-supply level answers both "is this
  // mechanism live?" and "did supply change?" — and the record then holds
  // it as two Evidence rows citing ONE stored artifact. Two identical tiles
  // side by side read as two findings and inflate one measurement into a
  // pattern; it is one measurement, referenced twice.
  //
  // IDENTITY IS THE OBSERVATION, NEVER AN EQUAL NUMBER. Two reads of total
  // supply at different slots can return the same amount — that is what
  // "supply was UNCHANGED across the interval" IS, and the engine models it
  // explicitly. Collapsing on the value would erase one endpoint of exactly
  // that interval and turn two real observations into one. So rows collapse
  // only when they cite the same artifact for the same fact kind: one read,
  // one slot, one hash, referenced more than once.
  //
  // A null observation id matches nothing, including another null: a value
  // whose read the record does not identify is never merged with anything.
  // The first in the deterministic order keeps the tile, and every row that
  // carried it stays in the block's references, so collapsing loses nothing
  // from the record trail.
  const identity = (m: PlannedMetric) =>
    m.observationId === null ? null : `${m.factKind}|${m.observationId}`;
  const unique: PlannedMetric[] = [];
  const alsoCarriedBy = new Map<string, string[]>();
  for (const m of [...candidates].sort((a, b) => relevance(a) - relevance(b) || stable(a, b))) {
    const key = identity(m);
    if (key === null) {
      unique.push(m);
      continue;
    }
    const existing = alsoCarriedBy.get(key);
    if (existing) {
      existing.push(m.evidenceId);
      continue;
    }
    alsoCarriedBy.set(key, []);
    unique.push(m);
  }
  const metrics = unique.slice(0, MAX_METRICS).sort(stable);

  return [
    {
      type: "METRIC",
      refs: {
        components: uniqueKeys(ctx, metrics.map((m) => m.component)),
        evidenceIds: [
          ...new Set(
            metrics.flatMap((m) => {
              const key = identity(m);
              return [m.evidenceId, ...(key === null ? [] : (alsoCarriedBy.get(key) ?? []))];
            }),
          ),
        ].sort(byString),
      },
      spec: { metrics, claims: claimsFor(ctx, metrics) },
    },
  ];
}

// THE PROPOSITION THE STRIP MUST NOT IMPLY, COPIED FROM UPSTREAM.
//
// When a total-supply measurement is on the strip, the reader will ask
// what it means for net effect. The answer shown is the persisted
// NET_EFFECT component result — its state, exactly — and nothing is
// computed from the measured direction here: the engine's reducer already
// read the same delta and graded the proposition, and a second grading in
// the presentation layer could only agree with it or contradict it. With
// no NET_EFFECT result in the record there is no claim.
function claimsFor(ctx: Context, metrics: PlannedMetric[]): PlannedClaim[] {
  const deltas = metrics.filter((m) => m.factKind === "TOTAL_SUPPLY_DELTA");
  const netEffect = ctx.componentByName.get("NET_EFFECT");
  if (deltas.length === 0 || !netEffect) return [];
  return [
    {
      component: netEffect.component,
      state: proofStateOf(netEffect.status),
      evidenceIds: deltas.map((d) => d.evidenceId),
    },
  ];
}

/* ------------------------- TABLE AND CHART ------------------------ */

// A SERIES GROUP: positioned quantities that share one unit domain (mint
// and decimals). Two quantities of different mints never share a table,
// however similar their numbers look — the columns would not compare.
interface SeriesGroup {
  mint: string;
  decimals: number;
  columns: string[];
  positions: { key: string; ordinal: number }[];
  // cell[factKind][positionKey]
  cells: Map<string, Map<string, { evidenceId: string; amountRaw: string | null; state: ProofState }>>;
  components: string[];
}

function seriesGroups(ctx: Context): { groups: SeriesGroup[]; ctx: Context } {
  const groups = new Map<string, SeriesGroup>();
  for (const q of ctx.input.quantities) {
    if (q.position === null) continue;
    if (!QUANTITY_FACT_KINDS.has(q.factKind)) continue;
    if (!Number.isInteger(q.decimals) || q.decimals < 0 || q.mint.length === 0) continue;
    if (q.amountRaw !== null && !CANONICAL_INTEGER.test(q.amountRaw)) continue;
    if (!ctx.componentByName.has(q.component)) continue;
    const admitted = measurementState(ctx, q.evidenceId);
    if (admitted === null) continue;

    const id = `${q.mint}:${q.decimals}`;
    let g = groups.get(id);
    if (!g) {
      g = { mint: q.mint, decimals: q.decimals, columns: [], positions: [], cells: new Map(), components: [] };
      groups.set(id, g);
    }
    if (!g.columns.includes(q.factKind)) g.columns.push(q.factKind);
    if (!g.positions.some((p) => p.key === q.position!.key)) g.positions.push({ ...q.position });
    if (!g.components.includes(q.component)) g.components.push(q.component);
    let col = g.cells.get(q.factKind);
    if (!col) {
      col = new Map();
      g.cells.set(q.factKind, col);
    }
    // First row wins for a duplicate (kind, position); the record should
    // not carry two, and choosing between them would be choosing a value.
    if (!col.has(q.position.key)) {
      col.set(q.position.key, {
        evidenceId: q.evidenceId,
        amountRaw: q.amountRaw,
        // AN UNKNOWN CELL IS NOT ESTABLISHED. It is never a zero and never
        // borrows the row's admission — there is no value to admit.
        state: q.amountRaw === null ? "NOT_ESTABLISHED" : admitted,
      });
    }
  }
  const out = [...groups.values()].map((g) => ({
    ...g,
    columns: [...g.columns].sort(byString),
    positions: [...g.positions].sort((a, b) => a.ordinal - b.ordinal || byString(a.key, b.key)),
    components: [...g.components].sort(byString),
  }));
  out.sort((a, b) => byString(a.mint, b.mint) || a.decimals - b.decimals);
  return { groups: out, ctx };
}

// A TABLE is exact values with their states, for comparison: at least two
// positioned rows in one unit domain. One row is a metric, not a table;
// two rows of different mints are two facts, not a table.
function tableBlocks({ groups, ctx }: ReturnType<typeof seriesGroups>): PlannedBlock[] | BlockRejection {
  const blocks: PlannedBlock[] = [];
  for (const g of groups) {
    if (g.positions.length < MIN_TABLE_ROWS) continue;
    const rows: PlannedTableRow[] = g.positions.map((p) => {
      const cells: Record<string, PlannedTableCell | null> = {};
      let known = 0;
      for (const kind of g.columns) {
        const cell = g.cells.get(kind)?.get(p.key);
        if (cell && cell.amountRaw !== null) {
          cells[kind] = { evidenceId: cell.evidenceId, amountRaw: cell.amountRaw };
          known += 1;
        } else {
          cells[kind] = null;
        }
      }
      return {
        position: p,
        cells,
        state:
          known === g.columns.length ? "ESTABLISHED" : known > 0 ? "PARTLY_ESTABLISHED" : "NOT_ESTABLISHED",
      };
    });
    // A table with nothing known in it compares nothing.
    if (!rows.some((r) => r.state !== "NOT_ESTABLISHED")) continue;
    blocks.push({
      type: "TABLE",
      refs: {
        components: uniqueKeys(ctx, g.components),
        evidenceIds: evidenceIdsOf(g),
      },
      spec: { mint: g.mint, decimals: g.decimals, columns: g.columns, rows },
    });
  }
  return blocks.length > 0 ? blocks : "NO_COMPARABLE_ROWS";
}

// A CHART is a shape: at least MIN_CHART_POINTS ordered positions of one
// measure, of which at least MIN_CHART_KNOWN_POINTS carry a value. Unknown
// positions are kept as null points — an empty slot, never a zero and never
// interpolated. Series that do not qualify are left out rather than padded.
function chartBlocks({ groups, ctx }: ReturnType<typeof seriesGroups>): PlannedBlock[] | BlockRejection {
  const blocks: PlannedBlock[] = [];
  for (const g of groups) {
    if (g.positions.length < MIN_CHART_POINTS) continue;
    const series: PlannedSeries[] = [];
    for (const kind of g.columns) {
      const col = g.cells.get(kind);
      const points: PlannedSeriesPoint[] = g.positions.map((p) => {
        const cell = col?.get(p.key);
        return cell && cell.amountRaw !== null
          ? { position: p, evidenceId: cell.evidenceId, amountRaw: cell.amountRaw, state: cell.state }
          : { position: p, evidenceId: null, amountRaw: null, state: "NOT_ESTABLISHED" };
      });
      if (points.filter((p) => p.amountRaw !== null).length < MIN_CHART_KNOWN_POINTS) continue;
      series.push({ factKind: kind, points });
    }
    if (series.length === 0) continue;
    blocks.push({
      type: "CHART",
      refs: { components: uniqueKeys(ctx, g.components), evidenceIds: evidenceIdsOf(g) },
      spec: { mint: g.mint, decimals: g.decimals, series },
    });
  }
  return blocks.length > 0 ? blocks : "INSUFFICIENT_ORDERED_POINTS";
}

function evidenceIdsOf(g: SeriesGroup): string[] {
  const ids = new Set<string>();
  for (const col of g.cells.values()) for (const c of col.values()) ids.add(c.evidenceId);
  return [...ids].sort(byString);
}

/* ------------------------------ FLOW ------------------------------ */

// FLOW IS THE RISKIEST BLOCK, BECAUSE ARROWS IMPLY CAUSATION. So every
// stage carries its own state, from its own persisted status, and the block
// is not planned at all unless the record holds an ESTABLISHED movement —
// at least one edge whose basis stands. A diagram of five unresolved boxes
// is not a finding; it is a guess drawn with lines.
//
// The EXECUTION stage is the one that says the mechanism RAN. It is read
// from the assembler's `executed` flag on the edge into the destination —
// not from the edge's basis status, which grades the evidence for the path,
// and not from any transfer having been observed. WHERE ≠ WHO; a
// transaction that happened ≠ the documented mechanism having executed.
function flowBlocks(ctx: Context): PlannedBlock[] | BlockRejection {
  if (ctx.input.flows.length === 0) return "NO_FLOW";
  const lifecycleRank: Record<PlanFlow["lifecycle"], number> = {
    CURRENT: 0,
    HISTORICAL: 1,
    NOT_ESTABLISHED: 2,
  };
  const flows = [...ctx.input.flows].sort(
    (a, b) => lifecycleRank[a.lifecycle] - lifecycleRank[b.lifecycle] || byString(a.flowId, b.flowId),
  );
  const blocks: PlannedBlock[] = [];
  for (const f of flows) {
    const established = f.edges.some((e) => STANDS.has(proofStateOf(e.basisStatus)));
    if (!established) continue;
    const node = (kind: PlanFlowNode["kind"]) => f.nodes.find((n) => n.kind === kind) ?? null;
    const intoDestination = f.edges.find((e) => e.to === "DESTINATION") ?? null;
    const stage = (step: FlowStep, n: PlanFlowNode | null): PlannedFlowStage => ({
      step,
      component: n?.component ?? null,
      state: n ? proofStateOf(n.componentStatus) : "NOT_ESTABLISHED",
    });
    const stages: PlannedFlowStage[] = [
      stage("SOURCE", node("VALUE_SOURCE")),
      stage("ALLOCATION", node("MECHANISM")),
      {
        step: "EXECUTION",
        component: intoDestination?.basisComponent ?? null,
        state:
          intoDestination !== null && intoDestination.executed
            ? proofStateOf(intoDestination.basisStatus)
            : "NOT_ESTABLISHED",
      },
      stage("DESTINATION", node("DESTINATION")),
      {
        step: "EFFECT",
        component: f.netEffect ? "NET_EFFECT" : null,
        state: f.netEffect ? proofStateOf(f.netEffect.componentStatus) : "NOT_ESTABLISHED",
      },
    ];
    // A movement needs two ends. Fewer than two standing stages is a chain
    // that is mostly speculation, and the product prefers no diagram to one.
    if (stages.filter((s) => STANDS.has(s.state)).length < 2) continue;
    const components = [
      ...f.nodes.map((n) => n.component),
      ...f.edges.map((e) => e.basisComponent),
      ...(f.netEffect ? ["NET_EFFECT"] : []),
    ];
    blocks.push({
      type: "FLOW",
      refs: { components: uniqueKeys(ctx, components), evidenceIds: [] },
      spec: { flowId: f.flowId, lifecycle: f.lifecycle, stages },
    });
    if (blocks.length === MAX_FLOWS) break;
  }
  return blocks.length > 0 ? blocks : "NO_ESTABLISHED_EDGE";
}

/* ---------------------------- TIMELINE ---------------------------- */

// A TIMELINE is a progression of DIFFERENT claims through time: written
// down, authorised, switched on, seen running. Each milestone is read from
// its own component and dated from that component's own admitted evidence
// — the earliest published or observed date, never the retrieval date. A
// milestone with no component result is not shown; one with no date is
// shown undated. Nothing is inferred: an established execution does not
// backfill an approval, and the block is not planned unless at least two
// distinct milestones actually carry dates.
function timelineBlock(ctx: Context): PlannedBlock[] | BlockRejection {
  const events: PlannedTimelineEvent[] = [];
  for (const c of sortedComponents(ctx)) {
    const kind = TIMELINE_KIND_OF_COMPONENT[c.component];
    if (!kind) continue;
    const ids = [...c.supportingEvidenceIds, ...c.contradictingEvidenceIds]
      .filter((id) => isAdmitted(ctx.evidenceById.get(id)))
      .sort(byString);
    const dates = ids
      .map((id) => ctx.evidenceById.get(id)!)
      .map((e) => e.publishedAt ?? e.observedAt)
      .filter((d): d is string => d !== null)
      .sort(byString);
    events.push({
      kind,
      component: c.component,
      date: dates[0] ?? null,
      state: proofStateOf(c.status),
      evidenceIds: ids,
    });
  }
  const dated = events.filter((e) => e.date !== null);
  if (new Set(dated.map((e) => e.kind)).size < MIN_TIMELINE_DATED_EVENTS) {
    return "NO_ORDERED_STATE_CHANGE";
  }
  events.sort(
    (a, b) =>
      (a.date === null ? 1 : 0) - (b.date === null ? 1 : 0) ||
      byString(a.date ?? "", b.date ?? "") ||
      TIMELINE_KIND_ORDER[a.kind] - TIMELINE_KIND_ORDER[b.kind],
  );
  return [
    {
      type: "TIMELINE",
      refs: {
        components: uniqueKeys(ctx, events.map((e) => e.component)),
        evidenceIds: [...new Set(events.flatMap((e) => e.evidenceIds))].sort(byString),
      },
      spec: { events },
    },
  ];
}

/* ----------------------------- ENTITY ----------------------------- */

// ADDRESS EXISTS ≠ ECONOMIC ROLE ESTABLISHED. An entity's role state is the
// status of the component that would establish such a role, and only when
// this entity's own evidence is among what that component admitted. An
// address that merely appears in a transaction has no role component, no
// intersection, and therefore no role — it is listed as an address. The
// block is planned only when at least one role actually stands.
function entityBlock(ctx: Context): PlannedBlock[] | BlockRejection {
  const entities: PlannedEntity[] = [...ctx.input.entities]
    .map((e) => {
      const comp = e.roleComponent ? ctx.componentByName.get(e.roleComponent) : undefined;
      const admittedHere = comp
        ? new Set([...comp.supportingEvidenceIds, ...comp.contradictingEvidenceIds])
        : new Set<string>();
      const grounded = e.evidenceIds.filter((id) => admittedHere.has(id)).sort(byString);
      const state: ProofState = comp && grounded.length > 0 ? proofStateOf(comp.status) : "NOT_ESTABLISHED";
      return {
        address: e.address,
        chain: e.chain,
        role: STANDS.has(state) ? e.claimedRole : null,
        claimedRole: e.claimedRole,
        roleComponent: e.roleComponent,
        state,
        evidenceIds: grounded,
      };
    })
    .sort((a, b) => byString(a.chain, b.chain) || byString(a.address, b.address));
  if (!entities.some((e) => STANDS.has(e.state))) return "NO_ESTABLISHED_ROLE";
  return [
    {
      type: "ENTITY",
      refs: {
        components: uniqueKeys(
          ctx,
          entities.flatMap((e) => (e.roleComponent && STANDS.has(e.state) ? [e.roleComponent] : [])),
        ),
        evidenceIds: [...new Set(entities.flatMap((e) => e.evidenceIds))].sort(byString),
      },
      spec: { entities },
    },
  ];
}

/* ------------------------ EVIDENCE SNAPSHOT ----------------------- */

// The few strongest admitted rows behind the result, ranked by persisted
// authority metadata alone. A direct contradiction always surfaces; a chain
// fact outranks a document; a document outranks media; a row bearing on a
// component the question named moves up. Ties break on id, so the same
// record always yields the same four.
function evidenceSnapshotBlock(ctx: Context): PlannedBlock[] | BlockRejection {
  const assessed = new Set(ctx.input.components.map((c) => c.component));
  const rows = ctx.input.evidence.filter(
    (e) => isAdmitted(e) && e.fragment.trim().length > 0 && e.component !== null && assessed.has(e.component),
  );
  if (rows.length === 0) return "NO_ADMITTED_EVIDENCE";
  const score = (e: PlanEvidence) =>
    (e.relationship === "CONTRADICTS" ? 100 : 0) +
    (SOURCE_CLASS_RANK[e.sourceClass ?? ""] ?? 0) +
    (e.officiality === "CONFIRMED" ? 5 : 0) +
    (e.directness === "DIRECT" ? 8 : e.directness === "INDIRECT" ? 3 : 0) +
    (ctx.relevant.size > 0 && e.component !== null && ctx.relevant.has(e.component) ? 12 : 0);
  const ranked = [...rows].sort((a, b) => score(b) - score(a) || byString(a.id, b.id));
  const chosen = ranked.slice(0, MAX_EVIDENCE_SNAPSHOTS);
  return [
    {
      type: "EVIDENCE_SNAPSHOT",
      refs: {
        components: uniqueKeys(ctx, chosen.map((e) => e.component!)),
        evidenceIds: chosen.map((e) => e.id),
      },
      spec: { evidenceIds: chosen.map((e) => e.id) },
    },
  ];
}

/* --------------------------- DEEP PROOF --------------------------- */

// The handover to verification: every assessed component with its state
// and how many admitted rows stand behind it. Same eligibility as the proof
// map, different depth — one is a shape read in a second, the other is the
// entry to checking each line.
function deepProofBlock(ctx: Context): PlannedBlock[] | BlockRejection {
  const comps = sortedComponents(ctx);
  if (comps.length === 0) return "NO_COMPONENT_RESULTS";
  return [
    {
      type: "DEEP_PROOF",
      refs: { components: comps.map(keyOf), evidenceIds: [] },
      spec: {
        rows: comps.map((c) => ({
          step: c.step,
          component: c.component,
          state: proofStateOf(c.status),
          sources: c.supportingEvidenceIds.length + c.contradictingEvidenceIds.length,
        })),
      },
    },
  ];
}

function uniqueKeys(ctx: Context, components: readonly string[]): ComponentKey[] {
  const seen = new Map<string, ComponentKey>();
  for (const name of components) {
    const c = ctx.componentByName.get(name);
    if (c && !seen.has(name)) seen.set(name, keyOf(c));
  }
  return [...seen.values()].sort((a, b) => a.step - b.step || byString(a.component, b.component));
}

/* ------------------------------------------------------------------ *
 * ADAPTER — from the job-detail payload the result screen already loads
 * ------------------------------------------------------------------ */

// Structural guard for `mechanism.flows`, which the API types as
// `unknown[]` and the engine persists as `MechanismFlow[]`. A row that does
// not carry the fields the planner reads is dropped, never repaired.
function isPlanFlow(value: unknown): value is PlanFlow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const nodesOk =
    Array.isArray(v.nodes) &&
    v.nodes.every(
      (n) =>
        typeof n === "object" &&
        n !== null &&
        typeof (n as PlanFlowNode).kind === "string" &&
        typeof (n as PlanFlowNode).component === "string" &&
        typeof (n as PlanFlowNode).componentStatus === "string",
    );
  const edgesOk =
    Array.isArray(v.edges) &&
    v.edges.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as PlanFlowEdge).from === "string" &&
        typeof (e as PlanFlowEdge).to === "string" &&
        typeof (e as PlanFlowEdge).basisComponent === "string" &&
        typeof (e as PlanFlowEdge).basisStatus === "string" &&
        typeof (e as PlanFlowEdge).executed === "boolean",
    );
  const netOk =
    v.netEffect === null ||
    (typeof v.netEffect === "object" &&
      v.netEffect !== null &&
      typeof (v.netEffect as { componentStatus: unknown }).componentStatus === "string");
  return (
    typeof v.flowId === "string" &&
    typeof v.lifecycle === "string" &&
    typeof v.shape === "string" &&
    nodesOk &&
    edgesOk &&
    netOk
  );
}

// WHAT THE PAYLOAD CAN FILL TODAY, AND WHAT IT CANNOT. Components, admitted
// Evidence, the assembled mechanism, the verdict, the question's own
// findings and now the structured quantities are all in the detail
// response and are copied here.
//
// `quantities` arrives already validated by the server projection, which
// carries a CLOSED set of on-chain fact kinds and drops any row whose
// canonical fields are incomplete. Every entry therefore has an exact
// amount, a unit domain and an Evidence row; `position` is null because
// the record holds point readings and nothing yet groups them into an
// ordered series. That is why a real payload can now produce a METRIC and
// still cannot produce a TABLE or a CHART: those need positions, and no
// position exists to copy.
//
// `entities` remains empty — admitted documentary locators are persisted
// but not projected — so ENTITY is still correctly rejected. Nothing here
// guesses a number from a fragment to fill any of these gaps.
export function inputFromResearchJobDetail(detail: ResearchJobDetail): AnalyticalOutputInputV1 {
  const findings = detail.questionFindings ?? [];
  return {
    question: {
      text: detail.job.originalQuestion,
      intent: detail.claimSupport?.intent ?? null,
      relevantComponents: [
        ...new Set(findings.flatMap((f) => [f.component, ...f.supportingComponents])),
      ].sort(byString),
    },
    verdict: detail.proof?.verdict ?? null,
    confidenceBand: detail.proof?.confidence.band ?? null,
    components: detail.components.map((c) => ({
      step: c.patternStep,
      component: c.component,
      status: c.status,
      reasonCodes: c.reasonCodes.filter((r): r is string => typeof r === "string"),
      supportingEvidenceIds: c.supportingEvidenceIds,
      contradictingEvidenceIds: c.contradictingEvidenceIds,
    })),
    evidence: detail.evidence.map((e) => ({
      id: e.id,
      patternStep: e.patternStep,
      component: e.component,
      relationship: e.relationship,
      directness: e.directness,
      sourceClass: e.sourceClass,
      officiality: e.officiality,
      fragment: e.fragment,
      summary: e.summary,
      doesNotProve: e.doesNotProve,
      mechanismState: e.mechanismState,
      publishedAt: e.publishedAt,
      observedAt: e.observedAt,
      fetchedAt: e.fetchedAt,
      retrievedUrl: e.retrievedUrl,
      sourceTitle: e.sourceTitle,
    })),
    flows: (detail.mechanism?.flows ?? []).filter(isPlanFlow),
    // Copied field for field. The server decided what was showable; this
    // adds only `position`, which the record does not carry.
    quantities: (detail.quantities ?? []).map((q) => ({
      evidenceId: q.evidenceId,
      observationId: q.observationId ?? null,
      factKind: q.factKind,
      step: q.step,
      component: q.component,
      mint: q.mint,
      decimals: q.decimals,
      amountRaw: q.amountRaw,
      position: null,
    })),
    entities: [],
  };
}
