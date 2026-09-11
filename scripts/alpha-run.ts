// First Real Run, Stage 2 (D-115/D-116) + S10 (live-provider-enablement.md,
// D-118) — internal/admin script. Creates ONE research job through the
// existing service layer (createResearchJob — same admission/quota/
// idempotency path any real job goes through) and drives it through the
// REAL worker task handler (handleResearchJobTask), never by calling
// S5/S6/S7 directly as a shortcut.
//
// S10: this script now requires an EXPLICIT --mode=fixture|live — there
// is NO default and NO fallback between the two in either direction
// (§11). fixture mode is exactly Stage 2's accepted non-live trace
// fixture (trace-fixture-executor.ts), unchanged. live mode is gated by
// BOTH internal_alpha_enabled=true (a DB config flag) AND this explicit
// --mode=live invocation (§10) — neither alone is sufficient — and uses
// the real Brave/native-fetch/Anthropic providers via
// createLiveS4WorkExecutor (live-executor.ts), which itself refuses to
// construct if internal_alpha_enabled is false (a second, independent
// backstop). research_enabled is never read or written by this script —
// live mode does NOT require or imply research_enabled=true; the public/
// product path stays closed regardless of internal-alpha state.
//
// Interpreter classification (createInterpretation) uses the SAME
// deterministic non-live `fake` gateway in BOTH modes — the Interpreter
// is not one of the four owner-approved live providers (§1), and
// promoting it to live is out of this script's scope.
//
// HIGH-1 closure: this script creates the job with { skipEnqueue: true }
// (research-jobs.ts) — no pg-boss task is ever enqueued for it, so there
// is no possibility of a real worker process racing this script for the
// same job.
//
// Execution and inspection are deliberately separate scripts — this one
// creates and runs; alpha-inspect.ts (read-only) is how you look at the
// result.
//
// Usage:
//   tsx scripts/alpha-run.ts --mode=fixture --actor=<name> [--owner=<user-id>] [--asset=<name>] [--project=<slug>] [--question="..."] [--scenario=<name>]
//   tsx scripts/alpha-run.ts --mode=live    --actor=<name> [--owner=<user-id>] [--asset=<name>] [--project=<slug>] [--question="..."]
//
// --actor is required in both modes (owner/admin invocation must name
// who is running this, for the audit trail printed below).
//
// --owner is OPTIONAL and names an EXISTING users.id the Research is
// created under. Without it this script keeps creating a disposable
// anonymous user per run (below), which is why a fresh alpha job could
// never be opened in the ordinary owner-scoped Research | Verification UI
// without someone rewriting its ownership afterwards.
//
// It is not an access-control change of any kind: the job is still
// created through createResearchJob, the product APIs still scope every
// read to the signed-in user, and nothing here grants, relaxes or
// impersonates an entitlement — this script simply stops inventing a
// user nobody can sign in as. The id must already exist; a missing or
// malformed one fails BEFORE the interpretation, before the job, and
// therefore before any provider call or reservation.
//
// --asset must name one of interpreter/fake.ts's KNOWN_ASSETS (default
// "Aave" in fixture mode, "Pump.fun" in live mode — §18's owner-approved
// first live target) — the fake Interpreter gateway only classifies
// DEEP_RESEARCH for a question that names a recognized asset.
import { eq, sql } from "drizzle-orm";

