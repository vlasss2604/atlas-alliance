// UI V1 — THE PROJECTION LAYER BETWEEN PERSISTED RESEARCH TRUTH AND SCREENS.
//
// Pure functions, no React, no fetching, no DOM: everything here is a
// deterministic reading of values the engine already persisted, so it can be
// tested directly and so no component has to invent semantics on the fly.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE: the UI describes what the
// engine recorded and nothing else. It never upgrades a missing value into a
// negative finding, never derives a verdict, never turns confidence into a
// probability, and never presents excluded material as support. Where the
// persisted data cannot answer a question, the answer is "could not verify"
// — which is a research outcome, not an application error.

export type JobState =
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_CLARIFICATION"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "BUDGET_LIMIT_REACHED"
  | (string & {});

export type AcquisitionPhase = "SEARCHING" | "FETCHING" | "EXTRACTING";

export type Verdict =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "NOT_SUPPORTED"
  | "INSUFFICIENT_EVIDENCE"
  | "NOT_APPLICABLE";

export type ComponentStatus =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "CONTRADICTED"
  | "INSUFFICIENT_EVIDENCE";

export const ACTIVE_JOB_STATES = ["QUEUED", "RUNNING", "AWAITING_CLARIFICATION"] as const;
export const TERMINAL_JOB_STATES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BUDGET_LIMIT_REACHED",
] as const;

