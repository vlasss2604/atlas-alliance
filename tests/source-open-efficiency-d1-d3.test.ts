import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquiredDocuments,
  evidence,
  projects,
  researchComponentResults,
  researchJobs,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { ACQUIRED_DOCUMENT_REPLAY_PROVIDER, sealedDocumentsForJob } from "../src/server/engine/acquired-documents";
import { isAlreadyFetchedUrl, isKnownDeadUrl, loadAcquisitionLedger } from "../src/server/engine/acquisition-ledger";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import { reconcileOutstandingComponents } from "../src/server/engine/component-reconciliation-store";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { persistFactLocators } from "../src/server/engine/documentary-locator-store";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import {
  resolveOnchainSourceOpenReserve,
  unprotectedCeiling,
} from "../src/server/engine/onchain-source-open-reserve";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// SOURCE-OPEN EFFICIENCY — D1 + D2 + D3, proved offline.
//
// The first fresh current-semantics live run (job bd7cf5ef-…) ended
// BUDGET_LIMIT_REACHED on source opens with 19 of 24 units reserved: three
// of them bought pages the job already held, five were protected for an
// on-chain chain that had no subject and no way left to get one, and the
// last page opened — an official documentation page — was never read
// because the refusal that followed it aborted the attempt first.
//
// Nothing here refunds a unit, raises a ceiling, or changes what counts as
// evidence. Three avoidable pieces of work are removed:
//
//   D1  a url this job already fetched successfully is served from the
//       job's own sealed copy, never opened again — including a page that
//       turned out to be another project's;
//   D2  the on-chain reserve for a component is released only once
//       documentary acquisition is over AND that component has no
//       admissible subject, i.e. when the subject can no longer arrive;
//   D3  a refused source-open reservation ends the open loop, the documents
//       already fetched are extracted, and THEN the same terminal error is
//       thrown.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const WALLET = "Wa11et11111111111111111111111111111111111111";
const DOMAIN = "docs.efficiency.test";
const PREFIX = "/mechanism";
const NOW = new Date("2026-09-11T00:00:00.000Z");

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

