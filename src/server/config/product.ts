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
  // Фаза 6, S4 (D-032/D-026 continuation, P3): роли модели движка меняются
  // ключом, не кодом — тот же принцип, что interpreter_model. MEDIUM-3
  // (S4 review fix): .default(...) — не .min(1) без default — так строка
  // без соответствующей строки product_config (реальная существующая БД,
  // мигрированная, но не пересеянная) не роняет loadProductConfig() для
  // ВСЕХ вызывающих маршрутов. Миграция 0012 также сама вставляет эти
  // ключи (ON CONFLICT DO NOTHING) — это защита в глубину, не замена.
  query_proposer_model: z.string().min(1).default("claude-haiku-4-5"),
  evidence_extractor_model: z.string().min(1).default("claude-haiku-4-5"),
  // Question-driven Proof projection. Same .default(...) discipline as the
  // two roles above and for the same reason: an existing database that has
  // been migrated but never re-seeded has no product_config row for this
  // key, and loadProductConfig() must not throw for every caller because a
  // presentation feature is unconfigured.
  projection_model: z.string().min(1).default("claude-haiku-4-5"),
  // S10 (live-provider-enablement.md §10) — internal-alpha gate, SEPARATE
  // from research_enabled (the public/product gate, which MUST remain
  // false throughout S10 internal alpha). Live executor construction
  // (live-executor.ts) requires BOTH this flag AND an explicit owner/
  // admin `alpha-run --mode=live` invocation — neither alone is
  // sufficient. .default(false): same MEDIUM-3-style defense as
  // query_proposer_model above — an existing DB that only runs
  // migrations (never re-seeds) still fails closed rather than throwing.
  internal_alpha_enabled: z.boolean().default(false),
  // D-138 — phased research (D-136) as an explicit opt-in, and ONLY for
  // the owner/internal-alpha admission path. false means the owner-alpha
  // Start Proof creates exactly the single-process job it has always
  // created; true means it creates one phased job instead. It is not a
  // second research gate: research_enabled still decides whether the
  // public path is open at all, and internal_alpha_enabled still decides
  // whether live providers may be constructed. .default(false) is the
  // same defense used by internal_alpha_enabled above — a database that
  // only ran migrations and was never re-seeded fails closed onto the
  // existing behaviour instead of throwing.
  phased_research_enabled: z.boolean().default(false),
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
  // D-032: механическая генерация/извлечение — Haiku.
  query_proposer_model: "claude-haiku-4-5",
  evidence_extractor_model: "claude-haiku-4-5",
  projection_model: "claude-haiku-4-5",
  internal_alpha_enabled: false,
  phased_research_enabled: false,
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

// S10 (live-provider-enablement.md §6, owner decision, LOCKED) — the ONE
// immutable envelope for internal-alpha LIVE runs. Deliberately a plain
// code constant, not a product_config row: unlike budget_demo/budget_core
// (which the owner may retune via DB without a deploy), this number set
// is explicitly "do not attempt to perfect these — recalibrate after
// ~10-20 real internal runs" — a code change (reviewed, committed), same
// discipline as model-cost-profile.ts's catalogue. No Quick/Standard/Deep
// variants; exactly one envelope for the whole internal-alpha period.
export const INTERNAL_ALPHA_V1: JobBudgetConfig = {
  maxSearchQueries: 12,
  maxSourceOpens: 24,
  maxModelCostMicro: 2_000_000,
  maxWallClockSec: 900,
  reservedRecoverySteps: 1,
};

export async function loadProductConfig(
  db: Database | Transaction,
): Promise<ProductConfig> {
  const rows = await db.select().from(productConfig);
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return productConfigSchema.parse(raw);
}
