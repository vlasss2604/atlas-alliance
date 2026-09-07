import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  evidence,
  onchainArtifacts,
  projects,
  researchAttempts,
  researchComponentResults,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { persistFactLocators } from "../src/server/engine/documentary-locator-store";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { runOnchainReactivationPass } from "../src/server/engine/onchain-reactivation";
import { onchainOpportunityConsumedComponents } from "../src/server/engine/onchain-source-open-reserve";
import {
  MAX_PROMOTED_INTENTS_PER_ATTEMPT,
  MAX_PROMOTION_DEPTH,
} from "../src/server/engine/onchain-subject-promotion";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { readJobBudgetReserved } from "../src/server/engine/budget-reservation";
import { recordTraceEvent } from "../src/server/engine/trace-store";
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

// DYNAMIC ON-CHAIN REACTIVATION V1.
//
// Acquisition order is fixed; subject availability is not. A component's
// structured on-chain branch runs at the TOP of its attempt, and the
// documentary locator that would give it a subject is admitted at the
// BOTTOM — by extraction, possibly of a much later component. The
// controller walks its queue once and never revisits, so the address died
// unused inside the very job that found it.
//
// This is not a retry. Nothing attempted is attempted again. The licence is
// narrower and is the whole point: NEW EVIDENCE ADMITTED IN THIS SAME JOB
// created a subject that did not exist before. What must be proved is the
// bound — one opportunity per component, consumed by failure exactly as by
// success, surviving a redelivery, and paid for out of the same ledger.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-03T00:00:00.000Z");
const MINT = "Mint1111111111111111111111111111111111111111";
const WALLET = "Wa11et11111111111111111111111111111111111111";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";

const EXECUTION = { step: 4, component: "EXECUTION_EVIDENCE" };
const NET_EFFECT = { step: 7, component: "NET_EFFECT" };

async function makeJob(withIdentity = true): Promise<{ jobId: string; projectId: string }> {
  const slug = uniq("react");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Reactivation Fixture", status: "ACTIVE_CORE" })
    .returning();
  if (withIdentity) {
    const ok = await confirmProjectIdentity(ctx.db, {
      projectSlug: slug,
      chain: "solana",
      tokenAddress: MINT,
    });
    if (!ok.ok) throw new Error("fixture identity failed");
  }
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "does the buyback actually reduce circulating supply?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "buyback burn" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return { jobId: job.id, projectId: project.id };
}

// The controller's own terminal attempt row, written exactly as the
// controller writes it. The pass revisits nothing that has not finished.
async function terminalAttempt(
  jobId: string,
  item: { step: number; component: string },
  status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "STARTED" = "FAILED",
): Promise<void> {
  await ctx.db.insert(researchAttempts).values({
    researchJobId: jobId,
    patternStep: item.step,
    component: item.component,
    attemptNumber: 1,
    status,
  });
}

// A documentary fact admitted LATER in the same job, carrying a validated
// locator — the event that creates a subject where there was none.
async function admitLocatorFact(jobId: string, address: string): Promise<string> {
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
      fragment: `bought-back tokens are sent to ${address} and burned there`,
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
  await persistFactLocators(ctx.db, row.id, [{ value: address, shape: "ADDRESS_LIKE" }]);
  return row.id;
}

function artifactFor(intent: OnchainIntent, result: OnchainResult): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: intent.subjectKind,
      subject: intent.subject,
      slot: 500,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "fixture",
      requestParams: { subject: intent.subject },
      retrievedAt: NOW,
      rawResponseHash: `sha256:${result.kind}:${intent.subject}`,
      artifactHash: `sha256:art:${result.kind}:${intent.subject}`,
      transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
    },
  });
}

const BURN = {
  programId: "TokenProg1111111111111111111111111111111111",
  instructionType: "BurnChecked" as const,
  mint: MINT,
  sourceAccount: TOKEN_ACCOUNT,
  authority: WALLET,
  amountRaw: "7723746661",
  decimals: 6,
};

