import { eq, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { userIdentities, users } from "../db/schema";
import { deriveCsrfToken } from "./csrf";
import { getEnv, HttpError } from "./guards";
import { validateInitData } from "./initdata";
import { hitRateLimit, RateLimitedError } from "./rate-limit";
import { createSession, hashToken, sessionCookie } from "./session";

export interface AuthResult {
  userId: string;
  csrfToken: string;
  setCookie: string;
  onboardingCompleted: boolean;
}

const AUTH_RATE_LIMIT = 20;
const AUTH_RATE_WINDOW_SEC = 600;

// Bootstrap-цепочка POST /api/auth/telegram (phase-2-plan §3.1):
//   Origin (проверяет route) → IP limit → validate initData →
//   verified-TG limit → session + CSRF.
// TG-бакет применяется ТОЛЬКО к подтверждённому подписью id — подставным
// чужим id в невалидном initData выжечь чужой лимит нельзя (§2.1).
export async function authenticateTelegram(
  db: Database,
  initData: string,
  clientIp: string,
): Promise<AuthResult> {
  await hitRateLimit(db, `ip:${clientIp}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_SEC);

  const validation = validateInitData(initData, {
    botToken: getEnv("BOT_TOKEN"),
    maxAgeSec: Number(process.env.AUTH_MAX_AGE_SEC ?? 600),
    clockSkewSec: Number(process.env.AUTH_CLOCK_SKEW_SEC ?? 60),
  });
  if (!validation.ok) {
    throw new HttpError(401, `INITDATA_${validation.reason}`);
  }

  await hitRateLimit(
    db,
    `tg:${validation.telegramUserId}`,
    AUTH_RATE_LIMIT,
    AUTH_RATE_WINDOW_SEC,
  );

  const userId = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        sql`${userIdentities.provider} = 'TELEGRAM'
            AND ${userIdentities.providerUserId} = ${validation.telegramUserId}`,
      );
    if (existing.length > 0) {
      await tx
        .update(users)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(users.id, existing[0].userId));
      return existing[0].userId;
    }
    const [created] = await tx
      .insert(users)
      .values({ lastSeenAt: sql`now()` })
      .returning({ id: users.id });
    try {
      await tx.insert(userIdentities).values({
        userId: created.id,
        provider: "TELEGRAM",
        providerUserId: validation.telegramUserId,
      });
    } catch (e) {
      // Гонка двух первых входов: unique-констрейнт Фазы 1. Проигравший
      // откатывается (savepoint) и переиспользует identity победителя.
      throw Object.assign(new FirstLoginRace(), { cause: e });
    }
    return created.id;
  }).catch(async (e) => {
    if (e instanceof FirstLoginRace) {
      const [row] = await db
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(
          sql`${userIdentities.provider} = 'TELEGRAM'
              AND ${userIdentities.providerUserId} = ${validation.telegramUserId}`,
        );
      if (row) return row.userId;
    }
    throw e;
  });

  const { rawToken } = await createSession(db, userId);
  const [u] = await db
    .select({ onboardingCompleted: users.onboardingCompleted })
    .from(users)
    .where(eq(users.id, userId));

  return {
    userId,
    csrfToken: deriveCsrfToken(hashToken(rawToken), getEnv("CSRF_SECRET")),
    setCookie: sessionCookie(rawToken),
    onboardingCompleted: u.onboardingCompleted,
  };
}

class FirstLoginRace extends Error {}

export { RateLimitedError };
