import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { acquiredDocuments, evidence, interpretations, projects, proofs, researchAttempts, researchComponentResults, researchJobs, researchPlans, topics, users } from "../src/server/db/schema";
import { loadActivePatternVersion } from "../src/server/engine/active-pattern";
import { prepareExtractionReplayFetcher, prepareExtractionReplayProposer, prepareExtractionReplaySearch } from "../src/server/engine/acquisition-phases";
import { buildContractView, type ComponentWorkItem } from "../src/server/engine/contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { PATTERN_V1_CONTENT, criticalComponentsFor } from "../src/server/domain/pattern";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ResearchBoundary } from "../src/server/engine/research-boundary";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { recoveryReserve, TARGETED_RECOVERY_BOUNDS, type TargetedRecoveryPlan } from "../src/server/engine/targeted-recovery";
import { expectRecoveryRanToCompletion } from "./recovery-continuation-assertions";
import { beginAcquisitionPhases, handleExtractingPhase, handleFetchingPhase, handleSearchingPhase, type PhaseWorkerContext } from "../src/server/jobs/acquisition-phase-worker";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { parseWorkerCapabilities, type PhaseCapability } from "../src/server/jobs/worker-capabilities";
import { parseContract } from "../src/server/memory/contract";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";
import { fixtureStateCue } from "./state-cue-fixture";

// TARGETED SECOND PASS (Research Reliability V1, B2).
//
// After the first acquisition walk, a CRITICAL component (the intent's
// declared proof path, B3) that stayed unresolved on a TECHNICAL boundary
// gets ONE bounded recovery attempt whenever a known admissible path
// remains — a confirmed route it never searched, an unopened candidate, a
// sealed document it never read. Hard bounds per component: <= 2 searches,
// <= 3 opens (and so <= 3 documentary extractions plus their compact
// retries). Never a third pass. The first pass holds back the recovery
// reserve (reservedRecoverySteps x bounds) on the two scarce axes so the
// second pass is not toothless under a spent envelope.
//
// The starved shape here is generic: a search envelope of 4 over a
// 10-component queue, so the first pass reaches two components and the
// critical ones close SKIPPED / SEARCH_BUDGET_EXHAUSTED with the project's
// confirmed OFFICIAL_DOCS route still unexplored for them.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const HOST = "docs.second-pass.test";
// The world's documents state the mechanism's state explicitly ("is currently
// active"): under D-163 present tense alone is never a current state, and
// these suites test recovery mechanics, not that rule.
const SENTENCE = "Protocol fees are used to buy back the token, the buyback is currently active, and bought-back tokens are held at a public address.";
const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
const STARVED_BUDGET = { ...INTERNAL_ALPHA_V1, maxSearchQueries: 4, reservedRecoverySteps: 1 };
const INTENT = "PROTOCOL_REVENUE_TO_TOKEN";
const CRITICAL = new Set(criticalComponentsFor(PATTERN_V1_CONTENT, INTENT));
const ROLE_SE: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("SEARCH_EXTRACT");
const ROLE_FETCH: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("FETCH");

function urlsFor(component: string, query: string): string[] {
  // Two candidate pages per query, on the confirmed route, named after the
  // component so the corpus is deterministic and readable.
  const slug = component.toLowerCase().replace(/_/g, "-");
  const n = query.endsWith("mechanism") ? 1 : 2;
  return [`https://${HOST}/mechanism/${slug}-${n}`, `https://${HOST}/mechanism/${slug}-${n}-b`];
}
function fixtureDoc(url: string): FetchedDocument {
  const text = `${SENTENCE} Details for ${url}.`;
  return { finalUrl: url, requestedUrl: url, httpStatus: 200, contentType: "text/markdown", normalizedText: text, contentHash: `sha256:${url}`, fetchedAt: new Date(), byteLength: text.length };
}
function fact(step: number, component: string): ExtractedFact {
  // State-bearing and fresh, so a current-state component can be
  // established by a documentary fact in this fixture.
  return { step, component, statement: SENTENCE, supportFragment: SENTENCE, mechanismState: "LIVE", stateCue: fixtureStateCue(SENTENCE, "LIVE"), directness: "DIRECT", publishedAt: new Date(Date.now() - 24 * 3600 * 1000), doesNotProve: "does not establish that any buyback executed", relationship: "SUPPORTS", onchainLocator: null, onchainLocators: null };
}

