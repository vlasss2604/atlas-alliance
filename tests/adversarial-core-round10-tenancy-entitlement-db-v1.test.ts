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
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { ActiveJobExistsError, createResearchJob, DemoQuotaExceededError } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { loadProofForJob } from "../src/server/services/proof-view";
import { loadSourceSnapshot } from "../src/server/services/source-snapshot";
import { coreEntitlement, demoEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH CORE ADVERSARIAL HARDENING — ROUND 10: AUTHORIZATION, TENANCY
// AND ENTITLEMENT UNDER COMPOSITION.
//
// A different boundary from every round before it. Rounds 1–8 asked whether
// the Proof was right; Round 9 asked whether the page said more than the
// Proof. Round 10 asks WHOSE record it is, and WHEN the right to it was
// decided:
//
//   can one account reach another account's research, at any door
//   can a Proof row's owner ever drift from its job's owner
//   can a lifetime quota be beaten by doing two things at once
//   can one account's idempotency key collide with another's
//   can a later entitlement change destroy, or retroactively enlarge, a
//     Research Job that was already authorized
//   can a job carry another project's evidence
//
// The product rules under attack are the ones written down: entitlement
// decides whether a NEW operation may start and never destroys a
// legitimate Proof; entitlement is enforced server-side; scope and
// entitlement are different things.
//
// Real Postgres, the real worker, the real S4 executor over fixture
// providers, the real loaders the API routes call. No model, no network,
// no RPC, no spend.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST_A = "docs.tenancy-a.example";
const DOCS_HOST_B = "docs.tenancy-b.example";

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
  const slug = uniq("ten");
  const name = `Tenancy ${slug.replace(/_/g, " ")}`;
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

function executorFor(project: Project) {
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
        return fetched(url, text(c));
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

async function research(userId: string, project: Project): Promise<string> {
  const { jobId } = await newJob(userId, project, "CORE");
  const handled = await handleResearchJobTask(ctx.db, jobId, executorFor(project));
  if (!handled.claimed) throw new Error("job not claimed");
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  if (job.state !== "SUCCEEDED") throw new Error(`job ${jobId} state ${job.state}`);
  return jobId;
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
describe("A. TENANCY — every door is the same door", () => {
  it("A1. one account's finished research is unreachable from another account at every loader the API uses, and the refusal is absence rather than a partial answer", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const jobId = await research(owner, project);

    // The owner can read it.
    expect(await ownedJob(jobId, owner)).not.toBeNull();
    const ownProof = await loadProofForJob(ctx.db, jobId, owner);
    expect(ownProof).not.toBeNull();

    // The stranger cannot, at any door.
    expect(await ownedJob(jobId, stranger)).toBeNull();
    expect(await loadProofForJob(ctx.db, jobId, stranger)).toBeNull();

    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(await loadSourceSnapshot(ctx.db, jobId, r.id, stranger), "a stranger read a source snapshot").toBeNull();
    }
    // And nothing partial leaks: the refusal is null, not a trimmed view.
    expect(await loadSourceSnapshot(ctx.db, jobId, rows[0].id, owner)).not.toBeNull();
  }, 180_000);

  it("A2. an evidence id from ANOTHER job cannot be read through a job you do own — the snapshot door checks the pair, not either half", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const projectA = await makeProject(DOCS_HOST_A);
    const projectB = await makeProject(DOCS_HOST_B);
    const mine = await research(owner, projectA);
    const theirs = await research(other, projectB);

    const theirRows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, theirs));
    expect(theirRows.length).toBeGreaterThan(0);
    for (const r of theirRows.slice(0, 3)) {
      // My job id + their evidence id + me.
      expect(await loadSourceSnapshot(ctx.db, mine, r.id, owner), "cross-job evidence served").toBeNull();
      // Their job id + their evidence id + me.
      expect(await loadSourceSnapshot(ctx.db, theirs, r.id, owner), "cross-user snapshot served").toBeNull();
    }
  }, 180_000);

  it("A3. a Proof's owner never drifts from its job's owner, and a Proof is bound to the project its job researched", async () => {
    const owner = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const jobId = await research(owner, project);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof.ownerUserId).toBe(job.userId);
    expect(proof.projectId).toBe(job.projectId);
    // The denormalised owner is what the loader trusts, so it must agree
    // with the job for EVERY proof in the database, not just this one.
    const drifted = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM proofs p JOIN research_jobs j ON j.id = p.research_job_id
      WHERE p.owner_user_id <> j.user_id OR p.project_id IS DISTINCT FROM j.project_id
    `);
    expect((drifted.rows as [{ n: number }])[0].n).toBe(0);
  }, 180_000);

  it("A4. a job carries only its own project's research: no evidence row, component result or proof of one job appears under another", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const projectA = await makeProject(DOCS_HOST_A);
    const projectB = await makeProject(DOCS_HOST_B);
    const jobA = await research(userA, projectA);
    const jobB = await research(userB, projectB);

    const idsA = new Set((await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobA))).map((r) => r.id));
    const idsB = new Set((await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobB))).map((r) => r.id));
    expect(idsA.size).toBeGreaterThan(0);
    expect(idsB.size).toBeGreaterThan(0);
    for (const id of idsA) expect(idsB.has(id)).toBe(false);

    // Each job's component results cite only their own job's rows.
    for (const [jobId, ids] of [[jobA, idsA], [jobB, idsB]] as const) {
      const comps = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
      expect(comps.length).toBeGreaterThan(0);
      for (const c of comps) {
        for (const eid of [...(c.supportingEvidenceIds as string[]), ...(c.contradictingEvidenceIds as string[])]) {
          expect(ids.has(eid), `${jobId} cites a foreign evidence row`).toBe(true);
        }
      }
    }
    // And each job's evidence names only its own project's host.
    for (const [jobId, host] of [[jobA, DOCS_HOST_A], [jobB, DOCS_HOST_B]] as const) {
      const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
      for (const r of rows) expect(r.retrievedUrl, `${jobId} read a foreign host`).toContain(host);
    }
  }, 240_000);
});

// ====================================================================
describe("B. A LIFETIME QUOTA IS NOT BEATABLE BY DOING TWO THINGS AT ONCE", () => {
  it("B1. concurrent DEMO starts for one account cannot outrun the ledger: whatever is admitted, the reservation count never exceeds the limit, and every refusal is one of the two legitimate refusals", async () => {
    const userId = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const LIMIT = 2;

    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => newJob(userId, project, "DEMO")));
    const admitted = attempts.filter((a) => a.status === "fulfilled").length;
    // The single-active-job rule bites first, so at most one start wins a
    // race — but the invariant under test is the ledger, not the count.
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThanOrEqual(LIMIT);
    for (const r of attempts) {
      if (r.status === "fulfilled") continue;
      const reason = (r as PromiseRejectedResult).reason;
      const legitimate = reason instanceof DemoQuotaExceededError || reason instanceof ActiveJobExistsError;
      expect(legitimate, `unexpected refusal: ${String(reason)}`).toBe(true);
    }
    const [{ n }] = (
      await ctx.db.execute(sql`
        SELECT count(*)::int AS n FROM ${demoQuotaReservations}
        WHERE user_id = ${userId} AND state IN ('RESERVED','CONSUMED')
      `)
    ).rows as [{ n: number }];
    expect(n).toBeLessThanOrEqual(LIMIT);
    expect(n).toBe(admitted);
    // One reservation per admitted job, all owned by this account.
    const res = await ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.userId, userId));
    expect(new Set(res.map((r) => r.researchJobId)).size).toBe(res.length);
  }, 180_000);

  it("B1b (FIXED, Founder decision Q1). the lifetime quota now decrements: a completed Research with a durable Proof CONSUMES its slot, and the allowance is exhausted exactly at the limit", async () => {
    const userId = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const LIMIT = 2;

    for (let i = 0; i < LIMIT; i++) {
      const { jobId } = await newJob(userId, project, "DEMO");
      const state = await runToTerminal(jobId, project);
      expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"], `demo job ${i} state`).toContain(state);
      const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
      expect(proof, `demo job ${i} produced no Proof`).toBeDefined();
      // WAS RELEASED before Q1 — this is the line the decision flipped.
      const [res] = await ctx.db
        .select()
        .from(demoQuotaReservations)
        .where(eq(demoQuotaReservations.researchJobId, jobId));
      expect(res.state, `demo job ${i} reservation`).toBe("CONSUMED");
    }

    const [{ n: occupied }] = (
      await ctx.db.execute(sql`
        SELECT count(*)::int AS n FROM ${demoQuotaReservations}
        WHERE user_id = ${userId} AND state IN ('RESERVED','CONSUMED')
      `)
    ).rows as [{ n: number }];
    expect(occupied).toBe(LIMIT);

    // Nothing is active, so only the quota can refuse the next start.
    const active = await ctx.db
      .select({ n: count() })
      .from(researchJobs)
      .where(and(eq(researchJobs.userId, userId), sql`state IN ('QUEUED','RUNNING','AWAITING_CLARIFICATION')`));
    expect(Number(active[0].n)).toBe(0);
    await expect(newJob(userId, project, "DEMO")).rejects.toBeInstanceOf(DemoQuotaExceededError);

    // And CONSUMED is reachable now — the state is no longer dead.
    const all = await ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.userId, userId));
    expect(all.length).toBe(LIMIT);
    expect(all.every((r) => r.state === "CONSUMED")).toBe(true);
  }, 400_000);

  it("B2. what the quota DOES still bind is per account and concurrent: an account with a live reservation cannot open a second one, and another account is unaffected by it", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const project = await makeProject(DOCS_HOST_A);

    // Two live (unfinished) DEMO starts for A would need two slots; the
    // one-active-job rule refuses the second before the quota is reached.
    const first = await newJob(a, project, "DEMO");
    expect(first.created).toBe(true);
    await expect(newJob(a, project, "DEMO")).rejects.toBeInstanceOf(ActiveJobExistsError);
    const [live] = await ctx.db
      .select()
      .from(demoQuotaReservations)
      .where(eq(demoQuotaReservations.researchJobId, first.jobId));
    expect(live.state).toBe("RESERVED");

    // B is untouched by A's live reservation.
    const started = await newJob(b, project, "DEMO");
    expect(started.created).toBe(true);
    const [{ n }] = (
      await ctx.db.execute(sql`SELECT count(*)::int AS n FROM ${demoQuotaReservations} WHERE user_id = ${b}`)
    ).rows as [{ n: number }];
    expect(n).toBe(1);
    // Every reservation is charged to the account that owns its job.
    const mismatched = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM ${demoQuotaReservations} r JOIN research_jobs j ON j.id = r.research_job_id
      WHERE j.user_id <> r.user_id
    `);
    expect((mismatched.rows as [{ n: number }])[0].n).toBe(0);
  }, 300_000);
});

