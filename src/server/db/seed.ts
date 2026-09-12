import { eq, sql } from "drizzle-orm";

import type { Database } from "./client";
import { productConfig, projectAliases, projects, researchPatterns, topics } from "./schema";
import { DEFAULT_PRODUCT_CONFIG } from "../config/product";
import { PATTERN_V1_CONTENT } from "../domain/pattern";

// Идемпотентный сид (phase-1-plan §8): тема, product config, каталог проектов,
// Pattern v1 (Фаза 5). Никаких фейковых Proof/Evidence/Memory —
// verified-знание сид создавать не может.
export async function seed(db: Database): Promise<void> {
  await db
    .insert(topics)
    .values({ slug: "token_value_capture", name: "Token Value Capture", isActive: true })
    .onConflictDoNothing({ target: topics.slug });

  const [topic] = await db
    .select()
    .from(topics)
    .where(eq(topics.slug, "token_value_capture"));

  for (const [key, value] of Object.entries(DEFAULT_PRODUCT_CONFIG)) {
    await db
      .insert(productConfig)
      .values({ key, value })
      .onConflictDoNothing({ target: productConfig.key });
  }

  // Каталог (scope), а не DEMO-доступность: она в product_config
  // (demo_project_slugs). Новая запись попадает в scope и НЕ становится
  // доступна DEMO — Scope != Entitlement.
  const catalogProjects = [
    { slug: "pump_fun", name: "Pump.fun", ticker: "PUMP" },
    { slug: "hyperliquid", name: "Hyperliquid", ticker: "HYPE" },
    { slug: "uniswap", name: "Uniswap", ticker: "UNI" },
    // Тикер владельцем при заведении не задан: каталожная запись не
    // утверждает идентичность токена — её место PROJECT_IDENTITY.
    { slug: "raydium", name: "Raydium", ticker: null },
    // Founder-approved 2026-09-12: the first UNSEEN validation project
    // (scenario family APPROVED ≠ LIVE ≠ EXECUTING). Catalog entry only —
    // no identity, no route, no resource: the engine discovers everything.
    { slug: "morpho", name: "Morpho", ticker: null },
    // Founder-approved 2026-09-12: the second UNSEEN validation project
    // (scenario family REVENUE ≠ TOKEN VALUE CAPTURE). Catalog entry only —
    // no identity, no route, no resource: the engine discovers everything.
    { slug: "lido", name: "Lido", ticker: null },
  ] as const;

  for (const p of catalogProjects) {
    await db
      .insert(projects)
      .values({ ...p, status: "ACTIVE_CORE", publishedAt: sql`now()` })
      .onConflictDoNothing({ target: projects.slug });
  }

  // RC-4 — ПОДТВЕРЖДЁННЫЕ ВЛАДЕЛЬЦЕМ АЛЬТЕРНАТИВНЫЕ НАПИСАНИЯ.
  //
  // Алиас — ЭТО НЕ утверждение идентичности токена. Поле projects.ticker
  // намеренно остаётся незаданным там, где владелец его не задавал, и
  // это решение здесь не переопределяется. Алиас говорит ровно одно:
  // «этой строкой люди называют вот этот уже известный проект».
  //
  // Зачем: на замороженной панели 3 из 9 вопросов по Raydium не дошли до
  // исследования: «Raydium» резолвился, а «RAY» не был связан ни с чем.
  // Отказ был честным — ATLAS не угадывает, — но сам вопрос был обычным.
  //
  // Коллизия не может возникнуть молча: uq_project_aliases_alias_lower —
  // глобальный уникальный индекс, поэтому один алиас не может
  // принадлежать двум проектам, а совпадение алиаса с именем или
  // тикером другого проекта резолвер вернёт как PROJECT_AMBIGUOUS,
  // а не выберет сам.
  const catalogAliases: ReadonlyArray<{ slug: string; alias: string }> = [
    { slug: "raydium", alias: "RAY" },
  ];

  for (const { slug, alias } of catalogAliases) {
    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) continue;
    await db.insert(projectAliases).values({ projectId: project.id, alias }).onConflictDoNothing();
  }

  // Pattern v1 (D-022, D-052): без этой строки CORE v0.1 отсутствует в БД
  // и планировщик Фазы 5 не может раскладывать память по шагам.
  await db
    .insert(researchPatterns)
    .values({
      topicId: topic.id,
      version: 1,
      status: "ACTIVE",
      content: PATTERN_V1_CONTENT,
    })
    .onConflictDoNothing({ target: [researchPatterns.topicId, researchPatterns.version] });
}
