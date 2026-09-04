// CHILD PROCESS FOR THE CHECKED-OUT-CLIENT DISCONNECT REGRESSION.
//
// This runs in its OWN process on purpose. An unhandled EventEmitter
// `error` is a process-level event, so it is only observable as what it
// actually is — a dead worker — from outside. A previous in-process test
// attached its own listener to the checked-out client and, by doing so,
// supplied the very cover production was missing: it passed while the real
// worker crashed. That mistake is why this file exists.
//
// NOTHING HERE MAY MASK THE FAILURE. No `client.on("error")`, no
// `process.on("uncaughtException")`, no `unhandledRejection` handler, no
// try/catch around anything but the transaction whose rejection is the
// assertion itself. The only protection in play is the one installed by
// `createDatabase`, which is exactly what is under test.
//
// Protocol on stdout, one marker per line, read by the parent:
//   PID=<n>            the backend serving the open transaction
//   TX_REJECTED        the transaction rejected, as it must
//   RECOVERED_PID=<n>  a later query succeeded on a fresh backend
//   DONE               reached the end and is exiting 0
import { sql } from "drizzle-orm";

import { createDatabase } from "../../src/server/db/client";

function say(line: string): void {
  process.stdout.write(line + "\n");
}

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set for the child");

  const { db, pool } = createDatabase(url);

  // A real Drizzle transaction: it checks out one client and holds it for
  // the whole callback, which is the production shape that crashed.
  let rejected = false;
  try {
    await db.transaction(async (tx) => {
      const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      say("PID=" + String(pid.rows[0].pid));

      // Long enough for the parent to terminate this backend while the
      // query is genuinely in flight inside the transaction.
      await tx.execute(sql`SELECT pg_sleep(30)`);
      say("UNEXPECTED_SLEEP_COMPLETED");
    });
  } catch {
    // The rejection is the point. It is caught here only so the child can
    // report it and go on to prove recovery — never to hide it.
    rejected = true;
  }

  if (!rejected) {
    say("TX_DID_NOT_REJECT");
    await pool.end();
    process.exit(2);
  }
  say("TX_REJECTED");

  // The dead client has been purged by the ordinary pool lifecycle, so the
  // same pool must serve the next query from a fresh backend.
  const recovered = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  say("RECOVERED_PID=" + String(recovered.rows[0].pid));

  const one = await pool.query<{ one: number }>("SELECT 1 AS one");
  if (one.rows[0].one !== 1) {
    say("SELECT_1_FAILED");
    await pool.end();
    process.exit(3);
  }

  await pool.end();
  say("DONE");
  process.exit(0);
}

main().catch((e) => {
  // A failure to even set up is a distinct, visible outcome — it must not
  // be mistaken for the crash this test is looking for.
  say("CHILD_SETUP_ERROR:" + (e instanceof Error ? e.name : "unknown"));
  process.exit(4);
});
