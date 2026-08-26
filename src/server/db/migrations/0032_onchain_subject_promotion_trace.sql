-- BOUNDED ON-CHAIN SUBJECT PROMOTION — trace vocabulary.
--
-- Structured acquisition can now derive a NEW research subject from a
-- confirmed observation: a documented account leads to the token accounts
-- it owns, a token account to one bounded signature window, one observed
-- signature to one transaction. Each of those is a decision the engine
-- made on its own, and a decision nobody can see is a decision nobody can
-- audit — so every promotion, refusal, budget stop and depth stop gets a
-- row.
--
-- TRACE != EVIDENCE, unchanged. These rows record what S4 DID, never what
-- is true about the project. A SUBJECT_PROMOTED row is not a claim that
-- the promoted account means anything.
--
-- Additive only: no existing value is renamed or removed, and every
-- historical row keeps its meaning.
ALTER TYPE "public"."trace_operation_type" ADD VALUE 'SUBJECT_PROMOTED';--> statement-breakpoint
ALTER TYPE "public"."trace_operation_type" ADD VALUE 'SUBJECT_PROMOTION_REJECTED';--> statement-breakpoint
ALTER TYPE "public"."trace_operation_type" ADD VALUE 'SUBJECT_PROMOTION_BUDGET_EXHAUSTED';--> statement-breakpoint
ALTER TYPE "public"."trace_operation_type" ADD VALUE 'SUBJECT_PROMOTION_DEPTH_LIMIT';--> statement-breakpoint
ALTER TYPE "public"."trace_operation_type" ADD VALUE 'SUBJECT_PROMOTION_TERMINAL';--> statement-breakpoint

-- Why a promotion did not happen. Closed vocabulary, same discipline as
-- every other reason code: never a raw provider string.
ALTER TYPE "public"."trace_reason_code" ADD VALUE 'PROMOTION_DEPTH_LIMIT';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE 'PROMOTION_NO_ELIGIBLE_SUBJECT';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE 'PROMOTION_BINDING_NOT_CONFIRMED';--> statement-breakpoint
ALTER TYPE "public"."trace_reason_code" ADD VALUE 'PROMOTION_INTENT_CAP_REACHED';--> statement-breakpoint
-- The observation was of a kind that promotes nothing further. Not a
-- failure: a transaction detail is where a chain is SUPPOSED to end.
ALTER TYPE "public"."trace_reason_code" ADD VALUE 'PROMOTION_TERMINAL_OBSERVATION';
