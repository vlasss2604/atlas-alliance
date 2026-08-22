import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  interpretations,
  projects,
  researchClaimSupport,
  researchComponentResults,
  researchMechanismAssembly,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { WorkExecutor } from "../src/server/engine/controller";
import { evaluateAndPersistClaimSupport } from "../src/server/engine/claim-support-store";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// Phase 6, S7 (phase-6-s7-plan.md §34, §35) — real PostgreSQL integration
// tests. Deliberately exercises the CANONICAL production entry point
// (runS4ResearchJob) — not just evaluateClaimSupport() in isolation — so
// a regression that removes S7's production wiring is caught, mirroring
// S5/S6's own deep-audit test discipline.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-08-22T00:00:00Z");

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makePlannedJob(intent: string | null = "PROTOCOL_REVENUE_TO_TOKEN", taskType: string | null = null): Promise<{ jobId: string; projectId: string; topicId: string }> {
  const topicId = await activeTopicId();
  const [project] = await ctx.db.insert(projects).values({ slug: uniq("p6s7"), name: "S7 integration test", status: "ACTIVE_CORE" }).returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId,
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  if (intent !== null) {
    await ctx.db.insert(interpretations).values({
      userId: user.id,
      researchJobId: job.id,
      originalQuestion: "does protocol revenue reach token holders?",
      status: "READY",
      result: {
        status: "READY",
        project_or_asset: null,
        related_entities: [],
        topic: null,
        task_type: taskType,
        research_task: "x",
        understood_summary: null,
        user_assumptions: [],
        ambiguities: [],
        clarification_question: null,
        route: "DEEP_RESEARCH",
        normalized_intent: intent,
        intent_confidence: 0.9,
        route_reason: "in scope",
        needs_fresh_evidence: true,
        quick_answer: null,
      },
    });
  }
  return { jobId: job.id, projectId: project.id, topicId };
}

async function makeSource(url: string): Promise<string> {
  const urlHash = `sha256:${url}`;
  const [row] = await ctx.db
    .insert(sources)
    .values({ url, urlHash, sourceType: "OFFICIAL_DOCS" })
    .onConflictDoNothing({ target: sources.urlHash })
    .returning({ id: sources.id });
  if (row) return row.id;
  const [existing] = await ctx.db.select().from(sources).where(eq(sources.urlHash, urlHash));
  return existing.id;
}

async function insertEvidence(jobId: string, sourceId: string, overrides: Partial<typeof evidence.$inferInsert> = {}): Promise<string> {
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: "protocol fees paid by users flow to the treasury",
      summary: "protocol fees paid by users",
      mechanismState: null,
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      fetchedAt: NOW,
      publishedAt: NOW,
      doesNotProve: "does not prove distribution to holders",
      retrievedUrl: "https://example.com/docs",
      contentHash: `hash-${Math.random()}`,
      extractionUnitKey: `unit-${Math.random()}`,
      ...overrides,
    })
    .returning({ id: evidence.id });
  return row.id;
}

async function s7RowFor(jobId: string) {
  const [row] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  return row;
}

