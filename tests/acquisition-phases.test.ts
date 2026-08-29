import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquiredDocuments,
  evidence,
  projects,
  proofs,
  researchAttempts,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  loadFetchTargets,
  prepareExtractionReplayFetcher,
  prepareExtractionReplayProposer,
  prepareExtractionReplaySearch,
  runFetchPhase,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import { persistAcquiredDocument } from "../src/server/engine/acquired-documents";
import { buildAndPersistProof } from "../src/server/engine/proof-store";
import { loadProofForJob } from "../src/server/services/proof-view";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { runS4ResearchJob } from "../src/server/engine/run-job";
import { buildContractView } from "../src/server/engine/contract-view";
import { parseContract } from "../src/server/memory/contract";
import { loadActivePatternVersion } from "../src/server/engine/active-pattern";
import { researchPlans } from "../src/server/db/schema";
import { desc } from "drizzle-orm";
import {
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
} from "../src/server/db/schema";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import type {
  ComponentTarget,
  ExtractedFact,
  FetchedDocument,
} from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-136 SLICE 1 — the phased research shape, proved entirely OFFLINE.
//
// One job crosses three capability phases without a single network call:
// SEARCHING (fixture providers) -> persisted candidate handoff ->
// FETCHING (fixture transport) -> sealed acquired_documents ->
// EXTRACTING (replay providers + the NORMAL controller) -> S5/S6/S7/S8/S9.
//
// The load-bearing claims are the ones about what does NOT happen:
// phases create no attempts and no Evidence, the controller runs once with
// FIRST attempts only, the recovery pool is untouched, and extraction
// never reaches outside the sealed set.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const DOC_URL = "https://docs.example-project.test/mechanism";
const OTHER_URL = "https://docs.example-project.test/second";
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

const ITEM: ComponentWorkItem = {
  step: 6,
  stepName: "Value Destination",
  component: "DESTINATION",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

function targetFor(project: { id: string; name: string; slug: string }) {
  return (item: ComponentWorkItem): ComponentTarget => ({
    step: item.step,
    stepName: item.stepName,
    component: item.component,
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
  });
}

function fixtureDoc(url: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText:
      "Protocol fees are used to buy back the token, and bought-back tokens are held at a public address.",
    contentHash: "sha256:fixture",
    fetchedAt: new Date("2026-08-29T00:00:00Z"),
    byteLength: 120,
  };
}

function validFact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 6,
    component: "DESTINATION",
    statement: "Bought-back tokens are held at a public address.",
    supportFragment: "bought-back tokens are held at a public address",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not establish that any buyback executed",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
    ...over,
  };
}

// A project with a CONFIRMED + classified route, so OWNER_STRICT sealing
// is possible and the PRODUCT_ACQUISITION difference is observable.
async function makeClassifiedProject() {
  const slug = uniq("d136");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D136 Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("fixture identity failed");
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: "docs.example-project.test",
    pathPrefix: "/mechanism",
  });
  if (!confirmed.ok) throw new Error("fixture route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("fixture route classify failed: " + classified.refusal);
  return { id: project.id, name: project.name, slug };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "q",
    normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement,
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

// The controller's own work queue, derived the way run-job.ts derives it.
// A phase must cover every component the controller will process, or those
// components legitimately have nothing to replay.
async function workQueueFor(jobId: string): Promise<ComponentWorkItem[]> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [planRow] = await ctx.db
    .select()
    .from(researchPlans)
    .where(eq(researchPlans.researchJobId, jobId))
    .orderBy(desc(researchPlans.version))
    .limit(1);
  const contract = parseContract(planRow.contract);
  const activePatternVersion = await loadActivePatternVersion(ctx.db, job.topicId!);
  const view = buildContractView({
    contract,
    mode: planRow.mode,
    capabilityAtStart: job.capabilityAtStart,
    activePatternVersion: activePatternVersion!,
  });
  return [...view.workQueue];
}

