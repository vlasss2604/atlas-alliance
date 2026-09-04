-- STANDALONE STRUCTURED OBSERVATIONS.
--
-- onchain_artifacts.research_job_id and .source_id were NOT NULL, so
-- persisting one deterministic chain read required inventing a user, a
-- research job and a source row. Those rows asserted something false —
-- that a research job occurred and that a document was fetched — purely to
-- satisfy foreign keys. Provenance that has to lie to be stored is not
-- provenance.
--
-- TWO EXPLICIT MODES, never blurred:
--
--   RESEARCH_JOB                        the artifact belongs to a real job
--                                       and its canonical-URI source row.
--                                       Unchanged in every respect.
--
--   STANDALONE_STRUCTURED_OBSERVATION   a deterministic chain read that
--                                       stands on its own. No job, no
--                                       source, and NOT because they are
--                                       optional — because they are
--                                       forbidden in this mode.
--
-- The CHECK makes every invalid combination unrepresentable rather than
-- merely discouraged: a standalone row carrying a job id, or a job row
-- missing one, cannot exist.
--
-- WHY A STANDALONE ARTIFACT STILL CANNOT BECOME EVIDENCE: evidence.source_id
-- is NOT NULL, and a standalone artifact has no source row to reference.
-- The impossibility is structural, not a rule someone must remember.
CREATE TYPE "public"."onchain_artifact_origin" AS ENUM('RESEARCH_JOB', 'STANDALONE_STRUCTURED_OBSERVATION');--> statement-breakpoint

-- Defaulting to RESEARCH_JOB is the fail-closed choice: a writer that
-- omits the mode gets the one that REQUIRES a job and a source, so an
-- omission fails loudly instead of silently creating an unattached row.
ALTER TABLE "onchain_artifacts"
  ADD COLUMN "origin_kind" "public"."onchain_artifact_origin" DEFAULT 'RESEARCH_JOB' NOT NULL;--> statement-breakpoint

ALTER TABLE "onchain_artifacts" ALTER COLUMN "research_job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "onchain_artifacts" ALTER COLUMN "source_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "onchain_artifacts" ADD CONSTRAINT "ck_onchain_artifacts_origin" CHECK (
  ("origin_kind" = 'RESEARCH_JOB'
     AND "research_job_id" IS NOT NULL
     AND "source_id" IS NOT NULL)
  OR
  ("origin_kind" = 'STANDALONE_STRUCTURED_OBSERVATION'
     AND "research_job_id" IS NULL
     AND "source_id" IS NULL)
);--> statement-breakpoint

-- ABSENCE OF A JOB IS NEVER ABSENCE OF PROVENANCE. Every field needed to
-- re-verify the observation is required of EVERY artifact, in both modes —
-- this is not a standalone-only rule, it is what an artifact has always
-- had to carry, now stated as an invariant instead of a convention.
ALTER TABLE "onchain_artifacts" ADD CONSTRAINT "ck_onchain_artifacts_provenance_complete" CHECK (
  length("canonical_uri") > 0
  AND length("chain") > 0
  AND length("network") > 0
  AND length("project_anchor") > 0
  AND length("subject") > 0
  AND length("subject_kind") > 0
  AND length("intent_kind") > 0
  AND length("retrieval_method") > 0
  AND length("provider_id") > 0
  AND length("provider_method") > 0
  AND length("finality") > 0
  AND length("raw_response_hash") > 0
  AND length("artifact_hash") > 0
  AND "slot" >= 0
);--> statement-breakpoint

-- Idempotent replay for standalone rows. The existing unique index is
-- (research_job_id, artifact_hash), and Postgres treats NULLs as distinct,
-- so it constrains nothing once the job id is NULL. Content-addressing the
-- standalone rows keeps a re-observation of identical content a no-op
-- rather than a duplicate.
CREATE UNIQUE INDEX "uq_onchain_artifacts_standalone_hash"
  ON "onchain_artifacts" ("artifact_hash")
  WHERE "research_job_id" IS NULL;
