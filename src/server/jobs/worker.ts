import { eq, sql } from "drizzle-orm";

import { deleteStaleRateLimits } from "../auth/rate-limit";
import { deleteExpiredSessions } from "../auth/session";
import { createDatabase, type Database } from "../db/client";
import { researchJobs } from "../db/schema";
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
    const { jobId } = task.data;
    const [job] = await db
      .select()
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    if (!job || job.state !== "QUEUED") {
      return; // job отменён/потерян — задача считается обработанной
    }
    await transitionJobState(db, jobId, "RUNNING", "worker picked up");
    // Фаза 1: no-op. Никакого фейкового прогресса — job остаётся RUNNING
    // только на время реальной работы; здесь работы нет, честно завершаем
    // технической ошибкой NOT_IMPLEMENTED и возвращаем DEMO-слот.
    await db.transaction(async (tx) => {
      await tx
        .update(researchJobs)
        .set({ errorCode: "NOT_IMPLEMENTED" })
        .where(eq(researchJobs.id, jobId));
      await transitionJobState(tx, jobId, "FAILED", "phase 1: engine not implemented");
      if (job.entitlementAtStart === "DEMO") {
        await resolveDemoReservation(tx, jobId, "RELEASED");
      }
    });
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
