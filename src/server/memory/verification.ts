import { eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { proofs } from "../db/schema";
import { assertAdmin } from "./lifecycle";

// D-041/D-055: VERIFIED гейтит промоушен в ACTIVE-память, не появление
// кандидата. Выставляется контролируемым, аудируемым действием админа —
// не автоматическим промоушеном моделью, не через admin UI (не строится
// в Фазе 5). Аудит — явная проверка роли + вызывающий скрипт печатает
// подтверждение (см. scripts/verify-proof.ts).
export async function markProofVerified(
  db: Database,
  proofId: string,
  adminUserId: string,
): Promise<{ id: string; verificationStatus: string }> {
  await assertAdmin(db, adminUserId);
  const [row] = await db
    .update(proofs)
    .set({ verificationStatus: "VERIFIED" })
    .where(eq(proofs.id, proofId))
    .returning({ id: proofs.id, verificationStatus: proofs.verificationStatus });
  if (!row) throw new Error(`proof not found: ${proofId}`);
  return row;
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
