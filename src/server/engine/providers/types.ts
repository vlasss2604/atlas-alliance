// Phase 6, S1 — shared provider-seam types (phase-6-plan.md §4.1, §7).
// These are the ONLY vocabulary the controller (S3) and provider seams
// exchange. None of these types imply orchestration: a provider returns
// candidates/content/facts for a single requested unit of work and does
// nothing else — scope, budget, eligibility and stopping remain the
// controller's job (D-070).

// D-137 — WHAT A PROVIDER INVOCATION COSTS THE JOB.
//
// The research-job budget measures REAL external capability consumption:
// how many search calls this job actually made, how many sources it
// actually opened, how much model work it actually authorized. A provider
// that serves already-persisted results performs none of that — the
// external call happened earlier and was already charged then. Charging it
// again would exhaust a job's budget for work nobody did.
//
// So a provider may DECLARE how its invocations should be metered:
//
//   LIVE   — the invocation performs billable external work (the default)
//   REPLAY — the invocation serves already-accounted persisted results
//
// The default is deliberately the expensive one. The field is optional and
// absence means LIVE, so every provider that existed before this decision,
// and every provider written without thinking about metering, is charged
// exactly as it was. Only an explicit, typed "REPLAY" is free, and the
// check is an equality test against that one value — anything else,
// including undefined, a typo or a truthy object, charges. Fail closed
// financially.
//
// Deliberately NOT how replay is detected: instanceof, a class or file
// name, the job's acquisition phase, the worker's role, or anything about
// the network. A provider states what it does; nothing infers it.
export const PROVIDER_METERING = ["LIVE", "REPLAY"] as const;
export type ProviderMetering = (typeof PROVIDER_METERING)[number];

// Implemented by every provider seam whose calls consume a budget axis.
export interface MeteredProvider {
  readonly metering?: ProviderMetering;
}

// The single decision function. Everything that is not exactly "REPLAY" is
// billable, including undefined.
export function isReplayProvider(provider: MeteredProvider | undefined | null): boolean {
  return provider?.metering === "REPLAY";
}

// One (step, component) unit of work — the same shape ContractView (S0)
// produces, kept here so provider modules don't need to import engine
// internals just for these four fields.
export interface ComponentTarget {
  step: number;
  stepName: string;
  component: string;
  // S4 review fix (HIGH-2, project containment): immutable project
  // identity carried structurally into every provider call, not just
  // mentioned in a prompt. Prompt inclusion alone does not stop a
  // compromised/wrong extractor from rewriting a summary to sound like
  // it's about this project — the real containment check
  // (s4-executor.ts) verifies the FETCHED DOCUMENT itself names the
  // project, independent of anything a provider claims about it.
  projectId: string | null;
  projectName: string;
  projectSlug: string;
  // ACQUISITION MINIMUM SAFE V1 (A) — what this research is actually
  // trying to find out. Before this, a provider received only the
  // component NAME, so the best a QueryProposer could do for NET_EFFECT
  // was search the label ("<project> net token effect mechanism") and the
  // EvidenceExtractor had to guess what would count as a relevant fact.
  //
  // researchTask is the job's normalized task (the user's question, as
  // normalized by the Interpreter); intent is its normalized intent;
  // evidenceGoal is the Pattern's human-authored proposition for THIS
  // component (pattern.ts componentRequirements.evidenceGoal — CORE data,
  // never model-invented).
  //
  // All three are CONTEXT for query/fact generation only. They never
  // reach S5: admissibility remains establishingClasses plus the existing
  // axes, and no provider output can widen scope — the structural
  // containment checks in s4-executor.ts (project naming, component
  // match) are unchanged and still the real enforcement.
  //
  // Optional so every existing fixture and caller stays valid; absent
  // simply means the prompt omits that line, never a fabricated one.
  researchTask?: string | null;
  intent?: string | null;
  evidenceGoal?: string | null;
}

// S10 (live-provider-enablement.md §7, D-118) — real token usage from a
// live model call, audit-only (see model-cost-profile.ts's
// calculateActualCostMicro). Never a second budget authority; never
// derived from an estimate.
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  // S10 acceptance closure (MEDIUM-2, D-119) — true when the provider
  // response reported a billable usage category (e.g.
  // cache_creation_input_tokens/cache_read_input_tokens) that the
  // approved cost profile cannot safely price, because INTERNAL_ALPHA_V1
  // intentionally does not use prompt caching. When true, the consumer
  // (s4-executor.ts) must NOT compute actualCostMicro from
  // inputTokens/outputTokens alone — that would silently understate real
  // cost. Never invents pricing for the unsupported category; surfaces
  // an explicit reason code instead.
  unsupportedBillingUsage?: boolean;
}

export interface SourceCandidate {
  url: string;
  // Whatever the search provider returns as a title/snippet — advisory
  // only. A search-result snippet is NEVER evidence (§7.1, D-076): it can
  // only tell the controller what to open next.
  title: string | null;
  snippet: string | null;
}

