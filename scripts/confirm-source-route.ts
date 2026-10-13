// OWNER SOURCE-ROUTE CONFIRMATION — the controlled human entrypoint for
// confirming that a domain belongs to a project.
//
// D-021/D-055: a transition to ACTIVE happens only by a human, through a
// controlled auditable script — not an admin UI, not a model, not
// hand-written SQL. `promote-memory.ts` is that script for
// `research_memory`. Nothing was that script for `project_memory_items`,
// so confirming a route had no supported path at all: every owner
// entrypoint is banned from route management by its own boundary test, and
// the project-item lifecycle function had no caller anywhere. This is the
// missing sibling.
//
// IT ASSIGNS NO ROUTE CLASS, and there is no flag that would let it.
// Confirming that a host belongs to a project is one judgement; deciding
// that a page carries documentation authority is a different one that
// should follow reading the page rather than precede it. So the result is
// always officiality CONFIRMED with routeClass null, which opens
// NON-EVIDENTIARY inspection and nothing else — evidentiary acquisition
// and both renderer-as-Evidence entry points require a non-null class and
// keep refusing. Classification stays a separate, later owner act.
//
// It performs no acquisition, no fetch, no inspection and no extraction:
// no provider, no renderer, no HTTP client and no model is in its import
// graph, and a test asserts it.
//
// Run:
//   npx tsx scripts/confirm-source-route.ts \
//     --project=<slug> --domain=<host> --prefix=</path> --actor=<name>
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createDatabase } from "../src/server/db/client";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_-]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function usage(): never {
  console.error(
    "usage: npx tsx scripts/confirm-source-route.ts --project=<slug> --domain=<host> --prefix=</path> --actor=<name>",
  );
  console.error("");
  console.error("Confirms a domain as belonging to the project, at one bounded path prefix.");
  console.error("It assigns NO route class: classification is a separate later decision,");
  console.error("made after the page has actually been read.");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Refused LOUDLY rather than ignored. Someone reaching for this flag is
  // trying to classify, and silently dropping it would let them believe
  // they had.
  for (const forbidden of ["route-class", "routeClass", "route_class", "class"]) {
    if (args[forbidden] !== undefined) {
      console.error(`[confirm-route] refusing: --${forbidden} is not accepted by this tool.`);
      console.error("  Confirming a domain and classifying a page are separate decisions.");
      console.error("  Confirm the route, inspect the page, and classify it afterwards.");
      process.exit(1);
    }
  }

  const projectSlug = args.project;
  const domain = args.domain;
  const pathPrefix = args.prefix;
  const actor = args.actor;
  if (!projectSlug || !domain || !pathPrefix || !actor) usage();

  const { db, pool } = createDatabase();
  try {
    console.log("--- source route confirmation ---");
    console.log("project:          " + projectSlug);
    console.log("domain:           " + domain);
    console.log("prefix:           " + pathPrefix);
    // Printed for the operator's own record. It is NOT persisted:
    // project_memory_items has no actor column, deliberately — unlike
    // research_memory, which carries promoted_by. The durable audit trail
    // is the row's lifecycle state and created_at. Inventing a field to
    // hold this would be inventing provenance.
    console.log("actor:            " + actor + "   (printed, not persisted — no such column)");

    const result = await confirmSourceRoute(db, { projectSlug, domain, pathPrefix });

    if (!result.ok) {
      console.error("\n[confirm-route] REFUSED: " + result.refusal);
      console.error("  " + result.detail);
      process.exit(1);
    }

    console.log("\n--- created ---");
    console.log("memoryItemId:     " + result.itemId);
    console.log("kind:             SOURCE_ROUTE");
    console.log("lifecycleState:   ACTIVE   (OBSERVED -> CANDIDATE -> ACTIVE)");
    console.log("content:          " + JSON.stringify({ domain: result.domain, pathPrefix: result.pathPrefix }));

    console.log("\n--- resolved by the real source-authority resolver ---");
    console.log("url:              " + `https://${result.domain}${result.pathPrefix}`);
    console.log("officiality:      " + result.resolved.officiality);
    console.log("routeClass:       " + String(result.resolved.routeClass));
    console.log("matchedPrefix:    " + String(result.resolved.matchedPathPrefix));
    console.log("observation:      " + String(result.resolved.observation));

    // The one invariant this tool exists to keep. Checked against the
    // resolver rather than against what was written, because the resolver
    // combines every ACTIVE row and is the only thing that knows the
    // answer.
    if (result.resolved.routeClass !== null) {
      console.error("\n[confirm-route] INVARIANT VIOLATED: routeClass resolved non-null.");
      console.error("  This tool promises an unclassified route. The row is ACTIVE and must");
      console.error("  be reviewed by hand — do not treat this route as unclassified.");
      process.exit(1);
    }

    console.log("\nConfirmed. This opens NON-EVIDENTIARY inspection only:");
    console.log("  npx tsx scripts/inspect-official-page.ts https://" + result.domain + result.pathPrefix + " " + projectSlug);
    console.log("Evidentiary acquisition and renderer-as-Evidence remain refused while");
    console.log("routeClass is null. Classify only after reading the page.");
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error("[confirm-route] failed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
