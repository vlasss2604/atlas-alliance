import { and, eq, inArray } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, proofs, researchComponentResults, researchMemory } from "../db/schema";
import { componentRequirementsFor, type PatternContent } from "../domain/pattern";
import { identityBindingKey, resolveConfirmedIdentity } from "../domain/project-identity";
import { loadActivePatternContentForJob } from "../engine/component-reconciliation-store";
import { observationKey } from "../engine/extraction-unit-key";
import { applicableFactKindsForComponent } from "../engine/onchain-facts";
import type { EvidenceSourceClass } from "../engine/providers/types";
import { copyProvenanceFromEvidence } from "./lifecycle";

// VERIFIED RESEARCH -> OBSERVED MEMORY CANDIDATES V1.
//
// THE FIRST PRODUCTION-PATH WRITER INTO research_memory. Until now nothing
// in the Research engine wrote Research Memory: rows came only from the
// golden-set harness and manual promotion. This module turns the
// supporting documentary observations of a Proof a human has marked
// VERIFIED into OBSERVED candidates — and nothing more:
//
//     VERIFIED Research -> eligible verified observations -> OBSERVED
//
// It never promotes (OBSERVED -> CANDIDATE -> ACTIVE stays the explicit,
// admin-only path in lifecycle.ts), never enables reuse (memory_enabled
// stays a persisted opt-in), and never copies a conclusion: no Proof
// verdict, no confidence, no S5 status, no delta, no attribution. What it
// copies is an OBSERVATION — the literal source passage with its exact
// provenance — so that a later Research can adopt it as ordinary Evidence
// of its own and build its OWN Proof:
//
//     old verified observations + new observations -> new Proof
//     (never old Proof -> new Proof)
//
// THE TRIGGER is the one canonical verification act, markProofVerified
// (verification.ts), inside its transaction, after the Proof row has
// genuinely become VERIFIED. A DRAFT or REVIEWED Proof, a merely SUCCEEDED
// or a failed Research, a budget-limited job — none of them reach this
// code, because none of them is VERIFIED. A row set to VERIFIED by any
// other means bypasses it and writes nothing, which is the safe direction.
//
// WHAT MAY BECOME A CANDIDATE — a POSITIVE allowlist, every axis code-owned,
// evaluated over the persisted rows and nothing a model wrote:
//
//   1. the row belongs to the VERIFIED Proof's own Research job;
//   2. the ordinary S5 reducer of that job lists it in
//      supportingEvidenceIds (SUPPORTED or PARTIALLY_SUPPORTED) — it was
//      actually used as support, so it is not excluded Evidence;
//   3. its component is one Research Memory may ever close: not fresh-only
//      by Pattern data and the closed on-chain maps (the same rule the
//      adoption path applies — a candidate adoption would refuse is noise);
//   4. it is a documentary observation: sourceClass in
//      DOCUMENTARY_SOURCE_CLASSES, no chain kind, no chain artifact, no
//      chain provenance — deterministic chain observations have their own
//      family (onchain_artifacts) and never travel through research_memory;
//   5. its authority is CONFIRMED (a human-confirmed route resolved it) and
//      its entity binding is not UNVERIFIED;
//   6. it SUPPORTS, DIRECTly — the observation states the fact rather than
//      implying it;
//   7. it carries the canonical unit identity and complete provenance
//      (extraction_unit_key, fragment, source, url, content hash);
//   8. it was not itself adopted from Research Memory
//      (reused_from_memory_id IS NULL): the memory row it came from IS the
//      observation, and cloning memory into memory would only fork lineage.
//
// IDENTITY BINDING (H11). Each row records the project's confirmed token
// identity at the moment of verification (`identity_key`), so a later
// adoption can refuse it once the identity has been replaced.
//
// Anything else — an unknown class, a new component semantic, a row with a
// missing axis — is refused, with a closed reason, and the Proof stays
// exactly as verified.
//
// IDENTITY. A candidate is keyed on `observationKey` (extraction-unit-
// key.ts): source row, step, component, normalized passage — the
// job-independent core of the canonical unit identity. The unique index
// uq_research_memory_live_observation makes a re-verification of the same
// Proof, or a second VERIFIED Research establishing the same passage, a
// no-op. A different passage is a different observation and gets its own
// row. A later adoption of the candidate recomputes the per-job unit key
// from the copied provenance and lands on the same slot a fresh extraction
// of that passage would.
//
// PROVENANCE is the existing research_memory_provenance copy
// (copyProvenanceFromEvidence): source row, url, content hash, fragment,
// fetchedAt / observedAt / dataAsOf and the origin Evidence id — exactly
// what the adoption path reads back to re-resolve authority and entity
// binding under the routes and identity of the LATER job.
//
// NO SPEND. Reads of this job's rows, one insert and one provenance copy
// per candidate.

