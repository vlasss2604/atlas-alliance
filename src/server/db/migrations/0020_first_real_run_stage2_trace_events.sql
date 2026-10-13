CREATE TYPE "public"."trace_budget_axis" AS ENUM('searchQueries', 'sourceOpens', 'modelCostMicro');--> statement-breakpoint
CREATE TYPE "public"."trace_operation_type" AS ENUM('QUERY_PROPOSED', 'SEARCH_EXECUTED', 'CANDIDATE_RETURNED', 'CANDIDATE_DEDUPED', 'CANDIDATE_SKIPPED_BUDGET', 'FETCH_ATTEMPTED', 'FETCH_OK', 'FETCH_FAILED', 'EXTRACT_ATTEMPTED', 'EXTRACT_OK', 'EXTRACT_FAILED', 'REJECTED_WRONG_PROJECT', 'REJECTED_WRONG_COMPONENT', 'REJECTED_NOT_TRACEABLE');--> statement-breakpoint
CREATE TYPE "public"."trace_provider_kind" AS ENUM('QUERY_PROPOSE', 'SEARCH', 'FETCH', 'EXTRACT');--> statement-breakpoint
CREATE TYPE "public"."trace_reason_code" AS ENUM('NONE', 'ZERO_CANDIDATES', 'DUPLICATE_URL', 'SEARCH_QUERY_BUDGET_EXHAUSTED', 'SOURCE_OPEN_BUDGET_EXHAUSTED', 'MODEL_COST_BUDGET_EXHAUSTED', 'PROVIDER_ERROR', 'WRONG_PROJECT', 'WRONG_COMPONENT', 'NOT_TRACEABLE');--> statement-breakpoint
CREATE TYPE "public"."trace_status" AS ENUM('OK', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "research_trace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"research_attempt_id" uuid,
	"sequence" bigint NOT NULL,
	"operation_type" "trace_operation_type" NOT NULL,
	"provider_kind" "trace_provider_kind",
	"provider_name" text,
	"pattern_step" smallint,
	"component" text,
	"target_ref" text,
	"status" "trace_status" NOT NULL,
	"reason_code" "trace_reason_code" DEFAULT 'NONE' NOT NULL,
	"source_id" uuid,
	"evidence_id" uuid,
	"budget_axis" "trace_budget_axis",
	"budget_amount" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_research_trace_events_target_ref_len" CHECK (char_length("research_trace_events"."target_ref") <= 2048)
);
--> statement-breakpoint
ALTER TABLE "research_trace_events" ADD CONSTRAINT "research_trace_events_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_trace_events" ADD CONSTRAINT "research_trace_events_research_attempt_id_research_attempts_id_fk" FOREIGN KEY ("research_attempt_id") REFERENCES "public"."research_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_trace_events_job_sequence" ON "research_trace_events" USING btree ("research_job_id","sequence");--> statement-breakpoint
CREATE INDEX "ix_research_trace_events_job" ON "research_trace_events" USING btree ("research_job_id");--> statement-breakpoint
CREATE INDEX "ix_research_trace_events_attempt" ON "research_trace_events" USING btree ("research_attempt_id");