-- OBSERVED TRANSACTION SIGNATURES.
--
-- A signature returned by getSignaturesForAddress is not a documentary
-- locator: no document states it, and calling it one would let an RPC
-- result inherit a project's own authority. It is also not arbitrary — a
-- confirmed structured read returned it for a subject that itself had
-- provenance. So it gets its own record, exactly like a derived subject
-- does, and for the same reason.
--
-- The question a row here answers, and the only one:
--   "why is this exact transaction signature eligible for getTransaction?"
--
-- It confers no execution semantics whatsoever. A signature being listed
-- for an address does not say what the transaction did, which tokens moved,
-- in which direction, or whether any burn occurred. `err` is the RPC's own
-- metadata and nothing more, and `memo` is SELECTION metadata — arbitrary
-- text written by whoever signed the transaction, useful for choosing what
-- to read, never proof of what executed.
--
-- Lineage, re-checked at read time rather than trusted because a row exists:
--   PROJECT_IDENTITY -> documentary wallet -> TOKEN_ACCOUNTS_BY_OWNER
--   artifact -> derived token account -> SIGNATURES_FOR_ADDRESS artifact
--   -> this signature
CREATE TABLE "onchain_observed_signatures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The retrieval that returned it. CASCADE because an observed signature
  -- has no meaning without the observation that produced it.
  "onchain_artifact_id" uuid NOT NULL,
  "chain" text NOT NULL,
  "network" text NOT NULL,
  "project_anchor" text NOT NULL,
  -- The address whose signatures were requested — a documentary locator or
  -- a derived on-chain subject, whichever the gate admitted at the time.
  "parent_subject" text NOT NULL,
  "signature" text NOT NULL,
  "slot" bigint NOT NULL,
  "block_time" timestamp with time zone,
  -- The RPC's own error flag. NOT a claim about what the transaction did.
  "err" boolean NOT NULL,
  -- Selection metadata only. Bounded upstream; nullable because most
  -- transactions carry none.
  "memo" text,
  "binding_status" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Only a CONFIRMED binding may be represented.
  CONSTRAINT "ck_onchain_observed_sig_binding" CHECK ("binding_status" = 'CONFIRMED'),
  -- A complete base58 signature. A truncated display form is
  -- unrepresentable at rest, the same discipline documentary locators use.
  CONSTRAINT "ck_onchain_observed_sig_shape"
    CHECK ("signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  CONSTRAINT "ck_onchain_observed_sig_parent_shape"
    CHECK ("parent_subject" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT "ck_onchain_observed_sig_anchor_shape"
    CHECK ("project_anchor" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);--> statement-breakpoint

ALTER TABLE "onchain_observed_signatures"
  ADD CONSTRAINT "onchain_observed_signatures_artifact_id_fk"
  FOREIGN KEY ("onchain_artifact_id") REFERENCES "public"."onchain_artifacts"("id") ON DELETE cascade;--> statement-breakpoint

-- Equality lookup is the gate's whole question. Indexed on the signature
-- alone and again scoped by anchor; there is no substring path.
CREATE INDEX "ix_onchain_observed_sig_signature" ON "onchain_observed_signatures" ("signature");--> statement-breakpoint
CREATE INDEX "ix_onchain_observed_sig_anchor" ON "onchain_observed_signatures" ("project_anchor", "signature");--> statement-breakpoint
CREATE INDEX "ix_onchain_observed_sig_parent" ON "onchain_observed_signatures" ("parent_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_onchain_observed_sig_artifact_signature"
  ON "onchain_observed_signatures" ("onchain_artifact_id", "signature");
