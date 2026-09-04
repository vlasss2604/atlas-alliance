import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { projects, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { __setOnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import type { OnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { KNOWN_ARGS, parseArgs, parseRunMode } from "../scripts/alpha-acquire-url";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// DOCUMENTARY-ONLY MODE — the owner instruction that a run performs no
// chain work at all, and the allowlist that admits a project to
// internal-alpha live execution.
//
// The point of the mode is STRUCTURAL: "no RPC" must hold because the
// on-chain branch is never entered, not because the database happens to
// contain nothing to address. The boundary test below therefore proves
// BOTH halves — that the retriever IS reached in the ordinary mode with
// this exact state, and that it is NOT reached in documentary-only mode.
// Remove the guard and the second half fails.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

afterEach(() => {
  __setOnchainRetriever(null);
});

// A Solana mint shape, invented — no real project's address is used here.
const FIXTURE_MINT = "So11111111111111111111111111111111111111112";

// A retriever that COUNTS instead of retrieving. Every call is an RPC that
// would have happened; `retrieve` is the network surface itself.
function spyRetriever() {
  const calls = { supports: 0, retrieve: 0 };
  const retriever: OnchainRetriever = {
    name: "spy",
    supports() {
      calls.supports += 1;
      return true;
    },
    async retrieve() {
      calls.retrieve += 1;
      throw new Error("the spy must never be asked to retrieve");
    },
  };
  return { calls, retriever };
}

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function projectWithConfirmedIdentity() {
  const slug = uniq("docs_only");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Documentary-only fixture", status: "ACTIVE_CORE" })
    .returning();
  // The REAL confirmation path — an ACTIVE identity is what makes the
  // on-chain branch reachable at all.
  const confirmed = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: FIXTURE_MINT,
  });
  expect(confirmed.ok).toBe(true);
  return project;
}

async function queueJob(projectId: string, topicId: string, e: EntitlementSnapshot): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId,
    projectId,
    originalQuestion: "what does the project's own documentation state?",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "read the documentation" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: e,
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

const FIXTURE = "non-live-fixture";
const COST = {
  modelId: "t",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  priceVersion: "t",
};

// NET_EFFECT takes a TOKEN_SUPPLY intent, whose subject is the project
// anchor itself — so the on-chain branch is reachable from a confirmed
// identity alone. That makes it the sharpest case for the guard: chain
// work would definitely occur here without it.
function workItem(): ComponentWorkItem {
  return {
    step: 7,
    stepName: "Net Token Effect",
    component: "NET_EFFECT",
    state: "NO_MEMORY",
    blockers: [],
    memoryIds: [],
    conflictingMemoryIds: [],
  };
}

function executorFor(
  project: { id: string; slug: string; name: string; ticker: string | null },
  chainAcquisition?: "ENABLED" | "DOCUMENTARY_ONLY",
) {
  return createS4WorkExecutor({
    db: ctx.db,
    project,
    queryProposer: { name: FIXTURE, async proposeQueries() { return ["q"]; } },
    searchGateway: { name: FIXTURE, async search() { return []; } },
    contentFetcher: { name: FIXTURE, async fetch() { throw new Error("no documentary fetch in this test"); } },
    evidenceExtractor: { name: FIXTURE, async extract() { return []; } },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    ...(chainAcquisition === undefined ? {} : { chainAcquisition }),
  });
}

async function run(
  project: { id: string; slug: string; name: string; ticker: string | null },
  jobId: string,
  chainAcquisition?: "ENABLED" | "DOCUMENTARY_ONLY",
) {
  const executor = executorFor(project, chainAcquisition);
  return executor.execute(workItem(), {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 1, maxSourceOpens: 2, maxModelCostMicro: 2_000_000 },
  });
}

describe("1/2/11. the internal-alpha live allowlist stays closed", () => {
  it("1. raydium is alpha-live-enabled", () => {
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("raydium")).toBe(true);
  });

  it("11. pump_fun, the first approved target, is unchanged", () => {
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("pump_fun")).toBe(true);
  });

  it("2. an unrelated CATALOG project remains disabled", () => {
    // uniswap and hyperliquid are in the catalog and in research scope —
    // only the allowlist keeps them out of live execution.
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("uniswap")).toBe(false);
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("hyperliquid")).toBe(false);
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("some_random_project")).toBe(false);
  });

  it("it is an enumerated set, not a rule that could admit a project by shape", () => {
    expect([...INTERNAL_ALPHA_LIVE_PROJECT_SLUGS].sort()).toEqual(["pump_fun", "raydium"]);
  });
});

describe("3/4/14. the CLI mode contract", () => {
  it("3. documentary-only is accepted", () => {
    expect(parseRunMode("documentary-only")).toBe("documentary-only");
  });

  it("omitting the flag is the ordinary mode, so existing invocations are unchanged", () => {
    expect(parseRunMode(undefined)).toBe("default");
    expect(parseRunMode("default")).toBe("default");
  });

  it("4. an unknown mode VALUE is refused, never coerced", () => {
    for (const bad of ["", "docs-only", "no-chain", "DOCUMENTARY-ONLY", "true", "1", "off"]) {
      expect(parseRunMode(bad), bad).toBeNull();
    }
  });

  it("4b. an unknown FLAG is surfaced rather than silently dropped", () => {
    // The real hazard: a misspelt safety flag that the parser ignores would
    // run with chain work ENABLED while the operator believed it off.
    const { args, unknown } = parseArgs([
      "--url=https://x.test/a",
      "--docs-only=true",
      "--no-chain",
      "--mode=documentary-only",
    ]);
    expect(args.url).toBe("https://x.test/a");
    expect(args.mode).toBe("documentary-only");
    expect(unknown).toEqual(["--docs-only=true", "--no-chain"]);
  });

  it("the known-argument set is closed and contains no surprises", () => {
    expect([...KNOWN_ARGS].sort()).toEqual(["actor", "component", "mode", "project", "step", "url"]);
  });

  it("14. the operator-facing contract describes chain work as CONDITIONAL, not absent", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../scripts/alpha-acquire-url.ts", import.meta.url), "utf-8");
    // The old claim was unconditional and wrong.
    expect(src).not.toContain("NO CHAIN CALL. No on-chain retriever is in this file's import graph");
    expect(src).toContain("CHAIN WORK IS CONDITIONAL");
    expect(src).toContain("WITHOUT --mode=documentary-only");
    expect(src).toContain("WITH --mode=documentary-only");
  });
});

