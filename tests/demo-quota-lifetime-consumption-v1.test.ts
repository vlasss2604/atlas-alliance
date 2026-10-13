import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  demoQuotaReservations,
  interpretations,
  projects,
  proofs,
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
import {
  ActiveJobExistsError,
  createResearchJob,
  DemoQuotaExceededError,
  demoTerminalOutcome,
  resolveDemoReservation,
  resolveDemoReservationForTerminal,
  transitionJobState,
} from "../src/server/jobs/research-jobs";
import { finishPhasedJob } from "../src/server/jobs/acquisition-phase-worker";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, demoEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// FOUNDER DECISION Q1 — WHAT SPENDS A DEMO LIFETIME SLOT.
//
//   PROJECT REALITY / RESEARCH VERDICT consumes quota.
//   TECHNICAL FAILURE does not.
//
// A slot is CONSUMED when the Research completed AND produced a durable
// Proof. The verdict does not enter into it: INSUFFICIENT_EVIDENCE and
// NOT_ESTABLISHED are legitimate ATLAS outcomes — ATLAS did the work and
// returned a bounded conclusion — so a question that ends in insufficient
// evidence is not free research. A FAILED job, a cancellation, a crash
// before the Proof, or a completion that produced no Proof, all return
// the slot.
//
// Before this round no path anywhere passed CONSUMED: every terminal
// released, so the lifetime limit bounded only concurrency. Pinned in
// round10 B1b, which this round flips.
//
// Real Postgres, the real worker, the real lifecycle functions. No model,
// no network, no RPC, no spend.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const DOCS_HOST = "docs.demoquota.example";
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

// Four evidence worlds, chosen so the Proof lands on a different verdict
// in each. The quota rule must not notice the difference.
const WORLDS = {
  // Everything documented end to end.
  full: {
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
  },
  // A recipient that positively refutes the holder question.
  treasury: {
    SOURCE_OF_VALUE: "swap fees charged on every trade are the only source of protocol revenue",
    FLOW_PATH: "collected swap fees are forwarded from the router to the allocation contract",
    MECHANISM_SPEC: "each epoch the allocation contract distributes half of the collected fees",
    DESTINATION: "fees are sent to the protocol treasury",
    RECIPIENT: "the treasury receives the collected fees",
  },
  // Almost nothing: the bounded "we could not establish it" outcome.
  sparse: {
    SOURCE_OF_VALUE: "the protocol earns money somehow",
  },
} as const;
type World = keyof typeof WORLDS;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