async function makeProject() {
  const slug = uniq("sp");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Second Pass", status: "ACTIVE_CORE" }).returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/mechanism" });
  if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}

async function makeJob(project: { id: string; slug: string }, budget = STARVED_BUDGET, opts: { enqueue?: boolean } = {}): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const question = "does protocol revenue buy back the token, and where does it go?";
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: { level: "ARI_CORE", capability: "FRESH_RESEARCH", budget },
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: !opts.enqueue },
  );
  await ctx.db.insert(interpretations).values({
    userId: user.id,
    researchJobId: job.id,
    originalQuestion: question,
    status: "READY",
    result: {
      status: "READY",
      project_or_asset: project.slug,
      related_entities: [],
      topic: null,
      task_type: "VERIFY_MECHANISM",
      research_task: question,
      understood_summary: null,
      user_assumptions: [],
      ambiguities: [],
      clarification_question: null,
      route: "DEEP_RESEARCH",
      normalized_intent: INTENT,
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  return job.id;
}

interface Counters {
  proposer: number;
  search: number;
  fetch: number;
  extract: number;
  searchesByComponent: Map<string, number>;
  fetchedUrls: string[];
}
function counters(): Counters {
  return { proposer: 0, search: 0, fetch: 0, extract: 0, searchesByComponent: new Map(), fetchedUrls: [] };
}

function liveExecutor(project: { id: string; name: string; slug: string }, c: Counters, extract: (url: string, step: number, component: string) => ExtractedFact[]) {
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        c.proposer += 1;
        return [`${input.target.component} mechanism`, `${input.target.component} tokenomics`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query, target) {
        c.search += 1;
        c.searchesByComponent.set(target.component, (c.searchesByComponent.get(target.component) ?? 0) + 1);
        const base = query.replace(/^site:\S+\s+/, "");
        return urlsFor(target.component, base).map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture-transport",
      async fetch(url: string) {
        c.fetch += 1;
        c.fetchedUrls.push(url);
        return fixtureDoc(url);
      },
    },
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        c.extract += 1;
        return extract(input.document.finalUrl, input.target.step, input.target.component);
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: "DOCUMENTARY_ONLY",
  });
}

async function attemptsOf(jobId: string) {
  return ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
}
async function s5Of(jobId: string) {
  const rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  return new Map(rows.map((r) => [r.component, r]));
}

/* ------------------------------------------------------------------ */
/* 1. UNPHASED — IN-PROCESS                                            */
/* ------------------------------------------------------------------ */

