import type { ComponentTarget, SourceCandidate } from "./types";

// Phase 6, S1 — SearchGateway (phase-6-plan.md §4.1, §7.1).
//
// Returns candidate URLs for a query — nothing more. It does not judge
// truth, does not fetch content, and a search-result snippet is never
// treated as evidence (§7.1, D-076): SearchGateway only tells the
// controller what ContentFetcher should try to open next.
//
// P2 (search provider selection + API key) is not resolved yet
// (phase-6-plan.md §21). This module therefore ships the interface and a
// deterministic fixture-backed implementation for tests only; production
// has no configured provider and must fail loudly rather than silently
// use the fixture (no fake-in-production fallback, matching the
// established interpreter/gateway.ts pattern).

export interface SearchGateway {
  readonly name: string;
  search(
    query: string,
    target: ComponentTarget,
    opts: { maxResults: number },
  ): Promise<SourceCandidate[]>;
}

export class SearchProviderUnavailableError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
  ) {
    super(message);
    this.name = "SearchProviderUnavailableError";
  }
}

let _override: SearchGateway | null = null;

// Test-only. There is no production "fake" branch — see module comment.
export function __setSearchGateway(g: SearchGateway | null): void {
  _override = g;
}

// Throws until a live provider is selected (P2) and wired here as a real
// branch — deliberately does NOT fall back to a fixture in production.
export function resolveSearchGateway(): SearchGateway {
  if (_override) return _override;
  throw new SearchProviderUnavailableError(
    "no SearchGateway provider is configured for production (P2 not yet resolved) — " +
      "tests must call __setSearchGateway() with a fixture-backed implementation",
  );
}
