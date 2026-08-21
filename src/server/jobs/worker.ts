import { eq, sql } from "drizzle-orm";

import { deleteStaleRateLimits } from "../auth/rate-limit";
import { deleteExpiredSessions } from "../auth/session";
import { createDatabase, type Database } from "../db/client";
import { researchJobs } from "../db/schema";
import { runMemoryPlanningStage } from "../memory/plan-job";
import { createBoss, RESEARCH_QUEUE } from "./queue";
import { resolveDemoReservation, transitionJobState } from "./research-jobs";

// Periodic-обслуживание (phase-2-plan §2.1, §6): истёкшие сессии и
// устаревшие rate-limit-бакеты.
export async function runMaintenance(db: Database): Promise<void> {
  await deleteExpiredSessions(db);
  await deleteStaleRateLimits(db, 24 * 60 * 60);
}

// Зависший RUNNING (дольше бюджета × 1.5) — честный сбой вместо вечного
// RUNNING: FAILED + освобождение резервации квоты (phase-1-plan §6).
export async function sweepStaleRunningJobs(db: Database): Promise<number> {
  const stale = await db
    .select({ id: researchJobs.id, level: researchJobs.entitlementAtStart })
    .from(researchJobs)
    .where(
      sql`${researchJobs.state} = 'RUNNING'
        AND ${researchJobs.startedAt} IS NOT NULL
        AND now() - ${researchJobs.startedAt} >
            make_interval(secs => ((${researchJobs.budgetAtStart} ->> 'maxWallClockSec')::int * 3) / 2)`,
    );
  for (const job of stale) {
    await db.transaction(async (tx) => {
      await transitionJobState(tx, job.id, "FAILED", "stale RUNNING sweep");
      if (job.level === "DEMO") {
        await resolveDemoReservation(tx, job.id, "RELEASED");
      }
    });
  }
  return stale.length;
}

// Обработчик одной задачи очереди — вынесен из startWorker() именованной
// экспортируемой функцией, чтобы её можно было прогнать через настоящий
// pg-boss dequeue в acceptance-тесте (tests/phase5-worker-acceptance.test.ts)
// без дублирования этой логики. Поведение не изменилось, только форма.
export async function handleResearchJobTask(db: Database, jobId: string): Promise<void> {
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job || job.state !== "QUEUED") {
    return; // job отменён/потерян — задача считается обработанной
  }
  await transitionJobState(db, jobId, "RUNNING", "worker picked up");

  // Стадия 2 LOCKED §9 «Проверяю накопленный опыт» — Фаза 5 делает её
  // настоящей: retrieval → детерминированный план → запись контракта.
  // Честный сбой планирования — не то же самое, что «движка ещё нет»
  // (Фаза 6): разные errorCode, чтобы не смешивать баг с гранью фазы.
  let planningErrorCode: string | null = null;
  try {
    await runMemoryPlanningStage(db, jobId);
  } catch (e) {
    console.error("[worker] memory planning stage failed", e);
    planningErrorCode = "MEMORY_PLANNING_FAILED";
  }

  // Стадия 3+ «Ищу недостающие доказательства» — Research Engine, Фаза 6.
  // Никакого фейкового прогресса: план записан по-настоящему, дальше
  // честно нечем продолжить — завершаем понятной технической ошибкой
  // и возвращаем DEMO-слот.
  await db.transaction(async (tx) => {
    await tx
      .update(researchJobs)
      .set({ errorCode: planningErrorCode ?? "NOT_IMPLEMENTED" })
      .where(eq(researchJobs.id, jobId));
    await transitionJobState(
      tx,
      jobId,
      "FAILED",
      planningErrorCode ? "phase 5: memory planning failed" : "phase 5: engine not implemented",
    );
    if (job.entitlementAtStart === "DEMO") {
      await resolveDemoReservation(tx, jobId, "RELEASED");
    }
  });
}

// Entrypoint worker-процесса. В Фазе 1 хендлер — no-op (инфраструктура);
// реальный research-pipeline подключается в Фазах 4–6.
export async function startWorker() {
  const { db, pool } = createDatabase();
  const boss = createBoss();
  boss.on("error", (err) => console.error("[pg-boss]", err));

  await boss.start();
  await boss.createQueue(RESEARCH_QUEUE);

  await sweepStaleRunningJobs(db);
  await runMaintenance(db);
  const maintenanceTimer = setInterval(
    () => runMaintenance(db).catch((e) => console.error("[maintenance]", e)),
    10 * 60 * 1000,
  );

  await boss.work<{ jobId: string }>(RESEARCH_QUEUE, async ([task]) => {
    await handleResearchJobTask(db, task.data.jobId);
  });

  const shutdown = async () => {
    clearInterval(maintenanceTimer);
    await boss.stop({ graceful: true });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log("[worker] started, queue:", RESEARCH_QUEUE);
}

// Запуск: npm run worker:dev
if (process.argv[1] && process.argv[1].endsWith("worker.ts")) {
  startWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
