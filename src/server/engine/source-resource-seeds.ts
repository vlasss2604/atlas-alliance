import { eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchTraceEvents } from "../db/schema";
import { loadEligibleSourceResourcesWithCoverage } from "../memory/source-resource";
import type { RouteClass } from "./source-authority";
import { componentsAdmittingClass } from "./acquisition-plan";
import { loadJobContractView } from "./job-contract-view";
import { deriveSourceType, resolveSourceClass } from "./source-authority";
import { canonicalTargetRef, recordTraceEvent } from "./trace-store";

// D-148 — THE ONE SEED-SELECTION POLICY, SHARED BY BOTH ACQUISITION PATHS.
//
// THE DEFECT THIS CLOSES, measured on the clean Raydium validation run
// (job 5cc4a75a-…): the project held two ACTIVE, human-approved
// SOURCE_RESOURCE rows, each under an ACTIVE classified OFFICIAL_DOCS
// route, each approved for exactly the components the run failed on — and
// the run selected neither (SOURCE_RESOURCE_SELECTED: 0). The policy that
// admits an approved url the search engine never returned lived only in
// the phased FETCH path's `loadFetchTargets`. The single-process executor
// — the path alpha-run and the legacy worker actually use — built its
// candidate set from search results alone and consulted approvals only
// as a tie-break among urls search had already discovered (D-154). An
// approved document was therefore reachable on one path and structurally
// unreachable on the other, decided by nothing but which executor ran.
//
// This module is that policy, extracted rather than restated, so the two
// paths ask ONE function and cannot drift. Nothing about the policy
// changed in the move: eligibility is still `loadEligibleSourceResources
// WithCoverage` (ACTIVE, this project, serves a component this job still
// needs, url STILL resolves through an ACTIVE classified route, at most
// MAX_SOURCE_RESOURCE_SEEDS in creation order); routing is still the
// human-approved componentKeys plus every needed component whose Pattern
// admits the resource's resolved class (D-156); provenance is still one
// SOURCE_RESOURCE_SELECTED row per (step, component, url), written once
// (D-150). A resource grants no authority here and gains none: what the
// url is worth is decided at acquisition by resolveSourceRoute, exactly as
// for a url search returned.
//
// WHAT A SEED DOES NOT BYPASS. A caller admits a seed into its ordinary
// candidate set and nothing else: the seed then takes the same
// source-open reservation against the same ceiling, the same
// per-component allowance, the same SSRF-safe transport, the same dedupe,
// the same admission and the same authority resolution as any other
// candidate. This module never opens anything and never reserves anything.

export interface ApprovedSeedTarget {
  // The resource's canonical url, exactly as registered.
  canonicalUrl: string;
  // The ACTIVE route's own class, as resolveSourceRoute stated it at
  // selection time. Carried for the caller's information only — never a
  // grant; the resolver is asked again at acquisition.
  routeClass: RouteClass;
  // The components a human approved this resource for, verbatim.
  componentKeys: readonly string[];
  // The (step, component) pairs of THIS job the seed was selected for and
  // whose provenance was recorded: (approved ∪ admitting) ∩ still-needed.
  // A caller executing one component asks whether it is in here.
  routedFor: ReadonlyArray<{ step: number; component: string }>;
}

// D-148 — WHAT THIS RESEARCH STILL NEEDS, as component names.
//
// The boundary contract's own work queue: the components the planner did
// NOT mark satisfied from memory. Using it rather than the whole pattern is
// what keeps a seeded resource question-bounded — a project's curated
// sources are eligible because they serve something this job is actually
// missing, not merely because they exist.
//
// Degrade-never-throw, exactly like the ledger it sits beside: acquisition
// memory is an optimisation and must never fail a job that would otherwise
// run. No readable contract, no seeds.
async function neededWorkItems(
  db: Database | Transaction,
  jobId: string,
): Promise<Array<{ step: number; component: string }>> {
  try {
    const { view } = await loadJobContractView(db, jobId);
    // The step travels with the component because provenance must record
    // BOTH: the extraction replay is keyed by (step, component), and the
    // canonical mapping between them belongs to the ACTIVE pattern the
    // contract was built from — never to a second lookup that could drift.
    return view.workQueue.map((item) => ({ step: item.step, component: item.component }));
  } catch {
    return [];
  }
}