function docFor(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}`,
    fetchedAt: NOW,
    byteLength: text.length,
  };
}

function factFor(item: { step: number; component: string }, fragment: string): ExtractedFact {
  return {
    step: item.step,
    component: item.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: fragment,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
  };
}

// A live transport that counts every real call and can be told which urls
// fail. It declares no metering, so it is charged — exactly like production.
function countingFetcher(byUrl: Record<string, FetchedDocument | "FAIL">) {
  const calls: string[] = [];
  const fetcher: ContentFetcher = {
    name: "live-transport",
    async fetch(url: string) {
      calls.push(url);
      const entry = byUrl[url];
      if (!entry || entry === "FAIL") throw new ContentFetchError("HTTP_ERROR", "fixture: 404", url, 404);
      return entry;
    },
  };
  return { fetcher, calls };
}

async function makeProject(opts: { identity: boolean }) {
  const slug = uniq("eff");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Efficiency Fixture", status: "ACTIVE_CORE" })
    .returning();
  if (opts.identity) {
    const ok = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
    if (!ok.ok) throw new Error("fixture identity failed");
  }
  const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: DOMAIN, pathPrefix: PREFIX });
  if (!confirmed.ok) throw new Error("fixture route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!classified.ok) throw new Error("fixture route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug, ticker: null as string | null };
}

async function makeJob(projectId: string, entitlement: EntitlementSnapshot = coreEntitlement()): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function reservedOpens(jobId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: researchJobs.sourceOpensReserved })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row.n;
}

async function trace(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

// The persisted fetch sequence of the fresh live run, in trace order:
// every FETCH_ATTEMPTED and how it ended. Copied from
// research_trace_events for job bd7cf5ef-33fa-4768-872e-104171aaf1d9
// (sequences 23–153), truncated only in the on-chain URIs' identical
// token segment. This is the input D1 is replayed against.
const LIVE_RUN_OPENS: ReadonlyArray<{ seq: number; component: string; url: string; outcome: "OK" | "FAILED" }> = [
  { seq: 23, component: "SOURCE_OF_VALUE", url: `https://solscan.io/token/${MINT}`, outcome: "FAILED" },
  { seq: 25, component: "SOURCE_OF_VALUE", url: `https://solscan.io/account/${MINT}`, outcome: "FAILED" },
  { seq: 27, component: "SOURCE_OF_VALUE", url: `https://dev-v2.solscan.io/token/${MINT}`, outcome: "FAILED" },
  { seq: 29, component: "SOURCE_OF_VALUE", url: "https://solscan.io/txs", outcome: "FAILED" },
  { seq: 31, component: "SOURCE_OF_VALUE", url: "https://solscan.io/tx/3EeEqdrYZKNPxoL3qcxK3LDbavPrn7skpAvjyuAxmLihpjc6qerQ1ZrqDv4kGPCkgEueC48nMqoeeZusAQ8Vsn3C", outcome: "FAILED" },
  { seq: 33, component: "SOURCE_OF_VALUE", url: `https://solana.fm/address/${MINT}`, outcome: "OK" },
  { seq: 48, component: "MECHANISM_SPEC", url: "https://docs.raydium.io/raydium/protocol", outcome: "FAILED" },
  { seq: 58, component: "GOVERNANCE_BASIS", url: "https://app.tokenomics.com/tokenomics/raydium", outcome: "OK" },
  { seq: 67, component: "CURRENT_STATE", url: `atlas-onchain://solana/mainnet/project/${MINT}/token/${MINT}/supply`, outcome: "OK" },
  { seq: 80, component: "DESTINATION", url: `https://solana.fm/address/${MINT}`, outcome: "OK" },
  { seq: 82, component: "DESTINATION", url: `https://solana.fm/address/${MINT}/distribution?cluster=mainnet-alpha`, outcome: "OK" },
  { seq: 84, component: "DESTINATION", url: "https://docs.solana.fm/reference/get_transfers", outcome: "OK" },
  { seq: 86, component: "DESTINATION", url: "https://solana.fm/", outcome: "OK" },
  { seq: 88, component: "DESTINATION", url: "https://solana.fm/address/BCgzNcUPtnJoveBukmbRTvGyYymA4ucddQ5eTB5z4uxw", outcome: "OK" },
  { seq: 90, component: "DESTINATION", url: "https://app.tokenomics.com/tokenomics/raydium", outcome: "OK" },
  { seq: 119, component: "RECIPIENT", url: `https://solana.fm/address/${MINT}`, outcome: "OK" },
  { seq: 124, component: "NET_EFFECT", url: `atlas-onchain://solana/mainnet/project/${MINT}/token/${MINT}/supply`, outcome: "OK" },
  { seq: 149, component: "DURABILITY_BASIS", url: "https://docs.raydium.io/", outcome: "OK" },
  { seq: 151, component: "DURABILITY_BASIS", url: "https://docs.raydium.io/raydium/build/tips-and-gotchas/launchlab-and-cpmm-fee-reference", outcome: "FAILED" },
];

/* ------------------------------------------------------------------ */
/* D1 — a url is opened once per job                                   */
/* ------------------------------------------------------------------ */