export const DOCUMENTARY_SOURCE_CLASSES: ReadonlySet<EvidenceSourceClass> = new Set<EvidenceSourceClass>([
  "OFFICIAL_DOCS",
  "GOVERNANCE",
  "OFFICIAL_REPORT",
]);

// Planner inputs the schema requires and no Proof may supply. Both are
// code-owned constants of THIS origin kind, never read from the Proof:
//
//   confidence — the row cleared every code-owned admission axis above and
//   a human verified the Proof it supported; the planner's reuse threshold
//   (memory_min_confidence_reuse) is a product setting the admin weighs at
//   promotion, not something this writer infers per row.
//
//   freshnessClass — no Pattern datum states how quickly a documentary
//   passage may change, so V1 fails closed to the SHORTEST reuse window.
//   A row already carrying a class (an adopted row would, but those are
//   refused above) would keep it. Widening this is a product decision.
export const VERIFIED_OBSERVATION_ORIGIN_KIND = "VERIFIED_RESEARCH";
export const VERIFIED_OBSERVATION_CONFIDENCE = 80;
export const VERIFIED_OBSERVATION_DEFAULT_FRESHNESS = "HIGH_CHANGE" as const;

export type ObservedCandidateRefusal =
  | "FRESH_ONLY_COMPONENT"
  | "SOURCE_CLASS_NOT_DOCUMENTARY"
  | "ONCHAIN_FAMILY"
  | "OFFICIALITY_NOT_CONFIRMED"
  | "ENTITY_BINDING_UNVERIFIED"
  | "RELATIONSHIP_NOT_SUPPORTS"
  | "DIRECTNESS_NOT_DIRECT"
  | "NO_UNIT_IDENTITY"
  | "PROVENANCE_INCOMPLETE"
  | "REUSED_FROM_MEMORY";

type EvidenceRow = typeof evidence.$inferSelect;

export function observedCandidateRefusal(
  row: EvidenceRow,
  pattern: PatternContent,
): ObservedCandidateRefusal | null {
  // A row filed under no (step, component) is not an observation of
  // anything the Pattern names.
  if (row.patternStep === null || row.component === null) return "PROVENANCE_INCOMPLETE";
  const requirements = componentRequirementsFor(pattern, row.component);
  if (
    requirements.requiresCurrentState ||
    requirements.requiresLiveMechanismState ||
    applicableFactKindsForComponent(row.component).length > 0
  ) {
    return "FRESH_ONLY_COMPONENT";
  }
  if (row.reusedFromMemoryId !== null) return "REUSED_FROM_MEMORY";
  if (row.onchainFactKind !== null || row.onchainArtifactId !== null || (row.onchainProvenance ?? null) !== null) {
    return "ONCHAIN_FAMILY";
  }
  if (!DOCUMENTARY_SOURCE_CLASSES.has(row.sourceClass as EvidenceSourceClass)) return "SOURCE_CLASS_NOT_DOCUMENTARY";
  if (row.officiality !== "CONFIRMED") return "OFFICIALITY_NOT_CONFIRMED";
  if (row.entityBinding === "UNVERIFIED") return "ENTITY_BINDING_UNVERIFIED";
  if (row.relationship !== "SUPPORTS") return "RELATIONSHIP_NOT_SUPPORTS";
  if (row.directness !== "DIRECT") return "DIRECTNESS_NOT_DIRECT";
  if (row.extractionUnitKey === null) return "NO_UNIT_IDENTITY";
  if (!row.fragment || row.fragment.trim().length === 0 || !row.sourceId || !row.retrievedUrl || !row.contentHash) {
    return "PROVENANCE_INCOMPLETE";
  }
  return null;
}

export interface ObservedCandidatesResult {
  proofId: string;
  researchJobId: string;
  // New OBSERVED rows written by this call.
  created: { memoryId: string; evidenceId: string; step: number; component: string; observationKey: string }[];
  // Supporting rows whose observation already has a live memory row.
  deduplicated: { memoryId: string; evidenceId: string; step: number; component: string; observationKey: string }[];
  // Supporting rows refused by the allowlist, with the closed reason.
  refused: { evidenceId: string; step: number; component: string; reason: ObservedCandidateRefusal }[];
}

