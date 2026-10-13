import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { loadProductConfig } from "../config/product";
import { researchJobs, researchPatterns, researchPlans, memoryRetrievals } from "../db/schema";
import { patternContentSchema, type PatternContent } from "../domain/pattern";
import { loadActivePatternVersion, MissingActivePatternError } from "../engine/active-pattern";
import { planResearch, type PlanResult } from "./planner";
import { resolveMemoryRetrievalGateway } from "./retrieval-gateway";
import { parseContract } from "./contract";

// Стадия 2 из пяти LOCKED §9 («Проверяю накопленный опыт») — встраивается
// в worker.ts, не в HTTP-путь startResearch (phase-5-plan.md §1.4).
// Retrieval → детерминированный планировщик → запись плана + retrieval —
// одна транзакция: план без сырья ретрива непроверяем, а ретрив без плана
// бесполезен.

export interface MemoryPlanningResult {
  planId: string;
  mode: PlanResult["mode"];
  memoryUsed: boolean;
  memoryStatus: "NOT_USED" | "USED" | "USED_AND_REVERIFIED";
}

// PLAN-TIME PATTERN READ — ONE ACTIVE ROW, CONTENT AND VERSION TOGETHER.
//
// THE LATENT TRAP THIS CLOSES (the RC-1 class, second site). This read
// used to select by topic alone: no status filter, no ORDER BY. On a topic
// carrying a RETIRED v1 beside an ACTIVE v2 it returned whichever row the
// heap happened to yield first, so planning could take its `steps` and
// `requiredComponents` from a RETIRED Pattern while freezing the ACTIVE
// version number into the contract — two different Patterns for one job,
// with nothing anywhere to notice. It was inert only while every version
// carried identical steps; the first semantic version that changes either
// field turns it into planning against the wrong Pattern, silently.
//
// Selecting BY the already-resolved ACTIVE version is the same two-step
// S5, S6 and S7 already use (component-reconciliation-store.ts,
// mechanism-assembly-store.ts, claim-support-store.ts): resolve the ACTIVE
// version through the canonical resolver, then read the row keyed by it.
// Content and version therefore always come from ONE row, and that row is
// always the ACTIVE one — DRAFT and RETIRED can satisfy neither.
async function loadActivePatternContent(
  db: Database | Transaction,
  topicId: string,
  version: number,
): Promise<PatternContent> {
  const [row] = await db
    .select()
    .from(researchPatterns)
    .where(and(eq(researchPatterns.topicId, topicId), eq(researchPatterns.version, version)));
  if (!row) {
    throw new Error(
      `ACTIVE research_patterns row for topic ${topicId} version ${version} vanished between lookup and read`,
    );
  }
  // zod-контракт на content (§5.2) — искажённый Pattern не должен молча
  // пройти в планировщик.
  return patternContentSchema.parse(row.content);
}

export async function runMemoryPlanningStage(
  db: Database,
  jobId: string,
): Promise<MemoryPlanningResult> {
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  if (!job.projectId) throw new Error(`research job has no projectId: ${jobId}`);

  const config = await loadProductConfig(db);
  // FREEZE WHAT IS ACTIVE, NOT A LITERAL, AND READ THE SAME ROW. The
  // canonical ACTIVE resolver S4-S7 use decides the version; the content
  // is then read keyed by that version, so plan time and run time cannot
  // disagree about which Pattern this job belongs to, and the content can
  // never come from a DRAFT or RETIRED row.
  const patternVersion = await loadActivePatternVersion(db, job.topicId);
  if (patternVersion === null) {
    throw new MissingActivePatternError(
      `no ACTIVE research_patterns row for topic ${job.topicId} — refusing to plan without a confirmed active Pattern version`,
    );
  }
  const pattern = await loadActivePatternContent(db, job.topicId, patternVersion);
  const statementQuery = (job.normalizedTask as { task?: string } | null)?.task;

  const startedAt = Date.now();
  const gateway = resolveMemoryRetrievalGateway();
  const hits = config.memory_enabled
    ? await gateway.retrieve(
        db,
        { projectId: job.projectId, topicId: job.topicId, statementQuery },
        { topKPerStep: config.memory_retrieval_top_k },
      )
    : [];
  const durationMs = Date.now() - startedAt;

  const result = planResearch({
    memoryEnabled: config.memory_enabled,
    hits,
    pattern,
    patternVersion,
    capabilityAtStart: job.capabilityAtStart,
    budgetAtStart: job.budgetAtStart as never,
    config,
    now: new Date(),
  });
  // Контракт проходит через ту же строгую схему, что читает планировщик —
  // JSON, записанный в jsonb, обязан остаться валидным при чтении назад.
  const validatedContract = parseContract(result.contract);

  const memoryStatus: MemoryPlanningResult["memoryStatus"] = !result.memoryUsed
    ? "NOT_USED"
    : result.contract.requiredFreshEvidence.length > 0
      ? "USED_AND_REVERIFIED"
      : "USED";

  return db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(researchPlans)
      .values({
        researchJobId: jobId,
        version: 1,
        mode: result.mode,
        contract: validatedContract,
        memoryUsed: result.memoryUsed,
      })
      .returning({ id: researchPlans.id });

    await tx.insert(memoryRetrievals).values({
      researchJobId: jobId,
      planId: plan.id,
      queryKeys: { projectId: job.projectId, topicId: job.topicId, statementQuery: statementQuery ?? null },
      hits: hits.map((h) => ({
        memoryId: h.memoryId,
        step: h.patternStep,
        component: h.component,
        claimKey: h.claimKey,
        matchedVia: h.matchedVia,
        health: h.health,
        confidence: h.confidence,
      })),
      retrievedCount: hits.length,
      appliedCount: validatedContract.reusableEvidence.length,
      durationMs,
    });

    await tx
      .update(researchJobs)
      .set({ memoryStatus, progressStage: 2 })
      .where(eq(researchJobs.id, jobId));

    return { planId: plan.id, mode: result.mode, memoryUsed: result.memoryUsed, memoryStatus };
  });
}
