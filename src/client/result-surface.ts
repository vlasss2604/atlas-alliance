// RESULT PRESENTATION V1 — THE SURFACE MODEL OF A FINISHED RESEARCH.
//
// COMPLEX RESEARCH. SIMPLE SURFACE. The engine may be complex; what a
// reader meets must answer six questions in five to twenty seconds:
//
//   1. What is the answer to my question?
//   2. What actually happens with the money / value?
//   3. What is documented vs actually executing?
//   4. What evidence supports each important conclusion?
//   5. What could ATLAS NOT establish?
//   6. How current is the evidence?
//
// Everything here is a PURE derivation from the detail payload the result
// route already returns — persisted component statuses and reason codes,
// the question projection's own rows, admitted evidence with its links,
// the Proof's verdict, confidence and boundary record. No fetch, no model,
// no research. The invariant is absolute and pinned:
//
//   PAGE <= PERSISTED VERIFIED RECORD
//
// The surface may simplify, group, shorten, reorder and translate. It may
// not invent, infer, strengthen, hide a material limitation, convert a
// technical failure into project reality, convert "not established" into
// a contradiction, or convert "partially confirmed" into "confirmed".
//
// NO ENGINE VOCABULARY LEAVES THIS FILE. Reason codes, boundary codes,
// stage names, attempt and recovery language are read here and rendered
// as plain sentences; the closed lists at the bottom are what the tests
// scan a rendered surface for.

import type { ProofBoundaryView, ResearchJobDetail } from "./api";
import { compactAmount } from "./components/result-blocks/selected-blocks";
import {
  canonicalDocumentKey,
  componentClaimLabel,
  componentPhrase,
  deriveQuestionFindings,
  deriveResultLadder,
  domainOf,
  jobOutcome,
  researchAnswer,
  resultBriefing,
  retrievedOn,
  sourceClassCaveat,
  sourceClassLabel,
  type ComponentCoverage,
  type EvidenceItemLike,
  type JobState,
  type LadderComponentInput,
  type OutcomeKind,
  type RealityState,
  type ResultRow,
  type VerdictTone,
} from "./research-model";

/* ------------------------------------------------------------------ *
 * 1. STATUS — ONE VOCABULARY, FOUR WORDS
 * ------------------------------------------------------------------ */

export type ResultStatus = "CONFIRMED" | "PARTIAL" | "NOT_ESTABLISHED" | "CONTRADICTED";

// SUPPORTED → Confirmed, PARTIALLY_SUPPORTED → Partially confirmed,
// INSUFFICIENT_EVIDENCE → Not established, CONTRADICTED → Contradicted. A
// component with no persisted row (NOT_ASSESSED) has no status and is not
// shown: what a run did not assess is not part of what it found.
export const RESULT_STATUS_LABELS: Record<ResultStatus, string> = {
  CONFIRMED: "Confirmed",
  PARTIAL: "Partially confirmed",
  NOT_ESTABLISHED: "Not established",
  CONTRADICTED: "Contradicted",
};

// THE STATE, IN A READER'S WORD — what the surfaces show beside a fact.
// The canonical labels above remain the record's vocabulary (tests, the
// technical record); these are the words a person reads.
export const RESULT_STATE_WORDS: Record<ResultStatus, string> = {
  CONFIRMED: "Verified",
  PARTIAL: "Partly verified",
  NOT_ESTABLISHED: "Unresolved",
  CONTRADICTED: "Contradicted",
};

export function resultStatus(state: RealityState): ResultStatus | null {
  switch (state) {
    case "VERIFIED":
      return "CONFIRMED";
    case "PARTIAL":
      return "PARTIAL";
    case "UNRESOLVED":
      return "NOT_ESTABLISHED";
    case "NOT_HAPPENING":
      return "CONTRADICTED";
    default:
      return null;
  }
}

export function statusTone(status: ResultStatus): VerdictTone {
  switch (status) {
    case "CONFIRMED":
      return "supported";
    case "PARTIAL":
      return "partial";
    case "CONTRADICTED":
      return "negative";
    default:
      return "insufficient";
  }
}

/* ------------------------------------------------------------------ *
 * 2. THE BOUNDARY — THREE KINDS, FROM PERSISTED TRUTH
 * ------------------------------------------------------------------ */

// A check that is "not established" stopped for one of three reasons, and
// the reader must be able to tell them apart without a model:
//
//   SUBSTANTIVE     the relevant available paths were checked and the
//                   evidence still did not establish it;
//   TECHNICAL       the bounded Research reached a limit before every
//                   relevant evidence path could be checked (a search or
//                   recovery limit, an unreadable or unavailable source);
//   CONFIGURATION   ATLAS currently has no supported evidence route that
//                   could establish this (no confirmed official route for
//                   the only classes that could).
//
// Read from the Proof's boundary record where one exists; where the Proof
// predates the record, from the same closed reason codes the reducer
// persisted plus the attempt coverage. Neither reading is inferred.
export type BoundaryKind = "SUBSTANTIVE" | "TECHNICAL" | "CONFIGURATION";

export const BOUNDARY_COPY: Record<BoundaryKind, string> = {
  SUBSTANTIVE: "The available evidence does not settle this.",
  TECHNICAL: "The research limit was reached before all relevant sources could be checked.",
  CONFIGURATION: "ATLAS currently lacks a source route that can independently verify this point.",
};

// What each kind must never read as. Stated once, beside the group, so the
// distinction the record carries survives onto the screen.
export const BOUNDARY_NEVER: Record<BoundaryKind, string> = {
  SUBSTANTIVE: "This describes the evidence checked, not proof that the thing is absent.",
  TECHNICAL: "This is a limit of the research run, not a finding about the project.",
  CONFIGURATION: "This is a limit of what ATLAS can currently verify, not a finding that the mechanism is not executing.",
};

const TECHNICAL_BOUNDARY_CODES: ReadonlySet<string> = new Set([
  "RECOVERY_BOUND_REACHED",
  "KNOWN_PATHS_UNEXPLORED",
  "SEARCH_BUDGET_EXHAUSTED",
  "EXTRACTION_NOT_COMPLETED",
  "SOURCE_UNAVAILABLE",
  "SEARCH_UNAVAILABLE",
  "NO_QUERIES_PROPOSED",
]);
const CONFIGURATION_BOUNDARY_CODES: ReadonlySet<string> = new Set(["NO_ADMISSIBLE_ROUTE"]);

export interface BoundaryReading {
  kind: BoundaryKind;
  // Known evidence paths still open when the run stopped, summed over
  // kinds — present only where the boundary record carries them.
  remainingPaths: number | null;
  // Whether the reading came from the Proof's own record or from the
  // reason codes of a Proof written before the record existed.
  source: "RECORD" | "REASON_CODES";
}

export function boundaryOf(input: {
  component: string;
  reasonCodes: readonly unknown[] | null | undefined;
  coverage: ComponentCoverage;
  boundary: ProofBoundaryView | null | undefined;
}): BoundaryReading {
  const entry = input.boundary?.technical.find((t) => t.component === input.component) ?? null;
  const fromRecord = input.boundary !== null && input.boundary !== undefined;
  const codes = fromRecord
    ? (entry?.codes ?? [])
    : (input.reasonCodes ?? []).filter((c): c is string => typeof c === "string");
  const technical = codes.some((c) => TECHNICAL_BOUNDARY_CODES.has(c)) || (!fromRecord && input.coverage === "BLOCKED");
  const configuration = codes.some((c) => CONFIGURATION_BOUNDARY_CODES.has(c));
  const remaining = entry?.remainingPaths?.reduce((n, p) => n + Math.max(0, p.count), 0) ?? null;
  return {
    kind: technical ? "TECHNICAL" : configuration ? "CONFIGURATION" : "SUBSTANTIVE",
    remainingPaths: remaining !== null && remaining > 0 ? remaining : null,
    source: fromRecord ? "RECORD" : "REASON_CODES",
  };
}

