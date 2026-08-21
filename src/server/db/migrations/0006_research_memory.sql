-- pg_trgm доступен в установке (phase-5-plan.md §3.4, §6), но не обязательно
-- включён как расширение в этой БД. Нужен до создания trgm-индекса ниже.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."freshness_class" AS ENUM('LOW_CHANGE', 'MEDIUM_CHANGE', 'HIGH_CHANGE');--> statement-breakpoint
CREATE TYPE "public"."memory_health" AS ENUM('OK', 'QUESTIONABLE', 'REVERIFY', 'STALE', 'DEPRECATED');--> statement-breakpoint
CREATE TYPE "public"."memory_lifecycle_state" AS ENUM('OBSERVED', 'CANDIDATE', 'ACTIVE', 'DEPRECATED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."project_memory_kind" AS ENUM('SOURCE_ROUTE', 'USEFUL_QUERY', 'FAILED_QUERY', 'DEAD_END', 'TERMINOLOGY', 'METRIC_SEMANTICS', 'FRESHNESS_NOTE', 'CAVEAT');--> statement-breakpoint
CREATE TYPE "public"."proof_verification_status" AS ENUM('DRAFT', 'REVIEWED', 'VERIFIED');--> statement-breakpoint
CREATE TABLE "memory_retrievals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"query_keys" jsonb NOT NULL,
	"hits" jsonb NOT NULL,
	"retrieved_count" integer NOT NULL,
	"applied_count" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "project_memory_kind" NOT NULL,
	"content" jsonb NOT NULL,
	"source_id" uuid,
	"lifecycle_state" "memory_lifecycle_state" DEFAULT 'OBSERVED' NOT NULL,
	"health" "memory_health" DEFAULT 'OK' NOT NULL,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"pattern_step" smallint NOT NULL,
	"claim_key" text NOT NULL,
	"statement" text NOT NULL,
	"mechanism_state" text,
	"freshness_class" "freshness_class" NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"data_as_of" timestamp with time zone,
	"stale_after" interval,
	"confidence" smallint NOT NULL,
	"lifecycle_state" "memory_lifecycle_state" DEFAULT 'OBSERVED' NOT NULL,
	"health" "memory_health" DEFAULT 'OK' NOT NULL,
	"superseded_by" uuid,
	"promoted_by" uuid,
	"promoted_at" timestamp with time zone,
	"origin_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_research_memory_pattern_step" CHECK ("research_memory"."pattern_step" BETWEEN 1 AND 8),
	CONSTRAINT "ck_research_memory_confidence" CHECK ("research_memory"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "research_memory_provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"retrieved_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"fragment" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone,
	"data_as_of" timestamp with time zone,
	"origin_evidence_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"mode" "research_capability" NOT NULL,
	"contract" jsonb NOT NULL,
	"memory_used" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "ck_evidence_freshness_class";--> statement-breakpoint
-- D-044: словарь LOW/MEDIUM/HIGH_CHANGE -> LOW_CHANGE/MEDIUM_CHANGE/
-- HIGH_CHANGE. Таблица пуста сегодня (phase-5-plan.md §5.3), но CASE
-- вместо голого ::freshness_class документирует правило приведения на
-- случай, если этот путь когда-нибудь встретит данные.
ALTER TABLE "evidence" ALTER COLUMN "freshness_class" SET DATA TYPE "public"."freshness_class" USING (
	CASE "freshness_class"
		WHEN 'LOW' THEN 'LOW_CHANGE'
		WHEN 'MEDIUM' THEN 'MEDIUM_CHANGE'
		WHEN 'HIGH_CHANGE' THEN 'HIGH_CHANGE'
		ELSE NULL
	END
)::"public"."freshness_class";--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "verification_status" "proof_verification_status" DEFAULT 'DRAFT' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_plan_id_research_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."research_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memory_items" ADD CONSTRAINT "project_memory_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memory_items" ADD CONSTRAINT "project_memory_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memory_items" ADD CONSTRAINT "project_memory_items_superseded_by_project_memory_items_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."project_memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_memory" ADD CONSTRAINT "research_memory_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_memory" ADD CONSTRAINT "research_memory_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_memory" ADD CONSTRAINT "research_memory_superseded_by_research_memory_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."research_memory"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_memory" ADD CONSTRAINT "research_memory_promoted_by_users_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_memory_provenance" ADD CONSTRAINT "research_memory_provenance_memory_id_research_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."research_memory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_memory_provenance" ADD CONSTRAINT "research_memory_provenance_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_plans" ADD CONSTRAINT "research_plans_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_memory_retrievals_job" ON "memory_retrievals" USING btree ("research_job_id");--> statement-breakpoint
CREATE INDEX "ix_project_memory_items_project_kind" ON "project_memory_items" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "ix_project_memory_items_active" ON "project_memory_items" USING btree ("project_id") WHERE "project_memory_items"."lifecycle_state" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "ix_research_memory_project_topic_step" ON "research_memory" USING btree ("project_id","topic_id","pattern_step");--> statement-breakpoint
CREATE INDEX "ix_research_memory_claim_key" ON "research_memory" USING btree ("claim_key");--> statement-breakpoint
CREATE INDEX "ix_research_memory_active_project_step" ON "research_memory" USING btree ("project_id","pattern_step") WHERE "research_memory"."lifecycle_state" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "ix_research_memory_statement_fts" ON "research_memory" USING gin (to_tsvector('simple', "statement"));--> statement-breakpoint
CREATE INDEX "ix_research_memory_statement_trgm" ON "research_memory" USING gin ("statement" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_research_memory_provenance_memory" ON "research_memory_provenance" USING btree ("memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_plans_job_version" ON "research_plans" USING btree ("research_job_id","version");--> statement-breakpoint
CREATE INDEX "ix_interpretations_research_job" ON "interpretations" USING btree ("research_job_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_proof" ON "evidence" USING btree ("proof_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_source" ON "evidence" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ix_proof_gaps_proof" ON "proof_gaps" USING btree ("proof_id");--> statement-breakpoint
CREATE INDEX "ix_proofs_project_topic" ON "proofs" USING btree ("project_id","topic_id");--> statement-breakpoint
CREATE INDEX "ix_proofs_owner" ON "proofs" USING btree ("owner_user_id");