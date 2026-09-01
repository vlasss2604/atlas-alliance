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

// D-153 — ONE MALFORMED FACT IS NOT A FAILED EXTRACTION.
//
// What a per-fact rejection is allowed to say. `index` is this code's own
// position counter over the response array, and `field` is the same closed,
// code-owned schema vocabulary a whole-response failure already reports. No
// model-derived text and no rejected value ever appears here — the report
// says WHICH element failed and WHICH code-owned field rejected it, and
// nothing about what the model actually wrote.
export interface RejectedFactReport {
  index: number;
  field: ExtractorSchemaField;
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

// WHICH schema field failed, for OUTPUT_SCHEMA_INVALID — the smallest
// closed refinement that distinguishes schema mismatches. A live window
// (job eb00256a-…) named the class and nothing could say the field: the
// zod message is model-derived text and correctly never crosses, but the
// FIELD PATHS are code-owned, finite names authored in
// extractedFactSchema (evidence-extractor-anthropic.ts) — safe to say by
// construction. Values are never exposed; only which code-owned field
// rejected them.
//
// The list mirrors the schema's own shape: ROOT (the output is not the
// result object at all), FACTS (the facts array itself — missing, not an
// array, an element that is not an object, or over the length cap), one
// code per fact field, and UNKNOWN_SCHEMA_FIELD for any path this map
// does not recognise — a renamed schema field fails SAFE to "unknown",
// never to a guessed or pass-through name.
export const EXTRACTOR_SCHEMA_FIELDS = [
  "ROOT",
  "FACTS",
  "FACTS_STEP",
  "FACTS_COMPONENT",
  "FACTS_STATEMENT",
  "FACTS_SUPPORT_FRAGMENT",
  "FACTS_MECHANISM_STATE",
  "FACTS_DIRECTNESS",
  "FACTS_PUBLISHED_AT",
  "FACTS_DOES_NOT_PROVE",
  "FACTS_RELATIONSHIP",
  "FACTS_ONCHAIN_LOCATOR",
  "FACTS_ONCHAIN_LOCATORS",
  "UNKNOWN_SCHEMA_FIELD",
] as const;

export type ExtractorSchemaField = (typeof EXTRACTOR_SCHEMA_FIELDS)[number];

const EXTRACTOR_SCHEMA_FIELD_SET: ReadonlySet<string> = new Set<string>(EXTRACTOR_SCHEMA_FIELDS);

// Same two-gate discipline as every other closed vocabulary here.
export function isExtractorSchemaField(v: unknown): v is ExtractorSchemaField {
  return typeof v === "string" && EXTRACTOR_SCHEMA_FIELD_SET.has(v);
}

// Schema field name -> closed code. A Map, deliberately not a plain
// object: an attacker-influenced path segment like "constructor" or
// "__proto__" must miss cleanly, never resolve through the prototype
// chain.
const FACT_FIELD_CODES: ReadonlyMap<string, ExtractorSchemaField> = new Map([
  ["step", "FACTS_STEP"],
  ["component", "FACTS_COMPONENT"],
  ["statement", "FACTS_STATEMENT"],
  ["supportFragment", "FACTS_SUPPORT_FRAGMENT"],
  ["mechanismState", "FACTS_MECHANISM_STATE"],
  ["directness", "FACTS_DIRECTNESS"],
  ["publishedAt", "FACTS_PUBLISHED_AT"],
  ["doesNotProve", "FACTS_DOES_NOT_PROVE"],
  ["relationship", "FACTS_RELATIONSHIP"],
  ["onchainLocator", "FACTS_ONCHAIN_LOCATOR"],
  ["onchainLocators", "FACTS_ONCHAIN_LOCATORS"],
]);

// The ONE reduction of a zod validation failure to the closed field
// vocabulary. Contract, chosen as the smallest deterministic one:
//
//   - FIRST issue only. zod validates in schema-shape order, so for a
//     given (schema, output) pair the first issue is stable — verified
//     empirically: an object missing every fact field reports "step"
//     first, every run. One code, no arrays, no caps to reason about.
//   - Numeric array indices are dropped (facts[3].step and facts[0].step
//     are the same statement about the same schema field); non-string
//     segments of any other kind are ignored the same way.
//   - Every mapping is a Map lookup against the closed table — no path
//     segment is ever concatenated, joined, or passed through into the
//     result, so an arbitrary path structurally cannot become output.
//
// Accepts a structural { path } shape rather than importing zod: the
// seam stays dependency-free, and a forged issues array degrades to a
// closed value like everything else.
export function classifyExtractionSchemaFailure(
  issues: ReadonlyArray<{ path: ReadonlyArray<unknown> }> | undefined,
): ExtractorSchemaField {
  const first = issues?.[0];
  if (!first || !Array.isArray(first.path)) return "UNKNOWN_SCHEMA_FIELD";
  const segments = first.path.filter((s): s is string => typeof s === "string");
  if (segments.length === 0) return "ROOT";
  if (segments[0] !== "facts") return "UNKNOWN_SCHEMA_FIELD";
  if (segments.length === 1) return "FACTS";
  if (segments.length === 2) return FACT_FIELD_CODES.get(segments[1]) ?? "UNKNOWN_SCHEMA_FIELD";
  return "UNKNOWN_SCHEMA_FIELD";
}

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
    // WHICH schema field failed — meaningful only alongside
    // diagnostic === "OUTPUT_SCHEMA_INVALID", set only by that branch's
    // classifyExtractionSchemaFailure product. Null everywhere else
    // (default keeps every existing constructor call valid), and the
    // boundary refuses it unless the diagnostic really is the schema one.
    public readonly schemaField: ExtractorSchemaField | null = null,
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
  // D-153 — same capture-box convention as onUsage: the provider reports,
  // the caller decides what to record. Optional, so every existing call
  // site and every fixture extractor stays valid.
  onRejectedFacts?: (rejected: readonly RejectedFactReport[]) => void,
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
    onRejectedFacts,
  );
}
