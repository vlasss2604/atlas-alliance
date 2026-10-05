-- PRIVATE-BETA FEEDBACK (Founder-approved, D-170).
--
-- One row per user, ever: the answer to the one-time prompt shown after
-- the user's second private-beta Research with a Proof (SUBMITTED), or the
-- record that they skipped it (DISMISSED). Either way the prompt is never
-- shown again. Owned by the canonical users.id (cascade on account
-- deletion). Bounded answers only: no Telegram identity, no request
-- metadata, no Research reference. Spends and grants nothing.
--
-- Forward only, additive only: one table, two enums, no row touched.
CREATE TYPE "public"."beta_feedback_status" AS ENUM('SUBMITTED', 'DISMISSED');
--> statement-breakpoint
CREATE TYPE "public"."beta_feedback_keep_using" AS ENUM('YES', 'NO', 'UNSURE');
--> statement-breakpoint
CREATE TABLE "research_beta_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "beta_feedback_status" NOT NULL,
	"useful" text,
	"missing" text,
	"keep_using" "beta_feedback_keep_using",
	"change_needed" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_research_beta_feedback_useful_bounded" CHECK ("useful" IS NULL OR char_length("useful") <= 1000),
	CONSTRAINT "ck_research_beta_feedback_missing_bounded" CHECK ("missing" IS NULL OR char_length("missing") <= 1000),
	CONSTRAINT "ck_research_beta_feedback_change_bounded" CHECK ("change_needed" IS NULL OR char_length("change_needed") <= 1000),
	CONSTRAINT "ck_research_beta_feedback_status_consistent" CHECK (("status" = 'SUBMITTED' AND "keep_using" IS NOT NULL) OR ("status" = 'DISMISSED' AND "useful" IS NULL AND "missing" IS NULL AND "keep_using" IS NULL AND "change_needed" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "research_beta_feedback" ADD CONSTRAINT "research_beta_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_beta_feedback_user" ON "research_beta_feedback" USING btree ("user_id");
