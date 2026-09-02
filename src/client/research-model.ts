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

// A TERMINAL PRODUCT STATE OUTRANKS A PERSISTED VERDICT.
//
// The state switch used to sit BELOW `if (job.verdict)`, so any job carrying
// a Proof row rendered as that Proof's verdict no matter how the run ended —
// and `loadProofForJob` is not gated on job state, so a Proof written before
// a run broke, was cancelled, or hit its budget ceiling came back on the GET
// and won. A run that FAILED would have announced "Insufficient evidence"
// about the project: a product fault, silently restated as a finding.
//
// The order is now state first. FAILED, CANCELLED and BUDGET_LIMIT_REACHED
// each say something about the RUN, and none of them may be read as a claim
// about the project. `verdict` is still carried on the view for the deep
// audit, so nothing is destroyed — it simply stops being the headline.
//
// BUDGET_LIMIT_REACHED is a COVERAGE limit, not a negative result. Component
// rows established before the ceiling are unaffected and still render; what
// this suppresses is the leap from "we stopped early" to "it is not true".
export function jobOutcome(job: {
  state: JobState;
  verdict?: string | null;
}): OutcomeView {
  if (isActive(job.state)) {
    return { kind: "IN_PROGRESS", label: "In progress", tone: "neutral", verdict: null };
  }
  switch (job.state) {
    case "FAILED":
      // A fault, not a finding.
      return {
        kind: "FAILED",
        label: "Research failed",
        tone: "fault",
        verdict: job.verdict ?? null,
      };
    case "CANCELLED":
      return {
        kind: "CANCELLED",
        label: "Cancelled",
        tone: "neutral",
        verdict: job.verdict ?? null,
      };
    case "BUDGET_LIMIT_REACHED":
      return {
        kind: "STOPPED_AT_LIMIT",
        label: "Stopped early",
        tone: "neutral",
        verdict: job.verdict ?? null,
      };
    default:
      break;
  }
  if (job.verdict) {
    return {
      kind: "VERDICT",
      label: verdictLabel(job.verdict),
      tone: verdictTone(job.verdict),
      verdict: job.verdict,
    };
  }
  // The run completed without writing a Proof. Honest, and distinct from
  // both "insufficient evidence" and "it broke".
  return { kind: "NO_CONCLUSION", label: "No conclusion", tone: "neutral", verdict: null };
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

// When a run last produced something worth dating: when it finished, or —
// while it is still running — when it was created.
//
// Returns NULL rather than 0 for anything unparseable. `Date.parse(...) || 0`
// silently turned a malformed timestamp into the epoch, which sorts as the
// OLDEST possible run: a single bad row on the newest job would have pushed it
// to the bottom and left the group header quoting a stale run while the run
// list showed the fresh one. Unknown is not "very old", and the two must not
// be spelled the same way.
function timestampOf(job: GroupableJob): number | null {
  const raw = job.finishedAt ?? job.createdAt;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

// Newest first, everywhere, so "latest" means the same thing at every level.
// A run with no usable timestamp sorts last — it cannot be shown as the most
// recent thing that happened — and ties break on id so the order is total and
// stable rather than dependent on input order.
function byNewest<T extends GroupableJob>(a: T, b: T): number {
  const ta = timestampOf(a);
  const tb = timestampOf(b);
  if (ta === null && tb === null) return a.id.localeCompare(b.id);
  if (ta === null) return 1;
  if (tb === null) return -1;
  if (tb !== ta) return tb - ta;
  return a.id.localeCompare(b.id);
}

// "LAST RESEARCHED" IS THE MAXIMUM, TAKEN EXPLICITLY.
//
// Reading it off whichever run happened to sort first makes the header depend
// on the comparator agreeing with the label — a coupling with no reason to
// hold and no way to notice when it stops. Computing the maximum directly
// means the header can only ever quote the newest run it is summarising.
//
// The fallback is used only when NO run in the group carries a usable
// timestamp, which keeps the field non-null for callers without inventing a
// time that no row supports.
function lastAtOf<T extends GroupableJob>(runs: readonly T[], fallback: T): string {
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const run of runs) {
    const at = timestampOf(run);
    if (at !== null && at > bestAt) {
      bestAt = at;
      best = run;
    }
  }
  const chosen = best ?? fallback;
  return chosen.finishedAt ?? chosen.createdAt;
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
          lastAt: lastAtOf(qSorted, qSorted[0]),
        };
      })
      .sort((a, b) => byNewest(a.latest, b.latest));

    groups.push({
      key,
      projectSlug: latest.projectSlug,
      projectName: latest.projectName ?? latest.projectTicker ?? "Unresolved project",
      runs: sorted,
      latest,
      latestOutcome: jobOutcome(latest),
      questions,
      runCount: sorted.length,
      lastAt: lastAtOf(sorted, latest),
    });
  }

  return groups.sort((a, b) => byNewest(a.latest, b.latest));
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

