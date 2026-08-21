CREATE TYPE "public"."entitlement_level" AS ENUM('DEMO', 'ARI_CORE');--> statement-breakpoint
CREATE TYPE "public"."evidence_relationship" AS ENUM('SUPPORTS', 'CONTRADICTS', 'CONTEXT', 'LIMITS');--> statement-breakpoint
CREATE TYPE "public"."interpreter_status" AS ENUM('READY', 'NEEDS_CLARIFICATION', 'OUT_OF_SCOPE', 'INVALID');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('NOT_USED', 'USED', 'USED_AND_REVERIFIED');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('RESEARCHED_INTERNAL', 'CANDIDATE', 'ACTIVE_CORE', 'UNPUBLISHED', 'DEPRECATED');--> statement-breakpoint
CREATE TYPE "public"."proof_visibility" AS ENUM('PRIVATE', 'ADMIN_ONLY');--> statement-breakpoint
CREATE TYPE "public"."quota_reservation_state" AS ENUM('RESERVED', 'CONSUMED', 'RELEASED');--> statement-breakpoint
CREATE TYPE "public"."research_capability" AS ENUM('MEMORY', 'TARGETED_REFRESH', 'FRESH_RESEARCH');--> statement-breakpoint
CREATE TYPE "public"."research_job_state" AS ENUM('QUEUED', 'RUNNING', 'AWAITING_CLARIFICATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BUDGET_LIMIT_REACHED');--> statement-breakpoint
CREATE TYPE "public"."source_health" AS ENUM('UNKNOWN', 'OK', 'BROKEN', 'CHANGED');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('OFFICIAL_DOCS', 'GOVERNANCE', 'ONCHAIN', 'SECURITY', 'RESEARCH', 'NEWS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('PENDING', 'ACTIVE', 'CANCEL_AT_PERIOD_END', 'CANCELLED', 'EXPIRED', 'PAST_DUE');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('USER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('SUPPORTED', 'PARTIALLY_SUPPORTED', 'NOT_SUPPORTED', 'INSUFFICIENT_EVIDENCE', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"level" "entitlement_level" DEFAULT 'ARI_CORE' NOT NULL,
	"status" "subscription_status" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"billing_provider" text DEFAULT 'TELEGRAM_STARS' NOT NULL,
	"provider_subscription_ref" text,
	"plan_version" text,
	"price_stars_at_purchase" integer,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "user_role" DEFAULT 'USER' NOT NULL,
	"language" text DEFAULT 'EN' NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"onboarding_version" smallint,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"ticker" text,
	"status" "project_status" DEFAULT 'RESEARCHED_INTERNAL' NOT NULL,
	"published_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "research_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_research_patterns_status" CHECK ("research_patterns"."status" IN ('DRAFT', 'ACTIVE', 'RETIRED'))
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "demo_quota_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"research_job_id" uuid NOT NULL,
	"state" "quota_reservation_state" DEFAULT 'RESERVED' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"research_job_id" uuid,
	"original_question" text NOT NULL,
	"status" "interpreter_status" NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"result" jsonb,
	"model_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_interpretations_attempt" CHECK ("interpretations"."attempt" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "research_job_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"from_state" "research_job_state" NOT NULL,
	"to_state" "research_job_state" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "research_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"topic_id" uuid NOT NULL,
	"state" "research_job_state" DEFAULT 'QUEUED' NOT NULL,
	"progress_stage" smallint DEFAULT 1 NOT NULL,
	"memory_status" "memory_status" DEFAULT 'NOT_USED' NOT NULL,
	"original_question" text NOT NULL,
	"normalized_task" jsonb,
	"normalized_task_hash" text NOT NULL,
	"entitlement_at_start" "entitlement_level" NOT NULL,
	"capability_at_start" "research_capability" NOT NULL,
	"budget_at_start" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"clarification_attempts" smallint DEFAULT 0 NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_research_jobs_progress_stage" CHECK ("research_jobs"."progress_stage" BETWEEN 1 AND 5),
	CONSTRAINT "ck_research_jobs_clarifications" CHECK ("research_jobs"."clarification_attempts" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proof_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"relationship" "evidence_relationship" NOT NULL,
	"fragment" text NOT NULL,
	"summary" text,
	"does_not_prove" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone,
	"data_as_of" timestamp with time zone,
	"freshness_class" text,
	"retrieved_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_evidence_freshness_class" CHECK ("evidence"."freshness_class" IS NULL OR "evidence"."freshness_class" IN ('LOW', 'MEDIUM', 'HIGH_CHANGE'))
);
--> statement-breakpoint
CREATE TABLE "proof_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proof_id" uuid NOT NULL,
	"description" text NOT NULL,
	"kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"visibility" "proof_visibility" DEFAULT 'PRIVATE' NOT NULL,
	"verdict" "verdict" NOT NULL,
	"confidence" smallint NOT NULL,
	"layers" jsonb NOT NULL,
	"research_cutoff" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_proofs_confidence" CHECK ("proofs"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"publisher" text,
	"source_type" "source_type" DEFAULT 'OTHER' NOT NULL,
	"health" "source_health" DEFAULT 'UNKNOWN' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_url_hash_unique" UNIQUE("url_hash")
);
--> statement-breakpoint
CREATE TABLE "product_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_aliases" ADD CONSTRAINT "project_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_patterns" ADD CONSTRAINT "research_patterns_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_quota_reservations" ADD CONSTRAINT "demo_quota_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_quota_reservations" ADD CONSTRAINT "demo_quota_reservations_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_job_transitions" ADD CONSTRAINT "research_job_transitions_job_id_research_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD CONSTRAINT "research_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD CONSTRAINT "research_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD CONSTRAINT "research_jobs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_proof_id_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."proofs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_gaps" ADD CONSTRAINT "proof_gaps_proof_id_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."proofs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscriptions_one_entitling" ON "subscriptions" USING btree ("user_id") WHERE "subscriptions"."status" IN ('ACTIVE', 'CANCEL_AT_PERIOD_END');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_identities_provider" ON "user_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_aliases_alias_lower" ON "project_aliases" USING btree (lower("alias"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_patterns_topic_version" ON "research_patterns" USING btree ("topic_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_patterns_one_active" ON "research_patterns" USING btree ("topic_id") WHERE "research_patterns"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_demo_quota_reservations_job" ON "demo_quota_reservations" USING btree ("research_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_jobs_idempotency" ON "research_jobs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_jobs_active_task" ON "research_jobs" USING btree ("user_id","normalized_task_hash") WHERE state IN ('QUEUED', 'RUNNING', 'AWAITING_CLARIFICATION');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_jobs_one_active" ON "research_jobs" USING btree ("user_id") WHERE state IN ('QUEUED', 'RUNNING', 'AWAITING_CLARIFICATION');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proofs_research_job" ON "proofs" USING btree ("research_job_id");