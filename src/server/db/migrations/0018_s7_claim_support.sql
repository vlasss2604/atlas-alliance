CREATE TABLE "research_claim_support" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"pattern_version" integer NOT NULL,
	"requirement_set_version" integer NOT NULL,
	"intent" text NOT NULL,
	"status" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"requirement_results" jsonb NOT NULL,
	"context_gaps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_claim_support" ADD CONSTRAINT "research_claim_support_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_claim_support_job_pattern_reqset" ON "research_claim_support" USING btree ("research_job_id","pattern_version","requirement_set_version");--> statement-breakpoint
CREATE INDEX "ix_research_claim_support_job" ON "research_claim_support" USING btree ("research_job_id");