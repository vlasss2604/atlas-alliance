// OWNER ROUTE DECISION — CONFIRM + CLASSIFY IN ONE PREVIEWED WORKFLOW
// (Source Authority Strategy V1).
//
// Two explicit logical decisions, applied atomically and only after the
// owner has seen the preview and re-run with --confirm=yes:
//   1. this host, at this prefix, belongs to the project;
//   2. what sits under that prefix is <CLASS>.
//
// Host, prefix and class are all REQUIRED and taken verbatim. Nothing is
// inferred: the preview shows the engine's candidate provenance and its
// class hint for the owner to read, and neither is ever applied. A
// community host can never be GOVERNANCE, OFFICIAL_DOCS or OFFICIAL_REPORT
// for the whole host or an all-content root (/t, /c, /p, /u, ...).
//
// It fetches nothing and calls no model; read the pages before deciding.
//
// Run (preview, then apply):
//   npx tsx scripts/decide-source-route.ts --project=<slug> --domain=<host> \
//     --prefix=</path> --class=<CLASS> --actor=<name>
//   ... the same flags ... --confirm=yes
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createDatabase } from "../src/server/db/client";
import { VALID_ROUTE_CLASSES } from "../src/server/engine/source-authority";
import { decideOwnerRoute, previewOwnerRouteDecision } from "../src/server/memory/source-route-owner-decision";

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
    "usage: npx tsx scripts/decide-source-route.ts --project=<slug> --domain=<host> --prefix=</path> --class=<CLASS> --actor=<name> [--confirm=yes]",
  );
  console.error("classes: " + VALID_ROUTE_CLASSES.join(", "));
  console.error("Every value is required and explicit; no class is ever taken from a hint.");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = { projectSlug: args.project, domain: args.domain, pathPrefix: args.prefix, routeClass: args.class };
  const actor = args.actor;
  if (!input.projectSlug || !input.domain || !input.pathPrefix || !input.routeClass || !actor) usage();

  const { db, pool } = createDatabase();
  try {
    const preview = await previewOwnerRouteDecision(db, input);
    if (!preview.ok) {
      console.error("[decide-route] REFUSED: " + preview.refusal);
      console.error("  " + preview.detail);
      process.exit(1);
    }

    console.log("--- owner route decision (preview) ---");
    console.log("project:          " + input.projectSlug);
    console.log("decision 1:       " + `${preview.domain} at ${preview.pathPrefix} belongs to the project`);
    console.log("decision 2:       " + `pages under ${preview.domain}${preview.pathPrefix} are ${preview.routeClass}`);
    console.log(
      "today:            " +
        `${preview.current.officiality} / class=${String(preview.current.routeClass)} / prefix=${String(preview.current.matchedPathPrefix)}`,
    );
    console.log("actor:            " + actor + "   (printed, not persisted — no such column)");
    if (preview.candidates.length === 0) {
      console.log("\nNo engine-observed candidate matches this host and prefix.");
    }
    for (const c of preview.candidates) {
      console.log(`\nobserved candidate ${c.id}: ${c.domain}${c.proposedPrefix ?? " (whole host)"}`);
      console.log("  ownership signal: " + (c.signals.join(", ") || "none") + (c.parentConfirmedDomain ? ` (parent ${c.parentConfirmedDomain})` : ""));
      console.log("  read by:          " + (c.components.join(", ") || "-") + `; evidence rows ${c.evidenceCount}`);
      for (const u of c.representativeUrls) console.log("  url:              " + u);
      console.log(
        "  class hint:       " +
          (c.classHint ? `${c.classHint.routeClass} (from ${c.classHint.basis}) — NON-BINDING, not applied` : "none"),
      );
    }

    if (args.confirm !== "yes") {
      console.log("\nPREVIEW ONLY — nothing changed. Read the pages above, then re-run with");
      console.log("--confirm=yes to apply BOTH decisions atomically.");
      return;
    }

    const result = await decideOwnerRoute(db, input);
    if (!result.ok) {
      console.error("\n[decide-route] REFUSED (nothing written): " + result.refusal);
      console.error("  " + result.detail);
      process.exit(1);
    }
    console.log("\n--- applied ---");
    console.log("ownership row:    " + result.confirmedItemId + "  (decision 1, now SUPERSEDED by decision 2)");
    console.log("classified row:   " + result.classifiedItemId + "  (decision 2, ACTIVE)");
    console.log(
      "resolver before:  " + `${result.before.officiality} / ${String(result.before.routeClass)} / prefix=${String(result.before.matchedPathPrefix)}`,
    );
    console.log(
      "resolver after:   " + `${result.after.officiality} / ${String(result.after.routeClass)} / prefix=${String(result.after.matchedPathPrefix)}`,
    );
    console.log("Future Research on this project uses it; nothing outside the prefix changed.");
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error("[decide-route] failed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