// THE TWO-GROUP SEPARATION AND THE STATE MAPPING LIVE ON, IN THE LADDER.
//
// The rung sets that used to sit here spelled their labels as four bare
// adjectives — Documented / Approved / Activated / Executing — and named the
// second group "Independent findings", which asks a reader to care that the
// engine models them separately. `MECHANISM_ROWS` and `VALUE_ROWS` at the
// foot of this file carry the same components, the same order and the same
// separation, written as claims a reader can evaluate.
//
// `rungState` below is unchanged and is what the ladder still reads. Its
// asymmetry is the load-bearing part: only CONTRADICTED can mean "the
// evidence indicates otherwise".
export type RealityState =
  | "VERIFIED"
  | "PARTIAL"
  | "UNRESOLVED"
  | "NOT_HAPPENING"
  | "NOT_ASSESSED";

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

// WHY A SOURCE WAS READ AND THEN REFUSED, IN ORDINARY WORDS.
//
// The keys below are the ENGINE's own closed `ExclusionReason` vocabulary
// (component-reconciler.ts). The previous map named five reasons, four of
// which the engine never emits — so eleven of the twelve real reasons fell
// through to a de-snaking fallback and rendered as "wrong component",
// "duplicate unit", "superseded by newer". That is an internal identifier
// with its underscores removed, shown to a reader as though it were English.
//
// This section is one of the few things a research product can show that a
// chat answer structurally cannot: proof that a source was read and then
// deliberately not used. It is worth stating properly.
export const EXCLUSION_LABELS: Record<string, string> = {
  WRONG_COMPONENT: "Relevant to a different part of the mechanism",
  WRONG_PROJECT: "About a different project",
  LEGACY_CONTRACT_VERSION: "Read under an older evidence contract, so it was not reused",
  CLASS_NOT_ADMISSIBLE: "This type of source cannot establish this step",
  DIRECTNESS_INSUFFICIENT: "Refers to this only indirectly",
  RELATIONSHIP_NOT_SUPPORTING: "Mentions this without supporting it",
  NOT_CURRENT_STATE_BEARING: "Does not say whether this is true now",
  MISSING_PUBLICATION_DATE: "Undated, so it cannot establish the current state",
  STALE_FOR_CURRENT_STATE: "Too old to establish the current state",
  SUPERSEDED_BY_NEWER: "Superseded by a more recent source",
  DUPLICATE_UNIT: "The same passage was already counted once",
  ENTITY_NOT_CONFIRMED: "Not bound to this project's confirmed on-chain identity",
};

// The fallback is a SENTENCE, never the code with its underscores removed.
// An unrecognised reason means this map has fallen behind the engine, which
// is a copy bug — it must not become a leak.
export function exclusionLabel(reason: string): string {
  return EXCLUSION_LABELS[reason] ?? "Did not meet the evidence standard for this step";
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
  // When this exact resource was fetched. Persisted on every Evidence row
  // (`evidence.fetched_at`, NOT NULL) and now projected, because "read on
  // 1 Sep 2026" is a verifiable fact about the retrieval and one of the
  // few things that distinguishes a real source record from text a
  // product wrote about itself.
  fetchedAt?: string | null;
  // Whether ATLAS still holds the document this excerpt came out of. It is
  // a fact about storage, not about the source: true only when acquisition
  // persisted the retrieved text and that row is still joined to this job.
  // False means the capture predates the feature or was never kept — and
  // the card then offers no snapshot action at all, rather than a link
  // that goes nowhere.
  hasSnapshot?: boolean;
  exclusionReason?: string | null;
}

// WHAT WAS ACTUALLY FETCHED, DESCRIBED HONESTLY.
//
// A reader who opens a source and meets raw markdown reasonably asks what
// they are looking at. The engine often retrieves the machine-readable
// form of a page because it is cleaner and more reliable to parse — that
// is a good research decision and a confusing thing to show without
// explanation.
//
// This does NOT invent a prettier destination. It reads one fact about
// the url that was really requested — its file extension — and lets the
// card say so. Guessing that `x.md` has a human twin at `x` would be
// exactly the brittle derivation that turns a provenance claim into a
// fabrication, so it is not attempted anywhere.
const MACHINE_READABLE_EXTENSIONS = /\.(md|markdown|json|txt|xml|csv|ya?ml)$/i;

export interface RetrievedResource {
  filename: string | null;
  machineReadable: boolean;
}

export function retrievedResource(url: string): RetrievedResource {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() ?? null;
    return {
      filename: last,
      machineReadable: last !== null && MACHINE_READABLE_EXTENSIONS.test(last),
    };
  } catch {
    return { filename: null, machineReadable: false };
  }
}

