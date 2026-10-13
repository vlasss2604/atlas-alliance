-- EXACT DOCUMENTARY LOCATOR.
--
-- The complete on-chain identifier a documentary fact identifies, when the
-- document states one in full. Written ONLY by the deterministic validator
-- in documentary-locator.ts: a truncated display form ("99mRw3...pm4F3c"),
-- an incomplete shape, or a value absent from the document text all leave
-- this NULL. NULL is the ordinary case — most evidence names no account.
--
-- Separate from entity_binding (D-134): this records WHICH identifier the
-- document states, never that the identifier belongs to the project. The
-- CHECK below is a shape backstop only, not authority: it makes a
-- truncated or malformed value unrepresentable at rest even if some future
-- writer bypasses the validator.
ALTER TABLE "evidence" ADD COLUMN "documentary_locator" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "ck_evidence_documentary_locator_complete"
  CHECK ("documentary_locator" IS NULL OR "documentary_locator" ~ '^[1-9A-HJ-NP-Za-km-z]{32,88}$');
--> statement-breakpoint
-- Trace vocabulary for a REFUSED locator. The fact is still admitted; only
-- the locator is dropped, and a rejection that leaves no trace is a
-- rejection nobody can audit. Three distinct reasons, because "the page
-- only ever showed an abbreviation" and "the model proposed something the
-- document does not contain" are very different findings.
ALTER TYPE "public"."trace_operation_type" ADD VALUE IF NOT EXISTS 'LOCATOR_REJECTED';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE IF NOT EXISTS 'LOCATOR_TRUNCATED';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE IF NOT EXISTS 'LOCATOR_INCOMPLETE';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE IF NOT EXISTS 'LOCATOR_NOT_IN_DOCUMENT';
