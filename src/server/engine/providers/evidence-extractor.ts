import type { ComponentTarget, ExtractedFact, FetchedDocument } from "./types";

// Phase 6, S1 — EvidenceExtractor seam (phase-6-plan.md §4.1 table, §16).
//
// A model role: extracts schema-validated facts from ONE already-fetched
// document for ONE requested component. It never follows links, never
// calls tools, and never concludes anything about the component as a
// whole (that is ComponentReconciler's job, S5) — it only reports what
// this one document says.
//
// The fetched document is passed in as `FetchedDocument.normalizedText` —
// already stripped of scripts/styles by ContentFetcher (S1) — and MUST be
// treated as untrusted data by any real implementation: nothing found
// inside it may be interpreted as an instruction (§16, canon self-check
// 3 "инъекция в контенте"). Live wiring belongs to S4; this slice only
// fixes the contract.

export interface EvidenceExtractionInput {
  target: ComponentTarget;
  document: FetchedDocument;
}

export interface EvidenceExtractor {
  readonly name: string;
  extract(input: EvidenceExtractionInput): Promise<ExtractedFact[]>;
}

export class EvidenceExtractorUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
  ) {
    super(message);
    this.name = "EvidenceExtractorUnavailableError";
  }
}

let _override: EvidenceExtractor | null = null;

export function __setEvidenceExtractor(e: EvidenceExtractor | null): void {
  _override = e;
}

// P3 not resolved yet — same no-silent-fallback rule as query-proposer.ts.
export function resolveEvidenceExtractor(): EvidenceExtractor {
  if (_override) return _override;
  throw new EvidenceExtractorUnavailableError(
    "no EvidenceExtractor model role is configured for production (P3 not yet resolved) — " +
      "tests must call __setEvidenceExtractor() with a fixture-backed implementation",
  );
}
