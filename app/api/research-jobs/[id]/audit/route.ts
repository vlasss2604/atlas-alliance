import { and, eq } from "drizzle-orm";

import {
  errorResponse,
  requireMutation,
  requireSession,
  requireUuid,
} from "@/src/server/auth/guards";
import { researchJobs } from "@/src/server/db/schema";
import {
  generateAuditProjectionSafely,
  loadAuditProjection,
} from "@/src/server/engine/audit-projection-store";
import { getDb } from "@/src/server/runtime";

// FULL RESEARCH AUDIT — PREPARED ONLY WHEN A HUMAN ASKS FOR ONE.
//
// TWO METHODS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE COST STORY.
//
//   GET  reads. It never generates, never calls a model, and returns null
//        for a job whose audit has never been prepared. Opening a Result
//        therefore costs nothing, because the Result page only ever GETs.
//   POST prepares. It is reachable only from an explicit "Full research
//        audit" click, generates at most once per (job, audit version),
//        and persists its outcome — including failure.
//
// A read that could fall through to generation is exactly how "one model
// call per job" quietly becomes "one per render", so the two are separate
// verbs in separate code paths rather than one lazily-caching handler.
//
// POST IS IDEMPOTENT BY THE INDEX, NOT BY POLITENESS. The unique
// (research_job_id, audit_version) index means a double click, a
// double-submit or two tabs racing produce one row and one call; the
// second request finds the row and returns it. A FAILED row occupies the
// slot exactly as a VALID one does, so a failed audit is never retried by
// a page load — regeneration needs a human to bump AUDIT_VERSION.
//
// OWNERSHIP is the same predicate every job-scoped route uses, applied as
// a WHERE clause rather than a check after the fact.

async function ownedJob(
  db: ReturnType<typeof getDb>,
  id: string,
  userId: string,
): Promise<string | null> {
  requireUuid(id);
  const [job] = await db
    .select({ id: researchJobs.id })
    .from(researchJobs)
    .where(and(eq(researchJobs.id, id), eq(researchJobs.userId, userId)));
  return job?.id ?? null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const { id } = await params;
    const jobId = await ownedJob(db, id, session.userId);
    // A job that is not this caller's is indistinguishable from one with
    // no audit. Both answer "there is nothing here for you".
    if (!jobId) return Response.json({ audit: null });

    return Response.json({ audit: await loadAuditProjection(db, jobId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    // Session + CSRF + Origin, like every other state-changing endpoint.
    // Preparing an audit spends a model call, so it is a mutation even
    // though it changes nothing a reader would call research state.
    const session = await requireMutation(db, req);
    const { id } = await params;
    const jobId = await ownedJob(db, id, session.userId);
    if (!jobId) return Response.json({ audit: null });

    // Returns immediately when a row already exists — the second click
    // costs a SELECT, not a model call.
    await generateAuditProjectionSafely(db, jobId);

    // Whatever happened, the answer is the persisted row: VALID content, a
    // persisted failure the client renders quietly, or null if the job was
    // never auditable at all. An audit is presentation, so no path here
    // can report a research failure.
    return Response.json({ audit: await loadAuditProjection(db, jobId) });
  } catch (e) {
    return errorResponse(e);
  }
}
