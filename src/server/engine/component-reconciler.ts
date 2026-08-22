import type { EvidenceSourceClass } from "./providers/types";
import type { ComponentWorkItem } from "./contract-view";
import { normalizeMechanismState, type MechanismState } from "../domain/mechanism-state";

// Phase 6, S5 — Component Reconciliation (phase-6-s5-plan.md, D-092..D-096).
//
// Turns S4's deterministic, provenance-bearing Evidence[] for ONE
// (step, component) into a machine-readable ComponentReconciliationResult.
// Pure, deterministic, model-free, network-free — no DB access here (§4 of
// the task, §12 of the plan). Persistence lives in
// component-reconciliation-store.ts, a separate module by design so this
// file can be unit-tested with plain in-memory arrays.
//
// Normative boundary (plan §17.1): this file must never search, fetch,
// call an LLM, recompute sourceClass/officiality, mutate Evidence, promote
// memory, widen Boundary Contract scope, assemble an economic chain, issue
// a final Proof verdict, or assign a numeric confidence. Every rule below
// is structural: enum comparison, date comparison, class-membership
// lookup, a closed-list lexical detector. `fragment`/`summary` content is
// read only as DATA (lexical containment / token-qualifier detection),
// never as an instruction — there is no model in this file, so there is no
// prompt-injection surface here at all.

export type ComponentReconciliationStatus =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "CONTRADICTED"
  | "INSUFFICIENT_EVIDENCE";

// §10 — closed. Never invented, never extended without a new owner decision.
export type ExclusionReason =
  | "WRONG_COMPONENT"
  | "WRONG_PROJECT"
  | "LEGACY_CONTRACT_VERSION"
  | "CLASS_NOT_ADMISSIBLE"
  | "DIRECTNESS_INSUFFICIENT"
  | "RELATIONSHIP_NOT_SUPPORTING"
  | "NOT_CURRENT_STATE_BEARING"
  | "MISSING_PUBLICATION_DATE"
  | "STALE_FOR_CURRENT_STATE"
  | "SUPERSEDED_BY_NEWER"
  | "DUPLICATE_UNIT";

// §10 — closed.
export type ResultReasonCode =
  | "NO_EVIDENCE_FOUND"
  | "ALL_EVIDENCE_EXCLUDED"
  | "MISSING_EXECUTION_EVIDENCE"
  | "MISSING_CURRENT_STATE"
  | "STALE_CURRENT_STATE"
  | "INSUFFICIENT_AUTHORITY"
  | "INDIRECT_ONLY"
  | "STATE_NOT_FULLY_LIVE"
  | "CONFLICTING_STATE"
  | "TOKEN_STATE_UNQUALIFIED";

// §11.1 — the row shape S5 reads. A deliberately narrow projection of
// `evidence` (proof.ts) — only what this file's rules actually use.
export interface EvidenceRow {
  id: string;
  researchJobId: string;
  sourceId: string;
  evidenceContractVersion: number;
  patternStep: number | null;
  component: string | null;
  relationship: "SUPPORTS" | "CONTRADICTS" | "CONTEXT" | "LIMITS";
  directness: "DIRECT" | "INDIRECT" | "INFERRED" | null;
  fragment: string;
  summary: string | null;
  mechanismState: string | null;
  sourceClass: EvidenceSourceClass | null;
  officiality: "CONFIRMED" | "CLAIMED" | null;
  fetchedAt: Date;
  publishedAt: Date | null;
  extractionUnitKey: string | null;
  contentHash: string;
}

// §11.1 — Pattern/CORE data (D-095), never invented in this file.
export interface ComponentRequirements {
  component: string;
  establishingClasses: EvidenceSourceClass[];
  requiresCurrentState: boolean;
  requiresLiveMechanismState: boolean;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  tokenStateSensitive: boolean;
  requiredTokenState: string | null;
}

export interface ComponentReconciliationInput {
  // Additive vs. the plan's literal input sketch — needed to make
  // WRONG_PROJECT operable (Evidence carries research_job_id, not a
  // project id). Never widens what this file is allowed to do: it is used
  // for exactly one defensive equality check (§10), nothing else.
  jobId: string;
  item: Pick<ComponentWorkItem, "step" | "component">;
  requirements: ComponentRequirements;
  evidence: EvidenceRow[];
  now: Date;
  freshnessPolicyDays: Record<"LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE", number>;
}

