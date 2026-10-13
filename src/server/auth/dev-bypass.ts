import { eq, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { userIdentities, users } from "../db/schema";
import { deriveCsrfToken } from "./csrf";
import { getEnv } from "./guards";
import { createSession, hashToken, sessionCookie } from "./session";

// Только для локальной разработки (route дополнительно проверяет
// NODE_ENV=development + AUTH_DEV_BYPASS=1). В e2e-тестах играет роль
// TelegramPlatformAdapter'а.
export async function devAuthenticate(db: Database) {
  const providerUserId = "dev_user_1";
  const existing = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      sql`${userIdentities.provider} = 'TELEGRAM_DEV'
          AND ${userIdentities.providerUserId} = ${providerUserId}`,
    );
  let userId: string;
  if (existing.length > 0) {
    userId = existing[0].userId;
  } else {
    const [created] = await db
      .insert(users)
      .values({ lastSeenAt: sql`now()` })
      .returning({ id: users.id });
    await db.insert(userIdentities).values({
      userId: created.id,
      provider: "TELEGRAM_DEV",
      providerUserId,
    });
    userId = created.id;
  }
  const { rawToken } = await createSession(db, userId);
  const [u] = await db
    .select({ onboardingCompleted: users.onboardingCompleted })
    .from(users)
    .where(eq(users.id, userId));
  return {
    csrfToken: deriveCsrfToken(hashToken(rawToken), getEnv("CSRF_SECRET")),
    setCookie: sessionCookie(rawToken),
    onboardingCompleted: u.onboardingCompleted,
  };
}
