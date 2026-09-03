import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  evidence,
  projects,
  researchJobs,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  runStructuredOnchainAcquisition,
} from "../src/server/engine/onchain-acquisition";
import {
  ONCHAIN_RESERVED_SOURCE_OPENS,
  computeOnchainSourceOpenReserve,
  planHasActionableOnchainWork,
  resolveOnchainSourceOpenReserve,
} from "../src/server/engine/onchain-source-open-reserve";
import { runFetchPhase } from "../src/server/engine/acquisition-phases";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { admittedLocatorsForJob, persistFactLocators } from "../src/server/engine/documentary-locator-store";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { readJobBudgetReserved } from "../src/server/engine/budget-reservation";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type { OnchainArtifact, OnchainIntent } from "../src/server/engine/providers/onchain-types";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import type { FetchedDocument } from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ON-CHAIN SOURCE-OPEN RESERVATION V1.
//
// The live acceptance run these tests exist for: documentary acquisition
// spent the ENTIRE shared sourceOpens axis, seven deterministic on-chain
// intents were planned, the production RPC capability was installed
// correctly, and every single intent was refused with
// SOURCE_OPEN_BUDGET_EXHAUSTED. Typed on-chain reasoning was therefore
// never exercised at all — a false-negative risk, because "no observation
// of the mechanism" and "no mechanism" are different findings.
//
// What is proved here: a small bounded floor INSIDE the existing ceiling
// survives a documentary-heavy workload, the total ceiling does not grow,
// on-chain reads still spend the one canonical ledger, the floor is
// released whenever it protects nothing, and none of it consults a
// project.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const MINT = "Mint1111111111111111111111111111111111111111";
const WALLET = "Wa11et11111111111111111111111111111111111111";
const IDENTITY: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: MINT, ticker: "TST" };
const DOMAIN = "docs.reservation-fixture.test";
const PREFIX = "/mechanism";

// A component whose establishing classes admit ONCHAIN_VERIFIABLE and
// whose base intent addresses the ANCHOR — reachable with no locator.
const ANCHOR_COMPONENT = {
  component: "NET_EFFECT",
  establishingClasses: ["ONCHAIN_VERIFIABLE"] as const,
};
// A component whose base intent is account-kind, so it is reachable ONLY
// once a locator has been admitted.
const ACCOUNT_COMPONENT = {
  component: "EXECUTION_EVIDENCE",
  establishingClasses: ["ONCHAIN_VERIFIABLE"] as const,
};
const DOCUMENTARY_COMPONENT = {
  component: "MECHANISM_SPEC",
  establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"] as const,
};

// ---------------------------------------------------------------------
// The arithmetic, with no database at all.
// ---------------------------------------------------------------------

describe("1/4. documentary-only research keeps the ordinary budget", () => {
  it("no actionable on-chain work reserves nothing and leaves the ceiling whole", () => {
    for (const max of [1, 4, 12, 24, 60]) {
      const r = computeOnchainSourceOpenReserve({ maxSourceOpens: max, onchainWorkPlanned: false });
      expect(r.reserved).toBe(0);
      expect(r.documentaryCeiling).toBe(max);
      expect(r.released).toBe("NO_ACTIONABLE_ONCHAIN_WORK");
    }
  });
});

