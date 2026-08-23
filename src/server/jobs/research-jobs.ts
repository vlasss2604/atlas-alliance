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
  // Owner Manual Alpha App Test (D-123) — defaults to "PRODUCT" for every
  // existing caller (start-research.ts never sets this). Only
  // start-owner-alpha-research.ts passes "OWNER_MANUAL_ALPHA".
  origin?: "PRODUCT" | "OWNER_MANUAL_ALPHA";
}

export interface CreateResearchJobResult {
  job: ResearchJobRow;
  created: boolean;
}

// First Real Run, Stage 2 acceptance closure (D-116) — internal-only
// escape hatch, NOT part of CreateResearchJobInput (so it can never be
// populated from a spread/parsed request body): skips the pg-boss
// enqueue that createResearchJob otherwise always performs. Every real
// caller (start-research.ts) calls createResearchJob with no third
// argument and gets the exact original enqueue behaviour, unchanged.
// The only caller that ever passes { skipEnqueue: true } is
// scripts/alpha-run.ts, which then drives the job itself through the
// real handleResearchJobTask — this exists specifically so alpha-run
// never creates a pg-boss task that a real worker process could also
// pick up and race against it for the same job (HIGH-1 closure §3).
export interface CreateResearchJobOptions {
  skipEnqueue?: boolean;
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
  options?: CreateResearchJobOptions,
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
          origin: input.origin ?? "PRODUCT",
        })
        .returning();

      if (input.entitlement.level === "DEMO") {
        await tx.insert(demoQuotaReservations).values({
          userId: input.userId,
          researchJobId: job.id,
        });
      }

      if (!options?.skipEnqueue) {
        await enqueueResearchJobInTx(boss, tx, job.id);
      }
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

// First Real Run, Stage 2 acceptance closure (HIGH-1, D-116): atomic
// claim. The previous "SELECT job; if state !== QUEUED return; UPDATE to
// RUNNING" sequence was check-then-act — two concurrent handlers could
// both read state='QUEUED' before either transitions it, and
// trg_research_jobs_state_guard (0001_state_machine.sql) treats
// OLD.state === NEW.state as a silent no-op, so a second, later
// RUNNING->RUNNING "transition" would NOT be rejected by the DB either.
// This is a single UPDATE ... WHERE id=$1 AND state='QUEUED' RETURNING
// *: Postgres row-level locking makes it atomic without any explicit
// FOR UPDATE — a concurrent UPDATE on the same row blocks until the
// first commits, then re-evaluates its own WHERE clause against the now-
// RUNNING row and matches zero rows. Exactly one caller ever receives a
// non-null row for a given job.
export async function claimResearchJob(
  dbOrTx: Database | Transaction,
  jobId: string,
): Promise<ResearchJobRow | null> {
  return dbOrTx.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('atlas.transition_note', 'worker picked up', true)`);
    const rows = await tx
      .update(researchJobs)
      .set({ state: "RUNNING", startedAt: sql`COALESCE(started_at, now())` })
      .where(and(eq(researchJobs.id, jobId), eq(researchJobs.state, "QUEUED")))
      .returning();
    return rows[0] ?? null;
  });
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
