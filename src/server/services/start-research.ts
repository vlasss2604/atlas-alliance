import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { HttpError } from "../auth/guards";
import type { Database } from "../db/client";
import { interpretations, researchJobs } from "../db/schema";
import type { ProductConfig } from "../config/product";
import {
  ActiveJobExistsError,
  createResearchJob,
  DemoQuotaExceededError,
  resolveDemoReservation,
  transitionJobState,
  type ResearchJobRow,
} from "../jobs/research-jobs";
import { evaluateGates } from "./gates";

// Контракт structured-результата Interpreter. Полная схема — в
// src/server/interpreter/schema.ts; здесь нужны только поля, от которых
// зависит запуск исследования.
interface InterpretationResult {
  project_slug?: string;
  project_slugs?: string[];
  research_task?: string;
  route?: string;
}

export interface StartResearchInput {
  userId: string;
  interpretationId: string;
  idempotencyKey: string;
}

// Серверный конвейер запуска (phase-3-plan §2):
// research_enabled → interpretation READY → entitlement → scope →
// demo gate → createResearchJob (квота/dedupe/one-active/enqueue).
// Ни один отказ ДО createResearchJob не расходует квоту.
export async function startResearch(
  db: Database,
  boss: PgBoss,
  config: ProductConfig,
  input: StartResearchInput,
): Promise<{ job: ResearchJobRow; created: boolean }> {
  if (!config.research_enabled) {
    throw new HttpError(403, "RESEARCH_DISABLED");
  }

  const [interp] = await db
    .select()
    .from(interpretations)
    .where(
      and(
        eq(interpretations.id, input.interpretationId),
        eq(interpretations.userId, input.userId),
      ),
    );
  if (!interp || interp.status !== "READY") {
    throw new HttpError(409, "INTERPRETATION_REQUIRED");
  }
  if (interp.researchJobId) {
    // Idempotent replay: тот же interpretation + тот же ключ → тот же job.
    // (researchJobs импортирован статически)
    const [existing] = await db
      .select()
      .from(researchJobs)
      .where(eq(researchJobs.id, interp.researchJobId));
    if (
      existing &&
      existing.userId === input.userId &&
      existing.idempotencyKey === input.idempotencyKey
    ) {
      return { job: existing, created: false };
    }
    throw new HttpError(409, "INTERPRETATION_ALREADY_USED");
  }
  const result = (interp.result ?? {}) as InterpretationResult;
  if (!result.project_slug || !result.research_task) {
    throw new HttpError(409, "INTERPRETATION_REQUIRED");
  }
  // Только DEEP_RESEARCH ведёт к Proof (phase-4-plan §3.4):
  // QUICK_EXPLANATION и NO_RESEARCH_NEEDED не создают job даже прямым
  // вызовом API в обход UI.
  if (result.route !== "DEEP_RESEARCH") {
    throw new HttpError(409, "INTERPRETATION_REQUIRED");
  }

  // Scope и Entitlement — тем же кодом, что и превью Interpreter
  // (phase-4-plan §3.1): показанное пользователю решение и реальное
  // решение не могут разойтись.
  // Все сущности задачи (для старых строк без project_slugs — основная).
  const projectSlugs =
    result.project_slugs && result.project_slugs.length > 0
      ? result.project_slugs
      : [result.project_slug];

  const gates = await evaluateGates(db, config, {
    userId: input.userId,
    status: interp.status,
    route: result.route,
    projectSlugs,
  });
  if (gates.scope === "OUT_OF_SCOPE") throw new HttpError(403, "OUT_OF_SCOPE");
  if (gates.entitlement === "CORE_REQUIRED") throw new HttpError(403, "CORE_REQUIRED");
  const entitlement = gates.entitlementView;
  const topic = { id: gates.topicId! };
  const project = { id: gates.projectId!, slug: result.project_slug };

  // Задача несёт ВСЕ сущности: усечение сравнения до одного проекта
  // израсходовало бы Proof на задачу, которую пользователь не задавал.
  const normalizedTask = {
    project_slug: project.slug,
    project_slugs: projectSlugs,
    task: result.research_task,
  };
  const normalizedTaskHash = createHash("sha256")
    .update(JSON.stringify(normalizedTask))
    .digest("hex");

  try {
    const created = await createResearchJob(db, boss, {
      userId: input.userId,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: interp.originalQuestion,
      normalizedTask,
      normalizedTaskHash,
      idempotencyKey: input.idempotencyKey,
      entitlement: entitlement.snapshot,
      demoLifetimeProofLimit: entitlement.demoLimit,
    });

    // Adversarial review, MEDIUM-2: replay ключа с ЧУЖОЙ interpretation
    // не должен приваривать её к старому job. created=false означает
    // idempotency-replay — job легитимен для этой interpretation, только
    // если он ещё ни к какой другой не привязан (self-heal после сбоя
    // между созданием и связкой) — иначе это переиспользование ключа.
    if (!created.created) {
      const [linkedElsewhere] = await db
        .select({ id: interpretations.id })
        .from(interpretations)
        .where(eq(interpretations.researchJobId, created.job.id));
      if (linkedElsewhere && linkedElsewhere.id !== interp.id) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED");
      }
    }

    // Цепочка Original Question → Interpretation → Job (LOCKED §5).
    // Guarded update (LOW-5): связываем только свободную interpretation —
    // конкурентная связка с другим job не перезаписывается молча.
    const linked = await db
      .update(interpretations)
      .set({ researchJobId: created.job.id })
      .where(
        and(
          eq(interpretations.id, interp.id),
          sql`${interpretations.researchJobId} IS NULL`,
        ),
      )
      .returning({ id: interpretations.id });
    if (linked.length === 0) {
      // Кто-то успел связать эту interpretation с другим job (TOCTOU).
      const [current] = await db
        .select({ researchJobId: interpretations.researchJobId })
        .from(interpretations)
        .where(eq(interpretations.id, interp.id));
      if (current?.researchJobId !== created.job.id) {
        // Компенсация: только что созданный лишний job гасим и возвращаем слот.
        if (created.created) {
          await db.transaction(async (tx) => {
            await transitionJobState(tx, created.job.id, "CANCELLED", "interpretation TOCTOU compensation");
            if (entitlement.snapshot.level === "DEMO") {
              await resolveDemoReservation(tx, created.job.id, "RELEASED");
            }
          });
        }
        throw new HttpError(409, "INTERPRETATION_ALREADY_USED");
      }
    }
    return created;
  } catch (e) {
    if (e instanceof DemoQuotaExceededError) {
      throw new HttpError(403, "DEMO_QUOTA_EXHAUSTED");
    }
    if (e instanceof ActiveJobExistsError) {
      throw new HttpError(409, "ACTIVE_JOB_EXISTS");
    }
    throw e;
  }
}
