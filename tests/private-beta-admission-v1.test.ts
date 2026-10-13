import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { POST as clarifyPOST } from "../app/api/interpretations/[id]/clarify/route";
import { POST as interpretPOST } from "../app/api/interpretations/route";
import { GET as projectsGET } from "../app/api/projects/route";
import { GET as auditGET, POST as auditPOST } from "../app/api/research-jobs/[id]/audit/route";
import { POST as cancelPOST } from "../app/api/research-jobs/[id]/cancel/route";
import { GET as eventsGET } from "../app/api/research-jobs/[id]/events/route";
import { POST as readPOST } from "../app/api/research-jobs/[id]/read/route";
import { GET as jobDetailGET } from "../app/api/research-jobs/[id]/route";
import { GET as snapshotGET } from "../app/api/research-jobs/[id]/snapshots/[evidenceId]/route";
import { GET as jobsGET, POST as jobsPOST } from "../app/api/research-jobs/route";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { canStartProof, proofBlockReason } from "../src/client/proof-gate";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { createSession } from "../src/server/auth/session";
import { DEFAULT_PRODUCT_CONFIG, INTERNAL_ALPHA_V1, loadProductConfig, productConfigSchema, type ProductConfig } from "../src/server/config/product";
import {
  interpretations,
  productConfig,
  projects,
  proofs,
  researchAttempts,
  researchJobs,
  subscriptions,
  topics,
  users,
} from "../src/server/db/schema";
import { persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import { loadHistoricalSupplyCandidates } from "../src/server/engine/onchain-supply-candidate-store";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { __setContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { __setEvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";
import { __setQueryProposer } from "../src/server/engine/providers/query-proposer";
import { __setSearchGateway } from "../src/server/engine/providers/search-gateway";
import { REAL_RESEARCH_ACQUISITION_ORIGINS } from "../src/server/engine/research-acquisition-origin";
import { __clearFakeScripts, __failNextCalls } from "../src/server/interpreter/fake";
import type { PhaseWorkerContext } from "../src/server/jobs/acquisition-phase-worker";
import { evaluateOwnerAlphaLive } from "../src/server/jobs/owner-alpha-routing";
import {
  PrivateBetaLiveRefusedError,
  assertJobLiveAdmitted,
  evaluateJobLiveAdmission,
  evaluatePrivateBetaLive,
  resolvePrivateBetaExtractionExecutor,
  resolvePrivateBetaWorkExecutor,
} from "../src/server/jobs/private-beta-routing";
import { PHASE_QUEUE, RESEARCH_QUEUE } from "../src/server/jobs/queue";
import { createResearchJob, transitionJobState } from "../src/server/jobs/research-jobs";
import { parseWorkerCapabilities } from "../src/server/jobs/worker-capabilities";
import {
  dispatchFetchQueueMessage,
  dispatchResearchQueueMessage,
  handleResearchJobTask,
  reconcileExhaustedPhaseDeliveries,
  sweepStaleRunningJobs,
} from "../src/server/jobs/worker";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { __resetRuntime } from "../src/server/runtime";
import { evaluateGates } from "../src/server/services/gates";
import {
  PRIVATE_BETA_GRANT_PROVIDER,
  PrivateBetaGrantError,
  countPrivateBetaJobs,
  evaluatePrivateBetaAdmission,
  grantPrivateBetaAccess,
  hasValidPrivateBetaGrant,
  interpreterAccessRefusal,
  privateBetaOpen,
  revokePrivateBetaAccess,
  setPrivateBetaConfig,
} from "../src/server/services/private-beta";
import { startPrivateBetaResearch } from "../src/server/services/start-private-beta-research";
import { startResearch } from "../src/server/services/start-research";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// PRIVATE BETA ADMISSION (Founder-approved, D-167).
//
// An approved beta USER runs the SAME real, budget-bounded Research as the
// owner — admitted by a server-owned grant on the existing subscription
// entitlement, never by the ADMIN role — while the public PRODUCT path stays
// closed. Everything here is offline: providers are fixtures that RECORD
// being called.

const ORIGIN = "https://app.atlas.test";
const WAVE_1 = ["raydium", "pump_fun", "lido"];
const BETA_PROJECT = "pump_fun";
const QUESTION = "Does Pump.fun revenue reach token holders?";
let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.MODEL_GATEWAY = "fake";
  ctx = await setupTestDatabase();
  await __resetRuntime();
});

afterAll(async () => {
  __setQueryProposer(null);
  __setSearchGateway(null);
  __setContentFetcher(null);
  __setEvidenceExtractor(null);
  await __resetRuntime();
  await ctx.close();
});

afterEach(async () => {
  __clearFakeScripts();
  __failNextCalls(0);
  // Every test starts from the shipped state: public closed, beta off, no
  // beta project, limit 5, owner alpha off, single-process.
  await setConfig({ research_enabled: false, internal_alpha_enabled: false, phased_research_enabled: false });
  await setPrivateBetaConfig(ctx.db, { enabled: false, projectSlugs: [], researchLimit: 5 });
  await __resetRuntime();
});

async function setConfig(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    await ctx.db.insert(productConfig).values({ key, value }).onConflictDoUpdate({ target: productConfig.key, set: { value } });
  }
  await __resetRuntime();
}

// The Wave 1 beta, switched on in the database (what the routes and the
// worker read) — returned as the config object the services take.
async function openBeta(over: { projectSlugs?: string[]; researchLimit?: number; phased?: boolean } = {}): Promise<ProductConfig> {
  await setPrivateBetaConfig(ctx.db, { enabled: true, projectSlugs: over.projectSlugs ?? WAVE_1, researchLimit: over.researchLimit ?? 5 });
  if (over.phased !== undefined) await setConfig({ phased_research_enabled: over.phased });
  await __resetRuntime();
  return loadProductConfig(ctx.db);
}

interface Authed {
  cookie: string;
  csrf: string;
  userId: string;
}

async function makeAuthedClient(role: "USER" | "ADMIN" = "USER"): Promise<Authed> {
  const [u] = await ctx.db.insert(users).values({ role }).returning();
  const { rawToken } = await createSession(ctx.db, u.id);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { cookie: `atlas_session=${rawToken}`, csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!), userId: u.id };
}

const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

async function betaUser(): Promise<Authed> {
  const c = await makeAuthedClient("USER");
  await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(30) });
  return c;
}

function post(path: string, c: Authed, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: c.cookie, origin: ORIGIN, "x-atlas-csrf": c.csrf },
    body: JSON.stringify(body),
  });
}
const get = (path: string, c: Authed): Request => new Request(`http://localhost${path}`, { method: "GET", headers: { cookie: c.cookie, origin: ORIGIN } });
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

// A READY research interpretation exactly as the Interpreter persists one.
async function interpretationFor(userId: string, slug = BETA_PROJECT): Promise<string> {
  const [row] = await ctx.db
    .insert(interpretations)
    .values({
      userId,
      originalQuestion: "Where does the fee revenue go, and what happens to the token that is bought back?",
      status: "READY",
      result: { project_slug: slug, project_slugs: [slug], research_task: "trace fee revenue to the token", route: "DEEP_RESEARCH" },
    })
    .returning();
  return row.id;
}

const start = (config: ProductConfig, userId: string, interpretationId: string, idempotencyKey = uniq("idem")) =>
  startPrivateBetaResearch(ctx.db, ctx.boss, config, { userId, interpretationId, idempotencyKey });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ADMITTED";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const jobsOf = async (userId: string) => ctx.db.select().from(researchJobs).where(eq(researchJobs.userId, userId));
