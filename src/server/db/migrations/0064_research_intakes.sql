-- RESEARCH INTAKES (Founder-approved: Telegram forward → ATLAS → Research).
--
-- A claim a user handed to ATLAS through an entry surface (today: a message
-- forwarded to the Telegram bot), stored BEFORE any interpretation or
-- Research exists. It is an INPUT: never a source, never Evidence, never a
-- Research job, and nothing in the engine reads it. The Research it may
-- lead to starts only through the canonical Ask → Interpreter → admission
-- path, which marks the row CONSUMED on success and links the job.
--
-- Owned by the canonical users.id (cascade on account deletion). Carries no
-- raw Telegram update, no sender profile, no chat id. Text is bounded to
-- the Interpreter's own question limit (2000). Expiry is a timestamp, not a
-- state, so nothing has to sweep.
--
-- Forward only, additive only: one table, two enums, no row touched.
CREATE TYPE "public"."research_intake_origin" AS ENUM('TELEGRAM_FORWARD');
--> statement-breakpoint
CREATE TYPE "public"."research_intake_status" AS ENUM('OPEN', 'CONSUMED');
--> statement-breakpoint
CREATE TABLE "research_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"origin" "research_intake_origin" NOT NULL,
	"raw_text" text NOT NULL,
	"source_label" text,
	"source_url" text,
	"detected_project_slug" text,
	"status" "research_intake_status" DEFAULT 'OPEN' NOT NULL,
	"external_ref" text,
	"research_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "ck_research_intakes_raw_text_bounded" CHECK (char_length("raw_text") BETWEEN 1 AND 2000),
	CONSTRAINT "ck_research_intakes_source_label_bounded" CHECK ("source_label" IS NULL OR char_length("source_label") <= 120),
	CONSTRAINT "ck_research_intakes_source_url_bounded" CHECK ("source_url" IS NULL OR char_length("source_url") <= 200),
	CONSTRAINT "ck_research_intakes_consumed_consistent" CHECK (("status" = 'CONSUMED') = ("consumed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "research_intakes" ADD CONSTRAINT "research_intakes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_intakes" ADD CONSTRAINT "research_intakes_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ix_research_intakes_user_created" ON "research_intakes" USING btree ("user_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_intakes_external_ref" ON "research_intakes" USING btree ("user_id","external_ref") WHERE external_ref IS NOT NULL;
