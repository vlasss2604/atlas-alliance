-- ROUND 3.5 — FOUNDER-APPROVED SEMANTICS (H9).
--
-- VERIFIED IS TERMINAL. Verification is a historical audit event.
--    Once a Proof is VERIFIED its verification_status never moves back to
--    REVIEWED or DRAFT: a later problem produces a NEW Proof from a new
--    Research, never a rewrite of history. DRAFT <-> REVIEWED stay as they
--    were. Same discipline as every other lifecycle graph in this schema
--    (0001, 0007): the constraint lives in the database, not in code
--    discipline, so direct SQL is held to it as well. VERIFIED -> VERIFIED
--    (a repeated verification) is not a transition and passes.
CREATE OR REPLACE FUNCTION proof_verification_status_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.verification_status = NEW.verification_status THEN
    RETURN NEW;
  END IF;
  IF OLD.verification_status = 'VERIFIED' THEN
    RAISE EXCEPTION 'forbidden proof verification regression: VERIFIED -> % (verification is a historical audit event)', NEW.verification_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_proofs_verification_status_guard
  BEFORE UPDATE OF verification_status ON proofs
  FOR EACH ROW EXECUTE FUNCTION proof_verification_status_guard();
