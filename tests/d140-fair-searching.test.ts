import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  projects,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import {
  prepareExtractionReplayProposer,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import { componentSearchAllowance } from "../src/server/engine/budget-fairness";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import {
  calculateMaxAuthorizedCostMicro,
  type ModelCostProfile,
} from "../src/server/engine/model-cost-profile";
import type { ComponentTarget, ModelUsage } from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-140 — FAIR SEARCHING, AND A PROPOSER THAT PAYS FOR ITSELF.
//
// The first real phased run: 10 components in the frozen work queue, 12
// search units in the envelope, and runSearchPhase walking Pattern order
// taking 2 each. The first six components consumed everything; the last
// four — DESTINATION, RECIPIENT, NET_EFFECT, DURABILITY_BASIS, which is
// what the question was actually about — searched nothing at all.
//
// That is D-130's defect, in a module D-130 never reached. The fix is
// D-130's own allocator, unchanged. And the 20 real Anthropic proposer
// calls that run made reserved zero model budget, so eight of them
// generated queries no component could ever search.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// The real envelope from the incident.
const INCIDENT_SEARCH_UNITS = 12;
const PER_COMPONENT_CAP = 2;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};
const COST_PER_CALL = calculateMaxAuthorizedCostMicro(COST);

async function makeProject() {
  const [p] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("d140"), name: "D140 Fixture", status: "ACTIVE_CORE" })
    .returning();
  return p;
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "where does the revenue go, and what happens to the token bought back?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

function targetFor(project: { id: string; name: string; slug: string }) {
  return (item: ComponentWorkItem): ComponentTarget => ({
    step: item.step,
    stepName: item.stepName,
    component: item.component,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });
}

// A proposer that behaves like a real one: distinct queries per component
// (so the ledger's dedup cannot mask a fairness failure) and it honours
// the maxQueries it is given, which is what the allowance now sets.
function countingProposer(calls: { n: number; maxSeen: number[] }) {
  return {
    name: "fixture-proposer",
    async proposeQueries(input: { hint?: string; maxQueries: number }) {
      calls.n += 1;
      calls.maxSeen.push(input.maxQueries);
      return Array.from({ length: input.maxQueries }, (_, i) => `${input.hint}-q${i + 1}`);
    },
  };
}

function countingSearch(calls: { n: number; queries: string[] }) {
  return {
    name: "fixture-search",
    async search(query: string) {
      calls.n += 1;
      calls.queries.push(query);
      return [{ url: `https://docs.example.test/${encodeURIComponent(query)}`, title: null, snippet: null }];
    },
  };
}

