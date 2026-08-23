import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { users } from "../db/schema";
import type { WorkExecutor } from "../engine/controller";
import {
  createLiveS4WorkExecutor,
  INTERNAL_ALPHA_LIVE_PROJECT_SLUGS,
} from "../engine/live-executor";
import type { S4ExecutorDeps } from "../engine/s4-executor";

// Owner Manual Alpha App Test (D-123) — the ONLY place in the worker path
// that may hand back a live-provider WorkExecutor for an
// origin="OWNER_MANUAL_ALPHA" job. Deliberately additive to (never edits)
// live-executor.ts, which is part of the frozen S10 baseline (D-122):
// this file only IMPORTS createLiveS4WorkExecutor and
// INTERNAL_ALPHA_LIVE_PROJECT_SLUGS read-only and adds the owner-alpha-
// specific admission checks live-executor.ts intentionally does not know
// about (job provenance, actor role at execution time).
//
// Every check below is fail-closed: any condition not explicitly
// satisfied throws OwnerAlphaLiveRefusedError rather than falling back to
// a non-live executor — a caller that got this wrong must see a refusal,
// never a silently-downgraded run that looks like it went live but didn't.
export class OwnerAlphaLiveRefusedError extends Error {
  constructor(
    public readonly reason:
      | "NOT_OWNER_MANUAL_ALPHA"
      | "ACTOR_NOT_ADMIN"
      | "PROJECT_NOT_ALLOWLISTED",
  ) {
    super(`owner-manual-alpha live execution refused: ${reason}`);
    this.name = "OwnerAlphaLiveRefusedError";
  }
}

export interface ResolveOwnerAlphaExecutorDeps {
  db: Database | Transaction;
  job: { userId: string; origin: string };
  project: S4ExecutorDeps["project"];
  internalAlphaEnabled: boolean;
}

// Resolves the WorkExecutor for an owner-manual-alpha job. Live execution
// requires ALL of:
//   1. the job itself is marked origin="OWNER_MANUAL_ALPHA" (never inferred
//      from the current caller/session — the job may be picked up long
//      after the admin's session ended);
//   2. the job's owning user currently still holds role="ADMIN" (re-checked
//      here, not trusted from creation time — a revoked admin's
//      already-queued job must not go live);
//   3. the resolved project slug is in INTERNAL_ALPHA_LIVE_PROJECT_SLUGS
//      (currently {"pump_fun"} only — live-executor.ts's own allowlist,
//      never duplicated or widened here);
//   4. internal_alpha_enabled is true — enforced by
//      createLiveS4WorkExecutor itself (InternalAlphaGateClosedError).
// Any failure throws; the caller (worker.ts) is responsible for mapping
// that to a terminal job outcome. This function never returns a non-live
// executor — callers that want the non-live path call
// createNonLiveS4WorkExecutor directly, exactly as before this file
// existed.
export async function resolveOwnerAlphaWorkExecutor(
  deps: ResolveOwnerAlphaExecutorDeps,
): Promise<WorkExecutor> {
  if (deps.job.origin !== "OWNER_MANUAL_ALPHA") {
    throw new OwnerAlphaLiveRefusedError("NOT_OWNER_MANUAL_ALPHA");
  }
  const [actor] = await deps.db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, deps.job.userId));
  if (!actor || actor.role !== "ADMIN") {
    throw new OwnerAlphaLiveRefusedError("ACTOR_NOT_ADMIN");
  }
  if (!INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(deps.project.slug)) {
    throw new OwnerAlphaLiveRefusedError("PROJECT_NOT_ALLOWLISTED");
  }
  return createLiveS4WorkExecutor({
    db: deps.db,
    project: deps.project,
    internalAlphaEnabled: deps.internalAlphaEnabled,
  });
}
