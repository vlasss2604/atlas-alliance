import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { entitlementLevel, subscriptionStatus, userRole } from "./enums";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  role: userRole("role").notNull().default("USER"),
  // RU/EN, ручной выбор в Профиле; по умолчанию английский (LOCKED §9)
  language: text("language").notNull().default("EN"),
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
  onboardingVersion: smallint("onboarding_version"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Lifetime DEMO-счётчик здесь НЕ хранится: единственный источник истины —
  // demo_quota_reservations (использовано = COUNT(state='CONSUMED')).
});

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // v1: 'TELEGRAM'
    providerUserId: text("provider_user_id").notNull(),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_user_identities_provider").on(t.provider, t.providerUserId),
  ],
);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Хэш токена, не сырой токен. Наполнение — Фаза 2.
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    level: entitlementLevel("level").notNull().default("ARI_CORE"),
    status: subscriptionStatus("status").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    autoRenew: boolean("auto_renew").notNull().default(true),
    billingProvider: text("billing_provider").notNull().default("TELEGRAM_STARS"),
    providerSubscriptionRef: text("provider_subscription_ref"),
    planVersion: text("plan_version"),
    // Снапшот цены в момент покупки. Деньги — целые числа (Stars).
    priceStarsAtPurchase: integer("price_stars_at_purchase"),
    cancelledReason: text("cancelled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Утверждено (вариант A): entitling = ACTIVE | CANCEL_AT_PERIOD_END.
    // Две одновременно действующие entitlement-подписки невозможны.
    uniqueIndex("uq_subscriptions_one_entitling")
      .on(t.userId)
      .where(sql`${t.status} IN ('ACTIVE', 'CANCEL_AT_PERIOD_END')`),
  ],
);