const jobRow = async (id: string) => (await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, id)))[0];
const roleOf = async (userId: string) => (await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, userId)))[0].role;
async function queued(queue: string, jobId: string): Promise<number> {
  const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${queue} AND data->>'jobId' = ${jobId}`);
  return (rows.rows[0] as { n: number }).n;
}
// Ends an admitted job while it is still QUEUED (execution never started),
// so the user may be admitted again. Under D-169 such a cancellation hands
// the slot back; a cancellation after execution started does not.
const finish = (jobId: string) => transitionJobState(ctx.db, jobId, "CANCELLED", "test: release the active slot");
// A Research that ended with a durable Proof: the one outcome that keeps a
// beta slot (D-169), exactly as a DEMO reservation is CONSUMED.
async function finishWithProof(jobId: string, userId: string): Promise<void> {
  const [job] = await ctx.db.select({ projectId: researchJobs.projectId, topicId: researchJobs.topicId }).from(researchJobs).where(eq(researchJobs.id, jobId));
  await transitionJobState(ctx.db, jobId, "RUNNING", "test: pick up");
  await transitionJobState(ctx.db, jobId, "SUCCEEDED", "test: finished with a Proof");
  await ctx.db.insert(proofs).values({ researchJobId: jobId, ownerUserId: userId, projectId: job.projectId!, topicId: job.topicId, verdict: "SUPPORTED", confidence: 70, layers: {} });
}

// Provider seams the REAL executor resolves. They record every call.
function recordingProviders() {
  const calls = { proposer: 0, search: 0, fetch: 0, extract: 0 };
  __setQueryProposer({
    name: "fixture-proposer",
    async proposeQueries() {
      calls.proposer += 1;
      return ["pump.fun buyback"];
    },
  });
  __setSearchGateway({
    name: "fixture-search",
    async search() {
      calls.search += 1;
      return [];
    },
  });
  __setContentFetcher({
    name: "fixture-fetch",
    async fetch() {
      calls.fetch += 1;
      throw new Error("fixture: nothing to fetch");
    },
  } as never);
  __setEvidenceExtractor({
    name: "fixture-extract",
    async extract() {
      calls.extract += 1;
      return { facts: [] };
    },
  } as never);
  return calls;
}
const total = (c: { proposer: number; search: number; fetch: number; extract: number }) => c.proposer + c.search + c.fetch + c.extract;

describe("1. the grant is the existing subscription entitlement, and nothing more", () => {
  it("config: three server-owned keys, each failing closed when absent", () => {
    const bare = productConfigSchema.parse({
      ...DEFAULT_PRODUCT_CONFIG,
      private_beta_enabled: undefined,
      private_beta_project_slugs: undefined,
      private_beta_research_limit: undefined,
    });
    expect(bare.private_beta_enabled).toBe(false);
    expect(bare.private_beta_project_slugs).toEqual([]);
    expect(bare.private_beta_research_limit).toBe(3); // creator beta, D-170
    expect(DEFAULT_PRODUCT_CONFIG.private_beta_enabled).toBe(false);
    expect(DEFAULT_PRODUCT_CONFIG.private_beta_project_slugs).toEqual([]);
    expect(DEFAULT_PRODUCT_CONFIG.research_enabled).toBe(false);
    expect(privateBetaOpen({ ...DEFAULT_PRODUCT_CONFIG, private_beta_enabled: true })).toBe(true);
    // The beta switch alone decides: research_enabled can never hand a beta
    // user to the PRODUCT path.
    expect(privateBetaOpen({ ...DEFAULT_PRODUCT_CONFIG, private_beta_enabled: true, research_enabled: true })).toBe(true);
    expect(privateBetaOpen({ ...DEFAULT_PRODUCT_CONFIG, private_beta_enabled: false, research_enabled: true })).toBe(false);
  });

  it("a grant is one ARI_CORE subscription row with an explicit expiry, no auto-renew, a server-owned marker — and the user stays USER", async () => {
    const c = await makeAuthedClient("USER");
    expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(false);
    const out = await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(14) });
    expect(out.created).toBe(true);
    const [row] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, c.userId));
    expect(row).toMatchObject({ level: "ARI_CORE", status: "ACTIVE", autoRenew: false, billingProvider: PRIVATE_BETA_GRANT_PROVIDER });
    expect(row.validUntil.getTime()).toBeGreaterThan(Date.now());
    expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(true);
    expect(await roleOf(c.userId)).toBe("USER");
    // Re-granting re-dates the same row; it never stacks a second one.
    const again = await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(60) });
    expect(again).toEqual({ subscriptionId: out.subscriptionId, created: false });
    expect(await ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, c.userId))).toHaveLength(1);
  });

  it("an expiry in the past, an unknown user, or another entitlement is refused; an auto-renewing or unmarked subscription is not a beta grant", async () => {
    const c = await makeAuthedClient("USER");
    await expect(grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(-1) })).rejects.toThrow(PrivateBetaGrantError);
    await expect(grantPrivateBetaAccess(ctx.db, { userId: "00000000-0000-4000-8000-000000000000", validUntil: inDays(5) })).rejects.toThrow(/USER_NOT_FOUND/);
    // A purchased-style subscription (auto-renewing, another provider).
    await ctx.db.insert(subscriptions).values({ userId: c.userId, status: "ACTIVE", validFrom: new Date(), validUntil: inDays(30) });
    expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(false);
    await expect(grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(5) })).rejects.toThrow(/OTHER_ENTITLEMENT_EXISTS/);
  });

  it("no route writes a grant or the beta config: only the owner tool and its service do", () => {
    for (const file of [
      "app/api/research-jobs/route.ts",
      "app/api/interpretations/route.ts",
      "app/api/projects/route.ts",
      "app/api/me/route.ts",
      "src/server/services/start-private-beta-research.ts",
      "src/server/jobs/private-beta-routing.ts",
    ]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toMatch(/grantPrivateBetaAccess|setPrivateBetaConfig|insert\(subscriptions\)/);
    }
  });
});

describe("2. admission: every refusal happens before a job exists", () => {
  it("a non-admitted USER is refused BETA_ACCESS_REQUIRED and no job is created", async () => {
    await openBeta();
    const c = await makeAuthedClient("USER");
    const interpretationId = await interpretationFor(c.userId);
    const res = await jobsPOST(post("/api/research-jobs", c, { interpretationId, idempotencyKey: uniq("idem") }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("BETA_ACCESS_REQUIRED");
    expect(await jobsOf(c.userId)).toHaveLength(0);
    // Even a request that names someone else's interpretation learns only
    // that beta access is required.
    const other = await betaUser();
    const foreign = await interpretationFor(other.userId);
    const res2 = await jobsPOST(post("/api/research-jobs", c, { interpretationId: foreign, idempotencyKey: uniq("idem") }));
    expect(await errorOf(res2)).toBe("BETA_ACCESS_REQUIRED");
  });

  it("a valid beta USER is admitted through the route with origin PRIVATE_BETA, the owner-alpha envelope, and stays USER", async () => {
    await openBeta();
    const c = await betaUser();
    const interpretationId = await interpretationFor(c.userId);
    const res = await jobsPOST(post("/api/research-jobs", c, { interpretationId, idempotencyKey: uniq("idem") }));
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { id: string } };
    const row = await jobRow(job.id);
    expect(row.origin).toBe("PRIVATE_BETA");
    expect(row.userId).toBe(c.userId);
    expect(row.entitlementAtStart).toBe("ARI_CORE");
    expect(row.capabilityAtStart).toBe("FRESH_RESEARCH");
    expect(row.budgetAtStart).toEqual(INTERNAL_ALPHA_V1);
    expect(row.state).toBe("QUEUED");
    // Created and enqueued atomically, through the existing path.
    expect(await queued(RESEARCH_QUEUE, job.id)).toBe(1);
    expect(await roleOf(c.userId)).toBe("USER");
    // The owner-alpha gate still refuses this user: nothing made them ADMIN.
    expect(await evaluateOwnerAlphaLive(ctx.db, { origin: "OWNER_MANUAL_ALPHA", userId: c.userId, projectSlug: BETA_PROJECT }, true)).toBe("ACTOR_NOT_ADMIN");
  });

  it("the client cannot choose or raise the budget: extra request fields are ignored", async () => {
    await openBeta();
    const c = await betaUser();
    const interpretationId = await interpretationFor(c.userId);
    const res = await jobsPOST(
      post("/api/research-jobs", c, {
        interpretationId,
        idempotencyKey: uniq("idem"),
        budget: { maxSearchQueries: 999, maxSourceOpens: 999, maxModelCostMicro: 99_000_000, maxWallClockSec: 99_999 },
        origin: "OWNER_MANUAL_ALPHA",
        entitlement: "ARI_CORE",
      }),
    );
    const { job } = (await res.json()) as { job: { id: string } };
    const row = await jobRow(job.id);
    expect(row.budgetAtStart).toEqual(INTERNAL_ALPHA_V1);
    expect(row.origin).toBe("PRIVATE_BETA");
  });

  it("a project outside the beta list is refused BETA_PROJECT_NOT_AVAILABLE; the default empty list admits nothing", async () => {
    const c = await betaUser();
    // Aave is in scope and on the live-spend allowlist, but not in Wave 1.
    expect(INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has("aave")).toBe(true);
    const config = await openBeta();
    expect(await codeOf(start(config, c.userId, await interpretationFor(c.userId, "aave")))).toBe("BETA_PROJECT_NOT_AVAILABLE");
    // Empty list (the default): even a Wave 1 project is refused.
    const empty = await openBeta({ projectSlugs: [] });
    expect(await codeOf(start(empty, c.userId, await interpretationFor(c.userId, BETA_PROJECT)))).toBe("BETA_PROJECT_NOT_AVAILABLE");
    // On the beta list but NOT on the code-owned live-spend allowlist.
    const slug = uniq("beta_only");
    await ctx.db.insert(projects).values({ slug, name: "Listed, not allowlisted", status: "ACTIVE_CORE" });
    const listed = await openBeta({ projectSlugs: [...WAVE_1, slug] });
    expect(await codeOf(start(listed, c.userId, await interpretationFor(c.userId, slug)))).toBe("BETA_PROJECT_NOT_AVAILABLE");
    // Out of research scope altogether keeps the existing reason.
    const draft = uniq("candidate");
    await ctx.db.insert(projects).values({ slug: draft, name: "Candidate", status: "CANDIDATE" });
    expect(await codeOf(start(listed, c.userId, await interpretationFor(c.userId, draft)))).toBe("OUT_OF_SCOPE");
    expect(await jobsOf(c.userId)).toHaveLength(0);
  });

  it("the 5-Research total cap is enforced, counts only Research that ended with a durable Proof, and is a server-owned number (D-169)", async () => {
    const config = await openBeta();
    const c = await betaUser();
    for (let i = 0; i < 5; i += 1) {
      const { job, created } = await start(config, c.userId, await interpretationFor(c.userId));
      expect(created).toBe(true);
      await finishWithProof(job.id, c.userId);
    }
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(5);
    expect(await codeOf(start(config, c.userId, await interpretationFor(c.userId)))).toBe("BETA_RESEARCH_LIMIT_REACHED");
    expect(await jobsOf(c.userId)).toHaveLength(5);
    // Raising the server-owned number admits the next one; another user's
    // jobs never count against this user.
    const raised = await openBeta({ researchLimit: 6 });
    expect(await codeOf(start(raised, c.userId, await interpretationFor(c.userId)))).toBe("ADMITTED");
    const other = await betaUser();
    expect(await countPrivateBetaJobs(ctx.db, other.userId)).toBe(0);
  });

  it("a cancelled or failed beta Research, or a terminal with no Proof, hands its slot back; an active one occupies it (D-169)", async () => {
    const config = await openBeta({ researchLimit: 2 });
    const c = await betaUser();
    // Cancelled before any Proof: the slot is not spent.
    const first = await start(config, c.userId, await interpretationFor(c.userId));
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(1); // active: occupies
    await finish(first.job.id);
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(0);
    // Failed: the slot is not spent.
    const second = await start(config, c.userId, await interpretationFor(c.userId));
    await transitionJobState(ctx.db, second.job.id, "RUNNING", "test: pick up");
    await transitionJobState(ctx.db, second.job.id, "FAILED", "test: provider failure");
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(0);
    // SUCCEEDED without a proofs row (nothing durable was produced): not spent.
    const third = await start(config, c.userId, await interpretationFor(c.userId));
    await transitionJobState(ctx.db, third.job.id, "RUNNING", "test: pick up");
    await transitionJobState(ctx.db, third.job.id, "SUCCEEDED", "test: no proof persisted");
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(0);
    // Two durable Proofs spend the whole allowance of 2; the three earlier
    // runs never counted. The user still has five job rows.
    for (let i = 0; i < 2; i += 1) {
      const { job } = await start(config, c.userId, await interpretationFor(c.userId));
      await finishWithProof(job.id, c.userId);
    }
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(2);
    expect(await jobsOf(c.userId)).toHaveLength(5);
    expect(await codeOf(start(config, c.userId, await interpretationFor(c.userId)))).toBe("BETA_RESEARCH_LIMIT_REACHED");
  });

  it("a Research cancelled after execution started keeps its slot permanently, through the user's own cancel route; cancelled while still QUEUED it does not (D-169)", async () => {
    const config = await openBeta({ researchLimit: 2 });
    const c = await betaUser();
    const cancelVia = async (jobId: string) =>
      cancelPOST(post(`/api/research-jobs/${jobId}/cancel`, c, {}), { params: Promise.resolve({ id: jobId }) });

    // Cancelled by the user while still QUEUED: nothing ran, the slot returns.
    const queuedOnly = await start(config, c.userId, await interpretationFor(c.userId));
    expect((await cancelVia(queuedOnly.job.id)).status).toBe(200);
    expect((await ctx.db.select({ startedAt: researchJobs.startedAt }).from(researchJobs).where(eq(researchJobs.id, queuedOnly.job.id)))[0].startedAt).toBeNull();
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(0);

    // Cancelled by the user after execution started: paid work may have run,
    // so the slot stays spent even though no Proof exists.
    const running = await start(config, c.userId, await interpretationFor(c.userId));
    await transitionJobState(ctx.db, running.job.id, "RUNNING", "test: pick up");
    expect((await cancelVia(running.job.id)).status).toBe(200);
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(1);

    // Cancelled while AWAITING_CLARIFICATION: that state is reachable only
    // through RUNNING, so execution started and the slot stays spent too.
    const clarifying = await start(config, c.userId, await interpretationFor(c.userId));
    await transitionJobState(ctx.db, clarifying.job.id, "RUNNING", "test: pick up");
    await transitionJobState(ctx.db, clarifying.job.id, "AWAITING_CLARIFICATION", "test: needs the user");
    expect((await cancelVia(clarifying.job.id)).status).toBe(200);
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(2);

    // Start → cancel cannot be repeated to consume unbounded beta spend:
    // the allowance of 2 is now exhausted without a single Proof.
    expect(await codeOf(start(config, c.userId, await interpretationFor(c.userId)))).toBe("BETA_RESEARCH_LIMIT_REACHED");
    expect(await jobsOf(c.userId)).toHaveLength(3);
  });

  it("a FAILED Research returns its slot even after execution started: a system failure never punishes the user (D-169)", async () => {
    const config = await openBeta({ researchLimit: 1 });
    const c = await betaUser();
    for (let i = 0; i < 3; i += 1) {
      const { job } = await start(config, c.userId, await interpretationFor(c.userId));
      await transitionJobState(ctx.db, job.id, "RUNNING", "test: pick up");
      await transitionJobState(ctx.db, job.id, "FAILED", "test: provider failure");
      expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(0);
    }
    expect(await codeOf(start(config, c.userId, await interpretationFor(c.userId)))).toBe("ADMITTED");
  });

  it("one active job per user: a second concurrent Research is refused and nothing more is enqueued", async () => {
    const config = await openBeta();
    const c = await betaUser();
    const first = await start(config, c.userId, await interpretationFor(c.userId));
    expect(await codeOf(start(config, c.userId, await interpretationFor(c.userId)))).toBe("ACTIVE_JOB_EXISTS");
    const mine = await jobsOf(c.userId);
    expect(mine.map((j) => j.id)).toEqual([first.job.id]);
    const res = await jobsPOST(post("/api/research-jobs", c, { interpretationId: await interpretationFor(c.userId), idempotencyKey: uniq("idem") }));
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("ACTIVE_JOB_EXISTS");
  });

  it("an idempotent duplicate returns the same job — even after the grant is gone — and enqueues nothing more", async () => {
    await openBeta();
    const c = await betaUser();
    const interpretationId = await interpretationFor(c.userId);
    const idempotencyKey = uniq("idem");
    const first = await jobsPOST(post("/api/research-jobs", c, { interpretationId, idempotencyKey }));
    expect(first.status).toBe(201);
    const id = ((await first.json()) as { job: { id: string } }).job.id;
    const again = await jobsPOST(post("/api/research-jobs", c, { interpretationId, idempotencyKey }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { job: { id: string } }).job.id).toBe(id);
    await revokePrivateBetaAccess(ctx.db, { userId: c.userId });
    const afterRevoke = await jobsPOST(post("/api/research-jobs", c, { interpretationId, idempotencyKey }));
    expect(afterRevoke.status).toBe(200);
    expect(await jobsOf(c.userId)).toHaveLength(1);
    expect(await queued(RESEARCH_QUEUE, id)).toBe(1);
    // The same interpretation under a different key is a reuse, not a replay.
    const reuse = await jobsPOST(post("/api/research-jobs", await betaUserFrom(c), { interpretationId, idempotencyKey: uniq("idem") }));
    expect(reuse.status).toBe(409);
  });

  it("an expired or revoked grant refuses a NEW Research", async () => {
    const config = await openBeta();
    const expired = await betaUser();
    await ctx.db.update(subscriptions).set({ validUntil: inDays(-1) }).where(eq(subscriptions.userId, expired.userId));
    expect(await hasValidPrivateBetaGrant(ctx.db, expired.userId)).toBe(false);
    expect(await codeOf(start(config, expired.userId, await interpretationFor(expired.userId)))).toBe("BETA_ACCESS_REQUIRED");
    const revoked = await betaUser();
    expect((await revokePrivateBetaAccess(ctx.db, { userId: revoked.userId })).revoked).toBe(1);
    expect(await codeOf(start(config, revoked.userId, await interpretationFor(revoked.userId)))).toBe("BETA_ACCESS_REQUIRED");
    expect(await jobsOf(expired.userId)).toHaveLength(0);
    expect(await jobsOf(revoked.userId)).toHaveLength(0);
  });
});

// The same signed-in user with a fresh grant (used where a test revoked it).
async function betaUserFrom(c: Authed): Promise<Authed> {
  await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(30) });
  return c;
}

describe("3. the public PRODUCT path and owner alpha are unchanged", () => {
  it("beta switch off: a USER — with or without a grant — is still RESEARCH_DISABLED, exactly as before", async () => {
    const plain = await makeAuthedClient("USER");
    const granted = await betaUser();
    for (const c of [plain, granted]) {
      const res = await jobsPOST(post("/api/research-jobs", c, { interpretationId: await interpretationFor(c.userId), idempotencyKey: uniq("idem") }));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("RESEARCH_DISABLED");
      expect(await jobsOf(c.userId)).toHaveLength(0);
    }
    await expect(startResearch(ctx.db, ctx.boss, await loadProductConfig(ctx.db), { userId: plain.userId, interpretationId: await interpretationFor(plain.userId), idempotencyKey: uniq("idem") })).rejects.toMatchObject({ code: "RESEARCH_DISABLED" });
    await expect(start(await loadProductConfig(ctx.db), granted.userId, await interpretationFor(granted.userId))).rejects.toMatchObject({ code: "RESEARCH_DISABLED" });
  });

  it("an ADMIN keeps the owner path with beta on: origin OWNER_MANUAL_ALPHA, never PRIVATE_BETA", async () => {
    await openBeta();
    const admin = await makeAuthedClient("ADMIN");
    const res = await jobsPOST(post("/api/research-jobs", admin, { interpretationId: await interpretationFor(admin.userId), idempotencyKey: uniq("idem") }));
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { id: string } };
    expect((await jobRow(job.id)).origin).toBe("OWNER_MANUAL_ALPHA");
  });

  it("the two switches are independent: the beta gate never reads internal_alpha_enabled, the owner gate never reads private_beta_enabled", async () => {
    const admin = await makeAuthedClient("ADMIN");
    const betaOnAlphaOff = { ...DEFAULT_PRODUCT_CONFIG, private_beta_enabled: true, private_beta_project_slugs: WAVE_1, internal_alpha_enabled: false };
    const betaOffAlphaOn = { ...DEFAULT_PRODUCT_CONFIG, private_beta_enabled: false, internal_alpha_enabled: true };
    const beta = { origin: "PRIVATE_BETA", userId: admin.userId, projectSlug: BETA_PROJECT };
    const owner = { origin: "OWNER_MANUAL_ALPHA", userId: admin.userId, projectSlug: BETA_PROJECT };
    expect(await evaluateJobLiveAdmission(ctx.db, beta, betaOnAlphaOff)).toBeNull();
    expect(await evaluateJobLiveAdmission(ctx.db, beta, betaOffAlphaOn)).toBe("PRIVATE_BETA_DISABLED");
    expect(await evaluateJobLiveAdmission(ctx.db, owner, betaOffAlphaOn)).toBeNull();
    expect(await evaluateJobLiveAdmission(ctx.db, owner, betaOnAlphaOff)).toBe("INTERNAL_ALPHA_DISABLED");
  });

  it("a PRODUCT job is still refused the live path and still runs the non-live executor — no provider is reached", async () => {
    const config = await openBeta();
    const c = await betaUser();
    expect(await evaluateJobLiveAdmission(ctx.db, { origin: "PRODUCT", userId: c.userId, projectSlug: BETA_PROJECT }, config)).toBe("NOT_OWNER_MANUAL_ALPHA");
    expect(evaluatePrivateBetaLive({ origin: "PRODUCT", projectSlug: BETA_PROJECT }, config)).toBe("NOT_PRIVATE_BETA");
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const [project] = await ctx.db.select().from(projects).where(eq(projects.slug, BETA_PROJECT));
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: c.userId,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: QUESTION,
      normalizedTask: { project_slug: BETA_PROJECT, project_slugs: [BETA_PROJECT], task: "revenue to holders" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 3,
    });
    expect((await jobRow(job.id)).origin).toBe("PRODUCT");
    const calls = recordingProviders();
    await handleResearchJobTask(ctx.db, job.id);
    expect(total(calls)).toBe(0);
  });
});

describe("4. a PRIVATE_BETA job runs the real executor", () => {
  it("single-process: the worker routes it to the real S4 executor, which reaches the (fixture) providers", async () => {
    const config = await openBeta();
    const c = await betaUser();
    const { job } = await start(config, c.userId, await interpretationFor(c.userId));
    const calls = recordingProviders();
    const result = await handleResearchJobTask(ctx.db, job.id);
    expect(result.claimed).toBe(true);
    // The real executor resolved the real provider seams — the non-live
    // placeholder never does (see the PRODUCT case above: zero calls).
    expect(calls.proposer + calls.search).toBeGreaterThan(0);
    const after = await jobRow(job.id);
    expect(["QUEUED", "RUNNING"]).not.toContain(after.state);
    expect(after.errorCode).not.toBe("PrivateBetaLiveRefusedError");
    expect(await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, job.id))).not.toHaveLength(0);
  });

  it("there is no beta executor: both resolvers construct the same createS4WorkExecutor the owner path uses", () => {
    // Code only: the comments explain the relation to the owner path by name.
    const src = readFileSync("src/server/jobs/private-beta-routing.ts", "utf-8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src.match(/createS4WorkExecutor\(/g)).toHaveLength(2);
    expect(src).not.toMatch(/createNonLiveS4WorkExecutor|createLiveS4WorkExecutor|internalAlphaEnabled: true/);
    // The beta gate itself reads only its own switch and list.
    const gate = src.slice(src.indexOf("export function evaluatePrivateBetaLive("), src.indexOf("export async function evaluateJobLiveAdmission("));
    expect(gate).toContain("private_beta_enabled");
    expect(gate).not.toMatch(/internal_alpha_enabled|research_enabled|users|role/);
    const worker = readFileSync("src/server/jobs/worker.ts", "utf-8");
    expect(worker).toContain('} else if (job.origin === "PRIVATE_BETA") {');
    expect(worker).toContain("resolvePrivateBetaWorkExecutor(");
    expect(worker).toContain("resolvePrivateBetaExtractionExecutor(");
    expect(worker).toContain("await assertJobLiveAdmitted(");
    // live-executor.ts (frozen) is untouched by this change.
    expect(readFileSync("src/server/engine/live-executor.ts", "utf-8")).not.toMatch(/PRIVATE_BETA|private_beta/);
  });

  it("the resolvers refuse a wrong origin, a closed switch and a project off the list — never a silent non-live fallback", async () => {
    const config = await openBeta();
    const [project] = await ctx.db.select().from(projects).where(eq(projects.slug, BETA_PROJECT));
    const [aave] = await ctx.db.select().from(projects).where(eq(projects.slug, "aave"));
    const job = { userId: "u", origin: "PRIVATE_BETA" };
    expect(resolvePrivateBetaWorkExecutor({ db: ctx.db, job, project, config })).toBeDefined();
    expect(() => resolvePrivateBetaWorkExecutor({ db: ctx.db, job: { userId: "u", origin: "PRODUCT" }, project, config })).toThrow(/NOT_PRIVATE_BETA/);
    expect(() => resolvePrivateBetaWorkExecutor({ db: ctx.db, job, project, config: { ...config, private_beta_enabled: false } })).toThrow(PrivateBetaLiveRefusedError);
    expect(() => resolvePrivateBetaWorkExecutor({ db: ctx.db, job, project: aave, config })).toThrow(/PROJECT_NOT_IN_PRIVATE_BETA/);
    const replay = {
      queryProposer: { name: "r", async proposeQueries() { return []; } },
      searchGateway: { name: "r", async search() { return []; } },
      contentFetcher: { name: "r", async fetch() { throw new Error("never"); } },
    } as never;
    expect(resolvePrivateBetaExtractionExecutor({ db: ctx.db, job, project, config, replay })).toBeDefined();
    expect(() => resolvePrivateBetaExtractionExecutor({ db: ctx.db, job, project, config: { ...config, private_beta_enabled: false }, replay })).toThrow(/PRIVATE_BETA_DISABLED/);
  });
});

describe("5. the phased pipeline: the gate is asked at every phase; the grant is not", () => {
  const ROLE_A: PhaseWorkerContext = { get db() { return ctx.db; }, get boss() { return ctx.boss; }, capabilities: parseWorkerCapabilities("SEARCH_EXTRACT") } as PhaseWorkerContext;
  const ROLE_B: PhaseWorkerContext = { get db() { return ctx.db; }, get boss() { return ctx.boss; }, capabilities: parseWorkerCapabilities("FETCH") } as PhaseWorkerContext;

  async function phasedJob() {
    const config = await openBeta({ phased: true });
    const c = await betaUser();
    const { job } = await start(config, c.userId, await interpretationFor(c.userId));
    return { c, job };
  }

  it("phased admission: one PRIVATE_BETA job, one SEARCHING message, no legacy message", async () => {
    const { job } = await phasedJob();
    const row = await jobRow(job.id);
    expect(row.origin).toBe("PRIVATE_BETA");
    expect(row.acquisitionPhase).toBe("SEARCHING");
    expect(await queued(PHASE_QUEUE.SEARCHING, job.id)).toBe(1);
  });

  it("a grant revoked or expired AFTER admission does not stop the admitted Research", async () => {
    const { c, job } = await phasedJob();
    await revokePrivateBetaAccess(ctx.db, { userId: c.userId });
    expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(false);
    await expect(assertJobLiveAdmitted(ctx.db, { origin: "PRIVATE_BETA", userId: c.userId, projectSlug: BETA_PROJECT }, await loadProductConfig(ctx.db))).resolves.toBeUndefined();
    const calls = recordingProviders();
    const out = await dispatchResearchQueueMessage(ROLE_A, job.id);
    expect(out.kind).toBe("PHASED");
    if (out.kind === "PHASED") expect(out.result).not.toEqual({ ran: false, refusal: "JOB_NOT_RUNNABLE" });
    // The phase really ran: the proposer was reached.
    expect(calls.proposer).toBeGreaterThan(0);
    const after = await jobRow(job.id);
    expect(after.state).not.toBe("FAILED");
    // And the user cannot start another one.
    expect(await codeOf(start(await loadProductConfig(ctx.db), c.userId, await interpretationFor(c.userId)))).toBe("BETA_ACCESS_REQUIRED");
  });

  it("private_beta_enabled off: SEARCHING stops before any provider, budget or attempt — the job ends FAILED with a named reason", async () => {
    const { job } = await phasedJob();
    await setPrivateBetaConfig(ctx.db, { enabled: false });
    const calls = recordingProviders();
    const out = await dispatchResearchQueueMessage(ROLE_A, job.id);
    expect(out.kind).toBe("PHASED");
    if (out.kind === "PHASED") expect(out.result).toEqual({ ran: false, refusal: "JOB_NOT_RUNNABLE" });
    expect(total(calls)).toBe(0);
    const after = await jobRow(job.id);
    expect(after.state).toBe("FAILED");
    expect(after.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
    expect(after.errorCode).toBe("PrivateBetaLiveRefusedError");
    expect(after.searchQueriesReserved).toBe(0);
    expect(after.sourceOpensReserved).toBe(0);
    expect(after.modelCostMicroReserved).toBe(0);
    expect(await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, job.id))).toHaveLength(0);
  });

  it("FETCHING asks again: the switch closing, or the project leaving the beta list, stops continuation", async () => {
    for (const close of [
      () => setPrivateBetaConfig(ctx.db, { enabled: false }),
      () => setPrivateBetaConfig(ctx.db, { projectSlugs: ["raydium", "lido"] }),
    ]) {
      const { job } = await phasedJob();
      await ctx.db.update(researchJobs).set({ acquisitionPhase: "FETCHING", state: "RUNNING" }).where(eq(researchJobs.id, job.id));
      await close();
      const result = await dispatchFetchQueueMessage(ROLE_B, job.id);
      expect(result).toEqual({ ran: false, refusal: "JOB_NOT_RUNNABLE" });
      const after = await jobRow(job.id);
      expect(after.state).toBe("FAILED");
      expect(after.errorCode).toBe("PrivateBetaLiveRefusedError");
      expect(after.sourceOpensReserved).toBe(0);
    }
  });

  it("beta switch off stops NEW phased jobs too", async () => {
    const c = await betaUser();
    await openBeta({ phased: true });
    await setPrivateBetaConfig(ctx.db, { enabled: false });
    expect(await codeOf(start(await loadProductConfig(ctx.db), c.userId, await interpretationFor(c.userId)))).toBe("RESEARCH_DISABLED");
    expect(await jobsOf(c.userId)).toHaveLength(0);
  });
});

describe("6. the Interpreter spends provider budget only for an admitted user during private beta", () => {
  it("beta on: a signed-in USER without a grant is refused before any model call; a grant holder and the owner are served", async () => {
    await openBeta();
    const plain = await makeAuthedClient("USER");
    const res = await interpretPOST(post("/api/interpretations", plain, { question: QUESTION }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("BETA_ACCESS_REQUIRED");
    expect(await ctx.db.select().from(interpretations).where(eq(interpretations.userId, plain.userId))).toHaveLength(0);
    // A refusal is not a model failure: had the model been reached, this
    // scripted failure would have surfaced instead of the access code.
    __failNextCalls(1);
    const again = await interpretPOST(post("/api/interpretations", plain, { question: QUESTION }));
    expect(await errorOf(again)).toBe("BETA_ACCESS_REQUIRED");
    __failNextCalls(0);

    const granted = await betaUser();
    const ok = await interpretPOST(post("/api/interpretations", granted, { question: QUESTION }));
    expect(ok.status).toBe(201);
    const admin = await makeAuthedClient("ADMIN");
    expect((await interpretPOST(post("/api/interpretations", admin, { question: QUESTION }))).status).toBe(201);
  });

  it("the clarification call is refused the same way", async () => {
    const config = await openBeta();
    const c = await betaUser();
    const [parent] = await ctx.db
      .insert(interpretations)
      .values({ userId: c.userId, originalQuestion: "is it good?", status: "NEEDS_CLARIFICATION", result: { clarification_question: "Which project?" } })
      .returning();
    await revokePrivateBetaAccess(ctx.db, { userId: c.userId });
    const res = await clarifyPOST(post(`/api/interpretations/${parent.id}/clarify`, c, { answer: "Pump.fun" }), { params: Promise.resolve({ id: parent.id }) });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("BETA_ACCESS_REQUIRED");
    expect(await interpreterAccessRefusal(ctx.db, config, c.userId)).toBe("BETA_ACCESS_REQUIRED");
  });

  it("beta off AND public research off (the emergency state, D-170): an ordinary user is refused before the model — switching the beta off never reopens the Interpreter", async () => {
    const plain = await makeAuthedClient("USER");
    expect(await interpreterAccessRefusal(ctx.db, await loadProductConfig(ctx.db), plain.userId)).toBe("RESEARCH_DISABLED");
    const res = await interpretPOST(post("/api/interpretations", plain, { question: QUESTION }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("RESEARCH_DISABLED");
    // The owner keeps the Interpreter, as before.
    const admin = await makeAuthedClient("ADMIN");
    expect(await interpreterAccessRefusal(ctx.db, await loadProductConfig(ctx.db), admin.userId)).toBeNull();
  });

  it("beta on governs the Interpreter even with research_enabled on: an ordinary user without a grant never reaches the model", async () => {
    const plain = await makeAuthedClient("USER");
    await setConfig({ research_enabled: true });
    expect(await interpreterAccessRefusal(ctx.db, await loadProductConfig(ctx.db), plain.userId)).toBeNull();
    const config = await openBeta();
    expect(config.research_enabled).toBe(true);
    expect(await interpreterAccessRefusal(ctx.db, config, plain.userId)).toBe("BETA_ACCESS_REQUIRED");
  });
});

describe("6b. research_enabled can never route a beta user to the PRODUCT path", () => {
  it("public switch on + beta on: a grant holder is admitted PRIVATE_BETA (never PRODUCT); a user without one is refused and no job exists", async () => {
    await setConfig({ research_enabled: true });
    const config = await openBeta();
    expect(privateBetaOpen(config)).toBe(true);

    const granted = await betaUser();
    const res = await jobsPOST(post("/api/research-jobs", granted, { interpretationId: await interpretationFor(granted.userId), idempotencyKey: uniq("idem") }));
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { id: string } };
    const row = await jobRow(job.id);
    expect(row.origin).toBe("PRIVATE_BETA");
    expect(row.budgetAtStart).toEqual(INTERNAL_ALPHA_V1);

    const plain = await makeAuthedClient("USER");
    const refused = await jobsPOST(post("/api/research-jobs", plain, { interpretationId: await interpretationFor(plain.userId), idempotencyKey: uniq("idem") }));
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toBe("BETA_ACCESS_REQUIRED");
    expect(await jobsOf(plain.userId)).toHaveLength(0);

    // The preview agrees with the route in this state too.
    const preview = async (userId: string) =>
      (await evaluateGates(ctx.db, config, { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [BETA_PROJECT] })).research;
    expect(await preview(plain.userId)).toBe("BETA_ACCESS_REQUIRED");
    expect(await preview(granted.userId)).toBe("ACTIVE_JOB_EXISTS");
    const fresh = await betaUser();
    expect(await preview(fresh.userId)).toBe("AVAILABLE");
    // And no PRODUCT job was created for any beta-era user.
    for (const u of [granted, plain, fresh]) {
      expect((await jobsOf(u.userId)).filter((j) => j.origin === "PRODUCT")).toHaveLength(0);
    }
  });
});

describe("7. the Ask preview is the admission decision, not a second opinion", () => {
  const previewOf = async (config: ProductConfig, userId: string, slug = BETA_PROJECT) =>
    (await evaluateGates(ctx.db, config, { userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [slug] })).research;

  it("for every case the preview says exactly what POST will do", async () => {
    const config = await openBeta();
    const cases: { name: string; user: Authed; slug: string; expected: string; setup?: () => Promise<unknown> }[] = [];
    const ok = await betaUser();
    cases.push({ name: "grant + allowed project + remaining cap", user: ok, slug: BETA_PROJECT, expected: "AVAILABLE" });
    cases.push({ name: "no grant", user: await makeAuthedClient("USER"), slug: BETA_PROJECT, expected: "BETA_ACCESS_REQUIRED" });
    cases.push({ name: "project outside the list", user: await betaUser(), slug: "aave", expected: "BETA_PROJECT_NOT_AVAILABLE" });
    const capped = await betaUser();
    for (let i = 0; i < 5; i += 1) await finishWithProof((await start(config, capped.userId, await interpretationFor(capped.userId))).job.id, capped.userId);
    cases.push({ name: "cap reached", user: capped, slug: BETA_PROJECT, expected: "BETA_RESEARCH_LIMIT_REACHED" });
    const busy = await betaUser();
    await start(config, busy.userId, await interpretationFor(busy.userId));
    cases.push({ name: "one already running", user: busy, slug: BETA_PROJECT, expected: "ACTIVE_JOB_EXISTS" });

    for (const c of cases) {
      const preview = await previewOf(config, c.user.userId, c.slug);
      expect(preview, c.name).toBe(c.expected);
      const outcome = await codeOf(start(config, c.user.userId, await interpretationFor(c.user.userId, c.slug)));
      expect(outcome, c.name).toBe(c.expected === "AVAILABLE" ? "ADMITTED" : c.expected);
      // The client consumes the verdict: the button and its note agree.
      const subject = { interpretation: { status: "READY" as const, route: "DEEP_RESEARCH" as const }, gates: { research: preview } };
      expect(canStartProof(subject as never), c.name).toBe(c.expected === "AVAILABLE");
      expect(proofBlockReason(subject as never), c.name).toBe(c.expected === "AVAILABLE" ? null : c.expected);
    }
  });

  it("the preview through the Interpreter route carries the same verdict, and beta off still says DISABLED", async () => {
    await openBeta();
    const c = await betaUser();
    const res = await interpretPOST(post("/api/interpretations", c, { question: QUESTION }));
    const body = (await res.json()) as { gates: { research: string } };
    expect(body.gates.research).toBe("AVAILABLE");
    await setPrivateBetaConfig(ctx.db, { enabled: false });
    await __resetRuntime();
    expect(await previewOf(await loadProductConfig(ctx.db), c.userId)).toBe("DISABLED");
  });

  it("the project roster offers a beta user only what admission will accept", async () => {
    await openBeta();
    const granted = await betaUser();
    const plain = await makeAuthedClient("USER");
    const rosterOf = async (c: Authed) => ((await (await projectsGET(get("/api/projects", c))).json()) as { projects: { slug: string; researchable: boolean }[] }).projects;
    const mine = await rosterOf(granted);
    expect(mine.filter((p) => p.researchable).map((p) => p.slug).sort()).toEqual([...WAVE_1].sort());
    expect((await rosterOf(plain)).some((p) => p.researchable)).toBe(false);
  });

  it("each refusal has its own words, in both languages", () => {
    for (const dict of [en, ru]) {
      const texts = [dict.ask.betaAccessRequired, dict.ask.betaProjectNotAvailable, dict.ask.betaResearchLimitReached, dict.ask.disabledNote, dict.ask.coreRequired];
      for (const t of texts) expect(typeof t === "string" && t.length > 10).toBe(true);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });
});

describe("8. ownership and privacy are untouched", () => {
  it("user B cannot read, cancel, mark, stream, audit or open the sources of user A's private-beta Research", async () => {
    await openBeta();
    const a = await betaUser();
    const b = await betaUser();
    const res = await jobsPOST(post("/api/research-jobs", a, { interpretationId: await interpretationFor(a.userId), idempotencyKey: uniq("idem") }));
    const { job } = (await res.json()) as { job: { id: string } };
    const params = { params: Promise.resolve({ id: job.id }) };
    const evidenceId = "00000000-0000-4000-8000-000000000001";

    // The owner reads their own.
    expect((await jobDetailGET(get(`/api/research-jobs/${job.id}`, a), params)).status).toBe(200);
    expect(((await (await jobsGET(get("/api/research-jobs", a))).json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(job.id);

    // The other user gets "not found" everywhere, never the row.
    expect((await jobDetailGET(get(`/api/research-jobs/${job.id}`, b), params)).status).toBe(404);
    expect((await cancelPOST(post(`/api/research-jobs/${job.id}/cancel`, b, {}), params)).status).toBe(404);
    expect((await readPOST(post(`/api/research-jobs/${job.id}/read`, b, {}), params)).status).toBe(404);
    expect((await eventsGET(get(`/api/research-jobs/${job.id}/events`, b), params)).status).toBe(404);
    // The audit routes answer a non-owner exactly as they answer "no audit
    // exists": nothing, and no model call is spent preparing one.
    expect(await (await auditGET(get(`/api/research-jobs/${job.id}/audit`, b), params)).json()).toEqual({ audit: null });
    expect(await (await auditPOST(post(`/api/research-jobs/${job.id}/audit`, b, {}), params)).json()).toEqual({ audit: null });
    const projections = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM research_audit_projections WHERE research_job_id = ${job.id}`);
    expect((projections.rows[0] as { n: number }).n).toBe(0);
    expect((await snapshotGET(get(`/api/research-jobs/${job.id}/snapshots/${evidenceId}`, b), { params: Promise.resolve({ id: job.id, evidenceId }) })).status).toBe(404);
    expect(((await (await jobsGET(get("/api/research-jobs", b))).json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id)).not.toContain(job.id);

    // B's failed cancel changed nothing; A's job is still A's and still queued.
    const after = await jobRow(job.id);
    expect(after.state).toBe("QUEUED");
    expect(after.userId).toBe(a.userId);

    // B cannot replay A's request to obtain A's job either.
    const stolen = await jobsPOST(post("/api/research-jobs", b, { interpretationId: await interpretationFor(a.userId), idempotencyKey: uniq("idem") }));
    expect(stolen.status).toBe(409);
    expect(await jobsOf(b.userId)).toHaveLength(0);
  });

  it("an ADMIN has no route into a beta user's Research either: ownership is the only key", async () => {
    await openBeta();
    const a = await betaUser();
    const admin = await makeAuthedClient("ADMIN");
    const { job } = (await (await jobsPOST(post("/api/research-jobs", a, { interpretationId: await interpretationFor(a.userId), idempotencyKey: uniq("idem") }))).json()) as { job: { id: string } };
    expect((await jobDetailGET(get(`/api/research-jobs/${job.id}`, admin), { params: Promise.resolve({ id: job.id }) })).status).toBe(404);
  });
});

