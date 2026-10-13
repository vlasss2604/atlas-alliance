import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabase } from "../src/server/db/client";

async function main() {
  const { db, pool } = createDatabase();
  await migrate(db, { migrationsFolder: "./src/server/db/migrations" });
  await pool.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
