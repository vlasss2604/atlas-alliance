-- RESEARCH MEMORY -> EVIDENCE ADOPTION V1 — THE REUSE POINTER.
--
-- THE DEFECT THIS CLOSES. When the planner closed a component from ACTIVE
-- Research Memory, the component left the work queue and NOTHING took its
-- place: no Evidence row of the current job, no S5 result, and so the
-- mechanism assembly reported MISSING_COMPONENT for the very component the
-- memory had "satisfied" (mechanism-assembler.ts treats an absent result
-- exactly like INSUFFICIENT_EVIDENCE). Reuse made the Proof worse.
--
-- The adoption path (engine/memory-evidence-adoption.ts) now materializes
-- one ordinary current-job Evidence row per reused memory observation and
-- runs the ordinary S5 reducer over it. This column is the durable, explicit
-- pointer from that adopted row back to the exact research_memory row it
-- came from, so a later reader can walk
--   current Evidence -> memory row -> research_memory_provenance
--   -> original source / origin Evidence
-- without guessing from text.
--
-- NULLABLE, ADDITIVE, NEVER REWRITTEN. Every existing row keeps NULL, which
-- reads as "freshly acquired". ON DELETE SET NULL: the pointer is
-- provenance, not a dependency — a memory row's own lifecycle is never
-- blocked by an Evidence row that once cited it (research_memory rows are
-- deprecated, not deleted, so this branch is defensive).
--
-- ONE ADOPTED ROW PER (job, memory row), enforced here and not only by the
-- adoption code's deterministic extraction_unit_key: a redelivered phase or
-- a second run of the same job cannot adopt the same observation twice.
ALTER TABLE "evidence" ADD COLUMN "reused_from_memory_id" uuid REFERENCES "research_memory"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "ix_evidence_reused_from_memory" ON "evidence" ("reused_from_memory_id") WHERE "reused_from_memory_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evidence_reused_memory_per_job" ON "evidence" ("research_job_id", "reused_from_memory_id") WHERE "reused_from_memory_id" IS NOT NULL;
