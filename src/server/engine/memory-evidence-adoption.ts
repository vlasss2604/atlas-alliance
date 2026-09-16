import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import {
  evidence,
  researchAttempts,
  researchComponentResults,
  researchJobs,
  researchMemory,
  researchMemoryProvenance,
  sources,
} from "../db/schema";
import { loadProductConfig, type ProductConfig } from "../config/product";
import { componentRequirementsFor, type PatternContent } from "../domain/pattern";
import { computeEntityBinding, identityBindingKey, resolveConfirmedIdentity } from "../domain/project-identity";
import { isStale } from "../memory/planner";
import type { ComponentReconciliationStatus, ResultReasonCode } from "./component-reconciler";
import {
  loadActivePatternContentForJob,
  reconcileAndPersistComponent,
} from "./component-reconciliation-store";
import type { ComponentWorkItem, ContractView, ReusedComponent } from "./contract-view";
import { extractionUnitKey } from "./extraction-unit-key";
import { loadJobContractView, type ResearchJobRow } from "./job-contract-view";
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
//      an explicit `reused_from_memory_id` pointer; and the CANONICAL
//      extraction_unit_key of that source fragment (extraction-unit-key.ts)
//      — the very key a fresh extraction of the same fragment from the
//      same source would receive — so the unit is one unit in this job
//      whichever path wrote it: a second run adopts nothing twice, a fresh
//      re-acquisition of the same fragment is the index's no-op rather
//      than a second row, and S5/S6 see one slot, not a fork;
//   3. run the ordinary S5 reducer over the component — the SAME reducer,
//      the same exclusions, the same obligations fresh Evidence faces;
//   4. keep the component out of the work queue ONLY if that reduction
//      establishes it; otherwise return it to the queue as ordinary fresh
//      work in EXACTLY the shape a component memory never touched has
//      (state NO_MEMORY, no blockers), so the executor's proposer hint and
//      every other acquisition input are the control's. The reason stays
//      machine-readable on the adoption outcome this function returns and
//      on the persisted rows (the adopted Evidence's memory pointer, the S5
//      row), never on the acquisition path.
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

// SUFFICIENCY — WHEN MAY AN ADOPTED OBSERVATION SUPPRESS FRESH ACQUISITION?
//
// SUPPORTED: yes. The reused observation, under today's authority, carries
// the component on its own.
//
// PARTIALLY_SUPPORTED: only when EVERY reason code on the persisted S5 row
// is on the positive allowlist below, and the allowlist admits a code only
// when it is PROVEN to be a stable, structural ceiling — one that another
// ordinary search / fetch / extract / chain attempt for the SAME component
// cannot reasonably resolve. A mixed set is judged as a set: one code off
// the list fails the whole set. An unknown or future code is off the list
// by construction, so it fails closed to fresh work. An empty reason set on
// a partial row is malformed and fails closed too.
//
// THE AUDIT (2026-09-14), over every code the reducer can attach to a
// PARTIALLY_SUPPORTED row that adopted documentary memory produced (a row
// with no chain kind, for a component that is not fresh-only):
//   INSUFFICIENT_AUTHORITY        any component — the best establishing row
//                                 is CLAIMED under today's routes; a fresh
//                                 fetch may find a CONFIRMED-route source.
//   INDIRECT_ONLY                 any component — no DIRECT establishing
//                                 row; a fresh extraction may be DIRECT.
//   PROPOSED_STATE_ONLY /
//   APPROVAL_NOT_ESTABLISHED      structural and GOVERNANCE_BASIS-class
//                                 components — lifecycle caps; fresh
//                                 governance records may carry the later
//                                 (APPROVED / IMPLEMENTING / LIVE) state.
//   TOKEN_STATE_UNQUALIFIED       token-state-sensitive components — the
//                                 Pattern states no required token state,
//                                 so any mention downgrades; fresh rows
//                                 change the establishing set and the
//                                 supersession picture. Not proven stable.
//   MECHANICAL_PROVENANCE_NOT_ESTABLISHED (SOURCE_OF_VALUE, D-158) — the
//                                 obligation joins TWO things: an ordinary
//                                 establishing row whose LITERAL passage
//                                 names a human-confirmed activity, and a
//                                 machine-owned chain row (an attributed
//                                 external-value transfer) for that same
//                                 activity, readable by this component
//                                 through the typed applicability map.
//                                 Fresh acquisition of the same component
//                                 can supply the first (a passage naming an
//                                 activity the reused fragment never named)
//                                 and admit the documentary locator that
//                                 lets the promotion chain and the bounded
//                                 reactivation pass acquire the second. It
//                                 is common, and it is NOT a ceiling.
//   STATE_NOT_FULLY_LIVE          needs requiresLiveMechanismState, which
//                                 makes the component fresh-only; never
//                                 reached through adoption.
//   SUPPLY_* / NET_SUPPLY_* /
//   CONFLICTING_SUPPLY_DELTA      NET_EFFECT only, fresh-only; unreachable.
//   CONFLICTING_STATE, NO_EVIDENCE_FOUND, ALL_EVIDENCE_EXCLUDED,
//   MISSING_* / STALE_CURRENT_STATE
//                                 never accompany PARTIALLY_SUPPORTED.
// No reason survives the audit, so the allowlist is EMPTY and every partial
// result returns the component to fresh work. Adding a code here requires
// an audit-backed test proving why fresh acquisition cannot improve it.
export const MEMORY_ADOPTION_SUFFICIENT_PARTIAL_REASONS: ReadonlySet<ResultReasonCode> = new Set<ResultReasonCode>([]);

