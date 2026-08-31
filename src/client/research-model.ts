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

export type VerdictTone =
  | "supported"
  | "partial"
  | "insufficient"
  | "negative"
  | "fault"
  | "neutral";

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
// evidence is not evidence of absence. A product fault has its own tone
// entirely, because "our run broke" is not a finding about the project.
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
 * OUTCOME — WHAT A RUN ENDED AS, IN PRODUCT LANGUAGE
 * ------------------------------------------------------------------ */

// A verdict is one possible outcome of a run, not the only one, and the
// others must not be flattened into it. In particular:
//
//   INSUFFICIENT_EVIDENCE is a RESEARCH RESULT — ATLAS looked and the
//   admissible evidence did not reach the bar. It is a legitimate answer.
//
//   FAILED is a PRODUCT FAULT — the run broke. It says nothing whatsoever
//   about the project, and presenting it as a finding would be a lie about
//   what was learned.
//
// They therefore get different kinds, different labels and different tones.
// "No proof" never appears: it is an implementation detail, not an outcome a
// reader can act on.
export type OutcomeKind =
  | "VERDICT"
  | "IN_PROGRESS"
  | "NO_CONCLUSION"
  | "FAILED"
  | "CANCELLED"
  | "STOPPED_AT_LIMIT";

export interface OutcomeView {
  kind: OutcomeKind;
  label: string;
  tone: VerdictTone;
  verdict: string | null;
}

export function jobOutcome(job: {
  state: JobState;
  verdict?: string | null;
}): OutcomeView {
  if (isActive(job.state)) {
    return { kind: "IN_PROGRESS", label: "In progress", tone: "neutral", verdict: null };
  }
  if (job.verdict) {
    return {
      kind: "VERDICT",
      label: verdictLabel(job.verdict),
      tone: verdictTone(job.verdict),
      verdict: job.verdict,
    };
  }
  switch (job.state) {
    case "FAILED":
      // A fault, not a finding.
      return { kind: "FAILED", label: "Research failed", tone: "fault", verdict: null };
    case "CANCELLED":
      return { kind: "CANCELLED", label: "Cancelled", tone: "neutral", verdict: null };
    case "BUDGET_LIMIT_REACHED":
      return {
        kind: "STOPPED_AT_LIMIT",
        label: "Stopped at limit",
        tone: "neutral",
        verdict: null,
      };
    default:
      // The run completed without writing a Proof. Honest, and distinct from
      // both "insufficient evidence" and "it broke".
      return { kind: "NO_CONCLUSION", label: "No conclusion", tone: "neutral", verdict: null };
  }
}

/* ------------------------------------------------------------------ *
 * RESEARCH HISTORY GROUPING
 * ------------------------------------------------------------------ */

