-- DERIVED ON-CHAIN SUBJECTS.
--
-- A token account discovered by getTokenAccountsByOwner is NOT documentary
-- evidence: no page states it, and it must never be reclassified as a
-- documentary locator. But it is not arbitrary either — its identity was
-- deterministically bound by a confirmed structured read: parsed owner ==
-- the documented wallet, parsed mint == the confirmed project mint, program
-- owner == an SPL Token program.
--
-- This table records exactly that, and nothing more: TECHNICAL PROVENANCE
-- answering one question — "why is this exact subject eligible for the next
-- structured read?" It confers no documentary authority, no source class,
-- no officiality, and no economic role. A row here says a chain query
-- returned this account under checks that held; it says nothing about what
-- the account is FOR.
--
-- The lineage stays explicit and re-checkable:
--   PROJECT_IDENTITY -> documentary wallet locator -> confirmed artifact
--   -> derived subject
-- parent_subject and onchain_artifact_id are the two links, and both are
-- re-validated at read time rather than trusted because a row exists.
CREATE TYPE "public"."onchain_derived_subject_kind" AS ENUM('TOKEN_ACCOUNT');--> statement-breakpoint
-- Closed allowlist. A derivation method is a reviewed code change, never a
-- runtime value: adding one means adding an enum member AND an entry in the
-- code-owned allowlist the gate reads.
CREATE TYPE "public"."onchain_derivation_method" AS ENUM('TOKEN_ACCOUNTS_BY_OWNER');--> statement-breakpoint

CREATE TABLE "onchain_derived_subjects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The structured retrieval this subject came out of. CASCADE because a
  -- derived subject has no meaning without the observation that produced
  -- it — it is not an independent record.
  "onchain_artifact_id" uuid NOT NULL,
  "chain" text NOT NULL,
  "network" text NOT NULL,
  "project_anchor" text NOT NULL,
  "subject" text NOT NULL,
  "subject_kind" "public"."onchain_derived_subject_kind" NOT NULL,
  -- The subject whose query returned this one — the documented wallet.
  "parent_subject" text NOT NULL,
  "derivation_method" "public"."onchain_derivation_method" NOT NULL,
  "binding_status" text NOT NULL,
  "observed_slot" bigint NOT NULL,
  "retrieved_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Only a CONFIRMED binding may be represented. An "unverified derived
  -- subject" is not a weaker row, it is not a row at all.
  CONSTRAINT "ck_onchain_derived_binding" CHECK ("binding_status" = 'CONFIRMED'),
  -- Shape backstops. Every address is a complete base58 identifier.
  CONSTRAINT "ck_onchain_derived_subject_shape"
    CHECK ("subject" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT "ck_onchain_derived_parent_shape"
    CHECK ("parent_subject" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT "ck_onchain_derived_anchor_shape"
    CHECK ("project_anchor" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- A subject derived from itself would be a lineage loop, not a lineage.
  CONSTRAINT "ck_onchain_derived_not_self" CHECK ("subject" <> "parent_subject")
);--> statement-breakpoint

ALTER TABLE "onchain_derived_subjects"
  ADD CONSTRAINT "onchain_derived_subjects_artifact_id_fk"
  FOREIGN KEY ("onchain_artifact_id") REFERENCES "public"."onchain_artifacts"("id") ON DELETE cascade;--> statement-breakpoint

-- Equality lookup is the gate's whole question, so the subject is indexed
-- on its own and again scoped by anchor. There is no substring path.
CREATE INDEX "ix_onchain_derived_subject" ON "onchain_derived_subjects" ("subject");--> statement-breakpoint
CREATE INDEX "ix_onchain_derived_anchor_subject" ON "onchain_derived_subjects" ("project_anchor", "subject");--> statement-breakpoint
CREATE INDEX "ix_onchain_derived_parent" ON "onchain_derived_subjects" ("parent_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_onchain_derived_artifact_subject" ON "onchain_derived_subjects" ("onchain_artifact_id", "subject");
