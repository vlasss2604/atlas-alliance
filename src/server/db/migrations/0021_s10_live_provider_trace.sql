ALTER TYPE "public"."trace_operation_type" ADD VALUE 'MODEL_CALL_SKIPPED';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE 'MODEL_INPUT_OVERSIZED';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE 'TOKEN_COUNT_UNAVAILABLE';--> statement-breakpoint
ALTER TABLE "research_trace_events" ADD COLUMN "actual_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "research_trace_events" ADD COLUMN "actual_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "research_trace_events" ADD COLUMN "actual_cost_micro" integer;--> statement-breakpoint

-- S10 (live-provider-enablement.md §10) — internal-alpha gate, same
-- deterministic-seed-on-migration discipline as migration 0012's
-- query_proposer_model/evidence_extractor_model rows: an existing
-- database that only ever runs migrations (never re-seeds) still ends up
-- with a valid product_config row for this key. Defaults to false —
-- research_enabled stays the primary product gate; this is a SEPARATE,
-- additional gate the live S10 executor construction requires (§10).
-- ON CONFLICT DO NOTHING: an owner-customized value is never overwritten.
INSERT INTO "product_config" ("key", "value") VALUES
  ('internal_alpha_enabled', 'false'::jsonb)
ON CONFLICT ("key") DO NOTHING;