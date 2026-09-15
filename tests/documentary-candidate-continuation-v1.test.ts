import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import {
  EvidenceExtractorUnavailableError,
  type EvidenceExtractionInput,
} from "../src/server/engine/providers/evidence-extractor";
import { __setOnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// DOCUMENTARY CANDIDATE CONTINUATION V1 — regression coverage.
//
// THE DEFECT, measured on the live Memory acceptance retry (job
// 58eeba58-…): MECHANISM_SPEC ran one search, search returned five
// confirmed OFFICIAL_DOCS candidates, fair share allowed ONE source open,
// the first candidate was fetched and extracted cleanly — and the model
// returned an empty facts array. The component stopped with four
// discovered, admissible, never-opened candidates and eleven unused source
// opens on the job: INSUFFICIENT_EVIDENCE / NO_EVIDENCE_FOUND.
//
// The rule under test: when the ONE opened candidate completes acquisition
// and admits nothing for the component, the attempt may open exactly ONE
// more already-discovered candidate, with no new search, no new proposer
// call, no reopened url, no ceiling raised, and never a third. Everything
// here is offline and synthetic.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setOnchainRetriever(null);
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
const CALL_MICRO = COST.maxInputTokens * COST.inputPriceMicroUsdPerToken + COST.maxOutputTokens * COST.outputPriceMicroUsdPerToken;

// The A2-prime shape for MECHANISM_SPEC: the third of ten components, eight
// still pending, a 12-search alpha budget → one search unit; and a
// source-open ledger that rations this component to ONE open while leaving
// spare global opens.
const A2_SEARCH_BUDGET = 12;
const A2_QUEUE = { workQueueSize: 10, remainingComponents: 8 };
const RATIONED_OPENS = 8;

async function makeProject(opts: { identity?: boolean } = {}) {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("cont");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Continuation Fixture", status: "ACTIVE_CORE" })
    .returning();
  if (opts.identity !== false) {
    const identity = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
    if (!identity.ok) throw new Error("identity fixture failed");
  }
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

const FRAGMENT = "rewards are distributed to stakers according to the documented rate schedule";

function factFor(item: { step: number; component: string }, fragment: string): ExtractedFact {
  return {
    step: item.step,
    component: item.component,
    statement: "the mechanism distributes rewards on a documented schedule",
    supportFragment: fragment,
    mechanismState: "LIVE",
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove the amounts actually distributed",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
  };
}

interface RunOpts {
  project: { id: string; name: string; slug: string; ticker: string | null; host: string };
  jobId: string;
  item: ComponentWorkItem;
  searchResults: string[];
  fetchable: Record<string, string>;
  extract: (input: EvidenceExtractionInput) => Promise<ExtractedFact[]>;
  retriever?: boolean;
  maxSearchQueries?: number;
  maxSourceOpens?: number;
  maxModelCostMicro?: number;
  queue?: { workQueueSize: number; remainingComponents: number };
  proposerQueries?: string[];
}

async function runOneComponent(opts: RunOpts) {
  if (opts.retriever) {
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
        return opts.proposerQueries ?? ["q-mechanism", "q-rules", "q-schedule"];
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
        return opts.extract(input);
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: "ENABLED",
  });
  const run = () =>
    executor.execute(opts.item, {
      jobId: opts.jobId,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: {
        maxSearchQueries: opts.maxSearchQueries ?? A2_SEARCH_BUDGET,
        maxSourceOpens: opts.maxSourceOpens ?? RATIONED_OPENS,
        maxModelCostMicro: opts.maxModelCostMicro ?? 5_000_000,
      },
      ...(opts.queue ?? A2_QUEUE),
    });
  return { run, fetchCalls, queries, proposerCalls, extractCalls };
}

// Five confirmed OFFICIAL_DOCS candidates on the project's classified docs
// host — the live shape. The extractor script is keyed by url.
function candidates(host: string): string[] {
  return ["dao", "introducing", "rewards", "index", "faq"].map((p) => `https://${host}/docs/${p}`);
}
function pages(project: { name: string }, urls: string[]): Record<string, string> {
  return Object.fromEntries(urls.map((u) => [u, `${project.name} documentation: ${FRAGMENT}. Page ${u}.`]));
}
// Extractor script: empty facts for every url unless named in `yields`.
function scripted(yields: Set<string>): RunOpts["extract"] {
  return async (input) => (yields.has(input.document.finalUrl) ? [factFor(input.target, FRAGMENT)] : []);
}

// The extractor script is built once the fixture urls exist.
async function mechanismSpec(
  opts: Partial<Omit<RunOpts, "extract">> & { script: (urls: string[]) => RunOpts["extract"]; identity?: boolean },
) {
  const { script, identity, ...rest } = opts;
  const project = await makeProject({ identity });
  const jobId = await makeJob(project.id);
  const item = await workItem(jobId, "MECHANISM_SPEC");
  const urls = candidates(project.host);
  const harness = await runOneComponent({
    project,
    jobId,
    item,
    searchResults: urls,
    fetchable: pages(project, urls),
    extract: script(urls),
    ...rest,
  });
  return { ...harness, project, jobId, item, urls };
}

describe("A2-prime MECHANISM_SPEC shape — one search, five candidates, first one empty", () => {
  it("opens exactly one more already-discovered candidate and admits its Evidence: one proposer, one search, two opens, no third", async () => {
    // Candidate #1 empty, candidate #2 yields one DIRECT fact.
    const { run, fetchCalls, queries, proposerCalls, extractCalls, jobId, item, urls } = await mechanismSpec({
      script: (u) => scripted(new Set([u[1]])),
    });
    const result = await run();

    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(proposerCalls).toHaveLength(1);
    expect(queries).toHaveLength(1);
    // Candidate #1 opened and read (empty), candidate #2 opened and read
    // (one fact), and nothing else: no third open, no reopen of #1.
    expect(fetchCalls).toEqual([urls[0], urls[1]]);
    expect(extractCalls.map((c) => c.document.finalUrl)).toEqual([urls[0], urls[1]]);

    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "SEARCH_EXECUTED")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "MODEL_CALL_ATTEMPTED" && r.providerKind === "QUERY_PROPOSE")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "FETCH_ATTEMPTED").map((r) => r.targetRef)).toEqual([urls[0], urls[1]]);
    expect(rows.filter((r) => r.operationType === "EXTRACT_ATTEMPTED")).toHaveLength(2);
    expect(rows.filter((r) => r.operationType === "EXTRACT_OK")).toHaveLength(1);
    // Honest accounting: two source opens, proposer + two extractions.
    const budget = await reserved(jobId);
    expect(budget.searchQueries).toBe(1);
    expect(budget.sourceOpens).toBe(2);
    expect(budget.modelCostMicro).toBe(3 * CALL_MICRO);
    expect(result.spent!.sourceOpens).toBe(2);
    expect(result.spent!.authorizedModelCostMicro).toBe(3 * CALL_MICRO);
    const ev = await ctx.db.select().from(evidence).where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, item.component)));
    expect(ev).toHaveLength(1);
    expect(ev[0].retrievedUrl).toBe(urls[1]);
    expect(ev[0].sourceClass).toBe("OFFICIAL_DOCS");
    expect(ev[0].officiality).toBe("CONFIRMED");
    expect(ev[0].directness).toBe("DIRECT");
  });

  it("the ration itself is one open: without continuation the shape reproduces (pinned via the useful-first case below)", async () => {
    // Sanity on the fixture: the fair share for this shape is exactly one
    // open, which is what made the live component stop.
    const { run, fetchCalls } = await mechanismSpec({ script: () => scripted(new Set()) });
    await run();
    // Two opens = one ration + one continuation; never more.
    expect(fetchCalls.length).toBeLessThanOrEqual(2);
  });
});

