import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import {
  evidence,
  proofs,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
} from "../db/schema";
import type { ClaimReasonCode, ClaimRequirementResult, ClaimSupportStatus, MechanismGapRef } from "./claim-evaluator";
import type { ComponentReconciliationStatus } from "./component-reconciler";
import { buildProof, type ProofDraft, type ProofRefusalReason } from "./proof-builder";

// Phase 6, S8 — the persistence half of the Proof Writer.
//
// The pure builder (proof-builder.ts) decides everything; this module
// only reads persisted S5/S6/S7 state, hands it over, and writes the
// result. It makes NO model call, NO network call, NO RPC and NO search —
// S8 is projection and persistence, nothing else.
//
// ATOMICITY. The Proof row and every `evidence.proof_id` binding are
// written inside ONE transaction, so the two states this could otherwise
// leave behind are unrepresentable: a Proof whose citations are only
// half bound, and Evidence pointing at a Proof whose insert failed. The
// composite FK `evidence_proof_same_job_fk` additionally makes a
// cross-job binding impossible at the database level.
//
// HISTORICAL SAFETY. `verificationStatus` gates promotion into ACTIVE
// research memory (D-041/D-055), so a Proof that a human has already
// REVIEWED or VERIFIED is immutable here: re-running S8 against one
// refuses rather than rewriting the object that decision was made about.
// A DRAFT Proof is the only one this module may replace, which is what
// makes a re-run stable rather than duplicating.

// Closed refusal vocabulary. Every one means "no Proof was written", and
// none is a system failure — an unbuildable Proof is a legitimate outcome.
export const PROOF_PERSIST_REFUSALS = [
  // The pure builder refused (no S7 claim support for this job).
  "NO_CLAIM_SUPPORT",
  // research_jobs.project_id is nullable but proofs.project_id is NOT
  // NULL: a job with no project cannot carry a Proof.
  "NO_PROJECT",
  // A human already reviewed or verified the existing Proof.
  "PROOF_NOT_DRAFT",
  // The job row itself is gone.
  "JOB_NOT_FOUND",
] as const;
export type ProofPersistRefusal = (typeof PROOF_PERSIST_REFUSALS)[number];

export interface ProofPersistResult {
  proofId: string | null;
  draft: ProofDraft | null;
  boundEvidenceIds: string[];
  refusal: ProofPersistRefusal | null;
  // True when an existing DRAFT row was replaced rather than inserted.
  replacedExisting: boolean;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asExcluded(v: unknown): { evidenceId: string; reason: string }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const row = x as { evidenceId?: unknown; reason?: unknown };
    if (typeof row.evidenceId !== "string" || typeof row.reason !== "string") return [];
    return [{ evidenceId: row.evidenceId, reason: row.reason }];
  });
}

// Reads every input the builder needs, builds, and persists — all inside
// one transaction so the read state and the written Proof cannot drift.
// NO `now` PARAMETER, deliberately: S8 needs no clock. `created_at`
// defaults in the database and `research_cutoff` stays null, so the
// projection is a pure function of persisted state plus the write itself.
// That is one less input that could make a re-run differ.
export async function buildAndPersistProof(
  db: Database | Transaction,
  jobId: string,
): Promise<ProofPersistResult> {
  return db.transaction(async (tx) => persistWithin(tx as Transaction, jobId));
}

