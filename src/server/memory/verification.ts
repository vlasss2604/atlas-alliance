import { eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { proofs } from "../db/schema";
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
export async function markProofVerified(
  db: Database,
  proofId: string,
  adminUserId: string,
): Promise<{ id: string; verificationStatus: string; memoryCandidates: ObservedCandidatesResult }> {
  await assertAdmin(db, adminUserId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(proofs)
      .set({ verificationStatus: "VERIFIED" })
      .where(eq(proofs.id, proofId))
      .returning({ id: proofs.id, verificationStatus: proofs.verificationStatus });
    if (!row) throw new Error(`proof not found: ${proofId}`);
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
  const [row] = await db
    .update(proofs)
    .set({ verificationStatus: "REVIEWED" })
    .where(eq(proofs.id, proofId))
    .returning({ id: proofs.id, verificationStatus: proofs.verificationStatus });
  if (!row) throw new Error(`proof not found: ${proofId}`);
  return row;
}
