import type Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { evidence, projects, researchAttempts, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { runSearchPhase } from "../src/server/engine/acquisition-phases";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import { componentConcurrency, createSemaphore, extractionCallsPerJob, searchPipelining } from "../src/server/engine/concurrency";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { runResearchController, type WorkExecutor } from "../src/server/engine/controller";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { componentHasOnchainIntent } from "../src/server/engine/onchain-acquisition";
import { EvidenceExtractorUnavailableError, type EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import {
  __resetAnthropicEvidenceExtractorClient,
  __setAnthropicEvidenceExtractorClient,
  createAnthropicEvidenceExtractor,
} from "../src/server/engine/providers/evidence-extractor-anthropic";
import type { ComponentTarget, ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ENGINE SPEED PASS V1 (2026-10-11) — FASTER MUST NOT MEAN WEAKER.
//
// Four changes, each pinned here against the one thing it may not change:
//   1. COMPONENT OVERLAP, EXACT BARRIER SEMANTICS (controller.ts): under a
//      replay executor, independent components run beside each other
//      (bounded); every component with an on-chain intent is a barrier
//      that runs alone, after everything before it and before everything
//      after it. Result order, attempt rows, fair-share inputs and failure
//      propagation are the sequential loop's.
//   2. JOB-LEVEL PROBE (s4-executor.ts): the "one document at a time until
//      the round's first success" probe runs once per job run; later
//      rounds overlap from their first document. Fatal classes unchanged.
//   3. JOB-WIDE EXTRACTION CALL GATE: a ceiling on generation calls in
//      flight across all overlapped components.
//   4. SEARCH PIPELINING (acquisition-phases.ts): the next component's
//      proposer call starts while the previous component's searches run;
//      trace sequence, candidates, reservations are byte-identical.
// Plus the 4,096 output ceiling: a large VALID extraction is one call, a
// truncated one still takes the canonical failure / compact-retry path.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const ENV_KEYS = ["ATLAS_COMPONENT_CONCURRENCY", "ATLAS_EXTRACTION_CALLS_PER_JOB", "ATLAS_SEARCH_PIPELINING", "ATLAS_EXTRACTION_CONCURRENCY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const k of ENV_KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => {
  setEnv(savedEnv);
  __resetAnthropicEvidenceExtractorClient();
});

const NOW = new Date("2026-10-11T00:00:00Z");
const HOST = "docs.speedpass.test";
const FRAGMENT = "the protocol fee accrues directly to the treasury contract";
const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 4_096,
  priceVersion: "test-fixture-not-production",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeJob(opts: { plan?: boolean; route?: boolean } = {}) {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("speed");
  const name = "Speed Project";
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  if (opts.route) {
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/page" });
    if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  }
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  if (opts.plan) await runMemoryPlanningStage(ctx.db, job.id);
  return { jobId: job.id, project: { id: project.id, name, slug, ticker: null as string | null } };
}

// ---------------------------------------------------------------------------
// 1. COMPONENT OVERLAP — EXACT BARRIER SEMANTICS
// ---------------------------------------------------------------------------

interface Span {
  component: string;
  start: number;
  readAt: number; // when the fake signalled its job-wide read (0: never)
  end: number;
  remainingComponents: number | undefined;
  pendingComponents: string[] | undefined;
}

// THE DEPENDENCY GRAPH, as the executor declares it: every component with
// an on-chain intent (onchain-acquisition.ts INTENTS_BY_COMPONENT) reads
// job-wide state at the start of its attempt and is a barrier.
const BARRIER_COMPONENTS = ["FLOW_PATH", "EXECUTION_EVIDENCE", "CURRENT_STATE", "DESTINATION", "RECIPIENT", "NET_EFFECT"];
const INDEPENDENT_COMPONENTS = ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "GOVERNANCE_BASIS", "DURABILITY_BASIS"];