describe("D1 — a url already fetched in this job is served from its sealed copy, never opened again", () => {
  it("the ledger knows a fetched url from a dead one, and a wrong-project page counts as fetched", async () => {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    const ok = `https://${DOMAIN}${PREFIX}/fetched`;
    const dead = `https://${DOMAIN}${PREFIX}/dead`;
    const rejected = `https://${DOMAIN}${PREFIX}/other-project`;
    const rows: Array<[string, "FETCH_ATTEMPTED" | "FETCH_OK" | "FETCH_FAILED" | "REJECTED_WRONG_PROJECT", "OK" | "FAILED" | "SKIPPED"]> = [
      [ok, "FETCH_ATTEMPTED", "OK"],
      [ok, "FETCH_OK", "OK"],
      [dead, "FETCH_ATTEMPTED", "OK"],
      [dead, "FETCH_FAILED", "FAILED"],
      [rejected, "FETCH_ATTEMPTED", "OK"],
      [rejected, "FETCH_OK", "OK"],
      [rejected, "REJECTED_WRONG_PROJECT", "SKIPPED"],
    ];
    for (const [url, operationType, status] of rows) {
      await recordTraceEvent(ctx.db, { researchJobId: jobId, operationType, providerKind: "FETCH", targetRef: url, status });
    }
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(isAlreadyFetchedUrl(ok, ledger)).toBe(true);
    expect(isKnownDeadUrl(ok, ledger)).toBe(false);
    expect(isAlreadyFetchedUrl(dead, ledger)).toBe(false);
    expect(isKnownDeadUrl(dead, ledger)).toBe(true);
    // Fetched, then rejected as another project's: still fetched.
    expect(isAlreadyFetchedUrl(rejected, ledger)).toBe(true);
    expect(isAlreadyFetchedUrl(`https://${DOMAIN}${PREFIX}/never`, ledger)).toBe(false);
  });

  it("REPLAY OF bd7cf5ef: over the persisted fetch sequence, exactly three opens were re-buys of a page the job already held", async () => {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    // Walk the live sequence in order. Before each open, ask the ledger —
    // built from the rows recorded so far, as the executor does — whether
    // the url was already fetched; then record the open as it happened.
    // Only documentary candidates pass through the executor's open loop;
    // the two deterministic chain reads are their own path with their own
    // one-shot ledger and are recorded here only so the counters match.
    const avoided: Array<{ seq: number; url: string }> = [];
    for (const open of LIVE_RUN_OPENS) {
      const ledger = await loadAcquisitionLedger(ctx.db, jobId);
      const documentary = open.url.startsWith("https://");
      if (documentary && isAlreadyFetchedUrl(open.url, ledger)) avoided.push({ seq: open.seq, url: open.url });
      await recordTraceEvent(ctx.db, { researchJobId: jobId, operationType: "FETCH_ATTEMPTED", providerKind: "FETCH", component: open.component, targetRef: open.url, status: "OK" });
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: open.outcome === "OK" ? "FETCH_OK" : "FETCH_FAILED",
        providerKind: "FETCH",
        component: open.component,
        targetRef: open.url,
        status: open.outcome,
        reasonCode: open.outcome === "OK" ? "NONE" : "PROVIDER_ERROR",
      });
    }
    expect(avoided).toEqual([
      { seq: 80, url: `https://solana.fm/address/${MINT}` },
      { seq: 90, url: "https://app.tokenomics.com/tokenomics/raydium" },
      { seq: 119, url: `https://solana.fm/address/${MINT}` },
    ]);
    // 19 reserved on the live run; 16 under D1. The five failed solscan
    // opens, the two failed docs opens and every first open stay paid —
    // nothing is refunded, only the re-buys are gone.
    expect(LIVE_RUN_OPENS.length).toBe(19);
    expect(LIVE_RUN_OPENS.length - avoided.length).toBe(16);
  });

  it("through the real executor: one page found by every component is opened ONCE, sealed, replayed to the rest, and still inspected by each", async () => {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    const url = `https://${DOMAIN}${PREFIX}/fees`;
    const text = `${project.name}: the protocol fee accrues directly to the treasury contract`;
    const { fetcher, calls } = countingFetcher({ [url]: docFor(url, text) });
    const extracted: string[] = [];
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-fees"]; } },
      searchGateway: { name: "fixture-search", async search() { return [{ url, title: null, snippet: null }]; } },
      contentFetcher: fetcher,
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract(input) {
          extracted.push(input.target.component);
          return [factFor(input.target, "the protocol fee accrues directly to the treasury contract")];
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);

    const { view } = await loadJobContractView(ctx.db, jobId);
    expect(view.workQueue.length).toBeGreaterThan(1);
    // ONE external open for the whole job, and one unit reserved for it.
    expect(calls).toEqual([url]);
    expect(await reservedOpens(jobId)).toBe(1);
    // Sealed once, under the product admission, for THIS job.
    const sealed = await ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId));
    expect(sealed).toHaveLength(1);
    expect(sealed[0].admission).toBe("PRODUCT_ACQUISITION");
    expect(sealed[0].acquisitionStrategy).toBe("DIRECT_HTTP");
    expect((await sealedDocumentsForJob(ctx.db, jobId)).documentCount).toBe(1);
    // Every later component still INSPECTED the document — reuse is not
    // "ignore the source" — and the trace says each replay was a replay.
    expect(extracted.length).toBe(view.workQueue.length);
    const rows = await trace(jobId);
    const replays = rows.filter((r) => r.operationType === "FETCH_OK" && r.providerName === ACQUIRED_DOCUMENT_REPLAY_PROVIDER);
    expect(replays.length).toBe(view.workQueue.length - 1);
    expect(rows.filter((r) => r.operationType === "FETCH_OK" && r.providerName === "live-transport")).toHaveLength(1);
    expect(rows.filter((r) => r.operationType === "CANDIDATE_SKIPPED_BUDGET")).toHaveLength(0);
    // A replay takes no reservation: no FETCH row of the replay provider
    // carries a budget axis.
    for (const r of rows.filter((r) => r.providerName === ACQUIRED_DOCUMENT_REPLAY_PROVIDER)) expect(r.budgetAxis).toBeNull();
    // Evidence came from every component's own reading of the one page.
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(new Set(ev.map((e) => e.component)).size).toBe(view.workQueue.length);
  });

  it("a page fetched fine but rejected as another project's is not bought again — and is still not evidence", async () => {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    const url = "https://explorer.example.test/address/abc";
    // Names no project: REJECTED_WRONG_PROJECT for every component.
    const { fetcher, calls } = countingFetcher({ [url]: docFor(url, "an unrelated explorer page about some other token") });
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-explorer"]; } },
      searchGateway: { name: "fixture-search", async search() { return [{ url, title: null, snippet: null }]; } },
      contentFetcher: fetcher,
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract(input) {
          return [factFor(input.target, "some other token")];
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    const rows = await trace(jobId);
    const rejected = rows.filter((r) => r.operationType === "REJECTED_WRONG_PROJECT");
    expect(rejected.length).toBeGreaterThan(1);
    // Rejected every time it was inspected, opened exactly once.
    expect(calls).toEqual([url]);
    expect(await reservedOpens(jobId)).toBe(1);
    expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId))).toHaveLength(0);
  });

  it("no refund and no free retry: a failed open keeps its unit, a dead url is not retried, and a new url is still paid for", async () => {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    const dead = `https://${DOMAIN}${PREFIX}/missing`;
    const live = `https://${DOMAIN}${PREFIX}/present`;
    const { fetcher, calls } = countingFetcher({ [dead]: "FAIL", [live]: docFor(live, `${project.name}: fees accrue to the treasury`) });
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-both"]; } },
      searchGateway: {
        name: "fixture-search",
        async search() { return [{ url: dead, title: null, snippet: null }, { url: live, title: null, snippet: null }]; },
      },
      contentFetcher: fetcher,
      evidenceExtractor: { name: "fixture-extractor", async extract(input) { return [factFor(input.target, "fees accrue to the treasury")]; } },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobId, executor, NOW);
    // The dead url was tried exactly once for the whole job (existing
    // dead-url memory), the live one exactly once (D1) — and BOTH opens
    // stayed on the counter: 2 reserved for 2 real transport calls.
    expect(calls.filter((u) => u === dead)).toHaveLength(1);
    expect(calls.filter((u) => u === live)).toHaveLength(1);
    expect(await reservedOpens(jobId)).toBe(calls.length);
  });

  it("the phased FETCH phase keeps its own once-per-job rule, and the replay fetcher shares one document set with the executor", () => {
    const phases = readFileSync("src/server/engine/acquisition-phases.ts", "utf-8");
    expect(phases).toContain("if (ledger.fetchedUrls.has(canonical)) continue;");
    expect(phases).toContain("sealedDocumentsForJob(db, jobId)");
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(executor).toContain("isAlreadyFetchedUrl(url, ledger)");
    expect(executor).toContain('admission: "PRODUCT_ACQUISITION"');
    // Reuse is gated on a METERED transport: the phased EXTRACTING replay
    // (metering REPLAY) is untouched by it.
    expect(executor).toContain("if (fetchMetered && isAlreadyFetchedUrl(url, ledger))");
  });
});

