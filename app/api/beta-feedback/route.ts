import { errorResponse, requireMutation } from "@/src/server/auth/guards";
import { recordBetaFeedback } from "@/src/server/services/beta-feedback";
import { getDb } from "@/src/server/runtime";

// PRIVATE-BETA FEEDBACK (D-170). Session, CSRF and Origin required; the
// row is always the session's own user. Answer or skip, once.
export async function POST(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const body = await req.json().catch(() => null);
    const recorded = await recordBetaFeedback(db, session.userId, body);
    return Response.json({ recorded }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