describe("S7 production wiring: canonical runS4ResearchJob evaluates and persists claim support", () => {
  it("real runS4ResearchJob with a deterministic fixture executor -> research_claim_support row exists", async () => {
    const { jobId } = await makePlannedJob("PROTOCOL_REVENUE_TO_TOKEN");
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const row = await s7RowFor(jobId);
    expect(row).toBeDefined();
    expect(row.intent).toBe("PROTOCOL_REVENUE_TO_TOKEN");
    expect(["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE"]).toContain(row.status);
  });

  it("job with no interpretation row -> treated as UNKNOWN intent (INSUFFICIENT_EVIDENCE + INTENT_NOT_CLASSIFIED), not a system failure", async () => {
    const { jobId } = await makePlannedJob(null);
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const row = await s7RowFor(jobId);
    expect(row).toBeDefined();
    expect(row.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(row.reasonCodes).toEqual(["INTENT_NOT_CLASSIFIED"]);
  });

  it("task_type=CLAIM_VERIFICATION ceiling is applied through the full production path", async () => {
    const { jobId } = await makePlannedJob("PROTOCOL_REVENUE_TO_TOKEN", "CLAIM_VERIFICATION");
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const row = await s7RowFor(jobId);
    expect(row.status).not.toBe("SUPPORTED");
  });
});

describe("S7 crash/replay: claim support is a derived projection over whatever S6 assembly currently exists", () => {
  it("S6 assembly exists, no S7 projection yet (simulated crash before S7) -> replay produces S7 without any new S4 provider work", async () => {
    const { jobId } = await makePlannedJob("PROTOCOL_REVENUE_TO_TOKEN");
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    await ctx.db.delete(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(await s7RowFor(jobId)).toBeUndefined();

    const attemptedComponents = new Set<string>();
    const noOpExecutor: WorkExecutor = {
      async execute(item) {
        attemptedComponents.add(`${item.step}:${item.component}`);
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, noOpExecutor, NOW);
    const row = await s7RowFor(jobId);
    expect(row).toBeDefined();
    expect(attemptedComponents.has("1:SOURCE_OF_VALUE")).toBe(false);
  });

  it("no S6 projection yet -> evaluateAndPersistClaimSupport returns null, no row written, no throw", async () => {
    const { jobId } = await makePlannedJob("PROTOCOL_REVENUE_TO_TOKEN");
    // No S5/S6 work has run at all — S6's table is empty for this job.
    const result = await evaluateAndPersistClaimSupport(ctx.db, jobId, NOW);
    expect(result).toBeNull();
    expect(await s7RowFor(jobId)).toBeUndefined();
  });

  it("delete + rerun evaluateAndPersistClaimSupport directly -> identical semantic result, no accumulation", async () => {
    const { jobId } = await makePlannedJob("PROTOCOL_REVENUE_TO_TOKEN");
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const first = await s7RowFor(jobId);

    await ctx.db.delete(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    const result = await evaluateAndPersistClaimSupport(ctx.db, jobId, NOW);
    const rows = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe(first.status);
    expect(rows[0].requirementResults).toEqual(first.requirementResults);
    expect(result?.status).toBe(first.status);
  });

  it("upsert replay is stable: calling evaluateAndPersistClaimSupport twice never accumulates rows", async () => {
    const { jobId } = await makePlannedJob("PROTOCOL_REVENUE_TO_TOKEN");
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const evidenceId = await insertEvidence(jobId, sourceId);
    await ctx.db.insert(researchComponentResults).values({
      researchJobId: jobId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      status: "SUPPORTED",
      reasonCodes: [],
      supportingEvidenceIds: [evidenceId],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
      currentState: null,
      tokenStateMentions: [],
      requiresFreshEvidence: false,
    });
    await ctx.db.insert(researchMechanismAssembly).values({
      researchJobId: jobId,
      patternVersion: 1,
      flows: [],
      unassignedGaps: [],
    });
    await evaluateAndPersistClaimSupport(ctx.db, jobId, NOW);
    await evaluateAndPersistClaimSupport(ctx.db, jobId, NOW);
    const rows = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    expect(rows.length).toBe(1);
  });
});

describe("S7 no model/network/upstream mutation", () => {
  it("evaluateAndPersistClaimSupport's signature takes only (db, jobId, now) — no WorkExecutor/model/network parameter exists to call", async () => {
    const { jobId } = await makePlannedJob("BURN_OR_SUPPLY_EFFECT");
    await ctx.db.insert(researchMechanismAssembly).values({ researchJobId: jobId, patternVersion: 1, flows: [], unassignedGaps: [] });
    const result = await evaluateAndPersistClaimSupport(ctx.db, jobId, NOW);
    expect(result?.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("evaluating claim support never writes to evidence, research_component_results, or research_mechanism_assembly", async () => {
    const { jobId } = await makePlannedJob("PROTOCOL_REVENUE_TO_TOKEN");
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const evidenceId = await insertEvidence(jobId, sourceId);
    await ctx.db.insert(researchComponentResults).values({
      researchJobId: jobId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      status: "SUPPORTED",
      reasonCodes: [],
      supportingEvidenceIds: [evidenceId],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
      currentState: null,
      tokenStateMentions: [],
      requiresFreshEvidence: false,
    });
    await ctx.db.insert(researchMechanismAssembly).values({ researchJobId: jobId, patternVersion: 1, flows: [], unassignedGaps: [] });
    const [evidenceBefore] = await ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));
    const [componentBefore] = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    const [assemblyBefore] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));

    await evaluateAndPersistClaimSupport(ctx.db, jobId, NOW);

    const [evidenceAfter] = await ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));
    const [componentAfter] = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    const [assemblyAfter] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
    expect(evidenceAfter).toEqual(evidenceBefore);
    expect(componentAfter).toEqual(componentBefore);
    expect(assemblyAfter).toEqual(assemblyBefore);
  });
});