describe("2/4/6. an actionable on-chain plan receives bounded protected capacity", () => {
  it("reserves a small fixed floor and never raises the total", () => {
    const r = computeOnchainSourceOpenReserve({ maxSourceOpens: 24, onchainWorkPlanned: true });
    expect(r.reserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(r.documentaryCeiling).toBe(24 - ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(r.maxSourceOpens).toBe(24);
  });

  it("4. reserved + documentary ceiling is ALWAYS exactly the unchanged ceiling", () => {
    for (let max = 0; max <= 64; max++) {
      for (const planned of [true, false]) {
        const r = computeOnchainSourceOpenReserve({ maxSourceOpens: max, onchainWorkPlanned: planned });
        expect(r.reserved + r.documentaryCeiling).toBe(max);
        expect(r.documentaryCeiling).toBeLessThanOrEqual(max);
      }
    }
  });

  it("6. the floor is bounded by one attempt's intents AND by half the ceiling", () => {
    expect(ONCHAIN_RESERVED_SOURCE_OPENS).toBe(MAX_ONCHAIN_INTENTS_PER_ATTEMPT);
    for (let max = 0; max <= 64; max++) {
      const r = computeOnchainSourceOpenReserve({ maxSourceOpens: max, onchainWorkPlanned: true });
      expect(r.reserved).toBeLessThanOrEqual(ONCHAIN_RESERVED_SOURCE_OPENS);
      expect(r.reserved).toBeLessThanOrEqual(Math.floor(max / 2));
    }
  });
});

describe("9. unused reserved capacity is handled deterministically", () => {
  it("a context that cannot reach a chain releases the floor", () => {
    const r = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      onchainWorkPlanned: true,
      onchainAcquisitionUnavailable: true,
    });
    expect(r.reserved).toBe(0);
    expect(r.documentaryCeiling).toBe(24);
    expect(r.released).toBe("ONCHAIN_ACQUISITION_UNAVAILABLE");
  });

  it("an UNKNOWN capability never releases it — only a known-absent one does", () => {
    const unknown = computeOnchainSourceOpenReserve({ maxSourceOpens: 24, onchainWorkPlanned: true });
    expect(unknown.reserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(unknown.released).toBeNull();
    const present = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      onchainWorkPlanned: true,
      onchainAcquisitionUnavailable: false,
    });
    expect(present.reserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
  });
});

describe("2/8. what counts as actionable on-chain work is Pattern semantics only", () => {
  it("a component that does not admit ONCHAIN_VERIFIABLE earns no floor", () => {
    expect(
      planHasActionableOnchainWork({ identity: IDENTITY, components: [DOCUMENTARY_COMPONENT] }),
    ).toBe(false);
  });

  it("an anchor-addressable component with a confirmed identity earns one", () => {
    expect(
      planHasActionableOnchainWork({ identity: IDENTITY, components: [ANCHOR_COMPONENT] }),
    ).toBe(true);
  });

  it("8. NO LOCATOR MEANS NO ARBITRARY RPC CALL — and therefore no floor", () => {
    expect(
      planHasActionableOnchainWork({ identity: IDENTITY, components: [ACCOUNT_COMPONENT] }),
    ).toBe(false);
    expect(
      planHasActionableOnchainWork({
        identity: IDENTITY,
        components: [ACCOUNT_COMPONENT],
        locators: [{ address: WALLET, origin: "ADMITTED_EVIDENCE_SOURCE" }],
      }),
    ).toBe(true);
  });

  it("no confirmed identity, or an unsupported chain, earns no floor", () => {
    expect(planHasActionableOnchainWork({ identity: null, components: [ANCHOR_COMPONENT] })).toBe(
      false,
    );
    expect(
      planHasActionableOnchainWork({
        identity: { chain: "ethereum", tokenAddress: MINT, ticker: null },
        components: [ANCHOR_COMPONENT],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 7. No project-specific branch, and no second budget ledger.
// ---------------------------------------------------------------------

describe("7. the rule is generic research capability, never a project", () => {
  it("the reservation module names no project, asset or chain", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = (
      await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8")
    ).toLowerCase();
    for (const banned of [
      "pump",
      "raydium",
      "bonk",
      "jupiter",
      "solana",
      "ethereum",
      "mainnet",
      "ticker",
      "symbol",
      "projectslug",
      "tokenaddress",
    ]) {
      expect(src, `reservation module must not name "${banned}"`).not.toContain(banned);
    }
  });

  it("the decision is delegated to selectOnchainIntents, not restated here", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8");
    expect(src).toContain("selectOnchainIntents");
    // No component -> intent knowledge of its own.
    expect(src).not.toContain("TOKEN_SUPPLY");
    expect(src).not.toContain("ACCOUNT_INFO");
  });

  it("3/11. every documentary source-open in the executor uses the capped ceiling", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/s4-executor.ts", "utf-8");
    // No documentary reservation may still be made against the full job
    // ceiling — that is exactly the path that starved the chain.
    expect(src).not.toContain('"sourceOpens", 1, ctx.budget.maxSourceOpens');
    expect(src).not.toContain("ctx.budget.maxSourceOpens,\n          );");
    const documentaryReservations = src.match(/documentaryMaxSourceOpens/g) ?? [];
    // The allowance, the fetch, the refusal render and the upgrade render.
    expect(documentaryReservations.length).toBeGreaterThanOrEqual(5);
    // The chain path keeps the FULL ceiling — the floor is protection, not
    // a second, smaller budget for on-chain work.
    expect(src).toContain("maxSourceOpens: ctx.budget.maxSourceOpens,");
  });

  it("3. every documentary source-open in the fetch phase uses the capped ceiling", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/acquisition-phases.ts", "utf-8");
    // The phase computes the ceiling once and hands every strategy the
    // capped input; nothing in the chain reads the raw job ceiling again.
    expect(src).toContain("const documentaryInput = { ...input, maxSourceOpens: reserve.documentaryCeiling };");
    expect(src).toContain("acquireOneUrl(documentaryInput, url, out)");
    const reservations = src.match(/"sourceOpens",\n\s+1,\n\s+input\.maxSourceOpens,/g) ?? [];
    expect(reservations.length).toBe(3); // fetch, render fallback, render upgrade
  });

  it("no second budget ledger appears — reserveJobBudget stays the only mutator", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8");
    // It never imports or calls the mutator, and writes nothing itself:
    // the ONE accounting authority stays where it already was.
    expect(src).not.toContain('from "./budget-reservation"');
    expect(src).not.toContain("reserveJobBudget(");
    expect(src).not.toContain("UPDATE research_jobs");
    expect(src).not.toContain(".insert(");
    expect(src).not.toContain(".update(");
    // And the canonical counter set is unchanged.
    expect(INTERNAL_ALPHA_V1.maxSourceOpens).toBe(24);
  });
});

// ---------------------------------------------------------------------
// The database-backed behaviour: a real FETCH phase against a real ledger.
// ---------------------------------------------------------------------

async function makeProject(withIdentity: boolean) {
  const slug = uniq("resv");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Reservation Fixture", status: "ACTIVE_CORE" })
    .returning();
  if (withIdentity) {
    const ok = await confirmProjectIdentity(ctx.db, {
      projectSlug: slug,
      chain: "solana",
      tokenAddress: MINT,
    });
    if (!ok.ok) throw new Error("fixture identity failed");
  }
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: DOMAIN,
    pathPrefix: PREFIX,
  });
  if (!confirmed.ok) throw new Error("fixture route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("fixture route classify failed: " + classified.refusal);
  return { id: project.id, slug };
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

// A PUMP-LIKE WORKLOAD: far more documentary candidates than the axis can
// pay for. Written straight into the candidate handoff the fetch phase
// reads, exactly as the search phase writes it.
async function seedCandidates(jobId: string, n: number): Promise<string[]> {
  const urls: string[] = [];
  await recordTraceEvent(ctx.db, {
    researchJobId: jobId,
    operationType: "SEARCH_EXECUTED",
    providerKind: "SEARCH",
    targetRef: "q-documentary",
    status: "OK",
  });
  for (let i = 0; i < n; i++) {
    const url = `https://${DOMAIN}${PREFIX}/doc-${i}`;
    urls.push(url);
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "CANDIDATE_RETURNED",
      providerKind: "SEARCH",
      targetRef: url,
      status: "OK",
    });
  }
  return urls;
}

