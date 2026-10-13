import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { sessions, users } from "../db/schema";

export const SESSION_COOKIE = "atlas_session";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 604800

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// Точная строка атрибутов cookie — требование phase-2-plan §2 (тест §9.3).
export function sessionCookie(rawToken: string): string {
  return `${SESSION_COOKIE}=${rawToken}; Path=/; Max-Age=${SESSION_TTL_SEC}; HttpOnly; Secure; SameSite=None`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;
}

// Создание сессии с ротацией: все прежние сессии пользователя удаляются.
export async function createSession(
  dbOrTx: Database | Transaction,
  userId: string,
): Promise<{ rawToken: string }> {
  const rawToken = randomBytes(32).toString("base64url");
  await dbOrTx.delete(sessions).where(eq(sessions.userId, userId));
  await dbOrTx.insert(sessions).values({
    userId,
    tokenHash: hashToken(rawToken),
    expiresAt: sql`now() + make_interval(secs => ${SESSION_TTL_SEC})`,
  });
  return { rawToken };
}

export interface SessionInfo {
  userId: string;
  tokenHash: string;
  role: "USER" | "ADMIN";
}

export async function findSession(
  db: Database,
  rawToken: string,
): Promise<SessionInfo | null> {
  const rows = await db
    .select({
      userId: sessions.userId,
      tokenHash: sessions.tokenHash,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, hashToken(rawToken)), gt(sessions.expiresAt, sql`now()`)),
    );
  return rows[0] ?? null;
}

export async function deleteExpiredSessions(db: Database): Promise<number> {
  const res = await db.execute(sql`DELETE FROM sessions WHERE expires_at <= now()`);
  return res.rowCount ?? 0;
}
