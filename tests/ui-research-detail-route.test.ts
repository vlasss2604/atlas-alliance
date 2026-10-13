import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { groupResearchRuns, relativeAge } from "../src/client/research-model";

// TWO BUGS REPORTED AFTER A FRESH RESEARCH RUN, AND WHAT EACH ONE ACTUALLY WAS.
//
// 1. /research/<valid-job-id> returned a route-level 404 while /research
//    returned 200. Diagnosed to a STALE DEV-SERVER ROUTE TABLE, not to the
//    code: Next's own generated route types had discovered every other route
//    including /api/research-jobs/[id], but not this page. Touching any file
//    under app/ made the server rescan, after which the identical, unchanged
//    file served 200 for every job id tried. There is no code fix to make,
//    so what these tests pin instead is that the ROUTE CONTRACT stays intact —
//    the file lives where the router expects it, reads its param the way
//    Next 16 requires of a client component, never converts a valid id into a
//    404, and is exactly what the index links to. Any of those breaking would
//    turn the same symptom into a real defect.
//
// 2. The project group header appeared to report a far older "last researched"
//    than the newest run listed inside it. Measured against the live page, the
//    header and the newest run agreed exactly — both said "19m ago". The
//    derivation was correct; the LABEL was ambiguous, because "m" reads as
//    months. That is the bug, and the tests below pin the unambiguous label
//    plus the timestamp selection that must keep backing it.

const RESULT_PAGE = "app/(app)/research/[id]/page.tsx";
const INDEX_PAGE = "app/(app)/research/page.tsx";

/* ------------------------------------------------------------------ */
/* DETAIL ROUTE CONTRACT                                               */
/* ------------------------------------------------------------------ */

describe("research detail route — a valid owned job resolves", () => {
  it("TEST 1: the detail page exists at the dynamic path the router expects", () => {
    // The router matches on the folder name. `(app)` is a route group and
    // contributes no url segment; `[id]` is the dynamic segment that makes
    // /research/<job-id> resolvable at all.
    expect(existsSync(RESULT_PAGE)).toBe(true);
    expect(existsSync(INDEX_PAGE)).toBe(true);

    // And the segment folder is literally `[id]` — a differently spelled
    // folder would still typecheck and still 404 forever.
    const segments = readdirSync("app/(app)/research").filter((entry) =>
      statSync(join("app/(app)/research", entry)).isDirectory(),
    );
    expect(segments).toContain("[id]");
  });

  it("TEST 2: a valid dynamic id is never converted into notFound", () => {
    const src = readFileSync(RESULT_PAGE, "utf-8");
    // Nothing in this page may raise a 404 of its own. An unknown or
    // non-owned job is refused by the API, and the page renders that refusal
    // as a message — it must not escalate a fetch outcome into a route miss,
    // which would be indistinguishable from the route being gone.
    expect(src).not.toContain("notFound(");
    expect(src).not.toMatch(/import\s*\{[^}]*\bnotFound\b[^}]*\}/);

    // It is a client component reading the param through useParams — the
    // Next 16 client-side contract. (The server contract, `params` as a
    // Promise, applies to server components and would be a silent mismatch
    // here.)
    expect(src.startsWith('"use client"')).toBe(true);
    expect(src).toContain("useParams");
    expect(src).toContain("useParams<{ id: string }>()");
    // The id is validated for shape only, never for membership: deciding
    // whether the job exists is the server's job.
    expect(src).toContain('typeof params?.id === "string" ? params.id : null');
  });

  it("TEST 3 + 4: an unknown or non-owned job fails safely, as a message", () => {
    const src = readFileSync(RESULT_PAGE, "utf-8");
    // Both cases arrive identically — the API answers 404 for a job that does
    // not exist AND for one this caller does not own, so the client cannot
    // tell them apart and must not try.
    expect(src).toContain('setStatus("error")');
    expect(src).toContain("This research could not be loaded.");

    // Ownership itself is enforced server-side, as a query predicate.
    const route = readFileSync("app/api/research-jobs/[id]/route.ts", "utf-8");
    expect(route).toContain("requireSession");
    expect(route).toContain("eq(researchJobs.userId, session.userId)");
    expect(route).toContain('throw new HttpError(404, "NOT_FOUND")');
    // The Proof is scoped to its owner too, not merely hidden after loading.
    expect(route).toContain("loadProofForJob(db, id, session.userId)");
  });

  it("TEST 5: the index links to exactly the route that exists", () => {
    // A link shape that drifts from the folder shape is the other way this
    // symptom appears, and it looks identical from the outside.
    for (const file of [
      "src/client/components/recent-proof-card.tsx",
      "src/client/components/research-group-card.tsx",
    ]) {
      expect(readFileSync(file, "utf-8"), file).toContain("href={`/research/${");
    }
    // The index renders both entry points a user can click.
    const index = readFileSync(INDEX_PAGE, "utf-8");
    expect(index).toContain("RecentProofCard");
    expect(index).toContain("ResearchGroupCard");
  });
});

