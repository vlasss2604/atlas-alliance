import type { Pool } from "pg";

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
  await _pool?.end().catch(() => {});
  _db = null;
  _pool = null;
  _config = null;
}
