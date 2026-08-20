import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Product config: цена, лимиты, DEMO-проекты, бюджеты. Ни одно из значений
// не появляется в коде или UI как литерал (B8).
export const productConfig = pgTable("product_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
