import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { evidence, interpretations, projects, researchAttempts, researchComponentResults, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { loadAcquisitionLedger, routeExploredForComponent, routeScopedQueryDomain } from "../src/server/engine/acquisition-ledger";
import { runResearchController } from "../src/server/engine/controller";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { PATTERN_V1_CONTENT, criticalComponentsFor } from "../src/server/domain/pattern";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { planTargetedRecovery, scopedWorkItems, TARGETED_RECOVERY_BOUNDS, type TargetedRecoveryPlan } from "../src/server/engine/targeted-recovery";
import { expectRecoveryRanToCompletion } from "./recovery-continuation-assertions";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH RELIABILITY V1 — C2, THE TWO BOUNDED COMPLETION/RECOVERY DEFECTS.
//
// The benchmark invariant: a Research must not finalize while a critical
// component is unresolved AND a known admissible path capable of resolving
// it is still unexplored. Two generic conditions broke it:
//
//   1. EVIDENCE-STATE RECOVERY ELIGIBILITY. The targeted second pass
//      selected its components from persisted S5 state, but the controller
//      then dropped every item whose first attempt had technical status
//      SUCCEEDED — so a critical component whose only Evidence S5 excluded
//      (stale for a current-state component) never got its second look,
//      with sealed documents on the confirmed route still unread for it.
//      Recovery eligibility is now the component's persisted result state,
//      gated only by the one-recovery maximum. Freshness is not weakened:
//      a stale observation stays excluded; acquisition merely keeps
//      looking for better evidence, once.
//
//   2. ROUTE EXPLORATION ACCOUNTING. A confirmed route on which a
//      component's route-scoped search (`site:<domain> …`) actually ran and
//      returned zero candidates was still ROUTE_UNEXPLORED, so the second
//      pass spent a search unit asking the same route again. An executed,
//      answered, metered scoped search now marks the route explored for
//      that component. A refused (budget-denied), failed (provider error)
//      or replayed search does not: technical failure ≠ explored, and zero
//      results ≠ the fact is absent — only that this bounded path was tried.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const HOST = "docs.c2-eligibility.test";
const OTHER_HOST = "blog.unconfirmed.test";
const SENTENCE = "Protocol fees are used to buy back the token and bought-back tokens are held at a public address.";
const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
// Generous: no component is starved, so every first attempt completes
// technically — the shape in which defect 1 hides.
const GENEROUS_BUDGET = { ...INTERNAL_ALPHA_V1, maxSearchQueries: 40, maxSourceOpens: 60, reservedRecoverySteps: 1 };
const INTENT = "PROTOCOL_REVENUE_TO_TOKEN";
const CRITICAL = new Set(criticalComponentsFor(PATTERN_V1_CONTENT, INTENT));
const DAY_MS = 24 * 3600 * 1000;

function urlsFor(host: string, component: string, query: string): string[] {
  const slug = component.toLowerCase().replace(/_/g, "-");
  const n = query.endsWith("mechanism") ? 1 : 2;
  return [`https://${host}/mechanism/${slug}-${n}`, `https://${host}/mechanism/${slug}-${n}-b`];
}
function fixtureDoc(url: string): FetchedDocument {
  const text = `${SENTENCE} Details for ${url}.`;
  return { finalUrl: url, requestedUrl: url, httpStatus: 200, contentType: "text/markdown", normalizedText: text, contentHash: `sha256:${url}`, fetchedAt: new Date(), byteLength: text.length };
}
function fact(step: number, component: string, ageDays: number): ExtractedFact {
  return { step, component, statement: SENTENCE, supportFragment: SENTENCE, mechanismState: "LIVE", directness: "DIRECT", publishedAt: new Date(Date.now() - ageDays * DAY_MS), doesNotProve: "does not establish that any buyback executed", relationship: "SUPPORTS", onchainLocator: null, onchainLocators: null };
}
const fresh = (step: number, component: string) => fact(step, component, 1);
// Far outside every freshness class — excluded at S5 as STALE_FOR_CURRENT_STATE.
const stale = (step: number, component: string) => fact(step, component, 400);

async function makeProject() {
  const slug = uniq("c2");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "C2 Eligibility", status: "ACTIVE_CORE" }).returning();
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: HOST, pathPrefix: "/mechanism" });
  if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}

