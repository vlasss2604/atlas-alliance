import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  demoQuotaReservations,
  evidence,
  interpretations,
  projects,
  proofs,
  researchComponentResults,
  researchJobs,
  topics,
  users,
} from "../src/server/db/schema";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { ActiveJobExistsError, createResearchJob, DemoQuotaExceededError } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { loadProofForJob } from "../src/server/services/proof-view";
import { loadSourceSnapshot } from "../src/server/services/source-snapshot";
import { coreEntitlement, demoEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ROUND 12, THE PERSISTED HALF — DEGRADATION THROUGH THE REAL PIPELINE.
//
// The pure half degrades an in-memory evidence pool. This half degrades
// the ENVIRONMENT: the same documents, the same project, the same
// question, run through the real worker and the real S4 executor with
// providers that fail the way providers actually fail — a fetch that
// 503s, an extractor that returns nothing, a search that finds no route,
// a page that is simply gone.
//
// Each degradation is paired against the healthy run over the identical
// documents, and the law is the same one:
//
//   the degraded run is never stronger, and never negative
//
// What must never happen is the shape this round exists to catch: a
// provider failure becoming a statement about the project.
//
// Real Postgres, the real worker, the real S4 executor, deterministic
// fixture providers. No model, no network, no RPC, no spend.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST_A = "docs.degradation-a.example";
const DOCS_HOST_B = "docs.degradation-b.example";

const ALL_COMPONENTS = [
  "SOURCE_OF_VALUE",
  "FLOW_PATH",
  "MECHANISM_SPEC",
  "GOVERNANCE_BASIS",
  "EXECUTION_EVIDENCE",
  "CURRENT_STATE",
  "DESTINATION",
  "RECIPIENT",
  "NET_EFFECT",
  "DURABILITY_BASIS",
] as const;
type Component = (typeof ALL_COMPONENTS)[number];
const FRAGMENT_OF: Record<Component, string> = {
  SOURCE_OF_VALUE: "swap fees charged on every trade are the only source of protocol revenue",
  FLOW_PATH: "collected swap fees are forwarded from the router to the allocation contract",
  MECHANISM_SPEC: "each epoch the allocation contract distributes half of the collected fees",
  GOVERNANCE_BASIS: "the allocation schedule was ratified by the token holder vote",
  EXECUTION_EVIDENCE: "the allocation contract has executed a distribution in every epoch since launch",
  CURRENT_STATE: "the allocation mechanism is active as of the latest epoch",
  DESTINATION: "fees are distributed to holders through the distributor",
  RECIPIENT: "token holders are entitled to a pro rata share of the distributed fees",
  NET_EFFECT: "circulating supply declines by the amount distributed each epoch",
  DURABILITY_BASIS: "the allocation can only be changed by a further token holder vote",
};

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

interface Project {
  id: string;
  slug: string;
  name: string;
  ticker: string | null;
  host: string;
}

const docUrl = (host: string, c: Component) => `https://${host}/docs/${c.toLowerCase().replace(/_/g, "-")}`;

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}
async function makeUser(): Promise<string> {
  const [u] = await ctx.db.insert(users).values({}).returning();
  return u.id;
}
async function makeProject(host: string): Promise<Project> {
  const slug = uniq("deg");
  const name = `Degradation ${slug.replace(/_/g, " ")}`;
  const [p] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const cls = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!cls.ok) throw new Error("docs classify failed: " + cls.refusal);
  return { id: p.id, slug, name, ticker: null, host };
}

