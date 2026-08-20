import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import type { Database, Transaction } from "../db/client";
import {
  demoQuotaReservations,
  researchJobs,
  users,
} from "../db/schema";
import type { EntitlementSnapshot } from "../../server/domain/types";
import { enqueueResearchJobInTx } from "./queue";

export class DemoQuotaExceededError extends Error {
  constructor() {
    super("DEMO lifetime proof quota exceeded");
    this.name = "DemoQuotaExceededError";
  }
}

export class ActiveJobExistsError extends Error {
  constructor(public readonly existingJobId?: string) {
    super("user already has an active research job");
    this.name = "ActiveJobExistsError";
  }
}

export type ResearchJobRow = typeof researchJobs.$inferSelect;

export interface CreateResearchJobInput {
  userId: string;
  topicId: string;
  projectId?: string | null;
  originalQuestion: string;
  normalizedTask?: unknown;
  normalizedTaskHash: string;
  idempotencyKey: string;
  entitlement: EntitlementSnapshot;
  demoLifetimeProofLimit: number;
}

export interface CreateResearchJobResult {
  job: ResearchJobRow;
  created: boolean;
}

function pgConstraint(e: unknown): string | undefined {
  const err = e as { code?: string; constraint?: string; cause?: unknown };
  if (err?.code === "23505") return err.constraint;
  const cause = err?.cause as { code?: string; constraint?: string } | undefined;
  if (cause?.code === "23505") return cause.constraint;
  return undefined;
}

// Единственная точка создания research job. Одна транзакция:
// admission-проверка квоты (RESERVED+CONSUMED < limit) → INSERT job →
// INSERT reservation (DEMO) → enqueue pg-boss. Нет коммита — нет задачи.
export async function createResearchJob(
  db: Database,
  boss: PgBoss,
  input: CreateResearchJobInput,
): Promise<CreateResearchJobResult> {
  try {
    return await db.transaction(async (tx) => {
      // Idempotency: повторный запрос с тем же ключом возвращает тот же job.
      const existing = await tx
        .select()
        .from(researchJobs)
        .where(
          and(
            eq(researchJobs.userId, input.userId),
            eq(researchJobs.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing.length > 0) {
        return { job: existing[0], created: false };
      }

      if (input.entitlement.level === "DEMO") {
        // Сериализация конкурентных стартов одного пользователя.
        const locked = await tx.execute(
          sql`SELECT id FROM ${users} WHERE id = ${input.userId} FOR UPDATE`,
        );
        if (locked.rows.length === 0) {
          throw new Error(`user not found: ${input.userId}`);
        }
        // Admission: RESERVED занимают слот наравне с CONSUMED;
        // «использовано» для пользователя — только CONSUMED.
        const [{ occupied }] = (
          await tx.execute(sql`
            SELECT count(*)::int AS occupied
            FROM ${demoQuotaReservations}
            WHERE user_id = ${input.userId}
              AND state IN ('RESERVED', 'CONSUMED')
          `)
        ).rows as [{ occupied: number }];
        if (occupied >= input.demoLifetimeProofLimit) {
          throw new DemoQuotaExceededError();
        }
      }

      const [job] = await tx
        .insert(researchJobs)
        .values({
          userId: input.userId,
          topicId: input.topicId,
          projectId: input.projectId ?? null,
          originalQuestion: input.originalQuestion,
          normalizedTask: input.normalizedTask ?? null,
          normalizedTaskHash: input.normalizedTaskHash,
          idempotencyKey: input.idempotencyKey,
          entitlementAtStart: input.entitlement.level,
          capabilityAtStart: input.entitlement.capability,
          budgetAtStart: input.entitlement.budget,
        })
        .returning();

      if (input.entitlement.level === "DEMO") {
        await tx.insert(demoQuotaReservations).values({
          userId: input.userId,
          researchJobId: job.id,
        });
      }

      await enqueueResearchJobInTx(boss, tx, job.id);
      return { job, created: true };
    });
  } catch (e) {
    const constraint = pgConstraint(e);
    if (constraint === "uq_research_jobs_idempotency") {
      // Гонка двух одинаковых запросов: вернуть job победителя.
      const [job] = await db
        .select()
        .from(researchJobs)
        .where(
          and(
            eq(researchJobs.userId, input.userId),
            eq(researchJobs.idempotencyKey, input.idempotencyKey),
          ),
        );
      return { job, created: false };
    }
    if (
      constraint === "uq_research_jobs_one_active" ||
      constraint === "uq_research_jobs_active_task"
    ) {
      const active = await db
        .select({ id: researchJobs.id })
        .from(researchJobs)
        .where(
          and(
            eq(researchJobs.userId, input.userId),
            inArray(researchJobs.state, [
              "QUEUED",
              "RUNNING",
              "AWAITING_CLARIFICATION",
            ]),
          ),
        );
      throw new ActiveJobExistsError(active[0]?.id);
    }
    throw e;
  }
}

// Единственная точка смены состояния. Корректность перехода и запись журнала
// гарантируют триггеры БД (0001_state_machine.sql); здесь — bookkeeping
// started_at/finished_at и передача note в журнал через SET LOCAL.
export async function transitionJobState(
  dbOrTx: Database | Transaction,
  jobId: string,
  toState: ResearchJobRow["state"],
  note?: string,
): Promise<ResearchJobRow> {
  const run = async (tx: Transaction): Promise<ResearchJobRow> => {
    // Всегда перезаписываем note (пустая строка -> NULL в триггере), чтобы
    // повторный переход в той же внешней транзакции не унаследовал чужую.
    await tx.execute(
      sql`SELECT set_config('atlas.transition_note', ${note ?? ""}, true)`,
    );
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"];
    const rows = await tx
      .update(researchJobs)
      .set({
        state: toState,
        startedAt: toState === "RUNNING" ? sql`COALESCE(started_at, now())` : undefined,
        finishedAt: terminal.includes(toState) ? sql`now()` : undefined,
        unread: terminal.includes(toState) ? true : undefined,
      })
      .where(eq(researchJobs.id, jobId))
      .returning();
    if (rows.length === 0) {
      throw new Error(`research job not found: ${jobId}`);
    }
    return rows[0];
  };
  // На Database открывает транзакцию, на Transaction — savepoint; оба корректны.
  return dbOrTx.transaction(run);
}

// Разрешение резервации DEMO-квоты: RESERVED -> CONSUMED | RELEASED.
// Недопустимые переходы блокирует триггер demo_quota_reservation_guard.
export async function resolveDemoReservation(
  dbOrTx: Database | Transaction,
  researchJobId: string,
  outcome: "CONSUMED" | "RELEASED",
): Promise<void> {
  await dbOrTx
    .update(demoQuotaReservations)
    .set({ state: outcome, resolvedAt: sql`now()` })
    .where(eq(demoQuotaReservations.researchJobId, researchJobId));
}