// A retrieval date, not a timestamp. The hour a fetch happened is audit
// detail; the day is what makes "this was read, and recently" legible.
export function retrievedOn(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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

  // THE LEAD SENTENCE IS GONE FOR EVERY NORMAL OUTCOME.
  //
  // It used to open "The checked evidence establishes part of what this
  // question asked about, but not the whole path" — which is the verdict
  // badge, restated in twenty words, before a single fact. The badge
  // already says PARTIALLY SUPPORTED. What a reader does not have yet is
  // WHAT was and was not settled, so the answer now starts there.
  //
  // The fault outcomes keep their lead, because in those cases there is
  // no finding to lead with and the state of the RUN is the whole answer.
  switch (input.outcomeKind ?? "VERDICT") {
    case "IN_PROGRESS":
      return [`Still researching this question about ${subject}.`];
    case "FAILED":
      return [
        `This research run did not complete, so it established nothing about ${subject}.`,
        `The failure is a problem with the run itself — it is not a finding about the project.`,
      ];
    case "CANCELLED":
      return [`This research was cancelled before it reached a conclusion.`];
    case "STOPPED_AT_LIMIT":
      sentences.push(
        `This research stopped at its limit before covering everything it set out to check about ${subject}.`,
      );
      break;
    case "NO_CONCLUSION":
      sentences.push(`This research finished without producing a Proof for ${subject}.`);
      break;
    default:
      // No lead. The lists below are the answer.
      break;
  }

  // 2 — what was positively contradicted. Never omitted: it is the strongest
  // thing a run can say, and it comes only from a CONTRADICTED row.
  const contradicted = pick(input.components, "CONTRADICTED", UNVERIFIED_PRIORITY, 2);
  if (contradicted.length > 0) {
    sentences.push(`On ${joinPhrases(contradicted, "and")}, the evidence indicates otherwise.`);
  }

  // 3 — WHAT WAS SETTLED, LED BY THE WORD THAT SAYS SO.
  //
  // "Established:" carries the epistemic frame in one word, where "The
  // checked evidence establishes …" spent seven on it before reaching a
  // fact. The claim is identical and no weaker: this still describes what
  // the EVIDENCE reached, never what is true of the world, and it stays
  // accurate when the only source was documentation.
  const verified = pick(input.components, "SUPPORTED", VERIFIED_PRIORITY, 3);
  if (verified.length > 0) {
    sentences.push(`Established: ${joinPhrases(verified)}.`);
  }

  // 4 — what it did not settle. Only components that were actually
  // attempted and came back short. A limit of the EVIDENCE — never a
  // failure of the run, and never a claim that the thing is absent.
  const unresolved = pick(
    input.components,
    "INSUFFICIENT_EVIDENCE",
    UNVERIFIED_PRIORITY,
    verified.length > 0 ? 2 : 3,
  );
  if (unresolved.length > 0 && sentences.length < 3) {
    sentences.push(`Not established: ${joinPhrases(unresolved, "or")}.`);
  }

  // THREE SENTENCES, NOT FOUR. The default screen is read in about half a
  // minute; a fourth sentence is the one nobody reaches.
  return sentences.slice(0, 3);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

// UNITS ARE SPELLED OUT, BECAUSE "m" IS NOT ONE UNIT.
//
// This used to render "19m ago" / "19h ago" / "19d ago". A reader looking at
// "Last researched 2m ago" reads MONTHS, not minutes — which is exactly what
// happened: a group header quoting a run from nineteen minutes earlier was
// read as two months stale, and looked like it contradicted the run list
// directly beneath it that said the same thing. The derivation was right and
// the label was ambiguous, so the label is what changes.
//
// The scale also runs past days now. "63d ago" is arithmetic, not an answer;
// a reader wants "2 months ago".
export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return plural(mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 31) return plural(days, "day");
  // 30.44 is the mean Gregorian month, so the months bucket does not drift
  // against the days bucket it takes over from.
  const months = Math.round(days / 30.44);
  if (months < 12) return plural(Math.max(1, months), "month");
  return plural(Math.round(months / 12), "year");
}

/* ------------------------------------------------------------------ *
 * RESULT LADDER — THE DEFAULT SCREEN, IN THE READER'S WORDS
 * ------------------------------------------------------------------ */

