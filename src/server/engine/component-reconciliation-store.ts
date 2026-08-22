import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, researchComponentResults, researchJobs, researchPatterns } from "../db/schema";
import { loadProductConfig } from "../config/product";
import { componentRequirementsFor, patternContentSchema } from "../domain/pattern";
import type { ComponentWorkItem } from "./contract-view";
import { reconcileComponent, type ComponentReconciliationResult, type EvidenceRow } from "./component-reconciler";

// Phase 6, S5 — persistence boundary (phase-6-s5-plan.md §11.3, §17). This
// is the ONLY module that touches the DB for reconciliation: it loads
// exactly what reconcileComponent() (pure, DB-free) needs, then upserts its
// result. All the actual rules live in component-reconciler.ts — nothing
// here decides establishment/contradiction/supersession/token-state.

async function loadPatternContentForJob(db: Database | Transaction, jobId: string) {
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  const [pattern] = await db.select().from(researchPatterns).where(eq(researchPatterns.topicId, job.topicId));
  if (!pattern) throw new Error(`no research_patterns row for topic ${job.topicId}`);
  // Same discipline as plan-job.ts's loadActivePattern — a malformed
  // Pattern must not silently reach reconciliation.
  return patternContentSchema.parse(pattern.content);
}

async function loadEvidenceRows(
  db: Database | Transaction,
  jobId: string,
  step: number,
  component: string,
): Promise<EvidenceRow[]> {
  // Scoped by (job, step, component) at the SQL level — the pure
  // function's own WRONG_COMPONENT/WRONG_PROJECT checks are defense in
  // depth on top of this, not the primary scoping mechanism.
  const rows = await db
    .select()
    .from(evidence)
    .where(
      and(
        eq(evidence.researchJobId, jobId),
        eq(evidence.patternStep, step),
        eq(evidence.component, component),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    researchJobId: r.researchJobId,
    sourceId: r.sourceId,
    evidenceContractVersion: r.evidenceContractVersion,
    patternStep: r.patternStep,
    component: r.component,
    relationship: r.relationship,
    directness: r.directness,
    fragment: r.fragment,
    summary: r.summary,
    mechanismState: r.mechanismState,
    sourceClass: r.sourceClass,
    officiality: r.officiality,
    fetchedAt: r.fetchedAt,
    publishedAt: r.publishedAt,
    extractionUnitKey: r.extractionUnitKey,
    contentHash: r.contentHash,
  }));
}

// The one write this module performs — a deterministic upsert keyed by
// (research_job_id, pattern_step, component), matching the table's own
// unique index. A replay with identical inputs produces an identical row,
// never a duplicate (§11.3's "delete + rerun -> byte-identical" invariant
// depends on the pure function; this only has to not accumulate rows).
async function persistResult(
  db: Database | Transaction,
  jobId: string,
  result: ComponentReconciliationResult,
  now: Date,
): Promise<void> {
  await db
    .insert(researchComponentResults)
    .values({
      researchJobId: jobId,
      patternStep: result.step,
      component: result.component,
      status: result.status,
      reasonCodes: result.reasonCodes,
      supportingEvidenceIds: result.supportingEvidenceIds,
      contradictingEvidenceIds: result.contradictingEvidenceIds,
      excludedEvidence: result.excludedEvidence,
      currentState: result.currentState,
      temporalBasisField: result.temporalBasis?.basisField ?? null,
      temporalBasisAt: result.temporalBasis ? new Date(result.temporalBasis.at) : null,
      tokenStateMentions: result.tokenStateMentions,
      requiresFreshEvidence: result.requiresFreshEvidence,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        researchComponentResults.researchJobId,
        researchComponentResults.patternStep,
        researchComponentResults.component,
      ],
      set: {
        status: result.status,
        reasonCodes: result.reasonCodes,
        supportingEvidenceIds: result.supportingEvidenceIds,
        contradictingEvidenceIds: result.contradictingEvidenceIds,
        excludedEvidence: result.excludedEvidence,
        currentState: result.currentState,
        temporalBasisField: result.temporalBasis?.basisField ?? null,
        temporalBasisAt: result.temporalBasis ? new Date(result.temporalBasis.at) : null,
        tokenStateMentions: result.tokenStateMentions,
        requiresFreshEvidence: result.requiresFreshEvidence,
        updatedAt: now,
      },
    });
}

// The one entry point a caller (controller integration, a backfill script,
// a test) needs: load what's required, reconcile purely, persist. Never
// widens scope beyond ComponentWorkItem's own (step, component) — no
// budget, no provider, no search here (§17.1 boundary, restated at the
// integration edge too).
export async function reconcileAndPersistComponent(
  db: Database | Transaction,
  jobId: string,
  item: Pick<ComponentWorkItem, "step" | "component">,
  now: Date,
): Promise<ComponentReconciliationResult> {
  const [pattern, config, evidenceRows] = await Promise.all([
    loadPatternContentForJob(db, jobId),
    loadProductConfig(db),
    loadEvidenceRows(db, jobId, item.step, item.component),
  ]);
  const requirements = { component: item.component, ...componentRequirementsFor(pattern, item.component) };
  const result = reconcileComponent({
    jobId,
    item,
    requirements,
    evidence: evidenceRows,
    now,
    freshnessPolicyDays: config.memory_stale_after_days,
  });
  await persistResult(db, jobId, result, now);
  return result;
}
