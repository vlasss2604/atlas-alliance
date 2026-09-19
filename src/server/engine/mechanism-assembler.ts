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
  // D-158 PHASE 2 — a REQUIRED structural obligation is unmet. A genuine
  // basis for partial support: the component has admissible documentary
  // evidence and lacks machine-owned causal provenance, which is a stated
  // limitation of the node rather than an unexplained downgrade.
  | "MECHANICAL_PROVENANCE_NOT_ESTABLISHED"
  | "INSUFFICIENT_AUTHORITY"
  | "INDIRECT_ONLY"
  | "STATE_NOT_FULLY_LIVE"
  // GOVERNANCE LIFECYCLE SAFETY V1 — genuine bases for partial support: the
  // component has admissible evidence that describes a proposal (or, for
  // GOVERNANCE_BASIS, no approval-bearing state), a stated limitation of
  // the node rather than an unexplained downgrade. Neither is read by
  // computeLifecycle: a proposal never moves a flow toward CURRENT.
  | "PROPOSED_STATE_ONLY"
  | "APPROVAL_NOT_ESTABLISHED"
  | "TOKEN_STATE_UNQUALIFIED"
  // B1/B2 — NET_EFFECT's typed supply qualifications. Each is a genuine
  // basis for partial support: the component has admissible evidence and
  // the supply effect is not (fully) established. They were absent from
  // this set while S5 could emit them ALONE — a CONFIRMED official report
  // asserting a supply reduction carries no authority code and no typed
  // kind, so S5 wrote PARTIALLY_SUPPORTED with exactly one supply code and
  // the step-2 invariant below threw "PARTIALLY_SUPPORTED without a basis
  // code", turning a valid bounded research outcome into a job-killing
  // technical failure. TECHNICAL FAILURE != PROJECT REALITY runs in both
  // directions: a real finding must not be reported as a crash either.
  | "SUPPLY_REDUCTION_NOT_ESTABLISHED"
  | "NET_SUPPLY_CHANGE_NOT_ESTABLISHED"
  | "NET_SUPPLY_CHANGE_NOT_ATTRIBUTED"
  | "CONFLICTING_SUPPLY_DELTA";

