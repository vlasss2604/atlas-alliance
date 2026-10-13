import { errorResponse, HttpError, requireSession, requireUuid } from "@/src/server/auth/guards";
import { loadResearchIntakeForUser, toResearchIntakeView } from "@/src/server/services/research-intake";
import { getDb, getProductConfig } from "@/src/server/runtime";

// THE CURRENT USER'S OWN INTAKE. Session required; ownership, existence and
// expiry are one predicate in the service, so a foreign, unknown or expired
// id is the same 404 — nothing confirms that an intake exists to anyone
// but its owner. A GET reads and writes nothing: opening the Mini App,
// viewing the text or leaving again changes no state and spends nothing.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const { id } = await params;
    requireUuid(id);
    const row = await loadResearchIntakeForUser(db, { id, userId: session.userId });
    if (!row) throw new HttpError(404, "NOT_FOUND");
    return Response.json({ intake: await toResearchIntakeView(db, await getProductConfig(), row) });
  } catch (e) {
    return errorResponse(e);
  }
}
