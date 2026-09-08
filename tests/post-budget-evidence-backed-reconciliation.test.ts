import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  evidence,
  projects,
  researchAttempts,
  researchComponentResults,
  researchJobs,
  researchTraceEvents,
  onchainArtifacts,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { reconcileOutstandingComponents } from "../src/server/engine/component-reconciliation-store";
import {
  persistOnchainArtifact,
  persistOnchainArtifactAndFacts,
} from "../src/server/engine/onchain-acquisition";
import { runSupplyDeltaMaterialization } from "../src/server/engine/onchain-supply-delta-materialization";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// EVIDENCE ALREADY PAID FOR IS STILL REDUCED WHEN ACQUISITION STOPS.
//
// THE DEFECT. `BudgetExhaustedError` is thrown at the reservation boundary,
// so the controller's work loop aborts mid-queue: every component after the
// throwing one is left with NO attempt row, and no later sweep can change
// that, because nothing will ever attempt them again. The post-exhaustion
// continuation in run-job.ts then WRITES EVIDENCE INTO EXACTLY SUCH A
// COMPONENT — `runSupplyDeltaMaterialization` files a TOTAL_SUPPLY_DELTA
// under the component whose question it answers — and the sweep that runs
// immediately afterwards refused to read it, because the gate required a
// terminal attempt the component could never have. A live run established a
// deterministic burn, a comparable interval and a measured decrease, and
// reported the component as MISSING.
//
// WHAT IS PROVED HERE. That the reducer was ALREADY capable of the answer
// (tests/net-effect-measured-supply.test.ts drives it directly and gets the
// same verdict) and that only ORCHESTRATION REACHABILITY changed: the same
// evidence, with no attempt row, now reconciles when — and only when —
// acquisition has definitively stopped.
//
// AND THAT THE EXCEPTION IS NARROW. Six negative tests below pin the cases
// that must stay untouched, because "work never finished" and "the evidence
// is insufficient" are different findings and must not be merged.
//
// Every identifier is a fixture literal. No project, mint or transaction is
// named anywhere in this file.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-08T00:00:00.000Z");
const EXECUTION = { step: 4, component: "EXECUTION_EVIDENCE" };
const NET_EFFECT = { step: 7, component: "NET_EFFECT" };
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";

let seq = 0;
// Base58 excludes 0, O, I and l, so the counter is rendered in the digits
// 1-9 only — a decimal "10" would be a malformed identifier and the
// identity gate would (correctly) refuse the fixture.
function nextBase58(len: number, tag: string): string {
  seq += 1;
  let digits = "";
  let n = seq;
  do {
    digits = "123456789"[n % 9] + digits;
    n = Math.floor(n / 9);
  } while (n > 0);
  const head = `${tag}${digits}`;
  return (head + "z".repeat(Math.max(0, len - head.length))).slice(0, len);
}
const nextMint = () => nextBase58(44, "Mint");
const nextSignature = () => nextBase58(88, "Sig");

interface Fixture {
  projectId: string;
  slug: string;
  mint: string;
  priorJobId: string;
  jobId: string;
}

async function makeJob(projectId: string, slug: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "does the mechanism reduce total supply?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "supply effect" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function makeFixture(): Promise<Fixture> {
  const slug = uniq("pbr");
  const mint = nextMint();
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Post-budget fixture", status: "ACTIVE_CORE" })
    .returning();
  const ok = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: mint,
  });
  if (!ok.ok) throw new Error("fixture identity failed");
  return {
    projectId: project.id,
    slug,
    mint,
    priorJobId: await makeJob(project.id, slug),
    jobId: await makeJob(project.id, slug),
  };
}

const identityFor = (mint: string) => ({ chain: "solana" as const, tokenAddress: mint, ticker: null });

