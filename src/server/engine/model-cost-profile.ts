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
// S10 (live-provider-enablement.md §3/§4/§5, D-118) — this catalogue is
// now populated for exactly the two owner-approved production roles.
// Two structural changes from the S4-final/Stage-2 state:
//
// (a) ROLE-QUALIFIED IDENTITY. QUERY_PROPOSER and EVIDENCE_EXTRACTOR both
//     use modelId "claude-haiku-4-5" but need two DIFFERENT hard
//     ceilings (4,000/512 vs 48,000/1,536 tokens) — a catalogue keyed
//     only by modelId cannot hold two profiles for the same id. The
//     catalogue key is now `${role}:${modelId}`; the API model ID sent
//     to Anthropic remains the bare modelId (never the role-qualified
//     key — see providers/*-anthropic.ts, which only ever read
//     `profile.modelId`).
// (b) PROVABLE INPUT BOUND EXISTS NOW. D-090 previously kept this
//     catalogue empty because no provable (non-heuristic) mechanism
//     enforced maxInputTokens — a chars/token ratio is an approximation,
//     and promoting Anthropic's token-counting endpoint into an
//     unqualified guarantee would have been exactly the "invent a
//     heuristic" the review prohibited. S10 resolves this: every live
//     QueryProposer/EvidenceExtractor call now counts the EXACT request
//     shape via `client.messages.count_tokens` (providers/token-gate.ts)
//     BEFORE generation and refuses to call the model if the exact count
//     exceeds this profile's maxInputTokens — never a truncation, never
//     an estimate substituted for the real count. See token-gate.ts.
export interface ModelCostProfile {
  modelId: string;
  // Price per token, in micro-USD, rounded UP from the vendor's published
  // per-million-token price so a fractional-micro-USD price never
  // silently rounds the ceiling down.
  inputPriceMicroUsdPerToken: number;
  outputPriceMicroUsdPerToken: number;
  // A real, provable hard ceiling on the model's ACTUAL input/output
  // token count for the call this profile authorizes — enforced by the
  // count-then-gate mechanism in providers/token-gate.ts, not by
  // truncation or estimation. See the module doc comment above.
  maxInputTokens: number;
  maxOutputTokens: number;
  // Version/date identifier for the price data itself — when Anthropic's
  // published pricing changes, this profile is replaced by a new one
  // (code change), not silently mutated.
  priceVersion: string;
}

// The two roles a production model call can play in the S4 engine — the
// SAME closed pair s4-executor.ts's preflight() already resolves
// providers for. Not an open string: a role outside this pair cannot
// exist in the catalogue key, by construction.
// PROJECTION is a THIRD role, and the only one that runs after research
// has finished. Owner decision: it is exempt from the job's closed
// research budget — that budget measures acquisition, evidence and
// verification work, and this is bounded post-research presentation work —
// but it must still be economically observable. It therefore takes a
// profile here like any other role, so its ceiling is approved in the same
// version-controlled place and its actual cost is computed by the same
// arithmetic. Exempt from the budget is not exempt from the books.
export type ModelRole = "QUERY_PROPOSER" | "EVIDENCE_EXTRACTOR" | "PROJECTION" | "AUDIT";

export class ModelCostProfileMissingError extends Error {
  constructor(
    public readonly role: ModelRole,
    public readonly modelId: string,
  ) {
    super(`MODEL_COST_PROFILE_MISSING: no approved cost profile for role "${role}" + model "${modelId}"`);
    this.name = "ModelCostProfileMissingError";
  }
}

function catalogueKey(role: ModelRole, modelId: string): string {
  return `${role}:${modelId}`;
}

