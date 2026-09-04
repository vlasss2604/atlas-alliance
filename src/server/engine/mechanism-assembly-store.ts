import { and, desc, eq, inArray, ne } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, researchComponentResults, researchJobs, researchMechanismAssembly, researchPatterns, researchPlans } from "../db/schema";
import { patternContentSchema } from "../domain/pattern";
import { parseContract } from "../memory/contract";
import { loadActivePatternVersion, MissingActivePatternError } from "./active-pattern";
import type { ComponentReconciliationResult, ComponentReconciliationStatus, ExclusionReason, ResultReasonCode } from "./component-reconciler";
import { assembleMechanism, MechanismAssemblyInvariantError, type AssemblyEvidenceProjection, type MechanismAssemblyResult } from "./mechanism-assembler";

// Phase 6, S6 (phase-6-s6-plan.md §3.2, §18a, §20) — the ONLY module that
// touches the DB for mechanism assembly: loads exactly what
// assembleMechanism() (pure, DB-free) needs, then upserts its result.
// Same separation S5 already established (component-reconciler.ts /
// component-reconciliation-store.ts): all rules live in
// mechanism-assembler.ts, nothing here decides existence, classification,
// slotting, or flowId.

async function loadActivePatternContentForJob(db: Database | Transaction, jobId: string) {
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  if (!job.topicId) throw new Error(`research job ${jobId} has no topicId`);

  const activeVersion = await loadActivePatternVersion(db, job.topicId);
  if (activeVersion === null) {
    throw new MissingActivePatternError(
      `no ACTIVE research_patterns row for topic ${job.topicId} — refusing to assemble without a confirmed active Pattern version`,
    );
  }

  const [planRow] = await db
    .select()
    .from(researchPlans)
    .where(eq(researchPlans.researchJobId, jobId))
    .orderBy(desc(researchPlans.version))
    .limit(1);
  // S6 audit fix (LOW-2): a job with S5 results but NO frozen plan/contract
  // is an abnormal state, not a license to silently trust whatever Pattern
  // version happens to be ACTIVE right now. The version cross-check is
  // only meaningful against the version the job was actually planned
  // under — without it, refuse rather than guess.
  if (!planRow) {
    throw new MissingActivePatternError(
      `no research_plans row for job ${jobId} — refusing to assemble without the frozen contract's patternVersion to cross-check`,
    );
  }
  const contract = parseContract(planRow.contract);
  if (contract.patternVersion !== activeVersion) {
    throw new MissingActivePatternError(
      `job ${jobId}'s frozen contract.patternVersion=${contract.patternVersion} does not match topic ${job.topicId}'s ` +
        `current ACTIVE Pattern version=${activeVersion} — refusing to assemble against a Pattern the job was not planned under`,
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

async function loadComponentResults(db: Database | Transaction, jobId: string): Promise<ComponentReconciliationResult[]> {
  const rows = await db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  return rows.map((r) => ({
    step: r.patternStep,
    component: r.component,
    status: r.status as ComponentReconciliationStatus,
    reasonCodes: r.reasonCodes as ResultReasonCode[],
    supportingEvidenceIds: r.supportingEvidenceIds as string[],
    contradictingEvidenceIds: r.contradictingEvidenceIds as string[],
    excludedEvidence: r.excludedEvidence as { evidenceId: string; reason: ExclusionReason }[],
    currentState: r.currentState as ComponentReconciliationResult["currentState"],
    temporalBasis:
      r.temporalBasisField && r.temporalBasisAt
        ? { basisField: r.temporalBasisField as "published_at" | "fetched_at", at: r.temporalBasisAt.toISOString() }
        : null,
    tokenStateMentions: r.tokenStateMentions as string[],
    requiresFreshEvidence: r.requiresFreshEvidence,
  }));
}

// §3.1 — closed read discipline: only rows whose id appears in some
// componentResult's supportingEvidenceIds/contradictingEvidenceIds, and
// only the narrow field projection the plan approves. No other Evidence
// row is visible to S6, and no other column is read.
async function loadAdmittedEvidence(
  db: Database | Transaction,
  jobId: string,
  componentResults: ComponentReconciliationResult[],
): Promise<AssemblyEvidenceProjection[]> {
  const ids = new Set<string>();
  for (const r of componentResults) {
    for (const id of r.supportingEvidenceIds) ids.add(id);
    for (const id of r.contradictingEvidenceIds) ids.add(id);
  }
  if (ids.size === 0) return [];
  const rows = await db
    .select({
      id: evidence.id,
      researchJobId: evidence.researchJobId,
      sourceId: evidence.sourceId,
      extractionUnitKey: evidence.extractionUnitKey,
      sourceClass: evidence.sourceClass,
      officiality: evidence.officiality,
      mechanismState: evidence.mechanismState,
      publishedAt: evidence.publishedAt,
      fetchedAt: evidence.fetchedAt,
      fragment: evidence.fragment,
      summary: evidence.summary,
      retrievedUrl: evidence.retrievedUrl,
      contentHash: evidence.contentHash,
    })
    .from(evidence)
    .where(and(eq(evidence.researchJobId, jobId), inArray(evidence.id, [...ids])));
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    extractionUnitKey: r.extractionUnitKey,
    sourceClass: r.sourceClass,
    officiality: r.officiality,
    mechanismState: r.mechanismState,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    fragment: r.fragment,
    summary: r.summary,
    retrievedUrl: r.retrievedUrl,
    contentHash: r.contentHash,
  }));
}

