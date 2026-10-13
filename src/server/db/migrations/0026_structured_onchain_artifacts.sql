-- Structured on-chain retrieval V1 (owner-approved, AMENDMENT B).
--
-- One retrieval artifact is stored ONCE and may back MANY deterministic
-- evidence facts. Provenance is owned by the artifact, not copied onto
-- each fact, and not attached to `sources` (which is a globally shared
-- row keyed by url_hash, while every retrieval is a distinct
-- point-in-time observation with its own slot and response hash).
--
--   sources -> onchain_artifacts -> evidence.onchain_artifact_id
--
-- Existing Evidence semantics are untouched: the only change to `evidence`
-- is one NULLABLE column, read by no existing constraint.
CREATE TABLE "onchain_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "research_job_id" uuid NOT NULL REFERENCES "research_jobs"("id") ON DELETE cascade,
  "source_id" uuid NOT NULL REFERENCES "sources"("id") ON DELETE restrict,
  "canonical_uri" text NOT NULL,
  "chain" text NOT NULL,
  "network" text NOT NULL,
  "project_anchor" text NOT NULL,
  "subject_kind" text NOT NULL,
  "subject" text NOT NULL,
  "intent_kind" text NOT NULL,
  "slot" bigint NOT NULL,
  "block_time" timestamp with time zone,
  "block_hash" text,
  "finality" text NOT NULL,
  "transaction_signature" text,
  "retrieval_method" text NOT NULL,
  "provider_id" text NOT NULL,
  "provider_method" text NOT NULL,
  "request_params" jsonb NOT NULL,
  "retrieved_at" timestamp with time zone NOT NULL,
  "raw_response_hash" text NOT NULL,
  "artifact_hash" text NOT NULL,
  "normalized_result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "ix_onchain_artifacts_job" ON "onchain_artifacts" ("research_job_id");--> statement-breakpoint
CREATE INDEX "ix_onchain_artifacts_uri" ON "onchain_artifacts" ("canonical_uri");--> statement-breakpoint
-- Replaying the identical observation inside one job is a no-op, not a
-- duplicate row (same discipline as evidence.extraction_unit_key).
CREATE UNIQUE INDEX "uq_onchain_artifacts_job_artifact" ON "onchain_artifacts" ("research_job_id","artifact_hash");--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "onchain_artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "fk_evidence_onchain_artifact"
  FOREIGN KEY ("onchain_artifact_id") REFERENCES "onchain_artifacts"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "ix_evidence_onchain_artifact" ON "evidence" ("onchain_artifact_id");
