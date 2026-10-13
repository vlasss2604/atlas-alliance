-- FULL RESEARCH AUDIT PROJECTION — a derived PRESENTATION artifact.
--
-- Owner decision: the normal Result answers "what is the answer to my
-- question?". The Full Research Audit answers a different question — "can
-- I professionally inspect how ATLAS arrived at it?" — and must therefore
-- expose the COMPLETE relevant record rather than a question-shaped subset
-- of it.
--
-- WHAT THIS TABLE DOES AND DOES NOT HOLD.
--
-- It holds an ORDER, short human LABELS for canonical component references,
-- and two or three sentences of connective copy. That is all a model is
-- permitted to contribute. Every fact the audit shows — statuses, counts,
-- reason codes, evidence links, exclusion reasons, source classes,
-- retrieval times — is assembled at render time from the canonical rows,
-- so a failed or stale audit projection costs the audit its arrangement
-- and none of its substance.
--
-- Completeness is guaranteed by code, not by the model: a section that
-- canonical research gave content to renders whether or not the model
-- ordered it. This is the opposite of the question projection, where
-- omission is the point.
--
-- ITS OWN TABLE, DELIBERATELY.
--
-- Not a column on `proofs`, and not inside research_claim_support or
-- research_component_results. Those are engine-owned and carry a replay
-- contract — delete the rows, re-run from the same inputs, reproduce the
-- same result. Anything involving a model call cannot honour that
-- contract, so it must not share a home with artifacts whose auditability
-- depends on it.
--
-- Not merged into research_question_projections either, despite the shape
-- being similar. The lifecycles differ: a question projection is generated
-- once for every Proof, while an audit is generated ONLY if a human ever
-- opens one. Most Proofs will never have a row here.
--
-- ONE ROW PER (job, audit_version).
--
-- That unique index is what makes "at most one audit model call per job"
-- structural. A terminal failure occupies the slot exactly as a success
-- does, so re-opening a failed audit reads the persisted failure instead
-- of burning another call. Regeneration is authorised only by bumping
-- audit_version, which is a deliberate code change.
--
-- Additive only: one enum type, one table. No existing table, column or
-- row changes meaning, and nothing is backfilled.
CREATE TYPE "public"."audit_projection_status" AS ENUM('VALID', 'FAILED_VALIDATION', 'FAILED_MODEL');--> statement-breakpoint
CREATE TABLE "research_audit_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"audit_version" integer NOT NULL,
	"status" "audit_projection_status" NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_audit_projections" ADD CONSTRAINT "research_audit_projections_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_audit_projections_job_version" ON "research_audit_projections" USING btree ("research_job_id","audit_version");--> statement-breakpoint
CREATE INDEX "ix_research_audit_projections_job" ON "research_audit_projections" USING btree ("research_job_id");