export interface GroupableJob {
  id: string;
  state: JobState;
  verdict: string | null;
  originalQuestion: string;
  projectSlug: string | null;
  projectName: string | null;
  projectTicker?: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface QuestionGroup<T extends GroupableJob> {
  key: string;
  question: string;
  runs: T[];
  latest: T;
  latestOutcome: OutcomeView;
  lastAt: string;
}

export interface ProjectGroup<T extends GroupableJob> {
  key: string;
  projectSlug: string | null;
  projectName: string;
  runs: T[];
  latest: T;
  latestOutcome: OutcomeView;
  questions: QuestionGroup<T>[];
  runCount: number;
  lastAt: string;
}

// PROJECT IDENTITY is the slug — the project row's own stable key, not the
// display name, so two rows that render the same label can never be merged by
// accident and a renamed project keeps its history.
function projectKeyOf(job: GroupableJob): string {
  return job.projectSlug ?? " unresolved";
}

// QUESTION IDENTITY.
//
// `normalized_task_hash` looks like the right key and is the first thing I
// checked. It is not usable for this: measured against the real job table,
// four Raydium runs of the SAME user-visible question carry four different
// hashes (the interpretation differs run to run), so grouping by it produces
// singletons — exactly the wall of duplicates this replaces. Owner tooling
// rows carry synthetic hashes like "acquire-url-…" as well.
//
// So the question the USER asked is the identity, normalised only for
// whitespace and case. Two materially different questions have different
// text and therefore stay in different groups, which is the property that
// must not be lost.
function questionKeyOf(job: GroupableJob): string {
  return job.originalQuestion.trim().replace(/\s+/g, " ").toLowerCase();
}

function timeOf(job: GroupableJob): number {
  return Date.parse(job.finishedAt ?? job.createdAt) || 0;
}

// Newest first, everywhere, so "latest" means the same thing at every level.
function byNewest<T extends GroupableJob>(a: T, b: T): number {
  return timeOf(b) - timeOf(a);
}

export function groupResearchRuns<T extends GroupableJob>(jobs: T[]): ProjectGroup<T>[] {
  const byProject = new Map<string, T[]>();
  for (const job of jobs) {
    const key = projectKeyOf(job);
    const list = byProject.get(key) ?? [];
    list.push(job);
    byProject.set(key, list);
  }

  const groups: ProjectGroup<T>[] = [];
  for (const [key, runs] of byProject) {
    const sorted = [...runs].sort(byNewest);
    const latest = sorted[0];

    const byQuestion = new Map<string, T[]>();
    for (const job of sorted) {
      const qk = questionKeyOf(job);
      const list = byQuestion.get(qk) ?? [];
      list.push(job);
      byQuestion.set(qk, list);
    }
    const questions: QuestionGroup<T>[] = [...byQuestion.entries()]
      .map(([qk, qRuns]) => {
        const qSorted = [...qRuns].sort(byNewest);
        return {
          key: qk,
          question: qSorted[0].originalQuestion,
          runs: qSorted,
          latest: qSorted[0],
          latestOutcome: jobOutcome(qSorted[0]),
          lastAt: qSorted[0].finishedAt ?? qSorted[0].createdAt,
        };
      })
      .sort((a, b) => timeOf(b.latest) - timeOf(a.latest));

    groups.push({
      key,
      projectSlug: latest.projectSlug,
      projectName: latest.projectName ?? latest.projectTicker ?? "Unresolved project",
      runs: sorted,
      latest,
      latestOutcome: jobOutcome(latest),
      questions,
      runCount: sorted.length,
      lastAt: latest.finishedAt ?? latest.createdAt,
    });
  }

  return groups.sort((a, b) => timeOf(b.latest) - timeOf(a.latest));
}

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

export interface ComponentSummary {
  established: number;
  partial: number;
  contradicted: number;
  unresolved: number;
  total: number;
}

export function summariseComponents(
  components: { component: string; status: string }[],
): ComponentSummary {
  const count = (s: string) => components.filter((c) => c.status === s).length;
  return {
    established: count("SUPPORTED"),
    partial: count("PARTIALLY_SUPPORTED"),
    contradicted: count("CONTRADICTED"),
    unresolved: count("INSUFFICIENT_EVIDENCE"),
    total: components.length,
  };
}

/* ------------------------------------------------------------------ *
 * REALITY CHECK
 * ------------------------------------------------------------------ */

// TWO DIFFERENT KINDS OF FINDING, KEPT APART.
//
// The mechanism chain is genuinely sequential: a mechanism is written down,
// then authorised, then switched on, then observed executing. A break in that
// chain is meaningful — it is where the story stops being demonstrable.
//
// Destination, recipient and net effect are NOT further rungs of that ladder.
// A document can state where value lands regardless of whether execution was
// observed, and the engine establishes them independently. Rendering them
// below a break marker implied that an unverified execution step made them
// impossible, which is a claim the engine never makes. They are now listed
// separately, as independent findings, and the break marker belongs only to
// the chain.
export const MECHANISM_CHAIN_RUNGS = [
  { key: "DOCUMENTED", label: "Documented", component: "MECHANISM_SPEC" },
  { key: "APPROVED", label: "Approved", component: "GOVERNANCE_BASIS" },
  { key: "ACTIVATED", label: "Activated", component: "CURRENT_STATE" },
  { key: "EXECUTING", label: "Executing", component: "EXECUTION_EVIDENCE" },
] as const;

export const INDEPENDENT_FINDING_RUNGS = [
  { key: "DESTINATION", label: "Destination verified", component: "DESTINATION" },
  { key: "RECIPIENT", label: "Recipient verified", component: "RECIPIENT" },
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
  chain: RealityRungView[];
  // Index within `chain` of the first rung that is not verified — where the
  // sequential story stops being demonstrable. Null when not safely
  // derivable. It applies to the CHAIN ONLY and says nothing about the
  // independent findings below it.
  chainStopsAtIndex: number | null;
  independent: RealityRungView[];
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
  const build = (defs: readonly { key: string; label: string; component: string }[]) =>
    defs.map((r) => {
      const rawStatus = byComponent.get(r.component) ?? null;
      return {
        key: r.key,
        label: r.label,
        component: r.component,
        state: rungState(rawStatus),
        rawStatus,
      };
    });

  const chain = build(MECHANISM_CHAIN_RUNGS);
  const independent = build(INDEPENDENT_FINDING_RUNGS);

  // DEGRADE CONSERVATIVELY. The break marker is a claim about where an
  // established chain ends, so it is only drawn when there IS an established
  // chain to end: at least one CHAIN rung actually verified. A research that
  // established nothing in the chain gets the rungs without the marker,
  // rather than a marker implying the first rung was tested and failed.
  const firstVerified = chain.findIndex((r) => r.state === "VERIFIED");
  const firstUnverified = chain.findIndex((r) => r.state !== "VERIFIED");
  const chainStopsAtIndex =
    firstVerified === -1 || firstUnverified === -1 ? null : firstUnverified;

  return { chain, chainStopsAtIndex, independent, derivable: components.length > 0 };
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

// The human-facing name of a document: its last path segment where there is
// one, otherwise the domain. "ray-buybacks.md" reads as a document; the full
// url does not.
export function documentName(url: string, title: string | null): string {
  if (title && title.trim().length > 0) return title;
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last && last.length > 0 ? last : parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Canonical DOCUMENT identity for display grouping. Scheme, host case,
// trailing slash and fragment do not make a different document; a query
// string can, so it is kept.
export function canonicalDocumentKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

export interface EvidenceItemLike {
  id: string;
  component: string | null;
  summary: string | null;
  fragment: string;
  doesNotProve: string | null;
  sourceClass: string | null;
  officiality: string | null;
  retrievedUrl: string;
  sourceTitle: string | null;
  exclusionReason?: string | null;
}

export interface DocumentGroup<T extends EvidenceItemLike> {
  key: string;
  name: string;
  domain: string;
  url: string;
  sourceClass: string | null;
  // Components this ONE document was found to support, deduplicated. A
  // document that serves three components is one source, not three.
  components: string[];
  items: T[];
}

// PRESENTATION DEDUPLICATION ONLY.
//
// One acquired document routinely produces several Evidence rows, one per
// component it establishes. Listing each row as its own card made a single
// official document look like several independent corroborating sources —
// the precise illusion research output must never create.
//
// Stored Evidence is untouched: the rows, their component links and their
// admission are exactly as persisted. Only the rendering is collapsed, and
// the component relationships are carried along so nothing is lost.
export function groupEvidenceByDocument<T extends EvidenceItemLike>(
  items: T[],
): DocumentGroup<T>[] {
  const groups = new Map<string, DocumentGroup<T>>();
  for (const item of items) {
    const key = canonicalDocumentKey(item.retrievedUrl);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      if (item.component && !existing.components.includes(item.component)) {
        existing.components.push(item.component);
      }
      // A document's class is a property of the document. If rows disagree
      // (they should not), the first non-null wins rather than the last.
      existing.sourceClass = existing.sourceClass ?? item.sourceClass;
      continue;
    }
    groups.set(key, {
      key,
      name: documentName(item.retrievedUrl, item.sourceTitle),
      domain: domainOf(item.retrievedUrl),
      url: item.retrievedUrl,
      sourceClass: item.sourceClass,
      components: item.component ? [item.component] : [],
      items: [item],
    });
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------------ *
 * PLAIN-LANGUAGE ANSWER
 * ------------------------------------------------------------------ */

// What each component means in ordinary words, as the object of a sentence.
// Used for BOTH "ATLAS verified …" and "ATLAS could not verify …", so the two
// halves of the answer stay symmetrical and neither can drift into a claim
// the other would not make.
const COMPONENT_PHRASES: Record<string, string> = {
  SOURCE_OF_VALUE: "where the economic value comes from",
  FLOW_PATH: "the path the value takes through the protocol",
  MECHANISM_SPEC: "what the project's own documentation specifies",
  GOVERNANCE_BASIS: "the governing decision behind the mechanism",
  EXECUTION_EVIDENCE: "whether the mechanism has actually executed",
  CURRENT_STATE: "whether the mechanism is currently active",
  DESTINATION: "where the value ends up",
  RECIPIENT: "who ultimately receives it",
  NET_EFFECT: "a durable effect on token supply",
  DURABILITY_BASIS: "how durable the mechanism is",
};

// Which findings a reader actually needs first. Documentation and governance
// establish that something is SPECIFIED; execution, current state and net
// effect establish that it HAPPENS. The second kind decides more, so it leads
// the unverified list.
const VERIFIED_PRIORITY = [
  "MECHANISM_SPEC",
  "GOVERNANCE_BASIS",
  "SOURCE_OF_VALUE",
  "DESTINATION",
  "RECIPIENT",
  "EXECUTION_EVIDENCE",
  "CURRENT_STATE",
  "NET_EFFECT",
  "FLOW_PATH",
  "DURABILITY_BASIS",
];
const UNVERIFIED_PRIORITY = [
  "EXECUTION_EVIDENCE",
  "NET_EFFECT",
  "CURRENT_STATE",
  "DESTINATION",
  "RECIPIENT",
  "SOURCE_OF_VALUE",
  "FLOW_PATH",
  "GOVERNANCE_BASIS",
  "MECHANISM_SPEC",
  "DURABILITY_BASIS",
];

export interface AnswerInput {
  verdict: string | null;
  outcomeKind?: OutcomeKind;
  projectName: string | null;
  components: { component: string; status: string }[];
}

// "and" for things that were established, "or" for things that were not:
// "could not verify A and B" reads as one compound failure, "could not verify
// A or B" reads as two separate ones, which is what it is.
function joinPhrases(list: string[], conjunction = "and"): string {
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} ${conjunction} ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} ${conjunction} ${list[list.length - 1]}`;
}

function pick(
  components: { component: string; status: string }[],
  status: string,
  priority: string[],
  limit: number,
): string[] {
  const have = new Set(
    components.filter((c) => c.status === status).map((c) => c.component),
  );
  return priority
    .filter((c) => have.has(c) && COMPONENT_PHRASES[c])
    .slice(0, limit)
    .map((c) => COMPONENT_PHRASES[c]);
}

// THE ANSWER, BUILT FROM PERSISTED RESULTS ONLY.
//
// Two to four sentences, each one a restatement of a stored component status
// or the stored verdict. No model call, no causal reasoning, no inference
// across components: documentation never becomes execution, a buyback never
// becomes a burn, and an undated document never becomes current state,
// because each sentence can only ever name the component it was read from.
//
// A component with NO persisted row contributes nothing at all — it was not
// assessed, and saying "could not verify" about it would misreport the run.
export function researchAnswer(input: AnswerInput): string[] {
  const subject = input.projectName ?? "this project";
  const sentences: string[] = [];

  // 1 — the lead: what the run concluded, in the reader's terms.
  switch (input.outcomeKind ?? "VERDICT") {
    case "IN_PROGRESS":
      return [`ATLAS is still researching this question about ${subject}.`];
    case "FAILED":
      return [
        `This research run did not complete, so it established nothing about ${subject}.`,
        `The failure is a problem with the run itself — it is not a finding about the project.`,
      ];
    case "CANCELLED":
      return [`This research was cancelled before it reached a conclusion.`];
    case "STOPPED_AT_LIMIT":
      sentences.push(
        `This research stopped at its budget limit before reaching a conclusion about ${subject}.`,
      );
      break;
    case "NO_CONCLUSION":
      sentences.push(
        `This research finished without producing a Proof for ${subject}.`,
      );
      break;
    default:
      switch (input.verdict) {
        case "SUPPORTED":
          sentences.push(`ATLAS verified the mechanism it was asked about for ${subject}.`);
          break;
        case "PARTIALLY_SUPPORTED":
          sentences.push(
            `ATLAS verified part of what it was asked about for ${subject}, but not the whole path.`,
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
          sentences.push(`No conclusion was recorded for this research.`);
          break;
      }
      break;
  }

  // 2 — what was positively contradicted. Never omitted: it is the strongest
  // thing a run can say, and it comes only from a CONTRADICTED row.
  const contradicted = pick(input.components, "CONTRADICTED", UNVERIFIED_PRIORITY, 2);
  if (contradicted.length > 0) {
    sentences.push(`Evidence contradicts ${joinPhrases(contradicted, "and")}.`);
  }

  // 3 — what was established.
  const verified = pick(input.components, "SUPPORTED", VERIFIED_PRIORITY, 3);
  if (verified.length > 0) {
    sentences.push(`ATLAS verified ${joinPhrases(verified)}.`);
  }

  // 4 — what could not be established. Only components that were actually
  // attempted and came back short.
  const unresolved = pick(
    input.components,
    "INSUFFICIENT_EVIDENCE",
    UNVERIFIED_PRIORITY,
    verified.length > 0 ? 2 : 3,
  );
  if (unresolved.length > 0 && sentences.length < 4) {
    sentences.push(`ATLAS could not verify ${joinPhrases(unresolved, "or")}.`);
  }

  return sentences.slice(0, 4);
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
