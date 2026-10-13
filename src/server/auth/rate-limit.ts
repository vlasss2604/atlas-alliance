import { sql } from "drizzle-orm";

import type { Database } from "../db/client";

export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super("rate limited");
    this.name = "RateLimitedError";
  }
}

// Атомарный инкремент бакета фиксированного окна (phase-2-plan §2.1):
// один UPSERT, никакого read-modify-write; истёкшее окно сбрасывается
// в том же statement. Порядок применения ключей задаёт вызывающая сторона:
// IP-бакет — ДО валидации initData, TG-бакет — только для verified id.
export async function hitRateLimit(
  db: Database,
  bucketKey: string,
  limit: number,
  windowSec: number,
): Promise<void> {
  const res = await db.execute(sql`
    INSERT INTO auth_rate_limits (bucket_key, window_started_at, attempts)
    VALUES (${bucketKey}, now(), 1)
    ON CONFLICT (bucket_key) DO UPDATE SET
      attempts = CASE
        WHEN auth_rate_limits.window_started_at < now() - make_interval(secs => ${windowSec})
        THEN 1 ELSE auth_rate_limits.attempts + 1 END,
      window_started_at = CASE
        WHEN auth_rate_limits.window_started_at < now() - make_interval(secs => ${windowSec})
        THEN now() ELSE auth_rate_limits.window_started_at END
    RETURNING attempts,
      GREATEST(0, ${windowSec} - EXTRACT(EPOCH FROM (now() - window_started_at)))::int AS retry_after
  `);
  const row = res.rows[0] as { attempts: number; retry_after: number };
  if (row.attempts > limit) {
    throw new RateLimitedError(Math.max(1, row.retry_after));
  }
}

export async function deleteStaleRateLimits(
  db: Database,
  olderThanSec: number,
): Promise<number> {
  const res = await db.execute(
    sql`DELETE FROM auth_rate_limits
        WHERE window_started_at < now() - make_interval(secs => ${olderThanSec})`,
  );
  return res.rowCount ?? 0;
}