describe("9. the queue: only a newly enqueued message runs", () => {
  it("old QUEUED rows with no queue message stay inert through every startup sweep", async () => {
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const [project] = await ctx.db.select().from(projects).where(eq(projects.slug, BETA_PROJECT));
    const inert: string[] = [];
    for (const origin of ["PRODUCT", "PRIVATE_BETA", "OWNER_OBSERVATION"] as const) {
      const [user] = await ctx.db.insert(users).values({}).returning();
      const { job } = await createResearchJob(
        ctx.db,
        ctx.boss,
        {
          userId: user.id,
          topicId: topic.id,
          projectId: project.id,
          originalQuestion: QUESTION,
          normalizedTask: { project_slug: BETA_PROJECT, project_slugs: [BETA_PROJECT], task: "inert" },
          normalizedTaskHash: uniq("hash"),
          idempotencyKey: uniq("idem"),
          entitlement: coreEntitlement(),
          demoLifetimeProofLimit: 3,
          origin,
        },
        { skipEnqueue: true },
      );
      inert.push(job.id);
    }
    await openBeta();
    expect(await sweepStaleRunningJobs(ctx.db)).toBe(0);
    expect(await reconcileExhaustedPhaseDeliveries(ctx.db)).toBe(0);
    for (const id of inert) {
      expect((await jobRow(id)).state).toBe("QUEUED");
      expect(await queued(RESEARCH_QUEUE, id)).toBe(0);
    }
    // The worker's startup performs exactly those sweeps: nothing in it
    // selects QUEUED rows or enqueues work for them.
    const worker = readFileSync("src/server/jobs/worker.ts", "utf-8");
    const startup = worker.slice(worker.indexOf("export async function startWorker()"));
    expect(startup).not.toMatch(/state\s*=\s*'QUEUED'|"QUEUED"|enqueueResearchJob/);
  });
});