const docUrl = (c: Component) => `https://${DOCS_HOST}/docs/${c.toLowerCase().replace(/_/g, "-")}`;
const componentOfUrl = (url: string) => ALL_COMPONENTS.find((c) => docUrl(c) === url) ?? null;

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}
async function makeUser(): Promise<string> {
  const [u] = await ctx.db.insert(users).values({}).returning();
  return u.id;
}
interface Project {
  id: string;
  slug: string;
  name: string;
  ticker: string | null;
}
async function makeProject(): Promise<Project> {
  const slug = uniq("quota");
  const [p] = await ctx.db.insert(projects).values({ slug, name: `Quota ${slug}`, status: "ACTIVE_CORE" }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: DOCS_HOST, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const cls = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!cls.ok) throw new Error("docs classify failed: " + cls.refusal);
  return { id: p.id, slug, name: p.name, ticker: p.ticker ?? null };
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

// `failFetch` makes every acquisition raise a provider error, which is how
// a job reaches FAILED / SYSTEM_OR_PROVIDER_FAILURE without a Proof.
function executorFor(project: Project, world: World, opts: { failFetch?: boolean } = {}) {
  const fragments = WORLDS[world] as Partial<Record<Component, string>>;
  const text = (c: Component) => `${project.name}, ${c.toLowerCase().replace(/_/g, " ")}. ${fragments[c] ?? ""}`;
  return createS4WorkExecutor({
    db: ctx.db,
    project,
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: { name: "fixture-proposer", async proposeQueries(input) { return [`${input.target.component} of ${project.name}`]; } },
    searchGateway: {
      name: "fixture-search",
      async search(_q, target) {
        const c = target.component as Component;
        return fragments[c] ? [{ url: docUrl(c), title: null, snippet: null }] : [];
      },
    },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        if (opts.failFetch) throw new ContentFetchError("HTTP_ERROR", "fixture: provider down", url, 503);
        const c = componentOfUrl(url);
        if (!c) throw new ContentFetchError("HTTP_ERROR", "fixture: unknown url", url, 404);
        return fetched(url, text(c));
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        const c = input.target.component as Component;
        const fragment = fragments[c];
        if (!fragment || !input.document.normalizedText.includes(fragment)) return [];
        const fact: ExtractedFact = {
          step: input.target.step,
          component: c,
          statement: `${c.toLowerCase().replace(/_/g, " ")}: ${fragment}`,
          supportFragment: fragment,
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

const INTENT_OF: Record<World, string> = {
  full: "PASSIVE_HOLDER_OUTCOME",
  treasury: "PASSIVE_HOLDER_OUTCOME",
  sparse: "PROTOCOL_REVENUE_TO_TOKEN",
};

async function startDemoJob(userId: string, project: Project, world: World, limit = 1) {
  const question = "does revenue reach the token?";
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId,
      topicId: await activeTopicId(),
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: demoEntitlement(),
      demoLifetimeProofLimit: limit,
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
      normalized_intent: INTENT_OF[world],
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  return job.id;
}

async function reservationOf(jobId: string) {
  const [r] = await ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.researchJobId, jobId));
  return r ?? null;
}
async function occupiedSlots(userId: string): Promise<number> {
  const [{ n }] = (
    await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM ${demoQuotaReservations}
      WHERE user_id = ${userId} AND state IN ('RESERVED','CONSUMED')
    `)
  ).rows as [{ n: number }];
  return n;
}
async function runDemo(userId: string, project: Project, world: World, opts: { failFetch?: boolean; limit?: number } = {}) {
  const jobId = await startDemoJob(userId, project, world, opts.limit ?? 1);
  await handleResearchJobTask(ctx.db, jobId, executorFor(project, world, opts));
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  return { jobId, state: job.state, proof: proof ?? null, reservation: await reservationOf(jobId) };
}

// ====================================================================
describe("A. A COMPLETED RESEARCH WITH A DURABLE PROOF SPENDS THE SLOT, WHATEVER THE VERDICT", () => {
  it("A1. every evidence world that finishes with a durable Proof consumes the reservation exactly once", async () => {
    const project = await makeProject();
    for (const world of ["full", "treasury", "sparse"] as const) {
      const userId = await makeUser();
      const r = await runDemo(userId, project, world);
      expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"], `${world} state`).toContain(r.state);
      expect(r.proof, `${world} produced no Proof`).not.toBeNull();
      expect(r.reservation!.state, `${world} reservation`).toBe("CONSUMED");
      expect(r.reservation!.resolvedAt, `${world} resolvedAt`).not.toBeNull();
      expect(await occupiedSlots(userId), `${world} occupied`).toBe(1);
    }
  }, 400_000);

  it("A1b. THE RULE IS VERDICT-BLIND. Over a real DEMO job and its real persisted Proof, every legitimate verdict consumes the slot — SUPPORTED, PARTIALLY_SUPPORTED, CONTRADICTED, NOT_SUPPORTED and INSUFFICIENT_EVIDENCE alike", async () => {
    // Under DEMO the capability ceiling (TARGETED_REFRESH) leaves no
    // eligible work in this fixture, so every end-to-end DEMO run lands on
    // one verdict. Verdict-blindness is therefore exercised where the rule
    // actually reads it: against the persisted Proof row of a real job.
    const project = await makeProject();
    // The Proof verdict vocabulary, in full. A refutation is NOT_SUPPORTED
    // at Proof level — CONTRADICTED is a COMPONENT/requirement status, not
    // a verdict — so the Founder's "CONTRADICTED consumes" is this row.
    const VERDICTS = ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE", "NOT_APPLICABLE"] as const;
    for (const verdict of VERDICTS) {
      const userId = await makeUser();
      const r = await runDemo(userId, project, "full");
      expect(r.proof).not.toBeNull();
      await ctx.db.update(proofs).set({ verdict }).where(eq(proofs.id, r.proof!.id));
      const [reread] = await ctx.db.select().from(proofs).where(eq(proofs.id, r.proof!.id));
      expect(reread.verdict, verdict).toBe(verdict);
      // The decision, asked again with this verdict in place.
      expect(await demoTerminalOutcome(ctx.db, r.jobId, "SUCCEEDED"), verdict).toBe("CONSUMED");
      // And the slot this run actually spent is still spent.
      expect((await reservationOf(r.jobId))!.state, verdict).toBe("CONSUMED");
      expect(await occupiedSlots(userId), verdict).toBe(1);
    }
  }, 600_000);

  it("A2. the decision function itself is verdict-blind and state-aware: it consumes for every proof-bearing terminal state and releases for every technical one", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const r = await runDemo(userId, project, "full");
    expect(r.proof).not.toBeNull();
    for (const state of ["SUCCEEDED", "BUDGET_LIMIT_REACHED"]) {
      expect(await demoTerminalOutcome(ctx.db, r.jobId, state), state).toBe("CONSUMED");
    }
    for (const state of ["FAILED", "CANCELLED", "QUEUED", "RUNNING"]) {
      expect(await demoTerminalOutcome(ctx.db, r.jobId, state), state).toBe("RELEASED");
    }
    // A completion that produced no Proof never consumes, even SUCCEEDED.
    const proofless = await makeUser();
    const jobId = await startDemoJob(proofless, project, "full");
    expect(await demoTerminalOutcome(ctx.db, jobId, "SUCCEEDED"), "no proof yet").toBe("RELEASED");
  }, 300_000);
});

// ====================================================================
describe("B. TECHNICAL FAILURE DOES NOT SPEND THE SLOT", () => {
  it("B1. a technical terminal with no Proof releases the reservation and leaves the lifetime allowance whole — driven through the real terminal writer the phased worker uses", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const jobId = await startDemoJob(userId, project, "full");
    expect((await reservationOf(jobId))!.state).toBe("RESERVED");
    await ctx.db.update(researchJobs).set({ state: "RUNNING", startedAt: sql`now()` }).where(eq(researchJobs.id, jobId));

    await finishPhasedJob(
      ctx.db,
      jobId,
      { state: "FAILED", terminationReason: "SYSTEM_OR_PROVIDER_FAILURE", errorCode: "ProviderError" },
      "DEMO",
      "test: provider failure before any Proof",
    );

    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.state).toBe("FAILED");
    const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
    expect(proof, "a failed job produced a Proof").toBeUndefined();
    expect((await reservationOf(jobId))!.state).toBe("RELEASED");
    expect(await occupiedSlots(userId)).toBe(0);
    // The allowance really is intact.
    expect(await startDemoJob(userId, project, "full")).toBeTruthy();
  }, 300_000);

  it("B1b (BOUNDARY, pinned). a DOCUMENT-LOCAL provider failure is not a technical failure of the Research: the run still finalises with a bounded Proof, so it DOES spend the slot — which is the decision's own rule, since INSUFFICIENT_EVIDENCE is a legitimate outcome and the work was done", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const r = await runDemo(userId, project, "full", { failFetch: true });
    expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED"]).toContain(r.state);
    expect(r.proof, "bounded research did not finalise").not.toBeNull();
    expect(r.reservation!.state).toBe("CONSUMED");
  }, 300_000);

  it("B2. a cancellation before any Proof releases the reservation", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const jobId = await startDemoJob(userId, project, "full");
    expect((await reservationOf(jobId))!.state).toBe("RESERVED");
    await ctx.db.transaction(async (tx) => {
      await transitionJobState(tx, jobId, "CANCELLED", "test: cancelled before any proof");
      await resolveDemoReservationForTerminal(tx, jobId, "CANCELLED");
    });
    expect((await reservationOf(jobId))!.state).toBe("RELEASED");
    expect(await occupiedSlots(userId)).toBe(0);
  }, 180_000);
});

// ====================================================================
describe("C. EXACTLY ONCE, UNDER REPLAY AND UNDER RACE", () => {
  it("C1. duplicate terminal handling produces exactly one CONSUMED transition, and a later RELEASED cannot hand a spent slot back", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const r = await runDemo(userId, project, "full");
    expect(r.reservation!.state).toBe("CONSUMED");
    const firstResolvedAt = r.reservation!.resolvedAt;

    // Worker replay: the same terminal handled again.
    await resolveDemoReservationForTerminal(ctx.db, r.jobId, "SUCCEEDED");
    // A stale failure path arriving late, which the DB trigger would
    // otherwise refuse with an exception.
    await resolveDemoReservation(ctx.db, r.jobId, "RELEASED");
    await resolveDemoReservationForTerminal(ctx.db, r.jobId, "FAILED");

    const after = await reservationOf(r.jobId);
    expect(after!.state, "a spent slot was handed back").toBe("CONSUMED");
    expect(after!.resolvedAt).toEqual(firstResolvedAt);
    expect(await occupiedSlots(userId)).toBe(1);
  }, 300_000);

  it("C2. concurrent terminal processing cannot consume twice, reopen the allowance, or leave a completed Proof RESERVED", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const r = await runDemo(userId, project, "full");

    await Promise.all([
      resolveDemoReservationForTerminal(ctx.db, r.jobId, "SUCCEEDED"),
      resolveDemoReservationForTerminal(ctx.db, r.jobId, "SUCCEEDED"),
      resolveDemoReservation(ctx.db, r.jobId, "RELEASED"),
      resolveDemoReservationForTerminal(ctx.db, r.jobId, "FAILED"),
    ]);

    const rows = await ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.researchJobId, r.jobId));
    expect(rows.length, "an extra reservation row appeared").toBe(1);
    expect(rows[0].state).toBe("CONSUMED");
    expect(await occupiedSlots(userId)).toBe(1);
    // No completed Proof is left RESERVED anywhere.
    const stranded = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM ${demoQuotaReservations} r
      JOIN research_jobs j ON j.id = r.research_job_id
      JOIN proofs p ON p.research_job_id = j.id
      WHERE r.state = 'RESERVED' AND j.state IN ('SUCCEEDED','BUDGET_LIMIT_REACHED')
    `);
    expect((stranded.rows as [{ n: number }])[0].n).toBe(0);
  }, 300_000);
});

