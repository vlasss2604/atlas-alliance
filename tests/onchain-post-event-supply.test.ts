import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import {
  evidence,
  onchainArtifacts,
  projects,
  researchAttempts,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { readJobBudgetReserved } from "../src/server/engine/budget-reservation";
import { persistFactLocators } from "../src/server/engine/documentary-locator-store";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import { runOnchainReactivationPass } from "../src/server/engine/onchain-reactivation";
import {
  postEventSupplyOpportunityConsumed,
  runPostEventSupplyCompletion,
} from "../src/server/engine/onchain-post-event-supply";
import { onchainOpportunityConsumedComponents } from "../src/server/engine/onchain-source-open-reserve";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ONE POST-EVENT TOKEN_SUPPLY ACQUISITION, PER RESEARCH JOB, EVER.
//
// A burn is stamped with its transaction's slot; a supply reading with the
// node's head at read time. When a burn discovered late sits after every
// reading the job took, an event-anchored interval has no right-hand side —
// and one more read completes it, but ONLY if a prior Research already holds
// a reading before that burn. Otherwise the read would exist purely for a
// future Research, which the policy refuses.
//
// What must be proved is the bound: one opportunity, spent by failure as by
// success, surviving redelivery, paid for last out of the unchanged ledger,
// consuming no component's reactivation opportunity, and never converting a
// technical failure into a finding about the project.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-03T00:00:00.000Z");
// EACH TEST GETS ITS OWN MINT. The historical loader is scoped by the
// CANONICAL URI of the active anchor — chain, network and mint — which is
// the correct production scoping (one mint is one project), but it means two
// fixtures sharing a mint would share each other's prior-job readings. The
// isolation therefore has to be the mint itself, not the project row.
let mintCounter = 0;
function nextMint(): string {
  mintCounter += 1;
  // Base58 has no "0", so the counter is written in digits 1..9 rather than
  // decimal — a mint whose shape the identity contract would refuse is not a
  // fixture, it is a different test.
  let tag = "";
  let n = mintCounter;
  do {
    tag = "123456789"[n % 9] + tag;
    n = Math.floor(n / 9);
  } while (n > 0);
  return `Mint${tag}`.padEnd(44, "1");
}

interface Fixture {
  id: string;
  slug: string;
  mint: string;
}

const WALLET = "Wa11et11111111111111111111111111111111111111";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const SIGNATURE_B = "Sig2222222222222222222222222222222222222222222222222222222222222222";
const BURN_SLOT = 500;
const EXECUTION = { step: 4, component: "EXECUTION_EVIDENCE" };

async function makeProject(): Promise<Fixture> {
  const slug = uniq("pes");
  const mint = nextMint();
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Post-Event Fixture", status: "ACTIVE_CORE" })
    .returning();
  const ok = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: mint,
  });
  if (!ok.ok) throw new Error("fixture identity failed");
  return { id: project.id, slug, mint };
}

function identityFor(mint: string) {
  return { chain: "solana" as const, tokenAddress: mint, ticker: null };
}

async function makeJob(projectId: string, slug: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "does the buyback actually reduce circulating supply?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "buyback burn" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

function artifactFor(
  intent: OnchainIntent,
  result: OnchainResult,
  slot: number,
  hashSalt = "",
): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
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
      requestParams: { subject: intent.subject },
      retrievedAt: NOW,
      rawResponseHash: `sha256:raw:${result.kind}:${intent.subject}:${slot}${hashSalt}`,
      artifactHash: `sha256:art:${result.kind}:${intent.subject}:${slot}${hashSalt}`,
      transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
    },
  });
}

function supplyIntent(mint: string): OnchainIntent {
  return {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };
}

function supplyArtifact(mint: string, slot: number, amountRaw = "1000"): OnchainArtifact {
  const intent = supplyIntent(mint);
  return artifactFor(
    intent,
    { kind: "TOKEN_SUPPLY", mint, amountRaw, decimals: 6 },
    slot,
    `:${amountRaw}`,
  );
}