function fixtureFetcher(calls: { urls: string[] }) {
  return {
    name: "fixture-transport",
    async fetch(url: string): Promise<FetchedDocument> {
      calls.urls.push(url);
      return {
        finalUrl: url,
        requestedUrl: url,
        httpStatus: 200,
        contentType: "text/markdown",
        normalizedText:
          "Protocol fees are used to buy back the token, and bought-back tokens are burned.",
        contentHash: `sha256:${url}`,
        fetchedAt: new Date("2026-09-01T00:00:00Z"),
        byteLength: 96,
      };
    },
  };
}

async function reservedSourceOpens(jobId: string): Promise<number> {
  const row = await readJobBudgetReserved(ctx.db, jobId);
  return row!.sourceOpens;
}

function anchorArtifact(intent: OnchainIntent): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result: { kind: "TOKEN_SUPPLY", mint: MINT, amountRaw: "1000", decimals: 6 },
    normalizedText: '{"kind":"TOKEN_SUPPLY"}',
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
      retrievedAt: new Date(),
      rawResponseHash: `sha256:raw:${intent.subject}`,
      artifactHash: `sha256:art:${intent.subject}`,
      transactionSignature: null,
    },
  });
}

function anchorRetriever(opts: { fail?: boolean } = {}) {
  const asked: OnchainIntent[] = [];
  return {
    asked,
    retriever: {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent): Promise<OnchainArtifact> => {
        asked.push(intent);
        if (opts.fail) throw new Error("provider exploded");
        return anchorArtifact(intent);
      },
    },
  };
}