async function persistAssembly(
  db: Database | Transaction,
  jobId: string,
  patternVersion: number,
  result: MechanismAssemblyResult,
  now: Date,
): Promise<void> {
  // S6 audit fix (LOW-2): the key is (job, pattern_version) — if a job is
  // ever legitimately re-assembled under a different version, the previous
  // version's projection is stale and must not linger as a second "current"
  // assembly for the same job. Derived projection: deleting is always safe.
  await db
    .delete(researchMechanismAssembly)
    .where(
      and(
        eq(researchMechanismAssembly.researchJobId, jobId),
        ne(researchMechanismAssembly.patternVersion, patternVersion),
      ),
    );
  await db
    .insert(researchMechanismAssembly)
    .values({
      researchJobId: jobId,
      patternVersion,
      flows: result.flows,
      unassignedGaps: result.unassignedGaps,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [researchMechanismAssembly.researchJobId, researchMechanismAssembly.patternVersion],
      set: {
        flows: result.flows,
        unassignedGaps: result.unassignedGaps,
        updatedAt: now,
      },
    });
}

// The one entry point a caller needs: load what's required, assemble
// purely, persist. Never widens scope beyond the job's own S5 results and
// their admitted Evidence — no budget, no provider, no S4 work here
// (§27's "must not consume search/model/provider budget").
//
// PatternConfigurationError and MechanismAssemblyInvariantError are
// deliberately NOT caught here — both are system/configuration failures
// (§21), never silently swallowed into a false empty assembly. Same
// posture as MissingActivePatternError (a Pattern selection failure).
export async function assembleAndPersistMechanism(
  db: Database | Transaction,
  jobId: string,
  now: Date,
): Promise<MechanismAssemblyResult> {
  const { content: pattern, version: patternVersion } = await loadActivePatternContentForJob(db, jobId);
  const componentResults = await loadComponentResults(db, jobId);
  const admittedEvidence = await loadAdmittedEvidence(db, jobId, componentResults);

  const result = assembleMechanism({
    researchJobId: jobId,
    patternVersion,
    pattern,
    contractView: { patternVersion },
    componentResults,
    admittedEvidence,
  });

  await persistAssembly(db, jobId, patternVersion, result, now);
  return result;
}

export { MechanismAssemblyInvariantError };
