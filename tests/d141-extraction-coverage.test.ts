import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  acquiredDocuments,
  evidence,
  projects,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import {
  prepareExtractionReplayFetcher,
  prepareExtractionReplaySearch,
  runFetchPhase,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ComponentTarget, FetchedDocument } from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-141 — THE EXTRACTION PHASE MUST SEE WHAT ITS OWN JOB FOUND.
//
// The real run (b77170f6-…): SEARCHING discovered 60 candidates, correctly
// attributed across all ten components, and FETCHING sealed six documents.
// Then nine of ten components entered EXTRACTING and reported
// NO_SEARCH_CANDIDATES without spending anything.
//
// Cause, proven from the trace: the executor's targeting (D-129/D-133)
// REPLACES a component's model queries with a site:<domain> or
// site:<explorer> <token> form. Every generic query in that run returned 5
// candidates; every targeted query returned 0. The replay gateway was keyed
// on the exact query string, so it answered "nothing" for strings the
// SEARCH phase had never run — while the job's own candidates sat in the
// trace, attributed to those very components. The single component that
// produced Evidence was the one whose targeting failed to rewrite
// anything, so its generic query still matched.
//
// This file reproduces the shape generically: several components, several
// fetched documents, one authoritative document carrying facts for more
// than one component, one unrelated third-party document.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

const AUTHORITATIVE = "https://docs.example-project.test/mechanism";
const UNRELATED = "https://blog.third-party.test/what-is-example";
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

function docFor(url: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/markdown",
    normalizedText:
      "Protocol fees are used to buy back the token, and bought-back tokens are held at a public address.",
    contentHash: `sha256:${url}`,
    fetchedAt: new Date("2026-08-30T00:00:00Z"),
    byteLength: 200,
  };
}

async function makeProject() {
  const slug = uniq("d141");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D141 Fixture", status: "ACTIVE_CORE" })
    .returning();
  // A confirmed on-chain identity is what makes the executor's targeting
  // produce site:<explorer> locators — the exact condition of the real run.
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("fixture identity failed");
  return { id: project.id, name: project.name, slug };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "where does the revenue go, and what happens to the token bought back?",
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

// Runs a real SEARCHING + FETCHING pass: every component discovers the
// authoritative document, and one component additionally discovers an
// unrelated third-party page.
async function runPhasesOneAndTwo() {
  const project = await makeProject();
  const jobId = await makeJob(project.id);
  const { view } = await loadJobContractView(ctx.db, jobId);
  const items = view.workQueue;
  expect(items.length).toBeGreaterThan(3);

  await runSearchPhase({
    db: ctx.db,
    jobId,
    items,
    target: targetFor(project),
    // Distinct query per component, exactly as a real proposer produces.
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        return Array.from({ length: input.maxQueries }, (_, i) => `${input.hint}-query-${i + 1}`);
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(query: string) {
        const urls = query.startsWith(items[0].component)
          ? [AUTHORITATIVE, UNRELATED]
          : [AUTHORITATIVE];
        return urls.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
    maxResultsPerQuery: 5,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });

  const fetchCalls = { n: 0, urls: [] as string[] };
  await runFetchPhase({
    db: ctx.db,
    jobId,
    projectId: project.id,
    contentFetcher: {
      name: "fixture-transport",
      async fetch(url: string) {
        fetchCalls.n += 1;
        fetchCalls.urls.push(url);
        return docFor(url);
      },
    },
    maxSourceOpens: INTERNAL_ALPHA_V1.maxSourceOpens,
  });

  return { project, jobId, items, fetchCalls };
}

describe("D-141 §1 — the replay gateway answers for the component, not only the string", () => {
  it("1. every component that discovered candidates can still reach them after targeting rewrote its queries", async () => {
    const { jobId, items } = await runPhasesOneAndTwo();
    const replay = await prepareExtractionReplaySearch(ctx.db, jobId);

    for (const item of items) {
      // A query string this job NEVER ran — precisely what the executor's
      // targeting produces (site:<explorer> <token>, site:<domain> …).
      const rewritten = `site:explorer.test ${MINT}`;
      const got = await replay.search(rewritten, targetFor({ id: "", name: "", slug: "" })(item), {
        maxResults: 5,
      });
      expect(
        got.map((c) => c.url),
        `component ${item.component} must still reach its own discovered corpus`,
      ).toContain(AUTHORITATIVE);
    }
  });

  it("the exact-query replay still comes first and is unchanged", async () => {
    const { jobId, items } = await runPhasesOneAndTwo();
    const replay = await prepareExtractionReplaySearch(ctx.db, jobId);
    const item = items[0];
    // The real query the phase ran for this component is in the trace.
    const executed = await ctx.db
      .select({ q: researchTraceEvents.targetRef, op: researchTraceEvents.operationType })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    expect(
      executed.some((r) => r.op === "SEARCH_EXECUTED" && r.q === `${item.component}-query-1`),
    ).toBe(true);

    const got = await replay.search(`${item.component}-query-1`, targetFor({ id: "", name: "", slug: "" })(item), {
      maxResults: 5,
    });
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].url).toBe(AUTHORITATIVE);
  });

  it("a component that discovered nothing still gets nothing — no cross-component leakage", async () => {
    const { jobId, items } = await runPhasesOneAndTwo();
    const replay = await prepareExtractionReplaySearch(ctx.db, jobId);
    // A component key that never appeared in this job's trace.
    const absent: ComponentTarget = {
      step: 99,
      stepName: "NOT_IN_THIS_JOB",
      component: "NOT_A_COMPONENT",
      projectId: "x",
      projectName: "x",
      projectSlug: "x",
    };
    const got = await replay.search("some-query-never-run", absent, { maxResults: 5 });
    expect(got).toEqual([]);
    // And the real components did discover things, so the empty answer
    // above is a real distinction rather than a broken reader.
    const real = await replay.search("some-query-never-run", targetFor({ id: "", name: "", slug: "" })(items[0]), {
      maxResults: 5,
    });
    expect(real.length).toBeGreaterThan(0);
  });
});

