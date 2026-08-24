// OWNER INSPECTION — render one confirmed-official page to stdout so a
// human can read it before deciding whether it deserves documentation
// authority.
//
// EXPLICITLY NON-EVIDENTIARY. This entrypoint:
//   * writes NO evidence and NO facts — it imports no evidence table, no
//     persistence module, and performs no insert/update/delete anywhere;
//   * enters NO part of S5/S6/S7 — none of those modules is in its import
//     graph;
//   * makes NO model call — no EvidenceExtractor, no QueryProposer, no
//     Anthropic client;
//   * assigns NO routeClass and promotes NO memory — deciding whether a
//     page is documentation stays a human act performed afterwards;
//   * spends NO research budget — it is not a research job.
//
// It DOES read the database, and that is deliberate: the gate below has to
// verify against project memory that the page is human-confirmed, matched
// at a path prefix, and NOT already classified. Enforcing that from the
// authoritative record is the entire point of the gate — asserting it from
// a command-line flag would make the check theatre. The read is confined
// to resolveSourceRoute, which issues a single SELECT. The accompanying
// test asserts this file contains no write call and imports no evidence,
// memory-promotion, S5-S7, or model module.
//
// Security: reuses the isolated renderer boundary wholesale — child
// process, scrubbed environment allowlist, deny-by-default egress proxy
// pinned to the confirmed host, cross-origin blocked, one navigation,
// bounded time and size, zero retry, teardown after use.
//
// Run: npx tsx scripts/inspect-official-page.ts <https url>
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { evaluateInspectionEligibility } from "../src/server/engine/inspection-eligibility";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";
import { RenderedDocsError } from "../src/server/engine/providers/rendered-docs-fetcher";

async function main(): Promise<void> {
  const url = process.argv[2];
  const slug = process.argv[3] ?? "pump_fun";
  if (!url) {
    console.error("usage: npx tsx scripts/inspect-official-page.ts <https url> [projectSlug]");
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  let eligible: { confirmedHost: string; matchedPathPrefix: string };
  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) throw new Error(`project not found: ${slug}`);
    const route = await resolveSourceRoute(db, project.id, url);
    console.log("officiality:      " + route.officiality);
    console.log("routeClass:       " + String(route.routeClass));
    console.log("matchedPrefix:    " + String(route.matchedPathPrefix));

    const decision = evaluateInspectionEligibility(url, route);
    if (!decision.eligible) {
      console.error("NOT ELIGIBLE FOR INSPECTION: " + decision.reason);
      process.exit(1);
    }
    eligible = decision;
  } finally {
    // The database connection is closed BEFORE the render begins, so the
    // renderer runs with no open handle to ATLAS data at all.
    await pool.end();
  }

  console.log("--- NON-EVIDENTIARY inspection render (one navigation) ---");
  const doc = await createIsolatedRenderedDocsFetcher().render(url, {
    confirmedHost: eligible.confirmedHost,
    matchedPathPrefix: eligible.matchedPathPrefix,
  });

  console.log("finalUrl:         " + doc.finalUrl);
  console.log("browserVersion:   " + doc.browserVersion);
  console.log("htmlBytes:        " + doc.byteLength);
  console.log("renderedLength:   " + doc.renderedTextLength);
  console.log("blockedRequests:  " + doc.blockedRequestCount);
  console.log("durationMs:       " + doc.renderDurationMs);
  console.log("contentHash:      " + doc.contentHash);
  const lower = doc.normalizedText.toLowerCase();
  console.log("--- term scan ---");
  for (const term of ["buyback", "buy back", "treasury", "burn", "revenue", "vault", "program", "wallet", "fee"]) {
    console.log("  " + term.padEnd(10) + (lower.includes(term) ? "FOUND" : "absent"));
  }
  // Machine-readable identifiers the plain-text conversion discards.
  // OBSERVATIONS ONLY — nothing here is trusted, classified, or promoted.
  const dl = doc.documentLinks;
  console.log("--- links / identifiers (observations only) ---");
  console.log("  anchors:      " + (dl ? dl.links.length : 0));
  console.log("  identifiers:  " + (dl ? dl.identifiers.length : 0));
  console.log("  hosts:        " + (dl ? dl.hosts.join(", ") || "(none)" : "(none)"));
  if (dl) {
    for (const id of dl.identifiers.slice(0, 40)) {
      console.log("    [" + id.shape + "] " + id.attribute + " = " + id.value);
    }
    for (const l of dl.links.slice(0, 60)) {
      console.log("    <a> " + l.href + "   :: " + l.text.slice(0, 80));
    }
  }
  console.log("--- rendered text ---");
  console.log(doc.normalizedText);
  console.log("--- end (nothing persisted; no classification assigned) ---");
}

main().catch((e) => {
  console.error(
    "INSPECTION FAILED: " + (e instanceof RenderedDocsError ? e.reason : String(e?.message ?? e)),
  );
  process.exit(1);
});
