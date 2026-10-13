-- R-2 (Phase 6 S0-S3 final review): a compatibility discriminator
-- separating legacy Phase 1-5 Evidence (backfilled by 0009, where
-- pattern_step/component/directness/source_class/officiality are
-- honestly NULL) from Evidence written under the Phase 6 contract, where
-- those five fields are structurally required. This is NOT a new
-- research/product semantic state (no new verdict, memory state, or
-- Evidence sufficiency state) — it exists purely to stop a NEW row from
-- silently claiming the legacy exemption.
--
-- Sequencing matters: the column is added NULLABLE first, every row that
-- already exists at this point in the migration (there is no other kind,
-- since no production code writes Evidence before Phase 6 S4 — see
-- phase-6-plan.md §0.2, already relied on by 0009's own backfill) is
-- backfilled to version 1, and ONLY THEN does the column become
-- NOT NULL DEFAULT 2 and the completeness CHECK gets installed. Doing
-- this in the other order (NOT NULL DEFAULT 2 from the start) would
-- backfill every legacy row to version 2 via the column default and the
-- new CHECK would immediately reject the very rows it exists to exempt.
ALTER TABLE "evidence" ADD COLUMN "evidence_contract_version" smallint;--> statement-breakpoint
UPDATE "evidence" SET "evidence_contract_version" = 1;--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "evidence_contract_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "evidence_contract_version" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "evidence" ADD CONSTRAINT "ck_evidence_contract_v2_complete" CHECK ("evidence"."evidence_contract_version" <> 2 OR (
        "evidence"."pattern_step" IS NOT NULL
        AND "evidence"."component" IS NOT NULL
        AND "evidence"."directness" IS NOT NULL
        AND "evidence"."source_class" IS NOT NULL
        AND "evidence"."officiality" IS NOT NULL
      ));--> statement-breakpoint

-- Anti-bypass: the CHECK above only enforces completeness FOR version-2
-- rows — nothing stops a new INSERT from simply declaring itself version
-- 1 (exempting itself from the classification requirement) or an
-- existing version-2 row from being silently downgraded to 1 later.
-- Both must be DB-enforced, not left to application/Zod discipline.
-- Installed AFTER the legacy backfill above, so it never blocks that
-- one-time, migration-owned UPDATE.
CREATE OR REPLACE FUNCTION evidence_contract_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.evidence_contract_version <> 2 THEN
      RAISE EXCEPTION 'evidence_contract_version_guard: new Evidence rows must be contract version 2, got %', NEW.evidence_contract_version;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.evidence_contract_version = 2 AND NEW.evidence_contract_version <> 2 THEN
      RAISE EXCEPTION 'evidence_contract_version_guard: cannot downgrade Evidence from contract version 2 to %', NEW.evidence_contract_version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER evidence_contract_version_guard
  BEFORE INSERT OR UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION evidence_contract_version_guard();
