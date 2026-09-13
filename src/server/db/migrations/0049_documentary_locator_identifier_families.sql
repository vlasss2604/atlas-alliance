-- DOCUMENTARY LOCATOR SHAPE BACKSTOP — ONE RULE PER IDENTIFIER FAMILY.
--
-- THE DEFECT THIS CLOSES. The deterministic documentary-locator validator
-- became environment-aware with the evidence-environment seam: for a
-- project whose confirmed identity is on an EVM chain it admits the EVM
-- identifier family (0x + 40 hex address, 0x + 64 hex transaction hash),
-- exactly as it always admitted base58 for Solana. The two CHECK backstops
-- written before that seam (0027 on evidence.documentary_locator, 0028 on
-- evidence_documentary_locators.value) still stated ONE family, base58.
-- The first normal live Research of an Ethereum project therefore crashed
-- at the Evidence insert: the application said "this document states the
-- project's own contract address" and the database said "not an
-- identifier". A backstop that contradicts the validator it backs is not
-- a backstop; it is a second, stale validator.
--
-- THE RULE IS THE APPLICATION'S RULE, RESTATED. domain/identifier-shape.ts
-- is the one place a family's alphabet and lengths are stated:
--   base58 address      32-44 chars of the base58 alphabet (no 0, O, I, l)
--   base58 signature    64-88 chars of the same alphabet
--   EVM address         0x + 40 hex, either case (EIP-55 or lowercase are
--                       two spellings of one address; a shape check
--                       recognises, it does not canonicalise)
--   EVM transaction     0x + 64 hex, either case
-- A POSITIVE UNION of exactly those four shapes, nothing wider: not "any
-- 0x-prefixed string", not "any hex". Base58 is tightened from the old
-- 32-88 span to the two ranges the validator actually admits (a
-- 45-63-character base58 string was never a valid locator and was never
-- written); every existing row satisfies the new rule, and the migration
-- rewrites none.
--
-- STILL A SHAPE, NEVER AUTHORITY OR ATTRIBUTION. Passing says a stored
-- value is a structurally complete identifier of a supported family. Which
-- chain it belongs to is the project's confirmed identity's statement;
-- whether it is the project's own is entity binding's; nothing here
-- changes either. No chain-specific branching exists anywhere in Research
-- logic because of this: the union is one regular expression.
ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "ck_evidence_documentary_locator_complete";--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "ck_evidence_documentary_locator_complete"
  CHECK (
    "documentary_locator" IS NULL
    OR "documentary_locator" ~ '^([1-9A-HJ-NP-Za-km-z]{32,44}|[1-9A-HJ-NP-Za-km-z]{64,88}|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$'
  );--> statement-breakpoint
ALTER TABLE "evidence_documentary_locators" DROP CONSTRAINT IF EXISTS "ck_evidence_locators_complete";--> statement-breakpoint
ALTER TABLE "evidence_documentary_locators" ADD CONSTRAINT "ck_evidence_locators_complete"
  CHECK (
    "value" ~ '^([1-9A-HJ-NP-Za-km-z]{32,44}|[1-9A-HJ-NP-Za-km-z]{64,88}|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$'
  );
