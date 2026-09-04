// STAGE A — ACQUIRE DOCUMENT, THEN STOP. Owner tooling.
//
// The exact-URL acquisition used to couple two external capabilities in
// one process: fetching the document and calling the model provider. Two
// live windows proved their working network conditions are not currently
// identical — so when extraction failed, a successfully fetched document
// was simply lost. This entrypoint performs ONLY the acquisition half and
// persists the validated document as an `acquired_documents` row for a
// later, separately authorized Stage B (`extract-from-document.ts`).
//
// FULL PRODUCTION FIDELITY, ZERO DUPLICATION. It runs the REAL S4
// executor exactly as alpha-acquire-url.ts does — the same route scope
// gate, the same SSRF-safe ContentFetcher, the same static-first renderer
// fallback and Stage-0 payload recovery, the same containment — and
// captures the document at the executor's own extractor seam. The
// injected "extractor" is a capture stub: it records the document the
// production path produced and returns zero facts.
//
// STRUCTURALLY ZERO of each: Anthropic calls (the extractor seam holds a
// local stub — ANTHROPIC_API_KEY is NOT required and never read), model
// generation, Evidence rows, documentary locators, RPC (chain acquisition
// runs as DOCUMENTARY_ONLY, D-127 — Stage A is documentary by
// definition). The persisted row is NOT Evidence and establishes nothing;
// see acquired-documents.ts.
//
// --component/--step shape the audit job only. The persisted document is
// component-independent: Stage B names its own component.
//
// Run: npx tsx scripts/acquire-document.ts --url=<https url> --component=<NAME> --step=<n> --actor=<name> --project=<slug>
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { projects, topics, users } from "../src/server/db/schema";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { persistAcquiredDocument } from "../src/server/engine/acquired-documents";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { loadModelCostProfile, ModelCostProfileMissingError } from "../src/server/engine/model-cost-profile";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { FetchedDocument } from "../src/server/engine/providers/types";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";
import { __setRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-fetcher";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import { createBoss } from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";

const KNOWN_ARGS = new Set(["url", "component", "step", "actor", "project"]);

function parseArgs(argv: string[]): { args: Record<string, string>; unknown: string[] } {
  const args: Record<string, string> = {};
  const unknown: string[] = [];
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_-]+)=(.*)$/.exec(arg);
    if (m && KNOWN_ARGS.has(m[1])) args[m[1]] = m[2];
    else unknown.push(arg);
  }
  return { args, unknown };
}

function usage(): never {
  console.error(
    "usage: npx tsx scripts/acquire-document.ts --url=<https url> --component=<NAME> --step=<n> --actor=<name> --project=<slug>",
  );
  console.error("");
  console.error("Fetches ONE confirmed-documentary url through the production transport and");
  console.error("persists the validated document. No model call, no Evidence, no RPC — the");
  console.error("extraction half is scripts/extract-from-document.ts, run separately.");
  process.exit(1);
}