async function makeJob(project: { id: string; slug: string }, budget = GENEROUS_BUDGET): Promise<string> {
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
    { skipEnqueue: true },
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
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

interface Counters {
  search: number;
  fetch: number;
  extract: number;
  searchQueries: string[];
  searchesByComponent: Map<string, number>;
}
function counters(): Counters {
  return { search: 0, fetch: 0, extract: 0, searchQueries: [], searchesByComponent: new Map() };
}

function liveExecutor(
  project: { id: string; name: string; slug: string },
  c: Counters,
  opts: {
    search: (query: string, component: string) => string[];
    extract: (url: string, step: number, component: string) => ExtractedFact[];
  },
) {
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        return [`${input.target.component} mechanism`, `${input.target.component} tokenomics`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query, target) {
        c.search += 1;
        c.searchQueries.push(query);
        c.searchesByComponent.set(target.component, (c.searchesByComponent.get(target.component) ?? 0) + 1);
        return opts.search(query, target.component).map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture-transport",
      async fetch(url: string) {
        c.fetch += 1;
        return fixtureDoc(url);
      },
    },
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        c.extract += 1;
        return opts.extract(input.document.finalUrl, input.target.step, input.target.component);
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: "DOCUMENTARY_ONLY",
  });
}

// Every query — generic or `site:`-scoped — finds the component's own two
// pages on the confirmed route.
const searchOnRoute = (query: string, component: string) => urlsFor(HOST, component, query.replace(/^site:\S+\s+/, ""));

async function attemptsOf(jobId: string) {
  return ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
}
async function s5Of(jobId: string) {
  const rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  return new Map(rows.map((r) => [r.component, r]));
}
async function traceOf(jobId: string) {
  return ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
}

/* ------------------------------------------------------------------ */
/* 1. EVIDENCE-STATE RECOVERY ELIGIBILITY                              */
/* ------------------------------------------------------------------ */