// The on-chain path exactly as the executor invokes it, against the SAME
// job ceiling documentary acquisition was capped below.
async function runOnchain(
  jobId: string,
  maxSourceOpens: number,
  opts: { fail?: boolean; component?: string; retriever?: boolean } = {},
) {
  const fixture = anchorRetriever({ fail: opts.fail });
  const traced: { operationType: string; reasonCode?: string }[] = [];
  const locators = await admittedLocatorsForJob(ctx.db, jobId);
  const outcome = await runStructuredOnchainAcquisition({
    db: ctx.db,
    jobId,
    attemptId: null,
    item: { step: 7, component: opts.component ?? "NET_EFFECT" },
    plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: IDENTITY },
    locators: locators.map((l) => ({ address: l.value, origin: "ADMITTED_EVIDENCE_SOURCE" as const })),
    maxSourceOpens,
    retriever: opts.retriever === false ? null : fixture.retriever,
    recordTrace: async (e) => {
      traced.push({ operationType: e.operationType, reasonCode: e.reasonCode });
    },
  });
  return { outcome, asked: fixture.asked, traced };
}

describe("3/10. documentary fetches cannot consume the protected on-chain capacity", () => {
  it("a PUMP-like workload leaves at least the floor for deterministic chain reads", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    await seedCandidates(jobId, 12);
    const calls = { urls: [] as string[] };
    const MAX = 8;

    const fetched = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: MAX,
    });

    // The floor was applied, and it is exactly the bounded floor.
    expect(fetched.onchainReservedSourceOpens).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(fetched.documentarySourceOpenCeiling).toBe(MAX - ONCHAIN_RESERVED_SOURCE_OPENS);

    // Documentary acquisition was hungry for 12 and stopped at the floor.
    expect(calls.urls.length).toBe(MAX - ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(await reservedSourceOpens(jobId)).toBe(MAX - ONCHAIN_RESERVED_SOURCE_OPENS);

    // 10. AND THE PROTECTED CAPACITY SURVIVED: the chain path that was
    // refused on the live run now wins its reservations.
    const chain = await runOnchain(jobId, MAX);
    expect(chain.asked.length).toBe(1);
    expect(chain.outcome.sourceOpensSpent).toBe(1);
    expect(chain.outcome.observations).not.toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
    expect(chain.outcome.evidenceIds.length).toBeGreaterThan(0);

    // 5. and it spent the CANONICAL ledger, not a private one.
    expect(await reservedSourceOpens(jobId)).toBe(MAX - ONCHAIN_RESERVED_SOURCE_OPENS + 1);
  }, 120_000);

  it("6. the chain path is still bounded by the same total ceiling", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    await seedCandidates(jobId, 12);
    const MAX = 4;
    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher({ urls: [] }),
      maxSourceOpens: MAX,
    });
    expect(await reservedSourceOpens(jobId)).toBe(MAX - ONCHAIN_RESERVED_SOURCE_OPENS);

    // Two protected units exist, and one anchor intent uses one of them.
    await runOnchain(jobId, MAX);
    await runOnchain(jobId, MAX);
    expect(await reservedSourceOpens(jobId)).toBe(MAX);

    // 12. Beyond the ceiling there is no capacity at all — and the refusal
    // is a BOUNDED RESEARCH LIMITATION, never a claim about the project.
    const exhausted = await runOnchain(jobId, MAX);
    expect(exhausted.asked.length).toBe(0);
    expect(exhausted.outcome.evidenceIds).toEqual([]);
    expect(exhausted.outcome.observations).toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
    expect(exhausted.traced[0].reasonCode).toBe("SOURCE_OPEN_BUDGET_EXHAUSTED");
    expect(await reservedSourceOpens(jobId)).toBe(MAX);
  }, 120_000);
});

describe("1/11. documentary-only research keeps its existing budget behaviour", () => {
  it("a project with no confirmed identity has no on-chain plan and no floor", async () => {
    const project = await makeProject(false);
    const jobId = await makeJob(project.id, project.slug);
    await seedCandidates(jobId, 12);
    const calls = { urls: [] as string[] };
    const MAX = 8;

    const fetched = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: MAX,
    });

    expect(fetched.onchainReservedSourceOpens).toBe(0);
    expect(fetched.documentarySourceOpenCeiling).toBe(MAX);
    expect(calls.urls.length).toBe(MAX);
    expect(await reservedSourceOpens(jobId)).toBe(MAX);
  }, 120_000);
});

