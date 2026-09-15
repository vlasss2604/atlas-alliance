import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { evidence, projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { explorerLocatorsForIdentity } from "../src/server/domain/project-identity";
import { loadAcquisitionPlan } from "../src/server/engine/acquisition-plan";
import {
  documentaryExecutableLocators,
  modelQueriesCanBeUsed,
} from "../src/server/engine/acquisition-targeting";
import { componentSearchAllowance } from "../src/server/engine/budget-fairness";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { extractionUnitKey } from "../src/server/engine/extraction-unit-key";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { componentAdmitsOnchainAcquisition } from "../src/server/engine/onchain-acquisition";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import {
  COMPACT_EXTRACTION_MAX_FACTS,
  EvidenceExtractorUnavailableError,
  type EvidenceExtractionInput,
} from "../src/server/engine/providers/evidence-extractor";
import {
  __resetAnthropicEvidenceExtractorClient,
  __setAnthropicEvidenceExtractorClient,
  buildEvidenceExtractorUserContent,
  COMPACT_EXTRACTION_DIRECTIVE,
  createAnthropicEvidenceExtractor,
  evidenceExtractorOutputFormat,
} from "../src/server/engine/providers/evidence-extractor-anthropic";
import { __setOnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ACQUISITION GRACEFUL DEGRADATION V1 — regression coverage.
//
// Two generic acquisition defects proven from the persisted trace of the
// first controlled live Memory acceptance run (job b5395f96-…):
//
//   1  A documentary component holding ONE search unit spent it on an
//      explorer locator the same executor then refused every result of,
//      because the on-chain path owns that fact. The proposer was skipped
//      as "provably unusable" on the strength of that very locator. Three
//      components ended NO_SOURCE_COULD_BE_FETCHED, deterministically.
//
//   2  A rich official page (94,584 normalized characters, inside the
//      input gate) was fetched, extraction hit the output ceiling, the
//      response was refused as MAX_TOKENS_TRUNCATED, and the whole document
//      contributed zero facts: EVIDENCE_EXTRACTOR_UNAVAILABLE.
//
// Everything here is offline and synthetic: fixture hosts, a fixture chain
// identity, fixture providers. No budget is raised, no admission or
// authority rule moves, and no project, chain, token or explorer appears
// in any rule under test.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setOnchainRetriever(null);
  __resetAnthropicEvidenceExtractorClient();
});

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const NOW = new Date("2026-09-15T00:00:00.000Z");

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

// Reserved per call: the same figure the executor derives from the profile
// (calculateMaxAuthorizedCostMicro = maxInput*inPrice + maxOutput*outPrice).
const CALL_MICRO = COST.maxInputTokens * COST.inputPriceMicroUsdPerToken + COST.maxOutputTokens * COST.outputPriceMicroUsdPerToken;

// The A2 budget shape: a 12-query alpha budget over a 10-component queue,
// with 9 components still pending when this one runs. Fair share = 1.
const A2_SEARCH_BUDGET = 12;
const A2_QUEUE = { workQueueSize: 10, remainingComponents: 9 };

async function makeProject() {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("degrade");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Degradation Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
  if (!identity.ok) throw new Error("identity fixture failed");
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!confirmed.ok) throw new Error(`confirm route failed: ${confirmed.refusal}`);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error(`classify route failed: ${classified.refusal}`);
  return { id: project.id, name: project.name, slug, ticker: null as string | null, host };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function workItem(jobId: string, component: string): Promise<ComponentWorkItem> {
  const { view } = await loadJobContractView(ctx.db, jobId);
  const item = view.workQueue.find((i) => i.component === component);
  if (!item) throw new Error(`fixture: ${component} is not in the work queue`);
  return item;
}