describe("10. cross-job reuse stays public chain data only", () => {
  it("PRIVATE_BETA is a Research-acquisition origin; an operator observation still is not", () => {
    expect([...REAL_RESEARCH_ACQUISITION_ORIGINS].sort()).toEqual(["OWNER_MANUAL_ALPHA", "PRIVATE_BETA", "PRODUCT"]);
  });

  it("another user's beta Research can reuse only the public supply reading — never the first user's question, evidence or job", async () => {
    const slug = uniq("chain");
    const mint = "Mint1".padEnd(44, "z");
    const [project] = await ctx.db.insert(projects).values({ slug, name: "Chain Fixture", status: "ACTIVE_CORE" }).returning();
    const identity = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: mint });
    expect(identity.ok).toBe(true);
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const userIds: string[] = [];
    const jobFor = async (question: string) => {
      const [user] = await ctx.db.insert(users).values({}).returning();
      userIds.push(user.id);
      const { job } = await createResearchJob(
        ctx.db,
        ctx.boss,
        {
          userId: user.id,
          topicId: topic.id,
          projectId: project.id,
          originalQuestion: question,
          normalizedTask: { project_slug: slug, project_slugs: [slug], task: question },
          normalizedTaskHash: uniq("hash"),
          idempotencyKey: uniq("idem"),
          entitlement: coreEntitlement(),
          demoLifetimeProofLimit: 3,
          origin: "PRIVATE_BETA",
        },
        { skipEnqueue: true },
      );
      return job.id;
    };
    const SECRET = "user A's private question about a secret thesis";
    const jobA = await jobFor(SECRET);
    const jobB = await jobFor("user B asks something else");
    const intent: OnchainIntent = { kind: "TOKEN_SUPPLY", chain: "solana", network: "mainnet", projectAnchor: mint, subjectKind: "token", subject: mint };
    const result = { kind: "TOKEN_SUPPLY" as const, mint, amountRaw: "5000", decimals: 6 };
    const stored = await persistOnchainArtifactAndFacts({
      db: ctx.db,
      jobId: jobA,
      artifact: brandOnchainArtifact({
        intent,
        canonicalUri: buildCanonicalOnchainUri(intent),
        result,
        normalizedText: JSON.stringify(result),
        provenance: {
          chain: "solana",
          network: "mainnet",
          projectAnchor: mint,
          subjectKind: "token",
          subject: mint,
          slot: 100,
          blockTime: 1_700_000_000,
          blockHash: null,
          finality: "finalized",
          retrievalMethod: "RPC",
          providerId: "fixture",
          providerMethod: "fixture",
          requestParams: { subject: mint },
          retrievedAt: new Date("2026-09-03T00:00:00.000Z"),
          rawResponseHash: "sha256:raw:beta",
          artifactHash: "sha256:art:beta",
          transactionSignature: null,
        },
      }),
      identity: { chain: "solana", tokenAddress: mint, ticker: null },
      target: { step: 7, component: "NET_EFFECT" },
    });
    expect(stored.rejectedReason).toBeNull();

    const seenByB = await loadHistoricalSupplyCandidates(ctx.db, { currentResearchJobId: jobB, projectAnchor: mint, chain: "solana", network: "mainnet", beforeSlot: 500 });
    expect(seenByB).toHaveLength(1);
    // What crosses is the public chain reading with its provenance (the
    // artifact, and the id of the job that read it — exactly as for owner
    // jobs today). Nothing of user A's Research content or identity does:
    // not the question, not the user.
    const serialized = JSON.stringify(seenByB);
    expect(serialized).toContain("5000");
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(userIds[0]);
    expect(Object.keys(seenByB[0]).sort()).toEqual(["observation", "onchainArtifactId"]);
    expect(Object.keys(seenByB[0].observation).sort()).toEqual(["artifact", "originKind", "researchJobId"]);
    expect(seenByB[0].observation.artifact.result).toEqual(result);
    // A job never reads its own head reading as history.
    expect(await loadHistoricalSupplyCandidates(ctx.db, { currentResearchJobId: jobA, projectAnchor: mint, chain: "solana", network: "mainnet", beforeSlot: 500 })).toHaveLength(0);
  });
});