function recordingExecutor(opts: {
  delayMs: (component: string) => number;
  failAt?: string;
  live?: boolean;
  // How long after starting a barrier signals that its job-wide read is
  // done; undefined: never signals (the controller then waits for the
  // barrier to complete).
  readMs?: number;
}) {
  const spans: Span[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const executor: WorkExecutor = {
    liveAcquisition: opts.live ?? false,
    independentOfJobState: (item) => !componentHasOnchainIntent(item.component),
    async execute(item, c) {
      const span: Span = {
        component: item.component,
        start: performance.now(),
        readAt: 0,
        end: 0,
        remainingComponents: c.remainingComponents,
        pendingComponents: c.pendingComponents,
      };
      spans.push(span);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const total = opts.delayMs(item.component);
      if (opts.readMs !== undefined && componentHasOnchainIntent(item.component)) {
        await sleep(Math.min(opts.readMs, total));
        span.readAt = performance.now();
        c.onJobStateRead?.();
        await sleep(Math.max(0, total - opts.readMs));
      } else {
        await sleep(total);
      }
      inFlight -= 1;
      span.end = performance.now();
      if (opts.failAt === item.component) throw new CapabilityFatalError("EVIDENCE_EXTRACTOR", "fixture: capability down");
      return { status: "SUCCEEDED" as const, reason: "fixture", spent: { searchQueries: 0, sourceOpens: 0, authorizedModelCostMicro: 7 } };
    },
  };
  return { executor, spans, max: () => maxInFlight };
}

function barrierIndices(queue: readonly ComponentWorkItem[]): number[] {
  return queue.map((c, i) => (componentHasOnchainIntent(c.component) ? i : -1)).filter((i) => i >= 0);
}

const EPS = 3; // ms — timer granularity

describe("1. component overlap — exact barrier semantics", () => {
  it("the dependency graph: on-chain-intent components are barriers, every other component is independent", () => {
    expect(BARRIER_COMPONENTS.every(componentHasOnchainIntent)).toBe(true);
    expect(INDEPENDENT_COMPONENTS.some(componentHasOnchainIntent)).toBe(false);
    expect(componentConcurrency()).toBe(3);
    expect(extractionCallsPerJob()).toBe(8);
    expect(searchPipelining()).toBe(true);
  });

  it("a barrier that never signals: it starts after everything before it has finished and nothing after it starts until it has; independents beside each other overlap", async () => {
    setEnv({ ATLAS_COMPONENT_CONCURRENCY: "3" });
    const { jobId } = await makeJob({ plan: true });
    const { view } = await loadJobContractView(ctx.db, jobId);
    const queue = view.workQueue;
    expect(queue.length).toBeGreaterThanOrEqual(8);
    const barriers = barrierIndices(queue);
    expect(barriers.length).toBeGreaterThanOrEqual(3);

    const rec = recordingExecutor({ delayMs: () => 60 });
    const result = await runResearchController({ db: ctx.db, jobId, view, executor: rec.executor, now: NOW });

    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(result.attemptsThisRun).toBe(queue.length);
    // Result arrays are in QUEUE order, however the attempts overlapped.
    expect(result.succeeded.map((c) => c.component)).toEqual(queue.map((c) => c.component));
    expect(result.budgetSpent.authorizedModelCostMicro).toBe(7 * queue.length);

    const byComponent = new Map(rec.spans.map((s) => [s.component, s]));
    const spanOf = (i: number) => byComponent.get(queue[i].component)!;
    for (const b of barriers) {
      const barrier = spanOf(b);
      for (let j = 0; j < b; j++) expect(barrier.start).toBeGreaterThanOrEqual(spanOf(j).end - EPS);
      for (let j = b + 1; j < queue.length; j++) expect(spanOf(j).start).toBeGreaterThanOrEqual(barrier.end - EPS);
    }
    // Two independent neighbours (no barrier between them) overlapped.
    const pair = queue.findIndex((c, i) => i + 1 < queue.length && !componentHasOnchainIntent(c.component) && !componentHasOnchainIntent(queue[i + 1].component));
    expect(pair).toBeGreaterThanOrEqual(0);
    expect(spanOf(pair + 1).start).toBeLessThan(spanOf(pair).end);
    expect(rec.max()).toBeGreaterThanOrEqual(2);
    expect(rec.max()).toBeLessThanOrEqual(3);

    // The fair-share inputs each attempt received are the sequential loop's.
    for (const [i, c] of queue.entries()) {
      const s = byComponent.get(c.component)!;
      expect(s.remainingComponents).toBe(queue.length - i);
      expect(s.pendingComponents).toEqual(queue.slice(i + 1).map((q) => q.component));
    }

    const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(rows.length).toBe(queue.length);
    expect(rows.every((r) => r.status === "SUCCEEDED" && r.attemptNumber === 1)).toBe(true);
  });

  it("a barrier that signals its job-wide read: everything before it is finished when it starts; the items after it start after the read, not after the barrier's end; the next barrier still waits for all", async () => {
    setEnv({ ATLAS_COMPONENT_CONCURRENCY: "3" });
    const { jobId } = await makeJob({ plan: true });
    const { view } = await loadJobContractView(ctx.db, jobId);
    const queue = view.workQueue;
    const barriers = barrierIndices(queue);

    const rec = recordingExecutor({ delayMs: () => 80, readMs: 10 });
    const result = await runResearchController({ db: ctx.db, jobId, view, executor: rec.executor, now: NOW });
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(result.succeeded.map((c) => c.component)).toEqual(queue.map((c) => c.component));

    const byComponent = new Map(rec.spans.map((s) => [s.component, s]));
    const spanOf = (i: number) => byComponent.get(queue[i].component)!;
    for (const b of barriers) {
      const barrier = spanOf(b);
      expect(barrier.readAt).toBeGreaterThan(0);
      // Exact: the barrier read the state after every earlier item completed…
      for (let j = 0; j < b; j++) expect(barrier.start).toBeGreaterThanOrEqual(spanOf(j).end - EPS);
      // …and nothing later persisted anything before that read.
      for (let j = b + 1; j < queue.length; j++) expect(spanOf(j).start).toBeGreaterThanOrEqual(barrier.readAt - EPS);
    }
    // The overlap this buys: a barrier followed by an independent item —
    // the independent item started before the barrier ended.
    const after = queue.findIndex((c, i) => i + 1 < queue.length && componentHasOnchainIntent(c.component) && !componentHasOnchainIntent(queue[i + 1].component));
    expect(after).toBeGreaterThanOrEqual(0);
    expect(spanOf(after + 1).start).toBeLessThan(spanOf(after).end);
    expect(rec.max()).toBeLessThanOrEqual(3);
    const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(rows.length).toBe(queue.length);
    expect(rows.every((r) => r.status === "SUCCEEDED")).toBe(true);
  });

  it("concurrency 1 is the sequential loop; a LIVE executor is sequential whatever the knob says", async () => {
    for (const live of [false, true]) {
      setEnv({ ATLAS_COMPONENT_CONCURRENCY: live ? "3" : "1" });
      const { jobId } = await makeJob({ plan: true });
      const { view } = await loadJobContractView(ctx.db, jobId);
      const rec = recordingExecutor({ delayMs: () => 15, live });
      const result = await runResearchController({ db: ctx.db, jobId, view, executor: rec.executor, now: NOW });
      expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
      expect(rec.max()).toBe(1);
      for (let i = 1; i < rec.spans.length; i++) expect(rec.spans[i].start).toBeGreaterThanOrEqual(rec.spans[i - 1].end - 3);
      expect(rec.spans.map((s) => s.component)).toEqual(view.workQueue.map((c) => c.component));
    }
  });

  it("a failure in one overlapped component does not corrupt the others: in-flight attempts complete and persist, nothing further is claimed, the error propagates", async () => {
    setEnv({ ATLAS_COMPONENT_CONCURRENCY: "3" });
    const { jobId } = await makeJob({ plan: true });
    const { view } = await loadJobContractView(ctx.db, jobId);
    const queue = view.workQueue;
    // The failing item: an independent item that follows a barrier and is
    // itself followed by another independent item (in Pattern order:
    // FLOW_PATH barrier → MECHANISM_SPEC, GOVERNANCE_BASIS).
    const failIndex = queue.findIndex(
      (c, i) => i > 0 && !componentHasOnchainIntent(c.component) && componentHasOnchainIntent(queue[i - 1].component) && i + 1 < queue.length && !componentHasOnchainIntent(queue[i + 1].component),
    );
    expect(failIndex).toBeGreaterThan(0);
    const failing = queue[failIndex].component;
    const neighbour = queue[failIndex + 1].component;
    const rec = recordingExecutor({ delayMs: (c) => (c === failing ? 20 : 90), failAt: failing, readMs: 5 });

    await expect(runResearchController({ db: ctx.db, jobId, view, executor: rec.executor, now: NOW })).rejects.toBeInstanceOf(CapabilityFatalError);

    // Everything up to the failing item's independent neighbour had started;
    // those attempts ran to completion and persisted. The failing one stays
    // STARTED (its terminal write never happens, exactly as in the
    // sequential loop). Nothing after the neighbour was ever claimed: the
    // failure was known before the next item's turn.
    const rows = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    const byComponent = new Map(rows.map((r) => [r.component, r.status]));
    expect(rows.length).toBe(failIndex + 2);
    for (let i = 0; i < failIndex; i++) expect(byComponent.get(queue[i].component)).toBe("SUCCEEDED");
    expect(byComponent.get(failing)).toBe("STARTED");
    expect(byComponent.get(neighbour)).toBe("SUCCEEDED");
    for (let i = failIndex + 2; i < queue.length; i++) expect(byComponent.has(queue[i].component)).toBe(false);
    // The neighbour (and the barrier whose documentary pass it overlapped)
    // finished AFTER the failure was thrown — allowed to complete, not cut off.
    const failSpan = rec.spans.find((s) => s.component === failing)!;
    expect(rec.spans.find((s) => s.component === neighbour)!.end).toBeGreaterThan(failSpan.end);
    expect(rec.spans.find((s) => s.component === queue[failIndex - 1].component)!.end).toBeGreaterThan(failSpan.end);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. JOB-LEVEL PROBE AND THE JOB-WIDE CALL GATE (real s4 executor)
// ---------------------------------------------------------------------------

const ITEM_1: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};
const ITEM_2: ComponentWorkItem = { ...ITEM_1, step: 2, stepName: "Flow Path", component: "FLOW_PATH" };

const ctxFor = (jobId: string) => ({
  jobId,
  attemptNumber: 1,
  isRecoveryAttempt: false,
  budget: { maxSearchQueries: 10, maxSourceOpens: 20, maxModelCostMicro: 10_000_000 },
});

function docFor(url: string, projectName: string, extra = ""): FetchedDocument {
  const text = `${projectName}: ${FRAGMENT}. ${extra} Details for ${url}.`;
  return { finalUrl: url, requestedUrl: url, httpStatus: 200, contentType: "text/html", normalizedText: text, contentHash: `sha256:${url}`, fetchedAt: NOW, byteLength: text.length };
}

function factFor(target: ComponentTarget, fragment = FRAGMENT): ExtractedFact {
  return {
    step: target.step,
    component: target.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: fragment,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove distribution",
    relationship: "SUPPORTS",
  };
}

const urlsFor = (component: string, n: number) => Array.from({ length: n }, (_, i) => `https://${HOST}/page-${component.toLowerCase()}-${i + 1}`);

function timedExtractor(delayMs: number, fail?: (callIndex: number) => Error | null) {
  const starts: Array<{ component: string; at: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const extractor: EvidenceExtractor = {
    name: "fixture-timed",
    async extract(input) {
      starts.push({ component: input.target.component, at: performance.now() });
      const err = fail?.(starts.length) ?? null;
      if (err) throw err;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(delayMs);
      inFlight -= 1;
      input.onUsage?.({ inputTokens: 800, outputTokens: 40 });
      return [factFor(input.target)];
    },
  };
  return { extractor, starts, max: () => maxInFlight };
}

function executorWith(project: { id: string; name: string; slug: string; ticker: string | null }, extractor: EvidenceExtractor, docsFor: (component: string) => number) {
  return createS4WorkExecutor({
    db: ctx.db,
    project,
    chainAcquisition: "DOCUMENTARY_ONLY",
    // Component-specific queries: the job-wide dedup (D-152) hands a
    // component that proposes a query another component already paid for
    // that component's candidates instead of searching again.
    queryProposer: { name: "fixture", async proposeQueries(input) { return [`${input.target.component.toLowerCase()} q`]; } },
    searchGateway: {
      name: "fixture",
      async search(_q, target) {
        return urlsFor(target.component, docsFor(target.component)).map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: { name: "fixture", async fetch(url: string) { return docFor(url, project.name); } },
    evidenceExtractor: extractor,
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

const startsOf = (starts: Array<{ component: string; at: number }>, component: string) => starts.filter((s) => s.component === component).map((s) => s.at);

describe("2. job-level probe — the serial first document is probed once per job run, then every round overlaps from its first document", () => {
  it("a fresh executor still probes: the first document of the job run is called alone, the rest of the round overlaps after it", async () => {
    setEnv({ ATLAS_EXTRACTION_CONCURRENCY: "4" });
    const { jobId, project } = await makeJob();
    const t = timedExtractor(60);
    const result = await executorWith(project, t.extractor, () => 4).execute(ITEM_2, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    const starts = startsOf(t.starts, "FLOW_PATH");
    expect(starts.length).toBe(4);
    // Document 1 alone; documents 2–4 start only after it answered.
    for (const later of starts.slice(1)) expect(later - starts[0]).toBeGreaterThanOrEqual(55);
    // …and those three start together.
    expect(Math.max(...starts.slice(1)) - Math.min(...starts.slice(1))).toBeLessThan(30);
  });

  it("after one successful extraction in the job run, a later component's round overlaps from its FIRST document", async () => {
    setEnv({ ATLAS_EXTRACTION_CONCURRENCY: "4" });
    const { jobId, project } = await makeJob();
    const t = timedExtractor(60);
    const executor = executorWith(project, t.extractor, (c) => (c === "SOURCE_OF_VALUE" ? 1 : 4));
    expect((await executor.execute(ITEM_1, ctxFor(jobId))).status).toBe("SUCCEEDED");
    expect((await executor.execute(ITEM_2, ctxFor(jobId))).status).toBe("SUCCEEDED");
    const starts = startsOf(t.starts, "FLOW_PATH");
    expect(starts.length).toBe(4);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(30);
    // Evidence is one row per (component, document), exactly as before.
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.filter((r) => r.component === "FLOW_PATH").length).toBe(4);
    expect(rows.filter((r) => r.component === "SOURCE_OF_VALUE").length).toBe(1);
  });

  it("the fatal classes are untouched: a permanent provider rejection on the job's first document is fatal after exactly one call", async () => {
    setEnv({ ATLAS_EXTRACTION_CONCURRENCY: "4" });
    const { jobId, project } = await makeJob();
    const t = timedExtractor(10, () => new EvidenceExtractorUnavailableError("generation failed: AUTHENTICATION_FAILED:401", false, "AUTHENTICATION_FAILED", 401));
    await expect(executorWith(project, t.extractor, () => 4).execute(ITEM_2, ctxFor(jobId))).rejects.toBeInstanceOf(CapabilityFatalError);
    expect(t.starts.length).toBe(1);
  });

  it("concurrency 1 reproduces the sequential loop even after the probe: one call at a time", async () => {
    setEnv({ ATLAS_EXTRACTION_CONCURRENCY: "1" });
    const { jobId, project } = await makeJob();
    const t = timedExtractor(20);
    const executor = executorWith(project, t.extractor, (c) => (c === "SOURCE_OF_VALUE" ? 1 : 4));
    await executor.execute(ITEM_1, ctxFor(jobId));
    await executor.execute(ITEM_2, ctxFor(jobId));
    expect(t.max()).toBe(1);
    expect(t.starts.length).toBe(5);
  });
});

describe("3. the job-wide extraction call gate bounds generation calls in flight across the job run", () => {
  it("ATLAS_EXTRACTION_CALLS_PER_JOB=2 holds a proven round of four documents to two calls at a time; every document is still extracted", async () => {
    setEnv({ ATLAS_EXTRACTION_CONCURRENCY: "4", ATLAS_EXTRACTION_CALLS_PER_JOB: "2" });
    const { jobId, project } = await makeJob();
    const t = timedExtractor(40);
    const executor = executorWith(project, t.extractor, (c) => (c === "SOURCE_OF_VALUE" ? 1 : 4));
    await executor.execute(ITEM_1, ctxFor(jobId));
    const result = await executor.execute(ITEM_2, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(t.max()).toBe(2);
    expect(startsOf(t.starts, "FLOW_PATH").length).toBe(4);
  });

  it("the semaphore primitive admits in arrival order and never more than its limit", async () => {
    const gate = createSemaphore(2);
    const order: number[] = [];
    let active = 0;
    let max = 0;
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        gate.run(async () => {
          active += 1;
          max = Math.max(max, active);
          order.push(i);
          await sleep(10);
          active -= 1;
        }),
      ),
    );
    expect(max).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(gate.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. SEARCH PIPELINING — the same phase, order for order, with the wait moved
// ---------------------------------------------------------------------------

async function runTimedSearchPhase(pipelined: boolean) {
  setEnv({ ATLAS_SEARCH_PIPELINING: pipelined ? "1" : "0" });
  const { jobId, project } = await makeJob({ plan: true, route: true });
  const { view } = await loadJobContractView(ctx.db, jobId);
  const proposerStarts: Array<{ component: string; at: number }> = [];
  const searchEnds: Array<{ component: string; at: number }> = [];
  const t0 = performance.now();
  const out = await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue,
    target: (item) => ({ step: item.step, stepName: item.stepName, component: item.component, projectId: project.id, projectName: project.name, projectSlug: project.slug }),
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        proposerStarts.push({ component: input.target.component, at: performance.now() });
        await sleep(40);
        return [`${input.target.component.toLowerCase()} mechanism`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query, target) {
        await sleep(40);
        searchEnds.push({ component: target.component, at: performance.now() });
        const key = query.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
        return [1, 2].map((i) => ({ url: `https://${HOST}/page/${key}-${i}`, title: null, snippet: null }));
      },
    },
    maxSearchQueries: 12,
    maxResultsPerQuery: 5,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: 10_000_000,
    projectId: project.id,
    queryProposerCostProfile: COST,
    readProposerUsage: () => ({ inputTokens: 600, outputTokens: 25 }),
  });
  const durationMs = performance.now() - t0;
  const trace = await ctx.db
    .select()
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId))
    .orderBy(asc(researchTraceEvents.sequence));
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return {
    out,
    durationMs,
    proposerStarts,
    searchEnds,
    traceShape: trace.map((e) => [e.operationType, e.component, e.targetRef, e.status, e.reasonCode, e.budgetAxis, e.budgetAmount, e.actualCostMicro].join("|")),
    reserved: { search: job.searchQueriesReserved, model: job.modelCostMicroReserved },
  };
}

describe("4. search pipelining — the next proposer call overlaps the previous searches; everything observable is the sequential loop's", () => {
  it("sequential and pipelined runs persist the identical trace sequence, candidates, counters and reservations; the pipelined run overlapped and finished sooner", async () => {
    const serial = await runTimedSearchPhase(false);
    const piped = await runTimedSearchPhase(true);

    expect(serial.out.proposerCalls).toBeGreaterThanOrEqual(3);
    expect(piped.out.proposerCalls).toBe(serial.out.proposerCalls);
    expect(piped.out.executedQueries).toEqual(serial.out.executedQueries);
    expect(piped.out.candidateUrls).toEqual(serial.out.candidateUrls);
    expect(piped.out.dedupedQueries).toEqual(serial.out.dedupedQueries);
    expect(piped.out.budgetRefusedQueries).toEqual(serial.out.budgetRefusedQueries);
    expect(piped.out.budgetRefusedComponents).toEqual(serial.out.budgetRefusedComponents);
    expect(piped.out.routeRefusedComponents).toEqual(serial.out.routeRefusedComponents);
    expect(piped.reserved).toEqual(serial.reserved);
    expect(piped.traceShape).toEqual(serial.traceShape);

    // Overlap happened: some proposer call for component i+1 began before
    // the last search of component i had answered.
    const overlapped = piped.proposerStarts.some((p, i) => {
      if (i === 0) return false;
      const prev = piped.proposerStarts[i - 1].component;
      const prevSearchEnd = Math.max(...piped.searchEnds.filter((s) => s.component === prev).map((s) => s.at), -Infinity);
      return prevSearchEnd > p.at;
    });
    expect(overlapped).toBe(true);
    // And in the sequential run it never did.
    const serialOverlapped = serial.proposerStarts.some((p, i) => {
      if (i === 0) return false;
      const prev = serial.proposerStarts[i - 1].component;
      const prevSearchEnd = Math.max(...serial.searchEnds.filter((s) => s.component === prev).map((s) => s.at), -Infinity);
      return prevSearchEnd > p.at;
    });
    expect(serialOverlapped).toBe(false);
    expect(piped.durationMs).toBeLessThan(serial.durationMs);
  });
});

// ---------------------------------------------------------------------------
// 5. THE 4,096 OUTPUT CEILING — a large valid answer is one call
// ---------------------------------------------------------------------------

function largeFactsJson(n: number) {
  return JSON.stringify({
    facts: Array.from({ length: n }, (_, i) => ({
      step: 1,
      component: "SOURCE_OF_VALUE",
      statement: `fee statement ${i + 1}`,
      supportFragment: `fee sentence ${i + 1} accrues to the treasury`,
      mechanismState: null,
      stateCue: null,
      executionCue: null,
      directness: "DIRECT",
      publishedAt: null,
      doesNotProve: "that the mechanism is currently LIVE",
      relationship: "SUPPORTS",
      onchainLocator: null,
      onchainLocators: null,
    })),
  });
}

const STUB_INPUT = {
  target: { step: 1, stepName: "Economic Source", component: "SOURCE_OF_VALUE", projectId: "p", projectName: "Speed Project", projectSlug: "speed" } as ComponentTarget,
  document: {
    finalUrl: `https://${HOST}/page-1`,
    requestedUrl: `https://${HOST}/page-1`,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText: Array.from({ length: 20 }, (_, i) => `fee sentence ${i + 1} accrues to the treasury.`).join(" "),
    contentHash: "sha256:stub",
    fetchedAt: NOW,
    byteLength: 1000,
  } as FetchedDocument,
};

describe("5. output ceiling — valid larger output is one call; truncation still takes the canonical path", () => {
  it("the live adapter sends max_tokens = 4096 and returns a 20-fact answer that ended normally without any retry", async () => {
    let createArg: { max_tokens?: number } | null = null;
    let creates = 0;
    __setAnthropicEvidenceExtractorClient({
      messages: {
        countTokens: vi.fn(async () => ({ input_tokens: 500 })),
        create: vi.fn(async (arg: { max_tokens?: number }) => {
          creates += 1;
          createArg = arg;
          return { stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 2_900 }, content: [{ type: "text", text: largeFactsJson(20) }] };
        }),
      },
    } as unknown as Anthropic);
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 4096, 48_000);
    const facts = await extractor.extract(STUB_INPUT);
    expect(facts).toHaveLength(20);
    expect(creates).toBe(1);
    expect(createArg!.max_tokens).toBe(4096);
  });

  it("a response the provider stopped at the ceiling is still MAX_TOKENS_TRUNCATED, and the executor still takes the compact retry", async () => {
    let creates = 0;
    __setAnthropicEvidenceExtractorClient({
      messages: {
        countTokens: vi.fn(async () => ({ input_tokens: 500 })),
        create: vi.fn(async () => {
          creates += 1;
          return { stop_reason: "max_tokens", usage: { input_tokens: 500, output_tokens: 4096 }, content: [{ type: "text", text: "{" }] };
        }),
      },
    } as unknown as Anthropic);
    const extractor = createAnthropicEvidenceExtractor("claude-haiku-4-5", 4096, 48_000);
    await expect(extractor.extract(STUB_INPUT)).rejects.toMatchObject({ diagnostic: "MAX_TOKENS_TRUNCATED" });
    expect(creates).toBe(1);

    // Through the executor: FULL truncated → exactly one COMPACT retry.
    const { jobId, project } = await makeJob();
    const modes: string[] = [];
    const fixture: EvidenceExtractor = {
      name: "fixture-truncating",
      async extract(input) {
        modes.push(input.mode ?? "FULL");
        if (modes.length === 1) throw new EvidenceExtractorUnavailableError("model output truncated (max_tokens)", false, "MAX_TOKENS_TRUNCATED");
        return [factFor(input.target)];
      },
    };
    const result = await executorWith(project, fixture, () => 1).execute(ITEM_1, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(modes).toEqual(["FULL", "COMPACT"]);
    expect(result.reason).toContain("EXTRACT_COMPACT_RETRY_OK");
  });

  it("a large VALID extraction through the executor is one call, no compact retry, every traceable fact admitted", async () => {
    const { jobId, project } = await makeJob();
    const sentences = Array.from({ length: 20 }, (_, i) => `fee sentence ${i + 1} accrues to the treasury`);
    let calls = 0;
    const fixture: EvidenceExtractor = {
      name: "fixture-large",
      async extract(input) {
        calls += 1;
        return sentences.map((s) => factFor(input.target, s));
      },
    };
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      chainAcquisition: "DOCUMENTARY_ONLY",
      queryProposer: { name: "fixture", async proposeQueries() { return ["q"]; } },
      searchGateway: { name: "fixture", async search() { return [{ url: `https://${HOST}/page-large`, title: null, snippet: null }]; } },
      contentFetcher: { name: "fixture", async fetch(url: string) { return docFor(url, project.name, sentences.join(". ") + "."); } },
      evidenceExtractor: fixture,
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
    });
    const result = await executor.execute(ITEM_1, ctxFor(jobId));
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toBe(1);
    expect(result.reason).not.toContain("EXTRACT_COMPACT_RETRY");
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.length).toBe(20);
  });
});