// Answers by intent KIND only — it has no idea which subject "should" come
// next, so a chain that reaches a transaction reached it by promotion.
function fixtureRetriever(opts: { fail?: boolean } = {}) {
  const asked: OnchainIntent[] = [];
  return {
    asked,
    retriever: {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent): Promise<OnchainArtifact> => {
        asked.push(intent);
        if (opts.fail) throw new Error("provider exploded");
        switch (intent.kind) {
          case "ACCOUNT_INFO":
            return artifactFor(intent, {
              kind: "ACCOUNT_INFO",
              address: intent.subject,
              exists: true,
              ownerProgram: "SysProg11111111111111111111111111111111111",
              executable: false,
              lamports: "64850000000",
              tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
              tokenAccount: null,
            });
          case "TOKEN_ACCOUNTS_BY_OWNER":
            return artifactFor(intent, {
              kind: "TOKEN_ACCOUNTS_BY_OWNER",
              owner: intent.subject,
              mint: MINT,
              rejectedCount: 0,
              accounts: [
                { account: TOKEN_ACCOUNT, owner: intent.subject, mint: MINT, amountRaw: "0", decimals: 6 },
              ],
            });
          case "SIGNATURES_FOR_ADDRESS":
            return artifactFor(intent, {
              kind: "SIGNATURES_FOR_ADDRESS",
              address: intent.subject,
              signatures: [
                { signature: SIGNATURE, slot: 20, err: false, blockTime: 1_700_000_000, memo: null },
              ],
            });
          case "TRANSACTION_DETAIL":
            return artifactFor(intent, {
              kind: "TRANSACTION_DETAIL",
              signature: intent.subject,
              slot: 500,
              blockTime: 1_700_000_000,
              succeeded: true,
              burns: [BURN],
              programs: [],
              accountKeys: [WALLET, MINT, TOKEN_ACCOUNT],
              tokenInstructions: [],
              lifecycleInstructions: [],
              preTokenBalances: [],
              postTokenBalances: [],
            });
          default:
            return artifactFor(intent, {
              kind: "TOKEN_SUPPLY",
              mint: MINT,
              amountRaw: "1000",
              decimals: 6,
            });
        }
      },
    },
  };
}

async function runPass(
  jobId: string,
  projectId: string,
  opts: { fail?: boolean; maxSourceOpens?: number; retriever?: null } = {},
) {
  const { view } = await loadJobContractView(ctx.db, jobId);
  const fixture = fixtureRetriever({ fail: opts.fail });
  const outcome = await runOnchainReactivationPass(ctx.db, {
    jobId,
    projectId,
    workQueue: view.workQueue,
    maxSourceOpens: opts.maxSourceOpens ?? 24,
    retriever: opts.retriever === null ? null : fixture.retriever,
  });
  return { outcome, asked: fixture.asked };
}

function refusalFor(outcome: Awaited<ReturnType<typeof runPass>>["outcome"], component: string) {
  return outcome.refused.find((r) => r.component === component)?.reason;
}

async function reservedSourceOpens(jobId: string): Promise<number> {
  const row = await readJobBudgetReserved(ctx.db, jobId);
  return row!.sourceOpens;
}

// ---------------------------------------------------------------------
// Eligibility.
// ---------------------------------------------------------------------

describe("1/2. newly-unblocked work, and only that", () => {
  it("1. no subject initially + a subject admitted later in the SAME job → reactivated", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    // The first pass had nothing to address: no locator existed.
    expect(await onchainOpportunityConsumedComponents(ctx.db, jobId)).toEqual(new Set());

    await admitLocatorFact(jobId, WALLET);
    const { outcome, asked } = await runPass(jobId, projectId);

    const execution = outcome.reactivated.find((r) => r.component === "EXECUTION_EVIDENCE");
    expect(execution).toBeTruthy();
    expect(asked.some((i) => i.subject === WALLET && i.kind === "ACCOUNT_INFO")).toBe(true);
  }, 120_000);

  it("2. no subject ever → no chain call at all, and a visible acquisition boundary", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    const { outcome, asked } = await runPass(jobId, projectId);
    expect(asked).toEqual([]);
    expect(outcome.reactivated).toEqual([]);
    expect(refusalFor(outcome, "EXECUTION_EVIDENCE")).toBe("NO_ACTIONABLE_SUBJECT");
    expect(await reservedSourceOpens(jobId)).toBe(0);
  }, 120_000);

  it("a component with no terminal attempt is never revisited", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION, "STARTED");
    await admitLocatorFact(jobId, WALLET);
    const { outcome, asked } = await runPass(jobId, projectId);
    expect(asked).toEqual([]);
    expect(refusalFor(outcome, "EXECUTION_EVIDENCE")).toBe("NO_TERMINAL_ATTEMPT");
  }, 120_000);

  it("15. a job with no confirmed identity is never reactivated", async () => {
    const { jobId, projectId } = await makeJob(false);
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    const { outcome, asked } = await runPass(jobId, projectId);
    expect(asked).toEqual([]);
    expect(refusalFor(outcome, "EXECUTION_EVIDENCE")).toBe("NO_ACTIONABLE_SUBJECT");
  }, 120_000);
});

