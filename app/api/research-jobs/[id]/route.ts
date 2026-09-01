import { and, desc, eq } from "drizzle-orm";

import type { ComponentCoverage } from "@/src/client/research-model";
import {
  errorResponse,
  HttpError,
  requireSession,
  requireUuid,
} from "@/src/server/auth/guards";
import {
  evidence,
  projects,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  sources,
} from "@/src/server/db/schema";
import { getDb } from "@/src/server/runtime";
import { loadProofForJob } from "@/src/server/services/proof-view";

// Owner Manual Alpha App Test (D-123) — result-detail read. Same
// ownership rule as every other /api/research-jobs/[id]/* route
// (requireSession + WHERE userId = session.userId, never a role check —
// a normal PRODUCT job's owner reads their own result exactly the same
// way an ADMIN reads their own OWNER_MANUAL_ALPHA job).
//
// Returns ONLY structured, already-admitted data: job lifecycle, S7 claim
// support, S6 mechanism assembly, and admitted Evidence with its source
// provenance. Never touches research_trace_events (operational/provider
// internals, §M of the S10 spec) and never returns a provider credential
// or raw provider response — there is nothing in this query that could
// contain one.
//
// It DOES read research_attempts, and reads only the terminal status per
// (step, component). That status is reduced here to a four-value coverage
// classification before it leaves the server: no attempt `reason` string,
// no provider label, no failure detail. The reason strings are assembled
// from provider labels and HTTP detail, so they are exactly the kind of
// operational text that must not cross this boundary — the UI needs to know
// THAT the checking was blocked, never the provider's words for why.
//
// CLAIM-SCOPED PROJECTION
// -----------------------
// This endpoint previously returned one flat `evidence` array — every row
// WHERE researchJobId = job — and the result view rendered it directly
// under the finding. That is how a job whose NET_EFFECT was
// INSUFFICIENT_EVIDENCE with ZERO supporting evidence still displayed two
// GOVERNANCE_BASIS rows (excluded as CLASS_NOT_ADMISSIBLE, from an
// unrelated component) as if they were its proof. The engine was right at
// every layer; only this projection lost the structural link.
//
// `finding` below is therefore built from the PERSISTED relationship, never
// from job membership and never from any client-side inference:
//   * research_claim_support.requirementResults[].provenance.evidenceIds
//     — evidence the S7 requirement itself cites, and
//   * .provenance.componentResultKeys / .blockingGaps
//     — the (step, component) results this claim actually rests on, whose
//       research_component_results rows carry the authoritative
//       supporting / contradicting / excluded sets.
// Components the claim does not reference contribute nothing, so evidence
// belonging to another component can no longer surface beneath a finding.
//
// Matching is by exact `step:component` key. If a gap ever failed to line
// up with its component result the finding renders EMPTY rather than
// falling back to something looser — fail-closed, since the failure this
// fixes was exactly a too-generous fallback.

interface ComponentKey {
  step: number;
  component: string;
}

interface ExcludedRef {
  evidenceId: string;
  reason: string;
}

