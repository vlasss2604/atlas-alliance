import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { HttpError } from "../auth/guards";
import type { Database } from "../db/client";
import { interpretations, projects, researchJobs, topics } from "../db/schema";
import type { ProductConfig } from "../config/product";
import {
  ActiveJobExistsError,
  createResearchJob,
  DemoQuotaExceededError,
  type ResearchJobRow,
} from "../jobs/research-jobs";
import { resolveEntitlement } from "./entitlement";

// Контракт structured-результата Interpreter (минимум Фазы 3; Фаза 4
// наполняет его настоящим Interpreter'ом).
interface InterpretationResult {
  project_slug?: string;
  research_task?: string;
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

  const entitlement = await resolveEntitlement(db, input.userId, config);

  // Scope: тема активна, проект существует и находится в исследуемом статусе.
  const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
  if (!topic) throw new HttpError(403, "OUT_OF_SCOPE");
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, result.project_slug));
  if (!project || project.status !== "ACTIVE_CORE") {
    throw new HttpError(403, "OUT_OF_SCOPE");
  }

  // Scope ≠ Entitlement: проект в scope ATLAS, но DEMO видит замок.
  if (
    entitlement.snapshot.level === "DEMO" &&
    !config.demo_project_slugs.includes(project.slug)
  ) {
    throw new HttpError(403, "CORE_REQUIRED");
  }

  const normalizedTask = {
    project_slug: project.slug,
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
    // Цепочка Original Question → Interpretation → Job (LOCKED §5).
    await db
      .update(interpretations)
      .set({ researchJobId: created.job.id })
      .where(eq(interpretations.id, interp.id));
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
