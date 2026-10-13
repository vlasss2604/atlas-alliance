-- PRE-ROUND-5 FOUNDER DECISION — VERIFICATION AUDIT METADATA.
--
-- VERIFIED is a terminal historical audit event (0052), so the event
-- itself is recorded on the row: WHO verified (the ADMIN actor the
-- canonical act already requires, D-055) and WHEN. The same shape
-- research_memory already carries for promotion (promoted_by /
-- promoted_at, 0006/0008), and the same database rule (D-065): the
-- transition into VERIFIED must name an actor who is ADMIN at that
-- moment. Written once, on the transition; a repeated verification
-- changes nothing (verification.ts). Nothing downstream reads these
-- columns: verdict, confidence, Evidence admissibility, Memory
-- eligibility and every reducer are untouched.
--
-- NULLABLE, ADDITIVE, NEVER BACKFILLED. A Proof verified before this
-- migration carries NULL in both: the event happened, its actor and
-- time were never persisted, and inventing them would be a false audit.
ALTER TABLE "proofs" ADD COLUMN "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "proofs" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint

CREATE OR REPLACE FUNCTION proof_verification_status_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.verification_status = NEW.verification_status THEN
    RETURN NEW;
  END IF;
  IF OLD.verification_status = 'VERIFIED' THEN
    RAISE EXCEPTION 'forbidden proof verification regression: VERIFIED -> % (verification is a historical audit event)', NEW.verification_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.verification_status = 'VERIFIED' THEN
    IF NEW.verified_by IS NULL OR NEW.verified_at IS NULL THEN
      RAISE EXCEPTION 'verification requires verified_by and verified_at (historical audit event, D-055)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.verified_by AND u.role = 'ADMIN') THEN
      RAISE EXCEPTION 'verification must be sanctioned by an ADMIN actor (D-055/D-065), verified_by=%', NEW.verified_by
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
