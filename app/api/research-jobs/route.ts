import { desc, eq } from "drizzle-orm";

import { errorResponse, requireSession } from "@/src/server/auth/guards";
import { researchJobs } from "@/src/server/db/schema";
import { getDb } from "@/src/server/runtime";

// Только собственные jobs (ownership на сервере). Внутренние поля
// (бюджеты, error-детали) наружу не отдаются.
export async function GET(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const rows = await db
      .select({
        id: researchJobs.id,
        state: researchJobs.state,
        progressStage: researchJobs.progressStage,
        originalQuestion: researchJobs.originalQuestion,
        unread: researchJobs.unread,
        createdAt: researchJobs.createdAt,
        finishedAt: researchJobs.finishedAt,
      })
      .from(researchJobs)
      .where(eq(researchJobs.userId, session.userId))
      .orderBy(desc(researchJobs.createdAt))
      .limit(50);
    return Response.json({ jobs: rows });
  } catch (e) {
    return errorResponse(e);
  }
}
