ALTER TABLE "research_jobs" ADD COLUMN "search_queries_reserved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD COLUMN "source_opens_reserved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD COLUMN "model_cost_micro_reserved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- MEDIUM-3 (S4 review fix): the normal migration/update path itself
-- deterministically populates the two S4 model-role config keys
-- (query_proposer_model, evidence_extractor_model) with their approved
-- defaults — not left to a separate, easy-to-forget `db:seed` run. An
-- existing Phase 1-5 database that only ever runs migrations (never
-- re-seeds) still ends up with a valid product_config row for these keys,
-- so loadProductConfig() never fails an unrelated API route for their
-- absence. ON CONFLICT DO NOTHING: an owner-customized value already
-- present is never overwritten.
INSERT INTO "product_config" ("key", "value") VALUES
  ('query_proposer_model', '"claude-haiku-4-5"'::jsonb),
  ('evidence_extractor_model', '"claude-haiku-4-5"'::jsonb)
ON CONFLICT ("key") DO NOTHING;