// WHY A STEP HAS THE STATUS IT HAS.
//
// `research_component_results.reasonCodes` is a CLOSED, code-owned
// vocabulary (component-reconciler.ts) that the engine has always written
// and always persisted, and it was reaching the client already. Until now
// its only rendering was a monospace enum dump inside Developer details,
// while every unresolved step on the product surface shared ONE generic
// sentence with the component name substituted in. The engine knew why and
// the screen said "could not verify" ten times over.
//
// Each entry below restates exactly one persisted code. None is stronger
// than the code it renders: an unresolved step never becomes a claim that
// the thing is absent, and "the sources ATLAS checked" never quietly becomes
// "the sources that exist".
export const REASON_CODE_EXPLANATIONS: Record<string, string> = {
  NO_EVIDENCE_FOUND:
    "The sources checked here carried nothing on this point.",
  ALL_EVIDENCE_EXCLUDED:
    "Sources discussed this, but none met the standard this claim requires.",
  MISSING_EXECUTION_EVIDENCE:
    "The mechanism is described, but nothing checked shows it actually running.",
  MISSING_CURRENT_STATE:
    "Nothing checked says whether this is active now.",
  STALE_CURRENT_STATE:
    "The only sources describing this are too old to speak for the present.",
  INSUFFICIENT_AUTHORITY:
    "The claim appears only in sources that cannot settle it.",
  INDIRECT_ONLY:
    "The sources refer to this indirectly, without stating it.",
  STATE_NOT_FULLY_LIVE:
    "What is described is implementation or preparation, not a fully live state.",
  CONFLICTING_STATE: "The sources disagree about the current state.",
  TOKEN_STATE_UNQUALIFIED:
    "Token state is mentioned, but not precisely enough to settle the effect in question.",
  // B1 — the two supply-qualification codes. An unrecognised code renders
  // as nothing at all (see reasonExplanation below), so a new canonical
  // reason without copy would be a silent gap on the Result and the audit.
  // Both sentences describe the RECORD and never the project: neither says
  // supply did not fall, only that this research did not establish it.
  SUPPLY_REDUCTION_NOT_ESTABLISHED:
    "Nothing checked here shows tokens being destroyed — a purchase, a holding or a transfer moves tokens without reducing supply.",
  NET_SUPPLY_CHANGE_NOT_ESTABLISHED:
    "Tokens were destroyed, but nothing checked shows the total supply is lower overall — what else was issued or unlocked over the same period was not observed.",
};

// The FIRST recognised code wins. `reasonCodes` arrives in the order S5
// wrote it, and S5 writes the specific code first, so this is deterministic
// without a ranking of its own. An unrecognised code yields null rather than
// a de-snaked identifier: a copy gap must never become a leak.
export function reasonExplanation(
  codes: readonly unknown[] | null | undefined,
): string | null {
  for (const code of codes ?? []) {
    if (typeof code !== "string") continue;
    const explanation = REASON_CODE_EXPLANATIONS[code];
    if (explanation) return explanation;
  }
  return null;
}

// WHAT A CLASS OF SOURCE CAN AND CANNOT SETTLE.
//
// Attached to the CLASS, once, rather than written per document — a caveat
// repeated under every source becomes furniture and stops being read. This
// is a capability statement, not a score: it says what kind of question the
// source is competent to answer, which is falsifiable, where a trust number
// would not be.
//
// The distinction it protects is the product's founding one. Official
// documentation is not a weaker on-chain record; it answers a DIFFERENT
// question. It settles what a project states, and nothing whatsoever about
// whether the stated thing is happening.
// `from` is WHERE the finding came from and is the one thing a reader does
// not already know from the answer itself — so it is what the expansion
// leads with, instead of restating the answer in longer words.
// `can` explains why that kind of source is the right one to ask, and is
// what a source card shows. `cannot` is the boundary, and is the reason
// this map exists at all: documentation is not a weaker on-chain record,
// it answers a DIFFERENT question.
export const SOURCE_CLASS_CAVEATS: Record<
  string,
  { from: string; can: string; cannot: string }
> = {
  OFFICIAL_DOCS: {
    from: "This comes from the project's own documentation.",
    can: "Shows what the project officially documents.",
    cannot: "Documentation alone does not establish that the documented thing is happening.",
  },
  GOVERNANCE: {
    from: "This comes from a formal governance decision.",
    can: "Shows that a decision was formally approved.",
    cannot: "An approved decision is not proof that it was carried out.",
  },
  ONCHAIN_VERIFIABLE: {
    from: "This comes from on-chain records.",
    can: "Shows transactions and state recorded on-chain.",
    cannot: "Tying a record to a particular mechanism can still require more evidence.",
  },
  OFFICIAL_REPORT: {
    from: "This comes from the project's own reporting.",
    can: "Shows what the project reports about itself.",
    cannot: "Self-reporting is not independent confirmation.",
  },
  DATA_PROVIDER: {
    from: "This comes from a third-party data provider.",
    can: "Shows measured data, within that provider's methodology.",
    cannot: "The methodology behind the numbers is not itself verified here.",
  },
  RESEARCH_MEDIA: {
    from: "This comes from secondary reporting.",
    can: "Useful for context and for finding leads worth checking.",
    cannot: "Reporting does not replace the primary evidence a claim requires.",
  },
  SOCIAL: {
    from: "This comes from a public statement.",
    can: "Shows that a statement was made, and by whom.",
    cannot: "A statement being made is not evidence that it is accurate.",
  },
};

export function sourceClassCaveat(
  sourceClass: string | null | undefined,
): { from: string; can: string; cannot: string } | null {
  if (!sourceClass) return null;
  return SOURCE_CLASS_CAVEATS[sourceClass] ?? null;
}