async function trace(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

async function reserved(jobId: string) {
  const [row] = await ctx.db
    .select({
      searchQueries: researchJobs.searchQueriesReserved,
      sourceOpens: researchJobs.sourceOpensReserved,
      modelCostMicro: researchJobs.modelCostMicroReserved,
    })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row;
}

function docFor(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}`,
    fetchedAt: NOW,
    byteLength: text.length,
  };
}

const FRAGMENT = "the protocol fee accrues directly to the treasury contract";

function factFor(item: { step: number; component: string }, fragment: string): ExtractedFact {
  return {
    step: item.step,
    component: item.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: fragment,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
  };
}

function truncated() {
  return new EvidenceExtractorUnavailableError("model output truncated (max_tokens)", false, "MAX_TOKENS_TRUNCATED");
}

function installUnproductiveRetriever() {
  __setOnchainRetriever(
    {
      name: "fixture-retriever",
      supports: () => true,
      retrieve: async () => {
        throw new Error("fixture: chain read produced nothing");
      },
    },
    { chain: "solana", network: "mainnet" },
  );
}

interface RunOpts {
  project: { id: string; name: string; slug: string; ticker: string | null; host: string };
  jobId: string;
  item: ComponentWorkItem;
  searchResults: string[];
  // Url -> normalized text the transport serves; everything else 404s.
  fetchable: Record<string, string>;
  // Scripted extractor: called with the sequence number of THIS call
  // (1-based) and the input it received; returns facts or throws.
  extract: (call: number, input: EvidenceExtractionInput) => Promise<ExtractedFact[]>;
  retriever?: boolean;
  chainAcquisition?: "ENABLED" | "DOCUMENTARY_ONLY";
  maxSearchQueries?: number;
  queue?: { workQueueSize: number; remainingComponents: number };
}

async function runOneComponent(opts: RunOpts) {
  if (opts.retriever) installUnproductiveRetriever();
  const fetchCalls: string[] = [];
  const fetcher: ContentFetcher = {
    name: "live-transport",
    async fetch(url: string) {
      fetchCalls.push(url);
      const text = opts.fetchable[url];
      if (text === undefined) throw new ContentFetchError("HTTP_ERROR", "fixture: 404", url, 404);
      return docFor(url, text);
    },
  };
  const queries: string[] = [];
  const proposerCalls: number[] = [];
  const extractCalls: EvidenceExtractionInput[] = [];
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: opts.project,
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries() {
        proposerCalls.push(1);
        return ["q-flow", "q-treasury", "q-revenue"];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query: string) {
        queries.push(query);
        return opts.searchResults.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: fetcher,
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        extractCalls.push(input);
        return opts.extract(extractCalls.length, input);
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: opts.chainAcquisition ?? "ENABLED",
  });
  const run = (attemptNumber = 1) =>
    executor.execute(opts.item, {
      jobId: opts.jobId,
      attemptNumber,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: opts.maxSearchQueries ?? 5, maxSourceOpens: 24, maxModelCostMicro: 5_000_000 },
      ...(opts.queue ?? {}),
    });
  return { run, fetchCalls, queries, proposerCalls, extractCalls };
}

/* ------------------------------------------------------------------ */
/* 1 — a documentary search opportunity must be executable             */
/* ------------------------------------------------------------------ */

describe("1 — the documentary search opportunity goes to a query the documentary path can follow through on", () => {
  it("the rule: locators are documentary targets only when the explorer open is the mechanism", () => {
    const locators = ["site:a.test ADDR", "site:b.test ADDR"];
    expect(documentaryExecutableLocators(locators, false)).toEqual(locators);
    expect(documentaryExecutableLocators(locators, true)).toEqual([]);
    expect(documentaryExecutableLocators([], true)).toEqual([]);
    expect(documentaryExecutableLocators([], false)).toEqual([]);
    // The proposer-skip rule itself is unchanged: fed the plan's locators
    // it still says "unusable" for one slot with no generic class — that is
    // exactly the A2 waste; fed only the EXECUTABLE locators it says the
    // model is needed. The pure rule did not move; its input did.
    const classes = ["OFFICIAL_DOCS", "ONCHAIN_VERIFIABLE"] as const;
    expect(modelQueriesCanBeUsed({ establishingClasses: classes, onchainLocators: locators, maxTotal: 1 })).toBe(false);
    expect(
      modelQueriesCanBeUsed({
        establishingClasses: classes,
        onchainLocators: documentaryExecutableLocators(locators, true),
        maxTotal: 1,
      }),
    ).toBe(true);
  });

  it("D. the A2 fair-share allowance is unchanged: one search unit for a non-required component under the 12-query budget", () => {
    const allowance = componentSearchAllowance({
      maxSearchQueries: A2_SEARCH_BUDGET,
      alreadyReserved: 0,
      workQueueSize: A2_QUEUE.workQueueSize,
      remainingComponents: A2_QUEUE.remainingComponents,
      isIntentRequired: false,
      hardCapPerAttempt: 3,
      intentRequiredPending: 0,
    });
    expect(allowance).toBe(1);
  });

  it("A + C. FLOW_PATH shape: one slot + owned explorer locator -> the proposer runs, the documentary query is searched, the explorer stays the adapter's", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "FLOW_PATH");
    const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
    // The premise, exactly as A2 had it: the component admits the class,
    // the on-chain path owns the fact, and the plan carries the locator.
    expect(plan.establishingClasses).toContain("ONCHAIN_VERIFIABLE");
    expect(
      componentAdmitsOnchainAcquisition({
        component: item.component,
        establishingClasses: plan.establishingClasses,
        identity: plan.confirmedIdentity,
      }),
    ).toBe(true);
    expect(plan.onchainLocators).toEqual(explorerLocatorsForIdentity(plan.confirmedIdentity!));
    expect(plan.onchainLocators.length).toBeGreaterThan(0);

    const docs = `https://${project.host}/docs/flow.md`;
    const explorer = `https://solscan.io/token/${MINT}`;
    const { run, queries, fetchCalls, proposerCalls, extractCalls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [explorer, docs],
      fetchable: { [docs]: `${project.name}: ${FRAGMENT}` },
      extract: async (_call, input) => [factFor(input.target, FRAGMENT)],
      retriever: true,
      maxSearchQueries: A2_SEARCH_BUDGET,
      queue: A2_QUEUE,
    });
    const result = await run();

    // The proposer received the opportunity the locator used to consume.
    expect(proposerCalls).toHaveLength(1);
    // Exactly the one authorised search unit, and it is a documentary
    // query — the confirmed docs route with the model's topic — never the
    // explorer locator whose results this executor refuses.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toBe(`site:${project.host} q-flow`);
    for (const locator of plan.onchainLocators) expect(queries).not.toContain(locator);
    // C. On-chain ownership is untouched: the explorer url search returned
    // is still not bought by HTTP, and the documentary open reads the docs.
    expect(fetchCalls).toEqual([docs]);
    expect(extractCalls).toHaveLength(1);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain("ONCHAIN_LOCATORS_WITHHELD_FROM_DOCUMENTARY_SEARCH");
    expect(result.reason).toContain("SKIPPED_EXPLORER_HTTP_ONCHAIN_PATH_OWNS_FACT");
    expect(result.reason).not.toContain("MODEL_QUERIES_UNUSABLE_SKIPPED_PROPOSER");
    expect(result.reason).not.toContain("CLASS_REQUIRES_CONFIRMED_ROUTE:ONCHAIN_VERIFIABLE");

    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "MODEL_CALL_SKIPPED" && r.providerKind === "QUERY_PROPOSE")).toHaveLength(0);
    expect(rows.filter((r) => r.operationType === "MODEL_CALL_ATTEMPTED" && r.providerKind === "QUERY_PROPOSE" && r.status === "OK")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "SEARCH_EXECUTED")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "QUERY_PROPOSED").map((r) => r.targetRef)).toEqual([`site:${project.host} q-flow`]);
    expect(rows.filter((r) => r.operationType === "FETCH_ATTEMPTED" && r.targetRef === explorer)).toHaveLength(0);
    // D. Budget: one search unit reserved, one source open, proposer +
    // one extraction on the model axis — no ceiling touched.
    const budget = await reserved(jobId);
    expect(budget.searchQueries).toBe(1);
    expect(budget.sourceOpens).toBe(1);
    expect(budget.modelCostMicro).toBe(2 * CALL_MICRO);
    expect(result.spent!.searchQueries).toBe(1);
    expect(result.spent!.authorizedModelCostMicro).toBe(2 * CALL_MICRO);
    // Evidence exists for the component that used to end with none.
    const ev = await ctx.db.select().from(evidence).where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, item.component)));
    expect(ev).toHaveLength(1);
  });

  it("A. the same shape for every A2 component that lost its slot: RECIPIENT and EXECUTION_EVIDENCE receive the proposer too", async () => {
    for (const component of ["RECIPIENT", "EXECUTION_EVIDENCE"]) {
      const project = await makeProject();
      const jobId = await makeJob(project.id);
      const item = await workItem(jobId, component);
      const docs = `https://${project.host}/docs/${component.toLowerCase()}.md`;
      const { run, queries, proposerCalls } = await runOneComponent({
        project,
        jobId,
        item,
        searchResults: [docs],
        fetchable: { [docs]: `${project.name}: ${FRAGMENT}` },
        extract: async (_call, input) => [factFor(input.target, FRAGMENT)],
        retriever: true,
        maxSearchQueries: A2_SEARCH_BUDGET,
        queue: A2_QUEUE,
      });
      await run();
      expect(proposerCalls, component).toHaveLength(1);
      expect(queries, component).toHaveLength(1);
      expect(queries[0], component).not.toContain(MINT);
    }
  });

  it("B. an executable locator keeps the existing efficient path: no deterministic path here -> the proposer is still skipped and the locator is searched", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "FLOW_PATH");
    const plan = await loadAcquisitionPlan(ctx.db, jobId, item.component, project.id);
    const explorer = `https://solscan.io/token/${MINT}`;
    const { run, queries, fetchCalls, proposerCalls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [explorer],
      fetchable: { [explorer]: `${project.name}: ${FRAGMENT}` },
      extract: async (_call, input) => [factFor(input.target, FRAGMENT)],
      retriever: false,
      chainAcquisition: "DOCUMENTARY_ONLY",
      maxSearchQueries: A2_SEARCH_BUDGET,
      queue: A2_QUEUE,
    });
    const result = await run();
    // Nothing changed for a locator the documentary path can act on: no
    // proposer call was paid for, the self-contained locator filled the
    // one slot, and the explorer page it found was opened.
    expect(proposerCalls).toHaveLength(0);
    expect(queries).toEqual([plan.onchainLocators[0]]);
    expect(fetchCalls).toEqual([explorer]);
    expect(result.reason).toContain("MODEL_QUERIES_UNUSABLE_SKIPPED_PROPOSER");
    expect(result.reason).not.toContain("ONCHAIN_LOCATORS_WITHHELD_FROM_DOCUMENTARY_SEARCH");
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "MODEL_CALL_SKIPPED" && r.providerKind === "QUERY_PROPOSE")).toHaveLength(1);
    expect((await reserved(jobId)).searchQueries).toBe(1);
  });

  it("the rule names no project, chain, token, explorer or component", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/server/engine/acquisition-targeting.ts", "utf-8");
    const start = src.indexOf("export function documentaryExecutableLocators(");
    const end = src.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/solscan|solana|etherscan|ethereum|lido|raydium|pump|0x/i);
    expect(body).not.toMatch(/SOURCE_OF_VALUE|DESTINATION|RECIPIENT|NET_EFFECT|EXECUTION_EVIDENCE|FLOW_PATH|CURRENT_STATE|MECHANISM_SPEC/);
  });
});

