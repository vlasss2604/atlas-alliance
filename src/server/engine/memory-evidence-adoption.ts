import { asc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { Database, Transaction } from "../db/client";
import {
  evidence,
  researchJobs,
  researchMemory,
  researchMemoryProvenance,
  sources,
} from "../db/schema";
import { componentRequirementsFor, type PatternContent } from "../domain/pattern";
import { resolveConfirmedIdentity, computeEntityBinding } from "../domain/project-identity";
import type { ComponentReconciliationStatus } from "./component-reconciler";
import {
  loadActivePatternContentForJob,
  reconcileAndPersistComponent,
} from "./component-reconciliation-store";
import type { ComponentWorkItem, ContractView, ReusedComponent } from "./contract-view";
import { applicableFactKindsForComponent } from "./onchain-facts";
import { resolveSourceClass, resolveSourceRoute } from "./source-authority";

// RESEARCH MEMORY -> EVIDENCE ADOPTION V1.
//
// WHAT RESEARCH MEMORY IS ALLOWED TO BE. A reusable store of previously
// verified OBSERVATIONS with exact provenance — never a verdict, never a
// Proof, never a component result. A later Research builds its own
// Evidence record, its own S5 results and its own Proof:
//
//     OLD OBSERVATIONS + NEW OBSERVATIONS -> NEW PROOF
//     (never OLD PROOF -> NEW PROOF)
//
// THE DEFECT THIS CLOSES. The planner closes a component from ACTIVE
// memory (SATISFIED), buildContractView routes it to `view.reused`, and
// nothing downstream consumed that list: no Evidence of the current job,
// no S5 row, and mechanism-assembler.ts reads an absent result exactly as
// INSUFFICIENT_EVIDENCE — a MISSING_COMPONENT gap for the one component
// memory had "satisfied". Reuse made the Proof worse than fresh research.
//
// WHAT THIS DOES INSTEAD, per reused component, before any work is claimed:
//
//   1. refuse outright if the component is FRESH-ONLY (below);
//   2. for each memory row the planner selected: verify it is the row the
//      planner meant (ACTIVE, this project, this topic, this step, this
//      component), find its copied provenance and the origin Evidence row
//      that provenance points at, and MATERIALIZE one ordinary Evidence row
//      of THIS job from them — fragment, source, url, content hash,
//      fetchedAt/observedAt/dataAsOf copied; relationship, directness and
//      the like taken from the origin row (they are properties of the
//      observation, not conclusions); sourceClass / officiality / entity
//      binding RE-RESOLVED under today's routes and identity, never copied;
//      an explicit `reused_from_memory_id` pointer; a deterministic
//      extraction_unit_key so a second run adopts nothing twice;
//   3. run the ordinary S5 reducer over the component — the SAME reducer,
//      the same exclusions, the same obligations fresh Evidence faces;
//   4. keep the component out of the work queue ONLY if that reduction
//      establishes it; otherwise return it to the queue as ordinary fresh
//      work, with the reason as a machine-readable blocker.
//
// NOTHING IS COPIED THAT IS A CONCLUSION: not the old component status, not
// the old Proof verdict or confidence, not any delta or NET_EFFECT reading.
// The memory row's own `confidence` is a planner input and never reaches
// Evidence. The memory row's `statement` becomes the adopted row's summary
// — it is the verified fragment's own statement, not a verdict.
//
// FRESH-ONLY COMPONENTS are decided from Pattern data and the closed
// on-chain maps, never from a component name: a requirement that demands a
// currency basis (`requiresCurrentState`) or a live mechanism state
// (`requiresLiveMechanismState`), or a component whose reconciliation
// reads cross-component deterministic chain facts
// (`applicableFactKindsForComponent`), asks a question an old documentary
// observation cannot answer today. On Pattern v1 that is CURRENT_STATE,
// EXECUTION_EVIDENCE and NET_EFFECT. Their existing fresh / on-chain
// semantics are untouched: they are simply never closed from memory.
//
// SEPARATE FAMILIES. This module reads research_memory and writes
// evidence. It never touches onchain_artifacts (chain observations have
// their own reuse, keyed by slot) and never touches project_memory_items
// except through the authority resolver every fresh acquisition already
// uses. No chain, project or component name appears here.
//
// NO SPEND. No provider, no search, no fetch, no model, no reservation.
// Two selects, one insert and one S5 reduction per reused memory row.

export const MEMORY_ADOPTION_SUFFICIENT_STATUSES: ReadonlySet<ComponentReconciliationStatus> = new Set([
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
]);

// Closed. Every value is a reason the component went BACK to fresh work.
export type MemoryAdoptionRefusal =
  | "FRESH_ONLY_COMPONENT"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_NOT_ACTIVE"
  | "MEMORY_SCOPE_MISMATCH"
  | "PROVENANCE_INCOMPLETE"
  | "ORIGIN_EVIDENCE_MISSING"
  | "SOURCE_MISSING"
  | "NOT_ESTABLISHED";

export interface MemoryAdoptionComponentOutcome {
  step: number;
  component: string;
  memoryIds: string[];
  // True when the component stays out of the work queue.
  adopted: boolean;
  // Adopted Evidence rows of THIS job (existing or newly written).
  evidenceIds: string[];
  // The ordinary S5 status the adopted rows reduced to, or null when no
  // row was materialized at all.
  status: ComponentReconciliationStatus | null;
  refusals: { memoryId: string | null; reason: MemoryAdoptionRefusal }[];
}

export interface MemoryAdoptionResult {
  // The effective work queue: the planned queue plus every reused
  // component adoption could not establish, ordered by step.
  workQueue: ComponentWorkItem[];
  adopted: MemoryAdoptionComponentOutcome[];
  fallback: MemoryAdoptionComponentOutcome[];
}

export function isFreshOnlyComponent(
  pattern: PatternContent,
  component: string,
): boolean {
  const requirements = componentRequirementsFor(pattern, component);
  return (
    requirements.requiresCurrentState ||
    requirements.requiresLiveMechanismState ||
    applicableFactKindsForComponent(component).length > 0
  );
}

// Deterministic per (job, memory row): the idempotency key the unique
// extraction_unit_key index enforces, in a namespace no fresh extraction
// can produce (fresh keys are hashes of job|source|step|component|fragment).
export function memoryAdoptionUnitKey(jobId: string, memoryId: string): string {
  return createHash("sha256").update(`memory-adoption|${jobId}|${memoryId}`).digest("hex");
}

export async function adoptReusedMemory(
  db: Database | Transaction,
  jobId: string,
  view: ContractView,
  now: Date,
): Promise<MemoryAdoptionResult> {
  if (view.reused.length === 0) {
    return { workQueue: view.workQueue, adopted: [], fallback: [] };
  }

  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (!job) throw new Error(`research job not found: ${jobId}`);
  if (!job.projectId || !job.topicId) throw new Error(`research job ${jobId} has no project/topic`);
  const projectId = job.projectId;
  const topicId = job.topicId;

  const pattern = await loadActivePatternContentForJob(db, jobId);
  const identity = await resolveConfirmedIdentity(db, projectId);

  const adopted: MemoryAdoptionComponentOutcome[] = [];
  const fallback: MemoryAdoptionComponentOutcome[] = [];

  for (const reused of view.reused) {
    const outcome = await adoptComponent(db, { jobId, projectId, topicId, pattern, identity, reused, now });
    (outcome.adopted ? adopted : fallback).push(outcome);
  }

  // Fallback components become ordinary fresh work. `UNUSABLE` is the
  // contract's own state for "memory exists but cannot close this", and
  // the blockers say why in machine-readable form — the same shape every
  // planned work item already carries, so the controller, the executor's
  // proposer hint and the search phase need no new case.
  const fallbackItems: ComponentWorkItem[] = fallback.map((f) => ({
    step: f.step,
    stepName: pattern.steps.find((s) => s.step === f.step)?.name ?? `step ${f.step}`,
    component: f.component,
    state: "UNUSABLE",
    blockers: [...new Set(f.refusals.map((r) => `MEMORY_ADOPTION_${r.reason}`))].sort(),
    memoryIds: f.memoryIds,
    conflictingMemoryIds: [],
  }));

  // Planned items keep their order; a fallback item joins its step after
  // them. A (step, component) the plan already lists as work is never
  // listed twice — the controller would otherwise claim it a second time
  // as a recovery attempt. Stable sort by step, nothing else.
  const plannedKeys = new Set(view.workQueue.map((w) => `${w.step}:${w.component}`));
  const workQueue = [...view.workQueue, ...fallbackItems.filter((f) => !plannedKeys.has(`${f.step}:${f.component}`))]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.step - b.item.step || a.index - b.index)
    .map((x) => x.item);

  return { workQueue, adopted, fallback };
}