// HOW COMPLETE THE CHECKING FOR ONE STEP ACTUALLY WAS.
//
// Derived on the server from `research_attempts`, which already carries a
// terminal status per (job, step, component). Nothing new is stored and no
// engine behaviour changes — that row was already being read and reduced to
// three aggregate counters before it reached the client.
//
// This exists to keep apart TWO situations the reconciler cannot itself
// distinguish. S5 sees Evidence rows and nothing else, so a step whose every
// fetch failed and a step whose sources genuinely said nothing both arrive
// as INSUFFICIENT_EVIDENCE carrying NO_EVIDENCE_FOUND. One of those is a
// finding about the public record; the other is a limitation of this run.
// Rendering them identically tells the reader a project lacks something when
// the truth is that ATLAS could not look.
export type ComponentCoverage = "COMPLETED" | "PARTIAL" | "BLOCKED" | "NOT_ATTEMPTED";

export interface ResultRow {
  // The persisted component this row reads. Carried for keys, test hooks and
  // the deep audit — NEVER rendered as a label.
  component: string;
  label: string;
  state: RealityState;
  stateLabel: string;
  rawStatus: string | null;
  // One sentence saying why this row has this state, from persisted reason
  // codes. Null where the state needs no explanation.
  reason: string | null;
  // What the evidence positively shows, restated from the component's own
  // ordinary-words phrase. Null on an unresolved row, where `reason` speaks.
  shows: string | null;
  coverage: ComponentCoverage;
  // Present ONLY where attempt data clearly shows the checking was blocked.
  // Never a claim for or against the project.
  limitation: string | null;
  admittedCount: number;
  refusedCount: number;
  checkedSummary: string;
  // Distinct admitted source classes behind this row, for the caveats about
  // what those sources cannot settle. Empty where nothing was admitted.
  sourceClasses: string[];
}

export interface ResultLadderView {
  mechanism: ResultRow[];
  value: ResultRow[];
  // The first mechanism row that is not established, and only where an
  // earlier mechanism row IS — the same conservative discipline
  // `chainStopsAtIndex` uses. Null when there is no established run to end,
  // because a boundary on an empty ladder implies a test that failed rather
  // than one that never had a foothold.
  boundary: ResultRow | null;
  derivable: boolean;
}

// TWO GROUPS, AND THE SEPARATION BETWEEN THEM IS LOAD-BEARING.
//
// The mechanism group is genuinely sequential: something is written down,
// then authorised, then switched on, then observed running. A break in it is
// meaningful, and it is where the story stops being demonstrable.
//
// The value group is NOT a continuation of that sequence. A document can
// state where value lands whether or not execution was ever observed, and
// the engine establishes those independently. Presenting them as later links
// of one chain would assert that an unverified execution step makes them
// impossible — a claim the engine never makes. That is why there are two
// groups here and not one arrow.
//
// Every label is a claim a reader can evaluate. None is a component name.
const MECHANISM_ROWS = [
  { component: "MECHANISM_SPEC", label: "The project documents the mechanism" },
  { component: "GOVERNANCE_BASIS", label: "A governing decision authorises it" },
  { component: "CURRENT_STATE", label: "It is currently active" },
  { component: "EXECUTION_EVIDENCE", label: "It has been observed executing" },
] as const;

const VALUE_ROWS = [
  { component: "SOURCE_OF_VALUE", label: "Where the value comes from" },
  { component: "FLOW_PATH", label: "The path the value takes" },
  { component: "DESTINATION", label: "Where the value is meant to go" },
  { component: "RECIPIENT", label: "Who receives it" },
  { component: "NET_EFFECT", label: "Effect on token supply" },
  { component: "DURABILITY_BASIS", label: "How durable the arrangement is" },
] as const;

// ROW STATE LABELS, AND WHY NONE OF THEM SAYS "COULD NOT VERIFY".
//
// That phrase used to name three different things on one screen — a panel
// heading, a component status and a rung state — so a reader could not tell
// whether they were seeing one finding restated or three separate ones. It
// also blamed ATLAS for what is usually a fact about the public record.
// "Not established" is the honest form: it describes the evidence, makes no
// claim that the thing is absent, and reads the same wherever it appears.
export const RESULT_STATE_LABELS: Record<RealityState, string> = {
  VERIFIED: "Established",
  PARTIAL: "Partly established",
  UNRESOLVED: "Not established",
  NOT_HAPPENING: "Evidence indicates otherwise",
  NOT_ASSESSED: "Not assessed",
};

// ONE NAME PER COMPONENT, EVERYWHERE A READER CAN SEE IT.
//
// `componentLabel` renders the Pattern's own vocabulary — "Net effect",
// "Flow path", "Durability basis" — which is precise for an analyst and
// close to meaningless for a reader ("net effect on what?"). Evidence cards
// used it to say which part of the mechanism a fragment supported, so the
// same internal words the ladder stopped showing reappeared one level down.
//
// The claim label is the SAME sentence the ladder row uses, so a reader who
// opens "Where the value is meant to go" and follows it into the evidence
// meets that phrase again instead of a new word for the same thing.
const CLAIM_LABELS: Record<string, string> = Object.fromEntries(
  [...MECHANISM_ROWS, ...VALUE_ROWS].map((r) => [r.component, r.label]),
);