describe("C2/1 — recovery eligibility is the persisted evidence state, not the first attempt's technical status", () => {
  it("A: first attempt SUCCEEDED technically, every Evidence stale/excluded at S5, sealed documents on the confirmed route unread for it → the one bounded recovery runs and resolves it; genuinely resolved critical components get no second attempt", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    const c = counters();
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      liveExecutor(project, c, {
        search: searchOnRoute,
        // CURRENT_STATE's own pages carry only a stale observation; every
        // other page on the route (sealed by the other components) carries
        // a fresh one for it. The recovery can only find the fresh
        // observation by reading a document the first pass never extracted
        // for this component.
        extract: (url, step, component) => (component === "CURRENT_STATE" && url.includes("/current-state-") ? [stale(step, component)] : [fresh(step, component)]),
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");

    const att = await attemptsOf(jobId);
    expect(att.every((a) => a.status !== "STARTED")).toBe(true);
    // THE DEFECT'S PRECONDITION: the first attempt completed technically —
    // it produced Evidence — and that Evidence was stale.
    const first = att.find((a) => a.component === "CURRENT_STATE" && a.attemptNumber === 1);
    expect(first?.status).toBe("SUCCEEDED");
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    const staleRows = ev.filter((e) => e.component === "CURRENT_STATE" && e.publishedAt !== null && Date.now() - e.publishedAt.getTime() > 300 * DAY_MS);
    expect(staleRows.length).toBeGreaterThan(0);

    // The plan selected CURRENT_STATE from S5 (INSUFFICIENT_EVIDENCE /
    // STALE_CURRENT_STATE) with a sealed, unextracted path — and the
    // controller WALKED it.
    const plan = result.targetedRecovery as TargetedRecoveryPlan;
    expect(plan).toBeTruthy();
    const planned = plan.items.find((i) => i.component === "CURRENT_STATE");
    expect(planned).toBeDefined();
    expect(planned!.reasonCodes).toContain("STALE_CURRENT_STATE");
    expect(planned!.paths.some((p) => p.kind === "SEALED_UNEXTRACTED")).toBe(true);
    const second = att.find((a) => a.component === "CURRENT_STATE" && a.attemptNumber === 2);
    expect(second).toBeDefined();
    expect(second!.reason ?? "").toContain("TARGETED_RECOVERY_ATTEMPT");
    expect(second!.searchQueriesSpent).toBeLessThanOrEqual(TARGETED_RECOVERY_BOUNDS.searches);
    expect(second!.sourceOpensSpent).toBeLessThanOrEqual(TARGETED_RECOVERY_BOUNDS.opens);
    expect(result.targetedRecoveryAttempts).toBe(plan.items.length);

    // Resolved by the recovery — on FRESH Evidence only. Freshness was not
    // weakened: the stale rows are still excluded, never supporting.
    const s5 = await s5Of(jobId);
    const row = s5.get("CURRENT_STATE")!;
    expect(row.status).toBe("SUPPORTED");
    const supporting = new Set(row.supportingEvidenceIds as string[]);
    for (const r of staleRows) expect(supporting.has(r.id), r.id).toBe(false);
    // Every stale row is excluded — as stale, or as superseded/duplicated
    // by the fresh observation that now establishes the component; never
    // admitted.
    const excluded = row.excludedEvidence as { evidenceId: string; reason: string }[];
    for (const r of staleRows) {
      const entry = excluded.find((x) => x.evidenceId === r.id);
      expect(entry, r.id).toBeDefined();
      expect(["STALE_FOR_CURRENT_STATE", "SUPERSEDED_BY_NEWER", "DUPLICATE_UNIT"], r.id).toContain(entry!.reason);
    }
    expect(ev.some((e) => e.component === "CURRENT_STATE" && supporting.has(e.id) && e.publishedAt !== null && Date.now() - e.publishedAt.getTime() < 30 * DAY_MS)).toBe(true);

    // No extra recovery for a genuinely resolved critical component, and
    // never more than one recovery for anything.
    for (const comp of CRITICAL) {
      if (comp === "CURRENT_STATE") continue;
      if (s5.get(comp)?.status === "SUPPORTED") {
        expect(att.filter((a) => a.component === comp).map((a) => a.attemptNumber), comp).toEqual([1]);
      }
    }
    expect(Math.max(...att.map((a) => a.attemptNumber))).toBe(2);
  }, 180_000);

  it("A2: recovery continues round by round while it consumes known paths, even when each round closes technically SUCCEEDED on excluded Evidence — a stale observation stays stale, it stops when the paths are used up, and a re-walk of the same scope claims nothing", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    const c = counters();
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      liveExecutor(project, c, {
        search: searchOnRoute,
        // Every page yields only a stale observation for CURRENT_STATE.
        extract: (_url, step, component) => (component === "CURRENT_STATE" ? [stale(step, component)] : [fresh(step, component)]),
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const plan = result.targetedRecovery as TargetedRecoveryPlan;
    expect(plan?.items.some((i) => i.component === "CURRENT_STATE")).toBe(true);
    const att = await attemptsOf(jobId);
    const cs = att.filter((a) => a.component === "CURRENT_STATE").sort((a, b) => a.attemptNumber - b.attemptNumber);
    expect(cs.length).toBeGreaterThanOrEqual(2);
    await expectRecoveryRanToCompletion(ctx.db, jobId, project.id);
    // Every attempt completed technically; none resolved the component.
    expect(cs[0].status).toBe("SUCCEEDED");
    const s5 = await s5Of(jobId);
    expect(s5.get("CURRENT_STATE")?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(s5.get("CURRENT_STATE")?.reasonCodes as string[]).toContain("STALE_CURRENT_STATE");

    // The planner never plans it again (its recovery is spent) …
    const { view } = await loadJobContractView(ctx.db, jobId);
    const again = await planTargetedRecovery(ctx.db, jobId, project.id, view.workQueue);
    expect(again?.items.some((i) => i.component === "CURRENT_STATE") ?? false).toBe(false);
    // … and a redelivered scoped walk of the SAME (last) plan claims
    // nothing: the round guard holds in the controller too, whatever the
    // attempts' technical statuses.
    const rewalk = await runResearchController({
      db: ctx.db,
      jobId,
      view,
      executor: liveExecutor(project, c, { search: searchOnRoute, extract: (_u, step, component) => [fresh(step, component)] }),
      now: new Date(),
      reconcile: reconcileAndPersistComponent,
      pendingOverride: scopedWorkItems(plan, view.workQueue),
      targetedRecovery: plan,
    });
    expect(rewalk.attemptsThisRun).toBe(0);
    const attAfter = await attemptsOf(jobId);
    expect(Math.max(...attAfter.map((a) => a.attemptNumber))).toBe(cs.length);
  }, 180_000);
});

/* ------------------------------------------------------------------ */
/* 2. ROUTE EXPLORATION ACCOUNTING                                     */
/* ------------------------------------------------------------------ */

// A job frozen at "first pass done, critical component unresolved, no
// candidate ever found on the confirmed route" — the state in which the
// planner decides whether the route is still a known path. The trace rows
// under test are then written exactly as the two runtimes write them.
async function frozenUnresolved(project: { id: string; slug: string }) {
  const jobId = await makeJob(project);
  const { view } = await loadJobContractView(ctx.db, jobId);
  const item = view.workQueue.find((w) => w.component === "MECHANISM_SPEC")!;
  await ctx.db.insert(researchAttempts).values({ researchJobId: jobId, patternStep: item.step, component: item.component, attemptNumber: 1, status: "SKIPPED", reason: "NO_SEARCH_CANDIDATES", completedAt: new Date() });
  await ctx.db.insert(researchComponentResults).values({ researchJobId: jobId, patternStep: item.step, component: item.component, status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], requiresFreshEvidence: false });
  return { jobId, item, workQueue: view.workQueue };
}
type SearchRow = { status: "OK" | "FAILED" | "SKIPPED"; query: string; budgetAmount: number | null; step?: number | null; component?: string | null };
async function writeSearch(jobId: string, item: { step: number; component: string }, rows: SearchRow[]) {
  for (const r of rows) {
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      providerKind: "SEARCH",
      providerName: "fixture-search",
      patternStep: r.step === undefined ? item.step : r.step,
      component: r.component === undefined ? item.component : r.component,
      targetRef: r.query,
      status: r.status,
      reasonCode: r.status === "OK" ? "NONE" : r.status === "FAILED" ? "PROVIDER_ERROR" : "SEARCH_QUERY_BUDGET_EXHAUSTED",
      budgetAxis: "searchQueries",
      budgetAmount: r.budgetAmount,
    });
  }
}
async function routePathsFor(jobId: string, projectId: string, workQueue: Parameters<typeof planTargetedRecovery>[3], component: string) {
  const plan = await planTargetedRecovery(ctx.db, jobId, projectId, workQueue);
  const item = plan?.items.find((i) => i.component === component) ?? null;
  return { plan, item, routes: (item?.paths ?? []).filter((p) => p.kind === "ROUTE_UNEXPLORED").map((p) => p.domain) };
}

