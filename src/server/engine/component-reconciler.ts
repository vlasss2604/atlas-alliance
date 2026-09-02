import {
  isGrossSupplyReductionFact,
  type OnchainFactKind,
} from "./onchain-facts";
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
  | "DUPLICATE_UNIT"
  // D-134 (RISK 2) — the ONE new reason this owner decision adds: an
  // ONCHAIN_VERIFIABLE row whose entity_binding is not CONFIRMED against
  // the project's own confirmed (chain, tokenAddress). The row's
  // sourceClass is untouched (it is still genuinely ONCHAIN_VERIFIABLE
  // data) — it simply cannot establish THIS project's component. Every
  // other class is unaffected; this axis is null (inapplicable) for them.
  | "ENTITY_NOT_CONFIRMED";

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
  | "TOKEN_STATE_UNQUALIFIED"
  // B1 — supply qualification for NET_EFFECT. Two codes, deliberately, for
  // two genuinely different states of the record.
  //
  // SUPPLY_REDUCTION_NOT_ESTABLISHED: nothing among the establishing
  // evidence is a typed gross supply-reduction event. A documented
  // buyback, an observed purchase, a holding balance, a transfer and a
  // point-in-time supply level all land here — they are the four things
  // this product must never let become "supply was reduced". CLEARABLE
  // TODAY: one deterministic BURN clears it.
  //
  // NET_SUPPLY_CHANGE_NOT_ESTABLISHED: a gross reduction IS established,
  // and net supply change across an interval is still not. A burn destroys
  // tokens; it does not establish that total supply is lower than before,
  // because nothing here has observed what else happened to supply in the
  // same window. CLEARABLE BY the supply-delta capability (two observations
  // of total supply at different slots), which is deliberately NOT in this
  // round — so in B1 this caps NET_EFFECT at PARTIALLY_SUPPORTED, and that
  // ceiling is the honest state of the engine rather than a defect.
  | "SUPPLY_REDUCTION_NOT_ESTABLISHED"
  | "NET_SUPPLY_CHANGE_NOT_ESTABLISHED";

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
  // D-134 — Axis C, independent of sourceClass/officiality. null when the
  // axis does not apply (any class other than ONCHAIN_VERIFIABLE).
  entityBinding: "CONFIRMED" | "UNVERIFIED" | null;
  // B1 — the DETERMINISTIC on-chain fact kind, or null for every row that
  // is not a deterministic chain observation (documentary, data-provider,
  // model-extracted). Null is read as absence of typed supply semantics,
  // never as permission.
  onchainFactKind: OnchainFactKind | null;
  fetchedAt: Date;
  publishedAt: Date | null;
  extractionUnitKey: string | null;
  contentHash: string;
}

