// OWNER SOURCE-RESOURCE REGISTRATION (D-148) — the controlled human
// entrypoint for approving one EXACT url as worth fetching for a project.
//
// D-021/D-055 discipline, same as its route siblings: a transition to
// ACTIVE happens only by a human, through a controlled auditable script —
// not a model, not an admin UI, not hand-written SQL.
//
// WHAT IT IS NOT. It grants NO authority. A resource never carries a
// routeClass and never reaches Evidence; it only puts a url in front of
// the ordinary bounded acquisition path, and what that url is worth is
// decided at acquisition time by the route resolver, every time. It is
// also not a claim that the document exists, is readable, or supports
// anything: registration means "a human approved attempting this", never
// "fetched successfully" and never "proves a claim".
//
// It performs NO acquisition, fetch, render, extraction or model call —
// no provider, no renderer, no HTTP client is in its import graph. It
// reads the database to verify, against the authoritative record, that
// the url resolves for THIS project through an ACTIVE route carrying a
// non-null routeClass. Asserting that from the command line would make
// the check theatre; a confirmed host is not documentation authority.
//
// Run:
//   npx tsx scripts/register-source-resource.ts \
//     --project=<slug> --url=<https url> --components=A,B [--actor=<name>]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createDatabase } from "../src/server/db/client";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";

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
    "usage: npx tsx scripts/register-source-resource.ts --project=<slug> --url=<https url> --components=<A,B> [--actor=<name>]",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !args.url || !args.components) usage();
  const componentKeys = args.components
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const { db, pool } = createDatabase();
  try {
    // The vocabulary comes from the ACTIVE pattern itself — no second list
    // to drift, and a component this pattern does not define is refused.
    const valid = await loadActivePatternComponents(db);
    if (valid.size === 0) {
      console.error("no ACTIVE pattern components could be loaded; cannot validate coverage");
      process.exit(1);
    }

    const result = await registerSourceResource(
      db,
      { projectSlug: args.project, url: args.url, componentKeys },
      valid,
    );

    if (!result.ok) {
      console.error(`REFUSED: ${result.refusal}`);
      console.error(`  ${result.detail}`);
      if (result.refusal === "UNKNOWN_COMPONENT_KEY") {
        console.error(`  known components: ${[...valid].sort().join(", ")}`);
      }
      process.exit(1);
    }

    console.log("SOURCE_RESOURCE registered (ACTIVE)");
    console.log("  itemId:        " + result.itemId);
    console.log("  project:       " + args.project + " (" + result.projectId + ")");
    console.log("  canonicalUrl:  " + result.canonicalUrl);
    console.log("  components:    " + result.componentKeys.join(", "));
    console.log("  --- authority AS RESOLVED NOW (not stored on the resource) ---");
    console.log("  officiality:   " + result.resolvedAtRegistration.officiality);
    console.log("  routeClass:    " + String(result.resolvedAtRegistration.routeClass));
    console.log("  matchedPrefix: " + String(result.resolvedAtRegistration.matchedPathPrefix));
    console.log("");
    console.log("This grants no authority. The route resolver decides the class of anything");
    console.log("acquired from this url, at acquisition time, every time.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("REGISTRATION FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