export type ContentType =
  | "text/html"
  // RFC 7763. Documentary text, handled on exactly the text/plain path:
  // the bytes are trimmed and kept as-is. Markdown is never parsed,
  // rendered, or followed — no embedded HTML is executed, no link is
  // resolved, no directive is honoured. A first-party document served as
  // Markdown was previously unreadable by the static path even though the
  // representation is strictly simpler than the HTML we already accept.
  | "text/markdown"
  | "text/plain"
  | "application/json"
  | "application/xml";

export interface FetchedDocument {
  finalUrl: string;
  requestedUrl: string;
  httpStatus: number;
  contentType: ContentType;
  // Normalized text — scripts/styles/hidden nodes stripped before this
  // ever reaches a model (§16). This is DATA, never instructions.
  normalizedText: string;
  contentHash: string; // sha256 of the raw bytes actually received
  fetchedAt: Date;
  byteLength: number;
  // Stage 0 — set ONLY when embedded structured-payload recovery ran for
  // a confirmed OFFICIAL_DOCS page AND recovered something. Null on every
  // ordinary fetch, so "was this text augmented?" is always answerable.
  embeddedPayload?: {
    kinds: string[];
    recoveredStrings: number;
    truncated: boolean;
    text: string;
  } | null;
  // Length of the text extracted from visible HTML alone, before any
  // recovery — the before/after pair is what makes the augmentation
  // auditable rather than invisible.
  staticTextLength?: number;
}

// S4 additive extension (phase-6-plan.md §19 S4, D-077/D-076): S1 shipped
// only the fields needed to typecheck the seam; S4 is where a real
// extraction actually happens and the model's output must carry enough
// to satisfy evidence's DB-enforced classification (ck_evidence_contract_
// v2_complete: pattern_step/component/directness/source_class/officiality
// all NOT NULL for a version-2 row). Adding fields here is additive, not
// breaking — no existing field's meaning changes.
export type EvidenceSourceClass =
  | "ONCHAIN_VERIFIABLE"
  | "OFFICIAL_DOCS"
  | "GOVERNANCE"
  | "OFFICIAL_REPORT"
  | "DATA_PROVIDER"
  | "RESEARCH_MEDIA"
  | "SOCIAL";

export type EvidenceOfficiality = "CONFIRMED" | "CLAIMED";

export interface ExtractedFact {
  step: number;
  component: string;
  // Normalized, model-composed summary — localizable, may paraphrase.
  statement: string;
  // The literal quoted excerpt from the fetched document that supports
  // `statement` — this is evidence.fragment ("оригинал, не переводится"),
  // kept distinct from `statement` precisely because the DB field is not
  // translated/normalized. A fact with no traceable excerpt here is not
  // extraction, it is invention (§7 "A model assertion without traceable
  // fetched-source support must not become persisted Evidence").
  supportFragment: string;
  mechanismState: string | null;
  directness: "DIRECT" | "INDIRECT" | "INFERRED";
  // S4 review fix (BLOCKER-1, D-074, §7.2): sourceClass/officiality are
  // DELIBERATELY ABSENT from this interface. Source authority is a two-
  // axis, code-computed decision (source-authority.ts) — the model is
  // never asked for it and has no field here to raise it even if it
  // tried. "The model may extract candidate factual content. The model
  // MUST NOT be authoritative for source authority."
  // Applicability time, where the document states one — optional, since
  // not every fetched page carries a publish date.
  publishedAt: Date | null;
  // What this fact explicitly does NOT establish — Proof Filter checkpoint
  // 6 (§12.2) requires every SUPPORTS-leaning extraction to carry this.
  doesNotProve: string;
  relationship: "SUPPORTS" | "CONTRADICTS" | "CONTEXT" | "LIMITS";
  // EXACT DOCUMENTARY LOCATOR — a concrete on-chain identifier (address,
  // account, program, transaction signature) this fact identifies, when
  // it identifies one. null for the overwhelming majority of facts, which
  // name no account at all.
  //
  // PROPOSED, NEVER TRUSTED. Like every other field here it is untrusted
  // model output, and unlike most of them it is checked by a dedicated
  // deterministic validator (documentary-locator.ts) before it can reach
  // the database: a truncated display form is refused, an incomplete
  // shape is refused, and a value that does not appear literally in the
  // document is refused. A model that ignores the instruction to prefer
  // the exact identifier therefore produces NO locator, never a wrong
  // one, and the fact itself is still admitted on its own merits.
  //
  // Not the same axis as entityBinding: this records WHICH identifier the
  // document states, never that the identifier is the project's. D-134
  // remains the only authority on that.
  onchainLocator?: string | null;
  // The SAME axis, for a fact that identifies MORE THAN ONE account — a
  // page listing two burn addresses under one heading states one fact
  // about two accounts, and splitting it into two facts to fit a scalar
  // would invent a distinction the document does not make.
  //
  // Merged with `onchainLocator` and validated PER VALUE: one bad entry
  // never contaminates a good one, and one good entry never launders a
  // bad one. Kept alongside the scalar rather than replacing it so every
  // existing caller and every historical row is untouched.
  onchainLocators?: readonly string[] | null;
}
