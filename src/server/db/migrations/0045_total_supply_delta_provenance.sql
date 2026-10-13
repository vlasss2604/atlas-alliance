-- TWO-ENDPOINT PROVENANCE FOR A DERIVED INTERVAL FACT.
--
-- Every other on-chain fact points at ONE artifact via
-- evidence.onchain_artifact_id. A TOTAL_SUPPLY_DELTA inverts that: it is
-- established by a historical reading, a current reading and arithmetic, and
-- by neither reading alone — so the singular pointer has no honest value and
-- stays NULL for such a row.
--
-- ESTABLISHING INPUTS ONLY. These are the operands: FROM is t0, TO is t1,
-- and the delta is true from those two alone. A burn whose slot lies inside
-- the interval is NOT here — it did not establish the number, it only makes
-- the interval interesting.
--
-- The pair is structurally exactly two: the CHECK pins ordinal 0 to FROM and
-- ordinal 1 to TO, and the two unique indexes forbid a second of either. A
-- three-input derivation is unrepresentable, not merely unexpected.
--
-- RECOVERED as canonical 0045 with a fresh journal timestamp, above the
-- applied watermark. Historical ledger rows are left exactly as they are.
ALTER TYPE "public"."onchain_fact_kind" ADD VALUE IF NOT EXISTS 'TOTAL_SUPPLY_DELTA';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_onchain_artifact_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- CASCADE, matching evidence_documentary_locators: an input has no meaning
  -- without the fact it established, and it is not independent evidence.
  "evidence_id" uuid NOT NULL,
  -- Position, so "the first input" is a stable concept rather than whatever
  -- the heap returns. Pinned to the role by the CHECK below.
  "ordinal" smallint NOT NULL,
  -- Which side of the interval this observation is. Text with a CHECK rather
  -- than a second enum type, matching the choice research_memory.mechanism_state
  -- and onchain_derived_subjects.binding_status already make.
  "input_role" text NOT NULL,
  "onchain_artifact_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Exactly two roles, exactly one ordinal each. A third input, a second
  -- FROM, or an input at an arbitrary position is unrepresentable.
  CONSTRAINT "ck_evidence_onchain_inputs_role" CHECK (
    ("ordinal" = 0 AND "input_role" = 'FROM') OR ("ordinal" = 1 AND "input_role" = 'TO')
  )
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "evidence_onchain_artifact_inputs"
    ADD CONSTRAINT "evidence_onchain_artifact_inputs_evidence_id_fk"
    FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  -- RESTRICT, deliberately unlike evidence.onchain_artifact_id's SET NULL: a
  -- delta whose endpoint observation was removed is not a fact that should
  -- quietly lose a pointer, it is a fact that is no longer established.
  ALTER TABLE "evidence_onchain_artifact_inputs"
    ADD CONSTRAINT "evidence_onchain_artifact_inputs_artifact_id_fk"
    FOREIGN KEY ("onchain_artifact_id") REFERENCES "public"."onchain_artifacts"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_evidence_onchain_inputs_role" ON "evidence_onchain_artifact_inputs" ("evidence_id", "input_role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_evidence_onchain_inputs_ordinal" ON "evidence_onchain_artifact_inputs" ("evidence_id", "ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_evidence_onchain_inputs_evidence" ON "evidence_onchain_artifact_inputs" ("evidence_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_evidence_onchain_inputs_artifact" ON "evidence_onchain_artifact_inputs" ("onchain_artifact_id");
