// First Real Run, Stage 2 acceptance closure (pipeline-integration-stage2.md,
// D-115/D-116) — internal/admin script. Creates ONE research job through
// the existing service layer (createResearchJob — same admission/quota/
// idempotency path any real job goes through) and drives it through the
// REAL worker task handler (handleResearchJobTask), never by calling
// S5/S6/S7 directly as a shortcut. Strictly non-live: the executor is
// always the Stage 2 trace fixture (trace-fixture-executor.ts), itself
// built entirely from non-live providers — createNonLiveS4WorkExecutor is
// never bypassed toward anything live, and research_enabled is never read
// or written by this script.
//
// MEDIUM-3 closure: a real question run through this script now goes
// through the REAL Interpreter service (createInterpretation) before the
// job is created — S7 (claim-support-store.ts's loadIntentAndTaskType)
// reads normalized_intent/task_type from the `interpretations` row it
// finds via `interpretations.researchJobId`, NOT from job.normalizedTask.
// The previous version of this script never created or linked an
// interpretation row at all, so that lookup always found zero rows and
// silently fell back to normalized_intent=UNKNOWN — S7 could never
// evaluate a real requirement set no matter what Evidence Stage 2's
// fixture produced. This script forces the Interpreter's own `fake`
// gateway (interpreter/fake.ts) — an existing, deterministic, non-live
// fixture already used by the test suite — via __setInterpreterGateway,
// so classification never depends on MODEL_GATEWAY being set correctly
// in the environment and never makes a live model call.
//
// HIGH-1 closure: this script creates the job with { skipEnqueue: true }
// (research-jobs.ts) — no pg-boss task is ever enqueued for it, so there
// is no possibility of a real worker process racing this script for the
// same job. The atomic claim in handleResearchJobTask (worker.ts) is the
// general production safety net for concurrent workers; this script
// simply never creates the second competitor in the first place.
//
// Execution and inspection are deliberately separate scripts — this one
// creates and runs; alpha-inspect.ts (read-only) is how you look at the
// result.
//
// Usage:
//   tsx scripts/alpha-run.ts --actor=<name> [--asset=<name>] [--project=<slug>] [--question="..."] [--scenario=<name>]
//
// --actor is required (owner/admin invocation must name who is running
// this, for the audit trail printed below — this script does not
// silently run as an anonymous identity).
//
// --asset must name one of interpreter/fake.ts's KNOWN_ASSETS (default
// "Aave") — the fake Interpreter gateway only classifies DEEP_RESEARCH
// for a question that names a recognized asset; anything else falls back
// to NEEDS_CLARIFICATION/UNKNOWN by the real Interpreter contract's own
// design, and this script fails loudly rather than fabricating a fake
// normalized_intent to route around that.
import { eq } from "drizzle-orm";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { interpretations, projects, topics, users } from "../src/server/db/schema";
import { createBoss, RESEARCH_QUEUE } from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { createTraceFixtureExecutor, type TraceFixtureScenario } from "../src/server/engine/trace-fixture-executor";
import { createInterpretation } from "../src/server/interpreter/interpret";
import { __setInterpreterGateway } from "../src/server/interpreter/gateway";
import { fakeGateway } from "../src/server/interpreter/fake";
import type { EntitlementSnapshot } from "../src/server/domain/types";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const actor = args.actor;
  if (!actor) {
    console.error(
      'usage: tsx scripts/alpha-run.ts --actor=<name> [--asset=<name>] [--project=<slug>] [--question="..."] [--scenario=<name>]',
    );
    process.exit(1);
  }

  // Non-live guarantee for the Interpreter call below: explicit, not
  // dependent on the MODEL_GATEWAY environment variable being set
  // correctly (interpreter/gateway.ts's own fake-in-production guard is
  // a second, independent backstop, not relied on here).
  __setInterpreterGateway(fakeGateway);

  const assetName = args.asset ?? "Aave";
  const projectSlug = args.project ?? assetName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const question = args.question ?? `does protocol revenue reach ${assetName} token holders?`;
  const scenario = (args.scenario ?? "ADMISSIBLE_EVIDENCE") as TraceFixtureScenario;

  const { db, pool } = createDatabase();
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
    const [user] = await db.insert(users).values({}).returning();

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
      budget: DEFAULT_PRODUCT_CONFIG.budget_core,
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
    // normalized_intent=UNKNOWN (the exact MEDIUM-3 defect this closure
    // fixes) — this update is what actually connects the classification
    // above to the job S4/S5/S6/S7 will run against.
    await db.update(interpretations).set({ researchJobId: job.id }).where(eq(interpretations.id, interp.id));

    // The REAL worker task handler — planning, then the frozen S4->S5->
    // S6->S7 engine, then the Stage 1 terminal-contract mapping — with
    // ONLY the executor swapped for the non-live trace fixture. Not a
    // shortcut around S5/S6/S7, which this handler still calls itself.
    const executor = createTraceFixtureExecutor({ db, project, defaultScenario: scenario });
    const result = await handleResearchJobTask(db, job.id, executor);

    if (!result.claimed) {
      // §2 of the closure spec: never print success/"trace-fixture
      // executor ran" for an invocation that did not actually claim the
      // job — this branch is unreachable in normal operation (skipEnqueue
      // means nothing else could have claimed it first) but is handled
      // explicitly rather than assumed away, in case this job id was
      // reused or raced by something else entirely.
      console.error(`[alpha-run] did not claim job ${job.id} (reason: ${result.reason}) — no research work was performed by this invocation.`);
      process.exit(1);
    }

    console.log("[alpha-run]");
    console.log(`  actor:              ${actor}`);
    console.log(`  jobId:              ${job.id}`);
    console.log(`  createdAt:          ${createdAt.toISOString()}`);
    console.log(`  interpretation:     normalized_intent=${normalizedIntent ?? "null"} task_type=${interp.understood.taskType ?? "null"} project_slug=${interp.understood.projectSlug}`);
    console.log(`  non-live mode:      true (trace-fixture executor, scenario=${scenario}, provider_name=non-live-fixture; interpreter gateway=fake)`);
    console.log(`  project:            ${project.slug} (${project.id})`);
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
