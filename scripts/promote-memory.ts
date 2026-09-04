// D-021/D-055: переход в ACTIVE — только человеком, через контролируемый
// аудируемый скрипт. Не admin UI, не автоматический промоушен моделью.
//
// Запуск: tsx scripts/promote-memory.ts <memoryId> <adminUserId>
import { createDatabase } from "../src/server/db/client";
import { promoteToActive } from "../src/server/memory/lifecycle";

async function main() {
  const [memoryId, adminUserId] = process.argv.slice(2);
  if (!memoryId || !adminUserId) {
    console.error("usage: tsx scripts/promote-memory.ts <memoryId> <adminUserId>");
    process.exit(1);
  }
  const { db, pool } = createDatabase();
  try {
    const row = await promoteToActive(db, memoryId, adminUserId);
    console.log(
      `[promote-memory] ${row.lifecycleState} memory=${row.id} by admin=${row.promotedBy} at=${new Date().toISOString()}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