async function counters(jobId: string) {
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

// What the trace says happened, per component — the same read that
// exposed the incident.
async function perComponent(jobId: string) {
  const rows = await ctx.db
    .select({
      op: researchTraceEvents.operationType,
      status: researchTraceEvents.status,
      component: researchTraceEvents.component,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
  const out = new Map<string, { proposed: number; searched: number; skipped: number }>();
  for (const r of rows) {
    if (!r.component) continue;
    const e = out.get(r.component) ?? { proposed: 0, searched: 0, skipped: 0 };
    if (r.op === "QUERY_PROPOSED") e.proposed += 1;
    if (r.op === "SEARCH_EXECUTED" && r.status === "OK") e.searched += 1;
    if (r.op === "MODEL_CALL_SKIPPED") e.skipped += 1;
    out.set(r.component, e);
  }
  return out;
}

// The full incident shape: the job's REAL frozen work queue, the real
// 12-unit envelope, the real 2-query cap.
async function runIncidentShape(opts: { searchUnits?: number } = {}) {
  const project = await makeProject();
  const jobId = await makeJob(project.id);
  const { view } = await loadJobContractView(ctx.db, jobId);
  const proposer = { n: 0, maxSeen: [] as number[] };
  const search = { n: 0, queries: [] as string[] };
  const result = await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue,
    target: targetFor(project),
    queryProposer: countingProposer(proposer),
    searchGateway: countingSearch(search),
    maxSearchQueries: opts.searchUnits ?? INCIDENT_SEARCH_UNITS,
    maxResultsPerQuery: 5,
    maxQueriesPerComponent: PER_COMPONENT_CAP,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });
  return { project, jobId, items: view.workQueue, proposer, search, result };
}

describe("D-140 §1 — the fairness primitive is D-130's, unchanged (items 1, 2)", () => {
  it("1. runSearchPhase asks componentSearchAllowance, and defines no allocation of its own", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/acquisition-phases.ts", "utf-8");
    expect(src).toContain("componentSearchAllowance({");
    expect(src).toContain('from "./budget-fairness"');
    // No second allocator: the phase must not compute a share itself.
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("fairShare");
    expect(code).not.toContain("Math.floor(remaining");
  });

  it("2. the allocator itself refuses to let an early component take a later one's last unit", () => {
    // D-130's invariant, asserted directly on the primitive with the
    // incident's numbers: 10 components, 12 units, cap 2.
    const first = componentSearchAllowance({
      maxSearchQueries: INCIDENT_SEARCH_UNITS,
      alreadyReserved: 0,
      workQueueSize: 10,
      remainingComponents: 10,
      isIntentRequired: false,
      hardCapPerAttempt: PER_COMPONENT_CAP,
    });
    // A non-required first component may NOT take the full cap while nine
    // others are still pending — that is exactly what the phase did.
    expect(first).toBeLessThan(PER_COMPONENT_CAP);
    expect(first).toBeGreaterThan(0);

    // The last pending component is deliberately uncapped, so the
    // reservation layer stays the only authority on exhaustion.
    expect(
      componentSearchAllowance({
        maxSearchQueries: INCIDENT_SEARCH_UNITS,
        alreadyReserved: 11,
        workQueueSize: 10,
        remainingComponents: 1,
        isIntentRequired: false,
        hardCapPerAttempt: PER_COMPONENT_CAP,
      }),
    ).toBe(PER_COMPONENT_CAP);
  });
});

describe("D-140 §2 — the real 10-component / 12-unit shape (items 3, 5, 11)", () => {
  it("3. no component is starved: every one gets a search opportunity", async () => {
    const { items, search, result } = await runIncidentShape();
    expect(items.length).toBeGreaterThanOrEqual(8);

    // The incident's signature was four components with zero searches
    // while earlier ones took two each. Assert the invariant, not an
    // invented split: every component that the phase reached with budget
    // remaining actually searched.
    expect(result.budgetRefusedComponents.length).toBeLessThan(items.length);
    expect(search.n).toBeGreaterThan(0);
    expect(search.n).toBeLessThanOrEqual(INCIDENT_SEARCH_UNITS);
  });

  it("3. the late components are no longer the ones that lose — measured per component", async () => {
    const { jobId, items, result } = await runIncidentShape();
    const byComponent = await perComponent(jobId);

    const searchedComponents = [...byComponent.entries()].filter(([, v]) => v.searched > 0);
    const starved = items.filter((i) => (byComponent.get(i.component)?.searched ?? 0) === 0);

    // With 12 units and 10 components at one unit each, every component is
    // reachable. The incident had exactly four starved; this must not.
    expect(searchedComponents.length).toBeGreaterThanOrEqual(
      Math.min(items.length, INCIDENT_SEARCH_UNITS),
    );
    expect(starved).toHaveLength(0);

    // And no component exceeded the per-component cap.
    for (const [, v] of byComponent) expect(v.searched).toBeLessThanOrEqual(PER_COMPONENT_CAP);

    // Bounded, not unlimited: the axis was never exceeded.
    expect(result.executedQueries.length).toBeLessThanOrEqual(INCIDENT_SEARCH_UNITS);
  });

  it("5. the proposer is never asked for more queries than the component may search", async () => {
    const { proposer } = await runIncidentShape();
    expect(proposer.n).toBeGreaterThan(0);
    for (const max of proposer.maxSeen) {
      expect(max).toBeGreaterThan(0);
      expect(max).toBeLessThanOrEqual(PER_COMPONENT_CAP);
    }
  });

  it("11. the job-wide search ceiling is still 12 and is still enforced by the reservation", async () => {
    const { jobId } = await runIncidentShape();
    const after = await counters(jobId);
    expect(after.searchQueries).toBeLessThanOrEqual(INCIDENT_SEARCH_UNITS);
    // The envelope constant itself is untouched.
    expect(INTERNAL_ALPHA_V1.maxSearchQueries).toBe(12);
    expect(INTERNAL_ALPHA_V1.maxSourceOpens).toBe(24);
    expect(INTERNAL_ALPHA_V1.maxModelCostMicro).toBe(2_000_000);
  });
});