/* ------------------------------------------------------------------ */
/* D3 — what was paid for is read before the axis is honoured          */
/* ------------------------------------------------------------------ */

describe("D3 — documents fetched before the source-open axis was refused are extracted, then the same terminal error is thrown", () => {
  async function runToExhaustion(maxSourceOpens: number) {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    const u = [1, 2, 3].map((i) => `https://${DOMAIN}${PREFIX}/doc-${i}`);
    const text = `${project.name}: the protocol fee accrues directly to the treasury contract`;
    const { fetcher, calls } = countingFetcher({ [u[0]]: docFor(u[0], text), [u[1]]: docFor(u[1], text), [u[2]]: docFor(u[2], text) });
    const extracted: string[] = [];
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-three"]; } },
      searchGateway: { name: "fixture-search", async search() { return u.map((url) => ({ url, title: null, snippet: null })); } },
      contentFetcher: fetcher,
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract(input) {
          extracted.push(input.document.finalUrl);
          return [factFor(input.target, "the protocol fee accrues directly to the treasury contract")];
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    // Executed directly as the LAST pending component, so the fair-share
    // allowance is the full per-attempt cap and the job ceiling is what
    // stops the loop — the shape of the live run's final component.
    let thrown: unknown = null;
    try {
      await executor.execute(ITEM, {
        jobId,
        attemptNumber: 1,
        isRecoveryAttempt: false,
        budget: { maxSearchQueries: 12, maxSourceOpens, maxModelCostMicro: 2_000_000 },
        workQueueSize: 1,
        remainingComponents: 1,
        pendingComponents: [],
      });
    } catch (e) {
      thrown = e;
    }
    return { project, jobId, u, calls, extracted, thrown };
  }

  it("BEFORE → AFTER: two of three candidates fit the ceiling; both are extracted; the third is refused; no fourth open; the error is the same", async () => {
    const { jobId, u, calls, extracted, thrown } = await runToExhaustion(2);
    expect(thrown).toBeInstanceOf(BudgetExhaustedError);
    expect((thrown as BudgetExhaustedError).axis).toBe("sourceOpens");
    // Exactly the two opens the ceiling allowed, nothing after the refusal.
    expect(calls).toEqual([u[0], u[1]]);
    expect(await reservedOpens(jobId)).toBe(2);
    // Both paid-for documents were read (before: zero — the throw came
    // first), and their Evidence is persisted.
    expect(extracted).toEqual([u[0], u[1]]);
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev.map((e) => e.retrievedUrl).sort()).toEqual([u[0], u[1]]);
    // Order in the trace: the refusal is recorded BEFORE any extraction,
    // so extraction provably started after the axis was closed and made
    // no open of its own.
    const rows = await trace(jobId);
    const refusedAt = rows.find((r) => r.operationType === "CANDIDATE_SKIPPED_BUDGET" && r.targetRef === u[2])!.sequence;
    const extracts = rows.filter((r) => r.operationType === "EXTRACT_ATTEMPTED");
    expect(extracts).toHaveLength(2);
    for (const r of extracts) expect(r.sequence).toBeGreaterThan(refusedAt);
    expect(rows.filter((r) => r.operationType === "FETCH_ATTEMPTED" && r.sequence > refusedAt)).toHaveLength(0);
  });

  it("the extracted Evidence reaches reconciliation on the budget-stopped path, exactly as an attempt that never reached a terminal row does", async () => {
    const { jobId } = await runToExhaustion(2);
    await reconcileOutstandingComponents(ctx.db, jobId, [ITEM], NOW, { acquisitionStopped: true });
    const [result] = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(eq(researchComponentResults.researchJobId, jobId));
    expect(result).toBeTruthy();
    expect(result.component).toBe(ITEM.component);
    expect((result.supportingEvidenceIds as string[]).length).toBe(2);
  });

  it("nothing fetched before the refusal → nothing to read → the error is thrown at once, as before", async () => {
    const { calls, extracted, thrown, jobId } = await runToExhaustion(0);
    expect(thrown).toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toEqual([]);
    expect(extracted).toEqual([]);
    expect(await reservedOpens(jobId)).toBe(0);
  });

  it("no refund is possible: the reservation module still has no decrement and the executor never touches the counter directly", () => {
    const reservation = readFileSync("src/server/engine/budget-reservation.ts", "utf-8");
    expect(reservation).toContain("A reservation is never refunded on failure");
    expect(reservation).not.toMatch(/SET\s+\$\{column\}\s*=\s*\$\{column\}\s*-/);
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(executor).not.toMatch(/source_opens_reserved\s*[-=]/);
    expect(executor).not.toMatch(/sourceOpensReserved\s*[-:]\s*sql/);
  });
});

