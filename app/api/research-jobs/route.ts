import { and, desc, eq } from "drizzle-orm";

import {
  errorResponse,
  HttpError,
  requireMutation,
  requireSession,
} from "@/src/server/auth/guards";
import { projects, proofs, researchJobs } from "@/src/server/db/schema";
import { startOwnerManualAlphaResearch } from "@/src/server/services/start-owner-alpha-research";
import { startResearch } from "@/src/server/services/start-research";
import { getBoss, getDb, getProductConfig } from "@/src/server/runtime";

// Только собственные jobs (ownership на сервере). Внутренние поля
// (бюджеты, error-детали) наружу не отдаются.
export async function GET(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    // UI V1 — the list carries what a Recent Proof card actually shows, so
    // the client never has to fetch every job's detail to render a list, and
    // never has to guess a verdict it was not given.
    //
    // `verdict` is LEFT JOINed from the persisted Proof: null means "this
    // job has no Proof", which is a real state (still running, or finished
    // without one) and is rendered as such — never as a verdict.
    //
    // `acquisitionPhase` is the engine's own persisted phase. It is exposed
    // because `progressStage` alone cannot say where an acquiring job
    // actually is: the stage counter stops at the memory step while the
    // engine goes on to search, fetch and extract, so a UI driven by it
    // shows "checking accumulated experience" for a job that is already
    // extracting. Nothing is computed here — the column is copied.
    const rows = await db
      .select({
        id: researchJobs.id,
        state: researchJobs.state,
        progressStage: researchJobs.progressStage,
        memoryStatus: researchJobs.memoryStatus,
        acquisitionPhase: researchJobs.acquisitionPhase,
        acquisitionPhaseAt: researchJobs.acquisitionPhaseAt,
        terminationReason: researchJobs.terminationReason,
        originalQuestion: researchJobs.originalQuestion,
        unread: researchJobs.unread,
        createdAt: researchJobs.createdAt,
        finishedAt: researchJobs.finishedAt,
        projectName: projects.name,
        projectSlug: projects.slug,
        projectTicker: projects.ticker,
        verdict: proofs.verdict,
      })
      .from(researchJobs)
      .leftJoin(projects, eq(researchJobs.projectId, projects.id))
      // Ownership is a predicate on the Proof too: a Proof is private, so
      // it is joined only where this caller owns it.
      .leftJoin(
        proofs,
        and(eq(proofs.researchJobId, researchJobs.id), eq(proofs.ownerUserId, session.userId)),
      )
      .where(eq(researchJobs.userId, session.userId))
      .orderBy(desc(researchJobs.createdAt))
      .limit(50);
    return Response.json({ jobs: rows });
  } catch (e) {
    return errorResponse(e);
  }
}

// Запуск исследования (phase-3-plan §2). До Фазы 4 закрыт конфигом
// research_enabled=false — Interpreter ещё не существует.
export async function POST(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const body = (await req.json().catch(() => ({}))) as {
      interpretationId?: string;
      idempotencyKey?: string;
    };
    if (!body.interpretationId || !body.idempotencyKey) {
      throw new HttpError(400, "BAD_REQUEST");
    }
    const config = await getProductConfig();
    // Owner Manual Alpha App Test (D-123) — ADMIN-only additive admission
    // path, reachable ONLY while the public path is closed
    // (research_enabled=false). The moment research_enabled becomes true,
    // this branch is dead code for every request (startResearch's own
    // check is no longer the one being bypassed) — an ADMIN submitting a
    // question once the product is live goes through the exact same
    // startResearch as any other user, with no special treatment.
    // Normal (non-ADMIN) users always fall through to startResearch below,
    // which still throws RESEARCH_DISABLED exactly as before this change.
    const { job, created } =
      !config.research_enabled && session.role === "ADMIN"
        ? await startOwnerManualAlphaResearch(db, await getBoss(), config, {
            userId: session.userId,
            interpretationId: body.interpretationId,
            idempotencyKey: body.idempotencyKey,
          })
        : await startResearch(db, await getBoss(), config, {
            userId: session.userId,
            interpretationId: body.interpretationId,
            idempotencyKey: body.idempotencyKey,
          });
    return Response.json(
      {
        job: {
          id: job.id,
          state: job.state,
          progressStage: job.progressStage,
          originalQuestion: job.originalQuestion,
          createdAt: job.createdAt,
        },
      },
      { status: created ? 201 : 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
