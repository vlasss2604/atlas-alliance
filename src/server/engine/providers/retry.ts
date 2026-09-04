import Anthropic from "@anthropic-ai/sdk";

// S10 acceptance closure (BLOCKER-2, D-119) — this module now owns ONLY
// the count_tokens retry (kept provider-internal, non-billable, per
// owner instruction: "It may retain at most one transient retry").
// SearchGateway/QueryProposer/EvidenceExtractor no longer self-retry
// here — every billable/budgeted external attempt now goes through
// s4-executor.ts's own reserveAndCallWithRetry, which reserves BEFORE
// every attempt (including a retry) so one reservation can never
// authorize two real external calls (the BLOCKER-2 defect this closure
// fixes). Provider primitives (search-gateway-brave.ts's doSearch,
// query-proposer-anthropic.ts's doProposeQueries, evidence-extractor-
// anthropic.ts's doExtract) each perform exactly ONE external attempt —
// s4-executor.ts calls them a second time itself, with a fresh
// reservation, if a retry is warranted.
//
// ContentFetcher deliberately never used this — 0 retries is the
// owner-approved policy for FETCH (move to the next candidate instead).

interface MaybeTransient {
  transient?: boolean;
}

// Exported so s4-executor.ts's reserveAndCallWithRetry classifies a
// caught (already-wrapped, own-typed) exception using the EXACT same
// rule as this module's own retryOnceIfTransient default — never a
// second, divergent transient-detection heuristic. This classifier only
// works on an error that already carries a normalized `.transient` flag
// (query-proposer-anthropic.ts/evidence-extractor-anthropic.ts/
// search-gateway-brave.ts compute and attach it before throwing their
// own typed error) — it is the WRONG classifier for a RAW, not-yet-
// wrapped Anthropic SDK exception; use isTransientAnthropicApiError for
// that (see MEDIUM-1 below).
export function isTransientError(e: unknown): boolean {
  return e instanceof Error && (e as Error & MaybeTransient).transient === true;
}

// S10 final pre-smoke closure (MEDIUM-1, D-120) — the ONE shared
// classifier for a RAW (not yet wrapped in one of this codebase's own
// typed provider errors) Anthropic SDK exception: 429, no distinguishable
// status (network/timeout/unknown), or any 5xx. This is the SAME rule
// query-proposer-anthropic.ts and evidence-extractor-anthropic.ts already
// compute independently in their own catch blocks before wrapping into
// QueryProposerUnavailableError/EvidenceExtractorUnavailableError — all
// three call sites (those two, plus token-gate.ts's own count_tokens
// retry below) now share this ONE function so the rule can never drift
// between them. Previously (the BLOCKER-1 defect this closure fixes),
// token-gate.ts wrapped `retryOnceIfTransient(() => client.messages.
// countTokens(...))` around the RAW SDK call — but isTransientError only
// recognizes an error carrying `.transient === true`, a field the raw
// SDK exception never has (it is computed by the CALLER, in the catch
// block AFTER this retry already decided not to retry). A genuinely
// transient 503/429/network failure on count_tokens attempt #1 therefore
// never retried in practice. Fixed by classifying the RAW exception with
// this function, before it is wrapped into anything.
export function isTransientAnthropicApiError(e: unknown): boolean {
  const status = e instanceof Anthropic.APIError ? e.status : undefined;
  return status === 429 || status === undefined || (status >= 500 && status < 600);
}

// `isTransient` defaults to isTransientError (the pre-existing default
// every caller except token-gate.ts still wants — retrying an already-
// classified, already-wrapped typed error). token-gate.ts passes
// isTransientAnthropicApiError explicitly (MEDIUM-1) since it retries a
// RAW SDK call, not a wrapped one — one retry-loop implementation, two
// pluggable classification rules, never two divergent retry mechanics.
export async function retryOnceIfTransient<T>(
  fn: () => Promise<T>,
  isTransient: (e: unknown) => boolean = isTransientError,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isTransient(e)) throw e;
    return await fn();
  }
}
