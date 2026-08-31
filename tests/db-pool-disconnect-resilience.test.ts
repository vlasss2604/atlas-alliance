import { spawn } from "node:child_process";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDatabase, safeDbErrorLabel } from "../src/server/db/client";
import { TEST_DATABASE_URL } from "./phase1-setup";

const CHILD_SCRIPT = path.join("tests", "fixtures", "db-disconnect-child.ts");

// Polls the child's stdout for the backend pid it reports from inside its
// open transaction. Polling its real output beats sleeping a guessed
// interval: the kill lands only once the transaction genuinely holds a
// connection.
async function waitForPid(read: () => string, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = /PID=(\d+)/.exec(read());
    if (m) return Number(m[1]);
    if (Date.now() > deadline) throw new Error("child never reported a backend pid");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// THE CENTRAL POOL MUST SURVIVE LOSING AN IDLE CONNECTION.
//
// The incident this pins: a FETCH worker sitting between jobs lost its
// PostgreSQL connectivity, node-postgres emitted `error` on the pool for an
// IDLE client, nothing was listening, and Node turned that unhandled
// EventEmitter error into a process exit — killing a worker for a
// connection it was not using and leaving its delivery to expire. The
// control-plane fault was real; converting it into a dead process was not.
//
// These tests use the REAL createDatabase path (not a hand-built pool), so
// they fail if the listener is ever dropped from the canonical factory.
// They open their own small pools rather than the shared fixture, because
// deliberately killing backends inside a fixture other suites share would
// be a different kind of defect.

const pools: Array<{ end: () => Promise<void> }> = [];

function makePool() {
  const created = createDatabase(TEST_DATABASE_URL);
  pools.push(created.pool);
  return created;
}

afterAll(async () => {
  for (const pool of pools) {
    await pool.end().catch(() => {});
  }
});

async function backendPid(pool: ReturnType<typeof makePool>["pool"]): Promise<number> {
  const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(rows[0].pid);
}

// Resolves when the pool reports an idle-client error, so the test observes
// the real event rather than sleeping a guessed interval.
function nextPoolError(
  pool: ReturnType<typeof makePool>["pool"],
  timeoutMs = 10_000,
): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pool.removeListener("error", onError);
      reject(new Error("pool never reported an idle-client error"));
    }, timeoutMs);
    const onError = (err: Error) => {
      clearTimeout(timer);
      resolve(err);
    };
    pool.once("error", onError);
  });
}

describe("central pool: an idle client dying is survivable", () => {
  it("keeps the process alive, purges the dead client, and serves the next query from a fresh backend", async () => {
    const { pool } = makePool();
    const killer = makePool();

    // The production listener must already be attached — this is the whole
    // fix. Node only throws for an `error` event when the listener count is
    // zero, so a non-zero count IS the guarantee that this event can never
    // become an unhandled process-level throw.
    expect(pool.listenerCount("error")).toBeGreaterThan(0);

    // 1-3. Take a connection and record which backend serves it.
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const idlePid = Number(rows[0].pid);

    // 4. Back to the pool: from here the client is IDLE, which is the only
    // state in which pg-pool routes a client error to the pool itself.
    client.release();

    // 5. Kill that backend from an entirely separate connection.
    const observed = nextPoolError(pool);
    await killer.pool.query("SELECT pg_terminate_backend($1)", [idlePid]);

    // 6. The idle-client error path really did run...
    const err = await observed;
    expect(err).toBeInstanceOf(Error);

    // 7. ...and the process is still here to assert it. The production
    // listener is still attached for the next failure, too.
    expect(pool.listenerCount("error")).toBeGreaterThan(0);

    // 8-9. The same pool still works, on a genuinely different backend.
    const freshPid = await backendPid(pool);
    expect(freshPid).toBeGreaterThan(0);
    expect(freshPid).not.toBe(idlePid);

    const alive = await pool.query<{ one: number }>("SELECT 1 AS one");
    expect(alive.rows[0].one).toBe(1);
  }, 30_000);

  it("does not swallow an active query's failure", async () => {
    const { pool } = makePool();

    // A failing query still rejects. The pool listener exists for clients
    // NOBODY holds; it is not an error sink for work in progress.
    await expect(pool.query("SELECT * FROM __atlas_no_such_table__")).rejects.toThrow();

    // And the pool is unharmed by that rejection.
    const alive = await pool.query<{ one: number }>("SELECT 1 AS one");
    expect(alive.rows[0].one).toBe(1);
  }, 30_000);

  it("a connection lost while CHECKED OUT rejects the query instead of reaching the pool handler", async () => {
    const { pool } = makePool();
    const killer = makePool();

    const client = await pool.connect();

    // NO test-owned error listener here, deliberately. An earlier version of
    // this test attached one and thereby supplied the exact cover production
    // was missing — it passed while the real worker died. The listener that
    // keeps this process alive must be the PRODUCTION one, installed by
    // createDatabase on the pool's `connect` event, so assert it is there.
    expect(client.listenerCount("error")).toBeGreaterThan(0);

    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = Number(rows[0].pid);

    let poolSawIt = false;
    const onPoolError = () => {
      poolSawIt = true;
    };
    pool.on("error", onPoolError);

    await killer.pool.query("SELECT pg_terminate_backend($1)", [pid]);

    // The failure surfaces where the caller can act on it — the query, not
    // a background event. Worker and pg-boss retry semantics stay in charge.
    await expect(client.query("SELECT 1")).rejects.toThrow();

    client.release();
    pool.removeListener("error", onPoolError);
    expect(poolSawIt).toBe(false);
  }, 30_000);
});

