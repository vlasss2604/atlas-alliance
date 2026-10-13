import { eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { proofs, researchJobs } from "../db/schema";
import { assertAdmin } from "./lifecycle";
import { writeObservedCandidatesForVerifiedProof, type ObservedCandidatesResult } from "./observed-candidates";

// D-041/D-055: VERIFIED гейтит промоушен в ACTIVE-память, не появление
// кандидата. Выставляется контролируемым, аудируемым действием админа —
// не автоматическим промоушеном моделью, не через admin UI (не строится
// в Фазе 5). Аудит — явная проверка роли + вызывающий скрипт печатает
// подтверждение (см. scripts/verify-proof.ts).
//
// VERIFIED RESEARCH -> OBSERVED CANDIDATES V1. This is the one canonical
// verification act, so it is also the one place the Research engine writes
// Research Memory: in the same transaction, AFTER the row has genuinely
// become VERIFIED, the Proof's supporting documentary observations become
// OBSERVED candidates (observed-candidates.ts). Idempotent — verifying the
// same Proof again writes nothing new. Never promotes, never enables reuse.
//
// TWO FOUNDER-APPROVED RULES (Round 3.5):
//
//   H10 — ONLY A PROOF OF A SUCCESSFUL BOUNDED RESEARCH IS VERIFIABLE. S8
//   may write a DRAFT Proof and the job may still end FAILED afterwards (a
//   crash before the terminal transaction, the stale-RUNNING sweep). That
//   Proof reflects research that was cut off by the run, not by the
//   evidence; verifying it would let a technical failure become project
//   reality. It stays persisted as DRAFT for audit and is refused here.
//   The admitted terminal states are the ones the question projection
//   already admits: SUCCEEDED and BUDGET_LIMIT_REACHED (an honest bounded
//   outcome). A job that is not yet terminal is refused for the same
//   reason — its Proof is not final.
//
//   H9 — VERIFIED IS TERMINAL. Verification is a historical audit event.
//   A VERIFIED Proof never moves back to REVIEWED or DRAFT; a later problem
//   is answered by a new Research and a new Proof, never by rewriting what
//   was verified. Refused here with a closed reason, and again by the
//   database guard (migration 0052) for anything that bypasses this code.
//   Verifying an already VERIFIED Proof is a no-op on the row (no update,
//   no history rewritten) that still reports the candidate picture.
//
//   THE EVENT IS RECORDED (Founder, pre-Round 5): `verified_by` (the ADMIN
//   actor this act already requires) and `verified_at` are written on the
//   one transition into VERIFIED and never again — a repeat leaves both as
//   they were. The database guard (migration 0054) requires both on the
//   transition and an ADMIN actor, exactly as promotion does (D-065).
//   Nothing that decides research reads them.

export type ProofVerificationRefusal =
  // The Proof's job did not end in a successful bounded terminal state.
  | "JOB_NOT_SUCCESSFUL"
  // The Proof is VERIFIED and the requested state is weaker.
  | "VERIFIED_IS_TERMINAL";

export class ProofVerificationRefusedError extends Error {
  constructor(
    public readonly refusal: ProofVerificationRefusal,
    public readonly proofId: string,
    detail: string,
  ) {
    super(`proof verification refused (${refusal}) for ${proofId}: ${detail}`);
    this.name = "ProofVerificationRefusedError";
  }
}

// The job terminal states whose Proof a human may verify. Code-owned and
// closed: RUNNING, QUEUED, FAILED, CANCELLED and AWAITING_CLARIFICATION are
// all refused, whatever the Proof row says.
export const VERIFIABLE_JOB_STATES: ReadonlySet<string> = new Set(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]);

async function loadProofForVerification(tx: Transaction, proofId: string) {
  // FOR UPDATE on the Proof row: two verifications arriving together are
  // serialized, so the second sees the first's committed status.
  const [row] = await tx
    .select({ id: proofs.id, verificationStatus: proofs.verificationStatus, researchJobId: proofs.researchJobId })
    .from(proofs)
    .where(eq(proofs.id, proofId))
    .for("update");
  if (!row) throw new Error(`proof not found: ${proofId}`);
  return row;
}

export async function markProofVerified(
  db: Database,
  proofId: string,
  adminUserId: string,
): Promise<{ id: string; verificationStatus: string; memoryCandidates: ObservedCandidatesResult }> {
  await assertAdmin(db, adminUserId);
  return db.transaction(async (tx) => {
    const proof = await loadProofForVerification(tx, proofId);
    const [job] = await tx.select({ state: researchJobs.state }).from(researchJobs).where(eq(researchJobs.id, proof.researchJobId));
    if (!job || !VERIFIABLE_JOB_STATES.has(job.state)) {
      throw new ProofVerificationRefusedError(
        "JOB_NOT_SUCCESSFUL",
        proofId,
        `research job ${proof.researchJobId} is ${job?.state ?? "missing"}; only a Proof of a job that ended ` +
          `${[...VERIFIABLE_JOB_STATES].join(" / ")} may be verified. The DRAFT stays persisted for audit.`,
      );
    }
    let row: { id: string; verificationStatus: string };
    if (proof.verificationStatus === "VERIFIED") {
      // Already verified: nothing on the row is rewritten — not the
      // status, not the actor, not the time.
      row = { id: proof.id, verificationStatus: proof.verificationStatus };
    } else {
      [row] = await tx
        .update(proofs)
        .set({ verificationStatus: "VERIFIED", verifiedBy: adminUserId, verifiedAt: sql`now()` })
        .where(eq(proofs.id, proofId))
        .returning({ id: proofs.id, verificationStatus: proofs.verificationStatus });
    }
    const memoryCandidates = await writeObservedCandidatesForVerifiedProof(tx, proofId, new Date());
    return { ...row, memoryCandidates };
  });
}

export async function markProofReviewed(
  db: Database,
  proofId: string,
  adminUserId: string,
): Promise<{ id: string; verificationStatus: string }> {
  await assertAdmin(db, adminUserId);
  return db.transaction(async (tx) => {
    const proof = await loadProofForVerification(tx, proofId);
    if (proof.verificationStatus === "VERIFIED") {
      throw new ProofVerificationRefusedError(
        "VERIFIED_IS_TERMINAL",
        proofId,
        "a VERIFIED Proof is a historical audit event and never regresses to REVIEWED; a corrected Research produces a new Proof.",
      );
    }
    const [row] = await tx
      .update(proofs)
      .set({ verificationStatus: "REVIEWED" })
      .where(eq(proofs.id, proofId))
      .returning({ id: proofs.id, verificationStatus: proofs.verificationStatus });
    return row;
  });
}
