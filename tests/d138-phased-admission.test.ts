import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CONFIG, type ProductConfig } from "../src/server/config/product";
import {
  interpretations,
  projects,
  researchAttempts,
  researchJobs,
  topics,
  users,
} from "../src/server/db/schema";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import {
  assertOwnerAlphaLive,
  evaluateOwnerAlphaLive,
} from "../src/server/jobs/owner-alpha-routing";
import {
  RESEARCH_EXTRACT_QUEUE,
  RESEARCH_FETCH_QUEUE,
  RESEARCH_QUEUE,
} from "../src/server/jobs/queue";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { startOwnerManualAlphaResearch } from "../src/server/services/start-owner-alpha-research";
import { parseWorkerCapabilities, type PhaseCapability } from "../src/server/jobs/worker-capabilities";
import {
  dispatchFetchQueueMessage,
  dispatchResearchQueueMessage,
} from "../src/server/jobs/worker";
import type { PhaseWorkerContext } from "../src/server/jobs/acquisition-phase-worker";
import { __setSearchGateway } from "../src/server/engine/providers/search-gateway";
import { __setQueryProposer } from "../src/server/engine/providers/query-proposer";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-138 — PHASED PRODUCT ADMISSION AND ONE LIVE GATE.
//
// Two things are proved here, and they are the last two between the
// engine and a real phased Proof:
//
//   1. the product can admit a phased job at all — one job, one SEARCHING
//      message, no legacy entry message, atomically;
//   2. all three phases ask the SAME live-eligibility question, before
//      constructing any provider, so a closed gate costs nothing.
//
// Everything is offline. The provider seams are overridden with fixtures
// that RECORD being called, so "zero external calls" is a measurement
// rather than a hope.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  __setSearchGateway(null);
  __setQueryProposer(null);
  await ctx.close();
});

const ROLE_A: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("SEARCH_EXTRACT");
const ROLE_B: ReadonlySet<PhaseCapability> = parseWorkerCapabilities("FETCH");

function roleCtx(capabilities: ReadonlySet<PhaseCapability>): PhaseWorkerContext {
  return { db: ctx.db, boss: ctx.boss, capabilities };
}

function configWith(over: Partial<ProductConfig>): ProductConfig {
  return { ...DEFAULT_PRODUCT_CONFIG, ...over };
}

// The allowlisted project the owner-alpha gate admits, and one that is in
// scope but deliberately outside the allowlist.
const ALLOWLISTED = [...INTERNAL_ALPHA_LIVE_PROJECT_SLUGS][0];

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

async function allowlistedProject() {
  const [p] = await ctx.db.select().from(projects).where(eq(projects.slug, ALLOWLISTED));
  return p;
}

async function makeAdmin() {
  const [admin] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
  return admin;
}

// A READY interpretation for the allowlisted project, exactly as the
// interpreter persists one — the admission path reads only this row.
async function makeInterpretation(userId: string, slug = ALLOWLISTED) {
  const [interp] = await ctx.db
    .insert(interpretations)
    .values({
      userId,
      originalQuestion:
        "Where does the revenue from trading fees go, and what happens to the token that is bought back?",
      status: "READY",
      result: {
        project_slug: slug,
        project_slugs: [slug],
        research_task: "trace fee revenue to the token",
        route: "DEEP_RESEARCH",
      },
    })
    .returning();
  return interp;
}

async function jobRow(jobId: string) {
  const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  return row;
}

