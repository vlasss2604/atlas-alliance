-- QUESTION-DRIVEN PROOF PROJECTION — a derived PRESENTATION artifact.
--
-- Owner decision: a question's result should be shaped by the question,
-- not by the Pattern. The Pattern still drives research; this table stores
-- which parts of a completed, canonical research result are relevant to
-- the question a person actually asked, in what order, under what wording.
--
-- ITS OWN TABLE, DELIBERATELY.
--
-- Not a column on `proofs`: the Proof is the canonical research answer,
-- and folding a model's relevance judgment into it would make that
-- judgment part of canonical truth — the second truth layer this design
-- exists to prevent.
--
-- Not one of the engine-owned derived tables (research_component_results,
-- research_mechanism_assembly, research_claim_support) either. Each of
-- those carries a replay contract: delete the rows, re-run from the same
-- inputs, reproduce the same result. A projection involves a model call
-- and cannot honour that contract, so it must not share a home with
-- artifacts whose auditability depends on it.
--
-- WHAT `findings` MAY CONTAIN.
--
-- References and labels only. Each finding names a canonical object that
-- already carries a status — a component result key, or an S7 requirement
-- id — plus a short user-facing label. No status, no fact, no evidence id
-- and no reason code is stored here, because none of those may originate
-- from a model. Status, explanation and evidence are resolved at render
-- time from the canonical row a reference points at, which is what makes
-- this artifact structurally incapable of contradicting research.
--
-- ONE ROW PER (job, projection_version).
--
-- That unique index is the structural guarantee behind "one model call per
-- Proof". A terminal failure occupies the slot exactly as a success does,
-- so a failed projection is never retried by a page load. Regeneration is
-- authorised only by bumping projection_version, which is a code change.
--
-- Additive only: one enum type, one table. No existing table, column or
-- row changes meaning, and nothing is backfilled.
CREATE TYPE "public"."question_projection_status" AS ENUM('VALID', 'FAILED_VALIDATION', 'FAILED_MODEL');--> statement-breakpoint
CREATE TABLE "research_question_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_job_id" uuid NOT NULL,
	"projection_version" integer NOT NULL,
	"pattern_version" integer NOT NULL,
	"status" "question_projection_status" NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_question_projections" ADD CONSTRAINT "research_question_projections_research_job_id_research_jobs_id_fk" FOREIGN KEY ("research_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_question_projections_job_version" ON "research_question_projections" USING btree ("research_job_id","projection_version");--> statement-breakpoint
CREATE INDEX "ix_research_question_projections_job" ON "research_question_projections" USING btree ("research_job_id");
