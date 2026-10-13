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
    if (mode === "reviewed") {
      const row = await markProofReviewed(db, proofId, adminUserId);
      console.log(
        `[verify-proof] ${row.verificationStatus} proof=${row.id} by admin=${adminUserId} at=${new Date().toISOString()}`,
      );
    } else {
      const row = await markProofVerified(db, proofId, adminUserId);
      console.log(
        `[verify-proof] ${row.verificationStatus} proof=${row.id} by admin=${adminUserId} at=${new Date().toISOString()}`,
      );
      const c = row.memoryCandidates;
      console.log(
        `[verify-proof] research memory OBSERVED candidates: created=${c.created.length} deduplicated=${c.deduplicated.length} refused=${c.refused.length}`,
      );
      for (const x of c.created) console.log(`  created  ${x.step}:${x.component} memory=${x.memoryId} evidence=${x.evidenceId}`);
      for (const x of c.deduplicated) console.log(`  existing ${x.step}:${x.component} memory=${x.memoryId} evidence=${x.evidenceId}`);
      for (const x of c.refused) console.log(`  refused  ${x.step}:${x.component} evidence=${x.evidenceId} reason=${x.reason}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