/* ------------------------------------------------------------------ *
 * 3. THE PROOF PATH — THE CHAIN A VALUE QUESTION TURNS ON
 * ------------------------------------------------------------------ */

// The logical order of a value-capture story, top to bottom: where the
// value comes from → how it moves → what the project specifies → what
// governance decided → whether it is active → whether it executed → where
// the tokens go → who holds them → what that does to supply → how durable
// it is. The table and the proof map both read in this order, so a reader
// scans the money story rather than the Pattern's step numbers.
export const PROOF_PATH_ORDER = [
  "SOURCE_OF_VALUE",
  "FLOW_PATH",
  "MECHANISM_SPEC",
  "GOVERNANCE_BASIS",
  "CURRENT_STATE",
  "EXECUTION_EVIDENCE",
  "DESTINATION",
  "RECIPIENT",
  "NET_EFFECT",
  "DURABILITY_BASIS",
] as const;

// THE MECHANISM, IN THE READER'S OWN WORD. The question and the
// projection's labels name what was asked about — a buyback, a burn, a
// revenue share, a reward. The noun is read from those words, never
// guessed from the intent: "the mechanism" is the honest fallback.
export function mechanismNounOf(texts: readonly (string | null | undefined)[]): string {
  const text = texts.filter((t): t is string => typeof t === "string").join(" ").toLowerCase();
  if (/buy[- ]?back|repurchas/.test(text)) return "the buyback";
  if (/\bburn/.test(text)) return "the burn";
  if (/revenue[- ]shar|fee[- ]shar|dividend|distribut/.test(text)) return "the revenue share";
  if (/staking|reward/.test(text)) return "the reward";
  if (/fee switch/.test(text)) return "the fee switch";
  return "the mechanism";
}

// WHAT A READER ACTUALLY ASKS, per check — never the Pattern's noun. The
// question projection's own labels lead where they exist; these serve the
// checks it leans on and the reality checks it did not name.
export function questionLabelFor(component: string, noun: string): string {
  const buyback = noun === "the buyback";
  switch (component) {
    case "SOURCE_OF_VALUE":
      return `What pays for ${noun}?`;
    case "FLOW_PATH":
      return "How does the value get there?";
    case "MECHANISM_SPEC":
      return `How is ${noun} designed to work?`;
    case "GOVERNANCE_BASIS":
      return "Who approved it?";
    case "CURRENT_STATE":
      return `Is ${noun} happening now?`;
    case "EXECUTION_EVIDENCE":
      return `Has ${noun} actually executed?`;
    case "DESTINATION":
      return buyback ? "Where do the bought tokens go?" : "Where does the value go?";
    case "RECIPIENT":
      return "Who ultimately receives it?";
    case "NET_EFFECT":
      return "Does total supply actually decrease?";
    case "DURABILITY_BASIS":
      return "How durable is it?";
    default:
      return componentClaimLabel(component);
  }
}

// The same checks as clauses of a sentence — "ATLAS established WHAT PAYS
// FOR THE BUYBACK and WHO APPROVED IT". Object forms for the answer.
export function statementPhraseFor(component: string, noun: string): string {
  const buyback = noun === "the buyback";
  switch (component) {
    case "SOURCE_OF_VALUE":
      return `what pays for ${noun}`;
    case "FLOW_PATH":
      return "how the value gets there";
    case "MECHANISM_SPEC":
      return `how ${noun} is designed to work`;
    case "GOVERNANCE_BASIS":
      return "who approved it";
    case "CURRENT_STATE":
      return `that ${noun} is happening now`;
    case "EXECUTION_EVIDENCE":
      return `that ${noun} has actually executed`;
    case "DESTINATION":
      return buyback ? "where the bought tokens go" : "where the value goes";
    case "RECIPIENT":
      return "who ultimately receives it";
    case "NET_EFFECT":
      return "that total supply actually decreases";
    case "DURABILITY_BASIS":
      return "how durable it is";
    default:
      return componentPhrase(component) ?? componentClaimLabel(component).toLowerCase();
  }
}

function pathIndex(component: string): number {
  const i = (PROOF_PATH_ORDER as readonly string[]).indexOf(component);
  return i === -1 ? PROOF_PATH_ORDER.length : i;
}

/* ------------------------------------------------------------------ *
 * 4. EVIDENCE — ONE CARD SHAPE FOR EVERY SURFACE
 * ------------------------------------------------------------------ */

export interface EvidenceCard {
  id: string;
  component: string | null;
  relation: "SUPPORTS" | "CONTRADICTS";
  // The check this evidence was admitted for, in the reader's words.
  claim: string;
  // What it proves: the engine's persisted reading, the passage otherwise.
  proves: string;
  // What it does NOT prove — the extractor's own record for this passage,
  // the class's generic limit otherwise.
  doesNotProve: string | null;
  excerpt: string;
  sourceName: string;
  sourceClass: string;
  sourceDomain: string;
  // The most informative date the row carries: publication first, then
  // the moment a chain state was observed, then when the copy was read.
  // `iso` is the persisted instant, for ordering; `value` is what is shown.
  date: { label: "Published" | "Observed" | "Checked"; value: string; iso: string } | null;
  url: string;
  // A live original to open — absent for a chain read, which has no page.
  openable: boolean;
  snapshotHref: string | null;
  // A chain observation translated for a reader: what was observed, on
  // which network — never the raw integer.
  onchain: { observation: string; network: string | null } | null;
  whyUsed: string | null;
}

export interface EvidenceLike extends EvidenceItemLike {
  onchainFactKind?: string | null;
  // The row's stated lifecycle state, as persisted. Optional: fixtures and
  // older payloads may not carry it, and absence reads as "no known state".
  mechanismState?: string | null;
  publishedAt?: string | null;
  // 1 = strict publication-date rule; null / absent = legacy provenance.
  publishedAtRuleVersion?: number | null;
  observedAt?: string | null;
  dataAsOf?: string | null;
}

interface QuantityLike {
  evidenceId: string;
  factKind: string;
  mint: string;
  decimals: number;
  amountRaw: string;
}

// A chain observation, read for a person. `TOKEN_SUPPLY` is the one
// projected kind, and its unit is the token itself, so the sentence names
// the token by its ticker where the job knows one.
function onchainObservation(
  e: EvidenceLike,
  quantity: QuantityLike | null,
  ticker: string | null,
): EvidenceCard["onchain"] {
  if (e.sourceClass !== "ONCHAIN_VERIFIABLE") return null;
  const network = networkOf(e.retrievedUrl);
  if (quantity && quantity.factKind === "TOKEN_SUPPLY") {
    const subject = ticker ? `${ticker} total supply` : "Token total supply";
    return { observation: `${subject} observed: ${compactAmount(quantity.amountRaw, quantity.decimals)}`, network };
  }
  return { observation: e.summary?.trim() || "On-chain state observed", network };
}

