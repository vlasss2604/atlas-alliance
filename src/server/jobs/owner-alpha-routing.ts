import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { users } from "../db/schema";
import type { WorkExecutor } from "../engine/controller";
import {
  createLiveS4WorkExecutor,
  InternalAlphaGateClosedError,
  INTERNAL_ALPHA_LIVE_PROJECT_SLUGS,
} from "../engine/live-executor";
import { createS4WorkExecutor } from "../engine/s4-executor";
import type { ContentFetcher } from "../engine/providers/content-fetcher";
import type { QueryProposer } from "../engine/providers/query-proposer";
import type { SearchGateway } from "../engine/providers/search-gateway";
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
// D-138 — THE ONE OWNER-ALPHA LIVE GATE.
//
// Every phase that may touch a real external provider asks THIS function,
// and there is no second implementation to drift from it: the
// single-process executor, the SEARCHING phase, the FETCHING phase and
// the EXTRACTING executor all call it with the same subject shape.
//
// The subject is deliberately the smallest set of facts the decision
// needs, not a job row: the product admission path can ask the same
// question BEFORE a job exists, and the worker can ask it again at
// execution time. Both must get the same answer for the same facts.
export interface OwnerAlphaLiveSubject {
  // The job's recorded provenance — never the current caller's identity.
  origin: string;
  // The user the job belongs to. Their role is re-read here, at decision
  // time, so a revoked admin's already-queued job stops going live.
  userId: string;
  projectSlug: string;
}

// Non-throwing form, for the admission path and for previews. Returns the
// refusal reason, or null when live execution is admitted.
export async function evaluateOwnerAlphaLive(
  db: Database | Transaction,
  subject: OwnerAlphaLiveSubject,
  internalAlphaEnabled: boolean,
): Promise<OwnerAlphaLiveRefusedError["reason"] | "INTERNAL_ALPHA_DISABLED" | null> {
  if (subject.origin !== "OWNER_MANUAL_ALPHA") return "NOT_OWNER_MANUAL_ALPHA";
  const [actor] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, subject.userId));
  if (!actor || actor.role !== "ADMIN") return "ACTOR_NOT_ADMIN";
  if (!INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(subject.projectSlug)) {
    return "PROJECT_NOT_ALLOWLISTED";
  }
  // Checked LAST, so the refusal a caller sees for a given set of facts is
  // exactly the one it saw before D-138.
  if (!internalAlphaEnabled) return "INTERNAL_ALPHA_DISABLED";
  return null;
}

// Throwing form. Keeps the two existing error types exactly as they were:
// the internal-alpha refusal is still InternalAlphaGateClosedError (the
// class live-executor.ts owns), everything else is still
// OwnerAlphaLiveRefusedError with its existing closed reason set.
export async function assertOwnerAlphaLive(
  db: Database | Transaction,
  subject: OwnerAlphaLiveSubject,
  internalAlphaEnabled: boolean,
): Promise<void> {
  const refusal = await evaluateOwnerAlphaLive(db, subject, internalAlphaEnabled);
  if (refusal === null) return;
  if (refusal === "INTERNAL_ALPHA_DISABLED") throw new InternalAlphaGateClosedError();
  throw new OwnerAlphaLiveRefusedError(refusal);
}

function subjectOf(deps: ResolveOwnerAlphaExecutorDeps): OwnerAlphaLiveSubject {
  return { origin: deps.job.origin, userId: deps.job.userId, projectSlug: deps.project.slug };
}

// D-136 — the EXTRACTING phase's executor. Same admission as the
// single-process live path below, plus the same internal-alpha gate
// (InternalAlphaGateClosedError, imported from live-executor.ts rather
// than re-invented), and one difference that is the entire point of the
// phase: the acquisition providers are REPLAYS of this job's own
// persisted phase-1/phase-2 outputs, so the extraction process performs
// no search and no source fetch of its own.
//
// The evidence extractor is deliberately NOT overridden — it falls
// through to the real resolver, exactly as createLiveS4WorkExecutor
// leaves it, because extraction is the one live capability this phase is
// for. live-executor.ts itself is untouched (D-122): this function
// re-states its gate rather than editing it.
export async function resolveOwnerAlphaExtractionExecutor(
  deps: ResolveOwnerAlphaExecutorDeps & {
    replay: {
      queryProposer: QueryProposer;
      searchGateway: SearchGateway;
      contentFetcher: ContentFetcher;
    };
  },
): Promise<WorkExecutor> {
  await assertOwnerAlphaLive(deps.db, subjectOf(deps), deps.internalAlphaEnabled);
  return createS4WorkExecutor({
    db: deps.db,
    project: deps.project,
    queryProposer: deps.replay.queryProposer,
    searchGateway: deps.replay.searchGateway,
    contentFetcher: deps.replay.contentFetcher,
  });
}

export async function resolveOwnerAlphaWorkExecutor(
  deps: ResolveOwnerAlphaExecutorDeps,
): Promise<WorkExecutor> {
  await assertOwnerAlphaLive(deps.db, subjectOf(deps), deps.internalAlphaEnabled);
  return createLiveS4WorkExecutor({
    db: deps.db,
    project: deps.project,
    internalAlphaEnabled: deps.internalAlphaEnabled,
  });
}