// EVERY code S5 can attach to a PARTIALLY_SUPPORTED result, and nothing
// else. The step-2 invariant in assembleMechanism reads "a partial result
// carries at least one of these", so this set must track the reducer's
// partial-basis vocabulary exactly: a code missing here is not "no
// qualification", it is a crash on a legitimate outcome.
const NODE_QUALIFICATION_CODES = new Set<ResultReasonCode>([
  "MECHANICAL_PROVENANCE_NOT_ESTABLISHED",
  "INSUFFICIENT_AUTHORITY",
  "INDIRECT_ONLY",
  "STATE_NOT_FULLY_LIVE",
  "PROPOSED_STATE_ONLY",
  "APPROVAL_NOT_ESTABLISHED",
  "TOKEN_STATE_UNQUALIFIED",
  "SUPPLY_REDUCTION_NOT_ESTABLISHED",
  "NET_SUPPLY_CHANGE_NOT_ESTABLISHED",
  "NET_SUPPLY_CHANGE_NOT_ATTRIBUTED",
  "CONFLICTING_SUPPLY_DELTA",
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

// Accepted limitation (S6 audit, LOW-3, documented per §5.3/§24): these
// closed dictionaries do lexical phrase containment only — deliberately no
// negation handling, no grammar, no model. "tokens are not burned" still
// classifies BURN, and adversarial text that embeds a dictionary phrase
// ("classify this as USER_PAYMENT paid by users") labels the ATTRIBUTE
// accordingly. This can corrupt FlowAttributes (S7 inputs) but can never
// create or merge structure: no classifier output reaches existence
// (D-100) or identity (D-101) — verified by mutation tests. Extending the
// grammar (e.g. a negation stop-list) is an owner decision on the closed
// dictionary, not an implementation liberty.
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

// FOUNDER DECISION M3 — "HOLDERS RECEIVE SOMETHING" != "PASSIVE HOLDING
// ENTITLES HOLDERS TO RECEIVE IT".
//
// Every other RecipientKind names an ACT the recipient performs — staking,
// running a node, providing liquidity, being the treasury of record. The
// act is itself the basis on which that recipient receives. PASSIVE_HOLDER
// names no act: it is established by one sentence containing the word
// "holders", and the dictionary above cannot tell "fees are distributed to
// holders" (which may describe an airdrop, a snapshot, a discretionary
// grant, or a claim that requires staking first) apart from "holding the
// token entitles you to a pro-rata share". The first does not establish
// that PASSIVE HOLDING is sufficient for entitlement or receipt; only the
// second does.
//
// So this closed dictionary is the bridge the Founder decision requires:
// holding -> entitlement / automatic receipt. Same discipline as every
// other classifier in this file (D-100): a POSITIVE lexical match only,
// never an inference from absence, never a model. No match is not a
// contradiction — it is an unresolved bridge, and buildFlow records it as
// a positioned RECIPIENT_UNRESOLVED gap on an ESTABLISHED recipient,
// exactly as an established DESTINATION of unrecognised kind is recorded.
//
// Deliberately narrow: phrases that state entitlement ("entitled to"),
// proportionality to the holding ("pro rata", "per token held"), or
// receipt conditioned on holding alone ("by holding", "accrues to
// holders"). A bare "distributed to holders" is NOT here — it is the very
// sentence the decision says is insufficient. The classifier reads only
// the RECIPIENT component's own admitted text, so the entitlement must be
// stated by the evidence that establishes who receives; a false negative
// costs PARTIAL, which is the safe direction.
const HOLDER_ENTITLEMENT_PHRASES = [
  "entitled to",
  "entitles",
  "entitlement",
  "pro rata",
  "in proportion to",
  "proportional to",
  "per token held",
  "for each token held",
  "by holding",
  "for holding",
  "accrue to holders",
  "accrues to holders",
  "accrued to holders",
  "automatically distributed to holders",
  "automatically to holders",
  "claimable by holders",
  "redeemable by holders",
  "no action required",
];

// FOUNDER REVIEW OF ROUND 8 — EXPLICIT NEGATION IS NOT A POSITIVE BRIDGE.
//
// The approved M3 rule is that POSITIVE entitlement or receipt must be
// established. "Holders are NOT entitled to any share" is the denial of
// exactly the proposition the dictionary above looks for, so reading it as
// the bridge does not merely fail to help — it asserts the opposite of the
// evidence. That is not the accepted H3 limitation ("not burned" -> BURN
// classifies a KIND that is genuinely discussed); it is the one place where
// the polarity of the sentence IS the fact being classified.
//
// The smallest rule that fixes it, and nothing more: a closed negator list,
// scoped so that a denial about something else cannot suppress a real
// statement about holders. Two bounds, both local to this one classifier:
//
//   CLAUSE   — the text is cut at sentence/clause terminators, and a clause
//              must carry the WHOLE bridge: it must name holders itself AND
//              state the entitlement. "Holders receive the fees; the
//              protocol is entitled to a pro rata share" is two clauses
//              about two actors, and establishes nothing — the same rule
//              that stopped two ROWS composing into a bridge, applied at
//              the granularity where the same composition is still
//              possible inside one row. Commas are deliberately NOT
//              terminators: "token holders, who hold the token, are
//              entitled to a pro rata share" is one statement.
//   WINDOW   — within that clause, only the NEGATOR_WINDOW tokens
//              immediately before the matched phrase are read. So "no fee
//              is charged and holders are entitled to a pro rata share"
//              still establishes the bridge, while "holders shall not,
//              under any circumstances, be entitled to fees" does not.
//
// No grammar, no parser, no model: one closed word list and two positional
// bounds. Every rejection costs PARTIAL, which is the safe direction.
const HOLDER_ENTITLEMENT_NEGATORS = new Set([
  "not",
  "no",
  "never",
  "without",
  "none",
  "nor",
  "neither",
  "cannot",
  "excluded",
  "ineligible",
  "nothing",
]);
const NEGATOR_WINDOW = 6;

// FOUNDER DECISION I4 — UNCERTAIN, PROPOSED OR CONDITIONAL IS NOT POSITIVE.
//
// "Holders MAY be entitled", "PROPOSED entitlement", "WOULD be entitled IF
// the vote passes", "EXPECTED to become entitled" — each of these is the
// same sentence as the bridge with its actuality removed. The approved M3
// rule asks for POSITIVE entitlement or receipt, and language that
// explicitly leaves the entitlement possible, planned or conditional does
// not supply it.
//
// Same bounded philosophy as the negators above: a small closed list of
// explicit non-actuality markers, read only inside the matched phrase's own
// clause. NOT a tense parser and not a grammar — this cannot and does not
// try to decide what tense a sentence is in.
//
// "WILL" IS DELIBERATELY ABSENT, and so is "can". "Holders will be entitled
// to a pro rata share" describes a scheduled mechanism, not an uncertain
// one; whether that mechanism is current or executing is what
// mechanism_state and the lifecycle machinery already decide, and this
// classifier must not quietly take that decision over. Only language that
// explicitly marks the entitlement as uncertain, proposed, conditional or
// merely possible is refused.
const HOLDER_ENTITLEMENT_NON_ACTUALITY = new Set([
  // possibility
  "may",
  "might",
  "could",
  "possible",
  "possibly",
  "potential",
  "potentially",
  "prospective",
  // conditionality
  "would",
  "should",
  "contingent",
  "subject",
  "conditional",
  // intention, not fact
  "proposed",
  "proposal",
  "plan",
  "plans",
  "planned",
  "intend",
  "intends",
  "intended",
  "expect",
  "expects",
  "expected",
  "anticipate",
  "anticipates",
  "anticipated",
  // not yet
  "pending",
  "tentative",
  "draft",
  "eventually",
]);
// Non-actuality is read on BOTH sides of the matched phrase, within the same
// bounded window: a negator precedes what it denies ("not entitled"), but a
// condition may follow what it qualifies ("entitled ... subject to a vote").
// Wider than the negator window: a negator sits immediately on what it
// denies ("not entitled"), while an intention or condition often opens the
// clause ("the protocol PLANS to entitle holders to a pro rata share").
// Deliberately conservative — an unresolved bridge costs PARTIAL, and a
// clause that does contain explicit proposal language is refused even when
// a reader could tell the proposal had already passed. ATLAS represents
// governance approval structurally (GOVERNANCE_BASIS, mechanism_state
// APPROVED), so nothing real rests on reading it out of prose.
const NON_ACTUALITY_WINDOW = 10;
// Sentence and clause terminators. A comma is not one — see above.
const CLAUSE_TERMINATORS = /[.;:!?\n\r]+/;

// Every start index at which `phrase` occurs in `tokens`.
function phraseOccurrences(tokens: string[], phrase: string): number[] {
  const phraseTokens = tokenizeForClassifier(phrase);
  const out: number[] = [];
  outer: for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

function negatedAt(tokens: string[], start: number): boolean {
  for (let k = Math.max(0, start - NEGATOR_WINDOW); k < start; k++) {
    if (HOLDER_ENTITLEMENT_NEGATORS.has(tokens[k])) return true;
  }
  return false;
}

function nonActualAt(tokens: string[], start: number, length: number): boolean {
  const from = Math.max(0, start - NON_ACTUALITY_WINDOW);
  const to = Math.min(tokens.length, start + length + NON_ACTUALITY_WINDOW);
  for (let k = from; k < to; k++) {
    if (k >= start && k < start + length) continue; // the phrase itself
    if (HOLDER_ENTITLEMENT_NON_ACTUALITY.has(tokens[k])) return true;
  }
  return false;
}

export function classifyHolderEntitlement(text: string): boolean {
  for (const clause of text.split(CLAUSE_TERMINATORS)) {
    const tokens = tokenizeForClassifier(clause);
    if (tokens.length === 0) continue;
    // The clause must be about holders on its own — the bridge is a claim
    // about holders, so the actor and the entitlement are one statement.
    if (classifyRecipientKind(clause) !== "PASSIVE_HOLDER") continue;
    // A CLAUSE IS JUDGED AS ONE ASSERTION. Several dictionary phrases can
    // match inside one clause — "may in future be ENTITLED TO a PRO RATA
    // share" matches twice — and the marker that defeats one of them sits
    // outside the other's window. Taking the first clean match would let
    // the clause through on its own second half. So the clause establishes
    // the bridge only when it has a clean match AND no defeated one:
    // whatever made one occurrence uncertain or denied made the clause
    // uncertain or denied.
    let clean = 0;
    let defeated = 0;
    for (const phrase of HOLDER_ENTITLEMENT_PHRASES) {
      const length = tokenizeForClassifier(phrase).length;
      for (const start of phraseOccurrences(tokens, phrase)) {
        if (negatedAt(tokens, start) || nonActualAt(tokens, start, length)) defeated += 1;
        else clean += 1;
      }
    }
    if (clean > 0 && defeated === 0) return true;
  }
  return false;
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
// §8 (audit fix MEDIUM-2) — telling a fused token-state IDENTITY apart
// from a bare QUALIFIER inside S5's tokenStateMentions. S5's frozen
// detector (component-reconciler.ts, D-097 — read-only for S6) emits two
// mention shapes into one list: closed-list qualifier words ("locked",
// "staked", ...) and discovered fused identities ("vecrv", "stkaave",
// "steth"). The qualifier vocabulary below is a verbatim mirror of S5's
// frozen TOKEN_STATE_QUALIFIERS (not exported by the frozen module — do
// not edit one without the other); a mention is an identity when it has a
// fused prefix continuation and is NOT one of these words ("staked" and
// "vested" would otherwise false-match the st-/ve- prefixes).
const S5_TOKEN_STATE_QUALIFIER_WORDS = new Set([
  "ve",
  "vote-escrowed",
  "vote escrowed",
  "locked",
  "staked",
  "wrapped",
  "escrowed",
  "vested",
]);
const FUSED_IDENTITY_PATTERN = /^(?:ve|stk|st)[a-z0-9]+$/;

function isFusedTokenStateIdentity(mention: string): boolean {
  return FUSED_IDENTITY_PATTERN.test(mention) && !S5_TOKEN_STATE_QUALIFIER_WORDS.has(mention);
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
//
// Honesty note (S6 audit, LOW-1): within one invocation, `step`,
// `component` and `parentBranchPathHash` are CONSTANT across every
// candidate, and the accumulator Map below is local to the invocation —
// so the only input that actually distinguishes slots is
// structuralUnitKey. The real invariant that keeps sibling branches from
// colliding is per-invocation isolation: this function is called once per
// (lineage, step, component) with candidates already scoped to that
// lineage; candidates of sibling branches never share an accumulator. The
// full tuple is kept as contract-shaped defense-in-depth (D-101 names it),
// but a mutation removing the constant fields is undetectable by
// construction — do not claim mutation teeth for it.
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
  // S6 audit fix (HIGH-1/MEDIUM-1): only the sources of slots attached AT
  // or AFTER the fork point. The shared prefix's sources deliberately do
  // NOT live here — sharing provenance with the prefix is sharing it with
  // EVERY sibling branch equally, which discriminates nothing (§13.4:
  // "разделяет provenance с ЭТОЙ ветвью"). Before any fork this set is
  // unused: an unforked lineage accepts every admitted row.
  postForkSourceIds: Set<string>;
  gaps: MechanismGap[];
  branchAttributionUnresolved: Set<string>; // component names, for dedupe
}

function cloneLineage(l: WorkingLineage): WorkingLineage {
  return {
    lineage: [...l.lineage],
    branchSlotPath: [...l.branchSlotPath],
    branchPointStep: l.branchPointStep,
    postForkSourceIds: new Set(l.postForkSourceIds),
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
    { lineage: [], branchSlotPath: [], branchPointStep: null, postForkSourceIds: new Set(), gaps: [], branchAttributionUnresolved: new Set() },
  ];
  const unassignedGaps: MechanismGap[] = [];
  let enumerationCapPoint: { step: number; component: string } | null = null;

  for (let step = 1; step <= 8; step++) {
    const components = requiredComponentsForStepSafe(input.pattern, step);
    for (const component of components) {
      const key = `${step}:${component}`;
      const result = byKey.get(key);
      const next: WorkingLineage[] = [];

      // S6 audit fix (HIGH-1): branch attribution is decided against the
      // WHOLE current fork picture, not one lineage in isolation. A row
      // whose post-fork provenance is shared by MORE than one sibling
      // branch (or by none) is not deterministically attributable to any
      // single branch — attaching it to each passing branch multiplied
      // sibling branches into a cartesian product of "established" flows
      // that no Evidence ever asserted. Precompute, once per component,
      // how many forked lineages each admitted row's sourceId passes.
      const allRowsForComponent =
        result && (result.status === "SUPPORTED" || result.status === "PARTIALLY_SUPPORTED")
          ? resolveRows(result.supportingEvidenceIds, key)
          : [];
      const forkedLineages = active.filter((l) => l.branchPointStep !== null);
      const passCountByRowId = new Map<string, number>();
      if (forkedLineages.length > 0) {
        for (const row of allRowsForComponent) {
          let count = 0;
          for (const fl of forkedLineages) {
            if (fl.postForkSourceIds.has(row.sourceId)) count += 1;
          }
          passCountByRowId.set(row.id, count);
        }
      }

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
          // Audit NOTE-2: contradicting ids are provenance too — a
          // dangling contradicting reference is the same §21 п.5 failure
          // as a dangling supporting one.
          resolveRows(result.contradictingEvidenceIds, key);
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

        // SUPPORTED / PARTIALLY_SUPPORTED.
        const allRows = allRowsForComponent;
        if (allRows.length === 0) {
          // SUPPORTED/PARTIALLY_SUPPORTED with zero supportingEvidenceIds
          // is an impossible S5 state (§21 п.3) — S5 never emits SUPPORTED
          // without at least one supporting id.
          throw new MechanismAssemblyInvariantError(`${key} is ${result.status} with no supportingEvidenceIds`);
        }

        // §13.4, post-audit-fix semantics: once this lineage has forked,
        // a row attaches to it when the row's provenance singles this
        // branch out — it shares a post-fork sourceId with this branch and
        // with NO sibling branch. A row shared by several branches (the
        // whole-document case: one source describes the fork AND what
        // lies below it, so the source itself defines which branch each
        // of its rows belongs to and the assembler cannot read that) is
        // unattributable: BRANCH_ATTRIBUTION_UNRESOLVED, never an
        // attachment to every passing branch and never the cartesian fork
        // multiplication of audit HIGH-1.
        //
        // ROUND 6.5 (Founder decision 3) — MORE AGREEING ADMISSIBLE
        // EVIDENCE != WEAKER PROOF. A row that names NO branch — its source
        // shares nothing with the post-fork part of any branch (§13.4
        // outcome 3, and the prefix-only source of audit MEDIUM-1) — is
        // not evidence about the fork at all. An unforked lineage attaches
        // every admitted row of a component by Pattern structure alone;
        // Round 6 (F1c, F2c) proved that treating such a row as
        // unattributable let a SECOND agreeing official page at one
        // component turn every later component into
        // BRANCH_ATTRIBUTION_UNRESOLVED and the claim from PARTIAL to
        // UNSATISFIED, with no contradiction, no temporal, identity or
        // scope reason — only multiplicity. So a row that names no branch
        // continues the trunk on every branch, exactly as it would have
        // with one slot fewer; and because it distinguishes none of them
        // its source is NOT added to any branch's post-fork provenance
        // (below), so a later row from that source names no branch either.
        // Each branch's flow is what the unforked flow would have been with
        // that branch's slot; S7 is existential over flows, so the claim is
        // never stronger than the strongest single-slot world and never
        // weaker than the control. Rows a single source spans across the
        // fork keep outcome 2: a real ambiguity the source defines.
        const parentBranchPathHash = sha256Hex(canonicalize(l.lineage));
        let candidateRows: AssemblyEvidenceProjection[];
        let attributionUnresolved = false;
        if (l.branchPointStep === null) {
          candidateRows = allRows;
        } else {
          // ROUND 6.6 (Founder decision 1) — SHARED SOURCE != AUTOMATIC
          // ATTRIBUTION FAILURE. Rows a single source spans across the fork
          // (they pass this branch AND a sibling) are ambiguous only when
          // there is a PAIRING CHOICE to make: when, on this branch, they
          // form two or more slots — audit HIGH-1's shape, one document
          // describing both allocations and both destinations, where the
          // document's own structure decides the pairing and the assembler
          // cannot read it. One shared slot offers no choice: every branch
          // the source spans continues with the same element, exactly as
          // an unforked lineage would take it, and the branches stay
          // distinct (one slot each at the fork, one shared provenance
          // below it — never an independent corroboration, S7 is
          // existential and confidence never counts). Two or more shared
          // slots keep outcome 2: BRANCH_ATTRIBUTION_UNRESOLVED, and none
          // of them attaches.
          const sharedWithMe = allRows.filter(
            (r) => l.postForkSourceIds.has(r.sourceId) && (passCountByRowId.get(r.id) ?? 0) > 1,
          );
          const sharedIsOneElement =
            sharedWithMe.length > 0 && partitionIntoSlots(step, component, parentBranchPathHash, sharedWithMe).length === 1;
          candidateRows = allRows.filter(
            (r) =>
              (l.postForkSourceIds.has(r.sourceId) && passCountByRowId.get(r.id) === 1) ||
              (passCountByRowId.get(r.id) ?? 0) === 0 ||
              (sharedIsOneElement && sharedWithMe.includes(r)),
          );
          attributionUnresolved = candidateRows.length === 0 || (sharedWithMe.length > 0 && !sharedIsOneElement);
        }

        if (candidateRows.length === 0) {
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

        const slots = partitionIntoSlots(step, component, parentBranchPathHash, candidateRows);

        // S6 audit fix (HIGH-2): the cap must never silently drop an
        // established component from this lineage's structure. The
        // affected flow carries a positioned FLOW_ENUMERATION_INCOMPLETE
        // gap (so it can never present COMPLETE_PATH), and the
        // result-level gap below names the first cap position too.
        //
        // ROUND 6.6 (Founder decision 2) — BOUNDED ENUMERATION != WEAKER
        // TRUTH. The cap used to leave the component OFF the lineage, so
        // every claim needing it read UNSATISFIED once enough agreeing
        // slots existed to exhaust the enumeration (Round 6.5 F2). The cap
        // is a computational safety boundary, not project counterevidence:
        // when it binds, the lineage continues with the STRUCTURALLY-FIRST
        // slot (slots are sorted by structuralUnitKey then ids — the same
        // element whatever the input order), no fork is opened, and the
        // gap records that the other slots were not enumerated. The flow is
        // a real lineage of established rows — never stronger than full
        // enumeration would give (it is one of its flows), never weaker
        // than the retained rows establish.
        const capBinds = active.length * slots.length + (active.length - 1) > MAX_FLOWS && slots.length > 1;
        if (capBinds) enumerationCapPoint = enumerationCapPoint ?? { step, component };
        const enumerated = capBinds ? [slots[0]] : slots;

        enumerated.forEach((slot, slotIndex) => {
          const clone = cloneLineage(l);
          clone.lineage.push({ step, component, componentResultKey: key, evidenceIds: slot.evidenceIds });
          if (enumerated.length > 1) {
            clone.branchPointStep = clone.branchPointStep ?? step;
            clone.branchSlotPath.push(slotIndex);
          }
          if (capBinds) {
            clone.gaps.push({
              kind: "FLOW_ENUMERATION_INCOMPLETE",
              component,
              afterStep: step,
              provenance: { componentResults: [{ step, component }], evidenceIds: [] },
            });
          }
          // Post-fork provenance accumulates from the fork point onward —
          // the diverging slot itself included (it IS what distinguishes
          // this branch); pre-fork slots stay out (see postForkSourceIds).
          // A row that named no branch (attached to every branch above)
          // distinguishes none, so its source stays out too. The pass
          // count map is empty while nothing has forked yet, and a row of
          // the slot that forks THIS lineage right now is never an orphan.
          if (clone.branchPointStep !== null) {
            for (const id of slot.evidenceIds) {
              if (l.branchPointStep !== null && (passCountByRowId.get(id) ?? 0) === 0) continue;
              const row = evidenceById.get(id)!;
              clone.postForkSourceIds.add(row.sourceId);
            }
          }
          if (result.status === "PARTIALLY_SUPPORTED") {
            clone.gaps.push({
              kind: "PARTIAL_COMPONENT",
              component,
              afterStep: step,
              provenance: provenanceOf(step, component, slot.evidenceIds),
            });
          }
          if (attributionUnresolved) {
            // Some of this component's admitted rows could NOT be
            // attributed (shared by several branches or by none) even
            // though others attached uniquely here — §13.4: unattributable
            // Evidence "порождает разрыв на каждой затронутой ветви".
            clone.gaps.push({
              kind: "BRANCH_ATTRIBUTION_UNRESOLVED",
              component,
              afterStep: step,
              provenance: provenanceOf(step, component, result.supportingEvidenceIds),
            });
          }
          next.push(clone);
        });
      }
      active = next;
    }
  }

  if (enumerationCapPoint) {
    unassignedGaps.push({
      kind: "FLOW_ENUMERATION_INCOMPLETE",
      component: enumerationCapPoint.component,
      afterStep: enumerationCapPoint.step,
      provenance: {
        componentResults: [{ step: enumerationCapPoint.step, component: enumerationCapPoint.component }],
        evidenceIds: [],
      },
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

  // Each admitted row's own text, kept separate. `textFor` joins them, which
  // is right for classifying ONE value out of everything the component says,
  // and wrong for asking whether ONE statement links two things: joining
  // "token holders receive the fees" to "the protocol is entitled to a pro
  // rata share" would read as holder entitlement although neither sentence
  // says it. Anything that must be stated TOGETHER reads this instead.
  const textsFor = (component: string): string[] => {
    const lineageStep = lineageStepFor(l, component);
    if (!lineageStep) return [];
    return lineageStep.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((r): r is AssemblyEvidenceProjection => !!r)
      .map(admittedTextOf);
  };
  const textFor = (component: string): string => textsFor(component).join(" ");

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
  // S6 audit fix (MEDIUM-3): §5.1 — executed is true ONLY when
  // EXECUTION_EVIDENCE is itself established on this lineage. A FLOW_PATH
  // edge over a specification-only mechanism must never read as executed.
  const executionEstablishedHere = !!lineageStepFor(l, "EXECUTION_EVIDENCE");
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
      executed: executionEstablishedHere,
      qualifications: qualificationsOf(result.reasonCodes),
      provenance: provenanceOf(step, spec.component, lineageStep.evidenceIds),
    });
  }

  // §5.2 attributes — classified ONLY over admitted text of already-
  // established components; never decides existence, never fed back
  // into lineage/flowId.
  const valueSourceText = textFor("SOURCE_OF_VALUE");
  const valueSource: ValueSource = valueSourceText ? classifyValueSource(valueSourceText) : "UNKNOWN";

  // S6 audit fix (MEDIUM-5): the walk already emits the correct gap for
  // every component it could not attach (missing -> its *_UNRESOLVED /
  // MISSING_COMPONENT kind, contradicted -> CONTRADICTED_COMPONENT,
  // unattributable -> BRANCH_ATTRIBUTION_UNRESOLVED, capped ->
  // FLOW_ENUMERATION_INCOMPLETE). buildFlow's absence-emissions below are
  // now gated on "no gap already covers this component" — they exist only
  // as a defensive backstop, never a second copy of the same absence.
  const componentAlreadyGapped = (component: string): boolean => gaps.some((g) => g.component === component);

  const destinationText = textFor("DESTINATION");
  const destinationKind: DestinationKind = destinationText ? classifyDestinationKind(destinationText) : "UNKNOWN";
  if (!lineageStepFor(l, "DESTINATION")) {
    if (!componentAlreadyGapped("DESTINATION")) {
      gaps.push({
        kind: "DESTINATION_UNRESOLVED",
        component: "DESTINATION",
        afterStep: 6,
        provenance: { componentResults: [{ step: 6, component: "DESTINATION" }], evidenceIds: [] },
      });
    }
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

  // FOUNDER DECISION M3 — RECIPIENT IDENTITY ALONE DOES NOT ESTABLISH
  // PASSIVE HOLDER ENTITLEMENT. The recipient component IS established and
  // the classification IS recognised, so this is not a MISSING/PARTIAL
  // component and nothing about the recipient is withdrawn: the flow still
  // carries recipientKind = PASSIVE_HOLDER, and every other recipient-based
  // fact is untouched. What is unresolved is the bridge from HOLDING to
  // entitlement/receipt, and that is recorded here, positioned on the
  // recipient, in exactly the shape S6 already uses for an established
  // DESTINATION whose kind the closed dictionary does not recognise (below,
  // and the same gap kind the walk emits when the component is absent).
  // S7 reads it; nothing here decides a verdict.
  //
  // Asked of each admitted row SEPARATELY, and inside a row of each clause
  // separately: the bridge is a claim about holders, so ONE statement must
  // carry both halves. Pooling the component's text would let two
  // individually true sentences about different actors compose into an
  // entitlement neither of them states, and so would pooling two clauses
  // of one row. Explicit negation of the bridge is not the bridge.
  const holderEntitlementEstablished = textsFor("RECIPIENT").some(classifyHolderEntitlement);
  if (
    recipientKind === "PASSIVE_HOLDER" &&
    !holderEntitlementEstablished &&
    !gaps.some((g) => g.component === "RECIPIENT" && g.kind === "RECIPIENT_UNRESOLVED")
  ) {
    gaps.push({
      kind: "RECIPIENT_UNRESOLVED",
      component: "RECIPIENT",
      afterStep: 6,
      provenance: provenanceOf(6, "RECIPIENT", lineageStepFor(l, "RECIPIENT")?.evidenceIds ?? []),
    });
  }

  const directionText = [textFor("SOURCE_OF_VALUE"), textFor("FLOW_PATH"), textFor("EXECUTION_EVIDENCE")]
    .filter(Boolean)
    .join(" ");
  const direction: FlowDirection = directionText ? classifyDirection(directionText) : "UNKNOWN";

  // §8 — token state carried forward verbatim from S5, never re-derived.
  //
  // S6 audit fix (MEDIUM-2): S5's frozen detector routinely emits a
  // qualifier AND a fused identity for ONE state ("locked veCRV" ->
  // ["locked","vecrv"]) — a single component's mention list describes ONE
  // state, never a conflict, so pooling both components' lists into one
  // set and calling size>1 a mismatch was wrong in both directions. The
  // comparison is now per-component: each side is reduced to its most
  // specific representation (fused identities when present, else the bare
  // qualifiers), and a TOKEN_STATE_MISMATCH exists only when BOTH sides
  // carry a state and those representations share nothing.
  //
  // Documented v1 limitation (same posture as §13.2b): the plan's
  // qualified-vs-UNQUALIFIED-neighbor example ("RECIPIENT несёт vecrv,
  // DESTINATION — незаквалифицированный crv") is NOT detectable from
  // frozen S5 data — S5 records qualified-state mentions only, so an
  // empty mention list cannot distinguish "text names the liquid token"
  // from "text does not name the token at all". Treating every
  // empty-mention neighbor as a mismatch would falsely gap the plan's own
  // scenario D. Detecting it needs liquid-token mentions at
  // reconciliation/extraction time — a future frozen-contract change,
  // not an S6 guess.
  const stateRepresentationOf = (mentions: string[]): Set<string> => {
    const identities = mentions.filter(isFusedTokenStateIdentity);
    return new Set(identities.length > 0 ? identities : mentions);
  };
  const recipientResult = resultFor(byKey, 6, "RECIPIENT");
  const destinationResult = resultFor(byKey, 6, "DESTINATION");
  const recipientStates = stateRepresentationOf(
    lineageStepFor(l, "RECIPIENT") ? (recipientResult?.tokenStateMentions ?? []) : [],
  );
  const destinationStates = stateRepresentationOf(
    lineageStepFor(l, "DESTINATION") ? (destinationResult?.tokenStateMentions ?? []) : [],
  );
  const statesIntersect = [...recipientStates].some((s) => destinationStates.has(s));
  const tokenStateMismatch = recipientStates.size > 0 && destinationStates.size > 0 && !statesIntersect;

  let tokenState: string | null = null;
  if (tokenStateMismatch) {
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
  } else {
    // Deterministic representative: the single shared/known state — a
    // unique fused identity when one exists, else the unique qualifier.
    // Anything plural or indeterminate stays null (not a gap: nothing
    // conflicts, the state is just not representable as one string).
    const union = new Set([...recipientStates, ...destinationStates]);
    const identities = [...union].filter(isFusedTokenStateIdentity);
    if (identities.length === 1) tokenState = identities[0];
    else if (identities.length === 0 && union.size === 1) tokenState = [...union][0];
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

  if (!lineageStepFor(l, "RECIPIENT") && !componentAlreadyGapped("RECIPIENT")) {
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
  } else if (!componentAlreadyGapped("DURABILITY_BASIS")) {
    gaps.push({
      kind: "MISSING_COMPONENT",
      component: "DURABILITY_BASIS",
      afterStep: 8,
      provenance: { componentResults: [{ step: 8, component: "DURABILITY_BASIS" }], evidenceIds: [] },
    });
  }

  if (!lineageStepFor(l, "GOVERNANCE_BASIS") && !componentAlreadyGapped("GOVERNANCE_BASIS")) {
    gaps.push({
      kind: "MISSING_COMPONENT",
      component: "GOVERNANCE_BASIS",
      afterStep: 3,
      provenance: { componentResults: [{ step: 3, component: "GOVERNANCE_BASIS" }], evidenceIds: [] },
    });
  }

  // §10/§11.1 (audit fix MEDIUM-4) — TEMPORAL_STATE_MISMATCH: the flow's
  // CURRENT_STATE is established and claims a live-ish state, while some
  // other lineage component carries DEPRECATED/REMOVED on a STRICTLY
  // newer temporal basis. computeLifecycle already degrades the lifecycle
  // for exactly this conflict; the conflict itself must also be a
  // machine-readable gap, not only an implicit lifecycle downgrade.
  const temporalConflict = detectTemporalStateMismatch(l, byKey);
  if (temporalConflict) gaps.push(temporalConflict);

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

// Audit fix MEDIUM-4 — see the call site in buildFlow. Mirrors the exact
// newer-conflict predicate computeLifecycle's CURRENT branch uses, so the
// gap and the lifecycle downgrade can never disagree about what a
// temporal conflict is.
function detectTemporalStateMismatch(
  l: WorkingLineage,
  byKey: Map<string, ComponentReconciliationResult>,
): MechanismGap | null {
  const currentStateStep = lineageStepFor(l, "CURRENT_STATE");
  const currentStateResult = resultFor(byKey, 5, "CURRENT_STATE");
  if (
    !currentStateStep ||
    !currentStateResult ||
    (currentStateResult.status !== "SUPPORTED" && currentStateResult.status !== "PARTIALLY_SUPPORTED")
  ) {
    return null;
  }
  const cs = currentStateResult.currentState;
  if (cs !== "LIVE" && cs !== "IMPLEMENTING") return null;
  const csAt = currentStateResult.temporalBasis ? new Date(currentStateResult.temporalBasis.at).getTime() : null;
  if (csAt === null) return null;

  for (const step of l.lineage) {
    if (step.component === "CURRENT_STATE") continue;
    const r = resultFor(byKey, step.step, step.component);
    if (!r?.currentState || !r.temporalBasis) continue;
    if (
      (r.currentState === "DEPRECATED" || r.currentState === "REMOVED") &&
      new Date(r.temporalBasis.at).getTime() > csAt
    ) {
      return {
        kind: "TEMPORAL_STATE_MISMATCH",
        component: "CURRENT_STATE",
        afterStep: 5,
        provenance: {
          componentResults: [
            { step: 5, component: "CURRENT_STATE" },
            { step: step.step, component: step.component },
          ],
          evidenceIds: sortedIds([...currentStateStep.evidenceIds, ...step.evidenceIds]),
        },
      };
    }
  }
  return null;
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
