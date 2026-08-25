// OWNER DOCS INSPECTION — render one page that ALREADY holds
// documentation authority, to stdout, so a human can read what the
// plain-text research path would see AND what it discards.
//
// This is the sibling of scripts/inspect-official-page.ts and must not be
// confused with it. That one serves the UNDECIDED case (confirmed domain,
// no routeClass yet). This one serves the DECIDED case. Neither weakens
// the other: they are separate files, separate gates, separate reasons,
// and the older gate is untouched by this one existing.
//
// EXPLICITLY NON-EVIDENTIARY. This entrypoint:
//   * writes nothing — it imports no persistence module for research
//     output and performs no insert/update/delete anywhere;
//   * closes the database BEFORE rendering, so after the gate resolves
//     there is no open ATLAS handle at all and no write is possible even
//     in principle;
//   * enters NO part of S5/S6/S7 — none of those modules is in its import
//     graph;
//   * makes NO model call — no extractor, no proposer, no vendor client;
//   * makes NO chain call — no retriever, no transport;
//   * makes NO search call;
//   * promotes NO memory and assigns NO class — what a page is worth
//     stays a human decision made afterwards;
//   * spends NO research budget — it is not a research job.
//
// It DOES read the database once, and that is deliberate: the gate has to
// verify against project memory that the page is human-confirmed, path
// scoped, and carries documentation authority. Enforcing that from the
// authoritative record is the entire point — asserting it from a
// command-line flag would make the check theatre.
//
// UNREACHABLE FROM THE ENGINE. Nothing under src/ may import this file or
// its gate; that is asserted by test, so a future edit that wires the
// research engine into this owner path fails rather than ships.
//
// Security: reuses the isolated renderer boundary wholesale — child
// process, scrubbed environment allowlist, deny-by-default egress proxy
// pinned to the confirmed host, cross-origin blocked, one navigation,
// bounded time and size, zero retry, teardown after use. One render per
// invocation: no click, no scroll, no pagination, no second navigation.
//
// PASSIVE NETWORK OBSERVATION is available behind --observe-network. It
// records metadata about requests the browser ALREADY made while
// rendering this one page, and bounded bodies for same-origin textual
// responses only. It issues nothing: no click, no pagination, no second
// navigation, no fetch. An observed URL confers NO authority — it is a
// URL the page asked for, not documentation, not evidence, not identity.
//
// RENDERED-HTML RECORD RECOVERY is available behind --recover=<needle>
// (repeatable). It parses the SETTLED html this render already captured,
// reusing Stage 0's payload discovery, and returns the smallest record
// containing each needle together with the identifiers found INSIDE THAT
// SAME RECORD. Parse only: no execution, no second navigation, no
// request. It confers no authority — a value recovered from a page's
// embedded payload means the page shipped it, nothing more.
//
// Run: npx tsx scripts/inspect-official-docs.ts <https url> [projectSlug] [--observe-network] [--recover=<needle> ...]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { evaluateDocsInspectionEligibility } from "../src/server/engine/docs-inspection-eligibility";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import { embeddedSearchVerdict } from "../src/server/engine/providers/embedded-records";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";
import { RenderedDocsError } from "../src/server/engine/providers/rendered-docs-fetcher";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const positional = args.filter((a) => !a.startsWith("--"));
  const url = positional[0];
  const slug = positional[1] ?? "pump_fun";
  const observeNetwork = flags.includes("--observe-network");
  const recoverNeedles = flags
    .filter((f) => f.startsWith("--recover="))
    .map((f) => f.slice("--recover=".length))
    .filter((n) => n.length > 0);
  if (!url) {
    console.error("usage: npx tsx scripts/inspect-official-docs.ts <https url> [projectSlug]");
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

    const decision = evaluateDocsInspectionEligibility(url, route);
    if (!decision.eligible) {
      console.error("NOT ELIGIBLE FOR DOCS INSPECTION: " + decision.reason);
      process.exit(1);
    }
    eligible = decision;
  } finally {
    // Closed BEFORE the render begins: the renderer runs with no open
    // handle to ATLAS data, and nothing after this point can write.
    await pool.end();
  }

  console.log("--- NON-EVIDENTIARY docs inspection render (one navigation) ---");
  console.log("observeNetwork:   " + observeNetwork);
  console.log("recoverNeedles:   " + (recoverNeedles.length > 0 ? recoverNeedles.join(" | ") : "(none)"));
  const doc = await createIsolatedRenderedDocsFetcher({
    observeNetwork,
    recoverNeedles,
  }).render(url, {
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

  // Machine-readable identifiers the plain-text conversion discards.
  // OBSERVATIONS ONLY — nothing here is trusted, classified or promoted.
  // Printed in full rather than sampled: a truncated read invites a second
  // render to see the rest, and there is exactly one render per run.
  const dl = doc.documentLinks;
  console.log("--- links / identifiers (observations only) ---");
  console.log("  anchors:      " + (dl ? dl.links.length : 0));
  console.log("  identifiers:  " + (dl ? dl.identifiers.length : 0));
  console.log("  truncated:    " + (dl ? String(dl.truncated) : "n/a"));
  console.log("  hosts:        " + (dl && dl.hosts.length > 0 ? dl.hosts.join(", ") : "(none)"));
  if (dl) {
    for (const shape of ["SIGNATURE_LIKE", "ADDRESS_LIKE"]) {
      const matching = dl.identifiers.filter((i) => i.shape === shape);
      console.log(`  --- ${shape} (${matching.length}) ---`);
      for (const id of matching) {
        console.log("    " + id.attribute + " = " + id.value);
      }
    }
    console.log(`  --- anchors (${dl.links.length}) ---`);
    for (const l of dl.links) {
      console.log("    <a> " + l.href + "   :: " + l.text.slice(0, 120));
    }
  }
  // Observations only. Printed so a human can read what the page
  // fetched; nothing here is promoted, classified or trusted.
  const net = doc.networkObservations;
  if (net) {
    console.log("--- network observations (no authority conferred) ---");
    console.log("  requests:     " + net.observations.length);
    console.log("  dropped:      " + net.droppedCount);
    console.log("  bodyBytes:    " + net.totalBodyBytes);
    for (const o of net.observations) {
      console.log(
        "  [" + o.status + "] " + o.method + " " + (o.sameOrigin ? "same-origin" : "CROSS-ORIGIN") +
          " " + String(o.contentType) + "  " + o.url,
      );
      if (o.body !== null) {
        console.log("    bodyBytes:  " + o.body.length + (o.bodyTruncated ? " (truncated)" : ""));
        console.log("    body:       " + o.body.replace(/\s+/g, " ").slice(0, 4000));
      }
    }
  }
  // Observations only. A recovered record says the page shipped these
  // bytes; it classifies nothing and promotes nothing.
  const rec = doc.embeddedRecords;
  if (rec) {
    console.log("--- embedded records (no authority conferred) ---");
    console.log("  kinds:        " + (rec.kinds.join(", ") || "(none)"));
    console.log("  matches:      " + rec.matches.length);
    console.log("  truncated:    " + rec.truncated);
    // COVERAGE. Finding a source is not searching it: a zero-match result
    // is only a real negative when coverage is COMPLETE.
    const c = rec.coverage;
    console.log("  --- coverage ---");
    console.log("    sourcesFound:      " + c.sourcesFound);
    console.log("    sourcesTraversed:  " + c.sourcesTraversed);
    console.log("    framesSeen:        " + c.framesSeen);
    console.log("    framesParsed:      " + c.framesParsed);
    console.log("    framesUnsupported: " + c.framesUnsupported);
    console.log("    parseErrors:       " + c.parseErrors);
    console.log("    recordsScanned:    " + c.recordsScanned);
    console.log("    SEARCH COVERAGE:   " + c.coverage);
    console.log("    VERDICT:           " + embeddedSearchVerdict(rec));
    for (const [i, m] of rec.matches.entries()) {
      console.log("  --- match " + (i + 1) + " (" + m.kind + ", script " + m.scriptIndex + ")");
      console.log("    path:       " + m.path);
      console.log("    needles:    " + m.matchedNeedles.join(" | "));
      console.log("    fields:     " + m.fields.join(", "));
      console.log("    identifiers in THIS record: " + m.identifiers.length);
      for (const id of m.identifiers) {
        console.log("      [" + id.shape + "] " + id.field + " = " + id.value);
      }
      console.log("    json:       " + m.json + (m.jsonTruncated ? "  (truncated)" : ""));
    }
  }
  console.log("--- rendered text ---");
  console.log(doc.normalizedText);
  console.log("--- end (nothing persisted; no classification assigned) ---");
}

main().catch((e) => {
  console.error(
    "DOCS INSPECTION FAILED: " + (e instanceof RenderedDocsError ? e.reason : String(e?.message ?? e)),
  );
  process.exit(1);
});