/* ------------------------------------------------------------------ */
/* 2 — MAX_TOKENS_TRUNCATED degrades to one compact extraction         */
/* ------------------------------------------------------------------ */

// Faithful to the A2 document: a rich official page, well inside the
// input gate, whose FULL extraction over-produces.
function richPage(projectName: string): string {
  const paragraph = `${projectName} explains one more mechanism detail here; ${FRAGMENT}; and then several further sentences of documentation prose. `;
  return paragraph.repeat(400);
}

async function runMechanismSpec(extract: RunOpts["extract"], project?: Awaited<ReturnType<typeof makeProject>>, jobId?: string) {
  project ??= await makeProject();
  jobId ??= await makeJob(project.id);
  const item = await workItem(jobId, "MECHANISM_SPEC");
  const page = `https://${project.host}/docs/how-it-works/rewards`;
  const harness = await runOneComponent({
    project,
    jobId,
    item,
    searchResults: [page],
    fetchable: { [page]: richPage(project.name) },
    extract,
    // The A2 budget shape: one search unit for this component.
    maxSearchQueries: A2_SEARCH_BUDGET,
    queue: A2_QUEUE,
  });
  return { ...harness, project, jobId, item, page };
}

describe("2 — a fetched page that says too much is not a page that says nothing", () => {
  it("A. normal extraction: one call, FULL mode, unchanged", async () => {
    const { run, extractCalls, fetchCalls, queries, jobId } = await runMechanismSpec(async (_call, input) => [
      factFor(input.target, FRAGMENT),
    ]);
    const result = await run();
    expect(result.status).toBe("SUCCEEDED");
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0].mode ?? "FULL").toBe("FULL");
    expect(fetchCalls).toHaveLength(1);
    expect(queries).toHaveLength(1);
    expect(result.reason).not.toContain("EXTRACT_COMPACT_RETRY");
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "EXTRACT_ATTEMPTED")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "EXTRACT_FAILED")).toHaveLength(0);
    // Proposer + one extraction, and nothing more.
    expect((await reserved(jobId)).modelCostMicro).toBe(2 * CALL_MICRO);
    expect(result.spent!.authorizedModelCostMicro).toBe(2 * CALL_MICRO);
  });

  it("B + F. MECHANISM_SPEC shape: first extraction truncates -> exactly one compact retry over the same document, valid facts survive, accounted honestly", async () => {
    const { run, extractCalls, fetchCalls, queries, jobId, item, page } = await runMechanismSpec(async (call, input) => {
      if (call === 1) throw truncated();
      return [factFor(input.target, FRAGMENT)];
    });
    const result = await run();

    expect(result.status).toBe("SUCCEEDED");
    expect(extractCalls).toHaveLength(2);
    expect(extractCalls[0].mode ?? "FULL").toBe("FULL");
    expect(extractCalls[1].mode).toBe("COMPACT");
    // The SAME fetched document — same url, same text, same hash — and the
    // same component target.
    expect(extractCalls[1].document).toBe(extractCalls[0].document);
    expect(extractCalls[1].document.finalUrl).toBe(page);
    expect(extractCalls[1].target).toEqual(extractCalls[0].target);
    // No second fetch, no new search.
    expect(fetchCalls).toHaveLength(1);
    expect(queries).toHaveLength(1);
    expect(result.reason).toContain("EXTRACT_FAILED:MAX_TOKENS_TRUNCATED");
    expect(result.reason).toContain("EXTRACT_COMPACT_RETRY");
    expect(result.reason).toContain("EXTRACT_COMPACT_RETRY_OK");
    expect(result.reason).not.toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");

    const rows = await trace(jobId);
    // One reserved attempt row per real call; the truncated pass is on the
    // record with its closed diagnostic; the compact call is the one
    // successful MODEL_CALL_ATTEMPTED.
    const attempted = rows.filter((r) => r.operationType === "EXTRACT_ATTEMPTED");
    expect(attempted).toHaveLength(2);
    expect(attempted.every((r) => r.targetRef === page && r.budgetAmount === CALL_MICRO)).toBe(true);
    const failed = rows.filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].diagnosticCode).toBe("MAX_TOKENS_TRUNCATED");
    expect(rows.filter((r) => r.operationType === "MODEL_CALL_ATTEMPTED" && r.providerKind === "EXTRACT" && r.status === "OK")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "FETCH_ATTEMPTED")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "SEARCH_EXECUTED")).toHaveLength(1);
    // F. Honest accounting: proposer + TWO extraction reservations, on the
    // job's counter and in the attempt's own spent figure; one source open.
    const budget = await reserved(jobId);
    expect(budget.modelCostMicro).toBe(3 * CALL_MICRO);
    expect(budget.sourceOpens).toBe(1);
    expect(budget.searchQueries).toBe(1);
    expect(result.spent!.authorizedModelCostMicro).toBe(3 * CALL_MICRO);
    expect(result.spent!.sourceOpens).toBe(1);
    // The compact fact is ordinary Evidence for the component.
    const ev = await ctx.db.select().from(evidence).where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, item.component)));
    expect(ev).toHaveLength(1);
    expect(ev[0].fragment).toBe(FRAGMENT);
  });

  it("C. the compact retry truncates too: zero further retries, fail closed", async () => {
    const { run, extractCalls, fetchCalls, jobId } = await runMechanismSpec(async () => {
      throw truncated();
    });
    const result = await run();
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(result.reason).toContain("EXTRACT_COMPACT_RETRY_FAILED");
    expect(extractCalls).toHaveLength(2);
    expect(extractCalls[1].mode).toBe("COMPACT");
    expect(fetchCalls).toHaveLength(1);
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "EXTRACT_ATTEMPTED")).toHaveLength(2);
    const failed = rows.filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.diagnosticCode === "MAX_TOKENS_TRUNCATED")).toBe(true);
    expect((await reserved(jobId)).modelCostMicro).toBe(3 * CALL_MICRO);
    expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId))).toHaveLength(0);
  });

  it("D. a malformed or invalid compact response fails closed — nothing is salvaged", async () => {
    for (const [make, expected] of [
      [() => new EvidenceExtractorUnavailableError("model output is not valid JSON", false, "OUTPUT_NOT_JSON"), "OUTPUT_NOT_JSON"],
      [
        () => new EvidenceExtractorUnavailableError("model output failed schema validation", false, "OUTPUT_SCHEMA_INVALID", null, "FACTS"),
        "OUTPUT_SCHEMA_INVALID:FACTS",
      ],
    ] as const) {
      const { run, extractCalls, jobId } = await runMechanismSpec(async (call) => {
        if (call === 1) throw truncated();
        throw make();
      });
      const result = await run();
      expect(result.status, expected).toBe("FAILED");
      expect(result.reason, expected).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
      expect(result.reason, expected).toContain(`EXTRACT_FAILED:${expected}`);
      expect(result.reason, expected).toContain("EXTRACT_COMPACT_RETRY_FAILED");
      expect(extractCalls, expected).toHaveLength(2);
      const rows = await trace(jobId);
      expect(rows.filter((r) => r.operationType === "EXTRACT_FAILED").map((r) => r.diagnosticCode)).toEqual(["MAX_TOKENS_TRUNCATED", expected]);
      expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId))).toHaveLength(0);
    }
  });

  it("the compact retry is ONE call even when it fails transiently: no transient retry, the document fails locally, the capability is not declared down", async () => {
    const { run, extractCalls, jobId } = await runMechanismSpec(async (call) => {
      if (call === 1) throw truncated();
      throw new EvidenceExtractorUnavailableError("generation failed: NETWORK_NO_RESPONSE", true, "NETWORK_NO_RESPONSE");
    });
    const result = await run();
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EXTRACT_FAILED:NETWORK_NO_RESPONSE");
    expect(extractCalls).toHaveLength(2);
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "EXTRACT_ATTEMPTED")).toHaveLength(2);
    expect((await reserved(jobId)).modelCostMicro).toBe(3 * CALL_MICRO);
  });

  it("a truncated first document does not stop the attempt from reading the next one", async () => {
    // Only the truncated document gets the compact call; a document whose
    // full extraction succeeds gets exactly one call as before.
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "MECHANISM_SPEC");
    const first = `https://${project.host}/docs/a`;
    const second = `https://${project.host}/docs/b`;
    const SECOND_FRAGMENT = "the treasury forwards collected fees to stakers weekly";
    const { run, extractCalls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [first, second],
      fetchable: { [first]: richPage(project.name), [second]: `${project.name}: ${SECOND_FRAGMENT}` },
      extract: async (_call, input) => {
        if (input.document.finalUrl === first && (input.mode ?? "FULL") === "FULL") throw truncated();
        return [factFor(input.target, input.document.finalUrl === first ? FRAGMENT : SECOND_FRAGMENT)];
      },
    });
    const result = await run();
    expect(result.status).toBe("SUCCEEDED");
    expect(extractCalls.map((c) => `${c.document.finalUrl}:${c.mode ?? "FULL"}`)).toEqual([
      `${first}:FULL`,
      `${first}:COMPACT`,
      `${second}:FULL`,
    ]);
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev).toHaveLength(2);
  });

  it("E. identity: a compact fact lands on the canonical extraction-unit key, and a later full extraction of the same passage is a no-op", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const first = await runMechanismSpec(
      async (call, input) => {
        if (call === 1) throw truncated();
        return [factFor(input.target, FRAGMENT)];
      },
      project,
      jobId,
    );
    const r1 = await first.run();
    expect(r1.status).toBe("SUCCEEDED");
    const [row] = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(row.extractionUnitKey).toBe(extractionUnitKey(jobId, row.sourceId!, first.item.step, first.item.component, FRAGMENT));

    // Attempt 2 of the same component in the same job: the full extraction
    // succeeds this time and reports the SAME passage. Same unit, one row.
    const second = await runMechanismSpec(async (_call, input) => [factFor(input.target, FRAGMENT)], project, jobId);
    await second.run(2);
    expect(second.extractCalls.every((c) => (c.mode ?? "FULL") === "FULL")).toBe(true);
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(row.id);
  });
});