async function adoptComponent(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string;
    topicId: string;
    pattern: PatternContent;
    identity: Awaited<ReturnType<typeof resolveConfirmedIdentity>>;
    reused: ReusedComponent;
    now: Date;
  },
): Promise<MemoryAdoptionComponentOutcome> {
  const { jobId, projectId, topicId, pattern, identity, reused, now } = input;
  const base = { step: reused.step, component: reused.component, memoryIds: reused.memoryIds };

  if (isFreshOnlyComponent(pattern, reused.component)) {
    return { ...base, adopted: false, evidenceIds: [], status: null, refusals: [{ memoryId: null, reason: "FRESH_ONLY_COMPONENT" }] };
  }

  const evidenceIds: string[] = [];
  const refusals: MemoryAdoptionComponentOutcome["refusals"] = [];

  for (const memoryId of reused.memoryIds) {
    const materialized = await materializeOne(db, { jobId, projectId, topicId, identity, memoryId, step: reused.step, component: reused.component });
    if (materialized.ok) evidenceIds.push(materialized.evidenceId);
    else refusals.push({ memoryId, reason: materialized.reason });
  }

  if (evidenceIds.length === 0) {
    return { ...base, adopted: false, evidenceIds, status: null, refusals };
  }

  // THE ORDINARY REDUCER, AND ONLY IT. The adopted rows are reconciled
  // exactly as fresh rows would be: admissible class, polarity,
  // directness, freshness, obligations, supersession. If the same
  // observation would be excluded when fresh, it is excluded here.
  const result = await reconcileAndPersistComponent(db, jobId, { step: reused.step, component: reused.component }, now);
  // Established, AND established by the adopted rows themselves: a status
  // earned by other Evidence of this job says nothing about the memory,
  // and memory that the reducer excluded has not satisfied anything.
  const establishedByMemory = result.supportingEvidenceIds.some((id) => evidenceIds.includes(id));
  if (MEMORY_ADOPTION_SUFFICIENT_STATUSES.has(result.status) && establishedByMemory) {
    return { ...base, adopted: true, evidenceIds, status: result.status, refusals };
  }
  // Not established from memory: the adopted rows stay (they are honest
  // Evidence of this job and the reducer will see them again beside the
  // fresh rows), the S5 row will be rewritten by the fresh attempt's own
  // hook, and the component goes back to fresh work.
  return {
    ...base,
    adopted: false,
    evidenceIds,
    status: result.status,
    refusals: [...refusals, { memoryId: null, reason: "NOT_ESTABLISHED" }],
  };
}

