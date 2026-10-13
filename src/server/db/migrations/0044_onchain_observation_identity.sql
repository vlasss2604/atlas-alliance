-- AN OBSERVATION IS NOT THE SAME THING AS ITS NORMALIZED VALUE.
--
-- Identity was the content address alone, which silently collapsed two
-- genuinely different chain observations whenever they reported equal
-- values:
--
--   slot 100: supply 1,000
--   slot 200: supply 1,000        <- dropped, as if it never happened
--
-- "Supply did not move between these two positions" is a finding, and the
-- record could not hold it. The defect is NOT specific to supply:
-- artifact_hash is sha256 of the NORMALIZED RESULT, and for the four intent
-- kinds whose slot arrives in the RPC context rather than in the result body
-- — TOKEN_SUPPLY, ACCOUNT_INFO, TOKEN_ACCOUNT_BALANCE and
-- TOKEN_ACCOUNTS_BY_OWNER — an unchanged reading at a later slot hashes
-- identically. SIGNATURES_FOR_ADDRESS and TRANSACTION_DETAIL carry their slot
-- inside the result and were never affected.
--
-- Identity is therefore WHAT CAME BACK plus WHERE ON THE CHAIN it was read:
-- (artifact_hash, slot), scoped by origin mode. artifact_hash keeps its
-- existing and separate meaning and is not redefined to smuggle position
-- into it. An exact retry stays idempotent — the same reading at the same
-- slot is the same observation however many times it is fetched, which is
-- why retrieved_at is deliberately NOT part of identity.
--
-- RECOVERED as canonical 0044. The original draft of this migration carried
-- a journal timestamp below the applied watermark; a fresh timestamp is used
-- so the migrator cannot silently skip it. Historical ledger rows are left
-- exactly as they are.
DROP INDEX IF EXISTS "uq_onchain_artifacts_job_artifact";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_onchain_artifacts_standalone_hash";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onchain_artifacts_job_observation" ON "onchain_artifacts" ("research_job_id","artifact_hash","slot");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_onchain_artifacts_standalone_observation" ON "onchain_artifacts" ("artifact_hash","slot") WHERE "research_job_id" IS NULL;