function artifact(intent: OnchainIntent, result: object, slot: number): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result: result as never,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: intent.projectAnchor,
      subjectKind: intent.subjectKind,
      subject: intent.subject,
      slot,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "fixture",
      requestParams: {},
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:${intent.kind}:${intent.subject}:${slot}`,
      artifactHash: `sha256:art:${intent.kind}:${intent.subject}:${slot}`,
      transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
    },
  });
}

async function establishBurn(f: Fixture, slot: number): Promise<void> {
  const signature = nextSignature();
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: f.mint,
    subjectKind: "tx",
    subject: signature,
  };
  await persistOnchainArtifactAndFacts({
    db: ctx.db,
    jobId: f.jobId,
    artifact: artifact(
      intent,
      {
        kind: "TRANSACTION_DETAIL",
        signature,
        slot,
        blockTime: 1_700_000_000,
        succeeded: true,
        burns: [
          {
            programId: "TokenProg1111111111111111111111111111111111",
            instructionType: "BurnChecked",
            mint: f.mint,
            sourceAccount: TOKEN_ACCOUNT,
            authority: null,
            amountRaw: "10000000000000",
            decimals: 6,
          },
        ] as BurnInstructionRef[],
        programs: [],
        accountKeys: [],
        tokenInstructions: [],
        lifecycleInstructions: [],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      slot,
    ),
    identity: identityFor(f.mint),
    target: EXECUTION,
  });
}

async function observeSupply(jobId: string, mint: string, slot: number, amountRaw: string) {
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };
  const stored = await persistOnchainArtifact({
    db: ctx.db,
    origin: { kind: "RESEARCH_JOB", jobId },
    artifact: artifact(intent, { kind: "TOKEN_SUPPLY", mint, amountRaw, decimals: 6 }, slot),
    identity: identityFor(mint),
  });
  if (!stored.artifactId) throw new Error(`observe failed: ${stored.rejectedReason}`);
}

// The live shape, reproduced: a burn, a comparable interval containing it,
// and the delta the production materializer derives from them — with NO S4
// attempt row for NET_EFFECT, exactly as a job whose work loop died before
// that component's turn.
async function measuredDecreaseWithNoAttempt(): Promise<Fixture> {
  const f = await makeFixture();
  await establishBurn(f, 500);
  await observeSupply(f.priorJobId, f.mint, 100, "1000");
  await observeSupply(f.jobId, f.mint, 900, "900");
  await runSupplyDeltaMaterialization(ctx.db, { jobId: f.jobId, projectId: f.projectId });
  const attempts = await ctx.db
    .select()
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, f.jobId));
  // The premise of every assertion below.
  expect(attempts.filter((a) => a.component === "NET_EFFECT")).toHaveLength(0);
  return f;
}

async function resultFor(jobId: string, component: string) {
  const rows = await ctx.db
    .select()
    .from(researchComponentResults)
    .where(
      and(
        eq(researchComponentResults.researchJobId, jobId),
        eq(researchComponentResults.component, component),
      ),
    );
  return rows[0] ?? null;
}

const sweep = (jobId: string, queue: { step: number; component: string }[], stopped: boolean) =>
  reconcileOutstandingComponents(ctx.db, jobId, queue, NOW, { acquisitionStopped: stopped });

// ---------------------------------------------------------------------
describe("evidence-backed reconciliation after acquisition has stopped", () => {
  it("THE DEFECT: without the stop context, a measured decrease is still discarded", async () => {
    const f = await measuredDecreaseWithNoAttempt();
    await sweep(f.jobId, [NET_EFFECT], false);
    // Exactly the live failure: the delta exists, and the component does not.
    expect(await resultFor(f.jobId, "NET_EFFECT")).toBeNull();
  }, 120_000);

  it("THE FIX: the same evidence reconciles once acquisition has definitively stopped", async () => {
    const f = await measuredDecreaseWithNoAttempt();
    await sweep(f.jobId, [NET_EFFECT], true);
    const result = await resultFor(f.jobId, "NET_EFFECT");
    expect(result).not.toBeNull();
    // THE VERDICT IS THE REDUCER'S, UNCHANGED. A burn is established and
    // supply fell across an interval containing it; the measurement is
    // established and the cause is not, which is why SUPPORTED is refused.
    expect(result!.status).toBe("PARTIALLY_SUPPORTED");
    expect(result!.status).not.toBe("SUPPORTED");
    expect(result!.reasonCodes as string[]).toContain("NET_SUPPLY_CHANGE_NOT_ATTRIBUTED");
    expect(result!.reasonCodes as string[]).not.toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
  }, 120_000);

  it("the fix changed reachability only — no attempt row was invented", async () => {
    const f = await measuredDecreaseWithNoAttempt();
    await sweep(f.jobId, [NET_EFFECT], true);
    const attempts = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, f.jobId));
    expect(attempts.filter((a) => a.component === "NET_EFFECT")).toHaveLength(0);
  }, 120_000);
});

// ---------------------------------------------------------------------
describe("the exception is narrow — what must stay untouched", () => {
  it("1. no evidence and no terminal attempt: the component stays unreconciled", async () => {
    const f = await makeFixture();
    // Nothing acquired at all. Even with acquisition stopped, there is
    // nothing to reduce, and a synthesized empty result would assert a
    // finding about work that never happened.
    await sweep(f.jobId, [NET_EFFECT], true);
    expect(await resultFor(f.jobId, "NET_EFFECT")).toBeNull();
  }, 120_000);

  it("2. active acquisition: a pending component with real evidence is NOT reconciled early", async () => {
    const f = await measuredDecreaseWithNoAttempt();
    // The default — every ordinary sweep and the per-attempt hook.
    await reconcileOutstandingComponents(ctx.db, f.jobId, [NET_EFFECT], NOW);
    expect(await resultFor(f.jobId, "NET_EFFECT")).toBeNull();
    // And the flag is what makes the difference, nothing else.
    await sweep(f.jobId, [NET_EFFECT], true);
    expect(await resultFor(f.jobId, "NET_EFFECT")).not.toBeNull();
  }, 120_000);

  it("3. a terminal attempt still reconciles, with or without the stop context", async () => {
    for (const stopped of [false, true]) {
      const f = await measuredDecreaseWithNoAttempt();
      await ctx.db.insert(researchAttempts).values({
        researchJobId: f.jobId,
        patternStep: NET_EFFECT.step,
        component: NET_EFFECT.component,
        attemptNumber: 1,
        status: "SUCCEEDED",
      });
      await sweep(f.jobId, [NET_EFFECT], stopped);
      const result = await resultFor(f.jobId, "NET_EFFECT");
      expect(result, `stopped=${stopped}`).not.toBeNull();
      expect(result!.status).toBe("PARTIALLY_SUPPORTED");
    }
  }, 120_000);

  it("4. evidence for ANOTHER component does not make this one eligible", async () => {
    const f = await makeFixture();
    // A burn is filed at EXECUTION_EVIDENCE and IS cross-readable by
    // NET_EFFECT, so it is deliberately not the test here. This is a
    // documentary row at an unrelated component: no onchain fact kind, so
    // no applicability, and a different component, so no ownership.
    const [source] = await ctx.db
      .insert(sources)
      .values({ url: `https://docs.example.test/${uniq("u")}`, urlHash: uniq("uh"), sourceType: "OFFICIAL_DOCS", health: "OK" })
      .returning();
    await ctx.db.insert(evidence).values({
      sourceId: source.id,
      researchJobId: f.jobId,
      relationship: "SUPPORTS",
      fragment: "the mechanism is documented",
      summary: "documented",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: NOW,
      evidenceContractVersion: 2,
      patternStep: 3,
      component: "MECHANISM_SPEC",
      directness: "DIRECT",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
    });
    await sweep(f.jobId, [NET_EFFECT], true);
    expect(await resultFor(f.jobId, "NET_EFFECT")).toBeNull();
  }, 120_000);

  it("5. evidence from ANOTHER job does not make this component eligible", async () => {
    const other = await measuredDecreaseWithNoAttempt();
    const mine = await makeFixture();
    // `other` genuinely holds a burn and a delta; `mine` holds nothing.
    await sweep(mine.jobId, [NET_EFFECT], true);
    expect(await resultFor(mine.jobId, "NET_EFFECT")).toBeNull();
    // The other job is unaffected by the sweep it was not the subject of.
    expect(await resultFor(other.jobId, "NET_EFFECT")).toBeNull();
  }, 120_000);

  it("6. a documentary row filed at an unrelated component triggers nothing", async () => {
    const f = await makeFixture();
    const [source] = await ctx.db
      .insert(sources)
      .values({ url: `https://docs.example.test/${uniq("u")}`, urlHash: uniq("uh"), sourceType: "OFFICIAL_DOCS", health: "OK" })
      .returning();
    for (const component of ["MECHANISM_SPEC", "FLOW_PATH", "DESTINATION"]) {
      await ctx.db.insert(evidence).values({
        sourceId: source.id,
        researchJobId: f.jobId,
        relationship: "CONTEXT",
        fragment: `text about ${component}`,
        summary: "context",
        retrievedUrl: source.url,
        contentHash: uniq("ch"),
        fetchedAt: NOW,
        evidenceContractVersion: 2,
        patternStep: 3,
        component,
        directness: "INDIRECT",
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
      });
    }
    await sweep(f.jobId, [NET_EFFECT], true);
    // Model-extracted and documentary rows carry no onchain_fact_kind, so
    // they can never reach a component through applicability.
    expect(await resultFor(f.jobId, "NET_EFFECT")).toBeNull();
  }, 120_000);

  it("7. the reconciliation is ZERO-COST: no budget, no artifact, no trace", async () => {
    const f = await measuredDecreaseWithNoAttempt();
    const before = {
      job: (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, f.jobId)))[0]!,
      artifacts: (
        await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, f.jobId))
      ).length,
      traces: (
        await ctx.db
          .select()
          .from(researchTraceEvents)
          .where(eq(researchTraceEvents.researchJobId, f.jobId))
      ).length,
    };

    await sweep(f.jobId, [NET_EFFECT], true);
    expect(await resultFor(f.jobId, "NET_EFFECT")).not.toBeNull();

    const after = {
      job: (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, f.jobId)))[0]!,
      artifacts: (
        await ctx.db.select().from(onchainArtifacts).where(eq(onchainArtifacts.researchJobId, f.jobId))
      ).length,
      traces: (
        await ctx.db
          .select()
          .from(researchTraceEvents)
          .where(eq(researchTraceEvents.researchJobId, f.jobId))
      ).length,
    };

    // Not one unit of any axis, and no new external observation of any kind.
    expect(after.job.sourceOpensReserved).toBe(before.job.sourceOpensReserved);
    expect(after.job.searchQueriesReserved).toBe(before.job.searchQueriesReserved);
    expect(after.job.modelCostMicroReserved).toBe(before.job.modelCostMicroReserved);
    expect(after.artifacts).toBe(before.artifacts);
    expect(after.traces).toBe(before.traces);
  }, 120_000);
});

// ---------------------------------------------------------------------
describe("boundaries", () => {
  it("only the post-exhaustion caller opts in — the ordinary sweep is unchanged", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/run-job.ts", "utf-8");
    // The ordinary path passes no options at all, byte for byte as before.
    expect(src).toContain("await reconcileOutstandingComponents(db, jobId, view.workQueue, now);");
    // Exactly one caller opts in.
    expect(src.split("acquisitionStopped: true").length - 1).toBe(1);
  });

  it("the exception names no component, step or fact kind", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/component-reconciliation-store.ts", "utf-8");
    const fn = src.slice(src.indexOf("export async function reconcileOutstandingComponents"));
    for (const banned of ["NET_EFFECT", "BURN", "TOTAL_SUPPLY_DELTA", "EXECUTION_EVIDENCE", "step === 7"]) {
      expect(fn, `must not name ${banned}`).not.toContain(banned);
    }
  });
});