async function persistWithin(tx: Transaction, jobId: string): Promise<ProofPersistResult> {
  const empty = { proofId: null, draft: null, boundEvidenceIds: [], replacedExisting: false };

  const [job] = await tx
    .select({
      id: researchJobs.id,
      userId: researchJobs.userId,
      projectId: researchJobs.projectId,
      topicId: researchJobs.topicId,
    })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  if (!job) return { ...empty, refusal: "JOB_NOT_FOUND" };
  if (!job.projectId) return { ...empty, refusal: "NO_PROJECT" };

  // An existing non-DRAFT Proof is never touched — see HISTORICAL SAFETY.
  const [existing] = await tx
    .select({ id: proofs.id, verificationStatus: proofs.verificationStatus })
    .from(proofs)
    .where(eq(proofs.researchJobId, jobId));
  if (existing && existing.verificationStatus !== "DRAFT") {
    return { ...empty, refusal: "PROOF_NOT_DRAFT" };
  }

  const [claim] = await tx
    .select({
      intent: researchClaimSupport.intent,
      status: researchClaimSupport.status,
      reasonCodes: researchClaimSupport.reasonCodes,
      requirementResults: researchClaimSupport.requirementResults,
      contextGaps: researchClaimSupport.contextGaps,
    })
    .from(researchClaimSupport)
    .where(eq(researchClaimSupport.researchJobId, jobId));

  const componentRows = await tx
    .select({
      patternStep: researchComponentResults.patternStep,
      component: researchComponentResults.component,
      status: researchComponentResults.status,
      reasonCodes: researchComponentResults.reasonCodes,
      supportingEvidenceIds: researchComponentResults.supportingEvidenceIds,
      excludedEvidence: researchComponentResults.excludedEvidence,
    })
    .from(researchComponentResults)
    .where(eq(researchComponentResults.researchJobId, jobId));

  // The ids that ACTUALLY exist as Evidence for this job. The builder
  // filters citations against exactly this set, so a dangling reference
  // is structurally impossible rather than merely unlikely.
  const evidenceRows = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(eq(evidence.researchJobId, jobId));

  const outcome = buildProof({
    researchJobId: jobId,
    claimSupport: claim
      ? {
          intent: claim.intent,
          status: claim.status as ClaimSupportStatus,
          reasonCodes: (claim.reasonCodes ?? []) as ClaimReasonCode[],
          requirementResults: (claim.requirementResults ?? []) as ClaimRequirementResult[],
          contextGaps: (claim.contextGaps ?? []) as MechanismGapRef[],
        }
      : null,
    componentResults: componentRows.map((r) => ({
      step: r.patternStep,
      component: r.component,
      status: r.status as ComponentReconciliationStatus,
      reasonCodes: asStringArray(r.reasonCodes),
      supportingEvidenceIds: asStringArray(r.supportingEvidenceIds),
      excludedEvidence: asExcluded(r.excludedEvidence),
    })),
    existingEvidenceIds: evidenceRows.map((r) => r.id),
  });

  if (outcome.proof === null) {
    // FAIL CLOSED (§7): no S7, no Proof. Never an UNKNOWN placeholder.
    return { ...empty, refusal: outcome.refusal satisfies ProofRefusalReason };
  }
  const draft = outcome.proof;

  // researchCutoff stays NULL deliberately: its semantics are not locked
  // anywhere, and inventing a derivation is exactly the mistake the
  // confidence contract already cost a round. The column is nullable, so
  // leaving it honest costs nothing.
  const values = {
    researchJobId: jobId,
    ownerUserId: job.userId,
    projectId: job.projectId,
    topicId: job.topicId,
    // Private by default; PUBLIC does not exist in v1.
    visibility: "PRIVATE" as const,
    verdict: draft.verdict,
    // D-135 — the band's encoding, never a percentage.
    confidence: draft.confidenceScore,
    layers: draft.layers,
    researchCutoff: null,
  };

  let proofId: string;
  let replacedExisting = false;
  if (existing) {
    // Replace the DRAFT in place: the unique index already guarantees one
    // Proof per job, so a re-run must update rather than insert.
    await tx.update(proofs).set(values).where(eq(proofs.id, existing.id));
    proofId = existing.id;
    replacedExisting = true;
    // Release citations this run no longer makes, so a shrinking Proof
    // cannot leave stale bindings behind.
    await tx
      .update(evidence)
      .set({ proofId: null })
      .where(
        and(
          eq(evidence.researchJobId, jobId),
          eq(evidence.proofId, existing.id),
          ...(draft.citedEvidenceIds.length > 0 ? [notInArray(evidence.id, draft.citedEvidenceIds)] : []),
        ),
      );
  } else {
    const [row] = await tx.insert(proofs).values(values).returning({ id: proofs.id });
    proofId = row.id;
  }

  // Bind ONLY what the builder cited, and only rows of THIS job. Excluded
  // and context Evidence is never bound merely for belonging to the job:
  // SOURCE != EVIDENCE != FACT != PROOF CLAIM.
  if (draft.citedEvidenceIds.length > 0) {
    await tx
      .update(evidence)
      .set({ proofId })
      .where(and(eq(evidence.researchJobId, jobId), inArray(evidence.id, draft.citedEvidenceIds)));
  }

  return {
    proofId,
    draft,
    boundEvidenceIds: draft.citedEvidenceIds,
    refusal: null,
    replacedExisting,
  };
}

// Kept exported for the same reason the other stores export theirs: the
// job pipeline calls this one, and tests ask the real rule.
export async function countUnboundEvidence(db: Database | Transaction, jobId: string): Promise<number> {
  const rows = await db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.researchJobId, jobId), isNull(evidence.proofId)));
  return rows.length;
}
