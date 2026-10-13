ALTER TABLE "research_attempts" ADD COLUMN "search_queries_spent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_attempts" ADD COLUMN "source_opens_spent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_attempts" ADD COLUMN "model_cost_micro_spent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "ck_evidence_contract_version_known" CHECK ("evidence"."evidence_contract_version" IN (1, 2));