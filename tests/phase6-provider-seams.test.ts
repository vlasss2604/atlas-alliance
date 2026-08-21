import { afterEach, describe, expect, it } from "vitest";

import {
  __setEvidenceExtractor,
  EvidenceExtractorUnavailableError,
  resolveEvidenceExtractor,
  type EvidenceExtractor,
} from "../src/server/engine/providers/evidence-extractor";
import {
  __setQueryProposer,
  QueryProposerUnavailableError,
  resolveQueryProposer,
  type QueryProposer,
} from "../src/server/engine/providers/query-proposer";
import {
  __setSearchGateway,
  resolveSearchGateway,
  SearchProviderUnavailableError,
  type SearchGateway,
} from "../src/server/engine/providers/search-gateway";

// Phase 6, S1 — provider-seam contract tests for the three roles that
// need an unresolved live provider (P2 SearchGateway, P3 QueryProposer/
// EvidenceExtractor — phase-6-plan.md §21). What matters at S1 is that
// these seams exist, are typed, and NEVER silently fall back to a fake in
// production: resolve*() must throw until a real branch is wired in a
// later slice, exactly like resolveInterpreterGateway()'s existing
// no-fake-in-production rule.

describe("Фаза 6, S1 — SearchGateway: без provider'а production падает явно, тесты подставляют фикстуру", () => {
  afterEach(() => __setSearchGateway(null));

  it("без конфигурации resolveSearchGateway() бросает, а не тихо использует fake", () => {
    expect(() => resolveSearchGateway()).toThrow(
      SearchProviderUnavailableError,
    );
  });

  it("тестовая фикстура через __setSearchGateway работает детерминированно", async () => {
    const fixture: SearchGateway = {
      name: "fixture",
      async search(query, target) {
        return [
          {
            url: `https://example.com/${target.component}`,
            title: query,
            snippet: null,
          },
        ];
      },
    };
    __setSearchGateway(fixture);
    const results = await resolveSearchGateway().search(
      "does the buyback happen",
      {
        step: 3,
        stepName: "Allocation Mechanism",
        component: "MECHANISM_SPEC",
      },
      { maxResults: 5 },
    );
    expect(results).toEqual([
      {
        url: "https://example.com/MECHANISM_SPEC",
        title: "does the buyback happen",
        snippet: null,
      },
    ]);
  });
});

describe("Фаза 6, S1 — QueryProposer: без provider'а production падает явно, тесты подставляют фикстуру", () => {
  afterEach(() => __setQueryProposer(null));

  it("без конфигурации resolveQueryProposer() бросает, а не тихо использует fake", () => {
    expect(() => resolveQueryProposer()).toThrow(QueryProposerUnavailableError);
  });

  it("тестовая фикстура возвращает НЕ БОЛЬШЕ maxQueries формулировок", async () => {
    const fixture: QueryProposer = {
      name: "fixture",
      async proposeQueries(input) {
        return Array.from(
          { length: input.maxQueries + 5 },
          (_, i) => `query ${i}`,
        ).slice(0, input.maxQueries);
      },
    };
    __setQueryProposer(fixture);
    const queries = await resolveQueryProposer().proposeQueries({
      target: {
        step: 1,
        stepName: "Economic Source",
        component: "SOURCE_OF_VALUE",
      },
      hint: "no memory for this component",
      maxQueries: 3,
    });
    expect(queries.length).toBe(3);
  });
});

describe("Фаза 6, S1 — EvidenceExtractor: без provider'а production падает явно, тесты подставляют фикстуру", () => {
  afterEach(() => __setEvidenceExtractor(null));

  it("без конфигурации resolveEvidenceExtractor() бросает, а не тихо использует fake", () => {
    expect(() => resolveEvidenceExtractor()).toThrow(
      EvidenceExtractorUnavailableError,
    );
  });

  it("тестовая фикстура извлекает факты по заданной схеме", async () => {
    const fixture: EvidenceExtractor = {
      name: "fixture",
      async extract(input) {
        return [
          {
            step: input.target.step,
            component: input.target.component,
            statement: "extracted from fixture document",
            mechanismState: null,
            directness: "DIRECT",
            doesNotProve: "does not prove current execution",
            relationship: "SUPPORTS",
          },
        ];
      },
    };
    __setEvidenceExtractor(fixture);
    const facts = await resolveEvidenceExtractor().extract({
      target: {
        step: 4,
        stepName: "Actual Execution",
        component: "EXECUTION_EVIDENCE",
      },
      document: {
        finalUrl: "https://example.com/doc",
        requestedUrl: "https://example.com/doc",
        httpStatus: 200,
        contentType: "text/html",
        normalizedText: "the buyback executed on-chain",
        contentHash: "sha256:deadbeef",
        fetchedAt: new Date(),
        byteLength: 100,
      },
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].doesNotProve.length).toBeGreaterThan(0);
  });
});
