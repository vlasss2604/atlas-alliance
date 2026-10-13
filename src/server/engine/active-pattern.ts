import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchPatterns } from "../db/schema";

// Shared home for the ACTIVE-Pattern-required error — both run-job.ts
// (S4's own gate, pre-dating S5) and component-reconciliation-store.ts
// (HIGH-4, deep audit) need to fail the exact same way when a topic has
// no confirmed ACTIVE Pattern, or when a job's frozen contract version
// disagrees with the topic's current ACTIVE version. Defined here rather
// than in either caller to avoid a run-job.ts <-> component-
// reconciliation-store.ts import cycle (run-job.ts calls the store after
// HIGH-1's production wiring fix).
export class MissingActivePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingActivePatternError";
  }
}

// Phase 6, S4 — Phase-6-safe ACTIVE-only Pattern version lookup
// (phase-6-plan.md §19 S4, final S0-S3 review note on frozen Phase 5
// LOW-2).
//
// This is the ONE place the ACTIVE predicate lives. It was written when
// Phase 5's plan-time read did NOT filter on status='ACTIVE' (the LOW-2
// debt), so S4's correctness would not depend on that deferred fix.
//
// That debt is now paid: plan-job.ts resolves the version through THIS
// function and then reads its content keyed by that version, exactly as
// S5, S6 and S7 do. Every planning-time and run-time Pattern read now
// shares this one ACTIVE boundary — no caller carries a second notion of
// which Pattern is active.
//
// research_patterns has a partial unique index enforcing at most one
// ACTIVE row per topic (uq_research_patterns_one_active), so "the active
// version" is well-defined whenever one exists.
export async function loadActivePatternVersion(
  db: Database | Transaction,
  topicId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ version: researchPatterns.version })
    .from(researchPatterns)
    .where(and(eq(researchPatterns.topicId, topicId), eq(researchPatterns.status, "ACTIVE")));
  return row?.version ?? null;
}