describe("D-141 §2 — one document may serve several components (the special check)", () => {
  it("2. the same sealed document is available to, and extractable by, more than one component", async () => {
    const { jobId, items } = await runPhasesOneAndTwo();

    // The authoritative document was sealed once...
    const docs = await ctx.db
      .select()
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    const authoritative = docs.filter((d) => d.url === AUTHORITATIVE);
    expect(authoritative).toHaveLength(1);

    // ...and the replay fetcher serves it to every component that asks,
    // repeatedly. Nothing claims it for one component.
    const { fetcher } = await prepareExtractionReplayFetcher(ctx.db, jobId);
    for (let i = 0; i < items.length; i += 1) {
      const doc = await fetcher.fetch(AUTHORITATIVE);
      expect(doc.finalUrl).toBe(AUTHORITATIVE);
    }

    // Consumption is not claimed by acquisition at all — it is marked only
    // when Evidence from the document is persisted (D-128), so no component
    // can lock the corpus by going first.
    expect(authoritative[0].consumedAt).toBeNull();
  });

  it("3. dedupe still prevents duplicate Evidence, per component and per document", async () => {
    const { jobId } = await runPhasesOneAndTwo();
    // The same url discovered by several components is sealed ONCE.
    const docs = await ctx.db
      .select({ url: acquiredDocuments.url })
      .from(acquiredDocuments)
      .where(eq(acquiredDocuments.acquiringJobId, jobId));
    const urls = docs.map((d) => d.url);
    expect(new Set(urls).size).toBe(urls.length);

    // And the replay gateway never returns the same url twice for one ask,
    // even though several queries discovered it.
    const replay = await prepareExtractionReplaySearch(ctx.db, jobId);
    const { view } = await loadJobContractView(ctx.db, jobId);
    const got = await replay.search("anything", targetFor({ id: "", name: "", slug: "" })(view.workQueue[0]), {
      maxResults: 10,
    });
    expect(new Set(got.map((c) => c.url)).size).toBe(got.length);
  });
});

describe("D-141 §3 — accounting and boundaries are untouched (items 4-8)", () => {
  it("5/6. the replay gateway is still free under D-137, and still declares itself", async () => {
    const { jobId } = await runPhasesOneAndTwo();
    const before = await counters(jobId);
    const replay = await prepareExtractionReplaySearch(ctx.db, jobId);
    expect(replay.metering).toBe("REPLAY");

    const { view } = await loadJobContractView(ctx.db, jobId);
    for (const item of view.workQueue) {
      await replay.search(`site:explorer.test ${MINT}`, targetFor({ id: "", name: "", slug: "" })(item), {
        maxResults: 5,
      });
    }
    const after = await counters(jobId);
    // Reading this job's own corpus costs nothing on any axis.
    expect(after).toEqual(before);
  });

  it("7. budgets are unchanged constants", () => {
    expect(INTERNAL_ALPHA_V1.maxSearchQueries).toBe(12);
    expect(INTERNAL_ALPHA_V1.maxSourceOpens).toBe(24);
    expect(INTERNAL_ALPHA_V1.maxModelCostMicro).toBe(2_000_000);
  });

  it("4. the replay gateway names no project, no component and no url", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/acquisition-phases.ts", "utf-8");
    const fn = src.slice(
      src.indexOf("export async function prepareExtractionReplaySearch"),
      src.indexOf("export async function prepareExtractionReplayProposer"),
    );
    const code = fn
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const word of [
      "raydium",
      "solscan",
      "docs.",
      "http",
      "destination",
      "governance",
      "net_effect",
      "site:",
    ]) {
      expect(code, `replay gateway must not name ${word}`).not.toContain(word);
    }
    // It reads only the closed event type it is allowed to read.
    expect(fn).toContain('"CANDIDATE_RETURNED"');
    expect(fn).toContain("isLossyTargetRef");
  });

  it("8. no admissibility, authority or reconciliation rule was touched", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/acquisition-phases.ts", "utf-8");
    for (const forbidden of [
      "sourceClass",
      "officiality",
      "CLASS_NOT_ADMISSIBLE",
      "reconcile",
      "SOCIAL",
    ]) {
      expect(src, `phase module must not touch ${forbidden}`).not.toContain(forbidden);
    }
    // Evidence rows are still only ever written by the executor.
    const { jobId } = await runPhasesOneAndTwo();
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev).toHaveLength(0);
  });
});

async function counters(jobId: string) {
  const [row] = await ctx.db
    .select({
      searchQueries: researchJobs.searchQueriesReserved,
      sourceOpens: researchJobs.sourceOpensReserved,
      modelCostMicro: researchJobs.modelCostMicroReserved,
    })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  return row;
}