describe("9. a floor that protects nothing is released, not wasted", () => {
  it("a caller that knows the chain path cannot act gets the whole budget", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    await seedCandidates(jobId, 12);
    const calls = { urls: [] as string[] };
    const MAX = 8;

    const fetched = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: MAX,
      onchainAcquisitionUnavailable: true,
    });

    expect(fetched.onchainReservedSourceOpens).toBe(0);
    expect(calls.urls.length).toBe(MAX);
    expect(await reservedSourceOpens(jobId)).toBe(MAX);
  }, 120_000);

  it("no OUTSTANDING component means no floor — the reserve is scoped to work still to do", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    const none = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      outstandingComponents: [],
      maxSourceOpens: 24,
    });
    expect(none.reserved).toBe(0);
    expect(none.documentaryCeiling).toBe(24);

    const some = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      outstandingComponents: ["NET_EFFECT"],
      maxSourceOpens: 24,
    });
    expect(some.reserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);

    // A purely documentary outstanding component protects nothing.
    const documentary = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      outstandingComponents: ["GOVERNANCE_BASIS"],
      maxSourceOpens: 24,
    });
    expect(documentary.reserved).toBe(0);
  }, 120_000);

  it("8. an outstanding component that needs a locator gets no floor until one is admitted", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    const before = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      outstandingComponents: ["EXECUTION_EVIDENCE"],
      maxSourceOpens: 24,
    });
    expect(before.reserved).toBe(0);

    await admitLocator(jobId, WALLET);

    const after = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      outstandingComponents: ["EXECUTION_EVIDENCE"],
      maxSourceOpens: 24,
    });
    expect(after.reserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
  }, 120_000);
});

// ---------------------------------------------------------------------
// The single-process executor path: the same floor, applied where the
// on-chain branch and the documentary loop run inside ONE attempt.
// ---------------------------------------------------------------------

const EXEC_COST = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

// A purely DOCUMENTARY component, so this attempt's own on-chain branch
// selects no intent and the floor can only come from what is still
// OUTSTANDING — which is the whole point of scoping it that way.
const DOC_ITEM: ComponentWorkItem = {
  step: 3,
  stepName: "Mechanism Specification",
  component: "MECHANISM_SPEC",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

async function runExecutorAttempt(
  project: { id: string; slug: string },
  jobId: string,
  opts: { pendingComponents: string[]; chainAcquisition?: "ENABLED" | "DOCUMENTARY_ONLY" },
) {
  const fetched: string[] = [];
  const candidates = [0, 1, 2, 3, 4, 5].map((i) => `https://${DOMAIN}${PREFIX}/exec-${i}`);
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, slug: project.slug, name: "Reservation Fixture", ticker: null },
    queryProposer: { name: "fixture", async proposeQueries() { return ["q"]; } },
    searchGateway: {
      name: "fixture",
      async search() {
        return candidates.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture",
      async fetch(url: string) {
        fetched.push(url);
        return {
          finalUrl: url,
          requestedUrl: url,
          httpStatus: 200,
          contentType: "text/markdown",
          normalizedText: "The mechanism is specified in the protocol documentation.",
          contentHash: `sha256:${url}`,
          fetchedAt: new Date("2026-09-01T00:00:00Z"),
          byteLength: 64,
        };
      },
    },
    evidenceExtractor: { name: "fixture", async extract() { return []; } },
    queryProposerCostProfile: EXEC_COST,
    evidenceExtractorCostProfile: EXEC_COST,
    ...(opts.chainAcquisition ? { chainAcquisition: opts.chainAcquisition } : {}),
  });
  const result = await executor.execute(DOC_ITEM, {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 12, maxSourceOpens: 8, maxModelCostMicro: 2_000_000 },
    workQueueSize: 2,
    remainingComponents: 2,
    pendingComponents: opts.pendingComponents,
  });
  return { fetched, result };
}