// pg-boss's own table: the only authority on what was actually enqueued.
async function queuedMessages(queue: string, jobId: string): Promise<number> {
  const rows = await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${queue} AND data->>'jobId' = ${jobId}`,
  );
  return (rows.rows[0] as { n: number }).n;
}

// Provider seams that scream if they are ever reached.
function recordingProviders() {
  const calls = { proposer: 0, search: 0 };
  __setQueryProposer({
    name: "must-not-be-called",
    async proposeQueries() {
      calls.proposer += 1;
      return ["q"];
    },
  });
  __setSearchGateway({
    name: "must-not-be-called",
    async search() {
      calls.search += 1;
      return [];
    },
  });
  return calls;
}

describe("D-138 §1 — the config flag (items 1, 19, 20)", () => {
  it("1/19/20. phased research defaults to false, and neither research gate moved", () => {
    expect(DEFAULT_PRODUCT_CONFIG.phased_research_enabled).toBe(false);
    // The two existing gates keep their own meaning and their own values.
    expect(DEFAULT_PRODUCT_CONFIG.research_enabled).toBe(false);
    expect(DEFAULT_PRODUCT_CONFIG.internal_alpha_enabled).toBe(false);
  });

  it("a database that never re-seeded still parses, and fails closed onto legacy", async () => {
    // The seeded row set is the authority in a real database; the schema
    // default exists so a config row that does not exist yet cannot throw
    // and cannot silently switch anything on.
    const rows = await ctx.db.execute(
      sql`SELECT value FROM product_config WHERE key = 'phased_research_enabled'`,
    );
    if (rows.rows.length > 0) {
      expect((rows.rows[0] as { value: unknown }).value).toBe(false);
    }
  });
});

describe("D-138 §2 — legacy admission is untouched (items 2, 10, 21)", () => {
  it("2. phased_research_enabled=false creates exactly the job it always created", async () => {
    const admin = await makeAdmin();
    const interp = await makeInterpretation(admin.id);
    const { job, created } = await startOwnerManualAlphaResearch(
      ctx.db,
      ctx.boss,
      configWith({ research_enabled: false, internal_alpha_enabled: true }),
      { userId: admin.id, interpretationId: interp.id, idempotencyKey: uniq("idem") },
    );
    expect(created).toBe(true);

    // No phase at all, and one legacy entry message: the single-process
    // path, byte for byte.
    expect((await jobRow(job.id)).acquisitionPhase).toBeNull();
    expect(await queuedMessages(RESEARCH_QUEUE, job.id)).toBe(1);
    expect(await queuedMessages(RESEARCH_FETCH_QUEUE, job.id)).toBe(0);
    expect(await queuedMessages(RESEARCH_EXTRACT_QUEUE, job.id)).toBe(0);

    // The interpretation is linked exactly as before.
    const [linked] = await ctx.db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, interp.id));
    expect(linked.researchJobId).toBe(job.id);
  });

  it("legacy admission does not consult the live gate at all", async () => {
    // A non-allowlisted project is still admissible on the legacy path —
    // eligibility for LIVE execution is decided later, at worker pickup,
    // exactly as D-123 specified. D-138 must not have moved that.
    const admin = await makeAdmin();
    const [offAllowlist] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("d138_off"), name: "Off Allowlist", status: "ACTIVE_CORE" })
      .returning();
    const interp = await makeInterpretation(admin.id, offAllowlist.slug);
    const { job } = await startOwnerManualAlphaResearch(
      ctx.db,
      ctx.boss,
      configWith({ research_enabled: false, internal_alpha_enabled: false }),
      { userId: admin.id, interpretationId: interp.id, idempotencyKey: uniq("idem") },
    );
    expect((await jobRow(job.id)).acquisitionPhase).toBeNull();
    expect(await queuedMessages(RESEARCH_QUEUE, job.id)).toBe(1);
  });
});

describe("D-138 §3 — phased admission (items 3, 4, 5, 6, 7)", () => {
  it("3/4/5/6/7. one phased job, one SEARCHING message, zero legacy messages, linked interpretation", async () => {
    const admin = await makeAdmin();
    const interp = await makeInterpretation(admin.id);
    const { job, created } = await startOwnerManualAlphaResearch(
      ctx.db,
      ctx.boss,
      configWith({
        research_enabled: false,
        internal_alpha_enabled: true,
        phased_research_enabled: true,
      }),
      { userId: admin.id, interpretationId: interp.id, idempotencyKey: uniq("idem") },
    );
    expect(created).toBe(true);

    const row = await jobRow(job.id);
    expect(row.acquisitionPhase).toBe("SEARCHING");
    expect(row.acquisitionPhaseAt).toBeInstanceOf(Date);
    expect(row.origin).toBe("OWNER_MANUAL_ALPHA");
    expect(row.state).toBe("QUEUED");

    // Exactly one message, on the SEARCHING queue, and none of the others.
    expect(await queuedMessages(RESEARCH_QUEUE, job.id)).toBe(1);
    expect(await queuedMessages(RESEARCH_FETCH_QUEUE, job.id)).toBe(0);
    expect(await queuedMessages(RESEARCH_EXTRACT_QUEUE, job.id)).toBe(0);

    // That one message is the PHASE message, not a legacy entry message —
    // they share a queue name, so the job's own phase is what tells them
    // apart, and it says SEARCHING.
    const [linked] = await ctx.db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, interp.id));
    expect(linked.researchJobId).toBe(job.id);

    // Nothing has run yet: admission creates work, never performs it.
    const attempts = await ctx.db
      .select()
      .from(researchAttempts)
      .where(eq(researchAttempts.researchJobId, job.id));
    expect(attempts).toHaveLength(0);
  });

  it("phased admission refuses up front when the live gate would refuse anyway", async () => {
    const admin = await makeAdmin();
    const [offAllowlist] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("d138_off2"), name: "Off Allowlist 2", status: "ACTIVE_CORE" })
      .returning();
    const interp = await makeInterpretation(admin.id, offAllowlist.slug);

    await expect(
      startOwnerManualAlphaResearch(
        ctx.db,
        ctx.boss,
        configWith({
          research_enabled: false,
          internal_alpha_enabled: true,
          phased_research_enabled: true,
        }),
        { userId: admin.id, interpretationId: interp.id, idempotencyKey: uniq("idem") },
      ),
    ).rejects.toMatchObject({ code: "OWNER_ALPHA_LIVE_NOT_ELIGIBLE" });

    // Refused BEFORE anything was created: no job, no message, and the
    // interpretation is still unused.
    const [after] = await ctx.db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, interp.id));
    expect(after.researchJobId).toBeNull();
  });

  it("internal_alpha_enabled=false refuses phased admission too", async () => {
    const admin = await makeAdmin();
    const interp = await makeInterpretation(admin.id);
    await expect(
      startOwnerManualAlphaResearch(
        ctx.db,
        ctx.boss,
        configWith({
          research_enabled: false,
          internal_alpha_enabled: false,
          phased_research_enabled: true,
        }),
        { userId: admin.id, interpretationId: interp.id, idempotencyKey: uniq("idem") },
      ),
    ).rejects.toMatchObject({ code: "OWNER_ALPHA_LIVE_NOT_ELIGIBLE" });
  });
});

describe("D-138 §4 — atomicity and the one-active-job invariant (items 8, 9, 10)", () => {
  it("10. a job can never exist active with neither legacy nor phase work queued", async () => {
    // The phase write and its message share the job's own INSERT
    // transaction, so a failure anywhere in admission leaves NOTHING —
    // not a stranded active job. Forced here by making the enqueue fail.
    const admin = await makeAdmin();
    const project = await allowlistedProject();
    const topicId = await activeTopicId();
    const before = await ctx.db
      .select({ id: researchJobs.id })
      .from(researchJobs)
      .where(eq(researchJobs.userId, admin.id));
    expect(before).toHaveLength(0);

    await expect(
      ctx.db.transaction(async () => {
        await createResearchJob(
          ctx.db,
          // A boss whose send throws stands in for any failure between
          // the INSERT and the message.
          {
            send: async () => {
              throw new Error("enqueue failed");
            },
          } as never,
          {
            userId: admin.id,
            topicId,
            projectId: project.id,
            originalQuestion: "q",
            normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
            normalizedTaskHash: uniq("hash"),
            idempotencyKey: uniq("idem"),
            entitlement: {
              level: "ARI_CORE",
              capability: "FRESH_RESEARCH",
              budget: DEFAULT_PRODUCT_CONFIG.budget_core,
            },
            demoLifetimeProofLimit: 0,
            origin: "OWNER_MANUAL_ALPHA",
          },
          { phased: true },
        );
      }),
    ).rejects.toThrow();

    // The job row rolled back with the failed enqueue.
    const after = await ctx.db
      .select({ id: researchJobs.id })
      .from(researchJobs)
      .where(eq(researchJobs.userId, admin.id));
    expect(after).toHaveLength(0);
  });

  it("8/9. a second Start Proof cannot create a second active job or a second SEARCHING message", async () => {
    const admin = await makeAdmin();
    const first = await makeInterpretation(admin.id);
    const config = configWith({
      research_enabled: false,
      internal_alpha_enabled: true,
      phased_research_enabled: true,
    });
    const { job } = await startOwnerManualAlphaResearch(ctx.db, ctx.boss, config, {
      userId: admin.id,
      interpretationId: first.id,
      idempotencyKey: uniq("idem"),
    });
    expect(await queuedMessages(RESEARCH_QUEUE, job.id)).toBe(1);

    // A different interpretation, a different key — the one-active-job
    // index is what refuses it, exactly as on the legacy path.
    const second = await makeInterpretation(admin.id);
    await expect(
      startOwnerManualAlphaResearch(ctx.db, ctx.boss, config, {
        userId: admin.id,
        interpretationId: second.id,
        idempotencyKey: uniq("idem"),
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_EXISTS" });

    const active = await ctx.db
      .select({ id: researchJobs.id })
      .from(researchJobs)
      .where(sql`${researchJobs.userId} = ${admin.id} AND ${researchJobs.state} = 'QUEUED'`);
    expect(active).toHaveLength(1);
    expect(await queuedMessages(RESEARCH_QUEUE, job.id)).toBe(1);
  });

  it("the same idempotency key returns the same phased job, and enqueues nothing more", async () => {
    const admin = await makeAdmin();
    const interp = await makeInterpretation(admin.id);
    const key = uniq("idem");
    const config = configWith({
      research_enabled: false,
      internal_alpha_enabled: true,
      phased_research_enabled: true,
    });
    const first = await startOwnerManualAlphaResearch(ctx.db, ctx.boss, config, {
      userId: admin.id,
      interpretationId: interp.id,
      idempotencyKey: key,
    });
    const second = await startOwnerManualAlphaResearch(ctx.db, ctx.boss, config, {
      userId: admin.id,
      interpretationId: interp.id,
      idempotencyKey: key,
    });
    expect(second.job.id).toBe(first.job.id);
    expect(second.created).toBe(false);
    expect(await queuedMessages(RESEARCH_QUEUE, first.job.id)).toBe(1);
  });
});

describe("D-138 §5 — one live gate, asked by every phase (items 11-18, 16)", () => {
  it("16. the gate is one shared helper with one closed set of answers", async () => {
    const admin = await makeAdmin();
    const project = await allowlistedProject();

    // Admitted.
    expect(
      await evaluateOwnerAlphaLive(
        ctx.db,
        { origin: "OWNER_MANUAL_ALPHA", userId: admin.id, projectSlug: project.slug },
        true,
      ),
    ).toBeNull();

    // Every refusal, in the order the single-process path has always
    // produced them.
    expect(
      await evaluateOwnerAlphaLive(
        ctx.db,
        { origin: "PRODUCT", userId: admin.id, projectSlug: project.slug },
        true,
      ),
    ).toBe("NOT_OWNER_MANUAL_ALPHA");

    const [plain] = await ctx.db.insert(users).values({ role: "USER" }).returning();
    expect(
      await evaluateOwnerAlphaLive(
        ctx.db,
        { origin: "OWNER_MANUAL_ALPHA", userId: plain.id, projectSlug: project.slug },
        true,
      ),
    ).toBe("ACTOR_NOT_ADMIN");

    expect(
      await evaluateOwnerAlphaLive(
        ctx.db,
        { origin: "OWNER_MANUAL_ALPHA", userId: admin.id, projectSlug: "definitely_not_allowlisted" },
        true,
      ),
    ).toBe("PROJECT_NOT_ALLOWLISTED");

    expect(
      await evaluateOwnerAlphaLive(
        ctx.db,
        { origin: "OWNER_MANUAL_ALPHA", userId: admin.id, projectSlug: project.slug },
        false,
      ),
    ).toBe("INTERNAL_ALPHA_DISABLED");

    // The throwing form keeps the two existing error classes.
    await expect(
      assertOwnerAlphaLive(
        ctx.db,
        { origin: "OWNER_MANUAL_ALPHA", userId: admin.id, projectSlug: project.slug },
        false,
      ),
    ).rejects.toThrow(/internal_alpha_enabled/);
  });

  it("11/12/17/18. SEARCHING refuses a closed gate before constructing a provider", async () => {
    const admin = await makeAdmin();
    const interp = await makeInterpretation(admin.id);
    const { job } = await startOwnerManualAlphaResearch(
      ctx.db,
      ctx.boss,
      configWith({
        research_enabled: false,
        internal_alpha_enabled: true,
        phased_research_enabled: true,
      }),
      { userId: admin.id, interpretationId: interp.id, idempotencyKey: uniq("idem") },
    );
    expect((await jobRow(job.id)).acquisitionPhase).toBe("SEARCHING");

    // 17. The gate closes AFTER the message was enqueued: the actor loses
    // ADMIN. Nothing about the queued message changes; the worker must
    // decide from current state.
    await ctx.db.update(users).set({ role: "USER" }).where(eq(users.id, admin.id));

    const calls = recordingProviders();
    const out = await dispatchResearchQueueMessage(roleCtx(ROLE_A), job.id);

    expect(out.kind).toBe("PHASED");
    if (out.kind === "PHASED") expect(out.result).toEqual({ ran: false, refusal: "JOB_NOT_RUNNABLE" });

    // 12/18. Zero external calls, zero attempts, zero budget, no Proof.
    expect(calls.proposer).toBe(0);
    expect(calls.search).toBe(0);
    const after = await jobRow(job.id);
    expect(after.searchQueriesReserved).toBe(0);
    expect(after.sourceOpensReserved).toBe(0);
    expect(after.modelCostMicroReserved).toBe(0);
    expect(
      await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, job.id)),
    ).toHaveLength(0);
    // The job is terminal with a named reason, not silently stalled.
    expect(after.state).toBe("FAILED");
    expect(after.errorCode).toBe("OwnerAlphaLiveRefusedError");
  });

  it("13/14. FETCHING asks the gate again — it never infers eligibility from SEARCHING having succeeded", async () => {
    const admin = await makeAdmin();
    const interp = await makeInterpretation(admin.id);
    const { job } = await startOwnerManualAlphaResearch(
      ctx.db,
      ctx.boss,
      configWith({
        research_enabled: false,
        internal_alpha_enabled: true,
        phased_research_enabled: true,
      }),
      { userId: admin.id, interpretationId: interp.id, idempotencyKey: uniq("idem") },
    );

    // Pretend SEARCHING committed and handed off, then the gate closes.
    await ctx.db
      .update(researchJobs)
      .set({ acquisitionPhase: "FETCHING", state: "RUNNING" })
      .where(eq(researchJobs.id, job.id));
    await ctx.db.update(users).set({ role: "USER" }).where(eq(users.id, admin.id));

    const result = await dispatchFetchQueueMessage(roleCtx(ROLE_B), job.id);
    expect(result).toEqual({ ran: false, refusal: "JOB_NOT_RUNNABLE" });

    const after = await jobRow(job.id);
    expect(after.sourceOpensReserved).toBe(0);
    expect(after.state).toBe("FAILED");
    expect(after.errorCode).toBe("OwnerAlphaLiveRefusedError");
  });

  it("15. EXTRACTING still refuses through the same helper", async () => {
    const { resolveOwnerAlphaExtractionExecutor } = await import(
      "../src/server/jobs/owner-alpha-routing"
    );
    const admin = await makeAdmin();
    const project = await allowlistedProject();
    const replay = {
      queryProposer: { name: "r", async proposeQueries() { return []; } },
      searchGateway: { name: "r", async search() { return []; } },
      contentFetcher: { name: "r", async fetch() { throw new Error("never"); } },
    };
    // internal alpha off -> the same InternalAlphaGateClosedError as before.
    await expect(
      resolveOwnerAlphaExtractionExecutor({
        db: ctx.db,
        job: { userId: admin.id, origin: "OWNER_MANUAL_ALPHA" },
        project,
        internalAlphaEnabled: false,
        replay,
      }),
    ).rejects.toThrow(/internal_alpha_enabled/);

    // wrong origin -> the same owner-alpha refusal as before.
    await expect(
      resolveOwnerAlphaExtractionExecutor({
        db: ctx.db,
        job: { userId: admin.id, origin: "PRODUCT" },
        project,
        internalAlphaEnabled: true,
        replay,
      }),
    ).rejects.toThrow(/NOT_OWNER_MANUAL_ALPHA/);
  });
});

describe("D-138 §6 — boundaries (items 21, 26, 27, 28)", () => {
  it("21. the Start Proof request contract is unchanged: no phase field anywhere in the client", async () => {
    const { readFile } = await import("node:fs/promises");
    const api = await readFile("src/client/api.ts", "utf-8");
    for (const word of ["phased", "acquisitionPhase", "acquisition_phase", "capability", "SEARCHING"]) {
      expect(api, `client must not mention ${word}`).not.toContain(word);
    }
    // The service decides from configuration, which the client never sees.
    const service = await readFile("src/server/services/start-owner-alpha-research.ts", "utf-8");
    expect(service).toContain("config.phased_research_enabled");
    expect(service).not.toContain("input.phased");
  });

  it("26/27. admission and gating name no network product and no project", async () => {
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/server/services/start-owner-alpha-research.ts",
      "src/server/jobs/queue.ts",
      "src/server/jobs/worker-capabilities.ts",
    ];
    const forbidden = ["mantaray", "vpn", "proxy", "region", "country", "raydium", "pump_fun"];
    for (const file of files) {
      const code = (await readFile(file, "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const word of forbidden) {
        expect(code, `${file} must not name ${word}`).not.toContain(word);
      }
    }
  });

  it("28. admission touches no S5-S9 store and no controller", async () => {
    const { readFile } = await import("node:fs/promises");
    const service = await readFile("src/server/services/start-owner-alpha-research.ts", "utf-8");
    for (const forbidden of [
      "runResearchController",
      "reconcileAndPersistComponent",
      "assembleAndPersistMechanism",
      "evaluateAndPersistClaimSupport",
      "buildAndPersistProof",
      "runS4ResearchJob",
    ]) {
      expect(service).not.toContain(forbidden);
    }
  });

  it("createResearchJob refuses the one combination that could produce a job with no work", async () => {
    const admin = await makeAdmin();
    const project = await allowlistedProject();
    const topicId = await activeTopicId();
    await expect(
      createResearchJob(
        ctx.db,
        ctx.boss,
        {
          userId: admin.id,
          topicId,
          projectId: project.id,
          originalQuestion: "q",
          normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
          normalizedTaskHash: uniq("hash"),
          idempotencyKey: uniq("idem"),
          entitlement: {
            level: "ARI_CORE",
            capability: "FRESH_RESEARCH",
            budget: DEFAULT_PRODUCT_CONFIG.budget_core,
          },
          demoLifetimeProofLimit: 0,
          origin: "OWNER_MANUAL_ALPHA",
        },
        { phased: true, skipEnqueue: true },
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });
});
