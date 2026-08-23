// S10 (live-provider-enablement.md §8, D-118) — the ONE retry policy
// shape reused by every live provider that gets a single retry
// (SearchGateway, QueryProposer, EvidenceExtractor, count_tokens):
// exactly one retry, exactly two total external attempts, and ONLY when
// the failure is classified transient by the provider's own typed error
// (`.transient === true` — 429/5xx/network, never a deterministic 4xx,
// never schema-invalid output, never max_tokens truncation). Living here
// once means every consumer gets identical "2 total attempts maximum"
// semantics instead of four independently-hand-rolled loops.
//
// ContentFetcher deliberately does NOT use this — 0 retries is the
// owner-approved policy for FETCH (move to the next candidate instead).

interface MaybeTransient {
  transient?: boolean;
}

function isTransient(e: unknown): boolean {
  return e instanceof Error && (e as Error & MaybeTransient).transient === true;
}

export async function retryOnceIfTransient<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isTransient(e)) throw e;
    return await fn();
  }
}
