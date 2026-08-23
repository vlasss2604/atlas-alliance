import { and, eq, sql } from "drizzle-orm";

import { errorResponse, requireMutation } from "@/src/server/auth/guards";
import { users } from "@/src/server/db/schema";
import { getDb } from "@/src/server/runtime";

const ONBOARDING_VERSION = 1;

// Идемпотентный (LOCKED §10): повторный вызов не меняет completedAt.
export async function POST(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    await db
      .update(users)
      .set({
        onboardingCompleted: true,
        onboardingCompletedAt: sql`now()`,
        onboardingVersion: ONBOARDING_VERSION,
      })
      .where(
        and(eq(users.id, session.userId), eq(users.onboardingCompleted, false)),
      );
    return Response.json({ onboardingCompleted: true });
  } catch (e) {
    return errorResponse(e);
  }
}
