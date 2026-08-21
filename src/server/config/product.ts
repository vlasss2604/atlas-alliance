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
  // Калитка Interpreter — отдельно от research_enabled (phase-4-plan §3.3,
  // решение владельца №3): Ask-экран понимает вопрос уже с Фазы 4,
  // но Proof запустить нельзя до Фазы 6.
  interpreter_enabled: z.boolean(),
  // Модель Interpreter (решение владельца №2). Смена — без деплоя.
  interpreter_model: z.string().min(1),
  ari_core_price_stars: z.number().int().positive(),
  subscription_period_days: z.number().int().positive(),
  demo_lifetime_proof_limit: z.number().int().positive(),
  demo_project_slugs: z.array(z.string().min(1)),
  demo_max_capability: z.enum(["MEMORY", "TARGETED_REFRESH", "FRESH_RESEARCH"]),
  demo_max_recovery_steps: z.number().int().min(0),
  budget_demo: jobBudgetSchema,
  budget_core: jobBudgetSchema,
  // Фаза 5 (D-043): оценка Memory OFF vs ON — штатный режим, не хак в
  // тестах. Планировщик читает этот ключ на каждый job.
  memory_enabled: z.boolean(),
  // Пороги retrieval — в конфиг, не в код (phase-5-plan.md §5.5).
  memory_retrieval_top_k: z.number().int().positive(),
  memory_min_confidence_reuse: z.number().int().min(0).max(100),
  // Фолбэк свежести, когда конкретная запись памяти не несёт stale_after.
  memory_stale_after_days: z.object({
    LOW_CHANGE: z.number().int().positive(),
    MEDIUM_CHANGE: z.number().int().positive(),
    HIGH_CHANGE: z.number().int().positive(),
  }),
  // Триггер пересмотра семантики (§3.4.4, §6): доля ретривалов, где память
  // существовала, но не была найдена structured-путём. Не enforced
  // автоматически в Фазе 5 — читается оценочным harness'ом (§7).
  memory_semantic_review_threshold: z.number().min(0).max(1),
});

export type ProductConfig = z.infer<typeof productConfigSchema>;
export type JobBudgetConfig = z.infer<typeof jobBudgetSchema>;

// Значения по умолчанию для сида (LOCKED §2, §4). После сида источник
// истины — таблица product_config, не этот объект.
export const DEFAULT_PRODUCT_CONFIG: ProductConfig = {
  research_enabled: false,
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
  memory_stale_after_days: {
    LOW_CHANGE: 180,
    MEDIUM_CHANGE: 30,
    HIGH_CHANGE: 3,
  },
  memory_semantic_review_threshold: 0.2,
};

export async function loadProductConfig(
  db: Database | Transaction,
): Promise<ProductConfig> {
  const rows = await db.select().from(productConfig);
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return productConfigSchema.parse(raw);
}