function fixtureProposer(queries: string[]) {
  return { name: "fixture-proposer", async proposeQueries() { return queries; } };
}

function fixtureSearch(byQuery: Record<string, string[]>, calls?: { n: number }) {
  return {
    name: "fixture-search",
    async search(query: string) {
      if (calls) calls.n += 1;
      return (byQuery[query] ?? []).map((url) => ({ url, title: null, snippet: null }));
    },
  };
}

function fixtureFetcher(calls: { n: number; urls: string[] }) {
  return {
    name: "fixture-transport",
    async fetch(url: string) {
      calls.n += 1;
      calls.urls.push(url);
      return fixtureDoc(url);
    },
  };
}

async function countsFor(jobId: string) {
  const [ev, at, ad, pr] = await Promise.all([
    ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId)),
    ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId)),
    ctx.db.select().from(acquiredDocuments).where(eq(acquiredDocuments.acquiringJobId, jobId)),
    ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId)),
  ]);
  return { evidence: ev.length, attempts: at.length, documents: ad.length, proofs: pr.length };
}

describe("PHASE 1 — SEARCHING persists a handoff and nothing else (items 2-5)", () => {
  it("2/3/4/5. persists candidates via trace; zero fetch, zero Evidence, zero attempts, zero documents", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    const searchCalls = { n: 0 };

    const out = await runSearchPhase({
      db: ctx.db,
      jobId,
      items: [ITEM],
      target: targetFor(project),
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL, OTHER_URL] }, searchCalls),
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 2,
    });

    expect(searchCalls.n).toBe(1);
    expect(out.executedQueries).toEqual(["q-alpha"]);
    expect(out.candidateUrls).toEqual([DOC_URL, OTHER_URL]);

    // 2. the handoff is readable back through the canonical typed reader.
    expect((await loadFetchTargets(ctx.db, jobId)).sort()).toEqual([OTHER_URL, DOC_URL].sort());

    // 3/4/5. nothing else happened.
    const c = await countsFor(jobId);
    expect(c).toEqual({ evidence: 0, attempts: 0, documents: 0, proofs: 0 });
  }, 60_000);

  it("a query already searched in this job is not paid for twice, but still contributes its candidates", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    const calls = { n: 0 };
    const gateway = fixtureSearch({ "q-alpha": [DOC_URL] }, calls);
    const args = {
      db: ctx.db,
      jobId,
      items: [ITEM],
      target: targetFor(project),
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: gateway,
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 2,
    };
    await runSearchPhase(args);
    const second = await runSearchPhase(args);

    expect(calls.n).toBe(1); // the second pass spent no search unit
    expect(second.dedupedQueries).toEqual(["q-alpha"]);
    expect(second.candidateUrls).toEqual([DOC_URL]);
    expect((await loadFetchTargets(ctx.db, jobId))).toEqual([DOC_URL]);
  }, 60_000);
});

describe("the candidate handoff is strictly typed (items 7, 8)", () => {
  it("7. a lossy target ref is never offered as a fetch target", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    // Written the way the executor writes them, but with a REDACTED ref —
    // exactly what trace does to a credential-bearing url.
    const { recordTraceEvent } = await import("../src/server/engine/trace-store");
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      providerKind: "SEARCH",
      targetRef: "q-lossy",
      status: "OK",
    });
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "CANDIDATE_RETURNED",
      providerKind: "SEARCH",
      targetRef: "https://x.test/a?token=[REDACTED]",
      status: "OK",
    });
    expect(await loadFetchTargets(ctx.db, jobId)).toEqual([]);
  }, 60_000);

  it("8. candidate dedup is deterministic, and an already-fetched url is not re-offered", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    const { recordTraceEvent } = await import("../src/server/engine/trace-store");
    for (const q of ["q1", "q2"]) {
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: "SEARCH_EXECUTED",
        providerKind: "SEARCH",
        targetRef: q,
        status: "OK",
      });
      // The SAME url returned by both queries.
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: "CANDIDATE_RETURNED",
        providerKind: "SEARCH",
        targetRef: DOC_URL,
        status: "OK",
      });
    }
    expect(await loadFetchTargets(ctx.db, jobId)).toEqual([DOC_URL]);

    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "FETCH_OK",
      providerKind: "FETCH",
      targetRef: DOC_URL,
      status: "OK",
    });
    expect(await loadFetchTargets(ctx.db, jobId)).toEqual([]);
  }, 60_000);
});

