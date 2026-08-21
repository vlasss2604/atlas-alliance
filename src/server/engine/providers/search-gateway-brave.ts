import { SearchProviderUnavailableError } from "./search-gateway";
import type { SearchGateway } from "./search-gateway";
import type { ComponentTarget, SourceCandidate } from "./types";

// Phase 6 — live SearchGateway over the Brave Search API (Web Search),
// the production provider choice for P2. A plain authenticated HTTPS GET
// against a fixed endpoint — no SDK dependency, matching the "smallest
// PostgreSQL/HTTP-native mechanism" preference already used elsewhere in
// this codebase. Returns candidate URLs only (§7.1, D-076): a result
// snippet is never treated as Evidence here or by any caller — Evidence
// requires ContentFetcher to actually open the document.

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const REQUEST_TIMEOUT_MS = 10_000;

export function createBraveSearchGateway(apiKey: string): SearchGateway {
  return {
    name: "brave",
    async search(
      query: string,
      _target: ComponentTarget,
      opts: { maxResults: number },
    ): Promise<SourceCandidate[]> {
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.max(1, Math.min(opts.maxResults, 20))));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
          signal: controller.signal,
        });
      } catch (e) {
        throw new SearchProviderUnavailableError(
          `Brave Search request failed: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        throw new SearchProviderUnavailableError(`Brave Search returned HTTP ${res.status}`, transient);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new SearchProviderUnavailableError("Brave Search response was not valid JSON", true);
      }

      const results = (body as { web?: { results?: unknown[] } })?.web?.results ?? [];
      const candidates: SourceCandidate[] = [];
      for (const raw of results) {
        const r = raw as { url?: unknown; title?: unknown; description?: unknown };
        if (typeof r.url !== "string" || r.url.length === 0) continue; // malformed entry — skip, don't fabricate
        candidates.push({
          url: r.url,
          title: typeof r.title === "string" ? r.title : null,
          snippet: typeof r.description === "string" ? r.description : null,
        });
      }
      return candidates.slice(0, opts.maxResults);
    },
  };
}