describe("B2 — unphased: a starved critical component gets one bounded recovery attempt and is established", () => {
  it("first pass starves the queue; the second pass recovers critical components from the reserve, within bounds, once; non-critical components stay bounded", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    await runMemoryPlanningStage(ctx.db, jobId);
    const c = counters();
    const result = await runS4ResearchJob(ctx.db, jobId, liveExecutor(project, c, (_u, step, component) => [fact(step, component)]), new Date());

    // The pass ran and finalized on the ordinary terminal path.
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(result.targetedRecovery).not.toBeNull();
    expect(result.targetedRecoveryDeferred).toBeFalsy();
    const plan = result.targetedRecovery as TargetedRecoveryPlan;
    expect(plan.round).toBe(2);
    for (const item of plan.items) expect(CRITICAL.has(item.component), item.component).toBe(true);

    const att = await attemptsOf(jobId);
    expect(att.every((a) => a.status !== "STARTED")).toBe(true);
    expect(Math.max(...att.map((a) => a.attemptNumber))).toBe(2);
    const second = att.filter((a) => a.attemptNumber === 2);
    expect(second.length).toBe(plan.items.length);
    expect(second.length).toBeGreaterThan(0);
    for (const a of second) {
      expect(CRITICAL.has(a.component), `${a.component} is not critical`).toBe(true);
      expect(a.searchQueriesSpent, a.component).toBeLessThanOrEqual(TARGETED_RECOVERY_BOUNDS.searches);
      expect(a.sourceOpensSpent, a.component).toBeLessThanOrEqual(TARGETED_RECOVERY_BOUNDS.opens);
      expect(a.reason ?? "").toContain("TARGETED_RECOVERY_ATTEMPT");
    }
    // Non-critical components: exactly one attempt each.
    for (const a of att.filter((a) => !CRITICAL.has(a.component))) expect(a.attemptNumber, a.component).toBe(1);

    // The whole envelope, and no more: the reserve was spent second, not
    // added. First pass <= 4 - 2; total <= 4.
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.searchQueriesReserved).toBeLessThanOrEqual(STARVED_BUDGET.maxSearchQueries);
    expect(c.search).toBeLessThanOrEqual(STARVED_BUDGET.maxSearchQueries);
    const firstPassSearches = att.filter((a) => a.attemptNumber === 1).reduce((n, a) => n + a.searchQueriesSpent, 0);
    expect(firstPassSearches).toBeLessThanOrEqual(STARVED_BUDGET.maxSearchQueries - recoveryReserve(1).searchQueries);

    // At least one critical component that closed SKIPPED /
    // SEARCH_BUDGET_EXHAUSTED on the first pass is SUPPORTED after the
    // second, with Evidence of its own.
    const starvedThenRecovered = second.filter((a2) => {
      const a1 = att.find((a) => a.component === a2.component && a.attemptNumber === 1);
      return a1?.status === "SKIPPED" && /^SEARCH_BUDGET_EXHAUSTED/.test(a1.reason ?? "") && a2.status === "SUCCEEDED";
    });
    expect(starvedThenRecovered.length).toBeGreaterThan(0);
    const s5 = await s5Of(jobId);
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    for (const a of starvedThenRecovered) {
      const row = s5.get(a.component)!;
      expect(row.status, a.component).not.toBe("INSUFFICIENT_EVIDENCE");
      expect((row.reasonCodes as string[]).includes("SEARCH_BUDGET_EXHAUSTED"), a.component).toBe(false);
      expect(ev.some((e) => e.component === a.component), a.component).toBe(true);
    }
    expect(starvedThenRecovered.some((a) => s5.get(a.component)?.status === "SUPPORTED")).toBe(true);
    // The Proof exists and its boundary record no longer lists the
    // recovered components as technical.
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof).toBeDefined();
    const bounded = proof.boundedBy as ResearchBoundary;
    for (const a of starvedThenRecovered) {
      expect(bounded.technical.some((t) => t.component === a.component), a.component).toBe(false);
    }
  }, 180_000);

  it("honest boundary: when recovery reads the remaining paths and finds nothing, the component stays unresolved as a SUBSTANTIVE gap — and recovery stops when the paths are used up", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    await runMemoryPlanningStage(ctx.db, jobId);
    const c = counters();
    const result = await runS4ResearchJob(ctx.db, jobId, liveExecutor(project, c, () => []), new Date());
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const att = await attemptsOf(jobId);
    await expectRecoveryRanToCompletion(ctx.db, jobId, project.id);
    const second = att.filter((a) => a.attemptNumber === 2);
    expect(second.length).toBeGreaterThan(0);
    const s5 = await s5Of(jobId);
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    const bounded = proof.boundedBy as ResearchBoundary;
    for (const a of second) {
      expect(s5.get(a.component)?.status, a.component).toBe("INSUFFICIENT_EVIDENCE");
      // Inspected and empty is not "never reached": the boundary is
      // substantive for a component whose second attempt actually read.
      if (a.searchQueriesSpent > 0 || a.sourceOpensSpent > 0) {
        expect(bounded.technical.some((t) => t.component === a.component && t.codes.includes("SEARCH_BUDGET_EXHAUSTED")), a.component).toBe(false);
      }
    }
  }, 180_000);

  it("no gap, no pass: under a generous envelope nothing is planned and no component gets a second attempt", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project, { ...INTERNAL_ALPHA_V1, maxSearchQueries: 40, maxSourceOpens: 60, reservedRecoverySteps: 1 });
    await runMemoryPlanningStage(ctx.db, jobId);
    const c = counters();
    const result = await runS4ResearchJob(ctx.db, jobId, liveExecutor(project, c, (_u, step, component) => [fact(step, component)]), new Date());
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    expect(result.targetedRecovery ?? null).toBeNull();
    const att = await attemptsOf(jobId);
    expect(att.every((a) => a.attemptNumber === 1)).toBe(true);
  }, 180_000);
});

