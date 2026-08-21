// D-055: минимальный аудируемый механизм — не admin UI. Владелец/админ
// запускает это вручную, с explicit adminUserId; печатается подтверждение
// с актёром, целью и временем — весь аудит-след, который требуется
// операционному механизму Фазы 5 (полноценный лог — Фаза 9).
//
// Запуск: tsx scripts/verify-proof.ts <proofId> <adminUserId> [reviewed]
import { createDatabase } from "../src/server/db/client";
import { markProofReviewed, markProofVerified } from "../src/server/memory/verification";

async function main() {
  const [proofId, adminUserId, mode] = process.argv.slice(2);
  if (!proofId || !adminUserId) {
    console.error("usage: tsx scripts/verify-proof.ts <proofId> <adminUserId> [reviewed]");
    process.exit(1);
  }
  const { db, pool } = createDatabase();
  try {
    const row =
      mode === "reviewed"
        ? await markProofReviewed(db, proofId, adminUserId)
        : await markProofVerified(db, proofId, adminUserId);
    console.log(
      `[verify-proof] ${row.verificationStatus} proof=${row.id} by admin=${adminUserId} at=${new Date().toISOString()}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