// ---------------------------------------------------------------------
// The one-shot bound.
// ---------------------------------------------------------------------

// An on-chain operation already issued for this component, recorded the way
// acquisition records it — immediately BEFORE the call.
async function markIssued(
  jobId: string,
  item: { step: number; component: string },
  operationType: "FETCH_ATTEMPTED" | "CANDIDATE_SKIPPED_BUDGET",
  reasonCode: "NONE" | "SOURCE_OPEN_BUDGET_EXHAUSTED" = "NONE",
  subject: string = WALLET,
): Promise<void> {
  await recordTraceEvent(ctx.db, {
    researchJobId: jobId,
    operationType,
    providerKind: "FETCH",
    patternStep: item.step,
    component: item.component,
    targetRef: buildCanonicalOnchainUri({
      kind: "ACCOUNT_INFO",
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: "account",
      subject,
    }),
    status: operationType === "FETCH_ATTEMPTED" ? "OK" : "SKIPPED",
    reasonCode,
    budgetAxis: "sourceOpens",
    budgetAmount: 1,
  });
}

describe("3/4/5/6/7. one opportunity, consumed by outcome not by success", () => {
  it("3. a prior RPC means the opportunity is already spent", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    await markIssued(jobId, EXECUTION, "FETCH_ATTEMPTED");
    const { outcome, asked } = await runPass(jobId, projectId);
    expect(asked).toEqual([]);
    expect(refusalFor(outcome, "EXECUTION_EVIDENCE")).toBe("OPPORTUNITY_ALREADY_CONSUMED");
  }, 120_000);

  it("4. a prior BUDGET REFUSAL counts as already attempted — no free retry", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    await markIssued(jobId, EXECUTION, "CANDIDATE_SKIPPED_BUDGET", "SOURCE_OPEN_BUDGET_EXHAUSTED");
    const { outcome, asked } = await runPass(jobId, projectId);
    expect(asked).toEqual([]);
    expect(refusalFor(outcome, "EXECUTION_EVIDENCE")).toBe("OPPORTUNITY_ALREADY_CONSUMED");
  }, 120_000);

  it("5. an RPC that FAILS consumes the opportunity — no free retry", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);

    const first = await runPass(jobId, projectId, { fail: true });
    expect(first.asked).toHaveLength(1);
    const reactivated = first.outcome.reactivated.find((r) => r.component === "EXECUTION_EVIDENCE");
    expect(reactivated?.observations).toContain("ONCHAIN_RETRIEVAL_FAILED");
    expect(reactivated?.evidenceIds).toEqual([]);
    // A technical failure, never a finding — and the unit stays spent.
    expect(await reservedSourceOpens(jobId)).toBe(1);

    const second = await runPass(jobId, projectId);
    expect(second.asked).toEqual([]);
    expect(refusalFor(second.outcome, "EXECUTION_EVIDENCE")).toBe("OPPORTUNITY_ALREADY_CONSUMED");
  }, 120_000);

  it("6/7. one reactivation maximum, and a redelivered phase does not repeat it", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);

    const first = await runPass(jobId, projectId);
    const spentAfterFirst = await reservedSourceOpens(jobId);
    expect(first.asked.length).toBeGreaterThan(0);

    // Same job, same locators, the pass simply runs again — exactly what a
    // redelivered EXTRACTING message causes.
    const second = await runPass(jobId, projectId);
    const third = await runPass(jobId, projectId);
    expect(second.asked).toEqual([]);
    expect(third.asked).toEqual([]);
    expect(refusalFor(second.outcome, "EXECUTION_EVIDENCE")).toBe("OPPORTUNITY_ALREADY_CONSUMED");
    expect(await reservedSourceOpens(jobId)).toBe(spentAfterFirst);
  }, 120_000);

  it("a capability-less environment does NOT consume the opportunity", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    const none = await runPass(jobId, projectId, { retriever: null });
    const r = none.outcome.reactivated.find((x) => x.component === "EXECUTION_EVIDENCE");
    expect(r?.observations).toEqual(["ONCHAIN_RETRIEVER_NOT_CONFIGURED"]);
    expect(await reservedSourceOpens(jobId)).toBe(0);
    // A configuration boundary is not a research outcome: nothing was
    // spent, so nothing was consumed.
    expect(await onchainOpportunityConsumedComponents(ctx.db, jobId)).toEqual(new Set());
  }, 120_000);
});

