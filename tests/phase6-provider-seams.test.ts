import { afterEach, describe, expect, it, vi } from "vitest";

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
import { ISOLATED_PROVIDER_ENV_KEYS } from "./setup-provider-env";

// Phase 6, S1 — provider-seam contract tests for the three roles that
// need an unresolved live provider (P2 SearchGateway, P3 QueryProposer/
// EvidenceExtractor — phase-6-plan.md §21). What matters at S1 is that
// these seams exist, are typed, and NEVER silently fall back to a fake in
// production: resolve*() must throw until a real branch is wired in a
// later slice, exactly like resolveInterpreterGateway()'s existing
// no-fake-in-production rule.

// Every "unconfigured" assertion below states its own precondition instead
// of trusting the ambient environment: vi.stubEnv(key, undefined) removes
// the variable for the duration of the test and vi.unstubAllEnvs() restores
// whatever was there before. tests/setup-provider-env.ts already scrubs
// these globally, but a test that asserts "no credential is configured"
// must not depend on another file having arranged that — otherwise it
// silently stops testing anything the day that setup changes.
function withNoProviderCredentials(): void {
  vi.stubEnv("BRAVE_SEARCH_API_KEY", undefined);
  vi.stubEnv("SEARCH_GATEWAY_PROVIDER", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("MODEL_GATEWAY", undefined);
}

// Regression guard for the defect this file itself hit: the suite used to
// pass or fail depending on whether the developer running it happened to
// have real provider credentials exported in their shell. If
// tests/setup-provider-env.ts is ever dropped from vitest.config.ts, or
// stops covering a variable, these assertions fail immediately and by
// name — instead of the failure resurfacing as an unrelated, confusing
// "expected function to throw" somewhere else in the suite.
describe("тестовое окружение изолировано от реальных провайдерских кредов разработчика", () => {
  it("ни одна провайдерская переменная окружения не унаследована от машины разработчика", () => {
    for (const key of ISOLATED_PROVIDER_ENV_KEYS) {
      // Asserted as a BOOLEAN on purpose. expect(process.env[key]).toBeUndefined()
      // would embed the actual value in the failure diff — i.e. print a real
      // credential to the console on the very machines this guard exists for.
      // Comparing a boolean keeps the failure message to "expected false to
      // be true" plus the variable NAME, and never its value.
      const isAbsent = process.env[key] === undefined;
      expect(isAbsent, `${key} leaked into the test environment`).toBe(true);
    }
  });

  it("резолверы детерминированно недоступны по умолчанию, независимо от машины", () => {
    expect(() => resolveSearchGateway()).toThrow(SearchProviderUnavailableError);
  });
});

describe("Фаза 6, S1 — SearchGateway: без provider'а production падает явно, тесты подставляют фикстуру", () => {
  afterEach(() => {
    __setSearchGateway(null);
    vi.unstubAllEnvs();
  });

  it("без конфигурации resolveSearchGateway() бросает, а не тихо использует fake", () => {
    withNoProviderCredentials();
    expect(() => resolveSearchGateway()).toThrow(
      SearchProviderUnavailableError,
    );
  });

  // Requirement mirror of the test above: with a key present the resolver
  // must actually return a gateway rather than throw. The key is a
  // SYNTHETIC value set by this test — never the developer's real one —
  // and resolveSearchGateway() only CONSTRUCTS the gateway, so no request
  // is made. .search() is deliberately not called.
  it("с (синтетическим) ключом резолвер возвращает gateway и не делает запрос", () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-not-a-real-key");
    vi.stubEnv("SEARCH_GATEWAY_PROVIDER", undefined);
    const gateway = resolveSearchGateway();
    expect(gateway.name).toBeTruthy();
  });

  it("неизвестный SEARCH_GATEWAY_PROVIDER бросает даже когда ключ настроен", () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-not-a-real-key");
    vi.stubEnv("SEARCH_GATEWAY_PROVIDER", "not-a-real-provider");
    expect(() => resolveSearchGateway()).toThrow(SearchProviderUnavailableError);
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

describe("Фаза 6, S1/S4 — QueryProposer: без ключа production падает явно и сразу, тесты подставляют фикстуру", () => {
  afterEach(() => {
    __setQueryProposer(null);
    vi.unstubAllEnvs();
  });

  // S10 LAST HIGH CLOSURE (HIGH-2, D-121): resolveQueryProposer() now
  // throws EAGERLY for a missing ANTHROPIC_API_KEY — corrected from the
  // prior lazy-failure discipline (first real call throws), so
  // s4-executor.ts's preflight() can classify this as capability-fatal
  // BEFORE any reservation is made, never after.
  it("без ключа резолвер бросает сразу — .proposeQueries() никогда не вызывается", async () => {
    withNoProviderCredentials();
    await expect(resolveQueryProposer()).rejects.toThrow(QueryProposerUnavailableError);
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

describe("Фаза 6, S1/S4 — EvidenceExtractor: без ключа production падает явно и сразу, тесты подставляют фикстуру", () => {
  afterEach(() => {
    __setEvidenceExtractor(null);
    vi.unstubAllEnvs();
  });

  // S10 LAST HIGH CLOSURE (HIGH-2, D-121): resolveEvidenceExtractor() now
  // throws EAGERLY for a missing ANTHROPIC_API_KEY — see the matching
  // QueryProposer describe block above for the full reasoning.
  it("без ключа резолвер бросает сразу — .extract() никогда не вызывается", async () => {
    withNoProviderCredentials();
    await expect(resolveEvidenceExtractor()).rejects.toThrow(EvidenceExtractorUnavailableError);
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
