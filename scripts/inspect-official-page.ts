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
  // OWNER INSPECTION DIAGNOSTICS, opt-in and requested here only.
  //
  // It changes NOTHING about the render: the same isolated boundary, the
  // same deny-by-default proxy pinned to the same confirmed host, the same
  // single navigation, the same limits, the same zero retry. It only
  // decides whether a FAILURE is described to the operator standing at
  // this terminal — who typed the url above and is already reading the
  // confirmed host printed above it.
  //
  // Production acquisition never sets this flag, so an evidentiary render
  // continues to fail with a reason code and counts and nothing else.
  const doc = await createIsolatedRenderedDocsFetcher({
    inspectionDiagnostics: true,
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
  if (!(e instanceof RenderedDocsError)) {
    console.error("INSPECTION FAILED: " + String(e?.message ?? e));
    process.exit(1);
  }
  // The reason names the STAGE; the typed sub-reason beside it names which
  // kind. Printing only the stage is how a window came back saying
  // RENDER_FAILED and nothing else. Every value below is a member of a
  // closed code-owned set — no message, no url, no host, no stack.
  const detail =
    e.diagnostic ?? e.navigationDiagnostic ?? (e.httpStatus === null ? null : String(e.httpStatus));
  console.error("INSPECTION FAILED: " + e.reason + (detail === null ? "" : ":" + detail));

  // THE PROXY'S OWN VERDICT, printed as an INDEPENDENT observation beside
  // the browser's. What Chromium reported and what our containment decided
  // are two different witnesses, and reading both is the whole point.
  //
  // Counts only. Never a target, a hostname, a port or a resolved address —
  // the summary has no field that could hold one. Absent means the proxy
  // was never opened, which is itself different from opened-and-silent.
  const p = e.proxyDenials;
  if (p === null) {
    console.error("proxyDenials:     (none recorded)");
  } else {
    console.error("proxyDenials:     " + p.deniedCount + " denied, " + p.allowedCount + " allowed");
    for (const [reason, count] of Object.entries(p.denials)) {
      console.error("  " + reason.padEnd(20) + count);
    }
    if (p.deniedCount === 0) {
      console.error("  -> no proxy denial was recorded; the failure was not a containment refusal.");
    }
  }

  // THE OPERATOR'S DESCRIPTION. Present only because this entrypoint asked
  // for it, and structurally absent from every production render.
  //
  // Counts alone could not separate "the confirmed host itself was
  // refused" from "a third-party asset was refused while the page loaded
  // fine", nor say where the navigation ended up, nor report what the
  // browser actually said. Each line below answers exactly one of those.
  const d = e.inspection;
  if (d === null) {
    console.error("inspection:       (not collected)");
  } else {
    console.error("--- inspection diagnostics (bounded; no page content) ---");
    // URLs are reduced to origin + path before they get here: query
    // strings and fragments are dropped by construction, not by choice.
    console.error("requestedUrl:     " + String(d.requestedUrl));
    console.error("finalUrl:         " + String(d.finalUrl));
    if (d.finalUrl === "about:blank") {
      console.error("  -> the navigation never committed; nothing was loaded.");
    }
    // The browser's own verdict: an error CLASS and Chromium's own
    // net::ERR_* code. The message itself is never carried.
    console.error("navErrorName:     " + String(d.navigationErrorName));
    console.error("navNetError:      " + String(d.navigationNetError));
    console.error(
      "blockedRequests:  " +
        d.blockedRequests.length +
        (d.blockedRequestsTruncated ? " (truncated)" : ""),
    );
    for (const b of d.blockedRequests) {
      console.error(
        "  " +
          String(b.origin) +
          "  [" +
          String(b.resourceType) +
          "]" +
          (b.navigationRequest ? " navigation" : " subresource") +
          (b.mainFrame ? " main-frame" : ""),
      );
    }
    console.error(
      "egressDecisions:  " +
        d.egressDecisions.length +
        (d.egressDecisionsTruncated ? " (truncated)" : ""),
    );
    for (const x of d.egressDecisions) {
      console.error(
        "  " +
          (x.allowed ? "ALLOW" : "DENY ") +
          "  " +
          String(x.host) +
          ":" +
          String(x.port) +
          (x.reason === null ? "" : "  " + x.reason),
      );
    }
    // Stated rather than left to be assumed: the proxy filters CONNECT,
    // where a frame does not exist yet. Only the rows above it, recorded
    // by the browser-side handler, carry frame attribution.
    console.error(
      "  -> egress rows are CONNECT decisions; frame attribution is unavailable at that boundary.",
    );
  }
  process.exit(1);
});