// D-150 — WHY A COMPONENT MAY READ A DOCUMENT NO SEARCH RETURNED.
//
// A seeded resource has no search provenance, and the extraction replay
// builds each component's corpus from search provenance. Without this, a
// seeded document is fetched, sealed with full authority, and then shown to
// nobody — which is exactly what happened on the first live run.
//
// So the association is PERSISTED AT SELECTION TIME, once, as a fact about
// this run: this url was admitted for these components of this job. It is
// written before the url is returned as a target, so a document can never
// be acquired for a component that cannot later read it.
//
// It is deliberately NOT a CANDIDATE_RETURNED row. That event means "a
// search returned this", and forging it would make the extraction map work
// by corrupting search provenance — the trace would no longer be able to
// tell a discovered candidate from a curated one.
//
// Idempotent across redelivery: what is already recorded is not recorded
// again, so a phase that runs twice does not double the trace.
async function recordSeedProvenance(
  db: Database | Transaction,
  jobId: string,
  url: string,
  components: readonly string[],
  workItems: ReadonlyArray<{ step: number; component: string }>,
  already: ReadonlySet<string>,
): Promise<Array<{ step: number; component: string }>> {
  const canonical = canonicalTargetRef(url);
  const routedFor: Array<{ step: number; component: string }> = [];
  for (const item of workItems) {
    // Only components this resource was APPROVED to serve, intersected
    // with what this job still needs. Never the resource's whole coverage,
    // and never a component outside the job's boundary.
    if (!components.includes(item.component)) continue;
    routedFor.push(item);
    if (already.has(`${item.step}:${item.component}:${canonical}`)) continue;
    await recordTraceEvent(db, {
      researchJobId: jobId,
      operationType: "SOURCE_RESOURCE_SELECTED",
      providerKind: "FETCH",
      // Names the provenance channel, so search and curated targets stay
      // distinguishable in the trace by more than the operation alone.
      providerName: "source-resource",
      patternStep: item.step,
      component: item.component,
      targetRef: url,
      status: "OK",
    });
  }
  return routedFor;
}

// What this job has ALREADY recorded, so redelivery is quiet.
async function existingSeedProvenance(
  db: Database | Transaction,
  jobId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      patternStep: researchTraceEvents.patternStep,
      component: researchTraceEvents.component,
      targetRef: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
  const out = new Set<string>();
  for (const row of rows) {
    if (row.patternStep === null || row.component === null || !row.targetRef) continue;
    out.add(`${row.patternStep}:${row.component}:${canonicalTargetRef(row.targetRef)}`);
  }
  return out;
}

// THE SELECTION. Returns every eligible seed for this job, canonically
// deduplicated, with its provenance already persisted — whether or not the
// url has been fetched yet. What to do with an already-acquired seed is the
// caller's: the phased FETCH list drops it (it seals once), the executor
// replays the sealed copy (a url is opened once per job). Both callers
// dedupe a seed against search candidates by the same canonicalTargetRef,
// so a url known both ways is one target and one budget spend, never two.
//
// Order is creation order, which is the whole of the priority rule the
// phased list applies; the executor's own D-154/D-155 ranking then places
// a seed by its predicted class and its approval, never above a
// better-ranked candidate.
export async function selectApprovedSeedTargets(
  db: Database | Transaction,
  jobId: string,
  projectId: string,
): Promise<ApprovedSeedTarget[]> {
  const workItems = await neededWorkItems(db, jobId);
  const needed = new Set(workItems.map((item) => item.component));
  const seeds = await loadEligibleSourceResourcesWithCoverage(db, projectId, needed);
  const already = seeds.length > 0 ? await existingSeedProvenance(db, jobId) : new Set<string>();
  const out: ApprovedSeedTarget[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const canonical = canonicalTargetRef(seed.canonicalUrl);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    // D-156 — WHO MAY READ THIS DOCUMENT IS DECIDED BY ADMISSIBILITY,
    // NOT ONLY BY THE LIST A HUMAN TYPED.
    //
    // The registered componentKeys are kept, so nothing a human approved
    // is withdrawn. What is ADDED is every component this job still needs
    // whose Pattern admits this resource's resolved class — the same
    // Pattern data S5 will consult again, per Evidence row, when it
    // decides what was actually established.
    //
    // This grants no authority and admits no Evidence. It only lets a
    // component that COULD be established by this class inspect the
    // document with its OWN evidenceGoal, instead of the document being
    // acquired at full authority and shown to components that
    // structurally cannot use it. Extraction stays per (step, component),
    // so nothing is cloned between components.
    //
    // Class is the resolver's answer, carried from the eligibility check
    // that already required it to be non-null; this module never decides
    // it.
    const admitting = await componentsAdmittingClass(
      db,
      jobId,
      resolveSourceClass(seed.canonicalUrl, deriveSourceType(seed.canonicalUrl), seed.routeClass),
      [...needed],
    );
    const routedComponents = [...new Set([...seed.componentKeys, ...admitting])];
    // D-150 — provenance is written even when the url is already
    // acquired: a redelivery must still be able to tell extraction which
    // components this document was selected for.
    const routedFor = await recordSeedProvenance(
      db,
      jobId,
      seed.canonicalUrl,
      routedComponents,
      workItems,
      already,
    );
    out.push({
      canonicalUrl: seed.canonicalUrl,
      routeClass: seed.routeClass,
      componentKeys: seed.componentKeys,
      routedFor,
    });
  }
  return out;
}

// Is this seed selected for the component a caller is executing right now?
// Answered from the recorded routing, so the executor's admission and the
// extraction replay's corpus read the same (step, component) pairs.
export function seedRoutedForComponent(
  seed: ApprovedSeedTarget,
  step: number,
  component: string,
): boolean {
  return seed.routedFor.some((r) => r.step === step && r.component === component);
}
