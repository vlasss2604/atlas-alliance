// Phase 6, S4 final implementation (D-090, phase-6-plan.md §5.6) —
// maxModelCostMicro is a hard authorization ceiling in real micro-USD, not
// an abstract internal unit. Every model call this file's consumers make
// must be priced from an APPROVED, version-controlled cost profile before
// the call — never a live pricing API, never a guess.
//
// Order (D-090, non-negotiable): bound input -> bound output -> estimate
// cost from the SAME bounds -> reserve -> call. A reservation is only a
// real upper bound if the call is actually constrained by the same
// numbers it was priced with.

// A production model without an entry here fails closed (D-090) — no
// live call happens. This catalogue is code-owned and version-controlled,
// the same discipline as source-authority.ts's domain lists: changing a
// price or a model's limits is a code change (reviewed, committed), never
// a runtime/DB mutation and never a live pricing API call.
export interface ModelCostProfile {
  modelId: string;
  // Price per token, in micro-USD, rounded UP from the vendor's published
  // per-million-token price so a fractional-micro-USD price never
  // silently rounds the ceiling down.
  inputPriceMicroUsdPerToken: number;
  outputPriceMicroUsdPerToken: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  // Version/date identifier for the price data itself — when Anthropic's
  // published pricing changes, this profile is replaced by a new one
  // (code change), not silently mutated.
  priceVersion: string;
}

export class ModelCostProfileMissingError extends Error {
  constructor(public readonly modelId: string) {
    super(`MODEL_COST_PROFILE_MISSING: no approved cost profile for model "${modelId}"`);
    this.name = "ModelCostProfileMissingError";
  }
}

// Prices from Anthropic's published per-million-token rates, converted to
// micro-USD/token and rounded UP (Math.ceil) — never down — so the
// per-token price itself can never understate the vendor's real price.
// claude-haiku-4-5: $1.00/1M input -> 1 micro-USD/token exactly;
// $5.00/1M output -> 5 micro-USD/token exactly.
const MODEL_COST_PROFILES: Record<string, ModelCostProfile> = {
  "claude-haiku-4-5": {
    modelId: "claude-haiku-4-5",
    inputPriceMicroUsdPerToken: 1,
    outputPriceMicroUsdPerToken: 5,
    // QueryProposer/EvidenceExtractor inputs are one bounded document or
    // task description, never a multi-turn/agentic context — a few
    // thousand tokens is generous for either role while staying well
    // inside Haiku's 200K context window.
    maxInputTokens: 8_000,
    maxOutputTokens: 1_536,
    priceVersion: "anthropic-published-2026-06-24",
  },
};

// Deterministic lookup — the ONLY place a model id resolves to pricing.
// Throws ModelCostProfileMissingError (D-090 fail-closed) rather than
// falling back to any default/guessed price.
export function loadModelCostProfile(modelId: string): ModelCostProfile {
  const profile = MODEL_COST_PROFILES[modelId];
  if (!profile) throw new ModelCostProfileMissingError(modelId);
  return profile;
}

// D-090 "round upward, not downward" — plain integer arithmetic, no
// floating point. maxInputTokens/maxOutputTokens/prices are already
// integers, so the product is exact; this is the THEORETICAL MAXIMUM
// possible cost for one call under this profile's bounds, never the
// actual cost of any particular call (that would require knowing real
// usage, which D-090 explicitly does not require this round).
export function calculateMaxAuthorizedCostMicro(profile: ModelCostProfile): number {
  const inputCostMicro = profile.maxInputTokens * profile.inputPriceMicroUsdPerToken;
  const outputCostMicro = profile.maxOutputTokens * profile.outputPriceMicroUsdPerToken;
  return inputCostMicro + outputCostMicro;
}

// Deterministic, conservative input bounding (§8 "INPUT BOUNDING"). No
// real tokenizer is wired into this codebase, so token count is
// approximated with a CONSERVATIVE (i.e. UNDER-counting) characters-per-
// token ratio — the bound must never let more real tokens through than
// maxInputTokens permits, so it is safer to truncate MORE than the exact
// token boundary would require than to truncate less. English text
// commonly averages ~4 chars/token; using 3 chars/token as the floor
// keeps the truncation conservative even for token-dense text.
const CONSERVATIVE_CHARS_PER_TOKEN = 3;

export function maxInputCharsFor(profile: ModelCostProfile): number {
  return profile.maxInputTokens * CONSERVATIVE_CHARS_PER_TOKEN;
}

// Truncates `text` to the profile's deterministic input bound. Preserves
// traceability semantics per §8: if a document's genuine support fragment
// lives outside the bounded (model-visible) portion, the extractor simply
// cannot see it and will not report it — that is the correct, honest
// outcome (no fabricated evidence from unseen content), not a bug to work
// around here.
export function boundInputText(text: string, profile: ModelCostProfile): string {
  const maxChars = maxInputCharsFor(profile);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