// `atlas-onchain://<chain>/<network>/…` names the chain in its first
// segment. Anything else is not a chain locator and yields nothing.
export function networkOf(url: string): string | null {
  const m = /^atlas-onchain:\/\/([a-z0-9-]+)\/([a-z0-9-]+)/i.exec(url);
  if (!m) return null;
  const chain = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[2] === "mainnet" ? chain : `${chain} ${m[2]}`;
}

function dateOf(e: EvidenceLike): EvidenceCard["date"] {
  const published = retrievedOn(e.publishedAt ?? null);
  if (published) return { label: "Published", value: published, iso: e.publishedAt! };
  const observedIso = e.observedAt ?? e.dataAsOf ?? null;
  const observed = retrievedOn(observedIso);
  if (observed) return { label: "Observed", value: observed, iso: observedIso! };
  const checked = retrievedOn(e.fetchedAt ?? null);
  return checked ? { label: "Checked", value: checked, iso: e.fetchedAt! } : null;
}

export function evidenceCard(
  e: EvidenceLike,
  relation: EvidenceCard["relation"],
  input: { jobId: string | null; quantity: QuantityLike | null; ticker: string | null; component?: string | null },
): EvidenceCard {
  const component = input.component ?? e.component;
  const caveat = sourceClassCaveat(e.sourceClass);
  const onchain = onchainObservation(e, input.quantity, input.ticker);
  const domain = onchain ? (onchain.network ?? "on-chain") : domainOf(e.retrievedUrl);
  return {
    id: e.id,
    component,
    relation,
    claim: componentClaimLabel(component),
    // A chain reading is translated for the main surface: the persisted
    // summary carries the raw integer, the mint and the slot, and those
    // belong to the full evidence, not to a card a reader scans.
    proves: onchain ? onchain.observation : e.summary && e.summary.trim().length > 0 ? e.summary : e.fragment,
    doesNotProve: e.doesNotProve ?? caveat?.cannot ?? null,
    excerpt: e.fragment,
    sourceName: onchain ? "On-chain record" : e.sourceTitle?.trim() || domain,
    sourceClass: sourceClassLabel(e.sourceClass),
    sourceDomain: domain,
    date: dateOf(e),
    url: e.retrievedUrl,
    openable: !onchain && /^https?:\/\//i.test(e.retrievedUrl),
    snapshotHref: e.hasSnapshot && input.jobId ? `/research/${input.jobId}/source/${e.id}` : null,
    onchain,
    whyUsed: caveat?.can ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 5. THE RESEARCH TABLE — THE PRIMARY RESULT SURFACE
 * ------------------------------------------------------------------ */

export interface ResearchTableRow {
  // Carried for keys and tests — never rendered as a label.
  component: string;
  // What was checked, in plain language: the question projection's own
  // wording for the rows it named, the canonical claim otherwise.
  label: string;
  status: ResultStatus;
  statusLabel: string;
  tone: VerdictTone;
  // 1–2 short lines: what the evidence established, or — for a row that
  // is not established — the plain reason it stopped there.
  established: string;
  boundary: BoundaryReading | null;
  // A partly supported row whose own claim the persisted reason says is not
  // shown (CLAIM_NOT_SHOWN_CODES). The answer then says what the evidence
  // does not show, never "there is evidence that …".
  claimNotShown?: true;
  // A CURRENT_STATE row established as a stop — PAUSED, DEPRECATED or
  // REMOVED. The answer then says so, never "happening now".
  statedStop?: StopState;
  // The strongest admitted source behind the row, immediately visible.
  source: { kind: string; name: string } | null;
  date: EvidenceCard["date"];
  // Admitted evidence for this row only (SUPPORTING / CONTRADICTING links).
  evidence: EvidenceCard[];
  // True for the rows the question projection named directly.
  primary: boolean;
  // PRIMARY: a row the question projection named. REALITY: a row the
  // reader must always see when the record assessed it — what is
  // documented versus what is active and executing. SUPPORTING: a check a
  // primary finding leans on, established — folded under that finding as
  // one quiet line. PROMOTED: a supporting check that is contradicted,
  // blocked or uncertain; hiding it inside another row would conceal a
  // material limitation, so it stands as a row of its own.
  kind: "PRIMARY" | "REALITY" | "SUPPORTING" | "PROMOTED";
  // The established supporting checks folded under this row — as the
  // things they settle ("what pays for the buyback"), never as statuses.
  restsOn: { component: string; label: string; phrase: string; status: ResultStatus; statusLabel: string; tone: VerdictTone }[];
  // The row's underlying derivation, for the deep surfaces.
  row: ResultRow;
}

// THE PAPER-VS-REALITY AXIS. Whatever the question projection named, a
// reader must be able to tell what the project documents from what is
// active and executing — so these three stand as rows of their own
// whenever the record assessed them.
export const REALITY_COMPONENTS: readonly string[] = ["MECHANISM_SPEC", "CURRENT_STATE", "EXECUTION_EVIDENCE"];

// Which kind of source speaks for a row when several do — the same fixed
// precedence the ladder's caveats use, strongest first.
const SOURCE_PRECEDENCE = [
  "ONCHAIN_VERIFIABLE",
  "GOVERNANCE",
  "OFFICIAL_DOCS",
  "OFFICIAL_REPORT",
  "DATA_PROVIDER",
  "RESEARCH_MEDIA",
  "SOCIAL",
];

const MAX_ESTABLISHED = 220;

// POINT-IN-TIME STATE ≠ MECHANISM EXECUTION, ON EVERY RECORD. The engine no
// longer lets a single supply reading establish any component
// (onchain-facts.ts), but Proofs persisted before that rule still carry
// CURRENT_STATE / NET_EFFECT rows whose only support is one. They are never
// recomputed, so the surface applies the same ceiling when it reads them: a
// row resting only on level readings is shown as not established. Never the
// other way — this can only weaken a row.
const LEVEL_READING_FACT_KINDS: ReadonlySet<string> = new Set(["TOKEN_SUPPLY"]);
const LEVEL_READING_LIMIT = "A single reading of total supply cannot show this.";

function restsOnlyOnLevelReadings(
  supportingEvidenceIds: readonly string[] | undefined,
  quantityByEvidence: ReadonlyMap<string, QuantityLike>,
): boolean {
  const ids = supportingEvidenceIds ?? [];
  return ids.length > 0 && ids.every((id) => LEVEL_READING_FACT_KINDS.has(quantityByEvidence.get(id)?.factKind ?? ""));
}

// BURN EVENT ≠ CLAIMED MECHANISM EXECUTION, ON EVERY RECORD. A burn shows
// that tokens were destroyed, never that the researched mechanism did it;
// the engine no longer lets a burn establish EXECUTION_EVIDENCE, and a
// saved row resting only on burn events is shown as not established.
const BURN_EVENT_ONLY_LIMIT =
  "A burn of the project token was observed, but the available evidence does not establish that it was executed by the claimed mechanism.";

function restsOnlyOnBurnEvents(
  component: string,
  supportingEvidenceIds: readonly string[] | undefined,
  kindByEvidence: ReadonlyMap<string, string | null>,
): boolean {
  const ids = supportingEvidenceIds ?? [];
  return component === "EXECUTION_EVIDENCE" && ids.length > 0 && ids.every((id) => kindByEvidence.get(id) === "BURN");
}

// FRESH DOCUMENT ≠ CURRENT CLAIM, ON EVERY RECORD. The engine now lets a
// "what is true now" component be established only by a row that STATES a
// known state; Proofs saved before that rule may carry CURRENT_STATE as
// established on rows that state none — a cumulative total on a freshly
// dated page, say. They are never recomputed, so the surface reads them the
// way the engine now would: not established. Never the other way — this can
// only weaken a row. The known-state vocabulary is the engine's own
// (domain/mechanism-state.ts), pinned equal by a test.
export const KNOWN_STATED_STATES: ReadonlySet<string> = new Set([
  "PROPOSED",
  "APPROVED",
  "IMPLEMENTING",
  "LIVE",
  "DEPRECATED",
  "REMOVED",
  "PAUSED",
]);
const CURRENT_CLAIM_COMPONENTS: ReadonlySet<string> = new Set(["CURRENT_STATE"]);
const STATE_UNSTATED_LIMIT =
  "The sources checked do not state whether this is happening now; a recent page date alone cannot show it.";
// UNTRUSTED DOCUMENTARY DATES MUST NOT CREATE CURRENT TEMPORAL TRUTH, ON EVERY
// RECORD. A saved CURRENT_STATE established on documentary rows whose
// publication date was not produced under the strict rule (unmarked: legacy)
// is shown as not established; the rows and their dates stay visible.
const DATE_UNTRUSTED_LIMIT =
  "The sources checked carry no publication date that can show this is happening now.";
const TRUSTED_RULE_VERSION = 1;

type CurrentClaimCeiling = "STATE_UNSTATED" | "DATE_UNTRUSTED" | null;

function currentClaimCeilingOf(
  component: string,
  supportingEvidenceIds: readonly string[] | undefined,
  evidenceById: ReadonlyMap<string, EvidenceLike>,
): CurrentClaimCeiling {
  if (!CURRENT_CLAIM_COMPONENTS.has(component)) return null;
  const ids = supportingEvidenceIds ?? [];
  if (ids.length === 0) return null;
  let allStateless = true;
  for (const id of ids) {
    const e = evidenceById.get(id);
    const stated = KNOWN_STATED_STATES.has((e?.mechanismState ?? "").trim().toUpperCase());
    if (!stated) continue;
    allStateless = false;
    // A chain row is held to its own ceilings (a level reading, a burn); this
    // one is about DOCUMENTARY publication dates only.
    if (e!.onchainFactKind || e!.sourceClass === "ONCHAIN_VERIFIABLE") return null;
    const trusted = e!.publishedAt != null && e!.publishedAtRuleVersion === TRUSTED_RULE_VERSION;
    if (trusted) return null;
  }
  return allStateless ? "STATE_UNSTATED" : "DATE_UNTRUSTED";
}

// ---- stop states, and the latest trusted state the lifecycle read ---------
export type StopState = "PAUSED" | "DEPRECATED" | "REMOVED";
const STOP_STATE_SET: ReadonlySet<string> = new Set(["PAUSED", "DEPRECATED", "REMOVED"]);

export interface LatestStatedState {
  state: string;
  at: string;
}

// The unanimous stop state a CURRENT_STATE row's supporting evidence states,
// or null (a live state, a mixture, or no known state).
function statedStopOf(evidence: readonly EvidenceLike[]): StopState | null {
  const states = new Set(
    evidence.map((e) => (e.mechanismState ?? "").trim().toUpperCase()).filter((s) => KNOWN_STATED_STATES.has(s)),
  );
  if (states.size !== 1) return null;
  const only = [...states][0];
  return STOP_STATE_SET.has(only) ? (only as StopState) : null;
}

export function stopStatePhrase(state: StopState, noun: string): string {
  if (state === "PAUSED") return `that ${noun} is currently paused`;
  if (state === "DEPRECATED") return `that ${noun} has been deprecated`;
  return `that ${noun} has been removed`;
}

// For a CURRENT_STATE row established as a stop. "Latest" only when the
// lifecycle's own latest trusted state agrees; otherwise just what was stated.
function establishedStopNote(state: StopState, latest: LatestStatedState | null): string {
  const isLatest = latest !== null && latest.state === state;
  const when = isLatest ? retrievedOn(latest.at) : null;
  if (state === "PAUSED") {
    return isLatest
      ? `The latest official state is paused${when ? ` (dated ${when})` : ""}; this does not show it happening now.`
      : "An official record states it is paused; this does not show it happening now.";
  }
  const word = state === "DEPRECATED" ? "deprecated" : "removed";
  return isLatest
    ? `An official record${when ? ` dated ${when}` : ""} states it was ${word}; nothing newer shows it active again.`
    : `An official record states it was ${word}.`;
}

// For a CURRENT_STATE row that is NOT established, from the lifecycle's latest
// trusted stated state. A stale LIVE, a paused record of any age, and a durable
// stop each say what the latest trusted record said — never that it holds now.
function latestStateNote(latest: LatestStatedState): string | null {
  const when = retrievedOn(latest.at);
  if (!when) return null;
  const state = latest.state.toUpperCase();
  if (state === "PAUSED") return `It was last recorded as paused on ${when}; its current state is unknown.`;
  if (state === "DEPRECATED" || state === "REMOVED") {
    return `An official record dated ${when} states it was ${state === "DEPRECATED" ? "deprecated" : "removed"}; nothing newer shows it active again.`;
  }
  if (state === "LIVE" || state === "IMPLEMENTING") {
    return `The latest record saying it is active is dated ${when}; nothing recent confirms it is active now.`;
  }
  return null;
}

// The latest trusted stated state from the persisted mechanism flows, when
// the assembly recorded one. Older assemblies carry none.
export function latestStatedStateOf(flows: readonly unknown[] | null | undefined): LatestStatedState | null {
  for (const f of flows ?? []) {
    const v = (f as { latestStatedState?: unknown } | null)?.latestStatedState as
      | { state?: unknown; at?: unknown }
      | undefined;
    if (v && typeof v.state === "string" && typeof v.at === "string") return { state: v.state, at: v.at };
  }
  return null;
}

// THE SURFACE CEILING, ONE PLACE. What the engine no longer lets these
// rows establish, read off a saved record: a lone level reading (any
// component), burn events only (EXECUTION_EVIDENCE), or rows stating no
// known state (CURRENT_STATE). Used by the table and by the non-verdict
// answer, which reads component statuses directly.
type SurfaceCeiling = "LEVEL_ONLY" | "BURN_ONLY" | "STATE_UNSTATED" | "DATE_UNTRUSTED" | null;

function surfaceCeilingOf(
  component: string,
  persistedStatus: string,
  supportingEvidenceIds: readonly string[] | undefined,
  quantityByEvidence: ReadonlyMap<string, QuantityLike>,
  kindByEvidence: ReadonlyMap<string, string | null>,
  evidenceById: ReadonlyMap<string, EvidenceLike> = new Map(),
): SurfaceCeiling {
  if (persistedStatus !== "SUPPORTED" && persistedStatus !== "PARTIALLY_SUPPORTED") return null;
  if (restsOnlyOnLevelReadings(supportingEvidenceIds, quantityByEvidence)) return "LEVEL_ONLY";
  if (restsOnlyOnBurnEvents(component, supportingEvidenceIds, kindByEvidence)) return "BURN_ONLY";
  return currentClaimCeilingOf(component, supportingEvidenceIds, evidenceById);
}

// A partly supported row whose persisted reason says its OWN claim is not
// shown — no supply reduction, no net change, or measured intervals that
// disagree. Something real may stand behind the row (a burn, say), but the
// answer must not say there is evidence for the claim itself.
const CLAIM_NOT_SHOWN_CODES: ReadonlySet<string> = new Set([
  "SUPPLY_REDUCTION_NOT_ESTABLISHED",
  "NET_SUPPLY_CHANGE_NOT_ESTABLISHED",
  "CONFLICTING_SUPPLY_DELTA",
]);

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed)?.[0]?.trim() ?? trimmed;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

// THE ANSWER CELL — THE FACT FIRST, THEN WHAT STOPS IT BEING WHOLE.
//
// A confirmed row speaks in the engine's persisted reading of an admitted
// source (S5's order; never a sentence written here). A partially
// confirmed row says the same fact and then, in one sentence from the
// persisted reason code, exactly what could not be confirmed — so a
// reader never has to ask "partial how?". A contradicted row speaks in
// the contradicting source's reading. A not-established row states, in
// plain words, why: the persisted reason for a substantive gap, or the
// kind of limit the run hit.
export const ROW_LIMIT_COPY: Record<Exclude<BoundaryKind, "SUBSTANTIVE">, string> = {
  TECHNICAL: "The research limit was reached before this could be checked.",
  CONFIGURATION: "ATLAS currently lacks a source route that can independently verify this point.",
};

function establishedText(row: ResultRow, evidence: EvidenceCard[], boundary: BoundaryReading | null): string {
  const phrase = statementPhraseFor(row.component, "the mechanism");
  if (row.state === "VERIFIED" || row.state === "PARTIAL") {
    const summary = evidence.find((e) => e.relation === "SUPPORTS" && !e.onchain)?.proves
      ?? evidence.find((e) => e.relation === "SUPPORTS")?.proves;
    const fact = summary && firstSentence(summary).length <= MAX_ESTABLISHED ? firstSentence(summary) : null;
    if (row.state === "VERIFIED") return fact ?? row.shows ?? `The sources confirm ${phrase}.`;
    // Partial: the fact, then the gap — one persisted sentence, never the
    // word "partial" on its own.
    const gap = row.reason ?? "The whole claim is not confirmed by the sources that could be relied on.";
    return fact ? `${fact} ${gap}` : `The sources cover part of this. ${gap}`;
  }
  if (row.state === "NOT_HAPPENING") {
    const contra = evidence.find((e) => e.relation === "CONTRADICTS")?.proves;
    if (contra) {
      const one = firstSentence(contra);
      if (one.length <= MAX_ESTABLISHED) return `${one} The evidence points the other way.`;
    }
    return "The evidence points the other way.";
  }
  const kind = boundary?.kind ?? "SUBSTANTIVE";
  if (kind !== "SUBSTANTIVE") return ROW_LIMIT_COPY[kind];
  return row.reason ?? "The available evidence does not settle this.";
}

// A CURRENT_STATE row either established as a stop (its note says what was
// stated, and "latest" only when the lifecycle agrees), or not established
// with a latest trusted state the lifecycle recorded. Every other row is
// returned unchanged.
function withCurrentStateNote(
  component: string,
  status: ResultStatus,
  statedStop: StopState | null,
  latest: LatestStatedState | null,
  text: string,
): string {
  if (!CURRENT_CLAIM_COMPONENTS.has(component)) return text;
  if (statedStop !== null) return `${text} ${establishedStopNote(statedStop, latest)}`;
  if (status === "NOT_ESTABLISHED" && latest !== null) {
    const note = latestStateNote(latest);
    return note ? `${text} ${note}` : text;
  }
  return text;
}

// HISTORICAL EXECUTION ≠ EXECUTING NOW. Execution evidence shows that the
// mechanism executed at the time of the evidence; it never shows that it
// continues. A confirmed or partly confirmed execution row therefore says
// when its evidence is from, or that the evidence carries no date of its own.
function withExecutionTimeNote(
  component: string,
  status: ResultStatus,
  text: string,
  evidence: EvidenceCard[],
): string {
  if (component !== "EXECUTION_EVIDENCE" || (status !== "CONFIRMED" && status !== "PARTIAL")) return text;
  const dated = latestDate(evidence.filter((e) => e.relation === "SUPPORTS"));
  const note =
    dated && dated.label !== "Checked"
      ? `The supporting evidence is dated ${dated.value}: it shows that execution had happened by then, not that it continues now.`
      : "The supporting evidence carries no date of its own: it shows that execution happened, not that it continues now.";
  return `${text} ${note}`;
}

// The reading itself, then why it cannot answer the row.
function levelOnlyText(evidence: EvidenceCard[]): string {
  const reading = evidence.find((e) => e.relation === "SUPPORTS")?.proves;
  const fact = reading && firstSentence(reading).length <= MAX_ESTABLISHED ? firstSentence(reading) : null;
  return fact ? `${fact} ${LEVEL_READING_LIMIT}` : LEVEL_READING_LIMIT;
}

export interface SurfaceInput {
  jobId: string | null;
  ticker: string | null;
  // The user's question, for the mechanism noun the row labels use.
  question: string | null;
  components: readonly LadderComponentInput[];
  questionFindings:
    | readonly { label: string; patternStep: number; component: string; supportingComponents: string[] }[]
    | null
    | undefined;
  evidence: readonly (EvidenceLike & {
    links: readonly { component: string; role: "SUPPORTING" | "CONTRADICTING" | "EXCLUDED"; exclusionReason: string | null }[];
  })[];
  quantities: readonly QuantityLike[];
  boundary: ProofBoundaryView | null | undefined;
  // The lifecycle's latest trusted stated state, when the assembly has one.
  latestStatedState?: LatestStatedState | null;
}

// THE ROWS THE QUESTION TURNS ON. Where the question projection resolved,
// its named rows (primary) plus the rows it leans on (supporting); where
// none did, every assessed row of the Pattern ladder. Always in proof-path
// order, never every Pattern component by reflex.
export function buildResearchTable(input: SurfaceInput): ResearchTableRow[] {
  const classesByComponent: Record<string, string[]> = {};
  const admittedByComponent: Record<string, { e: SurfaceInput["evidence"][number]; relation: EvidenceCard["relation"] }[]> = {};
  for (const e of input.evidence) {
    for (const link of e.links) {
      if (link.role === "EXCLUDED") continue;
      const list = (admittedByComponent[link.component] ??= []);
      if (list.some((x) => x.e.id === e.id)) continue;
      list.push({ e, relation: link.role === "CONTRADICTING" ? "CONTRADICTS" : "SUPPORTS" });
      if (e.sourceClass) {
        const classes = (classesByComponent[link.component] ??= []);
        if (!classes.includes(e.sourceClass)) classes.push(e.sourceClass);
      }
    }
  }
  const quantityByEvidence = new Map(input.quantities.map((q) => [q.evidenceId, q]));
  const kindByEvidence = new Map(input.evidence.map((e) => [e.id, e.onchainFactKind ?? null]));
  const evidenceById = new Map<string, EvidenceLike>(input.evidence.map((e) => [e.id, e]));
  const latestStated = input.latestStatedState ?? null;

  const ladder = deriveResultLadder(input.components, classesByComponent);
  const ladderRows = new Map([...ladder.mechanism, ...ladder.value].map((r) => [r.component, r]));
  const selected = new Map<string, { row: ResultRow; kind: ResearchTableRow["kind"]; restsOn: string[] }>();
  const findings = input.questionFindings ?? [];
  const noun = mechanismNounOf([input.question, ...findings.map((f) => f.label)]);
  if (findings.length > 0) {
    for (const r of deriveQuestionFindings(findings, input.components, classesByComponent)) {
      const own = findings.find((f) => f.component === r.component);
      selected.set(r.component, { row: r, kind: "PRIMARY", restsOn: own?.supportingComponents ?? [] });
    }
    for (const c of REALITY_COMPONENTS) {
      if (selected.has(c)) continue;
      const row = ladderRows.get(c);
      if (row) selected.set(c, { row, kind: "REALITY", restsOn: [] });
    }
    for (const f of findings) {
      for (const c of f.supportingComponents) {
        if (selected.has(c)) continue;
        const row = ladderRows.get(c);
        if (row) selected.set(c, { row, kind: "SUPPORTING", restsOn: [] });
      }
    }
  } else {
    for (const [c, row] of ladderRows) selected.set(c, { row, kind: "PRIMARY", restsOn: [] });
  }

  const rows: ResearchTableRow[] = [];
  for (const [component, { row, kind, restsOn }] of selected) {
    const persistedStatus = resultStatus(row.state);
    if (persistedStatus === null) continue;
    const persisted = input.components.find((c) => c.component === component);
    const ceiling = persistedStatus === "CONFIRMED" || persistedStatus === "PARTIAL"
      ? surfaceCeilingOf(component, persisted?.status ?? "", persisted?.supportingEvidenceIds, quantityByEvidence, kindByEvidence, evidenceById)
      : null;
    const levelOnly = ceiling === "LEVEL_ONLY";
    const burnOnly = ceiling === "BURN_ONLY";
    const stateUnstated = ceiling === "STATE_UNSTATED";
    const dateUntrusted = ceiling === "DATE_UNTRUSTED";
    const status: ResultStatus = ceiling !== null ? "NOT_ESTABLISHED" : persistedStatus;
    const evidence = (admittedByComponent[component] ?? []).map(({ e, relation }) =>
      evidenceCard(e, relation, { jobId: input.jobId, quantity: quantityByEvidence.get(e.id) ?? null, ticker: input.ticker, component }),
    );
    const boundary = status === "NOT_ESTABLISHED" && !levelOnly && !burnOnly && !stateUnstated && !dateUntrusted
      ? boundaryOf({ component, reasonCodes: persisted?.reasonCodes, coverage: row.coverage, boundary: input.boundary })
      : null;
    const claimNotShown =
      status === "PARTIAL" && (persisted?.reasonCodes ?? []).some((c) => typeof c === "string" && CLAIM_NOT_SHOWN_CODES.has(c));
    const statedStop =
      CURRENT_CLAIM_COMPONENTS.has(component) && (status === "CONFIRMED" || status === "PARTIAL")
        ? statedStopOf((persisted?.supportingEvidenceIds ?? []).map((id) => evidenceById.get(id)).filter((e): e is EvidenceLike => !!e))
        : null;
    const strongestClass = SOURCE_PRECEDENCE.find((cls) => evidence.some((e) => e.sourceClass === sourceClassLabel(cls)));
    const strongest = strongestClass ? evidence.find((e) => e.sourceClass === sourceClassLabel(strongestClass)) ?? null : evidence[0] ?? null;
    // The question projection's own words for the rows it named; a
    // question in the reader's words for every other row. A projection
    // label the semantic-envelope guard refused has already degraded to
    // the Pattern's claim label (`safeClaimLabel`); that label is the
    // engine's noun, so it too falls back to the reader's question.
    const label = kind === "PRIMARY" && findings.length > 0 && row.label !== componentClaimLabel(component)
      ? row.label
      : questionLabelFor(component, noun);
    rows.push({
      component,
      label,
      status,
      statusLabel: RESULT_STATUS_LABELS[status],
      tone: statusTone(status),
      established: levelOnly
        ? levelOnlyText(evidence)
        : burnOnly
          ? BURN_EVENT_ONLY_LIMIT
          : stateUnstated
            ? STATE_UNSTATED_LIMIT
            : dateUntrusted
              ? DATE_UNTRUSTED_LIMIT
              : withCurrentStateNote(
                  component,
                  status,
                  statedStop,
                  latestStated,
                  withExecutionTimeNote(component, status, establishedText(row, evidence, boundary), evidence),
                ),
      boundary,
      ...(claimNotShown ? { claimNotShown: true as const } : {}),
      ...(statedStop ? { statedStop } : {}),
      source: strongest ? { kind: strongest.sourceClass, name: strongest.sourceName } : null,
      date: latestDate(evidence),
      evidence,
      primary: kind === "PRIMARY",
      kind,
      restsOn: [],
      row,
    });
    void restsOn;
  }
  rows.sort((a, b) => pathIndex(a.component) - pathIndex(b.component));
  // A supporting check that is NOT confirmed is promoted: contradicted,
  // blocked or uncertain, it would conceal a material limitation folded
  // under another row. A confirmed supporting check folds under the FIRST
  // primary row that leans on it, as the thing it settles — a reader sees
  // it, and sees it once.
  for (const r of rows) if (r.kind === "SUPPORTING" && r.status !== "CONFIRMED") r.kind = "PROMOTED";
  const byComponent = new Map(rows.map((r) => [r.component, r]));
  const folded = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "PRIMARY") continue;
    for (const c of selected.get(r.component)?.restsOn ?? []) {
      const dep = byComponent.get(c);
      if (!dep || dep.kind !== "SUPPORTING" || folded.has(c)) continue;
      folded.add(c);
      r.restsOn.push({ component: c, label: questionLabelFor(c, noun), phrase: dep.statedStop ? stopStatePhrase(dep.statedStop, noun) : statementPhraseFor(c, noun), status: dep.status, statusLabel: dep.statusLabel, tone: dep.tone });
    }
    r.restsOn.sort((a, b) => pathIndex(a.component) - pathIndex(b.component));
  }
  return rows;
}