/* ------------------------------------------------------------------ */
/* 3 — the compact request itself, offline, against the real path      */
/* ------------------------------------------------------------------ */

const INPUT: EvidenceExtractionInput = {
  target: {
    step: 3,
    stepName: "Mechanism",
    component: "MECHANISM_SPEC",
    projectId: "p",
    projectName: "Fixture Project",
    projectSlug: "fixture-project",
    researchTask: "does protocol revenue reach token holders",
    evidenceGoal: "the documented mechanism by which value reaches holders",
  },
  document: {
    finalUrl: "https://docs.example-project.test/how-it-works",
    requestedUrl: "https://docs.example-project.test/how-it-works",
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: "fee text mentioning the treasury and the mechanism",
    contentHash: "sha256:fixturehash",
    fetchedAt: NOW,
    byteLength: 100,
  },
};

function validFact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    step: 3,
    component: "MECHANISM_SPEC",
    statement: "fees go to the treasury",
    supportFragment: "fee text mentioning the treasury",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "nothing about distribution",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
    ...overrides,
  };
}

function modelResponse(text: string, stopReason = "end_turn") {
  return {
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "text", text }],
  };
}

function stubClient(create: (req: unknown) => Promise<unknown>) {
  const requests: unknown[] = [];
  const client = {
    messages: {
      countTokens: vi.fn(async () => ({ input_tokens: 10 })),
      create: vi.fn(async (req: unknown) => {
        requests.push(req);
        return create(req);
      }),
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe("3 — the compact request: same document, same prompt, narrower ask, bounded fact list", () => {
  it("the user content carries the directive after the goal and before the untrusted document; FULL content is unchanged", () => {
    const full = buildEvidenceExtractorUserContent(INPUT);
    const compact = buildEvidenceExtractorUserContent({ ...INPUT, mode: "COMPACT" });
    expect(full).not.toContain("COMPACT EXTRACTION");
    expect(buildEvidenceExtractorUserContent({ ...INPUT, mode: "FULL" })).toBe(full);
    expect(compact).toContain(COMPACT_EXTRACTION_DIRECTIVE);
    expect(compact).toContain(`AT MOST ${COMPACT_EXTRACTION_MAX_FACTS} facts`);
    expect(compact.indexOf(INPUT.target.evidenceGoal!)).toBeLessThan(compact.indexOf("COMPACT EXTRACTION"));
    expect(compact.indexOf("COMPACT EXTRACTION")).toBeLessThan(compact.indexOf("DOCUMENT ("));
    // The document block is byte-identical: the fallback re-reads the same
    // sealed text, never a summary or a slice of it.
    const block = (s: string) => s.slice(s.indexOf("DOCUMENT ("));
    expect(block(compact)).toBe(block(full));
    expect(COMPACT_EXTRACTION_MAX_FACTS).toBeLessThan(20);
  });

  it("the compact output format declares the smaller cap, and the full one is unchanged", () => {
    const facts = (mode?: "FULL" | "COMPACT") =>
      (evidenceExtractorOutputFormat(mode) as unknown as { schema: { properties: { facts: { description: string } } } }).schema.properties.facts.description;
    expect(facts()).toContain("maxItems: 20");
    expect(facts("FULL")).toContain("maxItems: 20");
    expect(facts("COMPACT")).toContain(`maxItems: ${COMPACT_EXTRACTION_MAX_FACTS}`);
  });

  it("over the real doExtract: the compact request sends the directive and the compact format, and admits facts through the identical schema", async () => {
    const { client, requests } = stubClient(async () => modelResponse(JSON.stringify({ facts: [validFact(), validFact({ statement: "second" })] })));
    __setAnthropicEvidenceExtractorClient(client);
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000);
    const facts = await extractor.extract({ ...INPUT, mode: "COMPACT" });
    expect(facts).toHaveLength(2);
    expect(requests).toHaveLength(1);
    const req = requests[0] as { max_tokens: number; messages: { content: string }[]; output_config: { format: { schema: { properties: { facts: { description: string } } } } } };
    // Same output ceiling — the fallback asks for less, it is not given more.
    expect(req.max_tokens).toBe(1536);
    expect(req.messages[0].content).toContain(COMPACT_EXTRACTION_DIRECTIVE);
    expect(req.output_config.format.schema.properties.facts.description).toContain(`maxItems: ${COMPACT_EXTRACTION_MAX_FACTS}`);
  });

  it("a compact response longer than the cap is refused whole; a truncated compact response is MAX_TOKENS_TRUNCATED with nothing salvaged", async () => {
    const tooMany = Array.from({ length: COMPACT_EXTRACTION_MAX_FACTS + 1 }, (_, i) => validFact({ statement: `s${i}` }));
    const over = stubClient(async () => modelResponse(JSON.stringify({ facts: tooMany })));
    __setAnthropicEvidenceExtractorClient(over.client);
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000);
    await expect(extractor.extract({ ...INPUT, mode: "COMPACT" })).rejects.toMatchObject({
      diagnostic: "OUTPUT_SCHEMA_INVALID",
      schemaField: "FACTS",
    });
    // The same list is fine for a FULL extraction: only the compact cap moved.
    __resetAnthropicEvidenceExtractorClient();
    __setAnthropicEvidenceExtractorClient(over.client);
    expect(await createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000).extract(INPUT)).toHaveLength(tooMany.length);

    __resetAnthropicEvidenceExtractorClient();
    const prefix = JSON.stringify({ facts: [validFact()] }).slice(0, 40);
    const cut = stubClient(async () => modelResponse(prefix, "max_tokens"));
    __setAnthropicEvidenceExtractorClient(cut.client);
    await expect(createAnthropicEvidenceExtractor("claude-haiku-4-5", 1536, 4000).extract({ ...INPUT, mode: "COMPACT" })).rejects.toMatchObject({
      diagnostic: "MAX_TOKENS_TRUNCATED",
      transient: false,
    });
  });
});