describe("3/9/11. the executor applies and releases the same floor", () => {
  it("an outstanding on-chain component narrows what the documentary loop may open", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    const withFloor = await runExecutorAttempt(project, jobId, {
      pendingComponents: ["NET_EFFECT"],
    });
    // Ceiling 8 - 2 reserved = 6, divided by the SAME existing fair-share
    // rule across 2 remaining components -> 3.
    expect(withFloor.fetched.length).toBe(3);
    expect(await reservedSourceOpens(jobId)).toBe(3);
    expect(withFloor.result.reason).toContain("SOURCE_OPENS_RESERVED_FOR_ONCHAIN");
  }, 120_000);

  it("11. with nothing on-chain outstanding, the documentary loop keeps its ordinary share", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    const noFloor = await runExecutorAttempt(project, jobId, {
      pendingComponents: ["GOVERNANCE_BASIS"],
    });
    // No floor: the full ceiling of 8, same fair-share rule -> 4.
    expect(noFloor.fetched.length).toBe(4);
    expect(await reservedSourceOpens(jobId)).toBe(4);
    expect(noFloor.result.reason ?? "").not.toContain("SOURCE_OPENS_RESERVED_FOR_ONCHAIN");
  }, 120_000);

  it("9. an owner documentary-only instruction releases the floor entirely", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    const released = await runExecutorAttempt(project, jobId, {
      pendingComponents: ["NET_EFFECT"],
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    expect(released.fetched.length).toBe(4);
    expect(await reservedSourceOpens(jobId)).toBe(4);
  }, 120_000);
});

// The four boundaries must stay four different things. None of them is
// evidence that a mechanism is absent.
describe("3(task)/12. failure semantics stay distinct", () => {
  it("no subject, disabled capability, provider failure and budget are four outcomes", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);

    // (a) NO SUBJECT / NO LOCATOR — an acquisition boundary. Nothing was
    // attempted, nothing was spent, and nothing is observed about a chain.
    const noSubject = await runOnchain(jobId, 24, { component: "EXECUTION_EVIDENCE" });
    expect(noSubject.asked).toEqual([]);
    expect(noSubject.outcome.observations).toEqual([]);
    expect(noSubject.outcome.sourceOpensSpent).toBe(0);
    expect(await reservedSourceOpens(jobId)).toBe(0);

    // (b) CAPABILITY DISABLED — a configuration limitation.
    const disabled = await runOnchain(jobId, 24, { retriever: false });
    expect(disabled.outcome.observations).toEqual(["ONCHAIN_RETRIEVER_NOT_CONFIGURED"]);
    expect(disabled.outcome.sourceOpensSpent).toBe(0);

    // (c) RPC FAILURE — a technical failure, and never a free retry.
    const failed = await runOnchain(jobId, 24, { fail: true });
    expect(failed.outcome.observations).toContain("ONCHAIN_RETRIEVAL_FAILED");
    expect(failed.outcome.evidenceIds).toEqual([]);
    expect(failed.outcome.sourceOpensSpent).toBe(1);

    // (d) RESERVED BUDGET EXHAUSTED — a bounded research limitation.
    const spent = await runOnchain(jobId, 1);
    expect(spent.outcome.observations).toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");

    // All four are distinct, and none of them is a finding about the
    // project: no evidence row was written by any of them.
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev).toHaveLength(0);
  }, 120_000);
});

// An admitted documentary locator, written exactly as the executor writes
// one — the only thing that may turn an account-kind intent actionable.
async function admitLocator(jobId: string, address: string): Promise<void> {
  const [source] = await ctx.db
    .insert(sources)
    .values({
      url: `https://${DOMAIN}${PREFIX}/${uniq("p")}`,
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
      fragment: `the mechanism sends tokens to ${address}`,
      summary: "documented account",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: new Date(),
      evidenceContractVersion: 2,
      patternStep: 3,
      component: "MECHANISM_SPEC",
      directness: "DIRECT",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
    })
    .returning();
  await persistFactLocators(ctx.db, row.id, [{ value: address, shape: "ADDRESS_LIKE" }]);
}

// A last structural guard: the trace still carries the on-chain spend on
// the SAME axis as documentary acquisition — one ledger, one vocabulary.
describe("5. on-chain reads are metered on the canonical sourceOpens axis", () => {
  it("every real chain read reserves one unit of the job's own counter", async () => {
    const project = await makeProject(true);
    const jobId = await makeJob(project.id, project.slug);
    expect(await reservedSourceOpens(jobId)).toBe(0);
    await runOnchain(jobId, 24);
    expect(await reservedSourceOpens(jobId)).toBe(1);
    const rows = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    expect(rows).toHaveLength(0); // the fixture captured trace instead of writing it
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.sourceOpensReserved).toBe(1);
  }, 120_000);
});