function fetched(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${text.length}:${text.slice(0, 64)}`,
    fetchedAt: new Date(),
    byteLength: text.length,
  };
}

interface Degradation {
  name: string;
  // A component whose page cannot be fetched this run (provider 503).
  fetchFails?: Component;
  // A component whose extractor returns nothing although the page loaded.
  extractEmpty?: Component;
  // A component search finds no route for at all. NOTE: with a confirmed
  // OFFICIAL_DOCS route the executor resolves candidate urls from the
  // ROUTE, not from the search gateway — the gateway is never consulted,
  // so this is inert in this configuration and is kept only to document
  // that. Real degradations here are fetch failures and empty extractions.
  searchEmpty?: Component;
  // A component whose page 404s.
  gone?: Component;
}

function executorFor(project: Project, degraded: Degradation = { name: "healthy" }) {
  const byUrl = new Map(ALL_COMPONENTS.map((c) => [docUrl(project.host, c), c]));
  const text = (c: Component) => `${project.name} tokenomics, ${c.toLowerCase().replace(/_/g, " ")}. ${FRAGMENT_OF[c]}.`;
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: { name: "fixture-proposer", async proposeQueries(input) { return [`${input.target.component} of ${project.name}`]; } },
    searchGateway: { name: "fixture-search", async search(_q, target) { return [{ url: docUrl(project.host, target.component as Component), title: null, snippet: null }]; } },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        const c = byUrl.get(url);
        if (!c) throw new Error(`fixture fetch: unexpected url ${url}`);
        if (degraded.fetchFails === c) throw new ContentFetchError("HTTP_ERROR", "fixture: provider unavailable", url, 503);
        if (degraded.gone === c) throw new ContentFetchError("HTTP_ERROR", "fixture: page gone", url, 404);
        return fetched(url, text(c));
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        const c = input.target.component as Component;
        if (degraded.extractEmpty === c) return [];
        if (!input.document.normalizedText.includes(FRAGMENT_OF[c])) return [];
        const fact: ExtractedFact = {
          step: input.target.step,
          component: c,
          statement: `${c.toLowerCase().replace(/_/g, " ")}: ${FRAGMENT_OF[c]}`,
          supportFragment: FRAGMENT_OF[c],
          mechanismState: null,
          directness: "DIRECT",
          publishedAt: null,
          doesNotProve: "does not prove the size of the effect",
          relationship: "SUPPORTS",
        };
        return [fact];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
}

async function newJob(userId: string, project: Project, level: "DEMO" | "CORE", key?: string) {
  const question = "does revenue reach the token?";
  const { job, created } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId,
      topicId: await activeTopicId(),
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: key ?? uniq("idem"),
      entitlement: level === "DEMO" ? demoEntitlement() : coreEntitlement(),
      demoLifetimeProofLimit: 2,
    },
    { skipEnqueue: true },
  );
  await ctx.db.insert(interpretations).values({
    userId,
    researchJobId: job.id,
    originalQuestion: question,
    status: "READY",
    result: {
      status: "READY",
      project_or_asset: project.slug,
      related_entities: [],
      topic: null,
      task_type: "VERIFY_MECHANISM",
      research_task: question,
      understood_summary: null,
      user_assumptions: [],
      ambiguities: [],
      clarification_question: null,
      route: "DEEP_RESEARCH",
      normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN",
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  return { jobId: job.id, created };
}

async function research(userId: string, project: Project, degraded: Degradation = { name: "healthy" }): Promise<string> {
  const { jobId } = await newJob(userId, project, "CORE");
  const handled = await handleResearchJobTask(ctx.db, jobId, executorFor(project, degraded));
  if (!handled.claimed) throw new Error("job not claimed");
  return jobId;
}

const VERDICT_RANK: Record<string, number> = {
  NOT_APPLICABLE: 0,
  NOT_SUPPORTED: 0,
  INSUFFICIENT_EVIDENCE: 1,
  PARTIALLY_SUPPORTED: 2,
  SUPPORTED: 3,
};

interface Outcome {
  jobId: string;
  state: string;
  verdict: string | null;
  confidence: number | null;
  componentStatuses: Record<string, string>;
  evidenceCount: number;
}

async function outcomeOf(jobId: string): Promise<Outcome> {
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const comps = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
  return {
    jobId,
    state: job.state,
    verdict: proof?.verdict ?? null,
    confidence: proof?.confidence ?? null,
    componentStatuses: Object.fromEntries(comps.map((c) => [c.component, c.status])),
    evidenceCount: rows.length,
  };
}

// The law, applied to every pair below.
function degradedNeverStronger(t: Outcome, healthy: Outcome, label: string): void {
  expect(VERDICT_RANK[t.verdict ?? "INSUFFICIENT_EVIDENCE"], `${label}: verdict rose`).toBeLessThanOrEqual(
    VERDICT_RANK[healthy.verdict ?? "INSUFFICIENT_EVIDENCE"],
  );
  if (t.verdict === healthy.verdict) {
    expect(t.confidence ?? 0, `${label}: band rose`).toBeLessThanOrEqual(healthy.confidence ?? 0);
  }
  // A technical failure never becomes a statement about the project.
  expect(t.verdict, `${label}: degradation produced a refutation`).not.toBe("NOT_SUPPORTED");
  for (const [component, status] of Object.entries(t.componentStatuses)) {
    if (healthy.componentStatuses[component] === "CONTRADICTED") continue;
    expect(status, `${label}: ${component} became CONTRADICTED from absence`).not.toBe("CONTRADICTED");
  }
}

// ATLAS allows ONE ACTIVE JOB PER ACCOUNT (enforced in the database), so a
// second start is refused before the quota is even consulted. Every quota
// case below therefore drives each job to a terminal state through the real
// worker before the next one begins — which is also the only way the
// reservation ledger moves RESERVED -> CONSUMED.
async function runToTerminal(jobId: string, project: Project): Promise<string> {
  await handleResearchJobTask(ctx.db, jobId, executorFor(project));
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return job.state;
}

// The exact ownership predicate every job route applies.
async function ownedJob(jobId: string, userId: string) {
  const [row] = await ctx.db
    .select()
    .from(researchJobs)
    .where(and(eq(researchJobs.id, jobId), eq(researchJobs.userId, userId)));
  return row ?? null;
}


// ====================================================================
describe("A. PROVIDER DEGRADATION THROUGH THE REAL PIPELINE", () => {
  it("A0. the baseline is comparable: two fresh projects with identical documents give the identical component picture, so a per-project healthy/degraded pair is a fair comparison", async () => {
    const p1 = await makeProject(DOCS_HOST_A);
    const p2 = await makeProject(DOCS_HOST_A);
    const a = await outcomeOf(await research(await makeUser(), p1));
    const b = await outcomeOf(await research(await makeUser(), p2));
    expect(b.componentStatuses).toEqual(a.componentStatuses);
    expect(b.verdict).toBe(a.verdict);
    expect(b.evidenceCount).toBe(a.evidenceCount);
  }, 600_000);

  it("A1. every single-component degradation — fetch 503, page gone, extractor empty, no route found — is no stronger than the healthy run, and none of them turns a component CONTRADICTED", async () => {
    // EACH CASE GETS ITS OWN PROJECT. A project whose pages were already
    // acquired by an earlier run reuses those documents, so a "search
    // finds nothing" degradation would not bite at all — the degraded run
    // has to be the FIRST research of its project for the degradation to
    // be real. (Found by probing: the search gateway was never called.)
    const healthyProject = await makeProject(DOCS_HOST_A);
    const healthy = await outcomeOf(await research(await makeUser(), healthyProject));
    expect(healthy.state).toBe("SUCCEEDED");
    expect(healthy.evidenceCount).toBeGreaterThan(0);

    const degradations: Degradation[] = [
      { name: "fetch 503 on MECHANISM_SPEC", fetchFails: "MECHANISM_SPEC" },
      { name: "page gone on DESTINATION", gone: "DESTINATION" },
      { name: "extractor empty on RECIPIENT", extractEmpty: "RECIPIENT" },
      { name: "fetch 503 on SOURCE_OF_VALUE", fetchFails: "SOURCE_OF_VALUE" },
      { name: "fetch 503 on CURRENT_STATE", fetchFails: "CURRENT_STATE" },
      { name: "extractor empty on NET_EFFECT", extractEmpty: "NET_EFFECT" },
      { name: "page gone on FLOW_PATH", gone: "FLOW_PATH" },
    ];
    for (const d of degradations) {
      const project = await makeProject(DOCS_HOST_A);
      const t = await outcomeOf(await research(await makeUser(), project, d));
      // Bounded research still finalises — a provider failure is not a
      // reason to leave a job unfinished.
      expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"], `${d.name}: state`).toContain(t.state);
      degradedNeverStronger(t, healthy, d.name);
      // And it really degraded: the targeted component lost its evidence.
      const target = (d.fetchFails ?? d.gone ?? d.extractEmpty)!;
      expect(t.componentStatuses[target], `${d.name}: ${target} was not actually degraded`).toBe("INSUFFICIENT_EVIDENCE");
      expect(t.evidenceCount, `${d.name}: no evidence was lost`).toBeLessThan(healthy.evidenceCount);
    }
  }, 1_200_000);

  it("A2. DEGRADATIONS COMPOSE WITHOUT INVERTING: stacking failures never recovers anything the single failures lost, and the fully degraded run is the weakest of all", async () => {
    const healthy = await outcomeOf(await research(await makeUser(), await makeProject(DOCS_HOST_A)));
    const one = await outcomeOf(
      await research(await makeUser(), await makeProject(DOCS_HOST_A), { name: "one", fetchFails: "MECHANISM_SPEC" }),
    );
    const two = await outcomeOf(
      await research(await makeUser(), await makeProject(DOCS_HOST_A), { name: "two", fetchFails: "MECHANISM_SPEC", extractEmpty: "DESTINATION" }),
    );
    const three = await outcomeOf(
      await research(await makeUser(), await makeProject(DOCS_HOST_A), {
        name: "three",
        fetchFails: "MECHANISM_SPEC",
        extractEmpty: "DESTINATION",
        gone: "FLOW_PATH",
      }),
    );

    degradedNeverStronger(one, healthy, "one failure");
    degradedNeverStronger(two, one, "two failures vs one");
    degradedNeverStronger(three, two, "three failures vs two");
    degradedNeverStronger(three, healthy, "three failures vs healthy");
    // Each rung really did shed evidence, so the ordering is not vacuous.
    expect(one.evidenceCount).toBeLessThan(healthy.evidenceCount);
    expect(two.evidenceCount).toBeLessThan(one.evidenceCount);
    expect(three.evidenceCount).toBeLessThan(two.evidenceCount);
  }, 1_200_000);

  it("A3. TOTAL PROVIDER FAILURE IS NOT A PROJECT FACT: every component failing to fetch leaves a finalised Research that establishes nothing and refutes nothing", async () => {
    const healthy = await outcomeOf(await research(await makeUser(), await makeProject(DOCS_HOST_A)));

    // A degradation that fails EVERY component's fetch, on its own fresh
    // project so nothing has been acquired for it before.
    const project = await makeProject(DOCS_HOST_A);
    const allGone: Degradation = { name: "everything 503" };
    const user = await makeUser();
    const { jobId } = await newJob(user, project, "CORE");
    const exec = createS4WorkExecutor({
      db: ctx.db,
      project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
      chainAcquisition: "DOCUMENTARY_ONLY",
      queryProposer: { name: "fixture-proposer", async proposeQueries(input) { return [`${input.target.component} of ${project.name}`]; } },
      searchGateway: {
        name: "fixture-search",
        async search(_q, target) {
          return [{ url: docUrl(project.host, target.component as Component), title: null, snippet: null }];
        },
      },
      contentFetcher: {
        name: "fixture-fetch",
        async fetch(url: string) {
          throw new ContentFetchError("HTTP_ERROR", "fixture: everything is down", url, 503);
        },
      },
      evidenceExtractor: { name: "fixture-extract", async extract() { return []; } },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
    });
    await handleResearchJobTask(ctx.db, jobId, exec);
    const t = await outcomeOf(jobId);

    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED", "FAILED"], `${allGone.name}: state`).toContain(t.state);
    expect(t.evidenceCount, "rows appeared from nowhere").toBe(0);
    // Nothing established, nothing refuted.
    for (const [component, status] of Object.entries(t.componentStatuses)) {
      expect(["INSUFFICIENT_EVIDENCE"], `${component} status under total failure`).toContain(status);
    }
    if (t.verdict !== null) {
      expect(t.verdict, "total provider failure produced a refutation").not.toBe("NOT_SUPPORTED");
      expect(t.verdict, "total provider failure produced a positive finding").not.toBe("SUPPORTED");
      degradedNeverStronger(t, healthy, "total provider failure");
    }
  }, 900_000);
});

// ====================================================================
describe("B. THE SAME DEGRADATION IS THE SAME ANSWER", () => {
  it("B1. degradation is deterministic: the identical failing environment run twice, on two jobs, gives the identical component picture and verdict", async () => {
    const d: Degradation = { name: "repeat", fetchFails: "MECHANISM_SPEC", extractEmpty: "RECIPIENT" };
    const a = await outcomeOf(await research(await makeUser(), await makeProject(DOCS_HOST_A), d));
    const b = await outcomeOf(await research(await makeUser(), await makeProject(DOCS_HOST_A), d));
    expect(b.componentStatuses).toEqual(a.componentStatuses);
    expect(b.verdict).toBe(a.verdict);
    expect(b.confidence).toEqual(a.confidence);
    expect(b.evidenceCount).toBe(a.evidenceCount);
  }, 900_000);

  it("B2. one project's bad day is not another's: a degraded run on project A leaves a healthy run on project B exactly where it would be alone, with no shared rows", async () => {
    const projectA = await makeProject(DOCS_HOST_A);
    const soloB = await outcomeOf(await research(await makeUser(), await makeProject(DOCS_HOST_B)));
    await research(await makeUser(), projectA, { name: "A degraded", fetchFails: "MECHANISM_SPEC", gone: "DESTINATION" });
    const afterB = await outcomeOf(await research(await makeUser(), await makeProject(DOCS_HOST_B)));

    expect(afterB.componentStatuses).toEqual(soloB.componentStatuses);
    expect(afterB.verdict).toBe(soloB.verdict);
    const idsSolo = new Set((await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, soloB.jobId))).map((r) => r.id));
    const rowsAfter = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, afterB.jobId));
    for (const r of rowsAfter) {
      expect(idsSolo.has(r.id), "B reused A-era rows").toBe(false);
      expect(r.retrievedUrl, "B read a foreign host").toContain(DOCS_HOST_B);
    }
  }, 900_000);
});