describe("PHASE 2 — FETCHING seals, and nothing else (items 6, 9, 12, 13)", () => {
  it("6/9/12/13. consumes only persisted candidates, seals documents, writes no Evidence and no attempt", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: [ITEM],
      target: targetFor(project),
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }),
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 2,
    });

    const calls = { n: 0, urls: [] as string[] };
    const out = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });

    // 6. only what phase 1 persisted was fetched.
    expect(calls.urls).toEqual([DOC_URL]);
    expect(out.sealedDocumentIds).toHaveLength(1);

    // 9. sealed with a real seal.
    const [row] = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.id, out.sealedDocumentIds[0]));
    expect(row.textSha256.startsWith("sha256:")).toBe(true);
    expect(row.acquiringJobId).toBe(jobId);

    // 12/13. still no Evidence, still no attempt.
    const c = await countsFor(jobId);
    expect(c.evidence).toBe(0);
    expect(c.attempts).toBe(0);
    expect(c.proofs).toBe(0);
  }, 60_000);

  it("a url that is not parseable https is refused BEFORE the transport is called", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    const { recordTraceEvent } = await import("../src/server/engine/trace-store");
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      providerKind: "SEARCH",
      targetRef: "q",
      status: "OK",
    });
    for (const bad of ["not-a-url", "http://insecure.test/a"]) {
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: "CANDIDATE_RETURNED",
        providerKind: "SEARCH",
        targetRef: bad,
        status: "OK",
      });
    }
    const calls = { n: 0, urls: [] as string[] };
    const out = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });
    expect(calls.n).toBe(0);
    expect(out.refusedUrls).toHaveLength(2);
    expect(out.sealedDocumentIds).toEqual([]);
  }, 60_000);
});

describe("PRODUCT_ACQUISITION admission (items 10, 11)", () => {
  it("11. OWNER_STRICT is unchanged: an unconfirmed route is still refused, by default and explicitly", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    // A url OUTSIDE the confirmed prefix — resolves without documentary
    // authority for this project.
    const unconfirmed = "https://docs.example-project.test/not-confirmed";
    const route = await resolveSourceRoute(ctx.db, project.id, unconfirmed);

    const byDefault = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: jobId,
      doc: fixtureDoc(unconfirmed),
      route,
      renderMode: "STATIC",
    });
    expect(byDefault).toMatchObject({ ok: false, refusal: "AUTHORITY_NOT_CONFIRMED" });

    const explicit = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: jobId,
      doc: fixtureDoc(unconfirmed),
      route,
      renderMode: "STATIC",
      admission: "OWNER_STRICT",
    });
    expect(explicit).toMatchObject({ ok: false, refusal: "AUTHORITY_NOT_CONFIRMED" });
  }, 60_000);

  it("10. PRODUCT_ACQUISITION seals the same document but grants NO authority — the snapshot is recorded as resolved", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    const unconfirmed = "https://docs.example-project.test/not-confirmed";
    const route = await resolveSourceRoute(ctx.db, project.id, unconfirmed);

    const sealed = await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: jobId,
      doc: fixtureDoc(unconfirmed),
      route,
      renderMode: "STATIC",
      admission: "PRODUCT_ACQUISITION",
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    const [row] = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.id, sealed.id));
    const authority = row.authority as { officiality: string; routeClass: string | null };
    // Recorded faithfully, never upgraded because the fetch succeeded.
    expect(authority.officiality).toBe(route.officiality);
    expect(authority.routeClass).toBe(route.routeClass);
    // NOTE, learned from the resolver rather than assumed: officiality is
    // DOMAIN-wide, so a url outside the confirmed prefix still resolves
    // CONFIRMED. The path-scoped axis is routeClass, which is null here —
    // and that null is exactly what OWNER_STRICT refuses on (the test
    // above) and what PRODUCT_ACQUISITION records without upgrading.
    expect(authority.routeClass).toBeNull();
    // The seal grants nothing: no documentary class was invented for it.
    expect(authority.routeClass).not.toBe("OFFICIAL_DOCS");
  }, 60_000);
});