function keyOf(step: number | string, component: string): string {
  return `${step}:${component}`;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const { id } = await params;
    requireUuid(id);

    const [job] = await db
      .select({
        id: researchJobs.id,
        state: researchJobs.state,
        progressStage: researchJobs.progressStage,
        // UI V1 — persisted engine phase and memory outcome, copied so the
        // Research screen can describe where the job actually is instead of
        // inferring it from a stage counter that stops at the memory step.
        memoryStatus: researchJobs.memoryStatus,
        acquisitionPhase: researchJobs.acquisitionPhase,
        acquisitionPhaseAt: researchJobs.acquisitionPhaseAt,
        originalQuestion: researchJobs.originalQuestion,
        terminationReason: researchJobs.terminationReason,
        errorCode: researchJobs.errorCode,
        origin: researchJobs.origin,
        createdAt: researchJobs.createdAt,
        startedAt: researchJobs.startedAt,
        finishedAt: researchJobs.finishedAt,
        // The project this research is about, for the screen header. A
        // LEFT JOIN because projectId is nullable — an unresolved project
        // stays null and the header says so rather than inventing a name.
        projectName: projects.name,
        projectSlug: projects.slug,
        projectTicker: projects.ticker,
      })
      .from(researchJobs)
      .leftJoin(projects, eq(researchJobs.projectId, projects.id))
      .where(and(eq(researchJobs.id, id), eq(researchJobs.userId, session.userId)));
    if (!job) throw new HttpError(404, "NOT_FOUND");

    const [claimSupport] = await db
      .select({
        intent: researchClaimSupport.intent,
        status: researchClaimSupport.status,
        reasonCodes: researchClaimSupport.reasonCodes,
        requirementResults: researchClaimSupport.requirementResults,
        contextGaps: researchClaimSupport.contextGaps,
      })
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, id))
      .orderBy(desc(researchClaimSupport.updatedAt))
      .limit(1);

    const [mechanism] = await db
      .select({
        flows: researchMechanismAssembly.flows,
        unassignedGaps: researchMechanismAssembly.unassignedGaps,
      })
      .from(researchMechanismAssembly)
      .where(eq(researchMechanismAssembly.researchJobId, id))
      .orderBy(desc(researchMechanismAssembly.updatedAt))
      .limit(1);

    const componentRows = await db
      .select({
        patternStep: researchComponentResults.patternStep,
        component: researchComponentResults.component,
        status: researchComponentResults.status,
        reasonCodes: researchComponentResults.reasonCodes,
        supportingEvidenceIds: researchComponentResults.supportingEvidenceIds,
        contradictingEvidenceIds: researchComponentResults.contradictingEvidenceIds,
        excludedEvidence: researchComponentResults.excludedEvidence,
      })
      .from(researchComponentResults)
      .where(eq(researchComponentResults.researchJobId, id))
      .orderBy(researchComponentResults.patternStep);

    const evidenceRows = await db
      .select({
        id: evidence.id,
        patternStep: evidence.patternStep,
        component: evidence.component,
        relationship: evidence.relationship,
        directness: evidence.directness,
        fragment: evidence.fragment,
        summary: evidence.summary,
        doesNotProve: evidence.doesNotProve,
        mechanismState: evidence.mechanismState,
        valueSource: evidence.valueSource,
        sourceClass: evidence.sourceClass,
        officiality: evidence.officiality,
        observedAt: evidence.observedAt,
        dataAsOf: evidence.dataAsOf,
        publishedAt: evidence.publishedAt,
        retrievedUrl: evidence.retrievedUrl,
        sourceTitle: sources.title,
        sourcePublisher: sources.publisher,
        sourceType: sources.sourceType,
      })
      .from(evidence)
      .innerJoin(sources, eq(evidence.sourceId, sources.id))
      .where(eq(evidence.researchJobId, id))
      .orderBy(evidence.patternStep, evidence.createdAt);

    // ---- Component ownership, straight from S5 --------------------------
    // Every evidence row is annotated with the component result(s) that
    // actually reference it and in what role. The client never has to
    // infer this (and must never guess it from text or step numbers).
    const linksByEvidenceId = new Map<
      string,
      { patternStep: number; component: string; role: string; exclusionReason: string | null }[]
    >();
    const addLink = (
      evidenceId: string,
      patternStep: number,
      component: string,
      role: string,
      exclusionReason: string | null,
    ) => {
      const list = linksByEvidenceId.get(evidenceId) ?? [];
      list.push({ patternStep, component, role, exclusionReason });
      linksByEvidenceId.set(evidenceId, list);
    };

    // ---- How complete was the checking for each component? ---------------
    //
    // `research_attempts` already carries a terminal status per (job, step,
    // component) and was already being read below for the execution counts —
    // it was simply reduced to three integers before it reached the client.
    // Nothing new is stored, no engine behaviour changes, no migration.
    //
    // This answers a question S5 structurally cannot. The reconciler sees
    // Evidence rows and nothing else, so a component whose every fetch
    // failed and a component whose sources genuinely said nothing both
    // arrive as INSUFFICIENT_EVIDENCE carrying NO_EVIDENCE_FOUND. Only the
    // attempt record separates "the public record is silent" from "this run
    // could not look", and the product must never present the second as the
    // first.
    const attemptRows = await db
      .select({
        patternStep: researchAttempts.patternStep,
        component: researchAttempts.component,
        status: researchAttempts.status,
      })
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, id));

    // DELIBERATELY CONSERVATIVE. COMPLETED is the only value that asserts
    // the checking finished cleanly, and it requires every attempt for that
    // component to have SUCCEEDED — one FAILED or one still-STARTED row
    // downgrades to PARTIAL rather than claiming exhaustiveness. BLOCKED is
    // the only value the UI may present as a research limitation, and it
    // requires that NOTHING succeeded and something positively failed.
    // Anything ambiguous lands in PARTIAL, which claims nothing either way.
    const attemptsByComponent = new Map<string, { ok: number; failed: number; other: number }>();
    for (const a of attemptRows) {
      const key = keyOf(a.patternStep, a.component);
      const acc = attemptsByComponent.get(key) ?? { ok: 0, failed: 0, other: 0 };
      if (a.status === "SUCCEEDED") acc.ok += 1;
      else if (a.status === "FAILED") acc.failed += 1;
      else acc.other += 1;
      attemptsByComponent.set(key, acc);
    }
    const coverageOf = (step: number, component: string): ComponentCoverage => {
      const acc = attemptsByComponent.get(keyOf(step, component));
      if (!acc) return "NOT_ATTEMPTED";
      if (acc.ok === 0 && acc.failed === 0) return "NOT_ATTEMPTED";
      if (acc.ok === 0 && acc.failed > 0) return "BLOCKED";
      if (acc.failed === 0 && acc.other === 0) return "COMPLETED";
      return "PARTIAL";
    };

    const components = componentRows.map((row) => {
      const supportingEvidenceIds = asArray(row.supportingEvidenceIds).filter(
        (v): v is string => typeof v === "string",
      );
      const contradictingEvidenceIds = asArray(row.contradictingEvidenceIds).filter(
        (v): v is string => typeof v === "string",
      );
      const excluded: ExcludedRef[] = asArray(row.excludedEvidence).flatMap((raw) => {
        const e = raw as { evidenceId?: unknown; reason?: unknown };
        return typeof e?.evidenceId === "string"
          ? [{ evidenceId: e.evidenceId, reason: typeof e.reason === "string" ? e.reason : "UNKNOWN" }]
          : [];
      });

      for (const eid of supportingEvidenceIds) {
        addLink(eid, row.patternStep, row.component, "SUPPORTING", null);
      }
      for (const eid of contradictingEvidenceIds) {
        addLink(eid, row.patternStep, row.component, "CONTRADICTING", null);
      }
      for (const ex of excluded) {
        addLink(ex.evidenceId, row.patternStep, row.component, "EXCLUDED", ex.reason);
      }

      return {
        patternStep: row.patternStep,
        component: row.component,
        status: row.status,
        reasonCodes: row.reasonCodes,
        supportingEvidenceIds,
        contradictingEvidenceIds,
        excludedEvidence: excluded,
        coverage: coverageOf(row.patternStep, row.component),
      };
    });

    // ---- Which components does the displayed claim actually rest on? ----
    const claimComponentKeys = new Set<string>();
    const directEvidenceIds = new Set<string>();
    for (const raw of asArray(claimSupport?.requirementResults)) {
      const rr = raw as {
        provenance?: { evidenceIds?: unknown; componentResultKeys?: unknown };
        blockingGaps?: unknown;
      };
      for (const eid of asArray(rr?.provenance?.evidenceIds)) {
        if (typeof eid === "string") directEvidenceIds.add(eid);
      }
      for (const k of asArray(rr?.provenance?.componentResultKeys)) {
        const ck = k as Partial<ComponentKey>;
        if (typeof ck?.step === "number" && typeof ck?.component === "string") {
          claimComponentKeys.add(keyOf(ck.step, ck.component));
        }
      }
      // A blocking gap names the component the claim FAILED on. Including
      // it is what lets an honest "considered but excluded" list appear for
      // the very component the finding is about — without it, a claim that
      // was blocked precisely because its evidence was excluded would show
      // no trace of why.
      for (const g of asArray(rr?.blockingGaps)) {
        const gap = g as { afterStep?: unknown; component?: unknown };
        if (typeof gap?.afterStep === "number" && typeof gap?.component === "string") {
          claimComponentKeys.add(keyOf(gap.afterStep, gap.component));
        }
      }
    }

    const claimComponents = components.filter((c) =>
      claimComponentKeys.has(keyOf(c.patternStep, c.component)),
    );

    const supportingIds = new Set<string>(directEvidenceIds);
    const contradictingIds = new Set<string>();
    const excludedRefs = new Map<string, string>();
    for (const c of claimComponents) {
      for (const eid of c.supportingEvidenceIds) supportingIds.add(eid);
      for (const eid of c.contradictingEvidenceIds) contradictingIds.add(eid);
      for (const ex of c.excludedEvidence) excludedRefs.set(ex.evidenceId, ex.reason);
    }
    // Hard invariant, enforced structurally rather than assumed: something
    // a component excluded can never be presented as that component's
    // support. S5 already keeps these disjoint; this makes it impossible
    // for a future regression upstream to surface excluded rows as proof.
    for (const eid of excludedRefs.keys()) {
      supportingIds.delete(eid);
      contradictingIds.delete(eid);
    }

    const byId = new Map(evidenceRows.map((e) => [e.id, e]));
    const pick = (ids: Iterable<string>) =>
      [...ids].flatMap((eid) => {
        const row = byId.get(eid);
        return row ? [row] : [];
      });

    const finding = {
      // The exact components this finding is scoped to — inspectable, so a
      // reviewer can see WHY a given item is or isn't here.
      componentKeys: claimComponents.map((c) => ({
        step: c.patternStep,
        component: c.component,
      })),
      supporting: pick(supportingIds),
      contradicting: pick(contradictingIds),
      excluded: [...excludedRefs.entries()].flatMap(([eid, reason]) => {
        const row = byId.get(eid);
        return row ? [{ ...row, exclusionReason: reason }] : [];
      }),
    };

    // ---- Honest execution counts ----------------------------------------
    // The result view used to label mechanism.flows.length as "steps
    // traced". flows are mechanism BRANCHES (a single unbranched path is
    // 1), not Pattern steps, so a job that attempted all 8 steps reported
    // "1 step traced". research_attempts is the authoritative record of
    // what the controller actually attempted.
    // Same rows the coverage projection above reads, counted a second way.
    const attemptedStepSet = new Set<number>();
    const attemptedComponentSet = new Set<string>();
    const succeededComponentSet = new Set<string>();
    for (const a of attemptRows) {
      attemptedStepSet.add(a.patternStep);
      attemptedComponentSet.add(keyOf(a.patternStep, a.component));
      if (a.status === "SUCCEEDED") {
        succeededComponentSet.add(keyOf(a.patternStep, a.component));
      }
    }

    const execution = {
      attemptedSteps: attemptedStepSet.size,
      attemptedComponents: attemptedComponentSet.size,
      succeededComponents: succeededComponentSet.size,
      establishedComponents: components.filter((c) => c.status === "SUPPORTED").length,
    };

    // S9 — THE PRODUCT BOUNDARY. `proof` is the canonical, client-facing
    // answer: verdict, confidence band, the locked layers and the
    // citations S8 actually bound. It comes from the ONE shared
    // serializer (services/proof-view.ts), so any future route returns
    // the same representation instead of assembling a second one.
    //
    // Null means exactly "no Proof exists for this job under this owner"
    // — a job still running, a job that finished without one, or a job
    // that is not this caller's. Nothing is fabricated on a GET, and the
    // job's own `state` remains the authority on whether it is still
    // working.
    //
    // Everything BELOW `proof` is engine state kept for owner
    // transparency during the manual alpha test (D-123). A client no
    // longer needs any of it to read a Proof; it is retained rather than
    // deleted because removing it would change the existing result view,
    // which this task deliberately does not touch.
    const proof = await loadProofForJob(db, id, session.userId);

    return Response.json({
      job,
      proof,
      claimSupport: claimSupport ?? null,
      mechanism: mechanism ?? null,
      execution,
      finding,
      components,
      // Retained for transparency/debug, now carrying its ownership links.
      // NOT the Proof source — `proof` is, and `finding` was before it.
      evidence: evidenceRows.map((e) => ({
        ...e,
        links: linksByEvidenceId.get(e.id) ?? [],
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
