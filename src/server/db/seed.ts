import { eq, sql } from "drizzle-orm";

import type { Database } from "./client";
import { productConfig, projects, researchPatterns, topics } from "./schema";
import { DEFAULT_PRODUCT_CONFIG } from "../config/product";
import { PATTERN_V1_CONTENT } from "../domain/pattern";

// Идемпотентный сид (phase-1-plan §8): тема, product config, 3 DEMO-проекта,
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

  const demoProjects = [
    { slug: "pump_fun", name: "Pump.fun", ticker: "PUMP" },
    { slug: "hyperliquid", name: "Hyperliquid", ticker: "HYPE" },
    { slug: "uniswap", name: "Uniswap", ticker: "UNI" },
  ] as const;

  for (const p of demoProjects) {
    await db
      .insert(projects)
      .values({ ...p, status: "ACTIVE_CORE", publishedAt: sql`now()` })
      .onConflictDoNothing({ target: projects.slug });
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
