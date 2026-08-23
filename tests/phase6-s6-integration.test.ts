import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, researchComponentResults, researchMechanismAssembly, sources, topics, users } from "../src/server/db/schema";
import type { WorkExecutor } from "../src/server/engine/controller";
import { assembleAndPersistMechanism } from "../src/server/engine/mechanism-assembly-store";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// Phase 6, S6 (phase-6-s6-plan.md §27) — real PostgreSQL integration
// tests. Deliberately exercises the CANONICAL production entry point
// (runS4ResearchJob) — not just assembleMechanism() in isolation — so a
// regression that removes S6's production wiring is caught, mirroring
// the same discipline S5's deep-audit tests already established.

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

async function makePlannedJob(): Promise<{ jobId: string; projectId: string; topicId: string }> {
  const topicId = await activeTopicId();
  const [project] = await ctx.db.insert(projects).values({ slug: uniq("p6s6"), name: "S6 integration test", status: "ACTIVE_CORE" }).returning();
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

async function s6RowFor(jobId: string) {
  const [row] = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
  return row;
}

describe("S6 production wiring: canonical runS4ResearchJob assembles and persists a mechanism, not just a test-only call path", () => {
  it("real runS4ResearchJob with a deterministic fixture executor -> research_mechanism_assembly row exists", async () => {
    const { jobId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const row = await s6RowFor(jobId);
    expect(row).toBeDefined();
    expect(Array.isArray(row.flows)).toBe(true);
  });
});

describe("S6 crash/resume: assembly is a derived projection over whatever S5 results currently exist", () => {
  it("S5 rows exist, no S6 projection yet (simulated crash between S5 and S6) -> replay produces S6 without any new S4 provider work", async () => {
    const { jobId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    // First run produces S5 rows AND (via the sweep) an S6 row. Simulate
    // "crashed before S6" by deleting the S6 row while keeping S5's.
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    await ctx.db.delete(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
    expect(await s6RowFor(jobId)).toBeUndefined();

    const attemptedComponents = new Set<string>();
    const noOpExecutor: WorkExecutor = {
      async execute(item) {
        attemptedComponents.add(`${item.step}:${item.component}`);
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, noOpExecutor, NOW);
    const row = await s6RowFor(jobId);
    expect(row).toBeDefined();
    // The already-SUCCEEDED SOURCE_OF_VALUE component must never be
    // re-attempted by S4 just to reproduce the S6 projection.
    expect(attemptedComponents.has("1:SOURCE_OF_VALUE")).toBe(false);
  });

  it("delete + rerun assembleAndPersistMechanism directly -> identical semantic result, no accumulation", async () => {
    const { jobId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    const executor: WorkExecutor = {
      async execute(item, execCtx) {
        await insertEvidence(execCtx.jobId, sourceId, { patternStep: item.step, component: item.component });
        return { status: "SUCCEEDED" };
      },
    };
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const first = await s6RowFor(jobId);

    await ctx.db.delete(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
    const result = await assembleAndPersistMechanism(ctx.db, jobId, NOW);
    const rows = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
    expect(rows.length).toBe(1);
    // Structural (not string) equality — jsonb round-tripping through
    // Postgres does not guarantee key insertion order is preserved, only
    // the data itself.
    expect(rows[0].flows).toEqual(first.flows);
    expect(result.flows).toEqual(first.flows);
  });

  it("upsert replay is stable: calling assembleAndPersistMechanism twice in a row never accumulates rows", async () => {
    const { jobId } = await makePlannedJob();
    const sourceId = await makeSource(`https://example.com/${uniq("doc")}`);
    await insertEvidence(jobId, sourceId);
    await ctx.db.insert(researchComponentResults).values({
      researchJobId: jobId,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      status: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["NO_EVIDENCE_FOUND"],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
      currentState: null,
      tokenStateMentions: [],
      requiresFreshEvidence: true,
    });
    await assembleAndPersistMechanism(ctx.db, jobId, NOW);
    await assembleAndPersistMechanism(ctx.db, jobId, NOW);
    const rows = await ctx.db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
    expect(rows.length).toBe(1);
  });
});

describe("S6 no model/network/S4-budget consumption", () => {
  it("assembleAndPersistMechanism's signature takes only (db, jobId, now) — structurally no WorkExecutor/model/network parameter exists to call", async () => {
    const { jobId } = await makePlannedJob();
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
    const result = await assembleAndPersistMechanism(ctx.db, jobId, NOW);
    expect(result.flows.length).toBe(1);
    expect(result.flows[0].nodes[0].kind).toBe("VALUE_SOURCE");
  });
});
