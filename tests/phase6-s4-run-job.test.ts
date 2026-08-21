import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, researchPatterns, sources, topics, users } from "../src/server/db/schema";
import { loadActivePatternVersion } from "../src/server/engine/active-pattern";
import type { WorkExecutor } from "../src/server/engine/controller";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// Phase 6, S4 — production wiring point: activePatternVersion resolution
// (final S0-S3 review note on frozen Phase 5 LOW-2) and the actual
// ContractView -> ResearchController integration for a real job.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-08-21T00:00:00Z");

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

describe("Фаза 6, S4 — loadActivePatternVersion: ACTIVE-only, не трогает замороженный loadActivePattern (тест 19)", () => {
  it("возвращает версию ACTIVE-строки, игнорируя DRAFT/RETIRED версии той же темы", async () => {
    const topicId = await activeTopicId();
    const [activeRow] = await ctx.db
      .select()
      .from(researchPatterns)
      .where(eq(researchPatterns.topicId, topicId));
    expect(activeRow.status).toBe("ACTIVE");

    // Дополнительные DRAFT/RETIRED версии той же темы — не должны
    // побеждать ACTIVE и не должны ломать "ровно одна версия".
    await ctx.db.insert(researchPatterns).values({
      topicId,
      version: activeRow.version + 1,
      status: "DRAFT",
      content: activeRow.content,
    });
    await ctx.db.insert(researchPatterns).values({
      topicId,
      version: activeRow.version + 2,
      status: "RETIRED",
      content: activeRow.content,
    });

    const version = await loadActivePatternVersion(ctx.db, topicId);
    expect(version).toBe(activeRow.version);
  });

  it("тема без ACTIVE-версии -> null, а не молчаливое падение на первую попавшуюся", async () => {
    const [topic] = await ctx.db
      .insert(topics)
      .values({ slug: uniq("t_no_active"), name: "No active pattern", isActive: false })
      .returning();
    await ctx.db.insert(researchPatterns).values({
      topicId: topic.id,
      version: 1,
      status: "DRAFT",
      content: {},
    });
    const version = await loadActivePatternVersion(ctx.db, topic.id);
    expect(version).toBeNull();
  });
});

describe("Фаза 6, S4 — runS4ResearchJob: ContractView -> ResearchController с реальным activePatternVersion (тест 19)", () => {
  async function makePlannedJob(): Promise<string> {
    const topicId = await activeTopicId();
    const [project] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("p6s4run"), name: "S4 run-job test", status: "ACTIVE_CORE" })
      .returning();
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
    return job.id;
  }

  it("реальный job: runS4ResearchJob строит ContractView с ACTIVE-версией Pattern'а и прогоняет controller", async () => {
    const jobId = await makePlannedJob();
    let executed = 0;
    const executor: WorkExecutor = {
      async execute() {
        executed += 1;
        return { status: "SUCCEEDED" };
      },
    };
    const result = await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    expect(result.stopReason).toBeDefined();
    // Пустая память -> все 8 шагов MISSING -> workQueue непуст -> executor вызывается.
    expect(executed).toBeGreaterThan(0);
  });

  it("несовпадение activePatternVersion с contract.patternVersion -> жёсткий отказ (CONTRACT_INVALID), не тихая работа со старым Pattern'ом", async () => {
    const jobId = await makePlannedJob();
    const topicId = await activeTopicId();
    // "Публикуем" новую ACTIVE-версию тем же способом, каким это делает
    // владелец продукта — деактивируем старую, активируем новую с другим
    // номером версии, чем тот, что уже заморожен в контракте job'а.
    await ctx.db.update(researchPatterns).set({ status: "RETIRED" }).where(eq(researchPatterns.topicId, topicId));
    const [oldRow] = await ctx.db
      .select()
      .from(researchPatterns)
      .where(eq(researchPatterns.topicId, topicId));
    await ctx.db.insert(researchPatterns).values({
      topicId,
      version: (oldRow?.version ?? 1) + 5,
      status: "ACTIVE",
      content: oldRow?.content ?? {},
    });

    const executor: WorkExecutor = { async execute() { return { status: "SUCCEEDED" }; } };
    await expect(runS4ResearchJob(ctx.db, jobId, executor, NOW)).rejects.toThrow(/CONTRACT_INVALID/);
  });
});

describe("Фаза 6, S4 — межпроектная утечка Evidence/Source запрещена (тест 20)", () => {
  it("две Evidence из РАЗНЫХ job'ов, ссылающиеся на ОДИН И ТОТ ЖЕ переиспользуемый source, остаются строго привязаны каждая к своему job'у", async () => {
    const topicId = await activeTopicId();
    const [projectA] = await ctx.db.insert(projects).values({ slug: uniq("proj_a"), name: "A", status: "ACTIVE_CORE" }).returning();
    const [projectB] = await ctx.db.insert(projects).values({ slug: uniq("proj_b"), name: "B", status: "ACTIVE_CORE" }).returning();
    const [userA] = await ctx.db.insert(users).values({}).returning();
    const [userB] = await ctx.db.insert(users).values({}).returning();
    const { job: jobA } = await createResearchJob(ctx.db, ctx.boss, {
      userId: userA.id, topicId, projectId: projectA.id, originalQuestion: "q",
      normalizedTask: { project_slug: projectA.slug, project_slugs: [projectA.slug], task: "x" },
      normalizedTaskHash: uniq("hash"), idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(), demoLifetimeProofLimit: 1000,
    });
    const { job: jobB } = await createResearchJob(ctx.db, ctx.boss, {
      userId: userB.id, topicId, projectId: projectB.id, originalQuestion: "q",
      normalizedTask: { project_slug: projectB.slug, project_slugs: [projectB.slug], task: "x" },
      normalizedTaskHash: uniq("hash"), idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(), demoLifetimeProofLimit: 1000,
    });

    const [source] = await ctx.db
      .insert(sources)
      .values({ url: "https://example.com/shared", urlHash: uniq("shared_url_hash") })
      .returning();

    const base = {
      sourceId: source.id,
      patternStep: 1 as const,
      component: "SOURCE_OF_VALUE",
      directness: "DIRECT" as const,
      sourceClass: "OFFICIAL_DOCS" as const,
      officiality: "CONFIRMED" as const,
      relationship: "SUPPORTS" as const,
      fragment: "shared source fragment",
      fetchedAt: NOW,
      retrievedUrl: "https://example.com/shared",
      contentHash: "sha256:shared",
    };
    await ctx.db.insert(evidence).values({ ...base, researchJobId: jobA.id, proofId: null });
    await ctx.db.insert(evidence).values({ ...base, researchJobId: jobB.id, proofId: null });

    const rowsA = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobA.id));
    const rowsB = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobB.id));
    expect(rowsA.length).toBe(1);
    expect(rowsB.length).toBe(1);
    expect(rowsA[0].id).not.toBe(rowsB[0].id);
    // Тот же source переиспользуется (не дублируется) — это ожидаемо
    // (source — библиотека URL, не project-scoped), но КАЖДАЯ Evidence
    // строка остаётся строго привязана к СВОЕМУ research_job_id — ни
    // одна выборка по job A не возвращает строку job B, и наоборот.
    expect(rowsA[0].sourceId).toBe(source.id);
    expect(rowsB[0].sourceId).toBe(source.id);
  });
});