// ---------------------------------------------------------------------
// What the pass may not do.
// ---------------------------------------------------------------------

describe("8/9/10/11/12. bounds the pass cannot exceed", () => {
  it("8. no search, no model and no fetch — structurally, not by discipline", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("src/server/engine/onchain-reactivation.ts", "utf-8");
    // Code only: the module comment names what it deliberately does NOT
    // import, and that sentence is the opposite of a violation.
    const src = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const banned of [
      "query-proposer",
      "QueryProposer",
      "search-gateway",
      "SearchGateway",
      "content-fetcher",
      "ContentFetcher",
      "evidence-extractor",
      "EvidenceExtractor",
      "rendered-docs",
      "acquisition-phases",
      "loadProductConfig",
    ]) {
      expect(src, `reactivation must not reach ${banned}`).not.toContain(banned);
    }
  });

  it("9. no research_attempts row is created", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    const before = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    await runPass(jobId, projectId);
    const after = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    expect(after).toEqual(before);
  }, 120_000);

  it("10. every call spends the canonical ledger and is refused at the ceiling", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    const { outcome } = await runPass(jobId, projectId, { maxSourceOpens: 2 });
    const r = outcome.reactivated.find((x) => x.component === "EXECUTION_EVIDENCE");
    // V2: a reactivated chain no longer passes the RAW job ceiling. On a
    // two-open job the contract's guaranteed anchor-level read keeps one
    // unit, so this chain may reach exactly one — which is the same
    // protection, applied in the other direction. The ledger is still the
    // one canonical counter and the refusal is still at a ceiling.
    expect(r?.sourceOpensSpent).toBe(1);
    expect(await reservedSourceOpens(jobId)).toBe(1);
    expect(r?.observations).toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
    // A bounded research limitation, and no evidence invented for it.
    const traced = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(
        and(
          eq(researchTraceEvents.researchJobId, jobId),
          eq(researchTraceEvents.reasonCode, "SOURCE_OPEN_BUDGET_EXHAUSTED"),
        ),
      );
    expect(traced.length).toBeGreaterThan(0);
    // Either closed operation type is correct — which one depends only on
    // whether the refusal landed on a base or a promoted step.
    for (const t of traced) {
      expect([
        "CANDIDATE_SKIPPED_BUDGET",
        "SUBJECT_PROMOTION_BUDGET_EXHAUSTED",
      ]).toContain(t.operationType);
    }
  }, 120_000);

  it("11. existing promotion limits are unchanged and still bind", async () => {
    expect(MAX_PROMOTION_DEPTH).toBe(3);
    expect(MAX_PROMOTED_INTENTS_PER_ATTEMPT).toBe(3);
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    const { asked } = await runPass(jobId, projectId);
    // One base intent plus at most MAX_PROMOTED_INTENTS_PER_ATTEMPT.
    expect(asked.length).toBeLessThanOrEqual(1 + MAX_PROMOTED_INTENTS_PER_ATTEMPT);
  }, 120_000);

  it("12. evidence persistence stays idempotent — one artifact, one row", async () => {
    const { jobId, projectId } = await makeJob();
    await terminalAttempt(jobId, EXECUTION);
    await admitLocatorFact(jobId, WALLET);
    await runPass(jobId, projectId);
    const artifacts = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.researchJobId, jobId));
    const hashes = new Set(artifacts.map((a) => a.artifactHash));
    expect(hashes.size).toBe(artifacts.length);
  }, 120_000);
});

