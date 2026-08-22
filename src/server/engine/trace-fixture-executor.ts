import type { Database, Transaction } from "../db/client";
import type { WorkExecutionResult, WorkExecutor } from "./controller";
import type { ComponentWorkItem } from "./contract-view";
import type { ModelCostProfile } from "./model-cost-profile";
import { ContentFetchError } from "./providers/content-fetcher";
import type { ContentFetcher } from "./providers/content-fetcher";
import type { EvidenceExtractor } from "./providers/evidence-extractor";
import type { QueryProposer } from "./providers/query-proposer";
import type { SearchGateway } from "./providers/search-gateway";
import type { ExtractedFact, FetchedDocument } from "./providers/types";
import { createS4WorkExecutor } from "./s4-executor";

// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) — a
// SEPARATE non-live fixture from the accepted Stage 1
// createNonLiveS4WorkExecutor (non-live-executor.ts, untouched by this
// file). Stage 1's fixture deterministically finds nothing (proves the
// wiring is safe with zero fabricated Evidence); THIS fixture can
// deterministically walk the real, frozen S4 executor
// (createS4WorkExecutor, s4-executor.ts, now instrumented for trace)
// through every stage — search, fetch, extraction, per-fact admission —
// so Stage 2's trace vocabulary has something real to observe.
//
// Every provider here is named exactly "non-live-fixture" (§C/§4) — an
// operator inspecting research_trace_events.provider_name can never
// confuse this with a live provider. No network call, no credential, no
// live model exists anywhere in this file.

export const NON_LIVE_FIXTURE_PROVIDER_NAME = "non-live-fixture";

export type TraceFixtureScenario =
  | "ZERO_CANDIDATES" // A
  | "FETCH_FAILURE" // B
  | "EXTRACTION_FAILURE" // C
  | "ADMISSIBLE_EVIDENCE" // D
  | "PARTIAL_FETCH_FAILURE" // E — one candidate fails, another succeeds
  | "DUPLICATE_CANDIDATE" // F
  | "BUDGET_SKIPPED_SOURCE_OPEN"; // G — candidate skipped due to sourceOpens budget

function fixedDoc(overrides: Partial<FetchedDocument> = {}): FetchedDocument {
  return {
    finalUrl: "https://example.com/non-live-fixture/doc",
    requestedUrl: "https://example.com/non-live-fixture/doc",
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "Non-Live Fixture Project: the protocol fee accrues directly to the treasury contract",
    contentHash: "sha256:non-live-fixture",
    fetchedAt: new Date(0),
    byteLength: 200,
    ...overrides,
  };
}

function admissibleFact(step: number, component: string, overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step,
    component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: "the protocol fee accrues directly to the treasury contract",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    ...overrides,
  };
}

const FIXTURE_COST_PROFILE: ModelCostProfile = {
  modelId: "non-live-fixture-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 1,
  maxOutputTokens: 1,
  priceVersion: "non-live-fixture-v1",
};

function queryProposer(queries: string[]): QueryProposer {
  return { name: NON_LIVE_FIXTURE_PROVIDER_NAME, async proposeQueries() { return queries; } };
}

function searchGateway(urls: string[]): SearchGateway {
  return {
    name: NON_LIVE_FIXTURE_PROVIDER_NAME,
    async search() {
      return urls.map((url) => ({ url, title: "non-live-fixture result", snippet: "a search snippet, never evidence" }));
    },
  };
}

function contentFetcher(byUrl: Record<string, FetchedDocument | "FAIL">): ContentFetcher {
  return {
    name: NON_LIVE_FIXTURE_PROVIDER_NAME,
    async fetch(url) {
      const entry = byUrl[url];
      if (!entry || entry === "FAIL") {
        throw new ContentFetchError("HTTP_ERROR", "non-live fixture: no document configured for this URL", url);
      }
      return entry;
    },
  };
}

function evidenceExtractor(byUrl: Record<string, ExtractedFact[] | "FAIL">): EvidenceExtractor {
  return {
    name: NON_LIVE_FIXTURE_PROVIDER_NAME,
    async extract(input) {
      const entry = byUrl[input.document.finalUrl];
      if (entry === "FAIL") {
        throw new Error("non-live fixture: extraction deliberately fails for this URL");
      }
      return entry ?? [];
    },
  };
}

