import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "../src/server/db/client";
import { productConfig } from "../src/server/db/schema";
import { loadProductConfig } from "../src/server/config/product";

// S4 review fix, MEDIUM-3: an existing, already-migrated Phase 1-5
// production database (product_config populated by an OLD seed that
// predates query_proposer_model/evidence_extractor_model) must survive
// the normal deployment path — migrate() run against the up-to-date
// migrations folder, WITHOUT a manual reseed — without loadProductConfig()
// breaking for unrelated API routes. Migration 0012 owns inserting the two
// new keys with approved defaults (ON CONFLICT DO NOTHING); the
// productConfigSchema .default(...) fallback is defense-in-depth only.
//
// This test reproduces the real rollout shape rather than asserting on
// the fix in isolation: it builds a database frozen at the LAST pre-S4
// migration (0011), hand-seeds product_config the way an old deployed
// seed would have (no S4 keys, plus one OWNER-CUSTOMIZED value on an
// existing key), then runs migrate() against the REAL, current migrations
// folder — the exact call `next start`/the deploy job would make — and
// checks the result.

const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "server", "db", "migrations");
const PRE_S4_LAST_TAG = "0011_s4_attempt_spend_and_evidence_version_check";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://atlas:atlas@localhost:5432/atlas_test";

async function buildPreS4MigrationsFolder(): Promise<string> {
  const journal = JSON.parse(
    await fs.readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] } & Record<string, unknown>;
  const cutIdx = journal.entries.findIndex((e) => e.tag === PRE_S4_LAST_TAG);
  if (cutIdx === -1) throw new Error(`pre-S4 cutoff tag not found: ${PRE_S4_LAST_TAG}`);
  const preS4Entries = journal.entries.slice(0, cutIdx + 1);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pre-s4-migrations-"));
  const metaDir = path.join(tmpDir, "meta");
  await fs.mkdir(metaDir);
  for (const entry of preS4Entries) {
    await fs.copyFile(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), path.join(tmpDir, `${entry.tag}.sql`));
    const snapshotName = `${String(preS4Entries.indexOf(entry)).padStart(4, "0")}_snapshot.json`;
    await fs.copyFile(path.join(MIGRATIONS_DIR, "meta", snapshotName), path.join(metaDir, snapshotName));
  }
  await fs.writeFile(
    path.join(metaDir, "_journal.json"),
    JSON.stringify({ ...journal, entries: preS4Entries }, null, 2),
  );
  return tmpDir;
}

describe("Фаза 6, S4 review fix — MEDIUM-3: существующая (не пересеянная) БД проходит нормальный путь миграции", () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>["pool"];

  beforeAll(async () => {
    ({ db, pool } = createDatabase(TEST_DATABASE_URL));
    await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await db.execute(sql`DROP SCHEMA public CASCADE`);
    await db.execute(sql`CREATE SCHEMA public`);

    // 1. Freeze the DB at the last pre-S4 migration — the state of a real
    // production database before this review-fix package.
    const preS4Dir = await buildPreS4MigrationsFolder();
    await migrate(db, { migrationsFolder: preS4Dir });

    // 2. Hand-seed product_config the way the OLD (pre-S4) seed() would
    // have — every key that existed at the time, NONE of the two new S4
    // keys, and one row deliberately set to a non-default,
    // owner-customized value (research_enabled=true) to prove the
    // upgrade path never overwrites what the owner already set.
    const preS4Config: Record<string, unknown> = {
      research_enabled: true, // owner-customized, non-default
      interpreter_enabled: true,
      interpreter_model: "claude-haiku-4-5",
      ari_core_price_stars: 2999,
      subscription_period_days: 30,
      demo_lifetime_proof_limit: 3,
      demo_project_slugs: ["pump_fun", "hyperliquid", "uniswap"],
      demo_max_capability: "TARGETED_REFRESH",
      demo_max_recovery_steps: 1,
      budget_demo: {
        maxSearchQueries: 8,
        maxSourceOpens: 12,
        maxModelCostMicro: 500_000,
        maxWallClockSec: 300,
        reservedRecoverySteps: 1,
      },
      budget_core: {
        maxSearchQueries: 40,
        maxSourceOpens: 60,
        maxModelCostMicro: 4_000_000,
        maxWallClockSec: 1200,
        reservedRecoverySteps: 3,
      },
      memory_enabled: true,
      memory_retrieval_top_k: 5,
      memory_min_confidence_reuse: 70,
      memory_stale_after_days: { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 },
      memory_semantic_review_threshold: 0.2,
    };
    for (const [key, value] of Object.entries(preS4Config)) {
      await db.insert(productConfig).values({ key, value });
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("нормальный путь миграции (migrate() против актуальной папки, без ручного пересева) -> loadProductConfig успешен, старый config сохранён, новые ключи получают approved defaults", async () => {
    // 3. The actual deploy step: migrate() against the REAL, current
    // migrations folder — same call the app makes on every boot.
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    // 4. Every route that calls loadProductConfig() must keep working —
    // this is the direct regression for "loadProductConfig() fails across
    // unrelated API routes".
    const config = await loadProductConfig(db);

    // Old, owner-customized value is untouched — migration must never
    // overwrite it.
    expect(config.research_enabled).toBe(true);
    // Other pre-existing values survive unchanged.
    expect(config.demo_lifetime_proof_limit).toBe(3);
    expect(config.budget_core.maxSearchQueries).toBe(40);

    // New S4 keys are present with the approved default — migration 0012
    // owns this insert (ON CONFLICT DO NOTHING).
    expect(config.query_proposer_model).toBe("claude-haiku-4-5");
    expect(config.evidence_extractor_model).toBe("claude-haiku-4-5");

    const [row] = await db.select().from(productConfig).where(eq(productConfig.key, "query_proposer_model"));
    expect(row).toBeDefined();
    expect(row.value).toBe("claude-haiku-4-5");
  });
});