export interface ComponentReconciliationResult {
  step: number;
  component: string;
  status: ComponentReconciliationStatus;
  reasonCodes: ResultReasonCode[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  excludedEvidence: { evidenceId: string; reason: ExclusionReason }[];
  currentState: MechanismState | null;
  temporalBasis: { basisField: "published_at" | "fetched_at"; at: string } | null;
  tokenStateMentions: string[];
  requiresFreshEvidence: boolean;
}

// §9 (D-096) — closed, code-owned list of token-state qualifiers, checked
// with token-boundary discipline (same discipline as S4's project-name
// containment) so "veCRV" matches but "give" (containing "ve") does not.
const TOKEN_STATE_QUALIFIERS = [
  "ve",
  "vote-escrowed",
  "vote escrowed",
  "locked",
  "staked",
  "wrapped",
  "escrowed",
  "vested",
] as const;

function normalizeForLexicalMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenizeForMatch(s: string): string[] {
  return normalizeForLexicalMatch(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// §9 — detects qualifiers by lexical token match, over the text the model
// actually produced (fragment/summary of an evidence row already admitted
// for this component) — never a fresh search, never a model call.
//
// "ve" needs its own detector: unlike "staked"/"locked"/"wrapped" (which
// always appear as their own separated word — "staked AAVE"), a
// vote-escrowed ticker fuses the prefix directly onto the token with no
// delimiter (veCRV, veBAL) — plain word-tokenization can never see "ve" as
// a token of its own there. Boundary discipline for THIS qualifier is a
// case-sensitive "ve" immediately followed by an uppercase letter (the
// start of the fused ticker) — the same false-positive risk word-boundary
// checks elsewhere in this codebase (S4 project containment) guard
// against, applied to a fused rather than a delimited token.
const VE_FUSION_PATTERN = /\bve(?=[A-Z])/;

function detectTokenStateMentions(text: string): string[] {
  const tokens = tokenizeForMatch(text);
  const found = new Set<string>();
  for (const qualifier of TOKEN_STATE_QUALIFIERS) {
    if (qualifier === "ve") continue; // handled separately below
    const qualifierTokens = tokenizeForMatch(qualifier);
    outer: for (let i = 0; i + qualifierTokens.length <= tokens.length; i++) {
      for (let j = 0; j < qualifierTokens.length; j++) {
        if (tokens[i + j] !== qualifierTokens[j]) continue outer;
      }
      found.add(qualifier);
      break;
    }
  }
  if (VE_FUSION_PATTERN.test(text)) found.add("ve");
  return [...found].sort();
}

function temporalBasisOf(row: EvidenceRow): { basisField: "published_at" | "fetched_at"; at: Date } | null {
  if (row.publishedAt !== null) return { basisField: "published_at", at: row.publishedAt };
  // §6.2 — the one narrow exception: an on-chain observation fixes the
  // state at load time, so fetched_at stands in for publication.
  if (row.sourceClass === "ONCHAIN_VERIFIABLE") return { basisField: "fetched_at", at: row.fetchedAt };
  return null;
}

function isFreshEnough(
  basis: { basisField: "published_at" | "fetched_at"; at: Date },
  now: Date,
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE",
  freshnessPolicyDays: Record<"LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE", number>,
): boolean {
  const maxAgeMs = freshnessPolicyDays[freshnessClass] * 24 * 60 * 60 * 1000;
  const ageMs = now.getTime() - basis.at.getTime();
  return ageMs <= maxAgeMs;
}

// §12 tie-break ranks. NOT an authority ranking (D-093 explicitly
// forbids one) — used ONLY after every real rule already decided the
// outcome, purely to produce a stable output order among rows a real rule
// left tied. Never read by any establishment/contradiction/supersession
// check above.
const CLASS_TIE_BREAK_RANK: Record<EvidenceSourceClass, number> = {
  ONCHAIN_VERIFIABLE: 0,
  OFFICIAL_DOCS: 1,
  GOVERNANCE: 2,
  OFFICIAL_REPORT: 3,
  DATA_PROVIDER: 4,
  RESEARCH_MEDIA: 5,
  SOCIAL: 6,
};
const OFFICIALITY_TIE_BREAK_RANK: Record<"CONFIRMED" | "CLAIMED", number> = {
  CONFIRMED: 0,
  CLAIMED: 1,
};
const DIRECTNESS_TIE_BREAK_RANK: Record<"DIRECT" | "INDIRECT" | "INFERRED", number> = {
  DIRECT: 0,
  INDIRECT: 1,
  INFERRED: 2,
};

// §12 full deterministic sort: published_at DESC NULLS LAST -> class rank
// -> officiality rank -> directness rank -> content_hash -> id. Total order
// — identical elements sort identically regardless of DB/array input order
// (scenario K, mutation 15).
function compareDeterministic(a: EvidenceRow, b: EvidenceRow): number {
  const aAt = a.publishedAt?.getTime() ?? null;
  const bAt = b.publishedAt?.getTime() ?? null;
  if (aAt !== bAt) {
    if (aAt === null) return 1; // NULLS LAST
    if (bAt === null) return -1;
    return bAt - aAt; // DESC
  }
  const aClass = a.sourceClass ? CLASS_TIE_BREAK_RANK[a.sourceClass] : 99;
  const bClass = b.sourceClass ? CLASS_TIE_BREAK_RANK[b.sourceClass] : 99;
  if (aClass !== bClass) return aClass - bClass;
  const aOff = a.officiality ? OFFICIALITY_TIE_BREAK_RANK[a.officiality] : 99;
  const bOff = b.officiality ? OFFICIALITY_TIE_BREAK_RANK[b.officiality] : 99;
  if (aOff !== bOff) return aOff - bOff;
  const aDir = a.directness ? DIRECTNESS_TIE_BREAK_RANK[a.directness] : 99;
  const bDir = b.directness ? DIRECTNESS_TIE_BREAK_RANK[b.directness] : 99;
  if (aDir !== bDir) return aDir - bDir;
  if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// D-093 §8.1a — "at least as capable of establishing THIS component" is
// class-membership only, never a global rank. If A wasn't capable at all,
// any B is vacuously "at least as capable" (B may supersede A regardless
// of B's own class) — this is what lets a newer, structurally inadmissible
// row fail to block supersession-by-omission while never itself winning
// (scenario W: OFFICIAL_DOCS can't supersede EXECUTION_EVIDENCE's onchain
// row, but also never establishes it either).
function atLeastAsCapable(
  aClass: EvidenceSourceClass | null,
  bClass: EvidenceSourceClass | null,
  establishingClasses: EvidenceSourceClass[],
): boolean {
  const aCapable = aClass !== null && establishingClasses.includes(aClass);
  if (!aCapable) return true;
  return bClass !== null && establishingClasses.includes(bClass);
}

interface RowVerdict {
  row: EvidenceRow;
  exclusionReason: ExclusionReason | null;
  normalizedState: MechanismState;
  temporalBasis: { basisField: "published_at" | "fetched_at"; at: Date } | null;
  // True only for a row eligible to independently establish (or
  // contradict) THIS component per §4/§5/§6 — directness/relationship
  // agnostic; used only internally to decide supportingEvidenceIds vs.
  // contradiction participation.
  eligibleCore: boolean;
}

// Core eligibility (§4 conditions 5-6, §5, §6.2, §6.3) — everything EXCEPT
// the relationship=SUPPORTS / directness=DIRECT axes, which the two callers
// (establishing-selection vs. contradiction-detection) apply differently
// per D-094's "same threshold" rule.
function evaluateCoreEligibility(
  row: EvidenceRow,
  requirements: ComponentRequirements,
  now: Date,
  freshnessPolicyDays: Record<"LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE", number>,
): { ok: true; reason: null } | { ok: false; reason: ExclusionReason } {
  if (row.sourceClass === null || !requirements.establishingClasses.includes(row.sourceClass)) {
    return { ok: false, reason: "CLASS_NOT_ADMISSIBLE" };
  }
  const normalizedState = normalizeMechanismState(row.mechanismState);
  if (requirements.requiresLiveMechanismState) {
    if (normalizedState !== "LIVE" && normalizedState !== "IMPLEMENTING") {
      return { ok: false, reason: "NOT_CURRENT_STATE_BEARING" };
    }
  }
  if (requirements.requiresCurrentState) {
    const basis = temporalBasisOf(row);
    if (basis === null) return { ok: false, reason: "MISSING_PUBLICATION_DATE" };
    if (!isFreshEnough(basis, now, requirements.freshnessClass, freshnessPolicyDays)) {
      return { ok: false, reason: "STALE_FOR_CURRENT_STATE" };
    }
  }
  return { ok: true, reason: null };
}

export function reconcileComponent(input: ComponentReconciliationInput): ComponentReconciliationResult {
  const { jobId, item, requirements, evidence, now, freshnessPolicyDays } = input;

  if (evidence.length === 0) {
    return {
      step: item.step,
      component: item.component,
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["NO_EVIDENCE_FOUND"],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
      currentState: null,
      temporalBasis: null,
      tokenStateMentions: [],
      requiresFreshEvidence: true,
    };
  }

  // --- Step 2: hard, unconditional exclusions -----------------------------
  const excluded = new Map<string, ExclusionReason>();
  for (const row of evidence) {
    if (row.evidenceContractVersion !== 2) {
      excluded.set(row.id, "LEGACY_CONTRACT_VERSION");
      continue;
    }
    if (row.patternStep !== item.step || row.component !== item.component) {
      excluded.set(row.id, "WRONG_COMPONENT");
      continue;
    }
    if (row.researchJobId !== jobId) {
      excluded.set(row.id, "WRONG_PROJECT");
      continue;
    }
  }

  const survivingAfterHard = evidence.filter((r) => !excluded.has(r.id));

  // Deduplicate: extraction_unit_key if present, else (source_id,
  // normalized fragment). The first row by the deterministic sort order
  // becomes the representative; the rest are DUPLICATE_UNIT. Sorting first
  // makes the "first" choice itself order-independent (scenario K/L).
  const sorted = [...survivingAfterHard].sort(compareDeterministic);
  const unitKeyOf = (r: EvidenceRow): string =>
    r.extractionUnitKey ?? `${r.sourceId}|${normalizeForLexicalMatch(r.fragment)}`;
  const seenUnits = new Set<string>();
  const survivingAfterDedup: EvidenceRow[] = [];
  for (const row of sorted) {
    const key = unitKeyOf(row);
    if (seenUnits.has(key)) {
      excluded.set(row.id, "DUPLICATE_UNIT");
      continue;
    }
    seenUnits.add(key);
    survivingAfterDedup.push(row);
  }

  // --- Step 3/core eligibility (normalization happens inside) -------------
  const verdictByRowId = new Map<string, RowVerdict>();
  for (const row of survivingAfterDedup) {
    const normalizedState = normalizeMechanismState(row.mechanismState);
    const temporalBasis = temporalBasisOf(row);
    const core = evaluateCoreEligibility(row, requirements, now, freshnessPolicyDays);
    verdictByRowId.set(row.id, {
      row,
      exclusionReason: core.ok ? null : core.reason,
      normalizedState,
      temporalBasis,
      eligibleCore: core.ok,
    });
  }

  // --- Step 4: supersession (§8.1) — among core-eligible-or-not rows that
  // carry a real state and a real temporal basis; class-capability (not
  // core eligibility, which already folds in the live-state gate) governs
  // condition 4, matching D-093's "class membership only" test. -----------
  const supersededIds = new Set<string>();
  const candidatesForSupersession = survivingAfterDedup.filter((r) => {
    const v = verdictByRowId.get(r.id)!;
    return v.normalizedState !== "UNKNOWN" && v.temporalBasis !== null;
  });
  for (const a of candidatesForSupersession) {
    const va = verdictByRowId.get(a.id)!;
    for (const b of candidatesForSupersession) {
      if (a.id === b.id) continue;
      const vb = verdictByRowId.get(b.id)!;
      if (vb.temporalBasis!.at.getTime() <= va.temporalBasis!.at.getTime()) continue; // b must be strictly newer
      if (!atLeastAsCapable(a.sourceClass, b.sourceClass, requirements.establishingClasses)) continue;
      supersededIds.add(a.id);
      break;
    }
  }
  for (const id of supersededIds) {
    excluded.set(id, "SUPERSEDED_BY_NEWER");
  }

  const activePool = survivingAfterDedup.filter((r) => !supersededIds.has(r.id));

  // --- Step 5: establishing / partial / contradiction-capable classification
  const fullEstablishing: EvidenceRow[] = [];
  const partialEstablishing: EvidenceRow[] = [];
  const contradictionCapable: EvidenceRow[] = [];

  for (const row of activePool) {
    const v = verdictByRowId.get(row.id)!;
    if (!v.eligibleCore) {
      excluded.set(row.id, v.exclusionReason!);
      continue;
    }
    if (row.relationship === "SUPPORTS" || row.relationship === "CONTRADICTS") {
      if (row.directness === "DIRECT") {
        contradictionCapable.push(row);
        if (row.relationship === "SUPPORTS") {
          fullEstablishing.push(row);
        } else {
          excluded.set(row.id, "RELATIONSHIP_NOT_SUPPORTING");
        }
        continue;
      }
      if (row.directness === "INDIRECT" && row.relationship === "SUPPORTS") {
        partialEstablishing.push(row);
        continue;
      }
      excluded.set(row.id, "DIRECTNESS_INSUFFICIENT"); // INFERRED, or INDIRECT+CONTRADICTS
      continue;
    }
    // CONTEXT / LIMITS never establish or contradict anything.
    excluded.set(row.id, "RELATIONSHIP_NOT_SUPPORTING");
  }

  // --- Step 6: contradiction (§7, D-094) ------------------------------------
  const stateBearingCapable = contradictionCapable.filter((r) => verdictByRowId.get(r.id)!.normalizedState !== "UNKNOWN");
  let contradictionFound = false;
  const contradictingSet = new Set<string>();
  for (let i = 0; i < stateBearingCapable.length; i++) {
    for (let j = i + 1; j < stateBearingCapable.length; j++) {
      const a = stateBearingCapable[i];
      const b = stateBearingCapable[j];
      const va = verdictByRowId.get(a.id)!;
      const vb = verdictByRowId.get(b.id)!;
      const bothSupportDiffer =
        a.relationship === "SUPPORTS" && b.relationship === "SUPPORTS" && va.normalizedState !== vb.normalizedState;
      const opposingRelationship =
        (a.relationship === "SUPPORTS" && b.relationship === "CONTRADICTS") ||
        (a.relationship === "CONTRADICTS" && b.relationship === "SUPPORTS");
      if (bothSupportDiffer || opposingRelationship) {
        contradictionFound = true;
        contradictingSet.add(a.id);
        contradictingSet.add(b.id);
      }
    }
  }

  const excludedEvidence = [...excluded.entries()]
    .map(([evidenceId, reason]) => ({ evidenceId, reason }))
    .sort((x, y) => (x.evidenceId < y.evidenceId ? -1 : x.evidenceId > y.evidenceId ? 1 : 0));

  if (contradictionFound) {
    const contradictingRows = [...stateBearingCapable]
      .filter((r) => contradictingSet.has(r.id))
      .sort(compareDeterministic);
    return {
      step: item.step,
      component: item.component,
      status: "CONTRADICTED",
      reasonCodes: ["CONFLICTING_STATE"],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: contradictingRows.map((r) => r.id),
      excludedEvidence,
      currentState: null,
      temporalBasis: null,
      tokenStateMentions: [],
      requiresFreshEvidence: true,
    };
  }

  // --- Step 7/8: SUPPORTED / PARTIALLY_SUPPORTED / INSUFFICIENT_EVIDENCE --
  const establishing = [...fullEstablishing, ...partialEstablishing];
  if (establishing.length === 0) {
    const specificCode: ResultReasonCode =
      item.component === "EXECUTION_EVIDENCE"
        ? "MISSING_EXECUTION_EVIDENCE"
        : item.component === "CURRENT_STATE"
          ? [...excluded.values()].includes("STALE_FOR_CURRENT_STATE")
            ? "STALE_CURRENT_STATE"
            : "MISSING_CURRENT_STATE"
          : excludedEvidence.length > 0
            ? "ALL_EVIDENCE_EXCLUDED"
            : "NO_EVIDENCE_FOUND";
    return {
      step: item.step,
      component: item.component,
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: [specificCode],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      excludedEvidence,
      currentState: null,
      temporalBasis: null,
      tokenStateMentions: [],
      requiresFreshEvidence: true,
    };
  }

  // §8.2 — closed partial-support bases, each independently checked.
  const reasonCodes: ResultReasonCode[] = [];
  const bestEstablishing = [...establishing].sort(compareDeterministic)[0];
  if (bestEstablishing.officiality === "CLAIMED") reasonCodes.push("INSUFFICIENT_AUTHORITY");
  if (fullEstablishing.length === 0 && partialEstablishing.length > 0) reasonCodes.push("INDIRECT_ONLY");

  // §6.3 STATE_NOT_FULLY_LIVE — an establishing element with normalized
  // state IMPLEMENTING where requiresLiveMechanismState demands LIVE.
  if (requirements.requiresLiveMechanismState) {
    const anyImplementingOnly =
      establishing.some((r) => verdictByRowId.get(r.id)!.normalizedState === "IMPLEMENTING") &&
      !establishing.some((r) => verdictByRowId.get(r.id)!.normalizedState === "LIVE");
    if (anyImplementingOnly) reasonCodes.push("STATE_NOT_FULLY_LIVE");
  }

  // §9.1 — token-state qualification. Detection ALWAYS runs over the
  // model-visible text of every establishing element (D-096); downgrade
  // only under all three named conditions.
  const tokenStateMentions = new Set<string>();
  for (const row of establishing) {
    for (const m of detectTokenStateMentions(`${row.fragment} ${row.summary ?? ""}`)) tokenStateMentions.add(m);
  }
  if (
    requirements.tokenStateSensitive &&
    tokenStateMentions.size > 0 &&
    requirements.requiredTokenState === null
  ) {
    // Condition 3: Pattern does not establish that the qualified state
    // equals the required one (no requirement stated at all -> equality
    // not established). If a requiredTokenState IS stated, downgrade
    // applies only when it does not match what was found, never on exact
    // match (scenario U).
    reasonCodes.push("TOKEN_STATE_UNQUALIFIED");
  } else if (
    requirements.tokenStateSensitive &&
    tokenStateMentions.size > 0 &&
    requirements.requiredTokenState !== null
  ) {
    const requiredNormalized = normalizeForLexicalMatch(requirements.requiredTokenState);
    const matchesRequired = [...tokenStateMentions].some((m) => normalizeForLexicalMatch(m) === requiredNormalized);
    if (!matchesRequired) reasonCodes.push("TOKEN_STATE_UNQUALIFIED");
  }

  const supportingRows = [...establishing].sort(compareDeterministic);

  // currentState/temporalBasis — from the best-ranked establishing element
  // that actually carries a known state, when the component carries state
  // at all (requiresLiveMechanismState or requiresCurrentState).
  let currentState: MechanismState | null = null;
  let temporalBasis: ComponentReconciliationResult["temporalBasis"] = null;
  if (requirements.requiresCurrentState || requirements.requiresLiveMechanismState) {
    const stateRows = supportingRows.filter((r) => verdictByRowId.get(r.id)!.normalizedState !== "UNKNOWN");
    if (stateRows.length > 0) {
      const chosen = stateRows[0];
      const v = verdictByRowId.get(chosen.id)!;
      currentState = v.normalizedState;
      temporalBasis = v.temporalBasis ? { basisField: v.temporalBasis.basisField, at: v.temporalBasis.at.toISOString() } : null;
    }
  }

  const status: ComponentReconciliationStatus = reasonCodes.length > 0 ? "PARTIALLY_SUPPORTED" : "SUPPORTED";

  return {
    step: item.step,
    component: item.component,
    status,
    reasonCodes,
    supportingEvidenceIds: supportingRows.map((r) => r.id),
    contradictingEvidenceIds: [],
    excludedEvidence,
    currentState,
    temporalBasis,
    tokenStateMentions: [...tokenStateMentions].sort(),
    requiresFreshEvidence: false,
  };
}
