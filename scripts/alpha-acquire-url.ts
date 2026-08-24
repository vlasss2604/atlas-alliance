// NARROWLY SCOPED EVIDENTIARY ACQUISITION — internal/owner tooling.
//
// One component. One already-known URL. No search provider. This exists
// for the case where the owner already knows WHICH page must be read and
// wants the ordinary evidentiary pipeline applied to it, without spending
// a search budget discovering it and without running a whole Proof.
//
// WHAT IT IS NOT. It is not a second acquisition path: it builds the REAL
// S4 executor (s4-executor.ts) with the REAL ContentFetcher and the REAL
// EvidenceExtractor, so admissibility, source authority, entity binding,
// traceability and persistence are the ordinary ones, unchanged. Two
// providers are injected, and both of them NARROW the run rather than
// widen it:
//
//   SearchGateway  — returns the single URL given on the command line and
//                    nothing else. Brave is never constructed, so no
//                    search query is issued and no candidate the owner
//                    did not name can enter the run.
//   QueryProposer  — returns one fixed query string without calling a
//                    model, because the URL is already known and there is
//                    nothing left to propose.
//
// Everything downstream of the fetch — extraction, class resolution,
// officiality, traceability, Evidence rows, S5 reconciliation — is the
// production code path. This script cannot make a document admissible
// that the engine would otherwise refuse.
//
// SCOPE GATE. Only a page whose route is human-CONFIRMED and carries
// OFFICIAL_DOCS authority may be acquired this way. A URL the owner
// merely believes is relevant is not enough: without a confirmed route
// the ordinary discovery path is the correct one, and this script refuses.
//
// NO CHAIN CALL. No on-chain retriever is in this file's import graph, so
// a run cannot reach an RPC endpoint whatever the page contains.
//
// Run: npx tsx scripts/alpha-acquire-url.ts --url=<https url> --component=<NAME> --step=<n> --actor=<name> [--project=<slug>]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { evidence, projects, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { literallyPresent } from "../src/server/engine/documentary-locator";
import { locatorsForEvidence } from "../src/server/engine/documentary-locator-store";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { loadModelCostProfile, ModelCostProfileMissingError } from "../src/server/engine/model-cost-profile";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";
import {
  __setRenderedDocsFetcher,
  type RenderedDocument,
} from "../src/server/engine/providers/rendered-docs-fetcher";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import { createBoss } from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function usage(): never {
  console.error(
    "usage: npx tsx scripts/alpha-acquire-url.ts --url=<https url> --component=<NAME> --step=<n> --actor=<name> [--project=<slug>]",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const component = args.component;
  const step = Number(args.step);
  const actor = args.actor;
  const projectSlug = args.project ?? "pump_fun";
  if (!url || !component || !Number.isInteger(step) || !actor) usage();

  const patternStep = PATTERN_V1_CONTENT.steps.find((s) => s.step === step);
  if (!patternStep) {
    console.error(`[acquire] no Pattern step ${step}`);
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  const boss = createBoss();
  try {
    const config = await loadProductConfig(db);

    // Fail closed on every prerequisite this script can check before
    // spending anything.
    const problems: string[] = [];
    if (!config.internal_alpha_enabled) problems.push("internal_alpha_enabled is false (product_config)");
    if (!process.env.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY is not set");
    if (!INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(projectSlug)) {
      problems.push(`project "${projectSlug}" is not in the internal-alpha live allowlist`);
    }
    try {
      loadModelCostProfile("EVIDENCE_EXTRACTOR", config.evidence_extractor_model);
    } catch (e) {
      if (e instanceof ModelCostProfileMissingError) problems.push(e.message);
      else throw e;
    }
    if (problems.length > 0) {
      console.error("[acquire] refusing — prerequisites missing:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug));
    if (!project) throw new Error(`project not found: ${projectSlug}`);

    // SCOPE GATE — read from the authoritative record, never from a flag.
    const route = await resolveSourceRoute(db, project.id, url);
    console.log("officiality:      " + route.officiality);
    console.log("routeClass:       " + String(route.routeClass));
    console.log("matchedPrefix:    " + String(route.matchedPathPrefix));
    if (route.officiality !== "CONFIRMED" || route.routeClass === null) {
      console.error("[acquire] refusing — this URL has no confirmed documentary route for this project.");
      process.exit(1);
    }

    const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
    if (!topic) throw new Error("no active topic found — is the database seeded?");
    const [user] = await db.insert(users).values({}).returning();

    // A bounded envelope smaller than the internal-alpha one: at most one
    // search "call" (a fixture that returns the given URL), and at most
    // two source opens — the static fetch and, if the render gate opens,
    // one render. There is no third.
    const budget = {
      ...INTERNAL_ALPHA_V1,
      maxSearchQueries: 1,
      maxSourceOpens: 2,
    };
    const entitlement: EntitlementSnapshot = {
      level: "ARI_CORE",
      capability: "FRESH_RESEARCH",
      budget,
    };

    const createdAt = new Date();
    const { job } = await createResearchJob(
      db,
      boss,
      {
        userId: user.id,
        topicId: topic.id,
        projectId: project.id,
        originalQuestion: `what does ${project.name}'s own documentation state at ${url}?`,
        normalizedTask: {
          project_slug: project.slug,
          project_slugs: [project.slug],
          task: `read the project's own documentation page and report what it states`,
        },
        normalizedTaskHash: `acquire-url-${createdAt.getTime()}`,
        idempotencyKey: `acquire-url-${user.id}-${createdAt.getTime()}`,
        entitlement,
        demoLifetimeProofLimit: config.demo_lifetime_proof_limit,
      },
      // No pg-boss task: nothing else can claim this job concurrently.
      { skipEnqueue: true },
    );
    console.log("jobId:            " + job.id);
    console.log("actor:            " + actor);

    // The renderer is not wired into the engine by default — a deployment
    // that never installs it simply keeps whatever the static path found.
    // Installing it here is what makes Stage 1 reachable for this one run,
    // and it is the SAME isolated boundary the owner inspection path uses:
    // child process, scrubbed env, deny-by-default egress proxy pinned to
    // the confirmed host, one navigation, zero retry.
    process.env.RENDERED_DOCS_ENABLED = "1";
    // Wrapped in a RECORDER so this script can report the document the
    // engine actually read, without fetching it a second time. It is a
    // pass-through: it performs no navigation of its own, alters nothing
    // it forwards, and the engine sees the isolated fetcher unchanged.
    // Without it a locator could be reported with no way to show WHERE in
    // the document it came from, which is the difference between a result
    // and an assertion.
    const isolated = createIsolatedRenderedDocsFetcher();
    // A holder rather than a bare `let`: TypeScript narrows a closure-assigned
    // local to `never` at the read site, which is exactly wrong here.
    const captured: { doc: RenderedDocument | null } = { doc: null };
    __setRenderedDocsFetcher({
      name: isolated.name,
      version: isolated.version,
      async render(target, route) {
        const doc = await isolated.render(target, route);
        captured.doc = doc;
        return doc;
      },
    });

    // NARROWING injections. Neither can admit anything the engine would
    // otherwise refuse; both only reduce what the run may reach.
    const singleUrlSearch: SearchGateway = {
      name: "owner-supplied-url",
      async search() {
        return [{ url, title: "owner-supplied url", snippet: "not evidence" }];
      },
    };
    const noModelProposer: QueryProposer = {
      name: "owner-supplied-url",
      async proposeQueries() {
        return ["owner-supplied url"];
      },
    };

    const executor = createS4WorkExecutor({
      db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
      searchGateway: singleUrlSearch,
      queryProposer: noModelProposer,
      // contentFetcher and evidenceExtractor deliberately absent — the
      // executor's own preflight resolves the REAL ones.
    });

    const item: ComponentWorkItem = {
      step,
      stepName: patternStep.name,
      component,
      state: "NO_MEMORY",
      blockers: [],
      memoryIds: [],
      conflictingMemoryIds: [],
    };

    console.log("--- S4 acquisition ---");
    const outcome = await executor.execute(item, {
      jobId: job.id,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: {
        maxSearchQueries: budget.maxSearchQueries,
        maxSourceOpens: budget.maxSourceOpens,
        maxModelCostMicro: budget.maxModelCostMicro,
      },
    });
    console.log("status:           " + outcome.status);
    // ALWAYS printed, not only on failure: on success this string also
    // carries the attempt observations (DOCS_RENDERED, DOCS_PAYLOAD_RECOVERED,
    // DOCS_RENDER_FAILED, source-route observations). Executing the item
    // directly means no research_attempts row is written, so this console
    // line is the only place that provenance is visible at all.
    console.log("reason:           " + String((outcome as { reason?: unknown }).reason));
    console.log("spent:            " + JSON.stringify(outcome.spent));

    console.log("--- Evidence ---");
    const rows = await db.select().from(evidence).where(eq(evidence.researchJobId, job.id));
    console.log("rows:             " + rows.length);
    for (const row of rows) {
      console.log("  ---");
      console.log("  component:      " + row.component + " (step " + row.patternStep + ")");
      console.log("  sourceClass:    " + row.sourceClass);
      console.log("  officiality:    " + row.officiality);
      console.log("  entityBinding:  " + String(row.entityBinding));
      console.log("  relationship:   " + row.relationship);
      console.log("  directness:     " + row.directness);
      console.log("  mechanismState: " + String(row.mechanismState));
      console.log("  retrievedUrl:   " + row.retrievedUrl);
      console.log("  summary:        " + row.summary);
      console.log("  fragment:       " + row.fragment);
      console.log("  doesNotProve:   " + String(row.doesNotProve));
      // The legacy scalar — now a projection of ordinal 0, kept visible
      // beside the child rows so the two can be compared rather than
      // assumed consistent.
      console.log("  LOCATOR(scalar):" + String(row.documentaryLocator));
      const locators = await locatorsForEvidence(db, row.id);
      console.log("  LOCATORS:       " + locators.length);
      for (const [ordinal, l] of locators.entries()) {
        console.log("    [" + ordinal + "] " + l.shape + " " + l.value);
      }
    }

    // Every locator the validator REFUSED, and why. A refusal that leaves
    // no visible record is a refusal nobody can audit.
    console.log("--- Locator rejections ---");
    const rejections = await db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, job.id));
    const refused = rejections.filter((t) => t.operationType === "LOCATOR_REJECTED");
    console.log("count:            " + refused.length);
    for (const r of refused) console.log("  reason:         " + String(r.reasonCode));

    // Where each admitted locator actually came from, read back out of the
    // document the engine already fetched. No second retrieval.
    console.log("--- Document provenance ---");
    const doc = captured.doc;
    if (!doc) {
      console.log("  (no rendered document — the static path was used)");
    } else {
      console.log("  renderMode:     " + doc.renderMode);
      console.log("  renderedText:   " + doc.renderedTextLength);
      console.log("  linkAppendix:   " + String(doc.linkAppendixLength));
      console.log("  anchors:        " + String(doc.documentLinks?.links.length ?? 0));
      console.log("  identifiers:    " + String(doc.documentLinks?.identifiers.length ?? 0));
      const resolved = (doc.documentLinks?.links ?? []).filter((l) => l.resolvedIdentifier);
      console.log("  resolvedLinks:  " + resolved.length);
      for (const l of resolved) {
        console.log("    text=" + l.text + " | resolves=" + String(l.resolvedIdentifier));
        console.log("      href=" + l.href);
        console.log("      heading=" + String(l.heading));
      }
      for (const row of rows) {
        const locator = row.documentaryLocator;
        if (!locator) continue;
        console.log("  --- locator " + locator);
        console.log("    literallyPresent: " + literallyPresent(doc.normalizedText, locator));
        const link = (doc.documentLinks?.links ?? []).find(
          (l) => l.resolvedIdentifier === locator || l.href.includes(locator),
        );
        console.log("    href:             " + (link ? link.href : "(not from an anchor)"));
        console.log("    visibleText:      " + (link ? link.text : "(none)"));
        console.log("    heading:          " + (link ? String(link.heading) : "(none)"));
        console.log("    context:          " + (link ? String(link.context) : "(none)"));
        for (const line of doc.normalizedText.split("\n").filter((l) => l.includes(locator))) {
          console.log("    line: " + line.slice(0, 400));
        }
      }
    }

    // The ordinary S5 path — the same function the controller calls after
    // every attempt, not a shortcut around it.
    console.log("--- S5 reconciliation ---");
    const result = await reconcileAndPersistComponent(db, job.id, item, new Date());
    console.log("status:           " + result.status);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    __setRenderedDocsFetcher(null);
    await boss.stop().catch(() => {});
    await pool.end();
  }
}

main().catch((e) => {
  console.error("ACQUISITION FAILED: " + String(e?.stack ?? e?.message ?? e));
  process.exit(1);
});