// The rows the table shows: a supporting check folds under the finding
// that leans on it; everything else is a row. The proof map shows all.
export function tableRows(rows: readonly ResearchTableRow[]): ResearchTableRow[] {
  return rows.filter((r) => r.kind !== "SUPPORTING");
}

// THE SOURCES SECTION'S ONE SENTENCE PER SOURCE: what this source tells
// us, in the row's own terms — the engine's persisted reading, a chain
// observation translated. Never a disclaimer.
export function sourceSentence(card: EvidenceCard): string {
  return card.onchain ? card.onchain.observation : card.proves;
}

// The most recent publication date among the row's admitted evidence; the
// most recent observation otherwise; the most recent read otherwise.
function latestDate(cards: readonly EvidenceCard[]): EvidenceCard["date"] {
  for (const label of ["Published", "Observed", "Checked"] as const) {
    const dates = cards.map((c) => c.date).filter((d): d is NonNullable<EvidenceCard["date"]> => d !== null && d.label === label);
    if (dates.length === 0) continue;
    return dates.reduce((best, d) => (Date.parse(d.iso) > Date.parse(best.iso) ? d : best));
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 6. THE PROOF MAP — THE CHAIN, ONE STATUS PER NODE
 * ------------------------------------------------------------------ */

export interface ProofNode {
  component: string;
  label: string;
  status: ResultStatus;
  statusLabel: string;
  tone: VerdictTone;
  sourceKind: string | null;
}

export function proofChain(rows: readonly ResearchTableRow[]): ProofNode[] {
  return [...rows]
    .sort((a, b) => pathIndex(a.component) - pathIndex(b.component))
    .map((r) => ({
      component: r.component,
      label: r.label,
      status: r.status,
      statusLabel: r.statusLabel,
      tone: r.tone,
      sourceKind: r.source?.kind ?? null,
    }));
}

/* ------------------------------------------------------------------ *
 * 7. KEY EVIDENCE — THE FEW PIECES A READER NEEDS FIRST
 * ------------------------------------------------------------------ */

export const MAX_KEY_EVIDENCE_CARDS = 5;

// Order: contradicting first (the one thing a reader must not miss), then
// what the Proof itself cites, then on-chain readings (protocol-native
// records outrank documents where both were admitted), then the other
// supporting evidence in proof-path order. One card per document; capped.
// Nothing excluded can reach this — the rows only ever carry admitted
// links.
export function keyEvidence(
  rows: readonly ResearchTableRow[],
  citedIds: ReadonlySet<string>,
  max = MAX_KEY_EVIDENCE_CARDS,
): EvidenceCard[] {
  const out: EvidenceCard[] = [];
  const seenIds = new Set<string>();
  const seenDocs = new Set<string>();
  const push = (c: EvidenceCard) => {
    if (out.length >= max || seenIds.has(c.id)) return;
    const doc = canonicalDocumentKey(c.url);
    if (seenDocs.has(doc)) return;
    seenIds.add(c.id);
    seenDocs.add(doc);
    out.push(c);
  };
  const ordered = [...rows].sort((a, b) => pathIndex(a.component) - pathIndex(b.component));
  for (const r of ordered) for (const c of r.evidence) if (c.relation === "CONTRADICTS") push(c);
  for (const r of ordered) for (const c of r.evidence) if (citedIds.has(c.id)) push(c);
  for (const r of ordered) for (const c of r.evidence) if (c.onchain) push(c);
  for (const r of ordered) for (const c of r.evidence) push(c);
  return out;
}

/* ------------------------------------------------------------------ *
 * 8. THE BOUNDARY SECTION — ONE COMPACT BLOCK, THREE KINDS
 * ------------------------------------------------------------------ */

export interface BoundaryGroup {
  kind: BoundaryKind;
  copy: string;
  never: string;
  // A persisted reason every row of the group shares, stated once.
  sharedDetail: string | null;
  items: { component: string; label: string; detail: string | null }[];
  // Known evidence paths still open, summed over the group's rows.
  remainingPaths: number | null;
}

// WHAT REMAINS UNCLEAR — ONLY WHERE IT ADDS INFORMATION. A row already
// says what was not established and, for a substantive gap, why; repeating
// that here would be the same sentence twice. What a row cannot explain is
// the RESEARCH BOUNDARY: that the run hit its configured limit with known
// sources unread, or that ATLAS has no supported route for this project.
// Those two kinds are listed, grouped, once. A contradicted row is a
// finding and is never listed; a substantive gap is not.
export function boundaryGroups(rows: readonly ResearchTableRow[]): BoundaryGroup[] {
  const order: BoundaryKind[] = ["TECHNICAL", "CONFIGURATION"];
  const groups: BoundaryGroup[] = [];
  for (const kind of order) {
    const members = rows.filter((r) => r.status === "NOT_ESTABLISHED" && (r.boundary?.kind ?? "SUBSTANTIVE") === kind);
    if (members.length === 0) continue;
    const remaining = members.reduce<number | null>((n, r) => {
      const v = r.boundary?.remainingPaths ?? null;
      return v === null ? n : (n ?? 0) + v;
    }, null);
    // The persisted reason, only where it adds to the group's sentence: a
    // substantive row's own reason; nothing for a technical or
    // configuration row, whose whole explanation IS the kind. A reason
    // every row shares is said once for the group, never once per row.
    const details = members.map((r) => (kind === "SUBSTANTIVE" && r.row.reason ? r.row.reason : null));
    const shared = members.length > 1 && details[0] !== null && details.every((d) => d === details[0]) ? details[0] : null;
    groups.push({
      kind,
      copy: BOUNDARY_COPY[kind],
      never: BOUNDARY_NEVER[kind],
      sharedDetail: shared,
      items: members.map((r, i) => ({
        component: r.component,
        label: r.label,
        detail: shared ? null : details[i],
      })),
      remainingPaths: remaining,
    });
  }
  return groups;
}

/* ------------------------------------------------------------------ *
 * 9. THE ANSWER — TWO TO FOUR SENTENCES
 * ------------------------------------------------------------------ */

export interface SurfaceAnswer {
  sentences: string[];
  // The verdict's own confidence, shown only where a verdict exists.
  confidenceLabel: string | null;
}

const CONFIDENCE_WORDS: Record<string, string> = {
  LOW: "Low",
  LIMITED: "Limited",
  STRONG: "Strong",
  VERY_STRONG: "Very strong",
};

function joinPhrases(items: readonly string[], last = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}


// THE ANSWER — TWO TO FOUR SENTENCES IN THE PROJECT'S TERMS, TYPED.
//
// No evidence text reaches this paragraph: a sentence at the top of a
// result reads as ATLAS's own conclusion, so every clause here is a
// persisted status or reason code rendered through the same question
// phrases the rows use. What it says, in order: what the evidence points
// against, what the sources confirm, what there is evidence for but is
// not fully confirmed (and exactly why), what the available evidence does
// not show — and, only where the run rather than the record is the limit,
// that boundary, in words that keep a research limit, a missing source
// route and an evidence gap distinct. The subject of every sentence is
// the evidence, never ATLAS. Nothing is manufactured; nothing is
// stronger than a row beneath it.
export function surfaceAnswer(input: {
  outcomeKind: OutcomeKind;
  verdict: string | null;
  confidenceBand: string | null;
  projectName: string | null;
  components: readonly { component: string; status: string }[];
  rows: readonly ResearchTableRow[];
  question: string | null;
}): SurfaceAnswer {
  const confidenceLabel = input.outcomeKind === "VERDICT" && input.confidenceBand ? (CONFIDENCE_WORDS[input.confidenceBand] ?? null) : null;
  // A run that did not end in a verdict keeps the settled wording for that
  // state — the state of the run is the whole answer there.
  if (input.outcomeKind !== "VERDICT") {
    return {
      sentences: researchAnswer({
        verdict: input.verdict,
        outcomeKind: input.outcomeKind,
        projectName: input.projectName,
        components: [...input.components],
      }).slice(0, 4),
      confidenceLabel,
    };
  }
  const rows = [...input.rows].sort((a, b) => pathIndex(a.component) - pathIndex(b.component));
  const noun = mechanismNounOf([input.question, ...rows.filter((r) => r.primary).map((r) => r.label)]);
  // A current state established as a stop is said as that stop, never as
  // "happening now".
  const phrase = (r: ResearchTableRow) =>
    r.statedStop ? stopStatePhrase(r.statedStop, noun) : statementPhraseFor(r.component, noun);
  const by = (status: ResultStatus) => rows.filter((r) => r.status === status);
  const sentences: string[] = [];

  const contradicted = by("CONTRADICTED");
  if (contradicted.length > 0) {
    sentences.push(`On ${joinPhrases(contradicted.map(phrase).slice(0, 2))}, the evidence points the other way.`);
  }
  const confirmed = by("CONFIRMED");
  if (confirmed.length > 0) {
    sentences.push(`The sources confirm ${joinPhrases(confirmed.map(phrase).slice(0, 4))}.`);
  }
  // "There is evidence that <claim>" only for a partial row whose claim the
  // evidence actually bears on; one whose reason says the claim itself is
  // not shown is said with what the evidence does not show.
  const partial = by("PARTIAL").filter((r) => !r.claimNotShown);
  if (partial.length > 0) {
    const lead = partial[0];
    const gap = lead.row.reason ? ` ${lead.row.reason}` : "";
    sentences.push(`There is evidence ${joinPhrases(partial.map(phrase).slice(0, 2))}, but it is not fully confirmed.${gap}`);
  }
  const open = rows.filter((r) => r.status === "NOT_ESTABLISHED" || (r.status === "PARTIAL" && r.claimNotShown));
  if (open.length > 0) {
    const kinds = new Set(open.map((r) => r.boundary?.kind ?? "SUBSTANTIVE"));
    const what = `The available evidence does not show ${joinPhrases(open.map(phrase).slice(0, 3), "or")}.`;
    if (kinds.has("TECHNICAL")) {
      sentences.push(`${what} The research limit was reached before all relevant sources could be checked.`);
    } else if (kinds.has("CONFIGURATION")) {
      sentences.push(`${what} ATLAS currently lacks a source route that can independently verify this for ${input.projectName ?? "this project"}.`);
    } else {
      sentences.push(what);
    }
  }
  if (sentences.length === 0) {
    sentences.push(`This research finished without a finding it could state about ${input.projectName ?? "this project"}.`);
  }
  return { sentences: sentences.slice(0, 4), confidenceLabel };
}

/* ------------------------------------------------------------------ *
 * 10. THE WHOLE SURFACE, FROM THE DETAIL PAYLOAD
 * ------------------------------------------------------------------ */

export interface ResultSurface {
  outcomeKind: OutcomeKind;
  verdict: string | null;
  answer: SurfaceAnswer;
  // When the evidence was checked (the run's finish), and the most recent
  // publication date among the admitted evidence.
  checkedOn: string | null;
  latestEvidence: EvidenceCard["date"];
  table: ResearchTableRow[];
  chain: ProofNode[];
  keyEvidence: EvidenceCard[];
  boundary: BoundaryGroup[];
  // Whether the Proof carried its own boundary record. False on a Proof
  // written before the record existed; the boundary is then read from
  // reason codes and coverage and says so nowhere on the surface.
  boundaryFromRecord: boolean;
}

export function buildResultSurface(detail: ResearchJobDetail): ResultSurface {
  const outcome = jobOutcome({ state: detail.job.state as JobState, verdict: detail.proof?.verdict ?? null });
  const components: LadderComponentInput[] = detail.components.map((c) => ({
    component: c.component,
    status: c.status,
    reasonCodes: c.reasonCodes,
    supportingEvidenceIds: c.supportingEvidenceIds,
    contradictingEvidenceIds: c.contradictingEvidenceIds,
    excludedEvidence: c.excludedEvidence,
    coverage: c.coverage,
  }));
  const snapshotIds = new Set(detail.snapshotEvidenceIds);
  const quantityByEvidence = new Map(detail.quantities.map((q) => [q.evidenceId, q]));
  const kindByEvidence = new Map(detail.evidence.map((e) => [e.id, e.onchainFactKind ?? null]));
  const evidenceById = new Map<string, EvidenceLike>(detail.evidence.map((e) => [e.id, e]));
  const answerStatusOf = (c: ResearchJobDetail["components"][number]): string => {
    if (surfaceCeilingOf(c.component, c.status, c.supportingEvidenceIds, quantityByEvidence, kindByEvidence, evidenceById) !== null) return "INSUFFICIENT_EVIDENCE";
    const claimNotShown =
      c.status === "PARTIALLY_SUPPORTED" && (c.reasonCodes ?? []).some((x) => typeof x === "string" && CLAIM_NOT_SHOWN_CODES.has(x));
    return claimNotShown ? "INSUFFICIENT_EVIDENCE" : c.status;
  };
  const table = buildResearchTable({
    jobId: detail.job.id,
    ticker: detail.job.projectTicker,
    question: detail.job.originalQuestion,
    components,
    questionFindings: detail.questionFindings,
    evidence: detail.evidence.map((e) => ({ ...e, hasSnapshot: snapshotIds.has(e.id) })),
    quantities: detail.quantities,
    boundary: detail.proof?.boundedBy ?? null,
    latestStatedState: latestStatedStateOf(detail.mechanism?.flows),
  });
  const cited = new Set((detail.proof?.citations ?? []).map((c) => c.evidenceId));
  const cards = keyEvidence(table, cited);
  return {
    outcomeKind: outcome.kind,
    verdict: outcome.verdict,
    answer: surfaceAnswer({
      outcomeKind: outcome.kind,
      verdict: outcome.verdict,
      confidenceBand: detail.proof?.confidence.band ?? null,
      projectName: detail.job.projectName,
      // The non-verdict answer reads statuses directly, so it gets the same
      // ceiling the table applies: never "partly confirmed" off a lone
      // level reading, burn events only, or a claim its reason says is not
      // shown.
      components: detail.components.map((c) => ({ component: c.component, status: answerStatusOf(c) })),
      rows: table,
      question: detail.job.originalQuestion,
    }),
    checkedOn: retrievedOn(detail.job.finishedAt),
    latestEvidence: latestDate(table.flatMap((r) => r.evidence)),
    table,
    chain: proofChain(table),
    keyEvidence: cards,
    boundary: outcome.kind === "VERDICT" ? boundaryGroups(table) : [],
    boundaryFromRecord: detail.proof?.boundedBy !== null && detail.proof?.boundedBy !== undefined,
  };
}

/* ------------------------------------------------------------------ *
 * 11. WHAT MUST NEVER REACH THE FIRST SCREEN
 * ------------------------------------------------------------------ */

// Engine vocabulary the rendered surface is scanned for in tests. Any of
// these on screen is a leak, whatever the sentence around it.
export const FORBIDDEN_SURFACE_TOKENS: readonly string[] = [
  "ATLAS established",
  "could not establish",
  "Partially established",
  "partially established",
  "mechanism established",
  "Current state",
  "Destination",
  "S5",
  "S6",
  "S7",
  "S8",
  "recovery",
  "attempt",
  "route ledger",
  "extraction",
  "WORK_QUEUE_EXHAUSTED",
  "SEARCH_BUDGET_EXHAUSTED",
  "RECOVERY_BOUND_REACHED",
  "KNOWN_PATHS_UNEXPLORED",
  "NO_ADMISSIBLE_ROUTE",
  "ALL_EVIDENCE_EXCLUDED",
  "INSUFFICIENT_EVIDENCE",
  "PARTIALLY_SUPPORTED",
  "NO_EVIDENCE_FOUND",
  "amountRaw",
  "Partly established",
  "Still open",
  "Partially created",
  "Could not verify",
  "Source of value",
  "Flow path",
  "Mechanism spec",
  "Governance basis",
  "Net effect",
  "Durability basis",
  // The Pattern ladder's claim labels — the engine's nouns, never a
  // reader's question. A refused projection label degrades to one of
  // these; the surface must turn it back into a question.
  "Where the value comes from",
  "The path the value takes",
  "Where the value is meant to go",
  "Who receives it",
  "Effect on token supply",
  "How durable the arrangement is",
];
