import { describe, expect, it } from "vitest";

import journal from "../src/server/db/migrations/meta/_journal.json";

// D-125: drizzle-orm's own migrator (pg-core/dialect.ts, PgDialect.migrate)
// decides which journal entries are "already applied" by comparing each
// entry's `when` against the MAXIMUM created_at already recorded in
// drizzle.__drizzle_migrations — not by position/count. A single
// out-of-order `when` (found in 0015_s5_backfill_component_requirements,
// which carried a `when` later than 0016-0022) silently and permanently
// blocks every later migration whose real timestamp falls below it,
// with no error from `npm run db:migrate` — it just reports success and
// changes nothing. This test fails fast on the exact defect class, using
// only the journal file (no DB), so it fails locally before anyone hits
// the confusing "migrate says success but nothing happened" symptom.
describe("migration journal — D-125 monotonic `when` order", () => {
  it("every entry's `when` is strictly greater than the previous entry's, in idx order", () => {
    const entries = journal.entries as { idx: number; when: number; tag: string }[];
    expect(entries.length).toBeGreaterThan(0);

    const sortedByIdx = [...entries].sort((a, b) => a.idx - b.idx);
    expect(sortedByIdx.map((e) => e.idx)).toEqual(entries.map((_, i) => i));

    for (let i = 1; i < sortedByIdx.length; i += 1) {
      const prev = sortedByIdx[i - 1];
      const cur = sortedByIdx[i];
      expect(
        cur.when,
        `journal entry ${cur.idx} (${cur.tag}) has when=${cur.when}, which is not ` +
          `strictly greater than entry ${prev.idx} (${prev.tag})'s when=${prev.when} — ` +
          `drizzle-orm's migrator compares against MAX(created_at), so an earlier ` +
          `entry with a later timestamp silently blocks every migration after it`,
      ).toBeGreaterThan(prev.when);
    }
  });
});