describe("what a database error is allowed to say", () => {
  it("reports the class name and a shape-checked code, never the message", () => {
    const withCode = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
      code: "ECONNRESET",
    });
    expect(safeDbErrorLabel(withCode)).toBe("Error:ECONNRESET");

    const sqlstate = Object.assign(new Error("terminating connection"), { code: "57P01" });
    expect(safeDbErrorLabel(sqlstate)).toBe("Error:57P01");
  });

  it("refuses a code that could carry a secret, and never leaks the message", () => {
    // A look-alike code containing a connection string must not cross.
    const forged = Object.assign(new Error("boom"), {
      code: "postgres://atlas:hunter2@localhost:5432/atlas",
    });
    expect(safeDbErrorLabel(forged)).toBe("Error");

    const overlong = Object.assign(new Error("boom"), { code: "A".repeat(33) });
    expect(safeDbErrorLabel(overlong)).toBe("Error");

    for (const value of [
      new Error("postgres://atlas:hunter2@localhost:5432/atlas"),
      Object.assign(new Error("x"), { code: 57 }),
      "not an error",
      null,
      undefined,
    ]) {
      const label = safeDbErrorLabel(value);
      expect(label).not.toMatch(/postgres:|hunter2|@|\/|:\/\//);
    }
    expect(safeDbErrorLabel("not an error")).toBe("UnknownError");
  });
});

// ---------------------------------------------------------------- child
// THE CHECKED-OUT CLIENT, OBSERVED AS A REAL PROCESS.
//
// An unhandled EventEmitter `error` kills a process, and a process death is
// not observable from inside the process it kills. This suite therefore
// runs the failure in a child and judges it by its EXIT CODE — the same
// signal the production incident produced.
describe("checked-out client: a transaction losing its connection is survivable", () => {
  it("rejects the transaction, keeps the child alive, and recovers on a fresh backend", async () => {
    const child = spawn(
      process.execPath,
      [path.join("node_modules", "tsx", "dist", "cli.mjs"), CHILD_SCRIPT],
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_DATABASE_URL },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let out = "";
    let errOut = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      errOut += b.toString();
    });

    const exited = new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });

    // Wait for the child to be inside its transaction and tell us which
    // backend is serving it.
    const pid = await waitForPid(() => out);

    // Kill that backend from an entirely separate connection, while the
    // transaction's pg_sleep is genuinely in flight.
    const killer = makePool();
    await killer.pool.query("SELECT pg_terminate_backend($1)", [pid]);

    const code = await exited;

    // The production crash was a NON-ZERO exit with this signature on
    // stderr. Assert against it by name so a regression reads unmistakably.
    expect(errOut).not.toMatch(/Emitted 'error' event on Client instance/);
    expect(out).toContain("TX_REJECTED");
    expect(out).toContain("DONE");
    expect(code).toBe(0);

    // ...and the recovery really used a different, live backend.
    const recovered = /RECOVERED_PID=(\d+)/.exec(out);
    expect(recovered).not.toBeNull();
    expect(Number(recovered?.[1])).not.toBe(pid);
  }, 90_000);
});
