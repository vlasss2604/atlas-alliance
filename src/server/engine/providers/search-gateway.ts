import { createBraveSearchGateway } from "./search-gateway-brave";
import type { ComponentTarget, MeteredProvider, SourceCandidate } from "./types";

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

export interface SearchGateway extends MeteredProvider {
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

// P2 resolved (S4): Brave Search is the chosen production provider
// (search-gateway-brave.ts), selected via SEARCH_GATEWAY_PROVIDER (same
// env-driven kind-switch shape as MODEL_GATEWAY). Deliberately still does
// NOT fall back to a fixture in production: with no key configured this
// throws exactly as before, naming the actual missing prerequisite
// (BRAVE_SEARCH_API_KEY) instead of a generic "P2 not resolved" — a real
// production configuration boundary, not a fake success.
export function resolveSearchGateway(): SearchGateway {
  if (_override) return _override;
  const provider = process.env.SEARCH_GATEWAY_PROVIDER ?? "brave";
  if (provider !== "brave") {
    throw new SearchProviderUnavailableError(
      `unknown SEARCH_GATEWAY_PROVIDER=${provider} — only "brave" is implemented; ` +
        "tests must call __setSearchGateway() with a fixture-backed implementation",
    );
  }
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new SearchProviderUnavailableError(
      "BRAVE_SEARCH_API_KEY is not set — no SearchGateway provider is usable in this environment " +
        "(live-provider verification is an environment prerequisite, not a code gap); " +
        "tests must call __setSearchGateway() with a fixture-backed implementation",
    );
  }
  return createBraveSearchGateway(apiKey);
}
