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
// Phase 5's loadActivePattern() (src/server/memory/plan-job.ts) does NOT
// filter on status='ACTIVE' — a known, explicitly-deferred Phase 5 debt
// item (LOW-2). It is FROZEN: S4 must not silently change it. This is a
// separate, additive function for the one thing S4 actually needs —
// resolving activePatternVersion to feed buildContractView()'s explicit
// cross-check — and it filters on status='ACTIVE' itself, so S4's own
// correctness does not depend on Phase 5's deferred fix. It does not
// call, wrap, or modify loadActivePattern() in any way.
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
