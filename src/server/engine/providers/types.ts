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

export interface ExtractedFact {
  step: number;
  component: string;
  statement: string;
  mechanismState: string | null;
  directness: "DIRECT" | "INDIRECT" | "INFERRED";
  // What this fact explicitly does NOT establish — Proof Filter checkpoint
  // 6 (§12.2) requires every SUPPORTS-leaning extraction to carry this.
  doesNotProve: string;
  relationship: "SUPPORTS" | "CONTRADICTS" | "CONTEXT" | "LIMITS";
}
