import { and, desc, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, researchAttempts, researchComponentResults, researchJobs, researchPatterns, researchPlans } from "../db/schema";
import { loadProductConfig } from "../config/product";
import { componentRequirementsFor, patternContentSchema } from "../domain/pattern";
import { parseContract } from "../memory/contract";
import { loadActivePatternVersion, MissingActivePatternError } from "./active-pattern";
import type { ComponentWorkItem } from "./contract-view";
import { reconcileComponent, type ComponentReconciliationResult, type EvidenceRow } from "./component-reconciler";

// Phase 6, S5 — persistence boundary (phase-6-s5-plan.md §11.3, §17). This
// is the ONLY module that touches the DB for reconciliation: it loads
// exactly what reconcileComponent() (pure, DB-free) needs, then upserts its
// result. All the actual rules live in component-reconciler.ts — nothing
// here decides establishment/contradiction/supersession/token-state.

// HIGH-4 (deep audit) fix — the previous version of this function read
// "the first research_patterns row for this topic", with no status filter
// and no ORDER BY: on a topic carrying a RETIRED v1 alongside an ACTIVE
// v2, it silently reconciled against whichever row Postgres's heap
// happened to return first — proven non-deterministic and, in the deep
// audit's repro, the RETIRED version. This reuses the SAME Phase-6-safe
// ACTIVE-only lookup S4 already established (active-pattern.ts) rather
// than inventing a second selector, and additionally cross-checks the
// job's own frozen contract.patternVersion (the same check
// buildContractView performs at plan time, §5.1) — defensively re-verified
// here since S5 can run at a different moment than plan-time. Either
// disagreement is a hard, typed configuration failure — never a silent
// fallback to some other row.
async function loadActivePatternContentForJob(db: Database | Transaction, jobId: string) {
  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  if (!job.topicId) throw new Error(`research job ${jobId} has no topicId`);

  const activeVersion = await loadActivePatternVersion(db, job.topicId);
  if (activeVersion === null) {
    throw new MissingActivePatternError(
      `no ACTIVE research_patterns row for topic ${job.topicId} — refusing to reconcile without a confirmed active Pattern version`,
    );
  }

  const [planRow] = await db
    .select()
    .from(researchPlans)
    .where(eq(researchPlans.researchJobId, jobId))
    .orderBy(desc(researchPlans.version))
    .limit(1);
  if (planRow) {
    const contract = parseContract(planRow.contract);
    if (contract.patternVersion !== activeVersion) {
      throw new MissingActivePatternError(
        `job ${jobId}'s frozen contract.patternVersion=${contract.patternVersion} does not match topic ${job.topicId}'s ` +
          `current ACTIVE Pattern version=${activeVersion} — refusing to reconcile against a Pattern the job was not planned under`,
      );
    }
  }

  const [pattern] = await db
    .select()
    .from(researchPatterns)
    .where(and(eq(researchPatterns.topicId, job.topicId), eq(researchPatterns.version, activeVersion)));
  if (!pattern) {
    throw new Error(`ACTIVE research_patterns row for topic ${job.topicId} version ${activeVersion} vanished between lookup and read`);
  }
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
//
// MEDIUM-3 (deep audit): a PatternConfigurationError from
// componentRequirementsFor (CORE not configured for this component at
// all) is deliberately NOT caught here — it propagates to the caller as a
// real system/configuration failure, never silently persisted as a false
// INSUFFICIENT_EVIDENCE row. Same posture for MissingActivePatternError
// (HIGH-4): a Pattern selection failure is a configuration failure, not
// an evidentiary outcome, and must not produce a derived-projection row
// that looks like one.
export async function reconcileAndPersistComponent(
  db: Database | Transaction,
  jobId: string,
  item: Pick<ComponentWorkItem, "step" | "component">,
  now: Date,
): Promise<ComponentReconciliationResult> {
  const [pattern, config, evidenceRows] = await Promise.all([
    loadActivePatternContentForJob(db, jobId),
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

// HIGH-2 (deep audit) fix — the smallest deterministic recovery
// mechanism: reconcile every (step, component) in `workQueue` whose S4
// attempt is already terminal (SUCCEEDED/FAILED/SKIPPED), regardless of
// whether it was already reconciled. reconcileAndPersistComponent is an
// idempotent derived-projection upsert (§11.3) — calling it again for an
// already-current row is a wasted read, never a correctness or budget
// problem, and never touches search/fetch/model budget (no WorkExecutor,
// no provider, nothing paid happens here). This is the sweep that makes
// S5 eventually consistent no matter when/where a crash happened between
// an S4 attempt's terminal UPDATE and its own S5 persistence — including
// a crash that happened on a PRIOR run of this job entirely, which the
// controller's own per-attempt `reconcile` hook structurally cannot ever
// revisit (a SUCCEEDED component is filtered out of `pending` before the
// controller's loop runs at all).
//
// A pending (not-yet-terminal, i.e. STARTED-and-still-within-lease, or
// never-attempted) component is intentionally left alone — reconciling it
// now would either read a stale/incomplete Evidence set for it, or (per
// §12) attempt to synthesize a result for work that has not actually
// finished; neither is this sweep's job. It runs unconditionally after
// every runS4ResearchJob call (see that module), so a component only
// pending because it isn't due yet will be swept the moment it does
// become terminal, either via the per-attempt hook or the next sweep.
export async function reconcileOutstandingComponents(
  db: Database | Transaction,
  jobId: string,
  workQueue: Pick<ComponentWorkItem, "step" | "component">[],
  now: Date,
): Promise<void> {
  if (workQueue.length === 0) return;

  const attemptRows = await db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  const latestByKey = new Map<string, { attemptNumber: number; status: string }>();
  for (const row of attemptRows) {
    const key = `${row.patternStep}:${row.component}`;
    const prior = latestByKey.get(key);
    if (!prior || row.attemptNumber >= prior.attemptNumber) {
      latestByKey.set(key, { attemptNumber: row.attemptNumber, status: row.status });
    }
  }

  const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "SKIPPED"]);
  for (const item of workQueue) {
    const latest = latestByKey.get(`${item.step}:${item.component}`);
    if (!latest || !TERMINAL_STATUSES.has(latest.status)) continue;
    await reconcileAndPersistComponent(db, jobId, item, now);
  }
}
