import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projects, proofs, researchJobs, researchQuestionProjections, topics, users } from "../src/server/db/schema";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import type { WorkExecutor } from "../src/server/engine/controller";
import { PROJECTION_VERSION } from "../src/server/engine/question-projection";
import { generateQuestionProjection } from "../src/server/engine/question-projection-store";
import {
  __resetAnthropicQuestionProjectorClient,
  QuestionProjectionUnavailableError,
} from "../src/server/engine/providers/question-projection-anthropic";
import {
  createNonLiveQuestionProjector,
  createTraceFixtureExecutor,
  NON_LIVE_FIXTURE_PROVIDER_NAME,
} from "../src/server/engine/trace-fixture-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// FIXTURE QUESTION PROJECTION SPEND SAFETY V1.
//
// QUESTION_PROJECTION_LIFECYCLE_V1 moved the post-terminal question
// projection into the worker, where it now actually runs — for every
// SUCCEEDED / BUDGET_LIMIT_REACHED job, including the ones alpha-run's
// --mode=fixture drives through handleResearchJobTask. With a real
// ANTHROPIC_API_KEY in the environment, a "non-live" fixture run would
// have spent one real model call on presentation.
//
// The mechanism is the store's existing provider seam, threaded through
// handleResearchJobTask's options exactly like executorOverride, and a
// non-live projector that REFUSES rather than pretends. These tests prove:
//
//   * with a real-looking key present, a fixture run makes zero external
//     projection calls (the real client is never even constructed);
//   * the fixture job still reaches the post-terminal hook and leaves the
//     same terminal FAILED_MODEL row the credential-free environment does
//     — no synthetic "AI answer" is persisted;
//   * the budget path is covered the same way;
//   * the production worker path (no option) still resolves the real
//     projector, and the lifecycle/idempotency from 31d353e is unchanged;
//   * no process.env mutation and no chain/project special-case.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// The real projector caches its Anthropic client at module level. Each test
// that sets a key resets it afterwards so no test can inherit a client.
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  __resetAnthropicQuestionProjectorClient();
});

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function makeJob(): Promise<{ jobId: string; project: typeof projects.$inferSelect }> {
  const slug = uniq("fixproj");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Fixture projection project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: await activeTopicId(),
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "does protocol revenue reach token holders" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return { jobId: job.id, project };
}

async function projectionRows(jobId: string) {
  return ctx.db
    .select()
    .from(researchQuestionProjections)
    .where(eq(researchQuestionProjections.researchJobId, jobId));
}

async function jobRow(jobId: string) {
  const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return row;
}

// A key that LOOKS real. With it present, the real projector would build
// an Anthropic client and attempt a network call; the assertion is that
// nothing ever asks it to.
const REAL_LOOKING_KEY = "sk-ant-test-fixture-spend-safety-000000000000";

