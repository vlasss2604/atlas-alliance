import type { Database, Transaction } from "../db/client";
import type { WorkExecutor } from "./controller";
import type { ModelCostProfile } from "./model-cost-profile";
import type { ContentFetcher } from "./providers/content-fetcher";
import type { EvidenceExtractor } from "./providers/evidence-extractor";
import type { QueryProposer } from "./providers/query-proposer";
import type { SearchGateway } from "./providers/search-gateway";
import { createS4WorkExecutor } from "./s4-executor";

// First Real Run, Stage 1 (pipeline-integration-stage.md, D-113) — a
// deterministic, zero-cost, zero-network WorkExecutor for the production
// worker path. Wires the REAL, frozen S4 executor (createS4WorkExecutor,
// s4-executor.ts) — never duplicates its logic — with explicit fake
// provider objects for all four S4 provider roles PLUS explicit fixture
// cost profiles, so preflight() inside s4-executor.ts never falls back
// to resolveSearchGateway()/resolveContentFetcher()/resolveQueryProposer()/
// resolveEvidenceExtractor() or loadModelCostProfile() — the production
// resolvers — at all. Every one of S4ExecutorDeps's override fields is
// supplied explicitly below; preflight() checks `deps.X ?? resolveX()`
// for each of the four providers UNCONDITIONALLY (before any budget
// reservation, regardless of what search/fetch would later find), so
// omitting even one would still risk touching a live resolver.
//
// This is the ONLY way to run createS4WorkExecutor with a provable
// zero-live-network/model guarantee. PRODUCTION_MODEL_COST_PROFILES
// (model-cost-profile.ts) is NOT touched by this file, and
// loadModelCostProfile's fail-closed behavior for real production model
// ids is untouched — the fixture profiles below are passed directly via
// S4ExecutorDeps.queryProposerCostProfile/evidenceExtractorCostProfile,
// a structurally separate path from the production catalogue (the exact
// discipline the existing S4 test suite already relies on).

const FIXTURE_MODEL_ID = "non-live-fixture-model";

function fixtureCostProfile(): ModelCostProfile {
  return {
    modelId: FIXTURE_MODEL_ID,
    inputPriceMicroUsdPerToken: 1,
    outputPriceMicroUsdPerToken: 1,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    priceVersion: "non-live-fixture-v1",
  };
}

// Deterministically proposes one fixed, inert query string. Never reads
// or reflects any external output back into control flow — there is no
// external call here at all.
const nonLiveQueryProposer: QueryProposer = {
  name: "non-live-fixture",
  async proposeQueries() {
    return ["non-live-stage-1-fixture-query"];
  },
};

// Deterministically returns zero candidates — no network call is made.
// This also means ContentFetcher/EvidenceExtractor are never actually
// invoked downstream in this attempt; they are still supplied explicitly
// below so preflight() never falls back to a real resolver for them.
const nonLiveSearchGateway: SearchGateway = {
  name: "non-live-fixture",
  async search() {
    return [];
  },
};

const nonLiveContentFetcher: ContentFetcher = {
  name: "non-live-fixture",
  async fetch(url) {
    throw new Error(`non-live executor: fetch() must never be called (url=${url})`);
  },
};

const nonLiveEvidenceExtractor: EvidenceExtractor = {
  name: "non-live-fixture",
  async extract() {
    throw new Error("non-live executor: extract() must never be called");
  },
};

export interface NonLiveExecutorDeps {
  db: Database | Transaction;
  project: { id: string; name: string; slug: string; ticker: string | null };
}

// The stage's one production entry point: a WorkExecutor guaranteed to
// make zero live network/model calls, built entirely from the frozen S4
// executor plus the fixtures above. Every S4 attempt under this executor
// deterministically fails with NO_SEARCH_CANDIDATES — this is honest (no
// fabricated Evidence is ever created merely to look like progress) and
// still exercises the real preflight/reservation/budget-accounting/
// project-containment wiring end to end, through the actual frozen S4
// code path, not a worker-side reimplementation of it.
export function createNonLiveS4WorkExecutor(deps: NonLiveExecutorDeps): WorkExecutor {
  return createS4WorkExecutor({
    db: deps.db,
    project: deps.project,
    queryProposer: nonLiveQueryProposer,
    searchGateway: nonLiveSearchGateway,
    contentFetcher: nonLiveContentFetcher,
    evidenceExtractor: nonLiveEvidenceExtractor,
    queryProposerCostProfile: fixtureCostProfile(),
    evidenceExtractorCostProfile: fixtureCostProfile(),
  });
}