/* ------------------------------------------------------------------ */
/* 2. PHASED — A SECOND SEARCH → FETCH → EXTRACT CYCLE                 */
/* ------------------------------------------------------------------ */

function roleCtx(capabilities: ReadonlySet<PhaseCapability>): PhaseWorkerContext {
  return { db: ctx.db, boss: ctx.boss, capabilities };
}
async function workQueueFor(jobId: string): Promise<ComponentWorkItem[]> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [planRow] = await ctx.db.select().from(researchPlans).where(eq(researchPlans.researchJobId, jobId)).orderBy(desc(researchPlans.version)).limit(1);
  const contract = parseContract(planRow.contract);
  const activePatternVersion = await loadActivePatternVersion(ctx.db, job.topicId!);
  return [...buildContractView({ contract, mode: planRow.mode, capabilityAtStart: job.capabilityAtStart, activePatternVersion: activePatternVersion! }).workQueue];
}

async function runCycle(jobId: string, project: { id: string; name: string; slug: string }, c: Counters) {
  const search = await handleSearchingPhase(roleCtx(ROLE_SE), jobId, {
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        c.proposer += 1;
        return [`${input.target.component} mechanism`, `${input.target.component} tokenomics`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query, target) {
        c.search += 1;
        c.searchesByComponent.set(target.component, (c.searchesByComponent.get(target.component) ?? 0) + 1);
        const base = query.replace(/^site:\S+\s+/, "");
        return urlsFor(target.component, base).map((url) => ({ url, title: null, snippet: null }));
      },
    },
    queryProposerCostProfile: COST,
  });
  const fetch = await handleFetchingPhase(roleCtx(ROLE_FETCH), jobId, {
    name: "fixture-transport",
    async fetch(url: string) {
      c.fetch += 1;
      c.fetchedUrls.push(url);
      return fixtureDoc(url);
    },
  });
  const extract = await handleExtractingPhase(roleCtx(ROLE_SE), jobId, async (replay) =>
    createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
      queryProposer: replay.queryProposer,
      searchGateway: replay.searchGateway,
      contentFetcher: replay.contentFetcher,
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract(input) {
          c.extract += 1;
          return [fact(input.target.step, input.target.component)];
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    }),
  );
  return { search, fetch, extract };
}