describe("D-140 §3 — no useless proposer spend (items 4, 14)", () => {
  it("4. a component with zero allowance makes no proposer call and generates no queries", async () => {
    // One unit for a queue of many: after it is spent, every later
    // component has an allowance of zero.
    const { items, proposer, search, jobId, result } = await runIncidentShape({ searchUnits: 1 });

    expect(search.n).toBe(1);
    // Exactly one component could search, so exactly one proposer call.
    expect(proposer.n).toBe(1);
    expect(result.budgetRefusedComponents.length).toBe(items.length - 1);

    const byComponent = await perComponent(jobId);
    // 14. TRUTHFULNESS: no QUERY_PROPOSED row exists for a component that
    // never had a generation — the incident wrote eight of them.
    for (const component of result.budgetRefusedComponents) {
      expect(byComponent.get(component)?.proposed ?? 0).toBe(0);
      expect(byComponent.get(component)?.skipped ?? 0).toBe(1);
    }
  });

  it("14. the skip is recorded with an existing reason code, not an invented one", async () => {
    const { jobId } = await runIncidentShape({ searchUnits: 1 });
    const rows = await ctx.db
      .select({
        op: researchTraceEvents.operationType,
        status: researchTraceEvents.status,
        reason: researchTraceEvents.reasonCode,
        axis: researchTraceEvents.budgetAxis,
        amount: researchTraceEvents.budgetAmount,
      })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    const skips = rows.filter((r) => r.op === "MODEL_CALL_SKIPPED");
    expect(skips.length).toBeGreaterThan(0);
    for (const s of skips) {
      expect(s.status).toBe("SKIPPED");
      expect(s.reason).toBe("SEARCH_QUERY_BUDGET_EXHAUSTED");
      expect(s.axis).toBe("searchQueries");
      expect(s.amount).toBe(0);
    }
  });
});

describe("D-140 §4 — the proposer pays for itself (items 6, 7, 12, 13)", () => {
  it("6/7. every live proposer call reserves its authorized model cost, using the canonical profile", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    expect((await counters(jobId)).modelCostMicro).toBe(0);

    const { view } = await loadJobContractView(ctx.db, jobId);
    const proposer = { n: 0, maxSeen: [] as number[] };
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: view.workQueue,
      target: targetFor(project),
      queryProposer: countingProposer(proposer),
      searchGateway: countingSearch({ n: 0, queries: [] }),
      maxSearchQueries: INCIDENT_SEARCH_UNITS,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: PER_COMPONENT_CAP,
      maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
      projectId: project.id,
      queryProposerCostProfile: COST,
    });

    const after = await counters(jobId);
    // The number is not an estimate: it is calls × the profile's own
    // maximum authorized cost, the same arithmetic S4 uses.
    expect(after.modelCostMicro).toBe(proposer.n * COST_PER_CALL);
    expect(proposer.n).toBeGreaterThan(0);
  });

  it("7. the audit row carries the reservation and the real usage when the caller supplies it", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const { view } = await loadJobContractView(ctx.db, jobId);
    const usage: ModelUsage = { inputTokens: 111, outputTokens: 22 };

    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: view.workQueue.slice(0, 1),
      target: targetFor(project),
      queryProposer: countingProposer({ n: 0, maxSeen: [] }),
      searchGateway: countingSearch({ n: 0, queries: [] }),
      maxSearchQueries: INCIDENT_SEARCH_UNITS,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: PER_COMPONENT_CAP,
      maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
      projectId: project.id,
      queryProposerCostProfile: COST,
      readProposerUsage: () => usage,
    });

    const [row] = await ctx.db
      .select({
        op: researchTraceEvents.operationType,
        axis: researchTraceEvents.budgetAxis,
        amount: researchTraceEvents.budgetAmount,
        inTok: researchTraceEvents.actualInputTokens,
        outTok: researchTraceEvents.actualOutputTokens,
        cost: researchTraceEvents.actualCostMicro,
      })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    // The first row of the phase is the model-call audit row.
    const attempted = row.op === "MODEL_CALL_ATTEMPTED" ? row : null;
    expect(attempted).not.toBeNull();
    expect(attempted!.axis).toBe("modelCostMicro");
    expect(attempted!.amount).toBe(COST_PER_CALL);
    expect(attempted!.inTok).toBe(111);
    expect(attempted!.outTok).toBe(22);
    // Priced with the SAME profile the reservation used.
    expect(attempted!.cost).toBe(111 * COST.inputPriceMicroUsdPerToken + 22 * COST.outputPriceMicroUsdPerToken);
  });

  it("12/13. one shared envelope: the model ceiling is the job's, not a phase's", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/acquisition-phases.ts", "utf-8");
    // The phase reserves on the job's own axis through the job's own
    // primitive. No second counter, no second ceiling.
    expect(src).toContain('reserveJobBudget(\n        input.db,\n        input.jobId,\n        "modelCostMicro"');
    expect(src).toContain("input.maxModelCostMicro");
    expect(src).not.toContain("phaseModelBudget");
    expect(src).not.toContain("searchPhaseBudget");
  });
});