export function componentClaimLabel(component: string | null | undefined): string {
  if (!component) return "This research";
  return CLAIM_LABELS[component] ?? componentLabel(component);
}

// THE SEMANTIC ENVELOPE OF A CANONICAL COMPONENT.
//
// A projection label is model-written presentation, and presentation may
// rename a finding but must never WIDEN it. Observed live: NET_EFFECT —
// whose canonical meaning is a durable effect on token SUPPLY — was
// labelled "the intended effect of buybacks on token value". A reader
// sees "value" and reasonably reads price. The research never checked
// price, so the label was quietly claiming a different question had been
// answered than the one the status underneath it grades.
//
// The guard is per COMPONENT, not per project: it names the vocabulary
// that is canonically wrong for a given component's meaning, and it holds
// for every project the engine will ever run. There is no token here, no
// domain, no question text — a Raydium run and a run on anything else are
// checked by the identical rule.
//
// A label that trips it is REPLACED with that component's own canonical
// label, never patched or reworded. Presentation degrades to the safe
// wording; it never tries to guess what the model meant.
const CLAIM_LABEL_FORBIDDEN: Record<string, RegExp> = {
  // Supply, not markets. Price/return/valuation are a different question.
  NET_EFFECT: /\b(price|valuation|market cap|marketcap|return|returns|yield|worth|value)\b/i,
  // Where value COMES FROM is not where it goes.
  SOURCE_OF_VALUE: /\b(destination|recipient|receives?|ends? up|goes? to)\b/i,
  // What is written down is not what is happening.
  MECHANISM_SPEC: /\b(execut|running|happening|live|active)/i,
  // An authorisation is not an execution.
  GOVERNANCE_BASIS: /\b(execut|running|happening)/i,
  // An intended destination is not an observed transfer.
  DESTINATION: /\b(execut|transferred|actually sent|observed)/i,
};

export function safeClaimLabel(component: string, label: string): string {
  const forbidden = CLAIM_LABEL_FORBIDDEN[component];
  if (forbidden && forbidden.test(label)) return componentClaimLabel(component);
  return label;
}

export interface LadderComponentInput {
  component: string;
  status: string;
  reasonCodes?: readonly unknown[];
  supportingEvidenceIds?: readonly string[];
  contradictingEvidenceIds?: readonly string[];
  excludedEvidence?: readonly { evidenceId: string; reason: string }[];
  coverage?: ComponentCoverage;
}

function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function buildRow(
  def: { component: string; label: string },
  byComponent: Map<string, LadderComponentInput>,
  classesByComponent: Record<string, readonly string[]> | undefined,
): ResultRow {
  const row = byComponent.get(def.component) ?? null;
  const rawStatus = row?.status ?? null;
  const state = rungState(rawStatus);
  const coverage: ComponentCoverage = row?.coverage ?? "NOT_ATTEMPTED";
  const admittedCount =
    (row?.supportingEvidenceIds?.length ?? 0) + (row?.contradictingEvidenceIds?.length ?? 0);
  const refusedCount = row?.excludedEvidence?.length ?? 0;
  const phrase = COMPONENT_PHRASES[def.component] ?? null;

  // A BLOCKED step must not borrow copy that implies checking happened.
  // "The sources ATLAS successfully checked did not provide evidence" is
  // true of an exhaustive search and false of a run whose fetches failed,
  // and the two arrive here indistinguishable at the reconciler. Where the
  // attempt data says the checking was blocked, the limitation speaks and
  // the reason-code sentence is withheld rather than restated wrongly.
  const blocked = coverage === "BLOCKED";
  const reason = blocked
    ? "ATLAS could not complete the checks for this step, so the evidence here is incomplete."
    : reasonExplanation(row?.reasonCodes);

  const shows =
    phrase === null
      ? null
      : state === "VERIFIED"
        ? `The checked evidence establishes ${phrase}.`
        : state === "PARTIAL"
          ? `The checked evidence partly establishes ${phrase}.`
          : state === "NOT_HAPPENING"
            ? `On ${phrase}, the checked evidence indicates otherwise.`
            : null;

  const checkedSummary = blocked
    ? "Sources for this step could not be opened."
    : admittedCount === 0 && refusedCount === 0
      ? "No source ATLAS read carried evidence for this step."
      : refusedCount === 0
        ? `${countLabel(admittedCount, "source", "sources")} used as evidence.`
        : admittedCount === 0
          ? `${countLabel(refusedCount, "source", "sources")} read and not used.`
          : `${countLabel(admittedCount, "source", "sources")} used as evidence, ${refusedCount} read and not used.`;

  return {
    component: def.component,
    label: def.label,
    state,
    stateLabel: RESULT_STATE_LABELS[state],
    rawStatus,
    reason,
    shows,
    coverage,
    limitation: blocked
      ? "Required source access failed during this step. This is a limit of the research run, not evidence for or against the project."
      : null,
    admittedCount,
    refusedCount,
    checkedSummary,
    sourceClasses: [...(classesByComponent?.[def.component] ?? [])],
  };
}

