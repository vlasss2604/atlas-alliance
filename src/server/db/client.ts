import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// WHAT MAY BE SAID ABOUT A DATABASE ERROR.
//
// The same discipline every other provider boundary in this repository
// uses: the exception's CLASS NAME, plus one typed detail admitted through
// a code-owned shape check — never the message. A connection error's
// message is the one place a connection string, a host:port, or a
// credential can appear verbatim, so there is no redaction step here to
// get subtly wrong: the message is never read at all.
//
// The second gate is not decoration. `code` arrives on an object this
// process did not construct, so it is admitted only if it matches a shape
// that structurally cannot carry a secret: letters, digits and underscore,
// at most 32 of them. That excludes ':' , '/', '@', '.', '=' and
// whitespace, which is every character a URL, a host:port pair or a
// password would need. Both PostgreSQL SQLSTATEs (`57P01`) and Node system
// codes (`ECONNRESET`) pass it unchanged.
const SAFE_DB_ERROR_CODE = /^[A-Za-z0-9_]{1,32}$/;

export function safeDbErrorLabel(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  const code: unknown = (err as { code?: unknown }).code;
  if (typeof code === "string" && SAFE_DB_ERROR_CODE.test(code)) {
    return err.name + ":" + code;
  }
  return err.name;
}

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString });

  // AN IDLE CLIENT DYING MUST NOT KILL THE PROCESS.
  //
  // A pooled connection can die while nobody is using it — the database
  // restarts, an administrator terminates the backend, or the network
  // between this process and PostgreSQL is interrupted. node-postgres
  // reports that through the POOL's own `error` event (pg-pool's
  // `makeIdleListener`), and an EventEmitter `error` with no listener is a
  // process-level throw. So a worker sitting idle between jobs died for a
  // connection it was not even using, taking its in-flight delivery down
  // with it. That is a control-plane fault being converted into a research
  // failure, which it is not.
  //
  // This listener is installed SYNCHRONOUSLY with the pool: a pool that
  // exists for even one tick without it is a pool that can still crash the
  // process.
  //
  // SCOPE — this is deliberately not a "swallow database errors" hook, and
  // pg-pool's own design is what bounds it. The idle listener is attached
  // to a client only on release (`_release`) and removed again on acquire
  // (`_acquireClient`), so this event fires ONLY for clients nobody holds.
  // An error on a CHECKED-OUT client never reaches here: it rejects the
  // query or the transaction exactly as before, and worker/pg-boss retry
  // semantics stay authoritative over it.
  //
  // Recovery needs no code of its own. pg-pool calls `_remove(client)`
  // before emitting, so the dead client is already purged when this runs;
  // the next query opens a fresh connection through the ordinary pool
  // lifecycle. No custom reconnect loop exists, and none should be added.
  pool.on("error", (err) => {
    console.error("[db pool] idle client error:", safeDbErrorLabel(err));
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}
