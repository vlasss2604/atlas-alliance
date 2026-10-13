import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { projectStatus } from "./enums";

export const topics = pgTable("topics", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // Активна одна тема (token_value_capture); активация новых — только вручную.
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ticker: text("ticker"),
  // Статус — данные, не код. DEMO-доступность здесь не хранится:
  // она в product_config (Scope ≠ Entitlement).
  status: projectStatus("status").notNull().default("RESEARCHED_INTERNAL"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const projectAliases = pgTable(
  "project_aliases",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    alias: text("alias").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("uq_project_aliases_alias_lower").on(sql`lower(${t.alias})`)],
);

export const researchPatterns = pgTable(
  "research_patterns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("DRAFT"),
    content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_research_patterns_topic_version").on(t.topicId, t.version),
    // Одна ACTIVE-версия Pattern на тему; переход v1→v2 — только вручную.
    uniqueIndex("uq_research_patterns_one_active")
      .on(t.topicId)
      .where(sql`${t.status} = 'ACTIVE'`),
    check(
      "ck_research_patterns_status",
      sql`${t.status} IN ('DRAFT', 'ACTIVE', 'RETIRED')`,
    ),
  ],
);