/* ------------------------------------------------------------------ */
/* LAST RESEARCHED                                                     */
/* ------------------------------------------------------------------ */

function run(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    state: "SUCCEEDED",
    verdict: "PARTIALLY_SUPPORTED",
    originalQuestion: "Where do the trading fees go?",
    projectSlug: "fixture",
    projectName: "Fixture Project",
    projectTicker: "FIX",
    createdAt: "2026-09-01T15:30:31.031Z",
    finishedAt: "2026-09-01T15:34:38.403Z",
    ...over,
  };
}

describe("research history — last researched is the true newest run", () => {
  it("TEST 6: the group header timestamp is the newest run's, whatever the input order", () => {
    const newest = run({ id: "new", finishedAt: "2026-09-01T15:34:38.403Z" });
    const older = run({ id: "old", finishedAt: "2026-07-02T09:00:00.000Z" });
    const oldest = run({ id: "oldest", finishedAt: "2026-06-01T09:00:00.000Z" });

    // Deliberately shuffled: the answer must not depend on arrival order.
    const groups = groupResearchRuns([older, newest, oldest]);
    expect(groups).toHaveLength(1);
    expect(groups[0].latest.id).toBe("new");
    expect(groups[0].lastAt).toBe("2026-09-01T15:34:38.403Z");
    // The header and the run list are the same fact, so they render the same.
    expect(relativeAge(groups[0].lastAt, Date.parse("2026-09-01T15:53:29.006Z"))).toBe(
      relativeAge(newest.finishedAt, Date.parse("2026-09-01T15:53:29.006Z")),
    );
  });

  it("TEST 7: an old run can never override a newer completed run", () => {
    const groups = groupResearchRuns([
      run({ id: "ancient", finishedAt: "2026-01-01T00:00:00.000Z" }),
      run({ id: "fresh", finishedAt: "2026-09-01T15:34:38.403Z" }),
    ]);
    expect(groups[0].lastAt).toBe("2026-09-01T15:34:38.403Z");

    // Nor can a malformed timestamp sink the newest run. `Date.parse(x) || 0`
    // used to turn "not a date" into the epoch — the OLDEST possible value —
    // so one bad row on the freshest job would have produced exactly the
    // stale header that was reported.
    const withJunk = groupResearchRuns([
      run({ id: "junk", finishedAt: "not-a-date", createdAt: "also-not-a-date" }),
      run({ id: "fresh", finishedAt: "2026-09-01T15:34:38.403Z" }),
    ]);
    expect(withJunk[0].latest.id).toBe("fresh");
    expect(withJunk[0].lastAt).toBe("2026-09-01T15:34:38.403Z");
  });

  it("TEST 7b: a still-running run is dated by when it started", () => {
    // finishedAt is null until it finishes; createdAt is the honest stand-in,
    // and it must still be comparable against finished runs.
    const groups = groupResearchRuns([
      run({ id: "done", finishedAt: "2026-09-01T10:00:00.000Z" }),
      run({ id: "running", state: "RUNNING", verdict: null, finishedAt: null, createdAt: "2026-09-01T14:00:00.000Z" }),
    ]);
    expect(groups[0].latest.id).toBe("running");
    expect(groups[0].lastAt).toBe("2026-09-01T14:00:00.000Z");
  });

  it("TEST 8: several questions in one project do not break latest selection", () => {
    const groups = groupResearchRuns([
      run({ id: "qa-old", originalQuestion: "Question A", finishedAt: "2026-08-01T00:00:00.000Z" }),
      run({ id: "qb-new", originalQuestion: "Question B", finishedAt: "2026-09-01T15:34:38.403Z" }),
      run({ id: "qa-mid", originalQuestion: "Question A", finishedAt: "2026-08-20T00:00:00.000Z" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].questions).toHaveLength(2);
    // The project header follows the newest run across ALL of its questions...
    expect(groups[0].lastAt).toBe("2026-09-01T15:34:38.403Z");
    // ...and each question keeps its own newest, independently.
    const byQuestion = Object.fromEntries(
      groups[0].questions.map((q) => [q.question, q.lastAt]),
    );
    expect(byQuestion["Question B"]).toBe("2026-09-01T15:34:38.403Z");
    expect(byQuestion["Question A"]).toBe("2026-08-20T00:00:00.000Z");
  });

  it("TEST 8b: group ordering is total and stable when timestamps tie", () => {
    const a = groupResearchRuns([
      run({ id: "aaa", projectSlug: "p1" }),
      run({ id: "bbb", projectSlug: "p2" }),
    ]).map((g) => g.projectSlug);
    const b = groupResearchRuns([
      run({ id: "bbb", projectSlug: "p2" }),
      run({ id: "aaa", projectSlug: "p1" }),
    ]).map((g) => g.projectSlug);
    expect(a).toEqual(b);
  });
});

describe("relative age — units a reader cannot misread", () => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");
  const ago = (ms: number) => relativeAge(new Date(now - ms).toISOString(), now);

  it('TEST 6b: "m" never has to mean two things', () => {
    // The whole bug: "19m ago" was read as nineteen MONTHS.
    expect(ago(19 * 60_000)).toBe("19 minutes ago");
    expect(ago(19 * 3_600_000)).toBe("19 hours ago");
    expect(ago(6 * 86_400_000)).toBe("6 days ago");
    expect(ago(63 * 86_400_000)).toBe("2 months ago");

    // No output may still be an ambiguous single-letter abbreviation.
    for (const ms of [60_000, 3_600_000, 86_400_000, 63 * 86_400_000, 800 * 86_400_000]) {
      expect(ago(ms)).not.toMatch(/^\d+[mhd] ago$/);
    }
  });

  it("TEST 6c: every bucket reads correctly at its boundaries", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(20_000)).toBe("just now");
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(59 * 60_000)).toBe("59 minutes ago");
    expect(ago(3_600_000)).toBe("1 hour ago");
    expect(ago(86_400_000)).toBe("1 day ago");
    expect(ago(365 * 86_400_000)).toBe("1 year ago");
    // A future timestamp is clamped rather than rendered as negative.
    expect(relativeAge(new Date(now + 60_000).toISOString(), now)).toBe("just now");
    // And an unusable value renders nothing rather than a wrong time.
    expect(relativeAge(null, now)).toBe("");
    expect(relativeAge("not-a-date", now)).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* GENERALITY                                                          */
/* ------------------------------------------------------------------ */

describe("no project-specific routing or timestamp behaviour", () => {
  it("TEST 9: neither fix knows about any project", () => {
    const codeOf = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const projectNames = /pump|raydium|hyperliquid|\bhype\b|jito|solana/i;
    for (const file of [
      "src/client/research-model.ts",
      RESULT_PAGE,
      INDEX_PAGE,
      "src/client/components/research-group-card.tsx",
    ]) {
      expect(projectNames.test(codeOf(readFileSync(file, "utf-8"))), file).toBe(false);
    }
    // And no job id is special-cased anywhere in the routing path.
    expect(codeOf(readFileSync(RESULT_PAGE, "utf-8"))).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});