function burnTransaction(
  mint: string,
  slot: number,
  signature = SIGNATURE,
  burnMint = mint,
): OnchainArtifact {
  const intent: OnchainIntent = {
    kind: "TRANSACTION_DETAIL",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "tx",
    subject: signature,
  };
  return artifactFor(
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
          mint: burnMint,
          sourceAccount: TOKEN_ACCOUNT,
          authority: WALLET,
          amountRaw: "7723746661",
          decimals: 6,
        },
      ],
      programs: [],
      accountKeys: [WALLET, mint, TOKEN_ACCOUNT],
      tokenInstructions: [],
      lifecycleInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    slot,
  );
}

// A burn established by THIS Research, the way the engine establishes one:
// the artifact persisted and a deterministic BURN fact filed from it.
async function establishBurn(
  f: Fixture,
  jobId: string,
  slot = BURN_SLOT,
  signature = SIGNATURE,
): Promise<void> {
  await persistOnchainArtifactAndFacts({
    db: ctx.db,
    jobId,
    artifact: burnTransaction(f.mint, slot, signature),
    identity: identityFor(f.mint),
    target: EXECUTION,
  });
}

// A reading THIS Research took, through the same canonical path an anchor
// component's own TOKEN_SUPPLY read uses.
async function establishCurrentSupply(
  f: Fixture,
  jobId: string,
  slot: number,
  amountRaw = "1000",
): Promise<void> {
  await persistOnchainArtifactAndFacts({
    db: ctx.db,
    jobId,
    artifact: supplyArtifact(f.mint, slot, amountRaw),
    identity: identityFor(f.mint),
    target: { step: 7, component: "NET_EFFECT" },
  });
}

// A PRIOR Research's reading, written as that job's own row.
async function establishPriorSupply(
  f: Fixture,
  slot: number,
  amountRaw = "5000",
  mint = f.mint,
): Promise<string> {
  const priorJob = await makeJob(f.id, f.slug);
  await persistOnchainArtifactAndFacts({
    db: ctx.db,
    jobId: priorJob,
    artifact: supplyArtifact(mint, slot, amountRaw),
    identity: identityFor(mint),
    target: { step: 7, component: "NET_EFFECT" },
  });
  return priorJob;
}

async function insertStandaloneSupply(
  mint: string,
  slot: number,
  amountRaw: string,
): Promise<void> {
  const intent = supplyIntent(mint);
  await ctx.db.insert(onchainArtifacts).values({
    originKind: "STANDALONE_STRUCTURED_OBSERVATION",
    researchJobId: null,
    sourceId: null,
    canonicalUri: buildCanonicalOnchainUri(intent),
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
    intentKind: "TOKEN_SUPPLY",
    slot,
    blockTime: null,
    blockHash: null,
    finality: "finalized",
    transactionSignature: null,
    retrievalMethod: "RPC",
    providerId: "owner-script",
    providerMethod: "getTokenSupply",
    requestParams: { subject: mint },
    retrievedAt: NOW,
    rawResponseHash: `sha256:raw:standalone:${mint}:${slot}`,
    artifactHash: `sha256:art:standalone:${mint}:${slot}`,
    normalizedResult: { kind: "TOKEN_SUPPLY", mint, amountRaw, decimals: 6 },
  });
}

// The production Solana adapter's own shape: a supply read answers at the
// node's CONTEXT slot, which the fixture is told.
function supplyRetriever(mint: string, opts: { slot?: number; fail?: boolean; amountRaw?: string } = {}) {
  const asked: OnchainIntent[] = [];
  return {
    asked,
    retriever: {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent): Promise<OnchainArtifact> => {
        asked.push(intent);
        if (opts.fail) throw new Error("provider exploded");
        return supplyArtifact(mint, opts.slot ?? 900, opts.amountRaw ?? "990");
      },
    },
  };
}

async function reservedSourceOpens(jobId: string): Promise<number> {
  const row = await readJobBudgetReserved(ctx.db, jobId);
  return row!.sourceOpens;
}

async function run(
  f: Fixture,
  jobId: string,
  opts: {
    slot?: number;
    fail?: boolean;
    amountRaw?: string;
    maxSourceOpens?: number;
    retriever?: null;
  } = {},
) {
  const fixture = supplyRetriever(f.mint, opts);
  const result = await runPostEventSupplyCompletion(ctx.db, {
    jobId,
    projectId: f.id,
    maxSourceOpens: opts.maxSourceOpens ?? 24,
    retriever: opts.retriever === null ? null : fixture.retriever,
  });
  return { result, asked: fixture.asked };
}

