-- B2d2 — TOTAL_SUPPLY_DELTA, AND THE TWO OBSERVATIONS THAT ESTABLISH IT.
--
-- THE PROBLEM THIS SOLVES.
--
-- Every deterministic on-chain fact so far comes from exactly ONE artifact,
-- and `evidence.onchain_artifact_id` says so: many facts may reference one
-- artifact, never the reverse. A total-supply DELTA breaks that shape. It is
-- established by two readings — a historical t0 and a current t1 — plus
-- arithmetic, and by neither one alone.
--
-- Every way of forcing it into the singular column lies. Pointing at t1
-- asserts that one observation established a fact two established; pointing
-- at t0 does the same and additionally names an artifact belonging to a
-- DIFFERENT research job than the evidence row; hiding the other endpoint in
-- `fragment` makes prose the only structured record of provenance, which no
-- audit could honestly read back.
--
-- WHAT THIS ADDS.
--
-- One enum value and one child table. The child table is the establishing
-- arithmetic INPUTS of a derived fact — exactly two of them, FROM and TO —
-- and deliberately nothing else. It is not a general "supporting artifacts"
-- table: a burn whose slot happens to fall inside the interval is NOT an
-- input to the arithmetic (the delta is true from t0 and t1 alone), and a
-- table named for support would eventually invite it in. Whether a burn lies
-- inside a delta's interval is a separate, later, deterministic question over
-- two independent Evidence rows.
--
-- `evidence.onchain_artifact_id` stays NULL for a delta row, on purpose. The
-- legacy singular pointer means "the one artifact this fact was derived
-- from", and for a two-endpoint fact there is no honest value. Mirroring t1
-- into it for convenience would make the canonical relation state something
-- false; the two readers of that column in the engine both require it to be
-- non-null and both are scoped to single-artifact fact kinds, so NULL is
-- read as absence exactly as it is for every documentary row.
--
-- Additive only: one enum value, one new table. No existing table, column or
-- row changes meaning, nothing is backfilled, nothing is deleted or merged,
-- and no historical row becomes invalid.

-- The typed kind. Its semantic ceiling is stated in code beside the other
-- kinds (ONCHAIN_DOES_NOT_PROVE): total supply changed by deltaRaw between
-- two observed slots. Not deflation, not a mechanism, not circulating supply.
-- Adding the value grants NOTHING: applicability
-- (APPLICABLE_COMPONENTS_BY_KIND) is unchanged and still holds exactly
-- BURN -> NET_EFFECT.
ALTER TYPE "public"."onchain_fact_kind" ADD VALUE 'TOTAL_SUPPLY_DELTA';--> statement-breakpoint

CREATE TABLE "evidence_onchain_artifact_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The derived fact these are the inputs of. CASCADE, matching
  -- evidence_documentary_locators: an input has no meaning without the fact
  -- it established, and it is not independent evidence.
  "evidence_id" uuid NOT NULL,
  -- Position, so "the first input" is a stable concept rather than whatever
  -- the heap returns. Pinned to the role by the CHECK below, which is what
  -- makes the pair structurally exactly two.
  "ordinal" smallint NOT NULL,
  -- Which side of the interval this observation is. Text with a CHECK rather
  -- than a second enum type: the same choice research_memory.mechanism_state
  -- and onchain_derived_subjects.binding_status already make for a closed
  -- two-value vocabulary that no other table shares.
  "input_role" text NOT NULL,
  "onchain_artifact_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Exactly two roles, exactly one ordinal each. A third input, a second
  -- FROM, or an input at an arbitrary position is unrepresentable rather
  -- than merely unexpected.
  CONSTRAINT "ck_evidence_onchain_inputs_role" CHECK (
    ("ordinal" = 0 AND "input_role" = 'FROM') OR ("ordinal" = 1 AND "input_role" = 'TO')
  )
);--> statement-breakpoint

ALTER TABLE "evidence_onchain_artifact_inputs"
  ADD CONSTRAINT "evidence_onchain_artifact_inputs_evidence_id_fk"
  FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade;--> statement-breakpoint

-- RESTRICT, deliberately unlike evidence.onchain_artifact_id's SET NULL.
-- A delta whose endpoint observation has been removed is not a weaker fact
-- that should quietly lose a pointer — it is a fact that is no longer
-- established, and the database refuses the deletion rather than leaving an
-- arithmetic claim standing on an input nobody can re-verify.
ALTER TABLE "evidence_onchain_artifact_inputs"
  ADD CONSTRAINT "evidence_onchain_artifact_inputs_artifact_id_fk"
  FOREIGN KEY ("onchain_artifact_id") REFERENCES "public"."onchain_artifacts"("id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "uq_evidence_onchain_inputs_role" ON "evidence_onchain_artifact_inputs" ("evidence_id", "input_role");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evidence_onchain_inputs_ordinal" ON "evidence_onchain_artifact_inputs" ("evidence_id", "ordinal");--> statement-breakpoint
CREATE INDEX "ix_evidence_onchain_inputs_evidence" ON "evidence_onchain_artifact_inputs" ("evidence_id");--> statement-breakpoint
-- So a future audit can ask the question from either end: which delta rests
-- on this observation, as well as which observations this delta rests on.
CREATE INDEX "ix_evidence_onchain_inputs_artifact" ON "evidence_onchain_artifact_inputs" ("onchain_artifact_id");
