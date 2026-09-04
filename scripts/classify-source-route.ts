// OWNER SOURCE-ROUTE CLASSIFICATION — the owner's SECOND decision about a
// route, and deliberately a separate one from confirming it.
//
// `confirm-source-route.ts` states that a host belongs to a project and
// assigns no class. This states that an already-confirmed exact route
// carries a documentary authority class — a judgement that should follow
// READING the page, which is why the two are not one command.
//
// IT CONFIRMS NOTHING AND DISCOVERS NOTHING. It cannot create a host,
// cannot confirm an unconfirmed one, cannot widen a prefix, and never
// fetches, renders or infers. A domain that "looks official" is not an
// input. It acts only on the exact ACTIVE, currently-unclassified route
// the owner names by id.
//
// The route is REPLACED, not edited: a new ACTIVE record carrying the same
// domain and the same prefix plus the class, with the original moved to
// SUPERSEDED and linked by `supersededBy`. That is the lifecycle graph's
// own model and the precedent already in the database. The whole
// transition is one transaction, because two co-matching ACTIVE rows —
// even for an instant — make the matched prefix vanish.
//
// Run:
//   npx tsx scripts/classify-source-route.ts \
//     --route-id=<uuid> --class=<CLASS> --actor=<name>
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createDatabase } from "../src/server/db/client";
import { VALID_ROUTE_CLASSES } from "../src/server/engine/source-authority";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";

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
    "usage: npx tsx scripts/classify-source-route.ts --route-id=<uuid> --class=<CLASS> --actor=<name>",
  );
  console.error("");
  console.error("classes: " + VALID_ROUTE_CLASSES.join(", "));
  console.error("");
  console.error("Classifies an EXACT already-ACTIVE, currently-unclassified route.");
  console.error("It confirms no host, widens no prefix, and reads nothing.");
  console.error("Find the route id with the project's SOURCE_ROUTE records.");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Refused LOUDLY. Someone passing a domain here is trying to confirm a
  // route, which is the other tool's job — and silently ignoring it would
  // let them believe this had acted on the host they named.
  for (const forbidden of ["domain", "prefix", "path-prefix", "project"]) {
    if (args[forbidden] !== undefined) {
      console.error(`[classify-route] refusing: --${forbidden} is not accepted by this tool.`);
      console.error("  Classification acts on an EXACT existing route, named by --route-id.");
      console.error("  Confirming a host is a separate act: scripts/confirm-source-route.ts");
      process.exit(1);
    }
  }

  const routeId = args["route-id"];
  const routeClass = args.class;
  const actor = args.actor;
  if (!routeId || !routeClass || !actor) usage();

  const { db, pool } = createDatabase();
  try {
    console.log("--- source route classification ---");
    console.log("routeId:          " + routeId);
    console.log("class:            " + routeClass);
    // Printed for the operator's own record. It is NOT persisted:
    // project_memory_items has no actor column, deliberately — unlike
    // research_memory, which carries promoted_by. The durable trail here
    // is the supersession link plus created_at on both rows.
    console.log("actor:            " + actor + "   (printed, not persisted — no such column)");

    const result = await classifySourceRoute(db, { routeId, routeClass });

    if (!result.ok) {
      console.error("\n[classify-route] REFUSED: " + result.refusal);
      console.error("  " + result.detail);
      process.exit(1);
    }

    console.log("\n--- transition ---");
    console.log("superseded:       " + result.supersededItemId + "  (now SUPERSEDED)");
    console.log("replacement:      " + result.newItemId + "  (now ACTIVE)");
    console.log("domain:           " + result.domain + "   (unchanged)");
    console.log("pathPrefix:       " + String(result.pathPrefix) + "   (unchanged)");

    console.log("\n--- resolved by the real source-authority resolver ---");
    console.log(
      "before:           " +
        result.before.officiality +
        " / " +
        String(result.before.routeClass) +
        " / prefix=" +
        String(result.before.matchedPathPrefix),
    );
    console.log(
      "after:            " +
        result.after.officiality +
        " / " +
        String(result.after.routeClass) +
        " / prefix=" +
        String(result.after.matchedPathPrefix),
    );

    console.log("\nClassified. The route now carries documentary authority for its exact");
    console.log("prefix and nothing wider. Evidentiary acquisition is possible for this");
    console.log("route; a page outside the prefix is still outside it.");
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error("[classify-route] failed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
