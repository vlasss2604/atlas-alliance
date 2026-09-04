import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  projects,
  researchClaimSupport,
  researchJobs,
  topics,
  users,
} from "../src/server/db/schema";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import { CapabilityFatalError } from "../src/server/engine/capability-fatal-error";
import type { WorkExecutor } from "../src/server/engine/controller";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function queueJob(entitlement: EntitlementSnapshot): Promise<string> {
  const slug = uniq("budget_proj");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Budget projection project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: await activeTopicId(),
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: {
      project_slug: slug,
      project_slugs: [slug],
      task: "does protocol revenue reach token holders",
    },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement,
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

// D-127 — the first real owner-alpha runs stopped on an exhausted job
// budget AXIS (searchQueries), which s4-executor.ts signals by THROWING
// BudgetExhaustedError. That exception propagated straight out of
// runS4ResearchJob, skipping the S5 sweep / S6 assembly / S7 claim-support
// steps that live after the controller call — so a job that had already
// collected and persisted real evidence ended with NO mechanism row and NO
// research_claim_support row at all, rendering a blank "stopped, no
// finding" screen.
//
// worker.ts's own terminal-contract comment for this exact case says the
// opposite is intended: "budget exhaustion with incomplete evidence is NOT
// a system/provider failure — research_claim_support may legitimately be
// INSUFFICIENT_EVIDENCE for this job, and that is an honest evidentiary
// outcome". The controller's attempt-count BUDGET_EXHAUSTED stop reason
// (returned rather than thrown) already reached those steps normally, so
// the same logical condition behaved differently depending only on which
// mechanism detected it.
describe("runS4ResearchJob — budget exhaustion still produces derived projections (D-127)", () => {
  it("runs S5/S6/S7 and persists claim support when real research preceded the BudgetExhaustedError, then re-throws unchanged", async () => {
    const jobId = await queueJob(coreEntitlement());

    // Models the REAL production shape: some components complete normally
    // (so S5 reconciles component results for them), and only then does a
    // required reservation get refused and s4-executor.ts throw. No
    // provider, no network, no spend.
    let calls = 0;
    const executor: WorkExecutor = {
      async execute() {
        calls += 1;
        if (calls <= 2) {
          return {
            status: "SUCCEEDED",
            reason: "fixture component completed",
            spent: { searchQueries: 1, sourceOpens: 1, authorizedModelCostMicro: 0 },
          };
        }
        throw new BudgetExhaustedError("searchQueries", "SEARCH_QUERY_BUDGET_EXHAUSTED");
      },
    };

    await expect(runS4ResearchJob(ctx.db, jobId, executor, new Date())).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );

    // The projections must have run despite the throw. S7 writes exactly
    // one claim-support row per job once S6 has produced an assembly.
    const support = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, jobId));
    expect(support.length).toBe(1);
    // With no admissible evidence behind those components this is
    // INSUFFICIENT_EVIDENCE — an honest evidentiary outcome, never a
    // fabricated conclusion.
    expect(support[0].status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("skips the projection entirely when the budget was refused before ANY component completed (accepted D-120 'stopped before S7')", async () => {
    const jobId = await queueJob(coreEntitlement());
    // Refused on the very first item: no component ever reached a terminal
    // S4 attempt, so there is genuinely nothing to project. Inventing an
    // assembly + claim-support row here would assert an evidentiary
    // conclusion about research that never happened.
    const executor: WorkExecutor = {
      async execute() {
        throw new BudgetExhaustedError("searchQueries", "SEARCH_QUERY_BUDGET_EXHAUSTED");
      },
    };

    await expect(runS4ResearchJob(ctx.db, jobId, executor, new Date())).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );

    const support = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, jobId));
    expect(support.length).toBe(0);
  });

  it("terminal job state is still BUDGET_LIMIT_REACHED/BUDGET_EXHAUSTED — the exception is re-thrown, not swallowed", async () => {
    const jobId = await queueJob(coreEntitlement());
    const executor: WorkExecutor = {
      async execute() {
        throw new BudgetExhaustedError("sourceOpens", "SOURCE_OPEN_BUDGET_EXHAUSTED");
      },
    };

    let caught: unknown = null;
    try {
      await runS4ResearchJob(ctx.db, jobId, executor, new Date());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError);
    expect((caught as BudgetExhaustedError).axis).toBe("sourceOpens");

    // Nothing here writes a terminal state — that stays worker.ts's job,
    // and its mapping (BudgetExhaustedError -> BUDGET_LIMIT_REACHED /
    // BUDGET_EXHAUSTED) is unchanged because the exception still escapes.
    const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(row.state).not.toBe("SUCCEEDED");
  });

  it("is NARROW: a CapabilityFatalError still propagates immediately with no projection written", async () => {
    const jobId = await queueJob(coreEntitlement());
    const executor: WorkExecutor = {
      async execute() {
        throw new CapabilityFatalError("QUERY_PROPOSER", "QUERY_PROPOSER_FAILED:TestError");
      },
    };

    await expect(runS4ResearchJob(ctx.db, jobId, executor, new Date())).rejects.toBeInstanceOf(
      CapabilityFatalError,
    );

    // A broken capability is not an evidentiary outcome — no claim support
    // row may be invented for it.
    const support = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, jobId));
    expect(support.length).toBe(0);
  });
});