describe("fixture question projection — zero external model spend", () => {
  it("1. alpha-run's fixture wiring with a real-looking key: the non-live projector is used, the real client is never constructed, and the run completes", async () => {
    process.env.ANTHROPIC_API_KEY = REAL_LOOKING_KEY;
    const { jobId, project } = await makeJob();

    // What scripts/alpha-run.ts does in fixture mode, verbatim in shape.
    const executor = createTraceFixtureExecutor({ db: ctx.db, project, defaultScenario: "ADMISSIBLE_EVIDENCE" });
    let projectorCalls = 0;
    const nonLive = createNonLiveQuestionProjector();
    const counting = {
      name: nonLive.name,
      async project(input: Parameters<typeof nonLive.project>[0]) {
        projectorCalls += 1;
        return nonLive.project(input);
      },
    };
    const result = await handleResearchJobTask(ctx.db, jobId, executor, { questionProjector: counting });
    expect(result).toEqual({ claimed: true });

    const job = await jobRow(jobId);
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(job.state);
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof).toBeDefined();

    // The hook ran (the non-live projector was asked once) …
    expect(projectorCalls).toBe(1);
    // … and persisted the terminal failure row: no findings, no tokens, no
    // cost, no retry — never a synthetic answer.
    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("FAILED_MODEL");
    expect(rows[0].findings).toEqual([]);
    const meta = rows[0].modelMeta as { failureCode: string | null; inputTokens: number | null; actualCostMicroUsd: number | null };
    expect(meta.failureCode).toBe("PROVIDER_ERROR");
    expect(meta.inputTokens).toBeNull();
    expect(meta.actualCostMicroUsd).toBeNull();
  });

  it("2. the non-live projector itself never returns output and never touches the network", async () => {
    process.env.ANTHROPIC_API_KEY = REAL_LOOKING_KEY;
    const projector = createNonLiveQuestionProjector();
    expect(projector.name).toBe(NON_LIVE_FIXTURE_PROVIDER_NAME);
    await expect(
      projector.project({ question: "q", intent: null, components: [], requirements: [] }),
    ).rejects.toBeInstanceOf(QuestionProjectionUnavailableError);
    // Structural: the fixture module constructs no client of any kind.
    const src = readFileSync("src/server/engine/trace-fixture-executor.ts", "utf-8");
    expect(src).not.toContain("new Anthropic");
    expect(src).not.toContain("createAnthropicQuestionProjector");
    expect(src).not.toMatch(/from "@anthropic-ai\/sdk"/);
    expect(src).not.toMatch(/globalThis\.fetch|undici/);
  });

  it("3. BUDGET_LIMIT_REACHED fixture path: same seam, same safe outcome", async () => {
    process.env.ANTHROPIC_API_KEY = REAL_LOOKING_KEY;
    const { jobId } = await makeJob();
    let n = 0;
    const executor: WorkExecutor = {
      async execute() {
        n += 1;
        if (n <= 2) return { status: "SUCCEEDED", reason: "fixture component completed" };
        throw new BudgetExhaustedError("searchQueries", "SEARCH_QUERY_BUDGET_EXHAUSTED");
      },
    };
    let projectorCalls = 0;
    const nonLive = createNonLiveQuestionProjector();
    await handleResearchJobTask(ctx.db, jobId, executor, {
      questionProjector: {
        name: nonLive.name,
        async project(input) {
          projectorCalls += 1;
          return nonLive.project(input);
        },
      },
    });
    expect((await jobRow(jobId)).state).toBe("BUDGET_LIMIT_REACHED");
    expect(projectorCalls).toBe(1);
    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("FAILED_MODEL");
  });

  it("4. the production path (no option) still resolves the REAL projector — proven by the key-less refusal, with no fixture in sight", async () => {
    // No key in the test environment: the real projector refuses before
    // any network call. That refusal is the fingerprint of the real
    // provider being resolved; the fixture provider is not involved.
    delete process.env.ANTHROPIC_API_KEY;
    const { jobId } = await makeJob();
    const completing: WorkExecutor = {
      async execute() {
        return { status: "SUCCEEDED", reason: "fixture component completed" };
      },
    };
    await handleResearchJobTask(ctx.db, jobId, completing);
    expect((await jobRow(jobId)).state).toBe("SUCCEEDED");
    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("FAILED_MODEL");
    // Structural: the worker's default is the store's own resolution; the
    // option is the only way a projector reaches it, and the worker never
    // imports the fixture module.
    const worker = readFileSync("src/server/jobs/worker.ts", "utf-8");
    expect(worker).not.toMatch(/from "\.\.\/engine\/trace-fixture-executor"/);
    expect(worker).not.toContain("createNonLiveQuestionProjector(");
    expect(worker).toContain("options?.questionProjector ? { provider: options.questionProjector } : undefined");
    // And the phased path carries no override at all — always the real
    // projector there.
    expect(worker).toContain("generateQuestionProjectionSafely(ctx.db, jobId)");
  });

  it("5/6. lifecycle and idempotency from 31d353e are unchanged: the fixture row occupies the slot, re-entry is ALREADY_EXISTS with no call", async () => {
    process.env.ANTHROPIC_API_KEY = REAL_LOOKING_KEY;
    const { jobId } = await makeJob();
    const completing: WorkExecutor = {
      async execute() {
        return { status: "SUCCEEDED", reason: "fixture component completed" };
      },
    };
    await handleResearchJobTask(ctx.db, jobId, completing, { questionProjector: createNonLiveQuestionProjector() });
    expect((await projectionRows(jobId)).length).toBe(1);

    const again = await handleResearchJobTask(ctx.db, jobId, completing, { questionProjector: createNonLiveQuestionProjector() });
    expect(again).toEqual({ claimed: false, reason: "NOT_QUEUED" });

    let calls = 0;
    const willing = {
      name: "willing",
      async project() {
        calls += 1;
        return { findings: [] };
      },
    };
    const direct = await generateQuestionProjection(ctx.db, jobId, { provider: willing });
    expect(direct).toEqual({ kind: "SKIPPED", reason: "ALREADY_EXISTS" });
    expect(calls).toBe(0);
    const rows = await projectionRows(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].projectionVersion).toBe(PROJECTION_VERSION);
  });

  it("7/8. alpha-run wires the projector by MODE, not by project or chain, and mutates no environment variable", () => {
    const script = readFileSync("scripts/alpha-run.ts", "utf-8");
    const call = script.indexOf("mode === \"live\" ? undefined : { questionProjector: createNonLiveQuestionProjector() }");
    expect(call).toBeGreaterThan(-1);
    // The option travels on the same handleResearchJobTask call as the
    // executor override.
    const handler = script.lastIndexOf("await handleResearchJobTask(", call);
    expect(handler).toBeGreaterThan(-1);
    expect(call - handler).toBeLessThan(400);
    // No env hack anywhere near it, and none in the worker or the fixture.
    for (const [file, src] of [
      ["scripts/alpha-run.ts", script],
      ["src/server/jobs/worker.ts", readFileSync("src/server/jobs/worker.ts", "utf-8")],
      ["src/server/engine/trace-fixture-executor.ts", readFileSync("src/server/engine/trace-fixture-executor.ts", "utf-8")],
    ] as const) {
      expect(src, file).not.toMatch(/delete process\.env\.ANTHROPIC_API_KEY/);
      expect(src, file).not.toMatch(/process\.env\.ANTHROPIC_API_KEY\s*=/);
    }
    // No project, chain or intent literal decides it.
    const fixture = readFileSync("src/server/engine/trace-fixture-executor.ts", "utf-8");
    const projectorBlock = fixture.slice(fixture.indexOf("export function createNonLiveQuestionProjector"));
    for (const literal of ["ethereum", "solana", "lido", "pump_fun", "TOKEN_SUPPLY"]) {
      expect(projectorBlock, literal).not.toContain(literal);
    }
  });
});
