import { and, eq } from "drizzle-orm";

import { errorResponse, HttpError, requireMutation,
  requireUuid,
} from "@/src/server/auth/guards";
import { researchJobs } from "@/src/server/db/schema";
import { getDb } from "@/src/server/runtime";

// Сброс unread — только для собственного job (ownership в WHERE).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const { id } = await params;
    requireUuid(id);
    const rows = await db
      .update(researchJobs)
      .set({ unread: false })
      .where(and(eq(researchJobs.id, id), eq(researchJobs.userId, session.userId)))
      .returning({ id: researchJobs.id });
    if (rows.length === 0) throw new HttpError(404, "NOT_FOUND");
    return Response.json({ read: true });
  } catch (e) {
    return errorResponse(e);
  }
}
