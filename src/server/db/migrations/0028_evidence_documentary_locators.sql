-- ONE-TO-MANY DOCUMENTARY LOCATORS.
--
-- evidence.documentary_locator holds one value. A single admitted
-- documentary fact can legitimately identify more than one concrete
-- on-chain account — a page listing two burn addresses under one heading
-- states one fact about two accounts — and the scalar silently discarded
-- the second.
--
-- ADDITIVE AND NON-DESTRUCTIVE. No evidence row is deleted, no historical
-- provenance is rewritten, and the scalar column stays exactly where it
-- is. It becomes a COMPATIBILITY PROJECTION of ordinal 0 rather than a
-- separate truth, so every existing reader and every historical row keeps
-- working unchanged.
CREATE TYPE "public"."evidence_locator_shape" AS ENUM('ADDRESS_LIKE', 'SIGNATURE_LIKE');--> statement-breakpoint

CREATE TABLE "evidence_documentary_locators" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "evidence_id" uuid NOT NULL,
  "ordinal" smallint NOT NULL,
  "value" text NOT NULL,
  "shape" "public"."evidence_locator_shape" NOT NULL,
  "literally_present" boolean NOT NULL,
  "validation_result" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Shape backstop: a truncated or malformed identifier is unrepresentable
  -- at rest, even if a future writer bypasses the validator.
  CONSTRAINT "ck_evidence_locators_complete"
    CHECK ("value" ~ '^[1-9A-HJ-NP-Za-km-z]{32,88}$'),
  -- Validation backstop: only a row the deterministic validator confirmed
  -- can exist. An "unchecked locator" has no representation.
  CONSTRAINT "ck_evidence_locators_validated"
    CHECK ("literally_present" = true AND "validation_result" = 'CONFIRMED')
);--> statement-breakpoint

ALTER TABLE "evidence_documentary_locators"
  ADD CONSTRAINT "evidence_documentary_locators_evidence_id_fk"
  FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "ix_evidence_locators_evidence" ON "evidence_documentary_locators" ("evidence_id");--> statement-breakpoint
-- Targeting ONE specific admitted locator is the on-chain provenance
-- gate's whole question, so the value is indexed on its own.
CREATE INDEX "ix_evidence_locators_value" ON "evidence_documentary_locators" ("value");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evidence_locators_value" ON "evidence_documentary_locators" ("evidence_id", "value");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evidence_locators_ordinal" ON "evidence_documentary_locators" ("evidence_id", "ordinal");--> statement-breakpoint

-- BACKFILL. Every existing scalar locator becomes ordinal 0 of its fact,
-- so historical rows are queryable through the same relationship as new
-- ones and the gate needs no second code path. Purely additive: the source
-- column is read, never modified. The shape is derived from length alone —
-- the same deterministic rule the validator applies, not a new judgement.
INSERT INTO "evidence_documentary_locators"
  ("evidence_id", "ordinal", "value", "shape", "literally_present", "validation_result")
SELECT
  "id",
  0,
  "documentary_locator",
  CASE WHEN length("documentary_locator") >= 64 THEN 'SIGNATURE_LIKE'::"public"."evidence_locator_shape"
       ELSE 'ADDRESS_LIKE'::"public"."evidence_locator_shape" END,
  true,
  'CONFIRMED'
FROM "evidence"
WHERE "documentary_locator" IS NOT NULL;