// Builds a WorkExecutor for exactly one scenario, wired through the
// real, frozen createS4WorkExecutor — this file invents no S4 logic of
// its own, only which fixture responses S4 receives.
function buildScenarioExecutor(
  scenario: TraceFixtureScenario,
  deps: { db: Database | Transaction; project: { id: string; name: string; slug: string; ticker: string | null } },
  step: number,
  component: string,
): WorkExecutor {
  const base = { db: deps.db, project: deps.project, queryProposerCostProfile: FIXTURE_COST_PROFILE, evidenceExtractorCostProfile: FIXTURE_COST_PROFILE };
  const urlA = `https://example.com/non-live-fixture/${step}/${component}/a`;
  const urlB = `https://example.com/non-live-fixture/${step}/${component}/b`;
  const doc = fixedDoc({ finalUrl: urlA, requestedUrl: urlA, normalizedText: `${deps.project.name}: the protocol fee accrues directly to the treasury contract` });
  const docB = fixedDoc({ finalUrl: urlB, requestedUrl: urlB, normalizedText: `${deps.project.name}: the protocol fee accrues directly to the treasury contract` });
  const fact = admissibleFact(step, component, { supportFragment: doc.normalizedText.split(": ")[1] });
  const factB = admissibleFact(step, component, { supportFragment: docB.normalizedText.split(": ")[1] });

  switch (scenario) {
    case "ZERO_CANDIDATES":
      return createS4WorkExecutor({ ...base, queryProposer: queryProposer(["non-live-fixture-query"]), searchGateway: searchGateway([]), contentFetcher: contentFetcher({}), evidenceExtractor: evidenceExtractor({}) });

    case "FETCH_FAILURE":
      return createS4WorkExecutor({
        ...base,
        queryProposer: queryProposer(["non-live-fixture-query"]),
        searchGateway: searchGateway([urlA]),
        contentFetcher: contentFetcher({ [urlA]: "FAIL" }),
        evidenceExtractor: evidenceExtractor({}),
      });

    case "EXTRACTION_FAILURE":
      return createS4WorkExecutor({
        ...base,
        queryProposer: queryProposer(["non-live-fixture-query"]),
        searchGateway: searchGateway([urlA]),
        contentFetcher: contentFetcher({ [urlA]: doc }),
        evidenceExtractor: evidenceExtractor({ [urlA]: "FAIL" }),
      });

    case "ADMISSIBLE_EVIDENCE":
      return createS4WorkExecutor({
        ...base,
        queryProposer: queryProposer(["non-live-fixture-query"]),
        searchGateway: searchGateway([urlA]),
        contentFetcher: contentFetcher({ [urlA]: doc }),
        evidenceExtractor: evidenceExtractor({ [urlA]: [fact] }),
      });

    case "PARTIAL_FETCH_FAILURE":
      return createS4WorkExecutor({
        ...base,
        queryProposer: queryProposer(["non-live-fixture-query"]),
        searchGateway: searchGateway([urlA, urlB]),
        contentFetcher: contentFetcher({ [urlA]: "FAIL", [urlB]: docB }),
        evidenceExtractor: evidenceExtractor({ [urlB]: [factB] }),
      });

    case "DUPLICATE_CANDIDATE":
      // Two queries whose search results both return the SAME url — the
      // real s4-executor.ts Map-based dedup (now traced, §D) collapses
      // them into one candidate.
      return createS4WorkExecutor({
        ...base,
        queryProposer: queryProposer(["non-live-fixture-query-1", "non-live-fixture-query-2"]),
        searchGateway: searchGateway([urlA]),
        contentFetcher: contentFetcher({ [urlA]: doc }),
        evidenceExtractor: evidenceExtractor({ [urlA]: [fact] }),
      });

    case "BUDGET_SKIPPED_SOURCE_OPEN":
      // Two candidates, but the job's own maxSourceOpens ceiling (passed
      // by the real controller, not this fixture) is expected to be 1 in
      // any scenario configuration that wants to actually observe this
      // trace event — this fixture only supplies two real candidates so
      // there is something for the ceiling to skip.
      return createS4WorkExecutor({
        ...base,
        queryProposer: queryProposer(["non-live-fixture-query"]),
        searchGateway: searchGateway([urlA, urlB]),
        contentFetcher: contentFetcher({ [urlA]: doc, [urlB]: docB }),
        evidenceExtractor: evidenceExtractor({ [urlA]: [fact], [urlB]: [factB] }),
      });
  }
}

export interface TraceFixtureExecutorDeps {
  db: Database | Transaction;
  project: { id: string; name: string; slug: string; ticker: string | null };
  // Keyed by "step:component" — which scenario that specific work item
  // should exercise. Any (step, component) not present here deterministically
  // runs ZERO_CANDIDATES (never silently fabricates Evidence for an
  // unconfigured component).
  scenarioByItem?: Record<string, TraceFixtureScenario>;
  defaultScenario?: TraceFixtureScenario;
}

export function createTraceFixtureExecutor(deps: TraceFixtureExecutorDeps): WorkExecutor {
  return {
    async execute(item: ComponentWorkItem, ctx): Promise<WorkExecutionResult> {
      const key = `${item.step}:${item.component}`;
      const scenario = deps.scenarioByItem?.[key] ?? deps.defaultScenario ?? "ZERO_CANDIDATES";
      const executor = buildScenarioExecutor(scenario, { db: deps.db, project: deps.project }, item.step, item.component);
      return executor.execute(item, ctx);
    },
  };
}
