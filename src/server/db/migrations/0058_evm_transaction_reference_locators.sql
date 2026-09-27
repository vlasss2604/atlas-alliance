-- EVM TRANSACTION-HASH ADMISSION RELIABILITY (Founder-approved).
--
-- 1. One trace reason: a proposed EVM 0x+64-hex locator whose every known
--    occurrence is deterministically NOT a transaction reference (a
--    Snapshot-style /proposal/ path, a Safe internal multisig identifier or
--    /multisig-transactions/ path, or an exact known non-transaction
--    constant) is refused and traced under its own code.
-- 2. One ordering flag: a locator the document also presented in an
--    explicit transaction path (/tx/<hash>) is admitted first, so it cannot
--    be crowded out of the unchanged per-job cap. It admits nothing and
--    refuses nothing.
--
-- Forward only. Existing rows are not rewritten: the new column reads false
-- for them through its default.
ALTER TYPE "public"."trace_reason_code" ADD VALUE IF NOT EXISTS 'LOCATOR_NOT_TRANSACTION_REFERENCE';--> statement-breakpoint
ALTER TABLE "evidence_documentary_locators" ADD COLUMN IF NOT EXISTS "transaction_structured" boolean DEFAULT false NOT NULL;
