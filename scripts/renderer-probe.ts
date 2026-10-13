// D-146 SLICE 2 — OWNER-CONTROLLED RENDERER PROBE.
//
// One question, one URL, one attempt: "would the FETCH worker's installed
// renderer be able to finish this page?" It answers that with the SAME
// production capability the worker installs and the SAME gate the
// acquisition chain applies — not an approximation of them.
//
// PRODUCTION-EQUIVALENT BY CONSTRUCTION. It calls
// installFetchRendererCapability() itself, so it runs the same self-test,
// the same isolated renderer, the same scrubbed child, the same
// deny-by-default egress proxy pinned to one validated host, and the same
// bounds. If this probe renders a page, the worker's third strategy would
// have rendered it; if this probe is refused, the worker would have been
// refused for the same stated reason. Because it shares the installer, it
// also requires the same two declarations — the FETCH role and
// RENDERED_DOCS_ENABLED=1 — rather than a private switch of its own.
//
// EXPLICITLY NON-EVIDENTIARY. It writes nothing: no research job, no
// Evidence, no acquired document, no seal, no trace row, no memory, no
// classification. It reserves no research budget — it is not a job, so
// there is no budget to reserve against; the source open it "spends" is
// the owner's decision to run it. The database is read ONCE, to resolve
// the route from the authoritative record, and closed BEFORE the render
// begins, so after the gate there is no open handle and no write is
// possible even in principle.
//
// GENERIC. It takes a URL argument and knows no project, no host, no
// vendor and no network. It cannot be pointed at an unconfirmed route:
// eligibility is decided by the shared routeEligibility gate against
// human-confirmed project memory, exactly as the chain decides it.
//
// BOUNDED OUTPUT. Success/failure, the final URL, an HTTP status when the
// renderer actually observed one, sizes, duration, and a CLOSED failure
// category. Deliberately NOT printed: rendered text, page content,
// document links, embedded payloads, network observations, proxy
// internals, addresses, or any raw browser error. This probe reports on
// the CAPABILITY, not on the document — reading a page's content is what
// scripts/inspect-official-docs.ts already exists for.
//
// ZERO RETRIES. Exactly one navigation. If it fails, it fails.
//
// Run: npm run probe:renderer -- <https url> [projectSlug]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { installFetchRendererCapability, uninstallRendererCapability, RENDERED_DOCS_ENV } from "../src/server/jobs/renderer-capability";
import { routeEligibility } from "../src/server/engine/rendered-docs-policy";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import {
  RenderedDocsError,
  renderedDocsAvailable,
  renderedDocsEnabled,
  resolveRenderedDocsFetcher,
} from "../src/server/engine/providers/rendered-docs-fetcher";

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const url = positional[0];
  const slug = positional[1];
  if (!url || !slug) {
    console.error("usage: npm run probe:renderer -- <https url> <projectSlug>");
    console.error("  one render, zero retries, nothing persisted.");
    process.exit(1);
  }

  // The capability first: there is no point resolving a route for a
  // renderer that cannot start. A self-test failure throws exactly as it
  // would at worker startup.
  const install = await installFetchRendererCapability({
    capabilities: new Set(["FETCH"]),
  });
  console.log("--- renderer capability ---");
  console.log("outcome:          " + install.outcome);
  if (install.outcome !== "INSTALLED") {
    console.error(
      "renderer not installed. This probe runs the production installer, so it " +
        "needs the same declaration the FETCH worker needs: " + RENDERED_DOCS_ENV + "=1",
    );
    process.exit(1);
  }
  console.log("selfTestMs:       " + String(install.selfTest?.durationMs));
  console.log("browserVersion:   " + String(install.selfTest?.browserVersion));

  const { db, pool } = createDatabase();
  let gate: { confirmedHost: string; matchedPathPrefix: string };
  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) throw new Error("project not found: " + slug);
    const route = await resolveSourceRoute(db, project.id, url);
    console.log("--- route (from the authoritative record) ---");
    console.log("officiality:      " + route.officiality);
    console.log("routeClass:       " + String(route.routeClass));
    console.log("matchedPrefix:    " + String(route.matchedPathPrefix));

    // THE SAME GATE THE CHAIN ASKS. Not a probe-specific relaxation:
    // https + CONFIRMED + OFFICIAL_DOCS + a matched path prefix the URL
    // is inside. An unconfirmed host is refused here exactly as the
    // acquisition path refuses it.
    const decision = routeEligibility(url, route, renderedDocsEnabled() && renderedDocsAvailable());
    if (!decision.eligible) {
      console.error("NOT ELIGIBLE FOR RENDER: " + decision.reason);
      process.exit(1);
    }
    gate = decision;
  } finally {
    // Closed before the render: from here on nothing can write.
    await pool.end();
  }

  console.log("--- one render, zero retries ---");
  try {
    const doc = await resolveRenderedDocsFetcher().render(url, {
      confirmedHost: gate.confirmedHost,
      matchedPathPrefix: gate.matchedPathPrefix,
    });
    console.log("result:           SUCCESS");
    console.log("finalUrl:         " + doc.finalUrl);
    console.log("httpStatus:       (not reported on success)");
    console.log("renderedLength:   " + doc.renderedTextLength);
    console.log("htmlBytes:        " + doc.byteLength);
    console.log("durationMs:       " + doc.renderDurationMs);
    // A count, never the requests themselves: which hosts a page asked
    // for is page content, and this probe does not report page content.
    console.log("blockedRequests:  " + doc.blockedRequestCount);
    console.log("--- nothing persisted; no document sealed; no Evidence written ---");
  } catch (e) {
    // Closed categories only. A RenderedDocsError carries its own
    // vocabulary member; anything else is reported as unclassified rather
    // than having its message printed, because an unclassified failure
    // must not become a channel for arbitrary text.
    const typed = e instanceof RenderedDocsError ? e : null;
    console.log("result:           FAILED");
    console.log("category:         " + (typed ? typed.reason : "(unclassified)"));
    console.log("diagnostic:       " + (typed?.diagnostic ?? "(none)"));
    console.log("httpStatus:       " + (typed?.httpStatus ?? "(none)"));
    console.log("--- nothing persisted ---");
    process.exitCode = 1;
  } finally {
    uninstallRendererCapability();
  }
}

main().catch((e) => {
  // Startup-class failures (self-test refusal, project not found) — the
  // typed message only, never a stack.
  console.error("RENDERER PROBE FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