// ---------------------------------------------------------------------
// 1..7. When exactly one read is issued, and when none is.
// ---------------------------------------------------------------------

describe("1..7. the gate decides, and the gate is the only thing that does", () => {
  it("2. burn + eligible prior t0 + no post-event reading → exactly one RPC", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId, { slot: 900 });
    expect(asked.length).toBe(1);
    expect(asked[0]!.kind).toBe("TOKEN_SUPPLY");
    expect(asked[0]!.subject).toBe(f.mint);
    expect(result.outcome).toBe("ACQUIRED");
    expect(result.gate?.decision).toBe("POST_EVENT_SUPPLY_REQUIRED");
  }, 120_000);

  it("1/5. a reading already after the burn → zero RPC", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 900, "990");

    const { result, asked } = await run(f, jobId);
    expect(asked).toEqual([]);
    expect(result.outcome).toBe("NO_ACTION");
    expect(result.gate?.reason).toBe("POST_EVENT_OBSERVATION_ALREADY_HELD");
    expect(await reservedSourceOpens(jobId)).toBe(0);
  }, 120_000);

  it("3. a first-ever Research with no prior t0 → zero RPC", async () => {
    const f = await makeProject();
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId);
    expect(asked).toEqual([]);
    expect(result.outcome).toBe("NO_ACTION");
    expect(result.gate?.reason).toBe("NO_HISTORICAL_T0");
    expect(await reservedSourceOpens(jobId)).toBe(0);
  }, 120_000);

  it("4. a standalone historical observation only → zero RPC", async () => {
    const f = await makeProject();
    await insertStandaloneSupply(f.mint, 100, "5000");
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId);
    expect(asked).toEqual([]);
    expect(result.gate?.reason).toBe("NO_HISTORICAL_T0");
    // It never even reached the pure layer as a candidate: the loader
    // excludes standalone rows at the query.
    expect(result.gate?.historicalCandidatesConsidered).toBe(0);
  }, 120_000);

  it("6. a current reading AT the burn's slot → exactly one RPC", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, BURN_SLOT, "1000");

    const { asked, result } = await run(f, jobId, { slot: 901 });
    expect(asked.length).toBe(1);
    expect(result.outcome).toBe("ACQUIRED");
  }, 120_000);

  it("7. a current reading before the burn → exactly one RPC", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 499, "1000");

    const { asked } = await run(f, jobId, { slot: 902 });
    expect(asked.length).toBe(1);
  }, 120_000);

  it("17. a prior reading of a DIFFERENT mint is not this project's t0 → zero RPC", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100, "5000", nextMint());
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId);
    expect(asked).toEqual([]);
    expect(result.gate?.reason).toBe("NO_HISTORICAL_T0");
  }, 120_000);

  it("no burn established at all → zero RPC, and no gate is even built", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId);
    expect(asked).toEqual([]);
    expect(result.outcome).toBe("NO_ACTION");
    expect(result.gate).toBeNull();
  }, 120_000);

  it("a process with no retriever spends nothing and consumes nothing", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result } = await run(f, jobId, { retriever: null });
    expect(result.outcome).toBe("ACQUISITION_UNAVAILABLE");
    expect(await reservedSourceOpens(jobId)).toBe(0);
    // Not consumed: a process that cannot reach a chain must not spend the
    // opportunity of one that can.
    expect(await postEventSupplyOpportunityConsumed(ctx.db, jobId)).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 8/19/20. Budget.
// ---------------------------------------------------------------------

