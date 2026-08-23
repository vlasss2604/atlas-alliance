import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { HttpError } from "../auth/guards";
import type { Database } from "../db/client";
import { interpretations, projects, researchJobs, topics } from "../db/schema";
import { INTERNAL_ALPHA_V1 } from "../config/product";
import type { EntitlementSnapshot } from "../domain/types";
import {
  ActiveJobExistsError,
  createResearchJob,
  transitionJobState,
  type ResearchJobRow,
} from "../jobs/research-jobs";

// Контракт structured-результата Interpreter — тот же минимальный срез,
// что и start-research.ts (полная схема — src/server/interpreter/schema.ts).
interface InterpretationResult {
  project_slug?: string;
  project_slugs?: string[];
  research_task?: string;
  route?: string;
}

export interface StartOwnerAlphaResearchInput {
  userId: string;
  interpretationId: string;
  idempotencyKey: string;
}

// Owner Manual Alpha App Test (D-123) — ADMIN-only manual-testing admission
// path, additive to startResearch (never replaces or modifies it). The
// caller (app/api/research-jobs/route.ts) is the ONLY place that decides
// this path may be reached — it requires session.role === "ADMIN" AND
// !config.research_enabled before calling here; this function trusts that
// decision and does not re-check role itself.
//
// Deliberately skips evaluateGates (gates.ts): DEMO/CORE_REQUIRED/quota
// concepts do not apply to an owner manual test, and research_enabled is
// the very gate this path exists to bypass for the owner only. Scope is
// still checked directly (topic active, every named project ACTIVE_CORE)
// so an owner cannot manually admit a job for a project ATLAS has no
// research pattern for at all.
//
// The job is created with origin="OWNER_MANUAL_ALPHA" UNCONDITIONALLY —
// even if internal_alpha_enabled=false or the resolved project is outside
// INTERNAL_ALPHA_LIVE_PROJECT_SLUGS. Live-execution eligibility is decided
// exactly once, at worker pickup time, by owner-alpha-routing.ts — never
// here. This keeps "may an owner-alpha job be created" and "may an
// owner-alpha job execute live" as two independently fail-closed checks:
// flipping internal_alpha_enabled after submission does not require the
// owner to resubmit, and a job submitted before the flag was enabled still
// fails closed at execution rather than silently going live retroactively.
export async function startOwnerManualAlphaResearch(
  db: Database,
  boss: PgBoss,
  input: StartOwnerAlphaResearchInput,
): Promise<{ job: ResearchJobRow; created: boolean }> {
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
  if (result.route !== "DEEP_RESEARCH") {
    throw new HttpError(409, "INTERPRETATION_REQUIRED");
  }

  const projectSlugs =
    result.project_slugs && result.project_slugs.length > 0
      ? result.project_slugs
      : [result.project_slug];

  const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
  const rows = projectSlugs.length
    ? await db.select().from(projects).where(inArray(projects.slug, projectSlugs))
    : [];
  const inScope =
    !!topic &&
    projectSlugs.length > 0 &&
    rows.length === projectSlugs.length &&
    rows.every((p) => p.status === "ACTIVE_CORE");
  if (!inScope || !topic) {
    throw new HttpError(403, "OUT_OF_SCOPE");
  }
  const primary = rows.find((p) => p.slug === result.project_slug);

  const normalizedTask = {
    project_slug: result.project_slug,
    project_slugs: projectSlugs,
    task: result.research_task,
  };
  const normalizedTaskHash = createHash("sha256")
    .update(JSON.stringify(normalizedTask))
    .digest("hex");

  // Fixed internal-alpha entitlement snapshot — never DEMO (no quota
  // concept applies), budget is the authoritative INTERNAL_ALPHA_V1
  // envelope regardless of which entitlement the owner's account holds.
  const entitlement: EntitlementSnapshot = {
    level: "ARI_CORE",
    capability: "FRESH_RESEARCH",
    budget: INTERNAL_ALPHA_V1,
  };

  try {
    const created = await createResearchJob(db, boss, {
      userId: input.userId,
      topicId: topic.id,
      projectId: primary?.id ?? null,
      originalQuestion: interp.originalQuestion,
      normalizedTask,
      normalizedTaskHash,
      idempotencyKey: input.idempotencyKey,
      entitlement,
      demoLifetimeProofLimit: 0,
      origin: "OWNER_MANUAL_ALPHA",
    });

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
      const [current] = await db
        .select({ researchJobId: interpretations.researchJobId })
        .from(interpretations)
        .where(eq(interpretations.id, interp.id));
      if (current?.researchJobId !== created.job.id) {
        if (created.created) {
          await db.transaction(async (tx) => {
            await transitionJobState(
              tx,
              created.job.id,
              "CANCELLED",
              "interpretation TOCTOU compensation",
            );
          });
        }
        throw new HttpError(409, "INTERPRETATION_ALREADY_USED");
      }
    }
    return created;
  } catch (e) {
    if (e instanceof ActiveJobExistsError) {
      throw new HttpError(409, "ACTIVE_JOB_EXISTS");
    }
    throw e;
  }
}
