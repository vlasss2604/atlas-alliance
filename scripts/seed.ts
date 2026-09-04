import { seed } from "../src/server/db/seed";
import { createDatabase } from "../src/server/db/client";

async function main() {
  const { db, pool } = createDatabase();
  await seed(db);
  await pool.end();
  console.log("seed applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
