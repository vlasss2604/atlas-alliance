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
import { feedbackDue } from "@/src/server/services/beta-feedback";
import { resolveEntitlement } from "@/src/server/services/entitlement";
import { privateBetaAllowanceFor } from "@/src/server/services/private-beta";
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
      // Whether Research Memory is consulted at all in this deployment, so
      // the progress rail never claims a step that does not happen (D-169).
      memoryEnabled: config.memory_enabled,
      // D-170: the beta user's own allowance, by the same count admission
      // uses (D-169 rule), or null when private beta does not admit them.
      privateBeta: await privateBetaAllowanceFor(db, config, { userId: session.userId, role: user.role }),
      // D-170: the one-time feedback prompt (second Proof, never answered).
      feedbackDue: await feedbackDue(db, session.userId),
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