describe("8/19/20. it is paid for last, out of the unchanged ledger", () => {
  it("8. no source open left → zero RPC, bounded outcome, Research continues", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId, { maxSourceOpens: 0 });
    expect(asked).toEqual([]);
    expect(result.outcome).toBe("BUDGET_EXHAUSTED");
    expect(result.sourceOpensSpent).toBe(0);
    expect(await reservedSourceOpens(jobId)).toBe(0);

    // The refusal is recorded, in the closed vocabulary, and it is not a
    // failure of the job.
    const traced = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(
        and(
          eq(researchTraceEvents.researchJobId, jobId),
          eq(researchTraceEvents.operationType, "CANDIDATE_SKIPPED_BUDGET"),
        ),
      );
    expect(traced.length).toBe(1);
    expect(traced[0]!.reasonCode).toBe("SOURCE_OPEN_BUDGET_EXHAUSTED");
    expect(traced[0]!.component).toBeNull();
  }, 120_000);

  it("19/20. the read spends exactly one unit of the existing global ceiling", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const before = await reservedSourceOpens(jobId);
    const { result } = await run(f, jobId, { slot: 900, maxSourceOpens: 24 });
    expect(result.sourceOpensSpent).toBe(1);
    expect(await reservedSourceOpens(jobId)).toBe(before + 1);
    expect(await reservedSourceOpens(jobId)).toBeLessThanOrEqual(24);
  }, 120_000);

  it("20. it introduces no protected reservation of its own", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-post-event-supply.ts", "utf-8");
    // It never consults, never recomputes and never widens the reserve.
    expect(src).not.toContain("onchain-source-open-reserve");
    expect(src).not.toContain("deterministicCeilingForComponent");
    // And it passes the RAW job ceiling: no allocation, only leftovers.
    expect(src).toContain('reserveJobBudget(db, input.jobId, "sourceOpens", 1, input.maxSourceOpens)');
    const reserve = await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8");
    expect(reserve).not.toContain("post-event");
  });
});

// ---------------------------------------------------------------------
// 9/10/11/12/13. One is one.
// ---------------------------------------------------------------------

describe("9..13. exactly one opportunity, spent by failure as by success", () => {
  it("9/18. a reading after the watermark is persisted canonically", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result } = await run(f, jobId, { slot: 900 });
    expect(result.outcome).toBe("ACQUIRED");
    expect(result.observedSlot).toBe(900);
    expect(result.artifactId).not.toBeNull();

    const [row] = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, result.artifactId!));
    expect(row.originKind).toBe("RESEARCH_JOB");
    expect(row.researchJobId).toBe(jobId);
    expect(row.intentKind).toBe("TOKEN_SUPPLY");
    expect(row.subject).toBe(f.mint);
    expect(row.slot).toBe(900);
    expect(row.finality).toBe("finalized");
    // Canonical persistence writes the shared source row too.
    expect(row.sourceId).not.toBeNull();

    // 23. and no Evidence was filed for it: no component asked for it.
    const ev = await ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.onchainArtifactId, result.artifactId!));
    expect(ev).toEqual([]);
  }, 120_000);

  it("10. a reading AT the watermark is kept, refuses completion, and is not retried", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId, { slot: BURN_SLOT, amountRaw: "991" });
    expect(asked.length).toBe(1);
    expect(result.outcome).toBe("NOT_STRICTLY_AFTER_EVENT");
    expect(result.artifactId).not.toBeNull();

    const again = await run(f, jobId, { slot: 900 });
    expect(again.asked).toEqual([]);
    expect(again.result.outcome).toBe("OPPORTUNITY_ALREADY_CONSUMED");
  }, 120_000);

  it("11. a reading BEFORE the watermark is kept, refuses completion, not retried", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId, { slot: 450, amountRaw: "992" });
    expect(asked.length).toBe(1);
    expect(result.outcome).toBe("NOT_STRICTLY_AFTER_EVENT");
    expect(result.observedSlot).toBe(450);
    expect(result.artifactId).not.toBeNull();
    expect((await run(f, jobId)).asked).toEqual([]);
  }, 120_000);

  it("12. an RPC failure consumes the opportunity and is never a finding", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const { result, asked } = await run(f, jobId, { fail: true });
    expect(asked.length).toBe(1);
    expect(result.outcome).toBe("RETRIEVAL_FAILED");
    expect(result.artifactId).toBeNull();
    // The unit was reserved BEFORE the call, so the failure still paid.
    expect(result.sourceOpensSpent).toBe(1);
    expect(await reservedSourceOpens(jobId)).toBe(1);

    // A technical limitation, recorded as one. Never "supply did not change".
    const traced = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(
        and(
          eq(researchTraceEvents.researchJobId, jobId),
          eq(researchTraceEvents.operationType, "FETCH_FAILED"),
        ),
      );
    expect(traced.length).toBe(1);
    expect(traced[0]!.reasonCode).toBe("PROVIDER_ERROR");

    const second = await run(f, jobId, { slot: 900 });
    expect(second.asked).toEqual([]);
    expect(second.result.outcome).toBe("OPPORTUNITY_ALREADY_CONSUMED");
    expect(await reservedSourceOpens(jobId)).toBe(1);
  }, 120_000);

  it("13. a resumed/redelivered job finds the opportunity already spent", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    expect(await postEventSupplyOpportunityConsumed(ctx.db, jobId)).toBe(false);
    await run(f, jobId, { slot: 900 });
    expect(await postEventSupplyOpportunityConsumed(ctx.db, jobId)).toBe(true);

    // TWO independent refusals now stand, and either alone is sufficient.
    // The marker is spent — and the gate itself no longer asks, because the
    // reading it just acquired IS the post-event observation. A redelivery
    // stops at the gate; the marker is what stops the cases where the gate
    // would still say yes (a failure, a too-early slot, a budget refusal),
    // and those are pinned by their own tests above.
    for (let i = 0; i < 3; i++) {
      const again = await run(f, jobId, { slot: 950 });
      expect(again.asked).toEqual([]);
      expect(again.result.outcome).toBe("NO_ACTION");
      expect(again.result.gate?.reason).toBe("POST_EVENT_OBSERVATION_ALREADY_HELD");
      expect(await postEventSupplyOpportunityConsumed(ctx.db, jobId)).toBe(true);
    }
    expect(await reservedSourceOpens(jobId)).toBe(1);
  }, 120_000);

  it("a budget refusal also spends it — this is not a retry gate", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    await run(f, jobId, { maxSourceOpens: 0 });
    expect(await postEventSupplyOpportunityConsumed(ctx.db, jobId)).toBe(true);
    const again = await run(f, jobId, { slot: 900, maxSourceOpens: 24 });
    expect(again.asked).toEqual([]);
    expect(again.result.outcome).toBe("OPPORTUNITY_ALREADY_CONSUMED");
  }, 120_000);
});

