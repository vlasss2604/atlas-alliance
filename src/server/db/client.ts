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

  // A CHECKED-OUT CLIENT DYING MUST NOT KILL THE PROCESS EITHER.
  //
  // The pool listener above covers exactly one half of the problem, because
  // pg-pool routes a client error to the POOL only while that client is
  // idle — it detaches its own listener on acquire. A client checked out by
  // a Drizzle transaction (`db.transaction()` takes one for the whole
  // transaction) therefore has no pool-level cover at all, and pg emits the
  // socket failure directly on the CLIENT (`Client._handleErrorEvent`).
  // With nothing listening there, Node kills the process:
  // "Emitted 'error' event on Client instance". A worker died mid-transaction
  // for the same environmental cause the pool listener already survives.
  //
  // So every physical connection gets a permanent client-level listener,
  // installed here rather than at each call site. `connect` is the right
  // seam for three reasons: pg-pool emits it once per NEW client
  // (`_acquireClient(..., isNew=true)`), it fires BEFORE `acquire` and
  // before the client is handed to the caller — so no application work can
  // ever touch a client that lacks the listener — and because it is once
  // per connection rather than per checkout, listeners cannot accumulate.
  //
  // The listener is permanent by design: it is never removed, so it covers
  // the client while idle, while checked out, and for the whole life of a
  // transaction. The pool-level handler is untouched and still fires for
  // idle clients; the two report from different boundaries and say so,
  // which is why one idle failure legitimately logs both lines.
  //
  // THIS DOES NOT SWALLOW ANYTHING, and pg's own ordering is the proof.
  // `_handleErrorEvent` sets `_queryable = false`, calls
  // `_errorAllQueries(err)` — rejecting every in-flight query and thereby
  // the transaction — and only THEN emits `error`. The rejection has
  // already happened before this handler can run, so an active query or
  // transaction still fails exactly as it did before, at the caller, where
  // worker and pg-boss retry semantics remain authoritative. There is no
  // SQL retry, no transaction replay, and no rejection is absorbed here.
  pool.on("connect", (client) => {
    client.on("error", (err) => {
      console.error("[db client] connection error:", safeDbErrorLabel(err));
    });
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}