export interface MemoryAdoptionReconciliation {
  status: ComponentReconciliationStatus;
  reasonCodes: readonly string[];
  supportingEvidenceIds: readonly string[];
}

// The one rule. Reads the persisted S5 row, so the write path and the
// read-only re-derivation below cannot disagree about what "sufficient" is.
// The allowlist is a parameter only so the rule's set semantics can be
// proven with a non-empty list; production callers never pass one.
export function isMemoryAdoptionSufficient(
  result: MemoryAdoptionReconciliation,
  adoptedEvidenceIds: readonly string[],
  sufficientPartialReasons: ReadonlySet<string> = MEMORY_ADOPTION_SUFFICIENT_PARTIAL_REASONS,
): boolean {
  // Established BY the adopted rows themselves: a status earned by other
  // Evidence of this job says nothing about the memory, and memory the
  // reducer excluded has satisfied nothing.
  if (!result.supportingEvidenceIds.some((id) => adoptedEvidenceIds.includes(id))) return false;
  if (result.status === "SUPPORTED") return true;
  if (result.status === "PARTIALLY_SUPPORTED") {
    return (
      result.reasonCodes.length > 0 &&
      result.reasonCodes.every((code) => sufficientPartialReasons.has(code))
    );
  }
  return false;
}

// Closed. Every value is a reason the component went BACK to fresh work.
//
// THREE ADOPTION-TIME RE-CHECKS (Round 3.5, Founder-approved). Planning
// decided these once; the world can change between planning and the
// moment a memory row becomes Evidence of a job, and each is re-decided
// HERE, on the persisted row, by the same rule planning used:
//
//   MEMORY_DISABLED   the operator's kill switch (`memory_enabled`) is off
//                     NOW. Read once per adoption; every reused component
//                     returns to fresh work, nothing is written, the
//                     Research itself is not cancelled.
//   MEMORY_STALE      the observation crossed its freshness window between
//                     planning and adoption (planner.ts `isStale`, the ONE
//                     freshness rule, over the row's own verifiedAt /
//                     freshnessClass / staleAfter). Not a contradiction;
//                     the row stays ACTIVE and is simply not eligible now.
//   MEMORY_HEALTH_NOT_OK
//                     the row's health is no longer OK (QUESTIONABLE,
//                     REVERIFY, STALE). D-059: only healthy memory may
//                     close a component — the planner's rule, re-applied
//                     to the row as it is now. DEPRECATED health stays
//                     MEMORY_NOT_ACTIVE (knowledge judged wrong, D-059).
//   IDENTITY_CHANGED  the row was verified under a confirmed token
//                     identity (`identity_key`) that is not the identity
//                     confirmed today (H11). Not an inference that the old
//                     fact is false; the row is not deleted or rebound.
//                     Fresh Research re-establishes it under the new
//                     identity.
export type MemoryAdoptionRefusal =
  | "FRESH_ONLY_COMPONENT"
  | "MEMORY_DISABLED"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_NOT_ACTIVE"
  | "MEMORY_SCOPE_MISMATCH"
  | "MEMORY_STALE"
  | "MEMORY_HEALTH_NOT_OK"
  | "IDENTITY_CHANGED"
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
  const config = await loadProductConfig(db);
  const identity = await resolveConfirmedIdentity(db, projectId);

  const adopted: MemoryAdoptionComponentOutcome[] = [];
  const fallback: MemoryAdoptionComponentOutcome[] = [];

  // THE KILL SWITCH, RE-READ AT THE MOMENT OF ADOPTION. A job planned while
  // memory_enabled was true does not carry that permission with it: the
  // switch is an operational control over what Memory may do NOW. Off means
  // every reused component becomes ordinary fresh work with no row written.
  if (!config.memory_enabled) {
    for (const reused of view.reused) {
      fallback.push({
        step: reused.step,
        component: reused.component,
        memoryIds: reused.memoryIds,
        adopted: false,
        evidenceIds: [],
        status: null,
        refusals: [{ memoryId: null, reason: "MEMORY_DISABLED" }],
      });
    }
    return { workQueue: buildEffectiveWorkQueue(view, pattern, fallback), adopted, fallback };
  }

  for (const reused of view.reused) {
    const outcome = await adoptComponent(db, { jobId, projectId, topicId, pattern, identity, config, reused, now });
    (outcome.adopted ? adopted : fallback).push(outcome);
  }

  const workQueue = buildEffectiveWorkQueue(view, pattern, fallback);
  return { workQueue, adopted, fallback };
}