async function main(): Promise<void> {
  const { args, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error("[acquire-document] refusing: unrecognised argument(s): " + unknown.join(" "));
    process.exit(1);
  }
  const url = args.url;
  const component = args.component;
  const step = Number(args.step);
  const actor = args.actor;
  const projectSlug = args.project;
  if (!url || !component || !Number.isInteger(step) || !actor || !projectSlug) usage();

  const patternStep = PATTERN_V1_CONTENT.steps.find((s) => s.step === step);
  if (!patternStep) {
    console.error(`[acquire-document] no Pattern step ${step}`);
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  const boss = createBoss();
  try {
    const config = await loadProductConfig(db);

    // Same fail-closed prerequisites as alpha-acquire-url, MINUS the
    // Anthropic credential: Stage A never talks to the model provider.
    // The cost-profile lookups are offline catalog reads, kept because
    // the executor resolves both profiles regardless of the stub.
    const problems: string[] = [];
    if (!config.internal_alpha_enabled) problems.push("internal_alpha_enabled is false (product_config)");
    if (!INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(projectSlug)) {
      problems.push(`project "${projectSlug}" is not in the internal-alpha live allowlist`);
    }
    for (const [role, model] of [
      ["EVIDENCE_EXTRACTOR", config.evidence_extractor_model],
      ["QUERY_PROPOSER", config.query_proposer_model],
    ] as const) {
      try {
        loadModelCostProfile(role, model);
      } catch (e) {
        if (e instanceof ModelCostProfileMissingError) problems.push(e.message);
        else throw e;
      }
    }
    if (problems.length > 0) {
      console.error("[acquire-document] refusing — prerequisites missing:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug));
    if (!project) throw new Error(`project not found: ${projectSlug}`);

    // SCOPE GATE — identical to alpha-acquire-url: a human-confirmed
    // documentary route, read from the authoritative record.
    const route = await resolveSourceRoute(db, project.id, url);
    console.log("officiality:      " + route.officiality);
    console.log("routeClass:       " + String(route.routeClass));
    console.log("matchedPrefix:    " + String(route.matchedPathPrefix));
    if (route.officiality !== "CONFIRMED" || route.routeClass === null) {
      console.error("[acquire-document] refusing — this URL has no confirmed documentary route for this project.");
      process.exit(1);
    }

    const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
    if (!topic) throw new Error("no active topic found — is the database seeded?");
    const [user] = await db.insert(users).values({}).returning();

    const budget = { ...INTERNAL_ALPHA_V1, maxSearchQueries: 1, maxSourceOpens: 2 };
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
        originalQuestion: `acquire the document at ${url} for later extraction`,
        normalizedTask: {
          project_slug: project.slug,
          project_slugs: [project.slug],
          task: `acquire one confirmed documentary page and persist it; extract nothing`,
        },
        normalizedTaskHash: `acquire-document-${createdAt.getTime()}`,
        idempotencyKey: `acquire-document-${user.id}-${createdAt.getTime()}`,
        entitlement,
        demoLifetimeProofLimit: config.demo_lifetime_proof_limit,
      },
      { skipEnqueue: true },
    );
    console.log("jobId:            " + job.id);
    console.log("actor:            " + actor + "   (printed, not persisted)");
    console.log("stage:            ACQUIRE-DOCUMENT (no model, no Evidence, no RPC)");

    // Renderer available exactly as in alpha-acquire-url, so the
    // static-first fallback keeps its production behaviour.
    process.env.RENDERED_DOCS_ENABLED = "1";
    __setRenderedDocsFetcher(createIsolatedRenderedDocsFetcher());

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
    // THE CAPTURE STUB. It is the whole point of Stage A: the document the
    // production path fetched/rendered arrives at the extractor seam, is
    // recorded, and no fact is ever produced — so no Source, no Evidence
    // and no locator can exist downstream.
    const captured: { doc: FetchedDocument | null } = { doc: null };
    const captureExtractor: EvidenceExtractor = {
      name: "document-capture",
      async extract(input) {
        captured.doc = input.document;
        return [];
      },
    };

    const executor = createS4WorkExecutor({
      db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
      searchGateway: singleUrlSearch,
      queryProposer: noModelProposer,
      evidenceExtractor: captureExtractor,
      // Stage A is documentary by definition — the on-chain branch is
      // never entered, whatever the database holds (D-127 semantics).
      chainAcquisition: "DOCUMENTARY_ONLY",
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

    console.log("--- Stage A acquisition ---");
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
    console.log("reason:           " + String((outcome as { reason?: unknown }).reason));

    if (!captured.doc) {
      console.error("[acquire-document] no document was captured — nothing persisted.");
      process.exit(1);
    }

    const renderMode =
      (captured.doc as { renderMode?: string }).renderMode === "RENDERED" ? "RENDERED" : "STATIC";
    const persisted = await persistAcquiredDocument(db, {
      projectId: project.id,
      acquiringJobId: job.id,
      doc: captured.doc,
      route,
      renderMode,
    });
    if (!persisted.ok) {
      console.error("[acquire-document] refusing to persist: " + persisted.refusal);
      console.error("  " + persisted.detail);
      process.exit(1);
    }

    console.log("--- persisted acquired document ---");
    console.log("documentId:       " + persisted.id);
    console.log("finalUrl:         " + captured.doc.finalUrl);
    console.log("contentType:      " + captured.doc.contentType);
    console.log("byteLength:       " + captured.doc.byteLength);
    console.log("textLength:       " + captured.doc.normalizedText.length);
    console.log("renderMode:       " + renderMode);
    console.log("contentHash:      " + captured.doc.contentHash);
    console.log("textSha256:       " + persisted.textSha256);
    console.log("");
    console.log("NOT Evidence. Extraction is a separate owner act:");
    console.log(
      "  npx tsx scripts/extract-from-document.ts --document-id=" +
        persisted.id +
        " --component=<NAME> --step=<n> --actor=<name> --project=" +
        projectSlug +
        " --mode=documentary-only",
    );
  } finally {
    __setRenderedDocsFetcher(null);
    await boss.stop().catch(() => {});
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("acquire-document.ts")) {
  main().catch((e) => {
    console.error("STAGE A FAILED: " + String(e?.stack ?? e?.message ?? e));
    process.exit(1);
  });
}
