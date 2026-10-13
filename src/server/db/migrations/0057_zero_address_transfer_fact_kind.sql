-- EVM V1 (Founder-approved): ONE NEW DETERMINISTIC FACT KIND.
--
-- A successful ERC-20 Transfer of the confirmed project token to
-- 0x0000000000000000000000000000000000000000, read from a transaction
-- receipt. It is NOT a burn and NOT mechanism execution: it establishes no
-- component, and at NET_EFFECT it only anchors a measured supply interval.
--
-- Forward only. Adds one enum value; no existing row is read, rewritten or
-- deleted.
ALTER TYPE "public"."onchain_fact_kind" ADD VALUE IF NOT EXISTS 'ZERO_ADDRESS_TRANSFER';
