import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  demoQuotaReservations,
  evidence,
  interpretations,
  productConfig,
  projects,
  proofs,
  researchComponentResults,
  researchJobs,
  researchMemory,
  topics,
  users,
} from "../src/server/db/schema";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { promoteToActive } from "../src/server/memory/lifecycle";
import { markProofVerified } from "../src/server/memory/verification";
import { ActiveJobExistsError, createResearchJob, DemoQuotaExceededError } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { loadProofForJob } from "../src/server/services/proof-view";
import { loadSourceSnapshot } from "../src/server/services/source-snapshot";
import { coreEntitlement, demoEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ROUND 13, THE PERSISTED HALF — IDENTITY ISOLATION WHERE BINDING IS
// ACTUALLY COMPUTED.
//
// The pure half hands the reducer rows whose binding is already decided.
// This half does not: two real projects are onboarded, each with its own
// confirmed token identity and its own classified source route, and every
// binding, class and authority decision is made by the production
// resolvers from the route table and the identity confirmed today.
//
// The attack is the same jigsaw, now with real identities:
//
//   can Project B's research be completed by Project A's pages, Project
//   A's verified Memory, or a reading of Project A's token
//
// and the answer must be no on every path, including the one path that is
// allowed to cross a job boundary at all — Research Memory, which may
// carry an OBSERVATION and never a verdict.
//
// Real Postgres, the real worker, the real S4 executor, the real identity
// and route resolvers. No model, no network, no RPC, no spend.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST_A = "docs.identity-a.example";
const DOCS_HOST_B = "docs.identity-b.example";

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
async function makeProject(host: string, identity?: { chain: string; tokenAddress: string; ticker?: string }): Promise<Project> {
  const slug = uniq("idn");
  const name = `Identity ${slug.replace(/_/g, " ")}`;
  const [p] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE", ticker: identity?.ticker ?? null }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const cls = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!cls.ok) throw new Error("docs classify failed: " + cls.refusal);
  if (identity) {
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: slug,
      chain: identity.chain,
      tokenAddress: identity.tokenAddress,
      ticker: identity.ticker ?? "IDN",
    });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, name, ticker: identity?.ticker ?? null, host };
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



const EVM_A = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
const EVM_B = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";