// Runs INSIDE the verification transaction. Re-reads the Proof so the
// only state it ever acts on is the persisted one.
export async function writeObservedCandidatesForVerifiedProof(
  db: Database | Transaction,
  proofId: string,
  now: Date,
): Promise<ObservedCandidatesResult> {
  const [proof] = await db.select().from(proofs).where(eq(proofs.id, proofId));
  if (!proof) throw new Error(`proof not found: ${proofId}`);
  if (proof.verificationStatus !== "VERIFIED") {
    throw new Error(`proof ${proofId} is ${proof.verificationStatus}, not VERIFIED`);
  }
  const jobId = proof.researchJobId;
  const out: ObservedCandidatesResult = { proofId, researchJobId: jobId, created: [], deduplicated: [], refused: [] };

  // The job's own S5 rows are the record of what was USED as support.
  const results = await db
    .select({
      step: researchComponentResults.patternStep,
      component: researchComponentResults.component,
      status: researchComponentResults.status,
      supportingEvidenceIds: researchComponentResults.supportingEvidenceIds,
    })
    .from(researchComponentResults)
    .where(eq(researchComponentResults.researchJobId, jobId));
  const supporting = new Set<string>();
  for (const r of results) {
    if (r.status !== "SUPPORTED" && r.status !== "PARTIALLY_SUPPORTED") continue;
    for (const id of (Array.isArray(r.supportingEvidenceIds) ? r.supportingEvidenceIds : []) as string[]) supporting.add(id);
  }
  if (supporting.size === 0) return out;

  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.researchJobId, jobId), inArray(evidence.id, [...supporting])));
  rows.sort(
    (a, b) =>
      (a.patternStep ?? 0) - (b.patternStep ?? 0) ||
      (a.component ?? "").localeCompare(b.component ?? "") ||
      a.id.localeCompare(b.id),
  );
  const pattern = await loadActivePatternContentForJob(db, jobId);
  // H11 — every candidate of this verification is bound to the token
  // identity confirmed NOW, read once through the production resolver.
  const identityKey = identityBindingKey(await resolveConfirmedIdentity(db, proof.projectId));

  for (const row of rows) {
    const refusal = observedCandidateRefusal(row, pattern);
    if (refusal !== null) {
      out.refused.push({ evidenceId: row.id, step: row.patternStep ?? 0, component: row.component ?? "", reason: refusal });
      continue;
    }
    // Narrowed by the refusal above (null step / component is refused).
    const step = row.patternStep as number;
    const component = row.component as string;
    const key = observationKey(row.sourceId, step, component, row.fragment);
    const entry = { evidenceId: row.id, step, component, observationKey: key };

    const [live] = await db
      .select({ id: researchMemory.id })
      .from(researchMemory)
      .where(
        and(
          eq(researchMemory.projectId, proof.projectId),
          eq(researchMemory.topicId, proof.topicId),
          eq(researchMemory.observationKey, key),
          inArray(researchMemory.lifecycleState, ["OBSERVED", "CANDIDATE", "ACTIVE"]),
        ),
      );
    if (live) {
      out.deduplicated.push({ memoryId: live.id, ...entry });
      continue;
    }

    // OBSERVED by default and by the lifecycle guard; nothing here can
    // insert any other state. ON CONFLICT DO NOTHING is the second line
    // behind the pre-check, for a concurrent verification of the same
    // observation.
    const [inserted] = await db
      .insert(researchMemory)
      .values({
        projectId: proof.projectId,
        topicId: proof.topicId,
        patternStep: step,
        component,
        claimKey: row.claimKey ?? component.toLowerCase(),
        // The observation's own statement of itself (the extractor's
        // summary of the passage), never a verdict; the passage itself
        // when no summary was recorded.
        statement: row.summary ?? row.fragment,
        mechanismState: row.mechanismState ?? null,
        freshnessClass: row.freshnessClass ?? VERIFIED_OBSERVATION_DEFAULT_FRESHNESS,
        verifiedAt: now,
        dataAsOf: row.dataAsOf ?? null,
        confidence: VERIFIED_OBSERVATION_CONFIDENCE,
        originKind: VERIFIED_OBSERVATION_ORIGIN_KIND,
        observationKey: key,
        identityKey,
      })
      .onConflictDoNothing()
      .returning({ id: researchMemory.id });
    if (!inserted) {
      const [raced] = await db
        .select({ id: researchMemory.id })
        .from(researchMemory)
        .where(
          and(
            eq(researchMemory.projectId, proof.projectId),
            eq(researchMemory.topicId, proof.topicId),
            eq(researchMemory.observationKey, key),
            inArray(researchMemory.lifecycleState, ["OBSERVED", "CANDIDATE", "ACTIVE"]),
          ),
        );
      if (raced) out.deduplicated.push({ memoryId: raced.id, ...entry });
      continue;
    }
    await copyProvenanceFromEvidence(db, inserted.id, row.id);
    out.created.push({ memoryId: inserted.id, ...entry });
  }
  return out;
}
