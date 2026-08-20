import { sql } from "drizzle-orm";

import type { Database } from "./client";
import { productConfig, projects, topics } from "./schema";
import { DEFAULT_PRODUCT_CONFIG } from "../config/product";

// Идемпотентный сид (phase-1-plan §8): тема, product config, 3 DEMO-проекта.
// Никаких фейковых Proof/Evidence/Memory — verified-знание сид создавать не может.
export async function seed(db: Database): Promise<void> {
  await db
    .insert(topics)
    .values({ slug: "token_value_capture", name: "Token Value Capture", isActive: true })
    .onConflictDoNothing({ target: topics.slug });

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
}
