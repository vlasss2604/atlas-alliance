import { and, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { demoQuotaReservations, subscriptions } from "../db/schema";
import type { ProductConfig } from "../config/product";
import type { EntitlementSnapshot } from "../domain/types";

export interface EntitlementView {
  snapshot: EntitlementSnapshot;
  demoUsed: number; // только CONSUMED — то, что видит пользователь
  demoLimit: number;
}

// Entitlement ВЫЧИСЛЯЕТСЯ, не хранится (B1): entitling-подписка =
// status IN (ACTIVE, CANCEL_AT_PERIOD_END) AND now() < valid_until
// (утверждено владельцем: вариант A — отмена продления дослуживает период).
export async function resolveEntitlement(
  db: Database,
  userId: string,
  config: ProductConfig,
): Promise<EntitlementView> {
  const entitling = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ["ACTIVE", "CANCEL_AT_PERIOD_END"]),
        gt(subscriptions.validUntil, sql`now()`),
      ),
    );

  const [{ used }] = (
    await db.execute(sql`
      SELECT count(*)::int AS used FROM ${demoQuotaReservations}
      WHERE user_id = ${userId} AND state = 'CONSUMED'
    `)
  ).rows as [{ used: number }];

  const isCore = entitling.length > 0;
  return {
    snapshot: isCore
      ? { level: "ARI_CORE", capability: "FRESH_RESEARCH", budget: config.budget_core }
      : {
          level: "DEMO",
          capability: config.demo_max_capability,
          budget: config.budget_demo,
        },
    demoUsed: used,
    demoLimit: config.demo_lifetime_proof_limit,
  };
}