async function materializeOne(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string;
    topicId: string;
    identity: Awaited<ReturnType<typeof resolveConfirmedIdentity>>;
    memoryId: string;
    step: number;
    component: string;
  },
): Promise<{ ok: true; evidenceId: string } | { ok: false; reason: MemoryAdoptionRefusal }> {
  const { jobId, projectId, topicId, identity, memoryId, step, component } = input;

  const [memory] = await db.select().from(researchMemory).where(eq(researchMemory.id, memoryId));
  if (!memory) return { ok: false, reason: "MEMORY_NOT_FOUND" };
  if (memory.lifecycleState !== "ACTIVE" || memory.health === "DEPRECATED") {
    return { ok: false, reason: "MEMORY_NOT_ACTIVE" };
  }
  // The planner already scoped retrieval by project and topic; this is the
  // fail-closed re-check at the point where a row becomes Evidence of a
  // job. A row for another project, topic, step or component is never
  // materialized, whatever the contract says about it.
  if (
    memory.projectId !== projectId ||
    memory.topicId !== topicId ||
    memory.patternStep !== step ||
    memory.component !== component
  ) {
    return { ok: false, reason: "MEMORY_SCOPE_MISMATCH" };
  }

  // Already adopted by an earlier run or phase of this job: the pointer is
  // the record, and the unit key makes the insert below a no-op anyway.
  // Checked AFTER scope, and the existing row must be filed at this very
  // (step, component): the key is per (job, memory row), so a contract
  // that named the same row under another component must not inherit it.
  const unitKey = memoryAdoptionUnitKey(jobId, memoryId);
  const [existing] = await db
    .select({ id: evidence.id, patternStep: evidence.patternStep, component: evidence.component })
    .from(evidence)
    .where(eq(evidence.extractionUnitKey, unitKey));
  if (existing) {
    return existing.patternStep === step && existing.component === component
      ? { ok: true, evidenceId: existing.id }
      : { ok: false, reason: "MEMORY_SCOPE_MISMATCH" };
  }

  // The copied provenance (research_memory_provenance) is the observation's
  // own record; the earliest row is the original copy. Without it there is
  // nothing to cite, and a memory row that cannot be cited is not reused.
  const [prov] = await db
    .select()
    .from(researchMemoryProvenance)
    .where(eq(researchMemoryProvenance.memoryId, memoryId))
    .orderBy(asc(researchMemoryProvenance.createdAt))
    .limit(1);
  if (!prov) return { ok: false, reason: "PROVENANCE_INCOMPLETE" };

  // Relationship, directness, what the fragment does not prove and the
  // publication date are properties of the ORIGINAL observation that the
  // provenance copy does not carry. They are read from the origin Evidence
  // row; if that row is gone the observation is incomplete and is not
  // reused (the copy survives, but V1 does not invent the missing axes).
  if (!prov.originEvidenceId) return { ok: false, reason: "ORIGIN_EVIDENCE_MISSING" };
  const [origin] = await db.select().from(evidence).where(eq(evidence.id, prov.originEvidenceId));
  if (!origin) return { ok: false, reason: "ORIGIN_EVIDENCE_MISSING" };

  const [source] = await db.select().from(sources).where(eq(sources.id, prov.sourceId));
  if (!source) return { ok: false, reason: "SOURCE_MISSING" };

  // AUTHORITY IS TODAY'S, NEVER YESTERDAY'S. The same three calls every
  // fresh documentary admission makes (s4-executor.ts): the route the
  // project's ACTIVE SOURCE_ROUTE rows give this url NOW, the class that
  // route and the host resolve to NOW, and the entity binding against the
  // identity confirmed NOW. A route deprecated since the original Research
  // makes the adopted row CLAIMED / weakest-class today, and the reducer
  // then excludes it exactly as it would a fresh row from that url.
  const route = await resolveSourceRoute(db, projectId, prov.retrievedUrl);
  const sourceClass = resolveSourceClass(prov.retrievedUrl, source.sourceType, route.routeClass);
  const entityBinding = computeEntityBinding(prov.retrievedUrl, sourceClass, identity);

  const [row] = await db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId: prov.sourceId,
      patternStep: step,
      component,
      relationship: origin.relationship,
      directness: origin.directness,
      fragment: prov.fragment ?? origin.fragment,
      summary: memory.statement,
      doesNotProve: origin.doesNotProve,
      mechanismState: memory.mechanismState ?? origin.mechanismState,
      valueSource: origin.valueSource,
      sourceClass,
      officiality: route.officiality,
      entityBinding,
      // Deterministic chain observations never travel through
      // research_memory; an adopted row is documentary by construction.
      onchainFactKind: null,
      onchainArtifactId: null,
      onchainProvenance: null,
      documentaryLocator: null,
      fetchedAt: prov.fetchedAt,
      observedAt: prov.observedAt,
      dataAsOf: prov.dataAsOf,
      publishedAt: origin.publishedAt,
      claimKey: memory.claimKey,
      freshnessClass: memory.freshnessClass,
      retrievedUrl: prov.retrievedUrl,
      contentHash: prov.contentHash,
      extractionUnitKey: unitKey,
      reusedFromMemoryId: memoryId,
    })
    .onConflictDoNothing()
    .returning({ id: evidence.id });
  if (row) return { ok: true, evidenceId: row.id };
  // A concurrent phase wrote it first; read it back through the same key.
  const [raced] = await db
    .select({ id: evidence.id })
    .from(evidence)
    .where(eq(evidence.extractionUnitKey, unitKey));
  return raced ? { ok: true, evidenceId: raced.id } : { ok: false, reason: "PROVENANCE_INCOMPLETE" };
}
