import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  memoryRetrievals,
  projects,
  researchJobs,
  researchPlans,
  topics,
  users,
} from "../src/server/db/schema";
import { RESEARCH_QUEUE } from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { researchBoundaryContractSchema } from "../src/server/memory/contract";
import { observeMemoryCandidate, promoteToActive } from "../src/server/memory/lifecycle";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

// Опрос вместо фиксированного sleep: реальный pg-boss опрашивает очередь
// сам, поэтому момент завершения задачи не детерминирован по времени.
async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

describe("Фаза 5 — настоящий end-to-end через pg-boss worker (не прямой вызов)", () => {
  it(
    "26. job -> реальный pg-boss dequeue -> handleResearchJobTask -> персистентный research_plan",
    async () => {
      const topicId = await activeTopicId();
      const [project] = await ctx.db
        .insert(projects)
        .values({ slug: uniq("worker_e2e"), name: "Worker E2E Project", status: "ACTIVE_CORE" })
        .returning();

      // Немного памяти, чтобы стадия планирования была содержательной, а не
      // тривиальным "ничего не найдено" — тот же путь, что и в реальном проекте.
      const [admin] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
      const { id: memoryId } = await observeMemoryCandidate(ctx.db, {
        projectId: project.id,
        topicId,
        patternStep: 1,
        component: "SOURCE_OF_VALUE",
        claimKey: "economic_source",
        statement: "worker e2e: swap fee is the economic source",
        freshnessClass: "LOW_CHANGE",
        verifiedAt: new Date(),
        confidence: 90,
        originKind: "WORKER_E2E",
      });
      await promoteToActive(ctx.db, memoryId, admin.id);

      const [user] = await ctx.db.insert(users).values({}).returning();

      // createResearchJob вызывает enqueueResearchJobInTx в ТОЙ ЖЕ транзакции,
      // что и INSERT job — это настоящая постановка в очередь pg-boss, не
      // прямой вызов runMemoryPlanningStage.
      const { job } = await createResearchJob(ctx.db, ctx.boss, {
        userId: user.id,
        topicId,
        projectId: project.id,
        originalQuestion: "does protocol revenue reach token holders?",
        normalizedTask: {
          project_slug: project.slug,
          project_slugs: [project.slug],
          task: "does protocol revenue reach token holders",
        },
        normalizedTaskHash: uniq("hash"),
        idempotencyKey: uniq("idem"),
        entitlement: coreEntitlement(),
        demoLifetimeProofLimit: 3,
      });
      expect(job.state).toBe("QUEUED");

      // Регистрируем ТОТ ЖЕ обработчик, что использует production worker.ts —
      // ничего не переписано и не задублировано, только вызван из настоящего
      // pg-boss dequeue вместо startWorker()'s бесконечного процесса.
      await ctx.boss.work<{ jobId: string }>(RESEARCH_QUEUE, async ([task]) => {
        await handleResearchJobTask(ctx.db, task.data.jobId);
      });

      await waitUntil(async () => {
        const [row] = await ctx.db
          .select({ state: researchJobs.state })
          .from(researchJobs)
          .where(eq(researchJobs.id, job.id));
        return row?.state === "FAILED";
      }, 15_000);

      const [finalJob] = await ctx.db
        .select()
        .from(researchJobs)
        .where(eq(researchJobs.id, job.id));
      // Планирование прошло по-настоящему; честно не хватает только Фазы 6.
      expect(finalJob.errorCode).toBe("NOT_IMPLEMENTED");
      expect(finalJob.memoryStatus).toBe("USED");
      expect(finalJob.progressStage).toBe(2);

      const [plan] = await ctx.db
        .select()
        .from(researchPlans)
        .where(eq(researchPlans.researchJobId, job.id));
      expect(plan).toBeTruthy();
      // D-058: 7 шагов подлинно MISSING -> FRESH_RESEARCH (CORE-потолок
      // это позволяет); закрытый шаг 1 остаётся закрытым в контракте.
      expect(plan.mode).toBe("FRESH_RESEARCH");
      // Контракт, записанный настоящим worker-проходом, обязан остаться
      // валиден по той же строгой схеме, что использует планировщик.
      const parsed = researchBoundaryContractSchema.parse(plan.contract);
      expect(parsed.alreadySatisfiedSteps).toEqual([1]);

      const [retrieval] = await ctx.db
        .select()
        .from(memoryRetrievals)
        .where(eq(memoryRetrievals.researchJobId, job.id));
      expect(retrieval).toBeTruthy();
      expect(retrieval.planId).toBe(plan.id);
    },
    20_000,
  );
});