// THE MICRO-ANSWER — WHAT THE RESULT IS, NOT HOW STRONGLY IT IS HELD.
//
// A collapsed finding used to read:
//
//   Where does trading fee revenue go?          Established
//   The checked evidence establishes where the value ends up.
//
// The badge already says "Established". The sentence said it again in
// longer words and never answered the question, so a reader had to open
// every finding just to learn what was found. The status carries STRENGTH;
// this line carries SUBSTANCE.
//
// GROUNDING. For an established or partial finding the sentence is the
// engine's OWN statement of what the admitted evidence supports for this
// component — a persisted Evidence summary that already passed admission,
// selected in S5's canonical order rather than by any judgment of ours.
// Nothing is generated, nothing is re-worded, and no model is called.
//
// The candidates handed in are SUPPORTING-linked evidence for THIS
// component only, so the sentence cannot answer a different claim than
// the one the badge beside it grades. Where no such statement exists, the
// fallback is the narrowest honest sentence about the component itself —
// never a stronger claim reached for to fill the space.
export function findingMicroAnswer(
  row: ResultRow,
  supportingSummaries: readonly string[] = [],
): string | null {
  const phrase = COMPONENT_PHRASES[row.component] ?? null;
  if (phrase === null) return null;

  // A run that was blocked has no result to state. It says what could not
  // be checked and stops — the reason belongs in the expansion, and a
  // limitation must never read as a finding about the project.
  if (row.coverage === "BLOCKED") {
    return `${capitalise(phrase)} could not be checked in this research run.`;
  }

  switch (row.state) {
    case "VERIFIED":
    case "PARTIAL":
      // NOTHING, rather than a sentence that says only what the badge
      // already said. Where there is no admitted statement to put here,
      // "the checked evidence establishes where the value ends up" adds
      // no fact a reader did not have from the question and the status
      // beside it — it just costs them a line. The row stays question +
      // status, and the expansion supplies where it came from.
      return firstUsableSummary(supportingSummaries);
    case "NOT_HAPPENING":
      // Still framed as what the SOURCES show. A contradiction is the
      // strongest thing a run can say and it is still a statement about
      // evidence, not a bare assertion of the negative.
      return `On ${phrase}, the sources point the other way.`;
    default:
      // Says what remains unknown, and nothing about whether it is true.
      // "Was not established" is not "does not happen".
      return `${capitalise(phrase)} was not established.`;
  }
}

// One sentence, never a truncation. A summary is admitted Evidence: cutting
// it mid-clause could change what it says, so an over-long first sentence
// is DECLINED rather than shortened, and the caller falls back.
const MAX_MICRO_ANSWER = 200;

function firstUsableSummary(summaries: readonly string[]): string | null {
  for (const raw of summaries) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed)?.[0]?.trim() ?? trimmed;
    if (first.length === 0 || first.length > MAX_MICRO_ANSWER) continue;
    return /[.!?]$/.test(first) ? first : `${first}.`;
  }
  return null;
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

// ONE CONNECTED EXPLANATION, NOT A FILING SYSTEM.
//
// A finding used to expand into three headed blocks — what ATLAS checked,
// what the evidence shows, what it does not establish. Each was accurate
// and the set of them read like an internal report: the reader had to
// visit three boxes and join them up, which is the assembly work this
// product exists to have already done.
//
// The same facts, in the same order, as prose a person reads once.
// EVERY SENTENCE IS STILL DERIVED, never written for the occasion: the
// state, the persisted reason code, the coverage classification and the
// admitted source classes are the only inputs, and each contributes at
// most one sentence. There is no model call here and no free text.
//
// Two to four sentences. Past that a reader stops reading, and a fourth
// sentence nobody reaches is not more honest than three they finish.

// Which kind of source speaks for a finding when several do. A fixed
// precedence rather than evidence-link order, so the caveat a reader is
// shown is stable across runs and is always the STRONGEST kind of source
// behind the finding — the one whose limits matter most.
const CAVEAT_PRECEDENCE = [
  "ONCHAIN_VERIFIABLE",
  "GOVERNANCE",
  "OFFICIAL_DOCS",
  "OFFICIAL_REPORT",
  "DATA_PROVIDER",
  "RESEARCH_MEDIA",
  "SOCIAL",
];