describe("PHASE 3 — EXTRACTING through the NORMAL controller (items 1, 14-23)", () => {
  it("1/14-23. the full offline path: three phases, first attempts only, one Proof, S9-readable", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);

    // --- phase 1, over the controller's OWN work queue ---
    const items = await workQueueFor(jobId);
    expect(items.length).toBeGreaterThan(0);
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items,
      target: targetFor(project),
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }),
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 2,
    });
    // --- phase 2 ---
    const fetchCalls = { n: 0, urls: [] as string[] };
    const fetched = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(fetchCalls),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });
    expect(fetched.sealedDocumentIds).toHaveLength(1);
    expect((await countsFor(jobId)).attempts).toBe(0);

    // --- phase 3: replay providers + the NORMAL executor ---
    const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
    expect(replay.documentCount).toBe(1);
    const replayCalls = { n: 0, urls: [] as string[] };
    const countingReplay = {
      name: replay.fetcher.name,
      fetch: async (url: string) => {
        replayCalls.n += 1;
        replayCalls.urls.push(url);
        return replay.fetcher.fetch(url);
      },
    };
    const extractorCalls = { n: 0 };
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
      queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
      searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
      contentFetcher: countingReplay,
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract() {
          extractorCalls.n += 1;
          return [validFact()];
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });

    // The REAL production entrypoint: controller once, then the S5 sweep,
    // S6, S7 and S8 exactly as run-job.ts orders them.
    await runS4ResearchJob(ctx.db, jobId, executor, new Date());

    // 14/15. extraction used ONLY sealed documents and never reached
    // outside them — the replay fetcher is the only transport it has.
    expect(replayCalls.urls.length).toBeGreaterThan(0);
    expect([...new Set(replayCalls.urls)]).toEqual([DOC_URL]);
    expect(fetchCalls.n).toBe(1); // still just phase 2's single fetch
    expect(extractorCalls.n).toBeGreaterThan(0);

    // 19-22. the normal projection ran, unchanged.
    const s5rows = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(eq(researchComponentResults.researchJobId, jobId));
    expect(s5rows.length).toBeGreaterThan(0);
    const s6rows = await ctx.db
      .select()
      .from(researchMechanismAssembly)
      .where(eq(researchMechanismAssembly.researchJobId, jobId));
    expect(s6rows).toHaveLength(1);
    const s7rows = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, jobId));
    expect(s7rows).toHaveLength(1);

    const proofRows = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proofRows).toHaveLength(1);
    expect(proofRows[0].visibility).toBe("PRIVATE");
    expect(proofRows[0].verificationStatus).toBe("DRAFT");

    // 23. S9 reads it with no phased-path special case.
    const [job] = await ctx.db
      .select()
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    const view = await loadProofForJob(ctx.db, jobId, job.userId);
    expect(view).not.toBeNull();
    expect(view!.proofId).toBe(proofRows[0].id);
  }, 120_000);

  it("16/17/18. the controller sees FIRST attempts only — the phases consumed no recovery budget", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: await workQueueFor(jobId),
      target: targetFor(project),
      queryProposer: fixtureProposer(["q-alpha"]),
      searchGateway: fixtureSearch({ "q-alpha": [DOC_URL] }),
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 2,
    });
    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher({ n: 0, urls: [] }),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });

    // 16. the controller has not started: no attempt row exists yet.
    expect((await countsFor(jobId)).attempts).toBe(0);

    const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: null },
      queryProposer: await prepareExtractionReplayProposer(ctx.db, jobId),
      searchGateway: await prepareExtractionReplaySearch(ctx.db, jobId),
      contentFetcher: replay.fetcher,
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract() { return [validFact()]; },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    await runS4ResearchJob(ctx.db, jobId, executor, new Date());

    // 17/18. every persisted attempt is attemptNumber 1 — nothing the
    // controller would charge against reservedRecoverySteps.
    const attempts = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) expect(a.attemptNumber).toBe(1);
    expect(attempts.filter((a) => a.attemptNumber > 1)).toHaveLength(0);
  }, 120_000);
});

