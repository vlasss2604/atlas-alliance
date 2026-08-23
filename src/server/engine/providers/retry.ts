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
// caught exception using the EXACT same rule as this module's own
// retryOnceIfTransient — never a second, divergent transient-detection
// heuristic.
export function isTransientError(e: unknown): boolean {
  return e instanceof Error && (e as Error & MaybeTransient).transient === true;
}

export async function retryOnceIfTransient<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isTransientError(e)) throw e;
    return await fn();
  }
}
