import type { Pool } from "pg";
import { PgBoss } from "pg-boss";

import { createDatabase, type Database } from "./db/client";
import { loadProductConfig, type ProductConfig } from "./config/product";

// Ленивые синглтоны процесса (Next route handlers / worker).
let _db: Database | null = null;
let _pool: Pool | null = null;

export function getDb(): Database {
  if (!_db) {
    const created = createDatabase();
    _db = created.db;
    _pool = created.pool;
  }
  return _db;
}

// pg-boss на стороне API: только транзакционный enqueue, без maintenance
// (обслуживанием занимается worker-процесс).
let _boss: PgBoss | null = null;
let _bossStarting: Promise<PgBoss> | null = null;

// Single-flight (adversarial review, LOW-7): конкурентные первые вызовы
// не должны запускать и терять второй экземпляр с его подключениями.
export async function getBoss(): Promise<PgBoss> {
  if (_boss) return _boss;
  if (_bossStarting) return _bossStarting;
  _bossStarting = (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      supervise: false,
      schedule: false,
    });
    boss.on("error", (e) => console.error("[pg-boss api]", e));
    await boss.start();
    _boss = boss;
    return boss;
  })().finally(() => {
    _bossStarting = null;
  });
  return _bossStarting;
}

let _config: { value: ProductConfig; loadedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;

export async function getProductConfig(): Promise<ProductConfig> {
  if (!_config || Date.now() - _config.loadedAt > CONFIG_TTL_MS) {
    _config = { value: await loadProductConfig(getDb()), loadedAt: Date.now() };
  }
  return _config.value;
}

// Для тестов: сбросить синглтоны (смена DATABASE_URL, кэш конфига).
export async function __resetRuntime(): Promise<void> {
  await _boss?.stop({ graceful: false }).catch(() => {});
  await _pool?.end().catch(() => {});
  _db = null;
  _pool = null;
  _boss = null;
  _config = null;
}