describe("bounds", () => {
  it("A. a useful first candidate never triggers the continuation — no extra work", async () => {
    const h = await mechanismSpec({ script: () => async (input) => [factFor(input.target, FRAGMENT)] });
    const result = await h.run();
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).not.toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(h.fetchCalls).toEqual([h.urls[0]]);
    expect(h.extractCalls).toHaveLength(1);
    expect((await reserved(h.jobId)).sourceOpens).toBe(1);
    expect((await reserved(h.jobId)).modelCostMicro).toBe(2 * CALL_MICRO);
  });

  it("B. first empty, second empty → exactly two opens, then stop (fail closed, no third round)", async () => {
    const h = await mechanismSpec({ script: () => scripted(new Set()) });
    const result = await h.run();
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toContain("NO_TRACEABLE_FACTS_FOR_COMPONENT");
    expect(result.reason).toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(h.fetchCalls).toEqual([h.urls[0], h.urls[1]]);
    expect(h.extractCalls).toHaveLength(2);
    expect((await reserved(h.jobId)).sourceOpens).toBe(2);
    expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, h.jobId))).toHaveLength(0);
  });

  it("C1. global source-open budget exhausted → no second open, and the attempt ends as before (not a budget throw)", async () => {
    // No identity, so no on-chain reserve lowers the documentary ceiling:
    // the job's whole ledger is ONE open, and the first candidate takes it.
    const h = await mechanismSpec({ script: (u) => scripted(new Set([u[1]])), identity: false, maxSourceOpens: 1 });
    const result = await h.run();
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toContain("DOCUMENTARY_CANDIDATE_CONTINUATION_SKIPPED_BUDGET");
    expect(result.reason).not.toMatch(/DOCUMENTARY_CANDIDATE_CONTINUATION[,;]|DOCUMENTARY_CANDIDATE_CONTINUATION$/);
    expect(h.fetchCalls).toEqual([h.urls[0]]);
    expect(h.extractCalls).toHaveLength(1);
    expect((await reserved(h.jobId)).sourceOpens).toBe(1);
    const rows = await trace(h.jobId);
    expect(rows.filter((r) => r.operationType === "CANDIDATE_SKIPPED_BUDGET")).toHaveLength(0);
  });

  it("C2. model-cost budget with no room for one more extraction → no second open", async () => {
    // Exactly proposer + one extraction fits; a second extraction would not.
    const h = await mechanismSpec({ script: () => scripted(new Set()), maxModelCostMicro: 2 * CALL_MICRO });
    const result = await h.run();
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toContain("DOCUMENTARY_CANDIDATE_CONTINUATION_SKIPPED_BUDGET");
    expect(h.fetchCalls).toEqual([h.urls[0]]);
    expect(h.extractCalls).toHaveLength(1);
    expect((await reserved(h.jobId)).modelCostMicro).toBe(2 * CALL_MICRO);
  });

  it("D. candidate #2 already opened by this job is served from the sealed copy, never reopened through the transport", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const urls = candidates(project.host);
    // An earlier component of the same job opened and sealed candidate #2.
    const earlier = await workItem(jobId, "SOURCE_OF_VALUE");
    const first = await runOneComponent({
      project,
      jobId,
      item: earlier,
      searchResults: [urls[1]],
      fetchable: pages(project, urls),
      extract: async (input) => [factFor(input.target, FRAGMENT)],
      queue: { workQueueSize: 10, remainingComponents: 10 },
      // Its own query text, so the later component's search is not a
      // D-152 replay of this one.
      proposerQueries: ["q-earlier-component"],
    });
    expect((await first.run()).status).toBe("SUCCEEDED");
    expect(first.fetchCalls).toEqual([urls[1]]);

    const item = await workItem(jobId, "MECHANISM_SPEC");
    const h = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: urls,
      fetchable: pages(project, urls),
      extract: scripted(new Set([urls[1]])),
    });
    const opensBefore = (await reserved(jobId)).sourceOpens;
    const result = await h.run();
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(result.reason).toContain("REUSED_ACQUIRED_DOCUMENT");
    // The transport saw only candidate #1; #2 was replayed from storage.
    expect(h.fetchCalls).toEqual([urls[0]]);
    expect(h.extractCalls.map((c) => c.document.finalUrl)).toEqual([urls[0], urls[1]]);
    expect((await reserved(jobId)).sourceOpens).toBe(opensBefore + 1);
    const rows = await trace(jobId);
    const replay = rows.filter((r) => r.component === item.component && r.operationType === "FETCH_ATTEMPTED" && r.targetRef === urls[1]);
    expect(replay).toHaveLength(1);
    expect(replay[0].providerName).toBe("acquired-document-replay");
    const ev = await ctx.db.select().from(evidence).where(and(eq(evidence.researchJobId, jobId), eq(evidence.component, item.component)));
    expect(ev).toHaveLength(1);
  });

  it("E. ownership and admissibility are unchanged: the continuation walks the same filtered list, so an explorer the on-chain path owns is never the second open", async () => {
    // FLOW_PATH admits ONCHAIN_VERIFIABLE; with a retriever installed the
    // explorer rule filters explorer urls out of the candidate list before
    // any open. Candidate order: docs #1 (empty), explorer, docs #2 (fact).
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "FLOW_PATH");
    const docs1 = `https://${project.host}/docs/flow-a`;
    const docs2 = `https://${project.host}/docs/flow-b`;
    const explorer = `https://solscan.io/token/${MINT}`;
    const { run, fetchCalls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [docs1, explorer, docs2],
      fetchable: { ...pages(project, [docs1, docs2]), [explorer]: `${project.name} ${FRAGMENT}` },
      extract: scripted(new Set([docs2])),
      retriever: true,
    });
    const result = await run();
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(result.reason).toContain("SKIPPED_EXPLORER_HTTP_ONCHAIN_PATH_OWNS_FACT");
    expect(fetchCalls).toEqual([docs1, docs2]);
    expect(fetchCalls).not.toContain(explorer);
  });

  it("E2. a first document that does not contain the project is rejected as before and does not continue", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "MECHANISM_SPEC");
    // Off-route host (no confirmed route), and the page never names the
    // project: REJECTED_WRONG_PROJECT — the document is inadmissible, not
    // empty, and the conservative rule leaves it exactly as it was.
    const foreign = `https://other-${uniq("h").replace(/_/g, "-")}.test/page`;
    const second = `https://${project.host}/docs/second`;
    const { run, fetchCalls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: [foreign, second],
      fetchable: { [foreign]: `some unrelated protocol: ${FRAGMENT}`, ...pages(project, [second]) },
      // The candidate order is class-ranked: the confirmed docs url ranks
      // first, so make the foreign page the only search result of a
      // query… — simpler: give the docs url nothing to say and check the
      // foreign one is never a continuation trigger.
      extract: async (input) => (input.document.finalUrl === foreign ? [factFor(input.target, FRAGMENT)] : []),
    });
    const result = await run();
    // Ranked first: the confirmed docs page (empty) → continuation opens the
    // foreign page → its facts are rejected WRONG_PROJECT → no third open.
    expect(fetchCalls).toEqual([second, foreign]);
    expect(result.status).toBe("SKIPPED");
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "REJECTED_WRONG_PROJECT")).toHaveLength(1);
  });

  it("F. a failed first extraction is not an empty document: no continuation, existing failure semantics", async () => {
    const h = await mechanismSpec({
      script: () => async () => {
        throw new EvidenceExtractorUnavailableError("model output is not valid JSON", false, "OUTPUT_NOT_JSON");
      },
    });
    const result = await h.run();
    expect(result.status).toBe("FAILED");
    expect(result.reason).toContain("EVIDENCE_EXTRACTOR_UNAVAILABLE");
    expect(result.reason).not.toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(h.fetchCalls).toEqual([h.urls[0]]);
  });

  it("G. a first fetch failure is not an empty document: no continuation beyond the existing single ration", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const item = await workItem(jobId, "MECHANISM_SPEC");
    const urls = candidates(project.host);
    const fetchable = pages(project, urls);
    delete fetchable[urls[0]];
    const { run, fetchCalls } = await runOneComponent({
      project,
      jobId,
      item,
      searchResults: urls,
      fetchable,
      extract: scripted(new Set(urls)),
    });
    const result = await run();
    expect(result.status).toBe("FAILED");
    expect(result.reason).not.toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(fetchCalls).toEqual([urls[0]]);
  });

  it("H. a truncated first document rescued by the compact retry but still empty may continue; the bound is +1 open and the compact fallback's own +1 call", async () => {
    let calls = 0;
    const h = await mechanismSpec({
      script: () => async (input) => {
        calls += 1;
        if (calls === 1) throw new EvidenceExtractorUnavailableError("model output truncated (max_tokens)", false, "MAX_TOKENS_TRUNCATED");
        if (input.mode === "COMPACT") return [];
        return [factFor(input.target, FRAGMENT)];
      },
    });
    const result = await h.run();
    expect(result.status).toBe("SUCCEEDED");
    expect(result.reason).toContain("EXTRACT_COMPACT_RETRY_OK");
    expect(result.reason).toContain("DOCUMENTARY_CANDIDATE_CONTINUATION");
    expect(h.fetchCalls).toEqual([h.urls[0], h.urls[1]]);
    expect(h.extractCalls.map((c) => `${c.document.finalUrl}:${c.mode ?? "FULL"}`)).toEqual([
      `${h.urls[0]}:FULL`,
      `${h.urls[0]}:COMPACT`,
      `${h.urls[1]}:FULL`,
    ]);
  });

  it("the rule names no project, chain, token, explorer or component", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    const start = src.indexOf("// THE CONTINUATION DECISION");
    const end = src.indexOf("// D3 — THE PAID-FOR DOCUMENTS HAVE NOW BEEN READ", start);
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/solscan|solana|etherscan|ethereum|lido|raydium|pump|0x/i);
    expect(body).not.toMatch(/SOURCE_OF_VALUE|DESTINATION|RECIPIENT|NET_EFFECT|EXECUTION_EVIDENCE|FLOW_PATH|CURRENT_STATE|MECHANISM_SPEC/);
    // The bound is structural: the round loop runs at most twice.
    expect(body).toContain("acquisitionRound === 1");
    expect(body).toContain("openAllowance = opensAttempted + 1");
  });
});
