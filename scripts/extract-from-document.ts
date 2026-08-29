// STAGE B — EXTRACT EVIDENCE FROM AN ALREADY-ACQUIRED DOCUMENT.
//
// Consumes ONE `acquired_documents` row (by exact id) and runs the REAL
// S4 extraction/persistence path against its stored text: the real
// EvidenceExtractor, the real fact validation and containment, the real
// Source/Evidence persistence, the real documentary-locator validator,
// the ordinary S5 reconciliation, and then — when Evidence was actually
// persisted — the same S6 assembly, S7 claim support and S8 Proof Writer
// that run-job.ts calls. Evidence, admitted locators and the Proof can
// come into existence ONLY through those paths; this script owns no
// shortcut and no second Proof implementation.
//
// The three projections are pure over already-persisted rows, so they add
// zero external calls: the stage's network footprint is unchanged from
// when it stopped at S5.
//
// STRUCTURALLY ZERO external document traffic: the executor's transport
// is a replay ContentFetcher that can serve exactly one stored document
// for exactly one url and errors on anything else; the renderer is
// force-disabled and never installed; the search gateway is the fixed
// single-url fixture. The ONLY network capability this stage needs is the
// model provider. RPC stays impossible under --mode=documentary-only
// (D-127), which is the expected mode for documentary resumes.
//
// STALENESS IS EXPLICIT. Stage B evaluates the exact immutable content
// Stage A captured — it never re-fetches to "check freshness". If the
// live page may have changed and that matters, that is a NEW acquisition,
// not a resume. The tamper seal (text_sha256) is verified before the text
// may reach extraction.
//
// AUTHORITY IS CHECKED AT BOTH ENDS. The acquisition-time snapshot must
// have permitted evidentiary use AND the route must still resolve
// CONFIRMED with a non-null routeClass NOW — so neither a
// classified-later route nor a revoked/superseded one can slip through.
// The Evidence's own sourceClass/officiality are still computed by the
// production path at extraction time, exactly as for a live fetch.
//
// A document that produced Evidence is marked consumed and refuses
// further resumes; a FAILED extraction leaves it intact and resumable.
// The operator cannot feed raw text into this stage: the only input is a
// row id, and the row can only have been written by Stage A.
//
// Run: npx tsx scripts/extract-from-document.ts --document-id=<uuid> --component=<NAME> --step=<n> --actor=<name> --project=<slug> [--mode=documentary-only]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { evidence, projects, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  authorityPermitsAcquisition,
  loadAcquiredDocumentForResume,
  markAcquiredDocumentConsumed,
  replayContentFetcher,
} from "../src/server/engine/acquired-documents";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { assembleAndPersistMechanism } from "../src/server/engine/mechanism-assembly-store";
import { evaluateAndPersistClaimSupport } from "../src/server/engine/claim-support-store";
import { buildAndPersistProof } from "../src/server/engine/proof-store";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { locatorsForEvidence } from "../src/server/engine/documentary-locator-store";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { loadModelCostProfile, ModelCostProfileMissingError } from "../src/server/engine/model-cost-profile";
import { __setRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-fetcher";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import { createBoss } from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { parseRunMode } from "./alpha-acquire-url";

const KNOWN_ARGS = new Set(["document-id", "component", "step", "actor", "project", "mode"]);

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
    "usage: npx tsx scripts/extract-from-document.ts --document-id=<uuid> --component=<NAME> --step=<n> --actor=<name> --project=<slug> [--mode=<mode>]",
  );
  console.error("");
  console.error("Runs the real extraction/Evidence path against ONE document previously");
  console.error("persisted by scripts/acquire-document.ts. Never fetches the external source.");
  process.exit(1);
}