// ---------------------------------------------------------------------
// PART D — the whole repaired chain, offline.
// ---------------------------------------------------------------------

describe("13/14 + PART D. the full chain, end to end, with no network", () => {
  it("a late locator unblocks the burn, and the burn reaches NET_EFFECT", async () => {
    const { jobId, projectId } = await makeJob();

    // The controller ran: EXECUTION_EVIDENCE finished with no account
    // locator and therefore no chain read at all.
    await terminalAttempt(jobId, EXECUTION);
    await terminalAttempt(jobId, NET_EFFECT, "SUCCEEDED");
    // NET_EFFECT's own anchor read needed no locator and already happened
    // during the controller, so its one opportunity is spent — recorded
    // exactly as acquisition records it.
    await markIssued(jobId, NET_EFFECT, "FETCH_ATTEMPTED", "NONE", MINT);
    const before = await reconcileAndPersistComponent(ctx.db, jobId, NET_EFFECT, NOW);
    expect(before.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(before.reasonCodes).toContain("NO_EVIDENCE_FOUND");

    // Later documentary Evidence in the SAME job admits a validated address.
    await admitLocatorFact(jobId, WALLET);

    // One bounded reactivation walks the whole authorised chain.
    const { outcome, asked } = await runPass(jobId, projectId);
    expect(asked.map((i) => i.kind)).toEqual([
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
    ]);
    expect(asked[0].subject).toBe(WALLET);
    expect(asked[3].subject).toBe(SIGNATURE);

    // A deterministic BURN, persisted ONCE, at EXECUTION_EVIDENCE.
    const burnRows = await ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.researchJobId, jobId), eq(evidence.onchainFactKind, "BURN")));
    expect(burnRows).toHaveLength(1);
    expect(burnRows[0].patternStep).toBe(4);
    expect(burnRows[0].component).toBe("EXECUTION_EVIDENCE");
    expect(burnRows[0].sourceClass).toBe("ONCHAIN_VERIFIABLE");
    expect(burnRows[0].entityBinding).toBe("CONFIRMED");
    expect(
      outcome.reactivated.find((r) => r.component === "EXECUTION_EVIDENCE")?.evidenceIds,
    ).toContain(burnRows[0].id);

    // 13. Reconciliation sees the new Evidence — for the component that
    // acquired it AND, through typed applicability, for NET_EFFECT.
    const execution = await reconcileAndPersistComponent(ctx.db, jobId, EXECUTION, NOW);
    expect(execution.supportingEvidenceIds).toContain(burnRows[0].id);

    const after = await reconcileAndPersistComponent(ctx.db, jobId, NET_EFFECT, NOW);
    expect(after.supportingEvidenceIds).toContain(burnRows[0].id);
    expect(after.reasonCodes).not.toContain("SUPPLY_REDUCTION_NOT_ESTABLISHED");
    // A burn is a GROSS reduction. The NET question is still open, and must
    // stay open — this is the boundary B1 exists to hold.
    expect(after.reasonCodes).toContain("NET_SUPPLY_CHANGE_NOT_ESTABLISHED");
    expect(after.status).toBe("PARTIALLY_SUPPORTED");
    expect(after.status).not.toBe("SUPPORTED");

    // 14. And the persisted projection carries the same thing, so S6/S7
    // re-derive from it with no special case.
    const [row] = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(
        and(
          eq(researchComponentResults.researchJobId, jobId),
          eq(researchComponentResults.component, "NET_EFFECT"),
        ),
      );
    expect(row.status).toBe("PARTIALLY_SUPPORTED");
    expect([...(row.supportingEvidenceIds as string[])]).toContain(burnRows[0].id);
  }, 120_000);

  it("15. nothing in the reactivation path names a project, asset or mechanism", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = (await readFile("src/server/engine/onchain-reactivation.ts", "utf-8")).toLowerCase();
    for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan", "buyback", "burn"]) {
      expect(src, `reactivation must not name "${banned}"`).not.toContain(banned);
    }
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(/["'][1-9a-hj-np-za-km-z]{32,44}["']/.test(codeOnly)).toBe(false);
  });
});
