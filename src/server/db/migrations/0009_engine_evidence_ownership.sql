CREATE TYPE "public"."evidence_directness" AS ENUM('DIRECT', 'INDIRECT', 'INFERRED');--> statement-breakpoint
CREATE TYPE "public"."evidence_officiality" AS ENUM('CONFIRMED', 'CLAIMED');--> statement-breakpoint
CREATE TYPE "public"."evidence_source_class" AS ENUM('ONCHAIN_VERIFIABLE', 'OFFICIAL_DOCS', 'GOVERNANCE', 'OFFICIAL_REPORT', 'DATA_PROVIDER', 'RESEARCH_MEDIA', 'SOCIAL');--> statement-breakpoint
CREATE TYPE "public"."research_attempt_status" AS ENUM('STARTED', 'SUCCEEDED', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "research_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"pattern_step" smallint NOT NULL,
	"component" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" "research_attempt_status" DEFAULT 'STARTED' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint

-- D-088 (phase-6-plan.md §6.3): Evidence обязан существовать ДО Proof.
-- evidence.proof_id -> nullable; evidence.research_job_id добавляется и
-- становится NOT NULL, но ТОЛЬКО после полного backfill — старый FK на
-- proof_id снят первым, чтобы ALTER COLUMN ... DROP NOT NULL прошёл.
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_proof_id_proofs_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "proof_id" DROP NOT NULL;--> statement-breakpoint

-- research_job_id добавляется NULLABLE намеренно (не NOT NULL сразу) —
-- backfill ниже целится в уже существующие строки прежде, чем инвариант
-- зафиксирован. У всех строк, созданных до этой миграции, proof_id был
-- NOT NULL, а proofs.research_job_id — тоже NOT NULL (Фаза 1), поэтому
-- backfill детерминирован и полон (§6.3 item 3).
ALTER TABLE "evidence" ADD COLUMN "research_job_id" uuid;--> statement-breakpoint
UPDATE "evidence" e SET "research_job_id" = p."research_job_id"
  FROM "proofs" p WHERE p."id" = e."proof_id";--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "research_job_id" SET NOT NULL;--> statement-breakpoint

-- Остальные добавления §6.2 — NULLABLE (Phase 6 S0-S3 review fix package):
-- эти пять колонок не могут быть детерминированно восстановлены для
-- строк Evidence, созданных ДО этой миграции (Phase 1-5) — обратно
-- совместимая ступенчатая схема вместо придуманного значения по
-- умолчанию или требования "таблица evidence пуста". Каждая строка,
-- записанная production-кодом Фазы 6, всегда заполняет их — nullable
-- ослабляет только тип колонки на уровне БД, не инвариант записи.
ALTER TABLE "evidence" ADD COLUMN "pattern_step" smallint;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "component" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "directness" "evidence_directness";--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "mechanism_state" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "value_source" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "source_class" "evidence_source_class";--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "officiality" "evidence_officiality";--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "claim_key" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "title" text;--> statement-breakpoint

ALTER TABLE "research_attempts" ADD CONSTRAINT "research_attempts_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_attempts_job_step_component_attempt" ON "research_attempts" USING btree ("research_job_id","pattern_step","component","attempt_number");--> statement-breakpoint
CREATE INDEX "ix_research_attempts_job" ON "research_attempts" USING btree ("research_job_id");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_evidence_job" ON "evidence" USING btree ("research_job_id");--> statement-breakpoint
CREATE INDEX "ix_evidence_job_step_component" ON "evidence" USING btree ("research_job_id","pattern_step","component");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proofs_id_job" ON "proofs" USING btree ("id","research_job_id");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "ck_evidence_pattern_step" CHECK ("evidence"."pattern_step" BETWEEN 1 AND 8);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "ck_evidence_provenance_nonempty" CHECK (length("evidence"."retrieved_url") > 0 AND length("evidence"."content_hash") > 0);--> statement-breakpoint

-- D-088 §6.3a: составной FK — единственная защита, реально запрещающая
-- привязку Evidence к Proof ЧУЖОГО job'а. MATCH SIMPLE (постгресовый
-- дефолт) не проверяет ограничение при proof_id IS NULL — ровно то, что
-- нужно состоянию JOB_ONLY; при заполненном proof_id физически
-- невозможно указать Proof с другим research_job_id, потому что
-- uq_proofs_id_job гарантирует, что пара (id, research_job_id) в proofs
-- единственна и совпадает только с СОБСТВЕННЫМ job'ом Proof'а.
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_proof_same_job_fk"
  FOREIGN KEY ("proof_id", "research_job_id")
  REFERENCES "public"."proofs" ("id", "research_job_id") ON DELETE CASCADE;