export function isTerminal(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

export function isActive(state: JobState): boolean {
  return (ACTIVE_JOB_STATES as readonly string[]).includes(state);
}

/* ------------------------------------------------------------------ *
 * LIVE PROGRESS
 * ------------------------------------------------------------------ */

// The six stages a person can actually follow. This is a PRESENTATION
// vocabulary over state the engine already keeps — deliberately NOT a second
// phase machine. It decides nothing, advances nothing and is never written
// back; it only chooses which persisted fact to show.
export const RESEARCH_STAGES = [
  { key: "UNDERSTANDING", label: "Understanding the question" },
  { key: "MEMORY", label: "Checking previous research" },
  { key: "SEARCH", label: "Searching sources" },
  { key: "FETCH", label: "Reading evidence" },
  { key: "EXTRACT", label: "Verifying the mechanism" },
  { key: "VERDICT", label: "Building the answer" },
] as const;

export type ResearchStageKey = (typeof RESEARCH_STAGES)[number]["key"];

export interface ProgressInput {
  state: JobState;
  // The stage counter. It only ever reaches the memory step for an acquiring
  // job, which is precisely why it cannot be the authority on its own.
  progressStage: number;
  // The engine's own persisted phase. Authoritative whenever it is set.
  acquisitionPhase: AcquisitionPhase | null;
}

export interface ProgressView {
  stages: { key: ResearchStageKey; label: string; state: "DONE" | "ACTIVE" | "PENDING" }[];
  activeIndex: number;
  // Which persisted field decided the active stage. Surfaced so a reader (and
  // a test) can see the answer's provenance rather than trusting it.
  source: "ACQUISITION_PHASE" | "PROGRESS_STAGE" | "TERMINAL";
  running: boolean;
}

const PHASE_STAGE_INDEX: Record<AcquisitionPhase, number> = {
  SEARCHING: 2,
  FETCHING: 3,
  EXTRACTING: 4,
};

// progressStage is a 1..5 counter from an older, coarser vocabulary. It is
// used ONLY as the fallback for a job that has not entered acquisition yet.
const PROGRESS_STAGE_INDEX = [0, 0, 1, 2, 4, 5];

// WHY acquisitionPhase WINS.
//
// progressStage advances to the memory step and then stops: the acquisition
// phases that follow are recorded in their own column. A UI reading only the
// counter therefore says "checking previous research" for a job that is
// already fetching documents or extracting facts — which is what the live
// Raydium runs showed on screen while the engine was three phases further on.
//
// So whenever the engine has recorded an acquisition phase, that phase is the
// answer. The counter is consulted only before acquisition begins, and a
// terminal job ignores both: it is finished, and its last phase is history.
export function deriveProgress(job: ProgressInput): ProgressView {
  if (isTerminal(job.state)) {
    return {
      stages: RESEARCH_STAGES.map((s) => ({ ...s, state: "DONE" as const })),
      activeIndex: RESEARCH_STAGES.length - 1,
      source: "TERMINAL",
      running: false,
    };
  }

  let activeIndex: number;
  let source: ProgressView["source"];
  if (job.acquisitionPhase && job.acquisitionPhase in PHASE_STAGE_INDEX) {
    activeIndex = PHASE_STAGE_INDEX[job.acquisitionPhase];
    source = "ACQUISITION_PHASE";
  } else {
    const raw = Number.isFinite(job.progressStage) ? job.progressStage : 1;
    activeIndex = PROGRESS_STAGE_INDEX[Math.min(Math.max(raw, 1), 5)] ?? 0;
    source = "PROGRESS_STAGE";
  }

  return {
    stages: RESEARCH_STAGES.map((s, i) => ({
      ...s,
      state: i < activeIndex ? "DONE" : i === activeIndex ? "ACTIVE" : "PENDING",
    })),
    activeIndex,
    source,
    running: true,
  };
}

/* ------------------------------------------------------------------ *
 * VERDICT
 * ------------------------------------------------------------------ */

export type VerdictTone = "supported" | "partial" | "insufficient" | "negative" | "neutral";

export const VERDICT_LABELS: Record<string, string> = {
  SUPPORTED: "Supported",
  PARTIALLY_SUPPORTED: "Partially supported",
  NOT_SUPPORTED: "Not supported",
  INSUFFICIENT_EVIDENCE: "Insufficient evidence",
  NOT_APPLICABLE: "Not applicable",
};

// Colour carries meaning, so the mapping is explicit and closed. Red belongs
// to NOT_SUPPORTED alone — the one verdict that says something was positively
// established to be false. Missing evidence is amber, never red: absence of
// evidence is not evidence of absence.
export function verdictTone(verdict: string | null | undefined): VerdictTone {
  switch (verdict) {
    case "SUPPORTED":
      return "supported";
    case "PARTIALLY_SUPPORTED":
      return "partial";
    case "INSUFFICIENT_EVIDENCE":
      return "insufficient";
    case "NOT_SUPPORTED":
      return "negative";
    default:
      return "neutral";
  }
}

export function verdictLabel(verdict: string | null | undefined): string {
  if (!verdict) return "No verdict yet";
  return VERDICT_LABELS[verdict] ?? verdict;
}

export const CONFIDENCE_LABELS: Record<string, string> = {
  LOW: "Low",
  LIMITED: "Limited",
  STRONG: "Strong",
  VERY_STRONG: "Very strong",
};

/* ------------------------------------------------------------------ *
 * COMPONENTS
 * ------------------------------------------------------------------ */

export const COMPONENT_LABELS: Record<string, string> = {
  SOURCE_OF_VALUE: "Source of value",
  FLOW_PATH: "Flow path",
  MECHANISM_SPEC: "Mechanism spec",
  GOVERNANCE_BASIS: "Governance basis",
  EXECUTION_EVIDENCE: "Execution evidence",
  CURRENT_STATE: "Current state",
  DESTINATION: "Destination",
  RECIPIENT: "Recipient",
  NET_EFFECT: "Net effect",
  DURABILITY_BASIS: "Durability basis",
};

export function componentLabel(component: string): string {
  return COMPONENT_LABELS[component] ?? component.replace(/_/g, " ").toLowerCase();
}

export const COMPONENT_STATUS_LABELS: Record<string, string> = {
  SUPPORTED: "Established",
  PARTIALLY_SUPPORTED: "Partly established",
  CONTRADICTED: "Contradicted",
  INSUFFICIENT_EVIDENCE: "Could not verify",
};

export function componentStatusLabel(status: string): string {
  return COMPONENT_STATUS_LABELS[status] ?? "Could not verify";
}

export function componentTone(status: string): VerdictTone {
  switch (status) {
    case "SUPPORTED":
      return "supported";
    case "PARTIALLY_SUPPORTED":
      return "partial";
    case "CONTRADICTED":
      return "negative";
    default:
      return "insufficient";
  }
}

/* ------------------------------------------------------------------ *
 * REALITY CHECK
 * ------------------------------------------------------------------ */

// The ladder from "someone wrote it down" to "it demonstrably changed
// something". Each rung is bound to exactly ONE persisted component result;
// a rung with no row is NOT_ASSESSED, never a failure.
export const REALITY_RUNGS = [
  { key: "DOCUMENTED", label: "Documented", component: "MECHANISM_SPEC" },
  { key: "APPROVED", label: "Approved", component: "GOVERNANCE_BASIS" },
  { key: "ACTIVATED", label: "Activated", component: "CURRENT_STATE" },
  { key: "EXECUTING", label: "Executing", component: "EXECUTION_EVIDENCE" },
  { key: "DESTINATION", label: "Destination verified", component: "DESTINATION" },
  { key: "NET_EFFECT", label: "Net effect proven", component: "NET_EFFECT" },
] as const;

export type RealityState =
  | "VERIFIED"
  | "PARTIAL"
  | "UNRESOLVED"
  | "NOT_HAPPENING"
  | "NOT_ASSESSED";

export interface RealityRungView {
  key: string;
  label: string;
  component: string;
  state: RealityState;
  // The persisted component status this rung was read from, or null when no
  // component result exists. Shown in developer details, never asserted.
  rawStatus: string | null;
}

export interface RealityCheckView {
  rungs: RealityRungView[];
  // Index of the first rung that is not verified — the honest boundary of
  // what this research established. Null when the ladder cannot be derived
  // safely (see the guard below).
  stopsAtIndex: number | null;
  derivable: boolean;
}

export const REALITY_STATE_LABELS: Record<RealityState, string> = {
  VERIFIED: "Verified",
  PARTIAL: "Partly verified",
  UNRESOLVED: "Could not verify",
  NOT_HAPPENING: "Verified not happening",
  NOT_ASSESSED: "Not assessed",
};

// STATUS -> RUNG STATE. The asymmetry is the point.
//
// Only CONTRADICTED becomes "verified not happening": that is the single
// persisted status meaning the engine positively established the opposite.
// INSUFFICIENT_EVIDENCE — and a component with no row at all — become
// "could not verify", because absence of evidence is not evidence of absence
// and a UI must never quietly convert one into the other.
function rungState(status: string | null): RealityState {
  switch (status) {
    case "SUPPORTED":
      return "VERIFIED";
    case "PARTIALLY_SUPPORTED":
      return "PARTIAL";
    case "CONTRADICTED":
      return "NOT_HAPPENING";
    case "INSUFFICIENT_EVIDENCE":
      return "UNRESOLVED";
    default:
      return "NOT_ASSESSED";
  }
}

export function deriveRealityCheck(
  components: { component: string; status: string }[],
): RealityCheckView {
  const byComponent = new Map(components.map((c) => [c.component, c.status]));
  const rungs: RealityRungView[] = REALITY_RUNGS.map((r) => {
    const rawStatus = byComponent.get(r.component) ?? null;
    return { key: r.key, label: r.label, component: r.component, state: rungState(rawStatus), rawStatus };
  });

  // DEGRADE CONSERVATIVELY. "Reality stops here" is a claim about where the
  // established chain ends, so it is only drawn when there IS an established
  // chain to end: at least one rung actually verified. A research that
  // established nothing gets the ladder without the marker, rather than a
  // marker implying the first rung was tested and failed.
  const firstVerified = rungs.findIndex((r) => r.state === "VERIFIED");
  const stopsAtIndex =
    firstVerified === -1 ? null : rungs.findIndex((r) => r.state !== "VERIFIED");

  return {
    rungs,
    stopsAtIndex: stopsAtIndex === -1 ? null : stopsAtIndex,
    derivable: components.length > 0,
  };
}

/* ------------------------------------------------------------------ *
 * EVIDENCE
 * ------------------------------------------------------------------ */

export const SOURCE_CLASS_LABELS: Record<string, string> = {
  OFFICIAL_DOCS: "Official docs",
  GOVERNANCE: "Governance",
  ONCHAIN_VERIFIABLE: "On-chain",
  OFFICIAL_REPORT: "Official report",
  DATA_PROVIDER: "Data provider",
  RESEARCH_MEDIA: "Research media",
  SOCIAL: "Social",
};

export function sourceClassLabel(sourceClass: string | null): string {
  if (!sourceClass) return "Unclassified";
  return SOURCE_CLASS_LABELS[sourceClass] ?? sourceClass;
}

export const EXCLUSION_LABELS: Record<string, string> = {
  CLASS_NOT_ADMISSIBLE: "Source class cannot establish this component",
  OFFICIALITY_NOT_ADMISSIBLE: "Source is not a confirmed official channel",
  ENTITY_BINDING_NOT_ADMISSIBLE: "Not bound to this project's on-chain identity",
  STALE: "Too old to establish current state",
  DIRECTNESS_NOT_ADMISSIBLE: "Only indirect for this component",
};

export function exclusionLabel(reason: string): string {
  return EXCLUSION_LABELS[reason] ?? reason.replace(/_/g, " ").toLowerCase();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ *
 * PLAIN-LANGUAGE ANSWER
 * ------------------------------------------------------------------ */

export interface AnswerInput {
  verdict: string | null;
  confidenceBand: string | null;
  projectName: string | null;
  components: { component: string; status: string }[];
  terminationReason: string | null;
}

// A TEMPLATED reading of persisted counts and statuses — the same discipline
// the Proof layers themselves follow. Every sentence is a restatement of a
// stored value; none of them adds a conclusion, and none of them appears
// unless the value behind it exists.
export function plainAnswer(input: AnswerInput): string[] {
  const subject = input.projectName ?? "This project";
  const established = input.components.filter((c) => c.status === "SUPPORTED");
  const contradicted = input.components.filter((c) => c.status === "CONTRADICTED");
  const unresolved = input.components.filter((c) => c.status === "INSUFFICIENT_EVIDENCE");
  const sentences: string[] = [];

  switch (input.verdict) {
    case "SUPPORTED":
      sentences.push(`ATLAS verified the mechanism it was asked about for ${subject}.`);
      break;
    case "PARTIALLY_SUPPORTED":
      sentences.push(
        `ATLAS verified part of the mechanism for ${subject}, but not the whole path.`,
      );
      break;
    case "NOT_SUPPORTED":
      sentences.push(
        `The evidence ATLAS gathered contradicts the claim it was asked to check for ${subject}.`,
      );
      break;
    case "INSUFFICIENT_EVIDENCE":
      sentences.push(
        `ATLAS could not gather enough admissible evidence to answer this question about ${subject}.`,
      );
      break;
    default:
      sentences.push(`No Proof was produced for this research.`);
      break;
  }

  if (established.length > 0) {
    sentences.push(
      `${established.length === 1 ? "One part of the chain is" : `${established.length} parts of the chain are`} established: ` +
        `${established.map((c) => componentLabel(c.component).toLowerCase()).join(", ")}.`,
    );
  }
  if (contradicted.length > 0) {
    sentences.push(
      `Evidence positively contradicts ` +
        `${contradicted.map((c) => componentLabel(c.component).toLowerCase()).join(", ")}.`,
    );
  }
  if (unresolved.length > 0) {
    sentences.push(
      `${unresolved.length} ${unresolved.length === 1 ? "part" : "parts"} of the chain could not be verified from the sources ATLAS was able to admit.`,
    );
  }
  if (input.confidenceBand) {
    sentences.push(
      `Structural confidence in this reading is ${CONFIDENCE_LABELS[input.confidenceBand] ?? input.confidenceBand}.`,
    );
  }
  return sentences;
}

export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
