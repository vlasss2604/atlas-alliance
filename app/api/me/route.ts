import { eq, sql } from "drizzle-orm";

import { deriveCsrfToken } from "@/src/server/auth/csrf";
import {
  errorResponse,
  getEnv,
  requireMutation,
  requireSession,
} from "@/src/server/auth/guards";
import { clearedSessionCookie } from "@/src/server/auth/session";
import { researchJobs, users } from "@/src/server/db/schema";
import { resolveEntitlement } from "@/src/server/services/entitlement";
import { getDb, getProductConfig } from "@/src/server/runtime";

export async function GET(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const config = await getProductConfig();

    const [user] = await db
      .select({
        language: users.language,
        role: users.role,
        onboardingCompleted: users.onboardingCompleted,
      })
      .from(users)
      .where(eq(users.id, session.userId));

    const entitlement = await resolveEntitlement(db, session.userId, config);
    const [{ unread }] = (
      await db.execute(sql`
        SELECT count(*)::int AS unread FROM ${researchJobs}
        WHERE user_id = ${session.userId} AND unread = true
      `)
    ).rows as [{ unread: number }];

    return Response.json({
      language: user.language,
      onboardingCompleted: user.onboardingCompleted,
      entitlement: {
        level: entitlement.snapshot.level,
        demoUsed: entitlement.demoUsed,
        demoLimit: entitlement.demoLimit,
        priceStars: config.ari_core_price_stars,
      },
      unreadCount: unread,
      csrfToken: deriveCsrfToken(session.tokenHash, getEnv("CSRF_SECRET")),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// Удаление аккаунта: сессия + CSRF + Origin + двойное подтверждение в UI.
// Один DELETE — каскады Фазы 1 удаляют всё user-owned, знание системы цело.
export async function DELETE(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    await db.delete(users).where(eq(users.id, session.userId));
    return Response.json(
      { deleted: true },
      { status: 200, headers: { "Set-Cookie": clearedSessionCookie() } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