// THE EFFECTIVE WORK QUEUE, BUILT ONE WAY. A fallback component becomes
// ordinary fresh work in the CONTROL'S OWN SHAPE — the work item a
// component gets when memory never held anything for it: state NO_MEMORY,
// no blockers, no memory ids. Nothing downstream can tell the two apart,
// which is the invariant: the executor composes its proposer hint from
// `state` and `blockers`, and a fallback that read "UNUSABLE /
// MEMORY_ADOPTION_*" there steered the model differently from the
// no-memory control. Why the adoption failed is not lost — it is on the
// adoption outcome (`fallback[].refusals`, `memoryIds`, `status`) and on
// the persisted rows — it simply never enters the acquisition path.
// Planned items keep their order; a fallback item joins its step after
// them; a (step, component) the plan already lists is never listed twice
// (the controller would otherwise claim it a second time as a recovery
// attempt).
function buildEffectiveWorkQueue(
  view: ContractView,
  pattern: PatternContent,
  fallback: readonly { step: number; component: string }[],
): ComponentWorkItem[] {
  const plannedKeys = new Set(view.workQueue.map((w) => `${w.step}:${w.component}`));
  const items: ComponentWorkItem[] = fallback
    .filter((f) => !plannedKeys.has(`${f.step}:${f.component}`))
    .map((f) => ({
      step: f.step,
      stepName: pattern.steps.find((s) => s.step === f.step)?.name ?? `step ${f.step}`,
      component: f.component,
      state: "NO_MEMORY",
      blockers: [],
      memoryIds: [],
      conflictingMemoryIds: [],
    }));
  return [...view.workQueue, ...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.step - b.item.step || a.index - b.index)
    .map((x) => x.item);
}