import { DEFAULT_PRODUCT_CONFIG, INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { interpretations, projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import { createBoss, RESEARCH_QUEUE } from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import {
  onchainEndpointEnvVar,
  OnchainCapabilityUnavailableError,
  ONCHAIN_RESEARCH_ENV,
} from "../src/server/jobs/onchain-capability";
import {
  RendererCapabilityUnavailableError,
  RENDERED_DOCS_ENV,
} from "../src/server/jobs/renderer-capability";
import { installRuntimeCapabilities } from "../src/server/jobs/runtime-capabilities";
import { PHASE_CAPABILITIES } from "../src/server/jobs/worker-capabilities";
import { createTraceFixtureExecutor, type TraceFixtureScenario } from "../src/server/engine/trace-fixture-executor";
import { createLiveS4WorkExecutor, INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { loadModelCostProfile, ModelCostProfileMissingError } from "../src/server/engine/model-cost-profile";
import { createInterpretation } from "../src/server/interpreter/interpret";
import { __setInterpreterGateway } from "../src/server/interpreter/gateway";
import { fakeGateway } from "../src/server/interpreter/fake";
import type { WorkExecutor } from "../src/server/engine/controller";
import type { EntitlementSnapshot } from "../src/server/domain/types";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// The same shape check scripts/extract-from-document.ts already applies to
// an id it is handed. Checked BEFORE the lookup, not instead of it: a
// malformed value must be refused as a refusal, never reach Postgres as a
// uuid cast and surface as a driver error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): never {
  console.error(
    'usage: tsx scripts/alpha-run.ts --mode=fixture|live --actor=<name> [--owner=<existing-user-id>] [--asset=<name>] [--project=<slug>] [--question="..."] [--scenario=<name> (fixture only)]',
  );
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const actor = args.actor;
  const mode = args.mode;
  if (!actor || (mode !== "fixture" && mode !== "live")) usage();

  // Non-live guarantee for the Interpreter call below, in BOTH modes:
  // explicit, not dependent on the MODEL_GATEWAY environment variable
  // being set correctly (interpreter/gateway.ts's own fake-in-production
  // guard is a second, independent backstop, not relied on here).
  __setInterpreterGateway(fakeGateway);

  const assetName = args.asset ?? (mode === "live" ? "Pump.fun" : "Aave");
  const projectSlug = args.project ?? (mode === "live" ? "pump_fun" : assetName.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const question = args.question ?? `does protocol revenue reach ${assetName} token holders?`;
  const scenario = (args.scenario ?? "ADMISSIBLE_EVIDENCE") as TraceFixtureScenario;

  const { db, pool } = createDatabase();
  const config = await loadProductConfig(db);

  // §12 — Internal Alpha Data Boundary: a LIVE run may only target an
  // explicitly approved project slug, checked BEFORE anything else (no
  // job, no interpretation, no reservation). Fixture mode is not bound
  // by this — it never resolves a live provider regardless of project.
  if (mode === "live" && !INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(projectSlug)) {
    console.error(`[alpha-run] refusing --mode=live for project "${projectSlug}" — not in the internal-alpha live allowlist (live-executor.ts).`);
    console.error(`  allowed: ${[...INTERNAL_ALPHA_LIVE_PROJECT_SLUGS].join(", ")}`);
    await pool.end();
    process.exit(1);
  }

  // OWNERSHIP IS RESOLVED BEFORE ANYTHING IS SPENT.
  //
  // Deliberately here — above the live-prerequisite block, above the
  // interpretation and above createResearchJob — so that "this owner does
  // not exist" costs exactly one indexed SELECT and ends the process with
  // no provider call, no reservation, no job row and no capability
  // installed. An owner that turns out to be wrong AFTER a live run has
  // started is the one failure this option must never introduce.
  //
  // Two independent refusals, in order: the value must have the shape of a
  // uuid (so a typo is a refusal here rather than a Postgres cast error),
  // and the row must actually exist (so a well-formed id for nobody is a
  // refusal too). Neither reads, relaxes or asserts anything about the
  // user's role or entitlement — the entitlement this run uses is the
  // script's own envelope below, exactly as before.
  let ownerUserId: string | null = null;
  if (args.owner !== undefined) {
    const requested = args.owner.trim();
    if (!UUID_RE.test(requested)) {
      console.error(`[alpha-run] refusing --owner="${requested}" — not a uuid. No Research was created and nothing was spent.`);
      await pool.end();
      process.exit(1);
    }
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, requested));
    if (!existing) {
      console.error(`[alpha-run] refusing --owner=${requested} — OWNER_NOT_FOUND. No Research was created and nothing was spent.`);
      await pool.end();
      process.exit(1);
    }
    ownerUserId = existing.id;
  }

  // §11 — fail closed BEFORE creating a half-configured live job, for
  // every prerequisite this script itself can check without spending
  // anything.
  if (mode === "live") {
    const problems: string[] = [];
    let onchainProviderId: string | null = null;
    let rendererOutcome: string | null = null;
    if (!config.internal_alpha_enabled) problems.push("internal_alpha_enabled is false (product_config)");
    if (!process.env.BRAVE_SEARCH_API_KEY) problems.push("BRAVE_SEARCH_API_KEY is not set");
    if (!process.env.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY is not set");

    // STRUCTURED ON-CHAIN RETRIEVAL, INSTALLED THE WAY THE WORKER INSTALLS IT.
    //
    // THE DEFECT THIS CLOSES. The worker installs the capability during
    // startup (worker.ts), immediately before it serves any queue. This
    // script never starts a worker — it drives `handleResearchJobTask`
    // directly — so no retriever was ever installed for it, and every
    // component that plans a chain read recorded
    // ONCHAIN_RETRIEVER_NOT_CONFIGURED. A live run could spend real search
    // and model budget and still, by construction, never read the chain.
    // Nothing said so until the trace was read afterwards.
    //
    // NO SECOND IMPLEMENTATION. This calls the SAME installer, which owns
    // the flag, the (chain, network) -> env-var allowlist, the https and
    // no-credential-in-URL contract, and the allowlist-derived provider
    // label. This script constructs no retriever and names no endpoint.
    //
    // THE CAPABILITY SET IS DECLARED, not read from the environment.
    // `loadWorkerCapabilities` answers "which queues does this PROCESS
    // serve", and a deployment splits phases across processes by setting
    // it. This script is not such a deployment: it runs the whole pipeline
    // in one process, so it serves every phase by construction and says so
    // rather than depending on ATLAS_WORKER_CAPABILITIES being set in a
    // developer's shell.
    //
    // REQUIRED IN LIVE MODE, and failing here is the point. The internal
    // alpha live target is a Solana project whose entire question is the
    // deterministic chain; a live run that cannot reach one spends real
    // money to produce a documentary-only answer that looks like a finding.
    //
    // EVERY runtime capability this process needs, through the ONE
    // bootstrap the worker uses. Installing only the on-chain retriever
    // here is what left the renderer unavailable inside alpha-run while
    // RENDERED_DOCS_ENABLED was 1 and the browser started fine — enabled,
    // capable, and never installed. A short list is exactly the defect the
    // bootstrap exists to make impossible.
    if (process.env[ONCHAIN_RESEARCH_ENV] !== "1") {
      problems.push(
        `${ONCHAIN_RESEARCH_ENV} is not "1" — structured on-chain retrieval is not declared for this process`,
      );
    } else if (!process.env[onchainEndpointEnvVar()]) {
      problems.push(`${onchainEndpointEnvVar()} is not set`);
    } else {
      try {
        const installed = await installRuntimeCapabilities({
          capabilities: new Set(PHASE_CAPABILITIES),
        });
        if (installed.onchain.outcome === "INSTALLED") {
          onchainProviderId = installed.onchain.providerId;
        } else {
          problems.push(
            `on-chain capability did not install (outcome: ${installed.onchain.outcome})`,
          );
        }
        // DECLARED MEANS REQUIRED. A renderer that is switched on and does
        // not install is a silent downgrade: the oversized-document chain
        // would reach negotiation and never the render, and a live run
        // could spend its whole budget before that became visible. Not
        // declared is a different thing and stays a legitimate
        // configuration — the chain simply has one fewer step.
        if (
          process.env[RENDERED_DOCS_ENV] === "1" &&
          installed.renderer.outcome !== "INSTALLED"
        ) {
          problems.push(
            `${RENDERED_DOCS_ENV} is "1" but the renderer did not install ` +
              `(outcome: ${installed.renderer.outcome}` +
              (installed.renderer.selfTest?.reason
                ? `, self-test: ${installed.renderer.selfTest.reason}`
                : "") +
              ")",
          );
        }
        rendererOutcome = installed.renderer.outcome;
      } catch (e) {
        // Declared and unconstructible, from either installer. Each error
        // names the env var it needs, never an endpoint or a path — an
        // endpoint can be the credential.
        if (
          e instanceof OnchainCapabilityUnavailableError ||
          e instanceof RendererCapabilityUnavailableError
        ) {
          problems.push(e.message);
        } else throw e;
      }
    }
    let queryProposerProfile;
    try {
      queryProposerProfile = loadModelCostProfile("QUERY_PROPOSER", config.query_proposer_model);
    } catch (e) {
      if (e instanceof ModelCostProfileMissingError) problems.push(e.message);
      else throw e;
    }
    let evidenceExtractorProfile;
    try {
      evidenceExtractorProfile = loadModelCostProfile("EVIDENCE_EXTRACTOR", config.evidence_extractor_model);
    } catch (e) {
      if (e instanceof ModelCostProfileMissingError) problems.push(e.message);
      else throw e;
    }
    if (problems.length > 0) {
      console.error("[alpha-run] refusing --mode=live — prerequisites missing:");
      for (const p of problems) console.error(`  - ${p}`);
      await pool.end();
      process.exit(1);
    }
    console.log("=== MODE: LIVE INTERNAL ALPHA ===");
    console.log("  real internet:      YES");
    console.log("  real provider cost: YES");
    console.log("  search provider:    brave");
    console.log(`  on-chain retrieval: INSTALLED (${onchainProviderId})`);
    console.log(`  rendered docs:      ${rendererOutcome}`);
    console.log(`  query proposer:     anthropic ${config.query_proposer_model} (cost profile ${queryProposerProfile!.priceVersion})`);
    console.log(`  evidence extractor: anthropic ${config.evidence_extractor_model} (cost profile ${evidenceExtractorProfile!.priceVersion})`);
    console.log(
      `  INTERNAL_ALPHA_V1:  maxSearchQueries=${INTERNAL_ALPHA_V1.maxSearchQueries} maxSourceOpens=${INTERNAL_ALPHA_V1.maxSourceOpens} ` +
        `maxModelCostMicro=${INTERNAL_ALPHA_V1.maxModelCostMicro} maxWallClockSec=${INTERNAL_ALPHA_V1.maxWallClockSec}`,
    );
    console.log("==================================");
  }

  const boss = createBoss();
  await boss.start();
  await boss.createQueue(RESEARCH_QUEUE);
  try {
    const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
    if (!topic) throw new Error("no active topic found — is the database seeded?");

    // Catalog entry the real Interpreter's resolveProjectSlug can match
    // against `question` (project_or_asset="${assetName}" -> looseKey ->
    // compared against p.slug/p.name/p.ticker) — created BEFORE the
    // interpretation call so resolution succeeds on the first attempt,
    // exactly like a real onboarded project would already exist.
    let project = (await db.select().from(projects).where(eq(projects.slug, projectSlug)))[0];
    if (!project) {
      [project] = await db
        .insert(projects)
        .values({ slug: projectSlug, name: assetName, status: "ACTIVE_CORE" })
        .returning();
    }

    // Internal alpha tooling has no notion of a real end-user account —
    // a fresh user row is created per run and printed alongside the
    // human-readable --actor label, which IS the audit identity (this
    // schema has no free-text label column on `users`, by design —
    // production users are Telegram-identity-linked, not admin-labeled).
    //
    // With --owner, that disposable row is NOT created at all: the
    // Research belongs to an account that already exists, so the result
    // opens in the ordinary owner-scoped product UI instead of being
    // reachable only by rewriting ownership afterwards. The id was proved
    // to exist above, before anything could be spent.
    const user = ownerUserId === null
      ? (await db.insert(users).values({}).returning())[0]
      : { id: ownerUserId };

    // Real Interpreter service (interpret.ts), non-live gateway forced
    // above. This is the SAME code path a real question goes through —
    // server-side entity resolution against the projects catalog,
    // schema-validated model output, status/route derivation — not a
    // hand-built stand-in for it.
    const interpretResult = await createInterpretation(db, DEFAULT_PRODUCT_CONFIG, {
      userId: user.id,
      question,
    });
    const interp = interpretResult.interpretation;
    if (interp.status !== "READY" || interp.route !== "DEEP_RESEARCH" || !interp.understood) {
      console.error("[alpha-run] interpretation did not classify as DEEP_RESEARCH — refusing to fabricate a job for it");
      console.error(`  status: ${interp.status}, route: ${interp.route}, adjustment: ${interp.adjustment}`);
      console.error(`  --asset="${assetName}" must name one of interpreter/fake.ts's KNOWN_ASSETS, and the project catalog entry must resolve it.`);
      process.exit(1);
    }
    if (!interp.understood.projectSlug) {
      console.error("[alpha-run] interpretation classified DEEP_RESEARCH but resolved no project_slug — refusing to fabricate one");
      process.exit(1);
    }

    const entitlement: EntitlementSnapshot = {
      level: "ARI_CORE",
      capability: "FRESH_RESEARCH",
      // §6 — LIVE runs use the ONE immutable internal-alpha envelope,
      // never budget_core (the product default). Fixture mode keeps
      // using budget_core, unchanged from Stage 2.
      budget: mode === "live" ? INTERNAL_ALPHA_V1 : DEFAULT_PRODUCT_CONFIG.budget_core,
    };

    const createdAt = new Date();
    const normalizedTask = {
      project_slug: interp.understood.projectSlug,
      project_slugs: [interp.understood.projectSlug],
      task: interp.understood.researchTask,
    };
    // HIGH-1 closure §3: skipEnqueue — no pg-boss task is created for
    // this job, so no real worker process can ever pick it up
    // concurrently with this script's own direct handleResearchJobTask
    // call below (see module doc comment).
    const { job } = await createResearchJob(
      db,
      boss,
      {
        userId: user.id,
        topicId: topic.id,
        projectId: project.id,
        originalQuestion: question,
        normalizedTask,
        normalizedTaskHash: `alpha-run-${createdAt.getTime()}`,
        idempotencyKey: `alpha-run-${user.id}-${createdAt.getTime()}`,
        entitlement,
        demoLifetimeProofLimit: DEFAULT_PRODUCT_CONFIG.demo_lifetime_proof_limit,
      },
      { skipEnqueue: true },
    );

    const [interpRow] = await db.select({ result: interpretations.result }).from(interpretations).where(eq(interpretations.id, interp.id));
    const normalizedIntent = (interpRow?.result as { normalized_intent?: unknown } | null)?.normalized_intent;

    // Original Question -> Interpretation -> Job chain (LOCKED §5) — the
    // same link start-research.ts writes for a real request. Without
    // this, S7's loadIntentAndTaskType (claim-support-store.ts) finds no
    // interpretation row for the job and silently falls back to
    // normalized_intent=UNKNOWN.
    await db.update(interpretations).set({ researchJobId: job.id }).where(eq(interpretations.id, interp.id));

    // The REAL worker task handler — planning, then the frozen S4->S5->
    // S6->S7 engine, then the Stage 1 terminal-contract mapping — with
    // ONLY the executor swapped. Not a shortcut around S5/S6/S7, which
    // this handler still calls itself.
    const executor: WorkExecutor =
      mode === "live"
        ? createLiveS4WorkExecutor({ db, project, internalAlphaEnabled: config.internal_alpha_enabled })
        : createTraceFixtureExecutor({ db, project, defaultScenario: scenario });
    const result = await handleResearchJobTask(db, job.id, executor);

    if (!result.claimed) {
      // Never print success/"executor ran" for an invocation that did not
      // actually claim the job — this branch is unreachable in normal
      // operation (skipEnqueue means nothing else could have claimed it
      // first) but is handled explicitly rather than assumed away.
      console.error(`[alpha-run] did not claim job ${job.id} (reason: ${result.reason}) — no research work was performed by this invocation.`);
      process.exit(1);
    }

    const jobRow = (await db.select().from(researchJobs).where(eq(researchJobs.id, job.id)))[0];
    // S10 acceptance closure (MEDIUM-1, D-119): actual cost is calculated
    // from MODEL_CALL_ATTEMPTED audit rows only — QUERY_PROPOSED/EXTRACT_OK
    // no longer carry usage, so summing over all trace rows would double
    // count. No ::int narrowing — SUM(bigint) stays numeric-safe.
    const [{ actualCostMicroSum }] = (
      await db.execute(
        sql`SELECT COALESCE(SUM(${researchTraceEvents.actualCostMicro}), 0) AS "actualCostMicroSum" FROM ${researchTraceEvents} WHERE research_job_id = ${job.id} AND operation_type = 'MODEL_CALL_ATTEMPTED'`,
      )
    ).rows as [{ actualCostMicroSum: number }];

    console.log("[alpha-run]");
    console.log(`  mode:               ${mode}`);
    console.log(`  actor:              ${actor}`);
    console.log(`  owner:              ${user.id} (${ownerUserId === null ? "anonymous user created for this run" : "existing user, --owner"})`);
    console.log(`  jobId:              ${job.id}`);
    console.log(`  createdAt:          ${createdAt.toISOString()}`);
    console.log(`  interpretation:     normalized_intent=${normalizedIntent ?? "null"} task_type=${interp.understood.taskType ?? "null"} project_slug=${interp.understood.projectSlug}`);
    console.log(
      mode === "live"
        ? "  providers:          search=brave fetch=native query_proposer=anthropic evidence_extractor=anthropic (interpreter=fake, non-live)"
        : `  non-live mode:      true (trace-fixture executor, scenario=${scenario}, provider_name=non-live-fixture; interpreter gateway=fake)`,
    );
    console.log(`  project:            ${project.slug} (${project.id})`);
    console.log(`  job state:          ${jobRow.state}`);
    console.log(`  termination reason: ${jobRow.terminationReason ?? "(none)"}`);
    console.log(`  model cost (micro): reserved=${jobRow.modelCostMicroReserved} actual=${actualCostMicroSum} limit=${entitlement.budget.maxModelCostMicro}`);
    console.log(`  next inspection:    tsx scripts/alpha-inspect.ts ${job.id}`);
  } finally {
    await boss.stop({ graceful: false });
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