describe("5-10. the structural guarantee, proved in both directions", () => {
  it("10/boundary: WITHOUT the mode, this exact state DOES reach the retriever", async () => {
    // Without this half the zero below would prove nothing — it could be
    // an artefact of the fixture rather than of the guard.
    const { calls, retriever } = spyRetriever();
    __setOnchainRetriever(retriever);
    const project = await projectWithConfirmedIdentity();
    const jobId = await queueJob(project.id, await activeTopicId(), coreEntitlement());

    await run(project, jobId); // no chainAcquisition — the default
    expect(calls.supports + calls.retrieve).toBeGreaterThan(0);
  });

  it("6/7/8/9. WITH documentary-only, the retriever is never touched — RPC count is exactly zero", async () => {
    const { calls, retriever } = spyRetriever();
    __setOnchainRetriever(retriever);
    const project = await projectWithConfirmedIdentity();
    const jobId = await queueJob(project.id, await activeTopicId(), coreEntitlement());

    // A configured retriever, a confirmed Solana identity, and a component
    // whose intent addresses the anchor: every prerequisite the ordinary
    // path needs is satisfied. Only the owner instruction stops it.
    const outcome = await run(project, jobId, "DOCUMENTARY_ONLY");

    expect(calls.retrieve).toBe(0);
    expect(calls.supports).toBe(0);
    expect(outcome.status).toBeTruthy();
  });

  it("mutation check: the SAME state, both modes — the only difference is the guard", async () => {
    // The two halves in one assertion, so the contrast itself is what is
    // pinned. Delete the guard in s4-executor and this fails immediately:
    // the documentary-only count becomes non-zero.
    const project = await projectWithConfirmedIdentity();
    const topicId = await activeTopicId();

    const ordinary = spyRetriever();
    __setOnchainRetriever(ordinary.retriever);
    await run(project, await queueJob(project.id, topicId, coreEntitlement()));

    const guarded = spyRetriever();
    __setOnchainRetriever(guarded.retriever);
    await run(project, await queueJob(project.id, topicId, coreEntitlement()), "DOCUMENTARY_ONLY");

    expect(ordinary.calls.supports + ordinary.calls.retrieve).toBeGreaterThan(0);
    expect(guarded.calls.supports + guarded.calls.retrieve).toBe(0);
  });

  it("5. documentary-only does NOT disable the documentary path — it still runs and reports", async () => {
    const { retriever } = spyRetriever();
    __setOnchainRetriever(retriever);
    const project = await projectWithConfirmedIdentity();
    const jobId = await queueJob(project.id, await activeTopicId(), coreEntitlement());

    let searched = 0;
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: FIXTURE, async proposeQueries() { return ["q"]; } },
      searchGateway: {
        name: FIXTURE,
        async search() {
          searched += 1;
          return [];
        },
      },
      contentFetcher: { name: FIXTURE, async fetch() { throw new Error("unused"); } },
      evidenceExtractor: { name: FIXTURE, async extract() { return []; } },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    const outcome = await executor.execute(workItem(), {
      jobId,
      attemptNumber: 1,
      isRecoveryAttempt: false,
      budget: { maxSearchQueries: 1, maxSourceOpens: 2, maxModelCostMicro: 2_000_000 },
    });
    // The run continued past the skipped chain branch into the ordinary
    // documentary path, rather than short-circuiting the attempt.
    expect(searched).toBeGreaterThan(0);
    expect(outcome.status).toBeTruthy();
  });

  it("with no retriever configured, neither mode performs RPC — so the mode is the guard, not the config", async () => {
    // A guard that merely mirrored `onchainRetrievalAvailable()` would be
    // indistinguishable HERE. It is the test above, with a retriever
    // configured, that separates the two.
    __setOnchainRetriever(null);
    const project = await projectWithConfirmedIdentity();
    const topicId = await activeTopicId();
    await expect(
      run(project, await queueJob(project.id, topicId, coreEntitlement())),
    ).resolves.toBeTruthy();
    await expect(
      run(project, await queueJob(project.id, topicId, coreEntitlement()), "DOCUMENTARY_ONLY"),
    ).resolves.toBeTruthy();
  });
});

describe("12/13. the exact-URL acquisition envelope is unchanged", () => {
  it("12. search stays absent from the owner entrypoint, and 13. no retry is introduced", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../scripts/alpha-acquire-url.ts", import.meta.url), "utf-8");
    // The single-URL SearchGateway fixture is still what narrows the run,
    // and Brave is still never constructed.
    expect(src).toContain("owner-supplied-url");
    expect(src).not.toContain("brave");
    expect(src).not.toContain("Brave(");
    // One attempt, never a loop.
    expect(src).toContain("attemptNumber: 1");
    expect(src).toContain("isRecoveryAttempt: false");
    expect(src).toContain("maxSourceOpens: 2");
    expect(src).toContain("maxSearchQueries: 1");
  });
});