// THE SAME EFFECTIVE QUEUE, READ BACK FROM PERSISTED STATE — for every
// acquisition-preparation step that runs AFTER adoption and used to read
// the planned queue: approved source-resource seeding and the on-chain
// source-open reserve, on both the single-process path (per attempt) and
// the phased path (the FETCH role, a different process). A component a
// failed adoption returned to fresh work must meet exactly the conditions
// it would have met had memory never closed it, so those steps must see it
// in the queue — for the whole life of the job.
//
// Reads, writes nothing. A reused component is fallback when ANY of:
//
//   1. it is fresh-only — adoption refuses it before reading anything;
//   2. this job holds a research_attempts row for it — the controller
//      claims attempts only for items of the effective queue, so an attempt
//      row is the durable record that the component WAS handed to fresh
//      work. Membership is for the job's lifetime, exactly as a planned
//      item's is: the fresh attempt's own S5 hook may later rewrite the row
//      to SUPPORTED with the adopted Evidence among its support, and that
//      must not drop the component out of the reserve or the seed routing
//      mid-job, where a control job would still list it;
//   3. its persisted S5 row is not sufficient BY an Evidence row of this job
//      that points at one of the memory rows the planner selected — the
//      very facts adoptReusedMemory persisted, judged by the same rule.
//      Before any attempt exists, that row can only have been written by
//      adoption itself (no other stage writes S5 for an unclaimed
//      component), so it is adoption's own verdict being read back.
//
// Any other state (adoption never ran, refused, excluded, insufficient)
// reads as fallback, which is the safe direction: a component prepared for
// fresh work that is then skipped costs nothing; one skipped by preparation
// and then researched would run under-prepared.
export async function loadEffectiveJobContractView(
  db: Database | Transaction,
  jobId: string,
): Promise<{ job: ResearchJobRow; view: ContractView }> {
  const { job, view } = await loadJobContractView(db, jobId);
  if (view.reused.length === 0) return { job, view };
  const pattern = await loadActivePatternContentForJob(db, jobId);
  // The kill switch, read the same way adoption reads it: off means every
  // reused component is fresh work for preparation too, so a phase that
  // prepares after the operator flipped the switch prepares what the
  // controller will actually walk.
  if (!(await loadProductConfig(db)).memory_enabled) {
    return { job, view: { ...view, workQueue: buildEffectiveWorkQueue(view, pattern, view.reused) } };
  }
  const attempted = new Set(
    (
      await db
        .select({ patternStep: researchAttempts.patternStep, component: researchAttempts.component })
        .from(researchAttempts)
        .where(eq(researchAttempts.researchJobId, jobId))
    ).map((a) => `${a.patternStep}:${a.component}`),
  );
  const fallback: { step: number; component: string }[] = [];
  for (const reused of view.reused) {
    if (isFreshOnlyComponent(pattern, reused.component)) {
      fallback.push(reused);
      continue;
    }
    if (attempted.has(`${reused.step}:${reused.component}`)) {
      fallback.push(reused);
      continue;
    }
    const adoptedRows = reused.memoryIds.length === 0
      ? []
      : await db
          .select({ id: evidence.id })
          .from(evidence)
          .where(
            and(
              eq(evidence.researchJobId, jobId),
              eq(evidence.patternStep, reused.step),
              eq(evidence.component, reused.component),
              inArray(evidence.reusedFromMemoryId, reused.memoryIds),
            ),
          );
    const [s5] = await db
      .select({
        status: researchComponentResults.status,
        reasonCodes: researchComponentResults.reasonCodes,
        supportingEvidenceIds: researchComponentResults.supportingEvidenceIds,
      })
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.patternStep, reused.step),
          eq(researchComponentResults.component, reused.component),
        ),
      );
    const sufficient =
      s5 !== undefined &&
      isMemoryAdoptionSufficient(
        {
          status: s5.status as ComponentReconciliationStatus,
          reasonCodes: Array.isArray(s5.reasonCodes) ? (s5.reasonCodes as string[]) : [],
          supportingEvidenceIds: Array.isArray(s5.supportingEvidenceIds) ? (s5.supportingEvidenceIds as string[]) : [],
        },
        adoptedRows.map((r) => r.id),
      );
    if (!sufficient) fallback.push(reused);
  }
  return { job, view: { ...view, workQueue: buildEffectiveWorkQueue(view, pattern, fallback) } };
}

