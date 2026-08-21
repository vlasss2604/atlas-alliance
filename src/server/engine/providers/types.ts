// Phase 6, S1 — shared provider-seam types (phase-6-plan.md §4.1, §7).
// These are the ONLY vocabulary the controller (S3) and provider seams
// exchange. None of these types imply orchestration: a provider returns
// candidates/content/facts for a single requested unit of work and does
// nothing else — scope, budget, eligibility and stopping remain the
// controller's job (D-070).

// One (step, component) unit of work — the same shape ContractView (S0)
// produces, kept here so provider modules don't need to import engine
// internals just for these four fields.
export interface ComponentTarget {
  step: number;
  stepName: string;
  component: string;
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
  // Two-axis authority (§7.2) — deterministic from the source, not from
  // how many times something like it was said (no repetition-as-authority).
  sourceClass: EvidenceSourceClass;
  officiality: EvidenceOfficiality;
  // Applicability time, where the document states one — optional, since
  // not every fetched page carries a publish date.
  publishedAt: Date | null;
  // What this fact explicitly does NOT establish — Proof Filter checkpoint
  // 6 (§12.2) requires every SUPPORTS-leaning extraction to carry this.
  doesNotProve: string;
  relationship: "SUPPORTS" | "CONTRADICTS" | "CONTEXT" | "LIMITS";
}
