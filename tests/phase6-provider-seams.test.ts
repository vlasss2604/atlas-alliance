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
        projectId: "test-project-id",
        projectName: "Test Project",
        projectSlug: "test_project",
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

describe("Фаза 6, S1/S4 — QueryProposer: без ключа production падает явно (лениво), тесты подставляют фикстуру", () => {
  afterEach(() => __setQueryProposer(null));

  // S4 resolved P3: resolveQueryProposer() itself no longer throws for
  // "no credentials" (it resolves to the live Anthropic-backed
  // implementation, same lazy-failure discipline as
  // resolveInterpreterGateway/anthropic.ts) — the throw now happens on
  // the first real call, when ANTHROPIC_API_KEY turns out to be unset.
  it("без ключа первый реальный вызов .proposeQueries() бросает, а не тихо использует fake", async () => {
    const proposer = await resolveQueryProposer();
    await expect(
      proposer.proposeQueries({
        target: { step: 1, stepName: "Economic Source", component: "SOURCE_OF_VALUE", projectId: "test-project-id", projectName: "Test Project", projectSlug: "test_project" },
        hint: "no memory for this component",
        maxQueries: 3,
      }),
    ).rejects.toThrow(QueryProposerUnavailableError);
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
    const proposer = await resolveQueryProposer();
    const queries = await proposer.proposeQueries({
      target: {
        step: 1,
        stepName: "Economic Source",
        component: "SOURCE_OF_VALUE",
        projectId: "test-project-id",
        projectName: "Test Project",
        projectSlug: "test_project",
      },
      hint: "no memory for this component",
      maxQueries: 3,
    });
    expect(queries.length).toBe(3);
  });
});

describe("Фаза 6, S1/S4 — EvidenceExtractor: без ключа production падает явно (лениво), тесты подставляют фикстуру", () => {
  afterEach(() => __setEvidenceExtractor(null));

  it("без ключа первый реальный вызов .extract() бросает, а не тихо использует fake", async () => {
    const extractor = await resolveEvidenceExtractor();
    await expect(
      extractor.extract({
        target: { step: 4, stepName: "Actual Execution", component: "EXECUTION_EVIDENCE", projectId: "test-project-id", projectName: "Test Project", projectSlug: "test_project" },
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
      }),
    ).rejects.toThrow(EvidenceExtractorUnavailableError);
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
            supportFragment: "the buyback executed on-chain",
            mechanismState: null,
            directness: "DIRECT",
            publishedAt: null,
            doesNotProve: "does not prove current execution",
            relationship: "SUPPORTS",
          },
        ];
      },
    };
    __setEvidenceExtractor(fixture);
    const extractor = await resolveEvidenceExtractor();
    const facts = await extractor.extract({
      target: {
        step: 4,
        stepName: "Actual Execution",
        component: "EXECUTION_EVIDENCE",
        projectId: "test-project-id",
        projectName: "Test Project",
        projectSlug: "test_project",
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
