// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) —
// internal/admin script. Creates ONE research job through the existing
// service layer (createResearchJob — same admission/quota/idempotency
// path any real job goes through) and drives it through the REAL
// worker task handler (handleResearchJobTask), never by calling
// S5/S6/S7 directly as a shortcut. Strictly non-live: the executor is
// always the Stage 2 trace fixture (trace-fixture-executor.ts), itself
// built entirely from non-live providers — never createNonLiveS4WorkExecutor
// is bypassed toward anything live, and research_enabled is never read
// or written by this script.
//
// Execution and inspection are deliberately separate scripts — this one
// creates and runs; alpha-inspect.ts (read-only) is how you look at the
// result.
//
// Usage:
//   tsx scripts/alpha-run.ts --actor=<name> [--project=<slug>] [--question="..."] [--scenario=<name>]
//
// --actor is required (owner/admin invocation must name who is running
// this, for the audit trail printed below — this script does not
// silently run as an anonymous identity).
import { eq } from "drizzle-orm";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { projects, topics, users } from "../src/server/db/schema";
import { createBoss, RESEARCH_QUEUE } from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { createTraceFixtureExecutor, type TraceFixtureScenario } from "../src/server/engine/trace-fixture-executor";
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
    console.error("usage: tsx scripts/alpha-run.ts --actor=<name> [--project=<slug>] [--question=\"...\"] [--scenario=<name>]");
    process.exit(1);
  }
  const projectSlug = args.project;
  const question = args.question ?? "does protocol revenue reach token holders?";
  const scenario = (args.scenario ?? "ADMISSIBLE_EVIDENCE") as TraceFixtureScenario;

  const { db, pool } = createDatabase();
  const boss = createBoss();
  await boss.start();
  await boss.createQueue(RESEARCH_QUEUE);
  try {
    const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
    if (!topic) throw new Error("no active topic found — is the database seeded?");

    let project = projectSlug ? (await db.select().from(projects).where(eq(projects.slug, projectSlug)))[0] : undefined;
    if (!project) {
      [project] = await db
        .insert(projects)
        .values({ slug: projectSlug ?? `alpha_run_${Date.now()}`, name: "First Real Run Stage 2 alpha project", status: "ACTIVE_CORE" })
        .returning();
    }

    // Internal alpha tooling has no notion of a real end-user account —
    // a fresh user row is created per run and printed alongside the
    // human-readable --actor label, which IS the audit identity (this
    // schema has no free-text label column on `users`, by design —
    // production users are Telegram-identity-linked, not admin-labeled).
    const [user] = await db.insert(users).values({}).returning();

    const entitlement: EntitlementSnapshot = {
      level: "ARI_CORE",
      capability: "FRESH_RESEARCH",
      budget: DEFAULT_PRODUCT_CONFIG.budget_core,
    };

    const createdAt = new Date();
    const { job } = await createResearchJob(db, boss, {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: `alpha-run-${createdAt.getTime()}`,
      idempotencyKey: `alpha-run-${user.id}-${createdAt.getTime()}`,
      entitlement,
      demoLifetimeProofLimit: DEFAULT_PRODUCT_CONFIG.demo_lifetime_proof_limit,
    });

    // The REAL worker task handler — planning, then the frozen S4->S5->
    // S6->S7 engine, then the Stage 1 terminal-contract mapping — with
    // ONLY the executor swapped for the non-live trace fixture (§K: not
    // a shortcut around S5/S6/S7, which this handler still calls itself).
    const executor = createTraceFixtureExecutor({ db, project, defaultScenario: scenario });
    await handleResearchJobTask(db, job.id, executor);

    console.log("[alpha-run]");
    console.log(`  actor:              ${actor}`);
    console.log(`  jobId:              ${job.id}`);
    console.log(`  createdAt:          ${createdAt.toISOString()}`);
    console.log(`  non-live mode:      true (trace-fixture executor, scenario=${scenario}, provider_name=non-live-fixture)`);
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