// Project B's research, run with a provider that ALSO serves project A's
// pages — the composition attack, where the wrong project's documents are
// physically reachable and only identity and routing stand between them
// and B's Proof.
function crossServingExecutor(subject: Project, alsoServes: Project) {
  const byUrl = new Map<string, Component>();
  for (const c of ALL_COMPONENTS) {
    byUrl.set(docUrl(subject.host, c), c);
    byUrl.set(docUrl(alsoServes.host, c), c);
  }
  const text = (p: Project, c: Component) => `${p.name} tokenomics, ${c.toLowerCase().replace(/_/g, " ")}. ${FRAGMENT_OF[c]}.`;
  return createS4WorkExecutor({
    db: ctx.db,
    project: { id: subject.id, name: subject.name, slug: subject.slug, ticker: subject.ticker },
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: { name: "fixture-proposer", async proposeQueries(input) { return [`${input.target.component} of ${subject.name}`]; } },
    searchGateway: {
      name: "fixture-search",
      async search(_q, target) {
        const c = target.component as Component;
        // The other project's page is offered FIRST, every time.
        return [
          { url: docUrl(alsoServes.host, c), title: null, snippet: null },
          { url: docUrl(subject.host, c), title: null, snippet: null },
        ];
      },
    },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        const c = byUrl.get(url);
        if (!c) throw new Error(`fixture fetch: unexpected url ${url}`);
        const owner = url.includes(alsoServes.host) ? alsoServes : subject;
        return fetched(url, text(owner, c));
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        const c = input.target.component as Component;
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

async function researchWith(userId: string, project: Project, executor: ReturnType<typeof crossServingExecutor>): Promise<string> {
  const { jobId } = await newJob(userId, project, "CORE");
  const handled = await handleResearchJobTask(ctx.db, jobId, executor);
  if (!handled.claimed) throw new Error("job not claimed");
  return jobId;
}

// ====================================================================
describe("A. ANOTHER PROJECT'S PAGES CANNOT COMPLETE THIS PROJECT'S PROOF", () => {
  it("A1. with Project A's documents physically reachable and offered first at every step, Project B's research is exactly the research it would have done alone — and every admitted row is B's own host", async () => {
    const projectA = await makeProject(DOCS_HOST_A, { chain: "ethereum", tokenAddress: EVM_A, ticker: "SAME" });
    const projectB = await makeProject(DOCS_HOST_B, { chain: "ethereum", tokenAddress: EVM_B, ticker: "SAME" });

    const alone = await outcomeOf(await research(await makeUser(), projectB));
    const crossServed = await outcomeOf(await researchWith(await makeUser(), projectB, crossServingExecutor(projectB, projectA)));

    // NOT A COMPARISON OF TWO EMPTY RUNS. The isolated research really does
    // establish things; if it ever stops doing so, this test must fail
    // rather than pass vacuously.
    const established = Object.values(alone.componentStatuses).filter((v) => v === "SUPPORTED" || v === "PARTIALLY_SUPPORTED");
    expect(established.length, "the isolated research established nothing; the comparison is vacuous").toBeGreaterThan(0);
    expect(alone.evidenceCount).toBeGreaterThan(0);

    // The answer is the same one.
    expect(crossServed.componentStatuses).toEqual(alone.componentStatuses);
    expect(crossServed.verdict).toBe(alone.verdict);
    expect(crossServed.confidence).toEqual(alone.confidence);
    // Nothing from A's host was ever admitted as B's evidence.
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, crossServed.jobId));
    expect(rows.length).toBeGreaterThan(0);
    const comps = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, crossServed.jobId));
    const admitted = new Set(comps.flatMap((c) => [...(c.supportingEvidenceIds as string[]), ...(c.contradictingEvidenceIds as string[])]));
    for (const r of rows) {
      if (!admitted.has(r.id)) continue;
      expect(r.retrievedUrl, "a row from the other project's host was admitted").toContain(DOCS_HOST_B);
    }
  }, 900_000);

  it("A2. SAME TICKER IS NOT SAME PROJECT, even when the other project's pages say exactly the same words: B's Proof cites no row whose url belongs to A", async () => {
    const projectA = await makeProject(DOCS_HOST_A, { chain: "ethereum", tokenAddress: EVM_A, ticker: "SAME" });
    const projectB = await makeProject(DOCS_HOST_B, { chain: "ethereum", tokenAddress: EVM_B, ticker: "SAME" });
    const jobId = await researchWith(await makeUser(), projectB, crossServingExecutor(projectB, projectA));
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof).toBeDefined();
    const cited = await ctx.db.select().from(evidence).where(and(eq(evidence.researchJobId, jobId), eq(evidence.proofId, proof.id)));
    expect(cited.length, "nothing was cited; the test proves nothing").toBeGreaterThan(0);
    for (const r of cited) expect(r.retrievedUrl, "the Proof cites the other project's page").toContain(DOCS_HOST_B);
    // The attack surface really was reached: the foreign page was offered
    // first at every step and fetched, and not one of its rows was written
    // as this job's Evidence.
    const all = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(all.filter((r) => r.retrievedUrl.includes(DOCS_HOST_A)).length, "a foreign-host row was written as this job's Evidence").toBe(0);
    // A's research is untouched by any of this.
    const aRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    for (const r of aRows) expect(r.researchJobId).toBe(jobId);
  }, 900_000);
});

