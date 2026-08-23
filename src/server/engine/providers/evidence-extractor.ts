import type { ComponentTarget, ExtractedFact, FetchedDocument, ModelUsage } from "./types";

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

export const DEFAULT_EVIDENCE_EXTRACTOR_MODEL = "claude-haiku-4-5";

// S10 LAST HIGH CLOSURE (HIGH-2, D-121) — same shape as
// resolveQueryProposer(): async, MODEL_GATEWAY-driven, now EAGER on a
// missing ANTHROPIC_API_KEY (corrected from the prior lazy-failure
// discipline — see resolveQueryProposer's doc comment for the full
// reasoning). `maxOutputTokens` (D-090, phase-6-plan.md §5.6): see
// resolveQueryProposer's doc comment — same discipline.
export async function resolveEvidenceExtractor(
  model?: string,
  maxOutputTokens?: number,
  maxInputTokens?: number,
  onUsage?: (usage: ModelUsage) => void,
): Promise<EvidenceExtractor> {
  if (_override) return _override;
  const kind = process.env.MODEL_GATEWAY ?? "anthropic";
  if (kind === "fake") {
    throw new EvidenceExtractorUnavailableError(
      "MODEL_GATEWAY=fake has no built-in EvidenceExtractor fixture — " +
        "tests must call __setEvidenceExtractor() with a fixture-backed implementation",
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new EvidenceExtractorUnavailableError("ANTHROPIC_API_KEY is not set");
  }
  const { createAnthropicEvidenceExtractor } = await import("./evidence-extractor-anthropic");
  return createAnthropicEvidenceExtractor(
    model ?? process.env.EVIDENCE_EXTRACTOR_MODEL ?? DEFAULT_EVIDENCE_EXTRACTOR_MODEL,
    maxOutputTokens,
    maxInputTokens,
    onUsage,
  );
}
