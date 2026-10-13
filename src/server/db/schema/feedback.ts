import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { betaFeedbackKeepUsing, betaFeedbackStatus } from "./enums";
import { users } from "./identity";

// PRIVATE-BETA FEEDBACK (D-170) — ONE ROW PER USER, EVER.
//
// Written once, when the user answers the prompt (SUBMITTED) or skips it
// (DISMISSED); the row's existence is what keeps the prompt from coming
// back. Owned by the canonical users.id and deleted with the account.
//
// It carries the user's own bounded answers and nothing else: no Telegram
// id, username or profile, no request metadata, no Research reference. It
// is product feedback — never a source, never Evidence, never a signal
// the engine or Memory reads, and it spends or grants nothing.
export const FEEDBACK_TEXT_MAX = 1000;

export const researchBetaFeedback = pgTable(
  "research_beta_feedback",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: betaFeedbackStatus("status").notNull(),
    // 1. What was useful?
    useful: text("useful"),
    // 2. What was missing, or what would you add?
    missing: text("missing"),
    // 3. Would you keep using ATLAS? — and, optionally, what would need to change.
    keepUsing: betaFeedbackKeepUsing("keep_using"),
    changeNeeded: text("change_needed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_research_beta_feedback_user").on(t.userId),
    check("ck_research_beta_feedback_useful_bounded", sql`${t.useful} IS NULL OR char_length(${t.useful}) <= 1000`),
    check("ck_research_beta_feedback_missing_bounded", sql`${t.missing} IS NULL OR char_length(${t.missing}) <= 1000`),
    check(
      "ck_research_beta_feedback_change_bounded",
      sql`${t.changeNeeded} IS NULL OR char_length(${t.changeNeeded}) <= 1000`,
    ),
    // A submission names its answer to question 3; a skip carries no answers.
    check(
      "ck_research_beta_feedback_status_consistent",
      sql`(${t.status} = 'SUBMITTED' AND ${t.keepUsing} IS NOT NULL) OR (${t.status} = 'DISMISSED' AND ${t.useful} IS NULL AND ${t.missing} IS NULL AND ${t.keepUsing} IS NULL AND ${t.changeNeeded} IS NULL)`,
    ),
  ],
);