// ====================================================================
describe("B. MEMORY MAY CARRY AN OBSERVATION, NEVER A VERDICT, AND NEVER ACROSS AN IDENTITY", () => {
  it("B1. Project A's VERIFIED, ACTIVE memory is not adoptable by Project B: B acquires everything fresh, adopts nothing, and lands exactly where it lands with no memory at all", async () => {
    const projectA = await makeProject(DOCS_HOST_A, { chain: "ethereum", tokenAddress: EVM_A, ticker: "AAA" });
    const projectB = await makeProject(DOCS_HOST_B, { chain: "ethereum", tokenAddress: EVM_B, ticker: "BBB" });
    const admin = await makeUser();
    await ctx.db.update(users).set({ role: "ADMIN" }).where(eq(users.id, admin));

    // A does a full research, is verified, and its observations go ACTIVE.
    const jobA = await research(await makeUser(), projectA);
    const [proofA] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobA));
    const verified = await markProofVerified(ctx.db, proofA.id, admin);
    expect(verified.verificationStatus).toBe("VERIFIED");
    const memA = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectA.id));
    expect(memA.length).toBeGreaterThan(0);
    for (const m of memA) await promoteToActive(ctx.db, m.id, admin);

    // B, with Memory ON.
    const controlB = await outcomeOf(await research(await makeUser(), projectB));
    await ctx.db
      .insert(productConfig)
      .values({ key: "memory_enabled", value: true })
      .onConflictDoUpdate({ target: productConfig.key, set: { value: true } });
    const withMemory = await outcomeOf(await research(await makeUser(), projectB));
    await ctx.db
      .insert(productConfig)
      .values({ key: "memory_enabled", value: false })
      .onConflictDoUpdate({ target: productConfig.key, set: { value: false } });

    // Nothing of A's was adopted, and B's answer is its own.
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, withMemory.jobId));
    const memIdsA = new Set(memA.map((m) => m.id));
    for (const r of rows) {
      expect(r.reusedFromMemoryId === null || !memIdsA.has(r.reusedFromMemoryId), "B adopted A's memory").toBe(true);
      expect(r.retrievedUrl).toContain(DOCS_HOST_B);
    }
    expect(withMemory.componentStatuses).toEqual(controlB.componentStatuses);
    expect(withMemory.verdict).toBe(controlB.verdict);
    expect(withMemory.confidence).toEqual(controlB.confidence);
    // A's memory is untouched by B's attempt.
    const memAfter = await ctx.db.select().from(researchMemory).where(eq(researchMemory.projectId, projectA.id));
    expect(memAfter.every((m) => m.lifecycleState === "ACTIVE")).toBe(true);
  }, 1_200_000);

  it("B2. A's VERDICT never reaches B: A's Proof is rewritten to SUPPORTED at maximum confidence and B's research is unmoved", async () => {
    const projectA = await makeProject(DOCS_HOST_A, { chain: "ethereum", tokenAddress: EVM_A, ticker: "AAA" });
    const projectB = await makeProject(DOCS_HOST_B, { chain: "ethereum", tokenAddress: EVM_B, ticker: "BBB" });
    const jobA = await research(await makeUser(), projectA);
    const controlB = await outcomeOf(await research(await makeUser(), projectB));

    await ctx.db.update(proofs).set({ verdict: "SUPPORTED", confidence: 99 }).where(eq(proofs.researchJobId, jobA));
    const afterB = await outcomeOf(await research(await makeUser(), projectB));

    expect(afterB.verdict).toBe(controlB.verdict);
    expect(afterB.confidence).toEqual(controlB.confidence);
    expect(afterB.componentStatuses).toEqual(controlB.componentStatuses);
    expect(afterB.verdict).not.toBe("SUPPORTED");
  }, 900_000);
});

// ====================================================================
describe("C. WHOLE-TABLE CLOSURE AFTER EVERY ATTACK", () => {
  it("C1. no component result anywhere cites another job's evidence, no proof owner has drifted, and every admitted row's url belongs to a route of its own project", async () => {
    const crossed = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM research_component_results c
      CROSS JOIN LATERAL jsonb_array_elements_text(
        (c.supporting_evidence_ids::jsonb) || (c.contradicting_evidence_ids::jsonb)
      ) AS cited(evidence_id)
      JOIN evidence e ON e.id = cited.evidence_id::uuid
      WHERE e.research_job_id <> c.research_job_id
    `);
    expect((crossed.rows as [{ n: number }])[0].n, "a component result cites another job's evidence").toBe(0);

    const drifted = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM proofs p JOIN research_jobs j ON j.id = p.research_job_id
      WHERE p.owner_user_id <> j.user_id OR p.project_id IS DISTINCT FROM j.project_id
    `);
    expect((drifted.rows as [{ n: number }])[0].n, "a Proof's owner or project drifted").toBe(0);

    // Every Proof citation belongs to the job that owns the Proof.
    const foreignCitation = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM evidence e JOIN proofs p ON p.id = e.proof_id
      WHERE e.research_job_id <> p.research_job_id
    `);
    expect((foreignCitation.rows as [{ n: number }])[0].n, "a Proof cites another job's row").toBe(0);
  }, 300_000);
});
