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
//
// S4 FINAL ACCEPTANCE FIX — production profile intentionally EMPTY until
// S10 (owner clarification, this round): D-090 requires a mathematically
// honest hard boundary on model INPUT. This codebase has no such
// mechanism today — a characters-per-token ratio is an approximation, not
// a proof, and breaks silently for Cyrillic/CJK/emoji/code/malformed text
// and any future tokenizer change. Anthropic's token-counting endpoint
// exists but is documented as an ESTIMATE, not a guaranteed hard bound —
// promoting it into a cost-safety guarantee here would be exactly the
// "invent another heuristic" the review prohibits. Until a genuinely
// owner-approved, provably-safe input-accounting mechanism exists
// (S10 territory), NO production model id resolves to a cost profile
// here — every real QueryProposer/EvidenceExtractor call fails closed
// (MODEL_COST_PROFILE_MISSING) rather than being priced on an unproven
// bound. This is deliberate and applies identically to BOTH model roles —
// D-090 protects every Research Engine model call, not just the one that
// happens to touch long fetched documents today.

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
  // A real, provable hard ceiling on the model's ACTUAL input/output
  // token count for the call this profile authorizes — not an estimate.
  // How that ceiling is enforced (e.g. a provider mechanism proven to
  // reject/truncate at an exact token count) is S10's job to establish
  // and get owner-approved; this type only carries the number once one
  // exists. See the module doc comment above for why none exists yet.
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

// PRODUCTION catalogue — intentionally EMPTY. See the module doc comment:
// no model id may resolve to a profile here until S10 delivers both (a)
// an owner-approved production profile and (b) a provably-safe input-
// accounting mechanism (not a chars/token heuristic, not an unqualified
// promotion of a "$0.000001-per-token, estimate" token-counting
// endpoint into a hard bound). Every real model call therefore fails
// closed via loadModelCostProfile below, for every configured model,
// for both QueryProposer and EvidenceExtractor alike.
//
// Tests use a STRUCTURALLY SEPARATE path — an explicit fixture
// ModelCostProfile object injected via S4ExecutorDeps
// (queryProposerCostProfile/evidenceExtractorCostProfile in
// s4-executor.ts) — never this catalogue. A fixture profile proves
// arithmetic, reservation ordering, and wiring; it never claims anything
// about real Anthropic billing safety.
const PRODUCTION_MODEL_COST_PROFILES: Record<string, ModelCostProfile> = {};

// Deterministic lookup — the ONLY place a model id resolves to a
// PRODUCTION profile. Throws ModelCostProfileMissingError (D-090
// fail-closed) rather than falling back to any default/guessed price —
// which, with an empty catalogue, means it throws for every model id
// today. That is the intended, reviewed behavior until S10.
export function loadModelCostProfile(modelId: string): ModelCostProfile {
  const profile = PRODUCTION_MODEL_COST_PROFILES[modelId];
  if (!profile) throw new ModelCostProfileMissingError(modelId);
  return profile;
}

// D-090 "round upward, not downward" — plain integer arithmetic, no
// floating point. maxInputTokens/maxOutputTokens/prices are already
// integers, so the product is exact; this is the THEORETICAL MAXIMUM
// possible cost for one call under this profile's bounds, never the
// actual cost of any particular call (real-usage reconciliation is out of
// scope for S4 — D-090).
export function calculateMaxAuthorizedCostMicro(profile: ModelCostProfile): number {
  const inputCostMicro = profile.maxInputTokens * profile.inputPriceMicroUsdPerToken;
  const outputCostMicro = profile.maxOutputTokens * profile.outputPriceMicroUsdPerToken;
  return inputCostMicro + outputCostMicro;
}
