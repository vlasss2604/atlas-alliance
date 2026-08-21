import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { loadProductConfig } from "../config/product";
import { researchJobs, researchPatterns, researchPlans, memoryRetrievals } from "../db/schema";
import { patternContentSchema, type PatternContent } from "../domain/pattern";
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

async function loadActivePattern(
  db: Database | Transaction,
  topicId: string,
): Promise<PatternContent> {
  const [row] = await db
    .select()
    .from(researchPatterns)
    .where(eq(researchPatterns.topicId, topicId));
  if (!row) throw new Error(`no research_patterns row for topic ${topicId}`);
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
  const pattern = await loadActivePattern(db, job.topicId);
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
        claimKey: h.claimKey,
        matchedVia: h.matchedVia,
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