describe("C2/2 — a confirmed route is explored once a scoped search actually ran against it, and only then", () => {
  it("parses the code-owned route-scoped form only", () => {
    expect(routeScopedQueryDomain(`site:${HOST} buyback mechanism`)).toBe(HOST);
    expect(routeScopedQueryDomain(`SITE:${HOST.toUpperCase()}`)).toBe(HOST);
    expect(routeScopedQueryDomain("buyback mechanism site:docs.example")).toBeNull();
    expect(routeScopedQueryDomain(`route:${HOST}/mechanism`)).toBeNull();
    expect(routeScopedQueryDomain("")).toBeNull();
  });

  it("control: with no scoped search the confirmed route is a known unexplored path", async () => {
    const project = await makeProject();
    const { jobId, workQueue } = await frozenUnresolved(project);
    const { routes } = await routePathsFor(jobId, project.id, workQueue, "MECHANISM_SPEC");
    expect(routes).toEqual([HOST]);
  });

  it("B: an executed scoped search with ZERO results explores the route — the component is not planned again for it", async () => {
    const project = await makeProject();
    const { jobId, item, workQueue } = await frozenUnresolved(project);
    await writeSearch(jobId, item, [{ status: "OK", query: `site:${HOST} mechanism spec`, budgetAmount: 1 }]);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(routeExploredForComponent(ledger, item.step, item.component, HOST)).toBe(true);
    const { plan, routes } = await routePathsFor(jobId, project.id, workQueue, "MECHANISM_SPEC");
    expect(routes).toEqual([]);
    // No other path either: nothing to recover through, so no second pass
    // (and no search unit spent re-asking the same route).
    expect(plan?.items.some((i) => i.component === "MECHANISM_SPEC") ?? false).toBe(false);
  });

  it("provider failure does not mark the route explored", async () => {
    const project = await makeProject();
    const { jobId, item, workQueue } = await frozenUnresolved(project);
    await writeSearch(jobId, item, [{ status: "FAILED", query: `site:${HOST} mechanism spec`, budgetAmount: 1 }]);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(routeExploredForComponent(ledger, item.step, item.component, HOST)).toBe(false);
    // The unit was spent (dedupe memory), but nothing about the route was learned.
    expect(ledger.executedQueries.has(`site:${HOST} mechanism spec`)).toBe(true);
    const { routes } = await routePathsFor(jobId, project.id, workQueue, "MECHANISM_SPEC");
    expect(routes).toEqual([HOST]);
  });

  it("a refused (budget-denied) scoped search does not mark the route explored", async () => {
    const project = await makeProject();
    const { jobId, item, workQueue } = await frozenUnresolved(project);
    await writeSearch(jobId, item, [{ status: "SKIPPED", query: `site:${HOST} mechanism spec`, budgetAmount: 0 }]);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(routeExploredForComponent(ledger, item.step, item.component, HOST)).toBe(false);
    const { routes } = await routePathsFor(jobId, project.id, workQueue, "MECHANISM_SPEC");
    expect(routes).toEqual([HOST]);
  });

  it("a replayed scoped search (no unit spent) does not mark the route explored", async () => {
    const project = await makeProject();
    const { jobId, item, workQueue } = await frozenUnresolved(project);
    await writeSearch(jobId, item, [{ status: "OK", query: `site:${HOST} mechanism spec`, budgetAmount: 0 }]);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(routeExploredForComponent(ledger, item.step, item.component, HOST)).toBe(false);
    const { routes } = await routePathsFor(jobId, project.id, workQueue, "MECHANISM_SPEC");
    expect(routes).toEqual([HOST]);
  });

  it("a scoped search on an unconfirmed host, or by another component, or unattributed, does not mark THIS component's confirmed route explored", async () => {
    const project = await makeProject();
    const { jobId, item, workQueue } = await frozenUnresolved(project);
    const other = workQueue.find((w) => w.component !== item.component)!;
    await writeSearch(jobId, item, [
      { status: "OK", query: `site:${OTHER_HOST} mechanism spec`, budgetAmount: 1 },
      { status: "OK", query: `site:${HOST} mechanism spec`, budgetAmount: 1, step: other.step, component: other.component },
      { status: "OK", query: `site:${HOST} mechanism spec`, budgetAmount: 1, step: null, component: null },
    ]);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(routeExploredForComponent(ledger, item.step, item.component, HOST)).toBe(false);
    expect(routeExploredForComponent(ledger, other.step, other.component, HOST)).toBe(true);
    const { routes } = await routePathsFor(jobId, project.id, workQueue, "MECHANISM_SPEC");
    expect(routes).toEqual([HOST]);
  });

  it("end to end (unphased): a first pass whose scoped searches return nothing on the confirmed route does not re-search that route in a second pass", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project);
    const c = counters();
    const result = await runS4ResearchJob(
      ctx.db,
      jobId,
      liveExecutor(project, c, {
        // The confirmed route answers nothing; generic queries find pages
        // on an unconfirmed host, which are opened and read and yield no
        // fact — so every documentary component stays unresolved.
        search: (query, component) => (query.startsWith("site:") ? [] : urlsFor(OTHER_HOST, component, query)),
        extract: () => [],
      }),
      new Date(),
    );
    expect(result.stopReason).toBe("WORK_QUEUE_EXHAUSTED");
    const trace = await traceOf(jobId);
    const scopedOk = trace.filter((t) => t.operationType === "SEARCH_EXECUTED" && t.status === "OK" && (t.budgetAmount ?? 0) > 0 && routeScopedQueryDomain(t.targetRef ?? "") === HOST);
    // Precondition: the first pass really ran a scoped search on the route
    // for critical documentary components, and it returned nothing.
    const scopedComponents = new Set(scopedOk.map((t) => t.component));
    expect([...CRITICAL].some((comp) => scopedComponents.has(comp))).toBe(true);
    for (const comp of scopedComponents) {
      expect(trace.some((t) => t.operationType === "CANDIDATE_RETURNED" && t.component === comp && (t.targetRef ?? "").includes(HOST)), comp!).toBe(false);
    }
    const s5 = await s5Of(jobId);
    for (const comp of scopedComponents) expect(s5.get(comp!)?.status, comp!).toBe("INSUFFICIENT_EVIDENCE");
    // The route is explored for those components: no ROUTE_UNEXPLORED for
    // it in the plan, and no second scoped search against it.
    const plan = (result.targetedRecovery ?? null) as TargetedRecoveryPlan | null;
    for (const comp of scopedComponents) {
      const planned = plan?.items.find((i) => i.component === comp) ?? null;
      expect(planned?.paths.some((p) => p.kind === "ROUTE_UNEXPLORED" && p.domain === HOST) ?? false, comp!).toBe(false);
    }
    const scopedSearchesByComponent = new Map<string, number>();
    for (const t of trace) {
      if (t.operationType !== "SEARCH_EXECUTED" || routeScopedQueryDomain(t.targetRef ?? "") !== HOST || t.component === null) continue;
      scopedSearchesByComponent.set(t.component, (scopedSearchesByComponent.get(t.component) ?? 0) + 1);
    }
    for (const [comp, n] of scopedSearchesByComponent) {
      // One scoped search per component per first attempt at most
      // (buildTargetedQueries emits one per confirmed domain); a second
      // pass re-asking the route would show as a second row.
      expect(n, comp).toBe(1);
    }
    // And the second pass, if any, never ran a scoped search on the route.
    const att = await attemptsOf(jobId);
    for (const a of att.filter((a) => a.attemptNumber === 2)) {
      const rowsOfSecond = trace.filter((t) => t.researchAttemptId === a.id && t.operationType === "SEARCH_EXECUTED" && routeScopedQueryDomain(t.targetRef ?? "") === HOST);
      expect(rowsOfSecond, a.component).toHaveLength(0);
    }
  }, 180_000);
});