// WHICH COMPONENT CARRIES A SUPPLY CLAIM.
//
// One named predicate rather than a bare string test scattered through the
// decision, so the rule is greppable and has exactly one home. Branching on
// a COMPONENT name is the file's established convention (EXECUTION_EVIDENCE
// and CURRENT_STATE already select their own reason codes the same way);
// branching on a project never is, and nothing here can.
//
// NET_EFFECT is the only component whose evidenceGoal asks whether supply
// "actually changed as a result". DESTINATION describes where value lands —
// including whether the destination retires it — but it does not claim a
// supply outcome, so it is deliberately NOT gated here. Widening this set
// is a Pattern-semantics decision, not an implementation liberty.
export function requiresSupplyEffectQualification(component: string): boolean {
  return component === "NET_EFFECT";
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
// "ve"/"stk"/"st" are FUSED prefixes (handled separately below, by
// FUSED_PREFIXES) — they never appear as their own delimited word, so the
// generic word-tokenizer below would never see them anyway.
const TOKEN_STATE_QUALIFIERS = [
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

// HIGH-5 (deep audit) fix — D-096 requires token-STATE IDENTITY, not a
// bare qualifier: "CRV != veCRV" and "AAVE != stkAAVE" mean the actual
// fused ticker must be preserved, not collapsed into the generic word
// "ve"/"stk"/"st". A fused-prefix qualifier attaches directly onto its
// ticker with no delimiter (veCRV, veBAL, stkAAVE, stETH) — plain
// word-tokenization can never see the prefix as a token of its own there.
//
// FINAL fix, round 3 (phase-6-s5-audit round 3, MEDIUM-1) — round 2's
// fully case-insensitive fused detector fixed the casing gap but
// overshot: it also fabricated identities from ordinary ALL-CAPS prose
// ("STAKING", "VESTING") and unsafe two-word shapes ("St Petersburg",
// "VE BOUGHT"), because an ALL-CAPS run trivially satisfies "uppercase
// right after the prefix" with no further discrimination possible from
// surface form alone. The fix is to stop trying to solve this with ONE
// detector and split the two genuinely different operations the review
// (§1-2, §9) names:
//
//   - VERIFICATION: does Evidence contain the ALREADY-KNOWN identity
//     Pattern asked for (requirements.requiredTokenState)? This is safe
//     to match fully case-insensitively, in any casing/separator combo,
//     because the ticker itself is fixed and human-approved — we are
//     never guessing what a ticker is, only whether Evidence names the
//     one Pattern already named. detectRequiredTokenStateIdentity below.
//
//   - DISCOVERY: what qualified identity (if any) does Evidence mention
//     when nothing specific was asked for? This has no such anchor, so
//     it must stay conservative: only shapes that carry a structural
//     signal beyond "starts with a known prefix" are accepted — a
//     genuine case TRANSITION (fused camelCase/Titlecase: veCRV, VeCRV)
//     or an EXPLICIT separator paired with the prefix's own canonical
//     lowercase spelling (ve-CRV, ve CRV — never "St"/"VE", which is
//     exactly what "St Petersburg"/"VE BOUGHT" are). A bare ALL-CAPS or
//     all-lowercase fused run (VECRV, vecrv) carries neither signal and
//     is deliberately left undetected here — see §7-8 of the final
//     review and the report for the full write-up; this is unchanged
//     from round 2's already-accepted all-lowercase deferral, now
//     extended to bare ALL-CAPS specifically because DISCOVERY (unlike
//     VERIFICATION) has no fixed ticker to anchor against.
//
// detectTokenStateMentions (below) is the union of both: the
// requirement-agnostic DISCOVERY set, plus — only when Evidence text
// actually contains it — the specific identity VERIFICATION was asked
// to look for. Pattern's requiredTokenState is never added just because
// it exists in Pattern; §10 of the review.
const FUSED_TOKEN_STATE_PREFIXES = ["ve", "stk", "st"] as const;

function titlecase(prefix: string): string {
  return prefix[0]!.toUpperCase() + prefix.slice(1);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// DISCOVERY grammar (requiredTokenState unknown/irrelevant) — see the
// block comment above. Two shapes only, both requiring a real structural
// boundary signal, never a bare ALL-CAPS or all-lowercase run:
//
//   1. Fused, no separator: prefix in its exact canonical lowercase
//      spelling OR Titlecase (first letter capitalised, matching a
//      sentence- or name-initial position), immediately followed by an
//      uppercase ticker-start letter — veCRV, VeCRV, stkAAVE, StkAAVE,
//      stETH, StETH. An ALL-CAPS prefix ("VE", "STK", "ST") is
//      deliberately excluded from this shape: it is what let "STAKING"/
//      "VESTING"/"STATE"/"STARTER"/"STONE" fuse in round 2.
//   2. Explicit separator: prefix in its exact canonical lowercase
//      spelling ONLY (not Titlecase, not ALL-CAPS) + a single hyphen or
//      space + an uppercase ticker-start letter — "ve-CRV", "ve CRV",
//      "stk AAVE", "st-ETH". Restricting the separated shape to exact
//      lowercase is what distinguishes "ve CRV" (accepted) from
//      "St Petersburg" / "VE BOUGHT" / "ST REWARDS" (Titlecase/ALL-CAPS
//      prefix, rejected) — those three unsafe examples share the exact
//      "prefix + separator + uppercase-start word" shape as the wanted
//      ones, so the prefix's own casing is the only remaining signal.
function detectGenericTokenStateIdentities(text: string): string[] {
  const found = new Set<string>();
  for (const prefix of FUSED_TOKEN_STATE_PREFIXES) {
    const lower = prefix;
    const title = titlecase(prefix);
    const fusedPattern = new RegExp(`\\b(?:${lower}|${title})(?=[A-Z])([A-Za-z][A-Za-z0-9]*)`, "g");
    for (const match of text.matchAll(fusedPattern)) {
      found.add(normalizeForLexicalMatch(`${prefix}${match[1]}`));
    }
    const separatedPattern = new RegExp(`\\b${lower}[-\\s](?=[A-Z])([A-Za-z][A-Za-z0-9]*)`, "g");
    for (const match of text.matchAll(separatedPattern)) {
      found.add(normalizeForLexicalMatch(`${prefix}${match[1]}`));
    }
  }
  return [...found];
}

// VERIFICATION (requiredTokenState known) — see the block comment above.
// Anchored to the EXACT expected identity, so full case-insensitivity is
// safe: there is no other candidate it could accidentally resolve to,
// unlike open-ended discovery. Splits requiredTokenState into its known
// fused prefix (longest match first, so "stk" wins over "st") and the
// remaining ticker, then looks for that literal prefix+ticker pair,
// case-insensitively, with an optional single hyphen/space between them
// at exactly that boundary — "VE-CRV"/"VE CRV" verify requiredTokenState
// "veCRV" (§3/§12) without opening any general ALL-CAPS discovery, because
// the ticker portion must literally equal the known "CRV", not an
// arbitrary uppercase continuation ("BOUGHT" does not equal "CRV").
// requiredTokenState values that don't start with a known fused prefix
// fall back to a plain whole-word case-insensitive literal match (no
// separator, since there is no known prefix/ticker boundary to place one
// at).
function detectRequiredTokenStateIdentity(text: string, requiredTokenState: string): string | null {
  const requiredLower = requiredTokenState.toLowerCase();
  const prefix = [...FUSED_TOKEN_STATE_PREFIXES]
    .sort((a, b) => b.length - a.length)
    .find((p) => requiredLower.startsWith(p));

  const pattern =
    prefix !== undefined
      ? new RegExp(
          `\\b${escapeRegExp(requiredTokenState.slice(0, prefix.length))}[-\\s]?${escapeRegExp(
            requiredTokenState.slice(prefix.length),
          )}\\b`,
          "i",
        )
      : new RegExp(`\\b${escapeRegExp(requiredTokenState)}\\b`, "i");

  return pattern.test(text) ? normalizeForLexicalMatch(requiredTokenState) : null;
}

// §9 — detects qualifiers by lexical token match, over the text the model
// actually produced (fragment/summary of an evidence row already admitted
// for this component) — never a fresh search, never a model call.
// requiredTokenState, when known, additionally licenses VERIFICATION of
// that one specific identity (see detectRequiredTokenStateIdentity) —
// this can surface a casing/separator variant DISCOVERY alone would
// leave conservative about (e.g. "VECRV" or "vecrv" when Pattern already
// names "veCRV"), without widening what DISCOVERY accepts when nothing
// specific was asked for.
function detectTokenStateMentions(text: string, requiredTokenState: string | null): string[] {
  const tokens = tokenizeForMatch(text);
  const found = new Set<string>();
  for (const qualifier of TOKEN_STATE_QUALIFIERS) {
    const qualifierTokens = tokenizeForMatch(qualifier);
    outer: for (let i = 0; i + qualifierTokens.length <= tokens.length; i++) {
      for (let j = 0; j < qualifierTokens.length; j++) {
        if (tokens[i + j] !== qualifierTokens[j]) continue outer;
      }
      found.add(qualifier);
      break;
    }
  }
  for (const identity of detectGenericTokenStateIdentities(text)) found.add(identity);
  if (requiredTokenState !== null) {
    const verified = detectRequiredTokenStateIdentity(text, requiredTokenState);
    if (verified !== null) found.add(verified);
  }
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
  // D-134 (RISK 2) — an ONCHAIN_VERIFIABLE row must additionally be bound
  // to THIS project's confirmed on-chain identity to establish anything.
  // The class check above already proved it is genuinely ONCHAIN_VERIFIABLE
  // data; this proves it is ONCHAIN_VERIFIABLE data ABOUT THIS PROJECT. A
  // wrong-asset explorer page (unrelated chain, unrelated mint, a testnet)
  // stops here, not by being reclassified — it stays genuinely
  // ONCHAIN_VERIFIABLE, it simply cannot establish this project's
  // component. Every other class is unaffected by this check.
  if (row.sourceClass === "ONCHAIN_VERIFIABLE" && row.entityBinding !== "CONFIRMED") {
    return { ok: false, reason: "ENTITY_NOT_CONFIRMED" };
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

// HIGH-3 (deep audit) fix — D-093 condition 4 ("B not less capable of
// establishing THIS component than A") is the FULL establishment
// threshold, not class-membership alone. §4 defines "capable of
// establishing" as: admissible class (§5) + relationship=SUPPORTS
// (condition 3 — "INDIRECT gives at most partial, INFERRED nothing") +
// directness=DIRECT (condition 4) + whatever §6 state/freshness gates the
// component requires. A row that could never itself establish this
// component — INFERRED, CONTEXT, LIMITS, INDIRECT, wrong class, stale,
// wrong state — must never be "at least as capable" of anything: it
// cannot supersede an older row that DOES establish. This subsumes the
// old class-membership-only rule (which is exactly evaluateCoreEligibility
// restricted to the SUPPORTS+DIRECT axes) and removes the need for the
// former "vacuous when A wasn't capable either" special case — a B that
// fully qualifies supersedes regardless of A's own capability (scenario
// X); a B that doesn't qualify supersedes nothing, ever (scenario W,
// and P1a-d in the deep audit).
function isEstablishmentEligible(row: EvidenceRow, v: RowVerdict): boolean {
  return v.eligibleCore && row.relationship === "SUPPORTS" && row.directness === "DIRECT";
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

  // --- Step 4: supersession (§8.1) — HIGH-3 fix: condition 4 now requires
  // the FULL establishment threshold from B (isEstablishmentEligible), not
  // class membership alone — see that function's doc comment. -------------
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
      if (!isEstablishmentEligible(b, vb)) continue;
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
  // MEDIUM-2 fix: a DIRECT CONTRADICTS row's final disposition (excluded
  // vs. actively contradiction-bearing) cannot be decided until AFTER
  // contradiction detection runs below — deciding it here, unconditionally,
  // is exactly what let one evidenceId land in BOTH contradictingEvidenceIds
  // AND excludedEvidence (deep audit P3a). It is added to
  // contradictionCapable now and its exclusion decision deferred.

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
        }
        // CONTRADICTS: excluded/kept decided after Step 6 below.
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
  // MEDIUM-1 fix: the threshold is state INCOMPATIBILITY, not a
  // relationship label. Two contradiction-capable, state-bearing rows
  // conflict iff their normalized states differ — this covers SUPPORTS-vs-
  // SUPPORTS-different-state (unchanged) AND SUPPORTS-vs-CONTRADICTS
  // (previously fired on relationship alone, even at identical states —
  // deep audit P6) while correctly NOT firing when a CONTRADICTS row
  // states the SAME machine-readable state as the SUPPORTS row it
  // "disagrees" with in prose (relationship label from the S4 model is
  // never itself the fact — the state is). A CONTRADICTS row with UNKNOWN
  // state was already excluded from this pool by the state-bearing filter,
  // so it correctly cannot fabricate OR suppress anything (P4a/P7).
  const stateBearingCapable = contradictionCapable.filter((r) => verdictByRowId.get(r.id)!.normalizedState !== "UNKNOWN");
  let contradictionFound = false;
  const contradictingSet = new Set<string>();
  for (let i = 0; i < stateBearingCapable.length; i++) {
    for (let j = i + 1; j < stateBearingCapable.length; j++) {
      const a = stateBearingCapable[i];
      const b = stateBearingCapable[j];
      const va = verdictByRowId.get(a.id)!;
      const vb = verdictByRowId.get(b.id)!;
      if (va.normalizedState !== vb.normalizedState) {
        contradictionFound = true;
        contradictingSet.add(a.id);
        contradictingSet.add(b.id);
      }
    }
  }

  // MEDIUM-2 fix, continued: finalize the deferred CONTRADICTS disposition
  // now that contradictingSet is known. A CONTRADICTS row that ended up
  // actively bearing the conflict is NEVER also recorded as excluded — the
  // three output sets (supporting/contradicting/excluded) stay disjoint.
  // A CONTRADICTS row that did NOT participate in any actual conflict (no
  // conflict at all, or a same-state disagreement that MEDIUM-1 correctly
  // refuses to treat as conflict) is excluded as non-supporting, same as
  // before (P4a/P7's honest INSUFFICIENT_EVIDENCE outcome).
  for (const row of contradictionCapable) {
    if (row.relationship !== "CONTRADICTS") continue;
    if (!contradictingSet.has(row.id)) {
      excluded.set(row.id, "RELATIONSHIP_NOT_SUPPORTING");
    }
  }

  const excludedEvidence = [...excluded.entries()]
    .map(([evidenceId, reason]) => ({ evidenceId, reason }))
    .sort((x, y) => (x.evidenceId < y.evidenceId ? -1 : x.evidenceId > y.evidenceId ? 1 : 0));

  if (contradictionFound) {
    const contradictingRows = [...stateBearingCapable]
      .filter((r) => contradictingSet.has(r.id))
      .sort(compareDeterministic);
    // LOW-2 (deep audit) — D-096 requires token-state observations to
    // transfer forward to S6 always, including on a CONTRADICTED outcome:
    // both conflicting sides may still name a qualified token state worth
    // carrying forward even though the component itself did not resolve.
    const tokenStateMentions = new Set<string>();
    for (const row of contradictingRows) {
      for (const m of detectTokenStateMentions(`${row.fragment} ${row.summary ?? ""}`, requirements.requiredTokenState)) {
        tokenStateMentions.add(m);
      }
    }
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
      tokenStateMentions: [...tokenStateMentions].sort(),
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
    for (const m of detectTokenStateMentions(`${row.fragment} ${row.summary ?? ""}`, requirements.requiredTokenState)) {
      tokenStateMentions.add(m);
    }
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

  // §B1 — SUPPLY QUALIFICATION. Source class is not permission.
  //
  // Before this, NET_EFFECT reached SUPPORTED whenever an admissible class
  // (ONCHAIN_VERIFIABLE, OFFICIAL_REPORT, DATA_PROVIDER) offered a
  // SUPPORTS/DIRECT row — with nothing whatever checking that the row was
  // ABOUT a supply reduction. A holding balance, a token transfer, a
  // single supply reading or a data provider's sentence each satisfied it.
  // That is the whole false positive: "tokens were bought" silently
  // becoming "supply was reduced".
  //
  // The qualification is typed, not lexical. `onchainFactKind` is written
  // only by deterministic chain synthesis, so this decision rests on what
  // the chain observation IS, never on what any text says about it. A row
  // with no kind (documentary, data-provider, model-extracted) carries no
  // typed supply semantics and therefore cannot qualify — it may still be
  // establishing evidence and still appear as support, it simply cannot
  // carry this component past the gate on its own.
  if (requiresSupplyEffectQualification(item.component)) {
    const grossReduction = establishing.some((r) => isGrossSupplyReductionFact(r.onchainFactKind));
    reasonCodes.push(
      grossReduction
        ? // A burn happened. What did NOT happen is an observation of
          // supply before and after, so net deflation stays unestablished.
          "NET_SUPPLY_CHANGE_NOT_ESTABLISHED"
        : "SUPPLY_REDUCTION_NOT_ESTABLISHED",
    );
  }

  const supportingRows = [...establishing].sort(compareDeterministic);

  // currentState/temporalBasis — from the best-ranked establishing element
  // that actually carries a known state, when the component carries state
  // at all (requiresLiveMechanismState or requiresCurrentState).
  let currentState: MechanismState | null = null;
  let temporalBasis: ComponentReconciliationResult["temporalBasis"] = null;
  if (requirements.requiresCurrentState || requirements.requiresLiveMechanismState) {
    const stateRows = supportingRows.filter((r) => verdictByRowId.get(r.id)!.normalizedState !== "UNKNOWN");
    // LOW-1 (deep audit) — non-CONTRADICTED does not mean agreeing: two
    // INDIRECT-only rows (which never reach Step 6's contradiction pool)
    // can carry different states while the component is merely
    // PARTIALLY_SUPPORTED. Picking the best-ranked row's state in that
    // case would be exactly the "molчаливый выбор строки" §8.1
    // prohibits — report currentState only when every state-bearing
    // establishing row actually agrees.
    const distinctStates = new Set(stateRows.map((r) => verdictByRowId.get(r.id)!.normalizedState));
    if (stateRows.length > 0 && distinctStates.size === 1) {
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
