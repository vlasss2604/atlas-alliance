import type { TokenCountDiagnostic } from "./token-gate";
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

// WHY the generation call failed, on the OUTPUT side — the three
// conditions the generation path itself can identify deterministically,
// each emitted only from its own branch (never inferred from anything
// else, and in particular never inferred from absent usage columns):
//   - MAX_TOKENS_TRUNCATED   — the response's own stop_reason was
//                              "max_tokens"; the output hit the approved
//                              ceiling before completing.
//   - OUTPUT_NOT_JSON        — the completed output failed JSON.parse.
//   - OUTPUT_SCHEMA_INVALID  — the parsed JSON failed the extraction
//                              schema.
// Provider/API failures are NOT here: those are classified by the ONE
// shared raw-SDK classifier (token-gate.ts, e7c422c) into its own closed
// vocabulary. A boundary that admits a generation diagnostic admits the
// union of the two closed lists — see s4-executor.ts's safeFailureDetail.
//
// A live Stage B window (job b3457f0b-…) died printing only
// EVIDENCE_EXTRACTOR_UNAVAILABLE + trace PROVIDER_ERROR, and nothing
// persisted could say whether the provider refused the request or the
// output truncated at the ceiling — situations whose next actions have
// nothing in common. This list is the generation-side half of the same
// fix count_tokens already received.
export const EXTRACTOR_OUTPUT_DIAGNOSTICS = [
  "MAX_TOKENS_TRUNCATED",
  "OUTPUT_NOT_JSON",
  "OUTPUT_SCHEMA_INVALID",
] as const;

export type ExtractorOutputDiagnostic = (typeof EXTRACTOR_OUTPUT_DIAGNOSTICS)[number];

const EXTRACTOR_OUTPUT_DIAGNOSTIC_SET: ReadonlySet<string> = new Set<string>(EXTRACTOR_OUTPUT_DIAGNOSTICS);

// The runtime gate — same discipline as isTokenCountDiagnostic: the type
// alone vouches for nothing, because a runtime value can violate a
// compile-time union. Membership here is one of the two ways a generation
// diagnostic may cross an observability boundary (the other being
// membership of the shared provider-failure vocabulary).
export function isExtractorOutputDiagnostic(v: unknown): v is ExtractorOutputDiagnostic {
  return typeof v === "string" && EXTRACTOR_OUTPUT_DIAGNOSTIC_SET.has(v);
}

// The full closed vocabulary a generation failure may carry: a provider
// class (shared with count_tokens — one classifier, one list, never a
// drifting copy) or an output class from this module's own list above.
// The import is type-only, so this seam stays free of any runtime SDK
// dependency.
export type EvidenceExtractorDiagnostic = TokenCountDiagnostic | ExtractorOutputDiagnostic;

export class EvidenceExtractorUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
    // Closed classification of WHY, decided at the throw site — the only
    // place still holding the raw condition (the SDK exception, the
    // response's stop_reason, the parse/validation outcome). Defaults
    // keep every existing constructor call valid, and — unlike
    // TokenCountUnavailableError, which has exactly one throw site — this
    // class is also thrown for resolve-time configuration failures that
    // are NOT generation failures, so the honest default is null ("no
    // generation diagnostic"), never a guessed class.
    public readonly diagnostic: EvidenceExtractorDiagnostic | null = null,
    public readonly httpStatus: number | null = null,
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