describe("11. the migration and the scope of the change", () => {
  it("0063 only adds the PRIVATE_BETA origin value", () => {
    const sqlText = readFileSync("src/server/db/migrations/0063_private_beta_job_origin.sql", "utf-8");
    const statements = sqlText.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim().length > 0);
    expect(statements).toEqual([`ALTER TYPE "public"."research_job_origin" ADD VALUE IF NOT EXISTS 'PRIVATE_BETA';`]);
    const journal = JSON.parse(readFileSync("src/server/db/migrations/meta/_journal.json", "utf-8")) as { entries: { idx: number; tag: string }[] };
    // Entry 63 is this migration; later migrations may follow it.
    expect(journal.entries.find((e: { idx: number }) => e.idx === 63)).toMatchObject({ idx: 63, tag: "0063_private_beta_job_origin" });
  });

  it("no new role, no new table: the role enum is unchanged and admission never reads or writes a role", () => {
    expect(readFileSync("src/server/db/schema/enums.ts", "utf-8")).toContain('export const userRole = pgEnum("user_role", ["USER", "ADMIN"]);');
    for (const file of ["src/server/services/start-private-beta-research.ts", "src/server/jobs/private-beta-routing.ts"]) {
      const code = readFileSync(file, "utf-8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code, file).not.toMatch(/\brole\b|ADMIN/);
    }
  });

  it("the evaluation used by enforcement and preview is one function", async () => {
    const config = await openBeta();
    const c = await makeAuthedClient("USER");
    expect(await evaluatePrivateBetaAdmission(ctx.db, config, { userId: c.userId, projectSlugs: [BETA_PROJECT] })).toBe("BETA_ACCESS_REQUIRED");
    expect(readFileSync("src/server/services/gates.ts", "utf-8")).toContain("evaluatePrivateBetaAdmission(");
    expect(readFileSync("src/server/services/start-private-beta-research.ts", "utf-8")).toContain("evaluatePrivateBetaAdmission(");
  });
});
