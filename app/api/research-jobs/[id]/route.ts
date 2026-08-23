import { and, desc, eq } from "drizzle-orm";

import {
  errorResponse,
  HttpError,
  requireSession,
  requireUuid,
} from "@/src/server/auth/guards";
import {
  evidence,
  researchClaimSupport,
  researchJobs,
  researchMechanismAssembly,
  sources,
} from "@/src/server/db/schema";
import { getDb } from "@/src/server/runtime";

// Owner Manual Alpha App Test (D-123) — result-detail read. Same
// ownership rule as every other /api/research-jobs/[id]/* route
// (requireSession + WHERE userId = session.userId, never a role check —
// a normal PRODUCT job's owner reads their own result exactly the same
// way an ADMIN reads their own OWNER_MANUAL_ALPHA job).
//
// Returns ONLY structured, already-admitted data: job lifecycle, S7 claim
// support, S6 mechanism assembly, and admitted Evidence with its source
// provenance. Never touches research_attempts or research_trace_events
// (operational/provider internals, §M of the S10 spec) and never returns
// a provider credential or raw provider response — there is nothing in
// this query that could contain one.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const { id } = await params;
    requireUuid(id);

    const [job] = await db
      .select({
        id: researchJobs.id,
        state: researchJobs.state,
        progressStage: researchJobs.progressStage,
        originalQuestion: researchJobs.originalQuestion,
        terminationReason: researchJobs.terminationReason,
        errorCode: researchJobs.errorCode,
        origin: researchJobs.origin,
        createdAt: researchJobs.createdAt,
        startedAt: researchJobs.startedAt,
        finishedAt: researchJobs.finishedAt,
      })
      .from(researchJobs)
      .where(and(eq(researchJobs.id, id), eq(researchJobs.userId, session.userId)));
    if (!job) throw new HttpError(404, "NOT_FOUND");

    const [claimSupport] = await db
      .select({
        intent: researchClaimSupport.intent,
        status: researchClaimSupport.status,
        reasonCodes: researchClaimSupport.reasonCodes,
        requirementResults: researchClaimSupport.requirementResults,
        contextGaps: researchClaimSupport.contextGaps,
      })
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, id))
      .orderBy(desc(researchClaimSupport.updatedAt))
      .limit(1);

    const [mechanism] = await db
      .select({
        flows: researchMechanismAssembly.flows,
        unassignedGaps: researchMechanismAssembly.unassignedGaps,
      })
      .from(researchMechanismAssembly)
      .where(eq(researchMechanismAssembly.researchJobId, id))
      .orderBy(desc(researchMechanismAssembly.updatedAt))
      .limit(1);

    const evidenceRows = await db
      .select({
        id: evidence.id,
        patternStep: evidence.patternStep,
        component: evidence.component,
        relationship: evidence.relationship,
        directness: evidence.directness,
        fragment: evidence.fragment,
        summary: evidence.summary,
        doesNotProve: evidence.doesNotProve,
        mechanismState: evidence.mechanismState,
        valueSource: evidence.valueSource,
        sourceClass: evidence.sourceClass,
        officiality: evidence.officiality,
        observedAt: evidence.observedAt,
        dataAsOf: evidence.dataAsOf,
        publishedAt: evidence.publishedAt,
        retrievedUrl: evidence.retrievedUrl,
        sourceTitle: sources.title,
        sourcePublisher: sources.publisher,
        sourceType: sources.sourceType,
      })
      .from(evidence)
      .innerJoin(sources, eq(evidence.sourceId, sources.id))
      .where(eq(evidence.researchJobId, id))
      .orderBy(evidence.patternStep, evidence.createdAt);

    return Response.json({
      job,
      claimSupport: claimSupport ?? null,
      mechanism: mechanism ?? null,
      evidence: evidenceRows,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