/* ------------------------------------------------------------------ */
/* D2 — the on-chain reserve is released only when the subject can no  */
/*      longer arrive                                                  */
/* ------------------------------------------------------------------ */

describe("D2 — the exact release rule", () => {
  const ONCHAIN_URI = `atlas-onchain://solana/mainnet/project/${MINT}/token/${MINT}/supply`;

  async function admitLocator(jobId: string, address: string): Promise<void> {
    const [source] = await ctx.db
      .insert(sources)
      .values({ url: `https://docs.example.test/${uniq("p")}`, urlHash: uniq("uh"), sourceType: "OFFICIAL_DOCS", health: "OK" })
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
  }

  // Marks the two anchor components as having had their opportunity —
  // the persisted state of the live run at the moment it stopped.
  async function consumeAnchorReads(jobId: string): Promise<void> {
    for (const component of ["CURRENT_STATE", "NET_EFFECT"]) {
      await recordTraceEvent(ctx.db, { researchJobId: jobId, operationType: "FETCH_ATTEMPTED", providerKind: "FETCH", component, targetRef: ONCHAIN_URI, status: "OK", budgetAxis: "sourceOpens", budgetAmount: 1 });
      await recordTraceEvent(ctx.db, { researchJobId: jobId, operationType: "FETCH_OK", providerKind: "FETCH", component, targetRef: ONCHAIN_URI, status: "OK", budgetAxis: "sourceOpens", budgetAmount: 1 });
    }
  }

  it("while documentary work remains, the reserve is HELD even with no subject — the late-subject case is protected", async () => {
    const project = await makeProject({ identity: true });
    const jobId = await makeJob(project.id);
    await consumeAnchorReads(jobId);
    const held = await resolveOnchainSourceOpenReserve(ctx.db, { jobId, projectId: project.id, maxSourceOpens: 24 });
    expect(held.reserved).toBeGreaterThan(0);
    expect(held.promotionReserved).toBeGreaterThan(0);
    expect(held.unreachableComponents).toEqual([]);
    expect(held.released).toBeNull();
    // Nothing the executor passes can release it: the flag is never set
    // from inside an attempt.
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(executor).not.toContain("documentaryAcquisitionFinished");
  });

  it("REPLAY OF bd7cf5ef: once documentary acquisition is over and no locator was ever admitted, the units held for the chain are released — 5 of 24 on the live run", async () => {
    const project = await makeProject({ identity: true });
    const jobId = await makeJob(project.id);
    await consumeAnchorReads(jobId);
    const before = await resolveOnchainSourceOpenReserve(ctx.db, { jobId, projectId: project.id, maxSourceOpens: 24 });
    expect(before.reserved).toBe(5);
    expect(before.demandByComponent).toEqual({ EXECUTION_EVIDENCE: 5 });
    expect(before.documentaryCeiling).toBe(19);

    const after = await resolveOnchainSourceOpenReserve(ctx.db, { jobId, projectId: project.id, maxSourceOpens: 24, documentaryAcquisitionFinished: true });
    expect(after.reserved).toBe(0);
    expect(after.released).toBe("NO_SUBJECT_AFTER_DOCUMENTARY_ACQUISITION");
    expect(after.unreachableComponents).toContain("EXECUTION_EVIDENCE");
    expect(after.documentaryCeiling).toBe(24);
    expect(unprotectedCeiling(after)).toBe(24);
    // The total never moves.
    expect(after.maxSourceOpens).toBe(24);
    expect(after.planned).toBe(true);
  });

  it("a component WITH an admitted subject keeps every unit it was protected — nothing a read could still use is released", async () => {
    const project = await makeProject({ identity: true });
    const jobId = await makeJob(project.id);
    await consumeAnchorReads(jobId);
    await admitLocator(jobId, WALLET);
    const held = await resolveOnchainSourceOpenReserve(ctx.db, { jobId, projectId: project.id, maxSourceOpens: 24 });
    const finished = await resolveOnchainSourceOpenReserve(ctx.db, { jobId, projectId: project.id, maxSourceOpens: 24, documentaryAcquisitionFinished: true });
    expect(held.reserved).toBe(5);
    expect(finished.reserved).toBe(held.reserved);
    expect(finished.demandByComponent).toEqual(held.demandByComponent);
    expect(finished.unreachableComponents).toEqual([]);
    expect(finished.released).toBeNull();
  });

  it("anchor-level reads need no locator, so they are never released by this rule", async () => {
    const project = await makeProject({ identity: true });
    const jobId = await makeJob(project.id);
    // Anchor components not yet consumed; no locator.
    const finished = await resolveOnchainSourceOpenReserve(ctx.db, { jobId, projectId: project.id, maxSourceOpens: 24, documentaryAcquisitionFinished: true });
    expect(finished.baseReserved).toBe(2);
    expect(finished.promotionReserved).toBe(0);
    expect(Object.keys(finished.demandByComponent).sort()).toEqual(["CURRENT_STATE", "NET_EFFECT"]);
    expect(finished.unreachableComponents).toContain("EXECUTION_EVIDENCE");
  });

  it("only the post-controller stages declare that documentary acquisition is over — on the ordinary path and on the budget-exhausted path", () => {
    const runJob = readFileSync("src/server/engine/run-job.ts", "utf-8");
    // Two reactivation calls and two supply-completion calls, all four
    // declared: literally true on the budget-exhausted path, and on the
    // ordinary path true for every stop reason but the resumable one.
    expect((runJob.match(/runOnchainReactivationPass\(db, \{[\s\S]*?documentaryAcquisitionFinished(: true)?,[\s\S]*?\}\)/g) ?? []).length).toBe(2);
    expect((runJob.match(/runPostEventSupplyCompletion\(db, \{[\s\S]*?documentaryAcquisitionFinished(: true)?,[\s\S]*?\}\)/g) ?? []).length).toBe(2);
    expect(runJob).toContain('const documentaryAcquisitionFinished = result.stopReason !== "INTERRUPTED";');
    for (const file of ["src/server/engine/onchain-reactivation.ts", "src/server/engine/onchain-post-event-supply.ts"]) {
      const src = readFileSync(file, "utf-8");
      expect(src).toContain("documentaryAcquisitionFinished: input.documentaryAcquisitionFinished");
    }
    // The reservation module names no project.
    const reserve = readFileSync("src/server/engine/onchain-source-open-reserve.ts", "utf-8").toLowerCase();
    for (const forbidden of ["raydium", "pump", "solscan", "tokenomics"]) expect(reserve).not.toContain(forbidden);
  });
});
