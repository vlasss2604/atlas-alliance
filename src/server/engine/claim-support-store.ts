import { and, desc, eq, ne } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { interpretations, researchClaimSupport, researchJobs, researchMechanismAssembly, researchPatterns, researchPlans } from "../db/schema";
import { INTENT_REQUIREMENTS_VERSION, patternContentSchema } from "../domain/pattern";
import { parseContract } from "../memory/contract";
import { loadActivePatternVersion, MissingActivePatternError } from "./active-pattern";
import { evaluateClaimSupport, ClaimEvaluationInvariantError, type ClaimSupportResult } from "./claim-evaluator";
import type { MechanismAssemblyResult } from "./mechanism-assembler";

// Phase 6, S7 (phase-6-s7-plan.md §24, D-111) — the only DB-touching
// module for claim support: loads exactly what evaluateClaimSupport()
// (pure, DB-free) needs, then upserts its result. Same separation S5/S6
// already established.

async function loadActivePatternContentForJob(db: Database | Transaction, jobId: string) {
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  if (!job.topicId) throw new Error(`research job ${jobId} has no topicId`);

  const activeVersion = await loadActivePatternVersion(db, job.topicId);
  if (activeVersion === null) {
    throw new MissingActivePatternError(
      `no ACTIVE research_patterns row for topic ${job.topicId} — refusing to evaluate claim support without a confirmed active Pattern version`,
    );
  }

  const [planRow] = await db
    .select()
    .from(researchPlans)
    .where(eq(researchPlans.researchJobId, jobId))
    .orderBy(desc(researchPlans.version))
    .limit(1);
  if (!planRow) {
    throw new MissingActivePatternError(
      `no research_plans row for job ${jobId} — refusing to evaluate claim support without the frozen contract's patternVersion to cross-check`,
    );
  }
  const contract = parseContract(planRow.contract);
  if (contract.patternVersion !== activeVersion) {
    throw new MissingActivePatternError(
      `job ${jobId}'s frozen contract.patternVersion=${contract.patternVersion} does not match topic ${job.topicId}'s ` +
        `current ACTIVE Pattern version=${activeVersion} — refusing to evaluate against a Pattern the job was not planned under`,
    );
  }

  const [pattern] = await db
    .select()
    .from(researchPatterns)
    .where(and(eq(researchPatterns.topicId, job.topicId), eq(researchPatterns.version, activeVersion)));
  if (!pattern) {
    throw new Error(`ACTIVE research_patterns row for topic ${job.topicId} version ${activeVersion} vanished between lookup and read`);
  }
  return { content: patternContentSchema.parse(pattern.content), version: activeVersion };
}

// §0.1/§6 — normalized_intent and task_type are the ONLY machine-readable
// axes read from the interpretation; research_task free text is never
// selected here at all (no column for it in this query), which is what
// makes the "S7 never reads free text" invariant structural rather than
// a promise (§27, §2 absolute free-text boundary).
async function loadIntentAndTaskType(db: Database | Transaction, jobId: string): Promise<{ intent: string; taskType: string | null }> {
  const [row] = await db
    .select({ result: interpretations.result })
    .from(interpretations)
    .where(eq(interpretations.researchJobId, jobId))
    .orderBy(desc(interpretations.createdAt))
    .limit(1);
  if (!row || !row.result || typeof row.result !== "object") {
    // No interpretation row, or a row without a structured result, is
    // treated the same as normalized_intent=UNKNOWN (§6) — a defensive,
    // non-failure default; not a system configuration error.
    return { intent: "UNKNOWN", taskType: null };
  }
  const result = row.result as { normalized_intent?: unknown; task_type?: unknown };
  const intent = typeof result.normalized_intent === "string" ? result.normalized_intent : "UNKNOWN";
  const taskType = typeof result.task_type === "string" ? result.task_type : null;
  return { intent, taskType };
}

async function loadMechanismAssembly(db: Database | Transaction, jobId: string, patternVersion: number): Promise<MechanismAssemblyResult | null> {
  const [row] = await db
    .select()
    .from(researchMechanismAssembly)
    .where(and(eq(researchMechanismAssembly.researchJobId, jobId), eq(researchMechanismAssembly.patternVersion, patternVersion)));
  if (!row) return null;
  return {
    researchJobId: row.researchJobId,
    patternVersion: row.patternVersion,
    flows: row.flows,
    unassignedGaps: row.unassignedGaps,
  };
}

async function persistClaimSupport(
  db: Database | Transaction,
  jobId: string,
  patternVersion: number,
  requirementSetVersion: number,
  result: ClaimSupportResult,
  now: Date,
): Promise<void> {
  // Derived projection: a stale row from a different requirement-set
  // version for this (job, patternVersion) is deleted, not left to
  // linger as a second "current" claim-support projection (§24, same
  // discipline S6's own audit fix established for its own stale rows).
  await db
    .delete(researchClaimSupport)
    .where(
      and(
        eq(researchClaimSupport.researchJobId, jobId),
        eq(researchClaimSupport.patternVersion, patternVersion),
        ne(researchClaimSupport.requirementSetVersion, requirementSetVersion),
      ),
    );
  await db
    .insert(researchClaimSupport)
    .values({
      researchJobId: jobId,
      patternVersion,
      requirementSetVersion,
      intent: result.intent,
      status: result.status,
      reasonCodes: result.reasonCodes,
      requirementResults: result.requirementResults,
      contextGaps: result.contextGaps,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [researchClaimSupport.researchJobId, researchClaimSupport.patternVersion, researchClaimSupport.requirementSetVersion],
      set: {
        intent: result.intent,
        status: result.status,
        reasonCodes: result.reasonCodes,
        requirementResults: result.requirementResults,
        contextGaps: result.contextGaps,
        updatedAt: now,
      },
    });
}

// The one entry point a caller needs: load what's required, evaluate
// purely, persist. Never widens scope beyond the job's own S6 assembly
// and CORE intentRequirements — no budget, no provider, no S4/S5/S6 work
// here (§27's "zero search/model/provider cost").
//
// Returns null (does NOT persist, does NOT throw) when no S6 projection
// exists yet for this job — S7 cannot run before S6 has produced
// something to judge, and this is the expected state during an
// in-progress job, not a system failure (§34: "S7 only after a valid
// current S6 projection exists").
//
// IntentConfigurationError / ClaimEvaluationInvariantError /
// MissingActivePatternError are deliberately NOT caught here — all are
// system/configuration failures (§25), never silently swallowed into a
// false claim-support row.
export async function evaluateAndPersistClaimSupport(
  db: Database | Transaction,
  jobId: string,
  now: Date,
): Promise<ClaimSupportResult | null> {
  const { content: pattern, version: patternVersion } = await loadActivePatternContentForJob(db, jobId);
  const assembly = await loadMechanismAssembly(db, jobId, patternVersion);
  if (!assembly) return null;

  const { intent, taskType } = await loadIntentAndTaskType(db, jobId);

  const result = evaluateClaimSupport({
    researchJobId: jobId,
    patternVersion,
    pattern,
    intent,
    taskType,
    requirementSetVersion: INTENT_REQUIREMENTS_VERSION,
    assembly,
  });

  await persistClaimSupport(db, jobId, patternVersion, INTENT_REQUIREMENTS_VERSION, result, now);
  return result;
}

export { ClaimEvaluationInvariantError };