describe("failure and replay safety (items 24, 15)", () => {
  it("24. a phase failure fabricates no Proof", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    // Phase 1 returns nothing, so phase 2 seals nothing.
    await runSearchPhase({
      db: ctx.db,
      jobId,
      items: [ITEM],
      target: targetFor(project),
      queryProposer: fixtureProposer(["q-empty"]),
      searchGateway: fixtureSearch({}),
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 5,
      maxQueriesPerComponent: 2,
    });
    const fetched = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher({ n: 0, urls: [] }),
      maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
    });
    expect(fetched.sealedDocumentIds).toEqual([]);

    const s8 = await buildAndPersistProof(ctx.db, jobId);
    expect(s8.refusal).toBe("NO_CLAIM_SUPPORT");
    expect((await countsFor(jobId)).proofs).toBe(0);
  }, 60_000);

  it("15. the replay fetcher refuses any url outside this job's sealed set", async () => {
    const project = await makeClassifiedProject();
    const jobId = await makeJob(project.id);
    const [source] = await ctx.db
      .insert(sources)
      .values({ url: DOC_URL, urlHash: uniq("uh"), sourceType: "OTHER" })
      .returning();
    expect(source.id).toBeTruthy();

    const route = await resolveSourceRoute(ctx.db, project.id, DOC_URL);
    await persistAcquiredDocument(ctx.db, {
      projectId: project.id,
      acquiringJobId: jobId,
      doc: fixtureDoc(DOC_URL),
      route,
      renderMode: "STATIC",
      admission: "PRODUCT_ACQUISITION",
    });

    const replay = await prepareExtractionReplayFetcher(ctx.db, jobId);
    await expect(replay.fetcher.fetch(DOC_URL)).resolves.toMatchObject({ finalUrl: DOC_URL });
    await expect(replay.fetcher.fetch("https://elsewhere.test/x")).rejects.toThrow();
  }, 60_000);
});

describe("boundary (item 25, and the network-identity rule)", () => {
  it("25. the phase module names no project, and no network product or VPN", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/acquisition-phases.ts", import.meta.url),
      "utf-8",
    );
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const banned of [
      "mantaray",
      "vpn",
      "proxy",
      "raydium",
      "pump",
      "solscan",
      "brave",
      "anthropic",
      "region",
      "country",
    ]) {
      expect(code, `phase module mentions "${banned}"`).not.toContain(banned);
    }
  });

  it("the phase module owns no attempt lifecycle and no projection", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/engine/acquisition-phases.ts", import.meta.url),
      "utf-8",
    );
    for (const banned of [
      "researchAttempts",
      "runResearchController",
      "reconcileAndPersistComponent",
      "assembleAndPersistMechanism",
      "evaluateAndPersistClaimSupport",
      "buildAndPersistProof",
    ]) {
      expect(src, `phase module references "${banned}"`).not.toContain(banned);
    }
  });
});
