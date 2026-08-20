import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";

import { createDatabase, type Database } from "../src/server/db/client";
import { seed } from "../src/server/db/seed";
import { createBoss, RESEARCH_QUEUE } from "../src/server/jobs/queue";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://atlas:atlas@localhost:5432/atlas_test";

export interface TestContext {
  db: Database;
  boss: PgBoss;
  close: () => Promise<void>;
}

// Чистая БД на каждый запуск: DROP SCHEMA CASCADE → миграции → сид →
// pg-boss install (DoD-тест 1 «миграции проходят на чистой БД» — сам setup).
export async function setupTestDatabase(): Promise<TestContext> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const { db, pool } = createDatabase(TEST_DATABASE_URL);

  await db.execute(sql`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  await db.execute(sql`DROP SCHEMA public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);

  await migrate(db, { migrationsFolder: "./src/server/db/migrations" });
  await seed(db);

  const boss = createBoss(TEST_DATABASE_URL);
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue(RESEARCH_QUEUE);

  return {
    db,
    boss,
    close: async () => {
      await boss.stop({ graceful: false });
      await pool.end();
    },
  };
}

export function demoEntitlement(): EntitlementSnapshot {
  return {
    level: "DEMO",
    capability: "TARGETED_REFRESH",
    budget: DEFAULT_PRODUCT_CONFIG.budget_demo,
  };
}

export function coreEntitlement(): EntitlementSnapshot {
  return {
    level: "ARI_CORE",
    capability: "FRESH_RESEARCH",
    budget: DEFAULT_PRODUCT_CONFIG.budget_core,
  };
}

let seq = 0;
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}_${Math.random().toString(36).slice(2, 8)}`;
}