// PRODUCTION catalogue — role-qualified, code-owned, version-controlled
// (same discipline as source-authority.ts's domain lists: changing a
// price/ceiling is a reviewed code change, never a runtime/DB mutation
// and never a live pricing API call). Exactly the two owner-approved
// S10 internal-alpha profiles (owner decision §2/§4, priceVersion
// "anthropic-2026-08") — no speculative models added.
//
// Tests use a STRUCTURALLY SEPARATE path — an explicit fixture
// ModelCostProfile object injected via S4ExecutorDeps
// (queryProposerCostProfile/evidenceExtractorCostProfile in
// s4-executor.ts) — never this catalogue.
const PRODUCTION_MODEL_COST_PROFILES: Record<string, ModelCostProfile> = {
  [catalogueKey("QUERY_PROPOSER", "claude-haiku-4-5")]: {
    modelId: "claude-haiku-4-5",
    inputPriceMicroUsdPerToken: 1,
    outputPriceMicroUsdPerToken: 5,
    maxInputTokens: 4_000,
    maxOutputTokens: 512,
    priceVersion: "anthropic-2026-08",
  },
  [catalogueKey("EVIDENCE_EXTRACTOR", "claude-haiku-4-5")]: {
    modelId: "claude-haiku-4-5",
    inputPriceMicroUsdPerToken: 1,
    outputPriceMicroUsdPerToken: 5,
    maxInputTokens: 48_000,
    maxOutputTokens: 1_536,
    priceVersion: "anthropic-2026-08",
  },
  // The projection sees a compact status summary — never a document, a
  // fragment, a url or a provider response — so its input ceiling is small
  // by design rather than by trimming. 4k in / 512 out bounds one call at
  // 4_000×1 + 512×5 = 6_560 micro-USD, roughly a tenth of a SINGLE
  // evidence-extraction call's ceiling and a small fraction of a research
  // job, which makes one call per completed Proof economically trivial.
  [catalogueKey("PROJECTION", "claude-haiku-4-5")]: {
    modelId: "claude-haiku-4-5",
    inputPriceMicroUsdPerToken: 1,
    outputPriceMicroUsdPerToken: 5,
    maxInputTokens: 4_000,
    maxOutputTokens: 512,
    priceVersion: "anthropic-2026-08",
  },
  // AUDIT is the FOURTH role, and like PROJECTION it runs only after
  // research — it can never widen, extend or influence a research job.
  // Its input is larger than PROJECTION's because it also lists the run's
  // sources by class, but it is still identifiers, statuses and counts:
  // no document, no fragment, no full url, no provider response. 8k in /
  // 1k out bounds one call at 8_000×1 + 1_024×5 = 13_120 micro-USD —
  // about 1.3 US cents, and it is charged at most ONCE per job, only if a
  // human actually opens the audit.
  [catalogueKey("AUDIT", "claude-haiku-4-5")]: {
    modelId: "claude-haiku-4-5",
    inputPriceMicroUsdPerToken: 1,
    outputPriceMicroUsdPerToken: 5,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_024,
    priceVersion: "anthropic-2026-08",
  },
};

// Deterministic lookup — the ONLY place a (role, model id) pair resolves
// to a PRODUCTION profile. Throws ModelCostProfileMissingError (D-090
// fail-closed) rather than falling back to any default/guessed price, or
// to the OTHER role's profile for the same modelId — a missing exact
// role+model combination fails closed BEFORE any reservation or call
// (owner decision §3).
export function loadModelCostProfile(role: ModelRole, modelId: string): ModelCostProfile {
  const profile = PRODUCTION_MODEL_COST_PROFILES[catalogueKey(role, modelId)];
  if (!profile) throw new ModelCostProfileMissingError(role, modelId);
  return profile;
}

// D-090 "round upward, not downward" — plain integer arithmetic, no
// floating point. maxInputTokens/maxOutputTokens/prices are already
// integers, so the product is exact; this is the THEORETICAL MAXIMUM
// possible cost for one call under this profile's bounds — the
// RESERVATION ceiling, never the actual cost of any particular call.
// Actual cost (from real provider usage) is a separate, audit-only
// computation using the same profile's prices — see
// calculateActualCostMicro below and s4-executor.ts's usage capture.
export function calculateMaxAuthorizedCostMicro(profile: ModelCostProfile): number {
  const inputCostMicro = profile.maxInputTokens * profile.inputPriceMicroUsdPerToken;
  const outputCostMicro = profile.maxOutputTokens * profile.outputPriceMicroUsdPerToken;
  return inputCostMicro + outputCostMicro;
}

// S10 (live-provider-enablement.md §7) — actual cost from REAL provider
// usage, priced with the SAME approved profile used to reserve the call
// (never a dynamic pricing lookup). AUDIT ONLY: never subtracted from or
// compared against research_jobs.*Reserved — the reservation computed by
// calculateMaxAuthorizedCostMicro above remains the sole execution
// authority (owner decision, explicit: "do not refund reservations, do
// not decrement reserved counters using actual usage").
export function calculateActualCostMicro(profile: ModelCostProfile, usage: { inputTokens: number; outputTokens: number }): number {
  return usage.inputTokens * profile.inputPriceMicroUsdPerToken + usage.outputTokens * profile.outputPriceMicroUsdPerToken;
}