export function findingExplanation(row: ResultRow): string[] {
  const phrase = COMPONENT_PHRASES[row.component] ?? null;

  // A RESEARCH LIMITATION IS ITS OWN EXPLANATION, AND LEADS.
  //
  // It must never be blended into sentences about what the evidence
  // showed, because in this case there is no evidence to have shown
  // anything — and a reader who skims would otherwise take "not
  // established" as a fact about the project.
  //
  // Stated as the state of the QUESTION, not as a narration of the run:
  // what is unavailable, what that leaves open, and whose limitation it
  // is. "Could not complete this stage" describes our workflow; nobody
  // asked about our workflow.
  if (row.coverage === "BLOCKED") {
    return [
      "The sources needed to check this were unavailable during this research run, so the question remains open.",
      "The limit is in research coverage, not evidence for or against the project.",
    ];
  }

  const sentences: string[] = [];
  const strongest = CAVEAT_PRECEDENCE.find((c) => row.sourceClasses.includes(c));
  const caveat = strongest ? sourceClassCaveat(strongest) : null;
  const established = row.state === "VERIFIED" || row.state === "PARTIAL";

  // 1 — WHERE IT CAME FROM. The one thing a reader cannot already know:
  // the row above states WHAT was found and the badge states how firmly,
  // so repeating either here would spend the reader's click on something
  // they have already read. What kind of source stands behind it is new.
  if (established && caveat) sentences.push(caveat.from);

  // 2 — why it stands where it does, from the persisted reason code. On an
  // established finding a reason code is a QUALIFIER (indirect only,
  // authority short of the bar) and is worth just as much as it is on an
  // unresolved one. On an unresolved row this is the whole explanation.
  if (row.reason) sentences.push(row.reason);

  // 3 — the boundary that the KIND of source cannot cross, whatever it
  // said. This is where "documented" is kept from reading as "happening",
  // and it belongs only where something was actually admitted.
  if (caveat && established) sentences.push(caveat.cannot);

  // A row with nothing else to say still says the honest minimum rather
  // than opening onto an empty panel.
  if (sentences.length === 0 && phrase) {
    sentences.push(
      row.state === "NOT_HAPPENING"
        ? `On ${phrase}, the sources point the other way.`
        : `Nothing checked settles ${phrase}.`,
    );
  }

  return sentences.slice(0, 3);
}

// THE QUESTION-DRIVEN VIEW — SAME DERIVATION, DIFFERENT SELECTION.
//
// A projection supplies two things and only two: WHICH canonical component
// results matter to the question that was asked, and what to CALL them.
// Everything a reader is told about truth still comes from `buildRow`,
// reading the same persisted component row it would have read anyway —
// status, reason code copy, coverage, limitation, evidence counts, source
// classes. That is the whole safety property, expressed as code reuse: a
// projection cannot make a row say anything a Pattern-driven row could not
// say about the same component, because it is the identical function.
//
// So the model chose the rows and named them; canonical research decided
// every word of what they mean. A row whose component has no persisted
// result is dropped here exactly as it is in the Pattern-driven ladder.
export function deriveQuestionFindings(
  findings: readonly {
    label: string;
    patternStep: number;
    component: string;
    supportingComponents: string[];
  }[],
  components: readonly LadderComponentInput[],
  classesByComponent?: Record<string, readonly string[]>,
): ResultRow[] {
  const byComponent = new Map(components.map((c) => [c.component, c]));
  return findings
    .map((f) =>
      buildRow(
        // The label passes the semantic-envelope guard before it is
        // rendered. A projection may rename a finding; it may not turn it
        // into a question the research did not ask.
        { component: f.component, label: safeClaimLabel(f.component, f.label) },
        byComponent,
        classesByComponent,
      ),
    )
    .filter((r) => r.state !== "NOT_ASSESSED");
}

// NOT_ASSESSED ROWS ARE HIDDEN, NOT DIMMED.
//
// A component with no persisted result was not tested. Listing it greyed out
// asks the reader to interpret an engine-internal absence, and it reads as a
// further failure sitting beside the real findings. What a run did not
// assess is not part of what that run found.
export function deriveResultLadder(
  components: readonly LadderComponentInput[],
  classesByComponent?: Record<string, readonly string[]>,
): ResultLadderView {
  const byComponent = new Map(components.map((c) => [c.component, c]));
  const build = (defs: readonly { component: string; label: string }[]) =>
    defs
      .map((d) => buildRow(d, byComponent, classesByComponent))
      .filter((r) => r.state !== "NOT_ASSESSED");

  const mechanism = build(MECHANISM_ROWS);
  const value = build(VALUE_ROWS);

  // The same conservative rule the reality-check break marker uses: a
  // boundary is a claim about where an ESTABLISHED run ends, so it is drawn
  // only when there is one to end.
  const firstEstablished = mechanism.findIndex((r) => r.state === "VERIFIED");
  const firstOpen = mechanism.findIndex((r) => r.state !== "VERIFIED");
  const boundary =
    firstEstablished === -1 || firstOpen === -1 ? null : (mechanism[firstOpen] ?? null);

  return { mechanism, value, boundary, derivable: components.length > 0 };
}