async function main(): Promise<void> {
  const { args, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error("[extract-from-document] refusing: unrecognised argument(s): " + unknown.join(" "));
    process.exit(1);
  }
  const mode = parseRunMode(args.mode);
  if (mode === null) {
    console.error("[extract-from-document] refusing: --mode=" + String(args.mode) + " is not a run mode.");
    process.exit(1);
  }
  const documentId = args["document-id"];
  const component = args.component;
  const step = Number(args.step);
  const actor = args.actor;
  const projectSlug = args.project;
  if (!documentId || !component || !Number.isInteger(step) || !actor || !projectSlug) usage();

  const patternStep = PATTERN_V1_CONTENT.steps.find((s) => s.step === step);
  if (!patternStep) {
    console.error(`[extract-from-document] no Pattern step ${step}`);
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  const boss = createBoss();
  try {
    const config = await loadProductConfig(db);

    // Full alpha prerequisites: this stage DOES spend the model provider.
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
      console.error("[extract-from-document] refusing — prerequisites missing:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug));
    if (!project) throw new Error(`project not found: ${projectSlug}`);

    const loaded = await loadAcquiredDocumentForResume(db, { documentId, projectId: project.id });
    if (!loaded.ok) {
      console.error("[extract-from-document] REFUSED: " + loaded.refusal);
      console.error("  " + loaded.detail);
      process.exit(1);
    }
    const { row, doc } = loaded;
    console.log("documentId:       " + row.id);
    console.log("acquiredAt:       " + row.acquiredAt.toISOString());
    console.log("finalUrl:         " + doc.finalUrl);
    console.log("textSha256:       " + row.textSha256 + "   (verified)");

    // BOTH-ENDS AUTHORITY: the live resolver must STILL permit
    // evidentiary use now, on top of the snapshot check load performed.
    const routeNow = await resolveSourceRoute(db, project.id, doc.finalUrl);
    console.log("officiality now:  " + routeNow.officiality);
    console.log("routeClass now:   " + String(routeNow.routeClass));
    if (!authorityPermitsAcquisition(routeNow)) {
      console.error("[extract-from-document] REFUSED: AUTHORITY_NOT_CONFIRMED_NOW");
      console.error("  the route no longer resolves as confirmed documentary authority");
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
        originalQuestion: `extract evidence from the acquired document ${row.id}`,
        normalizedTask: {
          project_slug: project.slug,
          project_slugs: [project.slug],
          task: `run the ordinary extraction path against one already-acquired document`,
        },
        normalizedTaskHash: `extract-from-document-${createdAt.getTime()}`,
        idempotencyKey: `extract-from-document-${user.id}-${createdAt.getTime()}`,
        entitlement,
        demoLifetimeProofLimit: config.demo_lifetime_proof_limit,
      },
      { skipEnqueue: true },
    );
    console.log("jobId:            " + job.id);

    // The SAME planning stage worker.ts runs, in the same order and for the
    // same reason: S6 refuses to assemble without the job’s frozen Boundary
    // Contract (`research_plans`) to cross-check the pattern version against,
    // and a resumed job is otherwise indistinguishable from a normal one. It
    // is DB-only — memory retrieval, the active Pattern, the deterministic
    // planner — so it adds no fetch, no render, no search, no RPC and no
    // model call. Fabricating a plan row by hand instead would assert a
    // planning stage that never happened, which is exactly the lie D-128
    // refuses elsewhere.
    await runMemoryPlanningStage(db, job.id);
    console.log("planning:         done   (frozen contract persisted; no external call)");
    console.log("actor:            " + actor + "   (printed, not persisted)");
    console.log("mode:             " + mode);
    console.log(
      "chain work:       " +
        (mode === "documentary-only"
          ? "DISABLED by owner instruction — branch not entered"
          : "permitted if S4's own prerequisites are met"),
    );
    console.log("external fetch:   IMPOSSIBLE — replay transport serves only the stored document");

    // The renderer is force-disabled: no install, and the enable flag is
    // cleared, so the render gates report RENDERER_DISABLED. Resume never
    // renders — it evaluates exactly what Stage A captured.
    process.env.RENDERED_DOCS_ENABLED = "";
    __setRenderedDocsFetcher(null);

    const singleUrlSearch: SearchGateway = {
      name: "acquired-document",
      async search() {
        return [{ url: doc.requestedUrl, title: "acquired document", snippet: "not evidence" }];
      },
    };
    const noModelProposer: QueryProposer = {
      name: "acquired-document",
      async proposeQueries() {
        return ["acquired document"];
      },
    };

    const executor = createS4WorkExecutor({
      db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
      searchGateway: singleUrlSearch,
      queryProposer: noModelProposer,
      contentFetcher: replayContentFetcher(doc),
      // evidenceExtractor deliberately absent — the executor resolves the
      // REAL one; this stage exists to spend exactly that capability.
      chainAcquisition: mode === "documentary-only" ? "DOCUMENTARY_ONLY" : "ENABLED",
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

    console.log("--- Stage B extraction ---");
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
    console.log("spent:            " + JSON.stringify(outcome.spent));

    console.log("--- Evidence ---");
    const rows = await db.select().from(evidence).where(eq(evidence.researchJobId, job.id));
    console.log("rows:             " + rows.length);
    for (const r of rows) {
      console.log("  ---");
      console.log("  component:      " + r.component + " (step " + r.patternStep + ")");
      console.log("  sourceClass:    " + r.sourceClass);
      console.log("  officiality:    " + r.officiality);
      console.log("  entityBinding:  " + String(r.entityBinding));
      console.log("  relationship:   " + r.relationship);
      console.log("  directness:     " + r.directness);
      console.log("  summary:        " + r.summary);
      console.log("  fragment:       " + r.fragment);
      console.log("  doesNotProve:   " + String(r.doesNotProve));
      const locators = await locatorsForEvidence(db, r.id);
      console.log("  LOCATORS:       " + locators.length);
      for (const [ordinal, l] of locators.entries()) {
        console.log("    [" + ordinal + "] " + l.shape + " " + l.value);
      }
    }

    console.log("--- Locator rejections ---");
    const trace = await db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, job.id));
    const refused = trace.filter((t) => t.operationType === "LOCATOR_REJECTED");
    console.log("count:            " + refused.length);
    for (const r of refused) console.log("  reason:         " + String(r.reasonCode));

    console.log("--- S5 reconciliation ---");
    const result = await reconcileAndPersistComponent(db, job.id, item, new Date());
    console.log("status:           " + result.status);
    console.log(JSON.stringify(result, null, 2));

    if (rows.length > 0) {
      const consumed = await markAcquiredDocumentConsumed(db, row.id, job.id);
      console.log("document consumed: " + consumed + "   (further resumes will be refused)");
    } else {
      console.log("document NOT consumed — no Evidence was persisted; it remains resumable.");
    }

    // --- S6 -> S7 -> S8, the SAME production functions run-job.ts calls ----
    //
    // The resumed path used to stop at S5, one stage short of the three
    // that now exist. These are pure derived projections over rows that
    // are already persisted: they open no socket, resolve no provider and
    // spend no budget, so continuing here adds ZERO external calls to a
    // documentary-only window — no fetch, no render, no search, no RPC,
    // and no model generation or count_tokens after extraction.
    //
    // GATED ON EVIDENCE, deliberately — and this is where the resumed path
    // DIVERGES from run-job.ts, which runs S6/S7/S8 unconditionally.
    // run-job.ts projects a whole work queue, so an empty result there is
    // still a statement about the research that was attempted. Here the
    // input is ONE document for ONE component: if extraction produced no
    // Evidence, a Proof built from it would be a conclusion about a
    // single failed replay, not about the project. Extraction failure
    // therefore stops before S6 and no Proof is written at all.
    //
    // ORDER: after the consumption mark, never before. D-128 defines
    // consumption at successful EVIDENCE persistence, and moving that
    // boundary merely because S8 now follows would change a locked
    // contract. The consequence is explicit and intended:
    //   DOCUMENT CONSUMED != PROOF NECESSARILY PERSISTED.
    // A crash inside S6/S7/S8 leaves the Evidence and the consumption
    // exactly as D-128 specifies, and the projections can be re-run.
    if (rows.length === 0) {
      console.log("--- S6/S7/S8 skipped: no Evidence was persisted, so there is nothing to project ---");
    } else {
      const projectionAt = new Date();
      console.log("--- S6 mechanism assembly ---");
      const assembly = await assembleAndPersistMechanism(db, job.id, projectionAt);
      console.log("flows:            " + assembly.flows.length);
      console.log("unassignedGaps:   " + assembly.unassignedGaps.length);

      console.log("--- S7 claim support ---");
      const claim = await evaluateAndPersistClaimSupport(db, job.id, projectionAt);
      console.log("status:           " + (claim === null ? "NONE (no S6 projection yet)" : claim.status));
      if (claim !== null) console.log("reasonCodes:      " + JSON.stringify(claim.reasonCodes));

      console.log("--- S8 Proof ---");
      const proof = await buildAndPersistProof(db, job.id);
      console.log("proofId:          " + String(proof.proofId));
      console.log("refusal:          " + String(proof.refusal));
      if (proof.draft !== null) {
        console.log("verdict:          " + proof.draft.verdict);
        console.log("confidence:       " + proof.draft.confidenceBand + " (" + proof.draft.confidenceScore + ")");
        console.log("boundEvidence:    " + proof.boundEvidenceIds.length);
      }
    }
  } finally {
    __setRenderedDocsFetcher(null);
    await boss.stop().catch(() => {});
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("extract-from-document.ts")) {
  main().catch((e) => {
    console.error("STAGE B FAILED: " + String(e?.stack ?? e?.message ?? e));
    process.exit(1);
  });
}
