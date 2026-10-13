import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG } from "../src/server/config/product";
import { evidence, projects, topics, users } from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RC-8 — AN OFFICIAL PAGE WAS ACQUIRED AND SHOWN TO NOBODY.
//
// THE DEFECT, measured on the frozen panel. In 4 of 4 researched Raydium
// jobs docs.raydium.io/ray/ray-buybacks.md was selected for seven
// components (SOURCE_RESOURCE_SELECTED), fetched OK, sealed with full
// authority — and produced zero Evidence rows, with no extraction error
// anywhere, because nothing failed: it was simply never opened. Every one
// of those jobs extracted exactly ONE document per component.
//
// THE MECHANISM. The EXTRACTING phase replays documents this job already
// fetched, through a fetcher whose metering is REPLAY. Charging a source
// open for such a read is already refused as meaningless (D-137) — it
// meters an external action that cannot occur. But the per-component OPEN
// ALLOWANCE was still computed from that same source-open ledger, which
// the FETCHING phase had already nearly exhausted (20 of 24 in the
// observed run). The fair-share division collapsed to zero, the floor
// pinned it at one, and extraction opened the first candidate and broke.
// The more authoritative documents acquisition found, the more it threw
// away — and silently, since a document that is never opened produces no
// failure to record.
//
// These tests pin both directions: the unmetered replay phase may read
// every document this job already paid for, and the metered path is
// untouched, so nothing about external source-open budgeting is relaxed.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-09-06T00:00:00Z");
const URL_A = "https://docs.example.test/protocol-fees";
const URL_B = "https://docs.example.test/buybacks";
const TEXT_A = "Fixture Project: trading fees accrue to the protocol fee vault";
const TEXT_B = "Fixture Project: the protocol buys back and burns the token every week";

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

const FIXTURE_COST_PROFILE: ModelCostProfile = {
  modelId: "fixture-test-model",
  priceVersion: "test-fixture-not-production",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_000,
};

function doc(url: string, text: string): FetchedDocument {
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

// The two fetchers differ ONLY in metering — same documents, same failures.
// That is what isolates the allowance rule from everything else.
function fetcher(metering: "LIVE" | "REPLAY"): ContentFetcher {
  const byUrl: Record<string, FetchedDocument> = {
    [URL_A]: doc(URL_A, TEXT_A),
    [URL_B]: doc(URL_B, TEXT_B),
  };
  const base = {
    name: metering === "REPLAY" ? "acquired-document-replay" : "fixture-live",
    async fetch(url: string) {
      const d = byUrl[url];
      if (!d) throw new ContentFetchError("HTTP_ERROR", "not in fixture", url);
      return d;
    },
  };
  return metering === "REPLAY" ? ({ ...base, metering: "REPLAY" } as ContentFetcher) : (base as ContentFetcher);
}

function fact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 1,
    component: "SOURCE_OF_VALUE",
    statement: "fees accrue to the protocol",
    supportFragment: TEXT_A,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove distribution to holders",
    relationship: "SUPPORTS",
    ...over,
  };
}

// Per-document extraction, so each document's own facts are attributable.
function perDocExtractor(byText: Record<string, ExtractedFact[]>): EvidenceExtractor {
  return {
    name: "fixture",
    async extract(input: { document: { normalizedText: string } }) {
      return byText[input.document.normalizedText] ?? [];
    },
  } as unknown as EvidenceExtractor;
}

const proposer: QueryProposer = { name: "fixture", async proposeQueries() { return ["q"]; } };
const search: SearchGateway = {
  name: "fixture",
  async search() {
    return [URL_A, URL_B].map((url) => ({ url, title: null, snippet: null }));
  },
};

async function makeJob() {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("rc8"), name: "Fixture Project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "does protocol revenue reach token holders?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return { jobId: job.id, projectId: project.id, projectName: project.name };
}

// The exhausted-axis shape the panel actually ran in: almost no source
// opens left and many components still pending, so the metered fair-share
// division floors the allowance at exactly one.
function exhaustedCtx(jobId: string) {
  return {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 10, maxSourceOpens: 2, maxModelCostMicro: 5_000_000 },
    workQueueSize: 8,
    remainingComponents: 8,
  };
}

async function run(
  metering: "LIVE" | "REPLAY",
  facts: Record<string, ExtractedFact[]>,
): Promise<{ jobId: string; rows: { fragment: string; component: string | null }[] }> {
  const p = await makeJob();
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: "fixture", ticker: null },
    config: DEFAULT_PRODUCT_CONFIG,
    queryProposer: proposer,
    searchGateway: search,
    contentFetcher: fetcher(metering),
    evidenceExtractor: perDocExtractor(facts),
    now: () => NOW,
    __testCostProfile: FIXTURE_COST_PROFILE,
  } as unknown as Parameters<typeof createS4WorkExecutor>[0]);
  await executor.execute(ITEM, exhaustedCtx(p.jobId) as never);
  const rows = await ctx.db
    .select({ fragment: evidence.fragment, component: evidence.component })
    .from(evidence)
    .where(eq(evidence.researchJobId, p.jobId));
  return { jobId: p.jobId, rows };
}

const BOTH = { [TEXT_A]: [fact()], [TEXT_B]: [fact({ statement: "buyback and burn", supportFragment: TEXT_B })] };

describe("RC-8 — an unmetered replay phase is not rationed by the metered source-open axis", () => {
  it("1. REPLAY: both already-acquired documents are read, not just the first", async () => {
    const { rows } = await run("REPLAY", BOTH);
    const fragments = rows.map((r) => r.fragment);
    expect(fragments).toContain(TEXT_A);
    // The one the panel lost in 4 of 4 jobs.
    expect(fragments).toContain(TEXT_B);
    expect(rows).toHaveLength(2);
  });

  it("2. METERED: the external-open budget is untouched — still exactly one document", async () => {
    const { rows } = await run("LIVE", BOTH);
    // Not a weakening: a real network open still costs a seat, and the
    // fair-share division still protects the components behind this one.
    expect(rows).toHaveLength(1);
    expect(rows[0].fragment).toBe(TEXT_A);
  });

  it("3. reading more documents does not relax traceability — an unquotable fact is still refused", async () => {
    const { rows } = await run("REPLAY", {
      [TEXT_A]: [fact()],
      [TEXT_B]: [fact({ statement: "invented", supportFragment: "a sentence that is not in the document" })],
    });
    expect(rows.map((r) => r.fragment)).toEqual([TEXT_A]);
  });

  it("4. component boundaries are not broadened by the extra document", async () => {
    const { rows } = await run("REPLAY", {
      [TEXT_A]: [fact()],
      [TEXT_B]: [fact({ step: 6, component: "DESTINATION", supportFragment: TEXT_B })],
    });
    // Whatever survives belongs to the component under work, never another.
    for (const r of rows) expect(r.component).toBe("SOURCE_OF_VALUE");
  });

  it("5. a second document without the proposition produces no support at all", async () => {
    const { rows } = await run("REPLAY", { [TEXT_A]: [fact()], [TEXT_B]: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].fragment).toBe(TEXT_A);
  });
});