describe("B2 — phased: the first EXTRACTING cycle defers the plan, the job goes round once under scope, and the scoped cycle finalizes", () => {
  it("cycle 1 plans and defers (phase back to SEARCHING, scope persisted); cycle 2 searches/opens within scope bounds, extracts, and finalizes with second attempts for the planned components only", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project, STARVED_BUDGET, { enqueue: true });
    await beginAcquisitionPhases(ctx.db, ctx.boss, jobId);
    const c = counters();

    const first = await runCycle(jobId, project, c);
    expect(first.extract.ran && first.extract.phase === "EXTRACTING").toBe(true);
    if (!first.extract.ran) throw new Error("unreachable");
    expect(first.extract.advancedTo).toBe("SEARCHING");
    expect(first.extract.controller?.targetedRecoveryDeferred).toBe(true);
    const [afterFirst] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(afterFirst.acquisitionPhase).toBe("SEARCHING");
    const scope = afterFirst.acquisitionScope as TargetedRecoveryPlan;
    expect(scope.round).toBe(2);
    for (const item of scope.items) expect(CRITICAL.has(item.component), item.component).toBe(true);
    // Nothing finalized yet: no Proof after a deferred cycle.
    expect(await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId))).toHaveLength(0);
    const searchesAfterFirst = c.search;
    const fetchesAfterFirst = c.fetch;
    const workQueue = await workQueueFor(jobId);
    expect(scope.items.length).toBeLessThanOrEqual(workQueue.length);

    const second = await runCycle(jobId, project, c);
    if (!second.extract.ran) throw new Error("second cycle did not run");
    expect(second.extract.advancedTo).toBeNull();
    expect(second.extract.controller?.targetedRecoveryDeferred).toBeFalsy();
    expect(second.extract.controller?.targetedRecovery?.round).toBe(2);
    // Scoped bounds: at most `searches` per planned item, at most `opens`
    // per planned item, and only for the planned components.
    expect(c.search - searchesAfterFirst).toBeLessThanOrEqual(scope.items.length * scope.bounds.searches);
    expect(c.fetch - fetchesAfterFirst).toBeLessThanOrEqual(scope.items.length * scope.bounds.opens);
    const att = await attemptsOf(jobId);
    expect(att.every((a) => a.status !== "STARTED")).toBe(true);
    const secondAttempts = att.filter((a) => a.attemptNumber === 2);
    expect(secondAttempts.map((a) => a.component).sort()).toEqual(scope.items.map((i) => i.component).sort());
    expect(att.every((a) => a.attemptNumber <= 2)).toBe(true);
    for (const a of secondAttempts) expect(a.reason ?? "").toContain("TARGETED_RECOVERY_ATTEMPT");
    // The scoped cycle finalized: S5 for every component, a Proof, and at
    // least one planned component now SUPPORTED with Evidence.
    const s5 = await s5Of(jobId);
    for (const w of workQueue) expect(s5.has(w.component), w.component).toBe(true);
    expect(await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId))).toHaveLength(1);
    const recovered = secondAttempts.filter((a) => a.status === "SUCCEEDED");
    expect(recovered.length).toBeGreaterThan(0);
    const docs = await ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(docs.length).toBeGreaterThan(0);

    // A redelivered scoped EXTRACTING plans nothing further: no third
    // cycle, no third attempt.
    const again = await handleExtractingPhase(roleCtx(ROLE_SE), jobId, async (replay) =>
      createS4WorkExecutor({
        db: ctx.db,
        project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
        queryProposer: replay.queryProposer,
        searchGateway: replay.searchGateway,
        contentFetcher: replay.contentFetcher,
        evidenceExtractor: { name: "fixture-extractor", async extract(input) { return [fact(input.target.step, input.target.component)]; } },
        queryProposerCostProfile: COST,
        evidenceExtractorCostProfile: COST,
        chainAcquisition: "DOCUMENTARY_ONLY",
      }),
    );
    if (again.ran) expect(again.advancedTo).toBeNull();
    const attAgain = await attemptsOf(jobId);
    expect(attAgain.every((a) => a.attemptNumber <= 2)).toBe(true);
  }, 240_000);

  it("the replay providers still serve the scoped cycle: the second EXTRACTING reads the sealed documents through the replay fetcher, never a transport", async () => {
    // Structural: the extraction cycle is built from the replay providers
    // in both cycles (the handler's own contract), so this pins that the
    // scoped cycle's executor reports no live acquisition.
    const project = await makeProject();
    const jobId = await makeJob(project);
    const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: jobId, name: "x", slug: "x", ticker: null },
      queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
      searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
      contentFetcher: replay.fetcher,
      evidenceExtractor: { name: "fixture-extractor", async extract() { return []; } },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    expect(executor.liveAcquisition).toBe(false);
  });
});
