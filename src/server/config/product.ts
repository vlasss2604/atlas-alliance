import { z } from "zod";

import type { Database, Transaction } from "../db/client";
import { productConfig } from "../db/schema";

// Бюджеты — целые числа; стоимость модели — в микро-USD.
const jobBudgetSchema = z.object({
  maxSearchQueries: z.number().int().positive(),
  maxSourceOpens: z.number().int().positive(),
  maxModelCostMicro: z.number().int().positive(),
  maxWallClockSec: z.number().int().positive(),
  reservedRecoverySteps: z.number().int().min(0),
});

const productConfigSchema = z.object({
  // Калитка запуска исследований (phase-3-plan §2). Аварийное отключение
  // без деплоя; включается только с появлением Interpreter (Фаза 4).
  research_enabled: z.boolean(),
  ari_core_price_stars: z.number().int().positive(),
  subscription_period_days: z.number().int().positive(),
  demo_lifetime_proof_limit: z.number().int().positive(),
  demo_project_slugs: z.array(z.string().min(1)),
  demo_max_capability: z.enum(["MEMORY", "TARGETED_REFRESH", "FRESH_RESEARCH"]),
  demo_max_recovery_steps: z.number().int().min(0),
  budget_demo: jobBudgetSchema,
  budget_core: jobBudgetSchema,
});

export type ProductConfig = z.infer<typeof productConfigSchema>;
export type JobBudgetConfig = z.infer<typeof jobBudgetSchema>;

// Значения по умолчанию для сида (LOCKED §2, §4). После сида источник
// истины — таблица product_config, не этот объект.
export const DEFAULT_PRODUCT_CONFIG: ProductConfig = {
  research_enabled: false,
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
};

export async function loadProductConfig(
  db: Database | Transaction,
): Promise<ProductConfig> {
  const rows = await db.select().from(productConfig);
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return productConfigSchema.parse(raw);
}