// ====================================================================
describe("D. THE LIFETIME LIMIT NOW BINDS", () => {
  it("D1 (flips round10 B1b). after the lifetime allowance is consumed, the next DEMO start is refused by the quota — with no job active, so it can only be the quota refusing", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const LIMIT = 2;
    for (let i = 0; i < LIMIT; i++) {
      const r = await runDemo(userId, project, "full", { limit: LIMIT });
      expect(r.reservation!.state, `run ${i}`).toBe("CONSUMED");
    }
    expect(await occupiedSlots(userId)).toBe(LIMIT);

    const active = await ctx.db
      .select({ n: count() })
      .from(researchJobs)
      .where(and(eq(researchJobs.userId, userId), sql`state IN ('QUEUED','RUNNING','AWAITING_CLARIFICATION')`));
    expect(Number(active[0].n), "a job was still active").toBe(0);

    await expect(startDemoJob(userId, project, "full", LIMIT)).rejects.toBeInstanceOf(DemoQuotaExceededError);
    // And it stays refused.
    await expect(startDemoJob(userId, project, "full", LIMIT)).rejects.toBeInstanceOf(DemoQuotaExceededError);
  }, 500_000);

  it("D2. a released slot is genuinely reusable: a technical failure does not count against the allowance that a later completed Proof then spends", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const failedJob = await startDemoJob(userId, project, "full", 1);
    await ctx.db.update(researchJobs).set({ state: "RUNNING", startedAt: sql`now()` }).where(eq(researchJobs.id, failedJob));
    await finishPhasedJob(
      ctx.db,
      failedJob,
      { state: "FAILED", terminationReason: "SYSTEM_OR_PROVIDER_FAILURE", errorCode: "ProviderError" },
      "DEMO",
      "test: provider failure",
    );
    expect((await reservationOf(failedJob))!.state).toBe("RELEASED");
    expect(await occupiedSlots(userId)).toBe(0);

    const ok = await runDemo(userId, project, "full", { limit: 1 });
    expect(ok.reservation!.state).toBe("CONSUMED");
    expect(await occupiedSlots(userId)).toBe(1);
    await expect(startDemoJob(userId, project, "full", 1)).rejects.toBeInstanceOf(DemoQuotaExceededError);
  }, 400_000);

  it("D3. account isolation: one account's consumed lifetime quota leaves another account's allowance whole", async () => {
    const project = await makeProject();
    const a = await makeUser();
    const b = await makeUser();
    const ra = await runDemo(a, project, "full", { limit: 1 });
    expect(ra.reservation!.state).toBe("CONSUMED");
    await expect(startDemoJob(a, project, "full", 1)).rejects.toBeInstanceOf(DemoQuotaExceededError);

    const rb = await runDemo(b, project, "full", { limit: 1 });
    expect(rb.reservation!.state).toBe("CONSUMED");
    expect(await occupiedSlots(a)).toBe(1);
    expect(await occupiedSlots(b)).toBe(1);
    // Every reservation is still charged to the account that owns its job.
    const mismatched = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM ${demoQuotaReservations} r JOIN research_jobs j ON j.id = r.research_job_id
      WHERE j.user_id <> r.user_id
    `);
    expect((mismatched.rows as [{ n: number }])[0].n).toBe(0);
  }, 400_000);
});

// ====================================================================
describe("E. NOTHING ELSE MOVED", () => {
  it("E1. a paid entitlement takes no reservation at all and is bounded by nothing here, however many Proofs it produces", async () => {
    const project = await makeProject();
    const userId = await makeUser();
    const question = "does revenue reach the token?";
    for (let i = 0; i < 3; i++) {
      const { job } = await createResearchJob(
        ctx.db,
        ctx.boss,
        {
          userId,
          topicId: await activeTopicId(),
          projectId: project.id,
          originalQuestion: question,
          normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
          normalizedTaskHash: uniq("hash"),
          idempotencyKey: uniq("idem"),
          entitlement: coreEntitlement(),
          demoLifetimeProofLimit: 1,
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
      await handleResearchJobTask(ctx.db, job.id, executorFor(project, "full"));
      const [done] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, job.id));
      expect(done.state, `core run ${i}`).toBe("SUCCEEDED");
      expect(await reservationOf(job.id), `core run ${i} took a DEMO slot`).toBeNull();
    }
    const [{ n }] = (
      await ctx.db.execute(sql`SELECT count(*)::int AS n FROM ${demoQuotaReservations} WHERE user_id = ${userId}`)
    ).rows as [{ n: number }];
    expect(n).toBe(0);
  }, 500_000);

  it("E2. idempotency is unchanged: the same key twice for one account is one job and one reservation, and a second account's identical key is its own", async () => {
    const project = await makeProject();
    const a = await makeUser();
    const b = await makeUser();
    const key = uniq("shared");
    const question = "does revenue reach the token?";
    const start = async (userId: string) =>
      createResearchJob(
        ctx.db,
        ctx.boss,
        {
          userId,
          topicId: await activeTopicId(),
          projectId: project.id,
          originalQuestion: question,
          normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
          normalizedTaskHash: uniq("hash"),
          idempotencyKey: key,
          entitlement: demoEntitlement(),
          demoLifetimeProofLimit: 2,
        },
        { skipEnqueue: true },
      );
    const first = await start(a);
    expect(first.created).toBe(true);
    const repeat = await start(a);
    expect(repeat.created).toBe(false);
    expect(repeat.job.id).toBe(first.job.id);
    // One job, one reservation — a repeat never took a second slot.
    const resA = await ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.userId, a));
    expect(resA.length).toBe(1);

    const other = await start(b);
    expect(other.created).toBe(true);
    expect(other.job.id).not.toBe(first.job.id);
    // A's live job blocks A's second start for the active-job reason, not
    // a quota one — unchanged behaviour.
    await expect(startDemoJob(a, project, "full", 2)).rejects.toBeInstanceOf(ActiveJobExistsError);
  }, 300_000);
});