async function adoptComponent(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string;
    topicId: string;
    pattern: PatternContent;
    identity: Awaited<ReturnType<typeof resolveConfirmedIdentity>>;
    config: ProductConfig;
    reused: ReusedComponent;
    now: Date;
  },
): Promise<MemoryAdoptionComponentOutcome> {
  const { jobId, projectId, topicId, pattern, identity, config, reused, now } = input;
  const base = { step: reused.step, component: reused.component, memoryIds: reused.memoryIds };

  if (isFreshOnlyComponent(pattern, reused.component)) {
    return { ...base, adopted: false, evidenceIds: [], status: null, refusals: [{ memoryId: null, reason: "FRESH_ONLY_COMPONENT" }] };
  }

  const evidenceIds: string[] = [];
  const refusals: MemoryAdoptionComponentOutcome["refusals"] = [];

  for (const memoryId of reused.memoryIds) {
    const materialized = await materializeOne(db, { jobId, projectId, topicId, identity, config, memoryId, step: reused.step, component: reused.component, now });
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
  if (isMemoryAdoptionSufficient(result, evidenceIds)) {
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
    config: ProductConfig;
    memoryId: string;
    step: number;
    component: string;
    now: Date;
  },
): Promise<{ ok: true; evidenceId: string } | { ok: false; reason: MemoryAdoptionRefusal }> {
  const { jobId, projectId, topicId, identity, config, memoryId, step, component, now } = input;

  // The row's own stale_after, whole, in seconds — read the way the
  // retrieval gateway reads it, so the planner's freshness rule sees the
  // same facts here that it saw at plan time.
  const [found] = await db
    .select({
      memory: researchMemory,
      staleAfterSeconds: sql<number | null>`EXTRACT(EPOCH FROM ${researchMemory.staleAfter})::double precision`,
    })
    .from(researchMemory)
    .where(eq(researchMemory.id, memoryId));
  if (!found) return { ok: false, reason: "MEMORY_NOT_FOUND" };
  const memory = found.memory;
  if (memory.lifecycleState !== "ACTIVE" || memory.health === "DEPRECATED") {
    return { ok: false, reason: "MEMORY_NOT_ACTIVE" };
  }
  // HEALTHY NOW, NOT ONLY AT PLAN TIME. The planner lets only health OK
  // close a component (D-059); a row marked QUESTIONABLE / REVERIFY / STALE
  // between planning and adoption may direct re-verification but never
  // becomes Evidence of this job.
  if (memory.health !== "OK") {
    return { ok: false, reason: "MEMORY_HEALTH_NOT_OK" };
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
  // the record (the partial unique index on (job, reused_from_memory_id)
  // guarantees at most one). Checked AFTER scope, and the existing row must
  // be filed at this very (step, component): a contract that named the same
  // row under another component must not inherit it.
  const [pointed] = await db
    .select({ id: evidence.id, patternStep: evidence.patternStep, component: evidence.component })
    .from(evidence)
    .where(and(eq(evidence.researchJobId, jobId), eq(evidence.reusedFromMemoryId, memoryId)));
  if (pointed) {
    return pointed.patternStep === step && pointed.component === component
      ? { ok: true, evidenceId: pointed.id }
      : { ok: false, reason: "MEMORY_SCOPE_MISMATCH" };
  }

  // FRESH NOW, NOT ONLY AT PLAN TIME (H8). The same rule, the same window,
  // the same config the planner applied — over the row as it is at this
  // moment. A row that crossed its window since planning is not adopted;
  // it stays ACTIVE and untouched, and the component is acquired fresh.
  if (
    isStale(
      {
        verifiedAt: memory.verifiedAt,
        freshnessClass: memory.freshnessClass,
        staleAfterSeconds: found.staleAfterSeconds != null ? Number(found.staleAfterSeconds) : null,
      },
      now,
      config,
    )
  ) {
    return { ok: false, reason: "MEMORY_STALE" };
  }

  // THE IDENTITY IT WAS VERIFIED UNDER MUST BE THE IDENTITY CONFIRMED NOW
  // (H11). Compared as values (chain and token address), never as row ids,
  // so a re-confirmation of the same token is not a replacement and a
  // different token on any chain is. NULL on the row means "verified under
  // no confirmed identity": eligible only while the project still has none.
  if (memory.identityKey !== identityBindingKey(identity)) {
    return { ok: false, reason: "IDENTITY_CHANGED" };
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

  // THE CANONICAL UNIT IDENTITY, NOT AN ADOPTION IDENTITY. The key a fresh
  // extraction of this same fragment from this same source row would
  // compute in this job (extraction-unit-key.ts): the source row is global
  // per url, the fragment is the observation's own literal passage, so a
  // later fresh re-acquisition of the same passage is the same unit — the
  // index makes it a no-op and S5/S6 see one slot. Anything that differs
  // (another url, another passage) is another unit and stays distinct.
  const fragment = prov.fragment ?? origin.fragment;
  const unitKey = extractionUnitKey(jobId, prov.sourceId, step, component, fragment);
  const [existing] = await db
    .select({ id: evidence.id, patternStep: evidence.patternStep, component: evidence.component })
    .from(evidence)
    .where(eq(evidence.extractionUnitKey, unitKey));
  if (existing) {
    // This job already holds this exact unit (the key embeds job, step and
    // component, so a hit is this job's row for this pair by construction;
    // the pair is still re-checked rather than assumed).
    return existing.patternStep === step && existing.component === component
      ? { ok: true, evidenceId: existing.id }
      : { ok: false, reason: "MEMORY_SCOPE_MISMATCH" };
  }

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
      fragment,
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