// ====================================================================
describe("C. AN IDEMPOTENCY KEY IS NOT A GLOBAL NAME", () => {
  it("C1. the same key twice for one account returns the same job; the same key for a DIFFERENT account is a different job, and never the first one", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const key = uniq("shared-key");

    const first = await newJob(a, project, "CORE", key);
    expect(first.created).toBe(true);
    const again = await newJob(a, project, "CORE", key);
    expect(again.created).toBe(false);
    expect(again.jobId).toBe(first.jobId);

    const other = await newJob(b, project, "CORE", key);
    expect(other.created).toBe(true);
    expect(other.jobId).not.toBe(first.jobId);
    // And each job belongs to the account that created it.
    expect((await ownedJob(first.jobId, a))?.userId).toBe(a);
    expect(await ownedJob(first.jobId, b)).toBeNull();
    expect((await ownedJob(other.jobId, b))?.userId).toBe(b);
    expect(await ownedJob(other.jobId, a)).toBeNull();
  }, 180_000);
});

// ====================================================================
describe("D. ENTITLEMENT DECIDES WHAT MAY START, AND NEVER REWRITES WHAT FINISHED", () => {
  it("D1. a CORE job that finished stays readable, and keeps its own recorded entitlement, after the account is downgraded to DEMO", async () => {
    const userId = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const jobId = await research(userId, project);
    const [before] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(before.entitlementAtStart).toBe("ARI_CORE");
    const proofBefore = await loadProofForJob(ctx.db, jobId, userId);
    expect(proofBefore).not.toBeNull();

    // The downgrade. Entitlement is not a column on the job — the job froze
    // what it started under — so a downgrade is a change to the ACCOUNT and
    // must leave the finished record exactly where it is.
    await ctx.db.insert(demoQuotaReservations).values({ userId, researchJobId: jobId }).onConflictDoNothing();

    const [after] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(after.state).toBe("SUCCEEDED");
    expect(after.entitlementAtStart).toBe("ARI_CORE");
    expect(after.capabilityAtStart).toBe(before.capabilityAtStart);
    const proofAfter = await loadProofForJob(ctx.db, jobId, userId);
    expect(proofAfter).not.toBeNull();
    expect(proofAfter!.verdict).toBe(proofBefore!.verdict);
    expect(proofAfter!.confidence).toEqual(proofBefore!.confidence);
    // The Proof is still the owner's, and still nobody else's.
    const stranger = await makeUser();
    expect(await loadProofForJob(ctx.db, jobId, stranger)).toBeNull();
  }, 180_000);

  it("D2. a job's recorded entitlement is frozen at start: a DEMO job stays a DEMO job however the account changes afterwards, and an upgrade grants it nothing retroactively", async () => {
    const userId = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const { jobId } = await newJob(userId, project, "DEMO");
    const [demoJob] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(demoJob.entitlementAtStart).toBe("DEMO");
    const demoBudget = JSON.stringify(demoJob.budgetAtStart);
    // One active job per account: the DEMO job must end before the next
    // start, which is also what makes the "frozen at start" check honest.
    await runToTerminal(jobId, project);

    // The account is upgraded — a later CORE start proves it.
    const { jobId: coreJobId } = await newJob(userId, project, "CORE");
    const [coreJob] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, coreJobId));
    expect(coreJob.entitlementAtStart).toBe("ARI_CORE");

    // The earlier job is untouched by it.
    const [stillDemo] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(stillDemo.entitlementAtStart).toBe("DEMO");
    expect(JSON.stringify(stillDemo.budgetAtStart)).toBe(demoBudget);
    expect(JSON.stringify(stillDemo.budgetAtStart)).not.toBe(JSON.stringify(coreJob.budgetAtStart));
  }, 180_000);

  it("D3. the DEMO reservation ledger tracks the job it was taken for, and one account's exhausted quota never blocks, frees or consumes another's", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const project = await makeProject(DOCS_HOST_A);
    const j1 = await newJob(a, project, "DEMO");
    await runToTerminal(j1.jobId, project);
    const j2 = await newJob(a, project, "DEMO");
    const resA = await ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.userId, a));
    expect(new Set(resA.map((r) => r.researchJobId))).toEqual(new Set([j1.jobId, j2.jobId]));
    // One finished with a Proof, one still live — the ledger distinguishes
    // them, and the finished one has SPENT its slot (Founder decision Q1).
    expect(new Set(resA.map((r) => r.state))).toEqual(new Set(["CONSUMED", "RESERVED"]));
    for (const r of resA) expect(r.userId).toBe(a);

    const [{ n: nb }] = (
      await ctx.db.execute(sql`SELECT count(*)::int AS n FROM ${demoQuotaReservations} WHERE user_id = ${b}`)
    ).rows as [{ n: number }];
    expect(nb).toBe(0);
    // And every reservation in the table points at a job owned by the same
    // account it is charged to.
    const mismatched = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM ${demoQuotaReservations} r JOIN research_jobs j ON j.id = r.research_job_id
      WHERE j.user_id <> r.user_id
    `);
    expect((mismatched.rows as [{ n: number }])[0].n).toBe(0);
  }, 300_000);
});

// ====================================================================
describe("E. THE WHOLE TABLE — invariants over every row this round created", () => {
  it("E1. no orphan and no crossed owner anywhere: every proof, component result and evidence row belongs to a job, and every job to an account", async () => {
    const orphanProofs = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM proofs p LEFT JOIN research_jobs j ON j.id = p.research_job_id WHERE j.id IS NULL
    `);
    expect((orphanProofs.rows as [{ n: number }])[0].n).toBe(0);

    const orphanEvidence = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM evidence e LEFT JOIN research_jobs j ON j.id = e.research_job_id WHERE j.id IS NULL
    `);
    expect((orphanEvidence.rows as [{ n: number }])[0].n).toBe(0);

    const orphanComponents = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM research_component_results c LEFT JOIN research_jobs j ON j.id = c.research_job_id WHERE j.id IS NULL
    `);
    expect((orphanComponents.rows as [{ n: number }])[0].n).toBe(0);

    const [{ n: jobs }] = (await ctx.db.select({ n: count() }).from(researchJobs)) as [{ n: number }];
    expect(Number(jobs)).toBeGreaterThan(0);
    const ownerless = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM research_jobs j LEFT JOIN users u ON u.id = j.user_id WHERE u.id IS NULL
    `);
    expect((ownerless.rows as [{ n: number }])[0].n).toBe(0);
  }, 120_000);

  it("E2. a component result never cites an evidence row from a different job — asserted across the whole table, not one fixture", async () => {
    const crossed = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM research_component_results c
      CROSS JOIN LATERAL jsonb_array_elements_text(
        (c.supporting_evidence_ids::jsonb) || (c.contradicting_evidence_ids::jsonb)
      ) AS cited(evidence_id)
      JOIN evidence e ON e.id = cited.evidence_id::uuid
      WHERE e.research_job_id <> c.research_job_id
    `);
    expect((crossed.rows as [{ n: number }])[0].n).toBe(0);
  }, 120_000);
});
