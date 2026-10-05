import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { HttpError } from "../auth/guards";
import type { Database } from "../db/client";
import { interpretations, projects, researchJobs, topics } from "../db/schema";
import { INTERNAL_ALPHA_V1, type ProductConfig } from "../config/product";
import type { EntitlementSnapshot } from "../domain/types";
import { evaluatePrivateBetaLive } from "../jobs/private-beta-routing";
import {
  ActiveJobExistsError,
  createResearchJob,
  transitionJobState,
  type ResearchJobRow,
} from "../jobs/research-jobs";
import {
  evaluatePrivateBetaAdmission,
  hasValidPrivateBetaGrant,
  lockPrivateBetaAdmission,
  privateBetaCapacityReached,
  privateBetaOpen,
} from "./private-beta";

interface InterpretationResult {
  project_slug?: string;
  project_slugs?: string[];
  research_task?: string;
  route?: string;
}

export interface StartPrivateBetaResearchInput {
  userId: string;
  interpretationId: string;
  idempotencyKey: string;
}

// PRIVATE BETA ADMISSION (Founder-approved, D-167).
//
// An approved private-beta USER starts the SAME real Research the owner
// starts through start-owner-alpha-research.ts — same job creation, same
// phased orchestration, same per-job envelope (INTERNAL_ALPHA_V1) — while
// the public product path (research_enabled / PRODUCT) stays closed and
// untouched. The user is never treated as ADMIN: nothing here reads a role.
//
// EVERY CHECK RUNS BEFORE A JOB EXISTS. A refusal therefore creates no job,
// spends nothing and can never surface as an empty Result:
//   1. private beta is open (private_beta_enabled, whatever research_enabled says);
//   2. the user holds a valid beta grant NOW            → BETA_ACCESS_REQUIRED
//      (an exact replay of an already-admitted request returns its job
//      first — nothing new is admitted by a replay);
//   3. the interpretation is this user's, READY, a research request, unused;
//   4. every named project is in research scope (ACTIVE_CORE);
//   5. the creator-beta global capacity is not reached → GLOBAL_BETA_CAPACITY_REACHED
//   6. every named project is on the beta list AND the
//      live-spend allowlist                             → BETA_PROJECT_NOT_AVAILABLE
//   7. the user's personal allowance (D-169 rule)
//      is under private_beta_research_limit             → BETA_RESEARCH_LIMIT_REACHED
//   8. one active job per user, and idempotency — the existing database
//      constraints inside createResearchJob.
// (2), (5), (6) and (7) are evaluatePrivateBetaAdmission, the function the
// Ask-screen preview also calls, so what the screen offers is what this admits.
//
// THE PERSONAL CAP CANNOT BE RACED PAST. Two concurrent submissions of one
// user that both read "2 used" cannot both be created: the second violates
// the one-active-job unique index and is refused.
//
// THE GLOBAL CAP CANNOT BE RACED PAST EITHER (D-170). Different users do
// not share that index, so the authoritative capacity check runs again
// INSIDE the job-creating transaction under one advisory lock
// (lockPrivateBetaAdmission): count → admit → INSERT is serial across all
// starts. The check in (5) is the early, cheap refusal; this one decides.
//
// THE BUDGET IS THE SERVER'S. The request carries an interpretation id and
// an idempotency key and nothing else; the envelope is a code constant.
export async function startPrivateBetaResearch(
  db: Database,
  boss: PgBoss,
  config: ProductConfig,
  input: StartPrivateBetaResearchInput,
): Promise<{ job: ResearchJobRow; created: boolean }> {
  if (!privateBetaOpen(config)) {
    throw new HttpError(403, "RESEARCH_DISABLED");
  }

  const [interp] = await db
    .select()
    .from(interpretations)
    .where(and(eq(interpretations.id, input.interpretationId), eq(interpretations.userId, input.userId)));
  if (interp?.researchJobId) {
    // Idempotent replay: the same interpretation + the same key → the same
    // job, whatever has changed since. Nothing new is admitted, so a grant
    // that expired after admission does not turn a replay into a refusal.
    const [existing] = await db.select().from(researchJobs).where(eq(researchJobs.id, interp.researchJobId));
    if (existing && existing.userId === input.userId && existing.idempotencyKey === input.idempotencyKey) {
      return { job: existing, created: false };
    }
  }
  // The grant is asked before anything about the request is examined: a
  // signed-in user without one learns only that beta access is required.
  if (!(await hasValidPrivateBetaGrant(db, input.userId))) {
    throw new HttpError(403, "BETA_ACCESS_REQUIRED");
  }
  if (!interp || interp.status !== "READY") {
    throw new HttpError(409, "INTERPRETATION_REQUIRED");
  }
  if (interp.researchJobId) {
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
    result.project_slugs && result.project_slugs.length > 0 ? result.project_slugs : [result.project_slug];

  const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
  const rows = projectSlugs.length ? await db.select().from(projects).where(inArray(projects.slug, projectSlugs)) : [];
  const inScope =
    !!topic && projectSlugs.length > 0 && rows.length === projectSlugs.length && rows.every((p) => p.status === "ACTIVE_CORE");
  if (!inScope || !topic) {
    throw new HttpError(403, "OUT_OF_SCOPE");
  }

  const refusal = await evaluatePrivateBetaAdmission(db, config, { userId: input.userId, projectSlugs });
  if (refusal !== null) {
    throw new HttpError(403, refusal);
  }

  // The execution-time gate, asked up front as the owner-alpha path does: a
  // job the gate would refuse at its first phase is never enqueued. The
  // same gate runs again at every phase (the switch can change), so this is
  // an early, honest refusal — not the authority.
  if (
    evaluatePrivateBetaLive({ origin: "PRIVATE_BETA", projectSlug: result.project_slug }, config) !== null
  ) {
    throw new HttpError(403, "BETA_PROJECT_NOT_AVAILABLE");
  }

  const primary = rows.find((p) => p.slug === result.project_slug);
  const normalizedTask = {
    project_slug: result.project_slug,
    project_slugs: projectSlugs,
    task: result.research_task,
  };
  const normalizedTaskHash = createHash("sha256").update(JSON.stringify(normalizedTask)).digest("hex");

  // The exact envelope owner-alpha runs under — never the client's, never
  // budget_core (which has not run live), never DEMO (no DEMO quota applies).
  const entitlement: EntitlementSnapshot = {
    level: "ARI_CORE",
    capability: "FRESH_RESEARCH",
    budget: INTERNAL_ALPHA_V1,
  };
  const phased = config.phased_research_enabled;

  try {
    const created = await createResearchJob(
      db,
      boss,
      {
        userId: input.userId,
        topicId: topic.id,
        projectId: primary?.id ?? null,
        originalQuestion: interp.originalQuestion,
        normalizedTask,
        normalizedTaskHash,
        idempotencyKey: input.idempotencyKey,
        entitlement,
        demoLifetimeProofLimit: 0,
        origin: "PRIVATE_BETA",
      },
      {
        ...(phased ? { phased: true } : {}),
        admitInTx: async (tx) => {
          await lockPrivateBetaAdmission(tx);
          if (await privateBetaCapacityReached(tx, config)) {
            throw new HttpError(403, "GLOBAL_BETA_CAPACITY_REACHED");
          }
        },
      },
    );

    if (!created.created) {
      const [linkedElsewhere] = await db
        .select({ id: interpretations.id })
        .from(interpretations)
        .where(eq(interpretations.researchJobId, created.job.id));
      if (linkedElsewhere && linkedElsewhere.id !== interp.id) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED");
      }
    }

    // Original Question → Interpretation → Job, the same chain every
    // admission path keeps (LOCKED §5), with the same TOCTOU compensation.
    const linked = await db
      .update(interpretations)
      .set({ researchJobId: created.job.id })
      .where(and(eq(interpretations.id, interp.id), sql`${interpretations.researchJobId} IS NULL`))
      .returning({ id: interpretations.id });
    if (linked.length === 0) {
      const [current] = await db
        .select({ researchJobId: interpretations.researchJobId })
        .from(interpretations)
        .where(eq(interpretations.id, interp.id));
      if (current?.researchJobId !== created.job.id) {
        if (created.created) {
          await db.transaction(async (tx) => {
            await transitionJobState(tx, created.job.id, "CANCELLED", "interpretation TOCTOU compensation");
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