// ---------------------------------------------------------------------
// 14/15. It must not disturb reactivation.
// ---------------------------------------------------------------------

describe("14/15. the marker belongs to no component", () => {
  it("14. it consumes no component's bounded reactivation opportunity", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const before = await onchainOpportunityConsumedComponents(ctx.db, jobId);
    await run(f, jobId, { slot: 900 });
    const after = await onchainOpportunityConsumedComponents(ctx.db, jobId);
    expect([...after].sort()).toEqual([...before].sort());

    // And the row it wrote really is component-less and really is on-chain.
    const marker = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(
        and(
          eq(researchTraceEvents.researchJobId, jobId),
          eq(researchTraceEvents.operationType, "FETCH_ATTEMPTED"),
          isNull(researchTraceEvents.component),
        ),
      );
    expect(marker.length).toBe(1);
    expect(marker[0]!.targetRef).toBe(buildCanonicalOnchainUri(supplyIntent(f.mint)));
    expect(marker[0]!.patternStep).toBeNull();
    expect(marker[0]!.providerName).toBeNull();
  }, 120_000);

  it("15. running it after reactivation leaves reactivation's semantics intact", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    // A component that finished with no subject, and a locator admitted
    // later in the same job — the reactivation case, untouched.
    await ctx.db.insert(researchAttempts).values({
      researchJobId: jobId,
      patternStep: EXECUTION.step,
      component: EXECUTION.component,
      attemptNumber: 1,
      status: "FAILED",
    });
    const [source] = await ctx.db
      .insert(sources)
      .values({
        url: `https://docs.example.test/${uniq("p")}`,
        urlHash: uniq("uh"),
        sourceType: "OFFICIAL_DOCS",
        health: "OK",
      })
      .returning();
    const [row] = await ctx.db
      .insert(evidence)
      .values({
        sourceId: source.id,
        researchJobId: jobId,
        relationship: "SUPPORTS",
        fragment: `bought-back tokens are sent to ${WALLET} and burned there`,
        summary: "documented burn account",
        retrievedUrl: source.url,
        contentHash: uniq("ch"),
        fetchedAt: NOW,
        evidenceContractVersion: 2,
        patternStep: 6,
        component: "DESTINATION",
        directness: "DIRECT",
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
      })
      .returning();
    await persistFactLocators(ctx.db, row.id, [{ value: WALLET, shape: "ADDRESS_LIKE" }]);

    // The completion runs FIRST here, deliberately: even out of order it
    // must not take EXECUTION_EVIDENCE's opportunity away.
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");
    await run(f, jobId, { slot: 900 });

    const { view } = await loadJobContractView(ctx.db, jobId);
    const pass = await runOnchainReactivationPass(ctx.db, {
      jobId,
      projectId: f.id,
      workQueue: view.workQueue,
      maxSourceOpens: 24,
      retriever: {
        name: "fixture",
        supports: () => true,
        retrieve: async (intent: OnchainIntent) =>
          artifactFor(
            intent,
            {
              kind: "ACCOUNT_INFO",
              address: intent.subject,
              exists: true,
              ownerProgram: "SysProg11111111111111111111111111111111111",
              executable: false,
              lamports: "1",
              tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
              tokenAccount: null,
            },
            600,
          ),
      },
    });
    // EXECUTION_EVIDENCE was still reactivatable: its opportunity was never
    // consumed by the completion above.
    const reactivated = pass.reactivated.find((r) => r.component === EXECUTION.component);
    expect(reactivated).toBeDefined();
    expect(reactivated!.sourceOpensSpent).toBeGreaterThan(0);
    expect(pass.refused.find((r) => r.component === EXECUTION.component)).toBeUndefined();
  }, 120_000);

  it("the one-shot marker cannot be confused with any other on-chain trace row", async () => {
    const f = await makeProject();
    const jobId = await makeJob(f.id, f.slug);
    // Documentary fetch rows are component-less too — and carry an https
    // url the canonical parser refuses.
    await ctx.db.insert(researchTraceEvents).values({
      researchJobId: jobId,
      sequence: 1,
      operationType: "FETCH_ATTEMPTED",
      providerKind: "FETCH",
      targetRef: "https://docs.example.test/whitepaper",
      status: "OK",
    });
    // An on-chain row from a component's own read carries its component.
    await ctx.db.insert(researchTraceEvents).values({
      researchJobId: jobId,
      sequence: 2,
      operationType: "FETCH_ATTEMPTED",
      providerKind: "FETCH",
      patternStep: 7,
      component: "NET_EFFECT",
      targetRef: buildCanonicalOnchainUri(supplyIntent(f.mint)),
      status: "OK",
    });
    // And an account-level on-chain read is a different intent path.
    await ctx.db.insert(researchTraceEvents).values({
      researchJobId: jobId,
      sequence: 3,
      operationType: "FETCH_ATTEMPTED",
      providerKind: "FETCH",
      targetRef: buildCanonicalOnchainUri({
        kind: "ACCOUNT_INFO",
        chain: "solana",
        network: "mainnet",
        projectAnchor: f.mint,
        subjectKind: "account",
        subject: WALLET,
      }),
      status: "OK",
    });
    expect(await postEventSupplyOpportunityConsumed(ctx.db, jobId)).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 16. Watermark, and what it does not mean.
// ---------------------------------------------------------------------

describe("16. several burns bound coverage and select nothing", () => {
  it("the greatest slot bounds the read; every burn stays established", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId, 300, SIGNATURE);
    await establishBurn(f, jobId, 700, SIGNATURE_B);
    await establishCurrentSupply(f, jobId, 650, "1000");

    const { result, asked } = await run(f, jobId, { slot: 800 });
    // 650 is after the earlier burn and before the later one, so coverage is
    // incomplete and one read is issued, bounded by the GREATEST slot.
    expect(asked.length).toBe(1);
    expect(result.watermarkSlot).toBe(700);
    expect(result.outcome).toBe("ACQUIRED");
    expect(result.gate?.acquisitionWatermark?.usableEvents).toBe(2);

    // Both burns remain established Evidence — nothing was discarded, and no
    // canonical Proof event was selected here.
    const burns = await ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.researchJobId, jobId), eq(evidence.onchainFactKind, "BURN")));
    expect(burns.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

// ---------------------------------------------------------------------
// 21..25. What this wiring is not allowed to be.
// ---------------------------------------------------------------------

describe("21..25. boundaries", () => {
  const MODULE = "src/server/engine/onchain-post-event-supply.ts";

  async function codeOf(file: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(file, "utf-8"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  }

  it("21. no search, fetch, model or extraction work is repeated", async () => {
    const code = await codeOf(MODULE);
    for (const banned of [
      "QueryProposer",
      "SearchGateway",
      "ContentFetcher",
      "EvidenceExtractor",
      "anthropic",
      "runSearchPhase",
      "runFetchPhase",
      "acquisition-phases",
    ]) {
      expect(code, `must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("21. and there is no loop, poll or sleep of any kind", async () => {
    const code = await codeOf(MODULE);
    for (const banned of ["while (", "setTimeout", "setInterval", "sleep", "for (;;)"]) {
      expect(code, `must not reference ${banned}`).not.toContain(banned);
    }
    // Exactly one retrieve call site.
    expect((code.match(/retriever\.retrieve\(/g) ?? []).length).toBe(1);
  });

  it("22. it creates no research_attempts row", async () => {
    const f = await makeProject();
    await establishPriorSupply(f, 100);
    const jobId = await makeJob(f.id, f.slug);
    await establishBurn(f, jobId);
    await establishCurrentSupply(f, jobId, 400, "1000");

    const before = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    await run(f, jobId, { slot: 900 });
    const after = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    expect(after).toEqual(before);
    expect(await codeOf(MODULE)).not.toContain("researchAttempts");
  }, 120_000);

  it("23. no SUPPLY_DELTA Evidence and no fact synthesis", async () => {
    const code = await codeOf(MODULE);
    expect(code).not.toContain("SUPPLY_DELTA");
    expect(code).not.toContain("synthesizeOnchainFacts");
    expect(code).not.toContain("persistOnchainArtifactAndFacts");
    // The artifact-only canonical path, deliberately.
    expect(code).toContain("persistOnchainArtifact(");
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    // B2d2 changed exactly one thing about this guard: the kind now EXISTS.
    // What must still be true — and is the thing that mattered — is that it
    // grants nothing: no applicability entry, so nothing may read it across
    // components.
    expect(facts).not.toContain("TOTAL_SUPPLY_DELTA: [");
  });

  it("24/25. BURN -> NET_EFFECT is still the only applicability pair", async () => {
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    const code = await codeOf(MODULE);
    expect(code).not.toContain("NET_EFFECT");
    expect(code).not.toContain("component-reconcil");
    expect(code).not.toContain("claim-evaluator");
    expect(code).not.toContain("SUPPORTED");
  });

  it("it is placed after reactivation and before the S5 sweep", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/run-job.ts", "utf-8");
    const reactivation = src.indexOf("await runOnchainReactivationPass(");
    const completion = src.indexOf("await runPostEventSupplyCompletion(");
    const sweep = src.indexOf("await reconcileOutstandingComponents(db, jobId, view.workQueue, now);\n\n  // Phase 6, S6");
    expect(reactivation).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(reactivation);
    expect(sweep).toBeGreaterThan(completion);
    // And it is NOT folded into the reactivation pass.
    const pass = await readFile("src/server/engine/onchain-reactivation.ts", "utf-8");
    expect(pass).not.toContain("onchain-post-event-supply");
  });

  it("it names no project and cannot invent a second transport", async () => {
    const { readFile } = await import("node:fs/promises");
    const lower = (await readFile(MODULE, "utf-8")).toLowerCase();
    for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan", "https://", "axios"]) {
      expect(lower, `must not name "${banned}"`).not.toContain(banned);
    }
    const code = await codeOf(MODULE);
    expect(code).toContain("resolveOnchainRetriever");
    expect(code).not.toContain("onchain-transport");
    expect(code).not.toContain("createSolanaOnchainAdapter");
  });
});
