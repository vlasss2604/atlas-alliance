CREATE TYPE "public"."component_reconciliation_status" AS ENUM('SUPPORTED', 'PARTIALLY_SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE');--> statement-breakpoint
CREATE TABLE "research_component_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"pattern_step" smallint NOT NULL,
	"component" text NOT NULL,
	"status" "component_reconciliation_status" NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supporting_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradicting_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_state" text,
	"temporal_basis_field" text,
	"temporal_basis_at" timestamp with time zone,
	"token_state_mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_fresh_evidence" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_component_results" ADD CONSTRAINT "research_component_results_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_component_results_job_step_component" ON "research_component_results" USING btree ("research_job_id","pattern_step","component");--> statement-breakpoint
CREATE INDEX "ix_research_component_results_job" ON "research_component_results" USING btree ("research_job_id");