// OWNER ROUTE-CANDIDATE REVIEW (Source Authority Strategy V1) — READ-ONLY.
//
// Lists every OBSERVED route candidate the engine recorded for a project,
// best first, with the facts an owner needs to decide: ownership signals,
// which (critical) components read it, how much it yielded, representative
// urls, whether it is a community host, and a NON-BINDING class hint.
//
// It writes nothing, fetches nothing and calls no model. The decisions it
// leads to are separate owner commands:
//   accept: scripts/decide-source-route.ts (confirm + classify, previewed)
//   reject: scripts/reject-route-candidate.ts
//
// Run:
//   npx tsx scripts/review-route-candidates.ts --project=<slug>
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { loadRouteCandidateReview, type RouteCandidateReviewItem } from "../src/server/memory/source-route-candidate-review";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_-]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function printItem(n: number, c: RouteCandidateReviewItem): void {
  console.log(`\n#${n}  ${c.domain}${c.proposedPrefix ? `  proposed prefix ${c.proposedPrefix}` : "  (whole host)"}`);
  console.log(`    candidate id:     ${c.id}`);
  console.log(`    ownership signal: ${c.signals.length > 0 ? c.signals.join(", ") : "none"}${c.parentConfirmedDomain ? ` (parent ${c.parentConfirmedDomain})` : ""}`);
  console.log(`    read by:          ${c.components.join(", ") || "-"}`);
  console.log(`    critical:         ${c.criticalComponents.join(", ") || "-"}`);
  console.log(`    evidence rows:    ${c.evidenceCount}`);
  for (const u of c.representativeUrls) console.log(`    url:              ${u}`);
  if (c.communityHost) {
    console.log("    COMMUNITY HOST:   GOVERNANCE / OFFICIAL_DOCS / OFFICIAL_REPORT are refused for the");
    console.log("                      whole host and for all-content roots (/t, /c, /p, /u, ...);");
    console.log("                      review the pages and choose a narrower prefix.");
  }
  console.log(
    `    class hint:       ${c.classHint ? `${c.classHint.routeClass} (from ${c.classHint.basis}) — NON-BINDING, never applied` : "none"}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error("usage: npx tsx scripts/review-route-candidates.ts --project=<slug>");
    process.exit(1);
  }
  const { db, pool } = createDatabase();
  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, args.project));
    if (!project) {
      console.error(`[review-candidates] unknown project "${args.project}"`);
      process.exit(1);
    }
    const review = await loadRouteCandidateReview(db, project.id);
    console.log(`--- route candidates for ${args.project} (read-only) ---`);
    console.log("Observed by Research. None of these confers ownership, class or authority.");
    if (review.pending.length === 0) console.log("\n(no candidate waiting for a decision)");
    review.pending.forEach((c, i) => printItem(i + 1, c));
    if (review.covered.length > 0) {
      console.log(`\n--- already covered by an ACTIVE route (no action needed): ${review.covered.length} ---`);
      for (const c of review.covered) console.log(`    ${c.domain}${c.proposedPrefix ?? ""}  (${c.id})`);
    }
    console.log("\nNext:");
    console.log("  accept: npx tsx scripts/decide-source-route.ts --project=<slug> --domain=<host> --prefix=</path> --class=<CLASS> --actor=<name>");
    console.log("  reject: npx tsx scripts/reject-route-candidate.ts --project=<slug> --candidate-id=<id> --actor=<name>");
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error("[review-candidates] failed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