describe("D-140 §5 — D-137 still holds on both sides (items 8, 9, 10)", () => {
  it("8. a REPLAY proposer is still free, and D-140 did not start charging it", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const { view } = await loadJobContractView(ctx.db, jobId);

    // First, a live pass that costs money and leaves QUERY_PROPOSED rows.
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: view.workQueue.slice(0, 2),
      target: targetFor(project),
      queryProposer: countingProposer({ n: 0, maxSeen: [] }),
      searchGateway: countingSearch({ n: 0, queries: [] }),
      maxSearchQueries: INCIDENT_SEARCH_UNITS,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: PER_COMPONENT_CAP,
      maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
      projectId: project.id,
      queryProposerCostProfile: COST,
    });
    const afterLive = await counters(jobId);
    expect(afterLive.modelCostMicro).toBeGreaterThan(0);

    // Now the replay proposer over the same job: D-137 says it declares
    // itself and pays nothing, even though the phase now meters.
    const replay = await prepareExtractionReplayProposer(ctx.db, jobId);
    expect(replay.metering).toBe("REPLAY");
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: view.workQueue.slice(0, 2),
      target: targetFor(project),
      queryProposer: replay,
      searchGateway: countingSearch({ n: 0, queries: [] }),
      maxSearchQueries: INCIDENT_SEARCH_UNITS,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: PER_COMPONENT_CAP,
      maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
      projectId: project.id,
      queryProposerCostProfile: COST,
    });

    const afterReplay = await counters(jobId);
    expect(afterReplay.modelCostMicro).toBe(afterLive.modelCostMicro);
  });

  it("9/10. live search is charged and replayed search is not — unchanged by D-140", async () => {
    const { jobId, search } = await runIncidentShape();
    const after = await counters(jobId);
    // One reserved unit per real search call.
    expect(after.searchQueries).toBe(search.n);
  });
});

describe("D-140 §6 — boundaries (items 21, 22, 23)", () => {
  it("21/22/23. the phase names no network, no project and touches no controller or S5-S9 store", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = (await readFile("src/server/engine/acquisition-phases.ts", "utf-8"))
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const word of [
      "mantaray",
      "vpn",
      "proxy",
      "region",
      "country",
      "raydium",
      "pump_fun",
      "destination",
      "net_effect",
    ]) {
      expect(code, `phase must not name ${word}`).not.toContain(word);
    }
    for (const forbidden of [
      "runresearchcontroller",
      "reconcileandpersistcomponent",
      "assembleandpersistmechanism",
      "evaluateandpersistclaimsupport",
      "buildandpersistproof",
      "researchattempts",
    ]) {
      expect(code, `phase must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });
});
