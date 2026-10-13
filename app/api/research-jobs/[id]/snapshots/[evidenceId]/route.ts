import {
  errorResponse,
  HttpError,
  requireSession,
  requireUuid,
} from "@/src/server/auth/guards";
import { getDb } from "@/src/server/runtime";
import { loadSourceSnapshot } from "@/src/server/services/source-snapshot";

// ONE SOURCE SNAPSHOT — the document this job actually read, on demand.
//
// Deliberately its own route rather than a field on the result detail: a
// capture can run to tens of kilobytes, and a reader who never opens a
// source should never pay to download one. The detail payload carries only
// a boolean saying the action leads somewhere.
//
// This route READS. It never fetches, never captures and never touches an
// external host — the document it serves was stored during acquisition, by
// the same fetch the research itself reasoned over.
//
// Ownership is the same predicate every job-scoped read uses, applied
// inside the query rather than after it. A snapshot that is not this
// caller's is indistinguishable from one that does not exist.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; evidenceId: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const { id, evidenceId } = await params;
    requireUuid(id);
    requireUuid(evidenceId);

    const snapshot = await loadSourceSnapshot(db, id, evidenceId, session.userId);
    // Absent, not-owned and never-captured all answer the same way. The
    // client renders "no snapshot", which is true in every one of those
    // cases and reveals nothing about which it was.
    if (!snapshot) throw new HttpError(404, "NOT_FOUND");

    return Response.json({ snapshot });
  } catch (e) {
    return errorResponse(e);
  }
}
