import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { researchIntakeOrigin, researchIntakeStatus } from "./enums";
import { users } from "./identity";
import { researchJobs } from "./research";

// RESEARCH INTAKE — THE CLAIM A USER HANDED IN, BEFORE ANYTHING ELSE EXISTS.
//
// One row per handed-in message, owned by exactly one canonical user
// (users.id — the Telegram sender was resolved through user_identities
// before this row could be written, so no Telegram identity lives here).
// It carries the bounded text, the little source context the entry surface
// could safely offer, and the project a deterministic catalog scan found,
// if any. It carries NO raw Telegram update, no sender profile, no chat id.
//
// PLATFORM-INDEPENDENT BY CONSTRUCTION (D-125): a Web or iOS client could
// write the same row from a share sheet. Only `origin` says where it came
// from.
//
// WHAT IT IS NOT. Not a source, not Evidence, not an observation, not a
// Research job. The Research that may follow is created only by the
// canonical start path, which marks the row CONSUMED on success and links
// the job. Opening, viewing or editing never consumes it.
export const researchIntakes = pgTable(
  "research_intakes",
  {
    // gen_random_uuid(): the id is the only launch token, so it must be
    // unguessable — and it is still useless without the owner's session.
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    origin: researchIntakeOrigin("origin").notNull(),
    // Bounded to the Interpreter's own question limit (MAX_QUESTION_CHARS),
    // pinned by the CHECK below so a longer text cannot be stored.
    rawText: text("raw_text").notNull(),
    // Optional, bounded source context for presentation only: a channel
    // title or @username, and a public t.me link when one could be derived
    // safely. Never a private chat id, never a sender name.
    sourceLabel: text("source_label"),
    sourceUrl: text("source_url"),
    // The one catalog project a deterministic scan of the text resolved to,
    // or null. Advisory for the bot reply and the Ask screen; the
    // Interpreter and the gates decide, never this column.
    detectedProjectSlug: text("detected_project_slug"),
    status: researchIntakeStatus("status").notNull().default("OPEN"),
    // Idempotency against delivery retries from the entry surface
    // (Telegram re-sends an update it got no 200 for): one row per
    // (user, external reference).
    externalRef: text("external_ref"),
    researchJobId: uuid("research_job_id").references(() => researchJobs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("ix_research_intakes_user_created").on(t.userId, t.createdAt.desc()),
    uniqueIndex("uq_research_intakes_external_ref")
      .on(t.userId, t.externalRef)
      .where(sql`external_ref IS NOT NULL`),
    check("ck_research_intakes_raw_text_bounded", sql`char_length(${t.rawText}) BETWEEN 1 AND 2000`),
    check("ck_research_intakes_source_label_bounded", sql`${t.sourceLabel} IS NULL OR char_length(${t.sourceLabel}) <= 120`),
    check("ck_research_intakes_source_url_bounded", sql`${t.sourceUrl} IS NULL OR char_length(${t.sourceUrl}) <= 200`),
    // CONSUMED carries the moment it happened; OPEN never does.
    check(
      "ck_research_intakes_consumed_consistent",
      sql`(${t.status} = 'CONSUMED') = (${t.consumedAt} IS NOT NULL)`,
    ),
  ],
);
