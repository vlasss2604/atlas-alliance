// OWNER ROUTE-CANDIDATE REJECTION (Source Authority Strategy V1).
//
// Moves ONE engine-observed route candidate OBSERVED -> DEPRECATED, so the
// observer stops proposing that exact host (or host + prefix) for the
// project. It confirms nothing, classifies nothing, removes no ACTIVE
// route and fetches nothing.
//
// Without --confirm=yes it only shows what would be rejected.
//
// Run:
//   npx tsx scripts/reject-route-candidate.ts \
//     --project=<slug> --candidate-id=<uuid> --actor=<name> [--confirm=yes]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { loadRouteCandidateReview, rejectRouteCandidate } from "../src/server/memory/source-route-candidate-review";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_-]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectSlug = args.project;
  const candidateId = args["candidate-id"];
  const actor = args.actor;
  if (!projectSlug || !candidateId || !actor) {
    console.error("usage: npx tsx scripts/reject-route-candidate.ts --project=<slug> --candidate-id=<uuid> --actor=<name> [--confirm=yes]");
    process.exit(1);
  }
  const { db, pool } = createDatabase();
  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug));
    if (!project) {
      console.error(`[reject-candidate] unknown project "${projectSlug}"`);
      process.exit(1);
    }
    const review = await loadRouteCandidateReview(db, project.id);
    const item = [...review.pending, ...review.covered].find((c) => c.id === candidateId);
    console.log("--- route candidate rejection ---");
    console.log("project:          " + projectSlug);
    console.log("candidate:        " + candidateId);
    if (item) {
      console.log("host:             " + item.domain + (item.proposedPrefix ? `  proposed prefix ${item.proposedPrefix}` : "  (whole host)"));
      console.log("read by:          " + (item.components.join(", ") || "-"));
      for (const u of item.representativeUrls) console.log("url:              " + u);
    }
    // Printed, not persisted — project_memory_items has no actor column.
    console.log("actor:            " + actor + "   (printed, not persisted — no such column)");

    if (args.confirm !== "yes") {
      console.log("\nPREVIEW ONLY — nothing changed. Re-run with --confirm=yes to reject.");
      return;
    }
    const result = await rejectRouteCandidate(db, { projectSlug, candidateId });
    if (!result.ok) {
      console.error("\n[reject-candidate] REFUSED: " + result.refusal);
      console.error("  " + result.detail);
      process.exit(1);
    }
    console.log("\nRejected (now DEPRECATED). Research will not propose this again;");
    console.log("no ACTIVE route, class or authority was touched.");
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error("[reject-candidate] failed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
