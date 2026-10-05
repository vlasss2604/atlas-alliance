import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { POST as feedbackPOST } from "../app/api/beta-feedback/route";
import { GET as intakeGET } from "../app/api/intakes/[id]/route";
import { POST as interpretPOST } from "../app/api/interpretations/route";
import { DELETE as meDELETE, GET as meGET } from "../app/api/me/route";
import { POST as invitePOST } from "../app/api/private-beta/invite/route";
import { GET as jobDetailGET } from "../app/api/research-jobs/[id]/route";
import { GET as jobsGET, POST as jobsPOST } from "../app/api/research-jobs/route";
import { betaInviteFromStartParam } from "../src/client/beta-invite-launch";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { intakeIdFromStartParam } from "../src/client/intake-launch";
import { startParamOf } from "../src/server/auth/authenticate";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { createSession } from "../src/server/auth/session";
import { DEFAULT_PRODUCT_CONFIG, INTERNAL_ALPHA_V1, loadProductConfig, productConfigSchema } from "../src/server/config/product";
import {
  interpretations,
  productConfig,
  proofs,
  researchBetaFeedback,
  researchJobs,
  subscriptions,
  topics,
  users,
} from "../src/server/db/schema";
import { __setInterpreterGateway, type InterpreterGateway } from "../src/server/interpreter/gateway";
import { fakeGateway } from "../src/server/interpreter/fake";
import { transitionJobState } from "../src/server/jobs/research-jobs";
import { __resetRuntime } from "../src/server/runtime";
import { feedbackDue } from "../src/server/services/beta-feedback";
import { evaluateGates } from "../src/server/services/gates";
import {
  countPrivateBetaAdmissions,
  countPrivateBetaJobs,
  evaluatePrivateBetaAdmission,
  grantPrivateBetaAccess,
  hasValidPrivateBetaGrant,
  countCreatorBetaUsers,
  countInviteRedemptions,
  newBetaInviteToken,
  PRIVATE_BETA_GRANT_PROVIDER,
  redeemBetaInvite,
  revokePrivateBetaAccess,
  setPrivateBetaConfig,
} from "../src/server/services/private-beta";
import { createResearchIntake } from "../src/server/services/research-intake";
import { startPrivateBetaResearch } from "../src/server/services/start-private-beta-research";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-170 — CREATOR BETA LAUNCH GUARDRAILS, offline.
//
// Global capacity (every admitted PRIVATE_BETA job, permanently, under one
// advisory lock), the Interpreter refusing before the model when no
// Research could follow, the creator invite writing the ordinary beta grant
// for the signed-in user only, the 3-Research allowance on /api/me, and the
// one-time feedback prompt after the second Proof. No live provider, no
// Telegram call: the Interpreter gateway is a recording wrapper around the
// deterministic fake.

const ORIGIN = "https://app.atlas.test";
const PROJECT = "raydium";
let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.MODEL_GATEWAY = "fake";
  ctx = await setupTestDatabase();
  await openBeta();
});

afterAll(async () => {
  __setInterpreterGateway(null);
  await __resetRuntime();
  await ctx.close();
});

afterEach(async () => {
  __setInterpreterGateway(null);
  await openBeta();
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function openBeta(
  patch: { researchLimit?: number; globalResearchLimit?: number; enabled?: boolean; creatorUserLimit?: number } = {},
) {
  await setPrivateBetaConfig(ctx.db, {
    enabled: patch.enabled ?? true,
    projectSlugs: [PROJECT],
    researchLimit: patch.researchLimit ?? 3,
    globalResearchLimit: patch.globalResearchLimit ?? 60,
    // Roomy unless a test sets exact headroom: many tests here redeem invites.
    creatorUserLimit: patch.creatorUserLimit ?? 10_000,
  });
  await ctx.db
    .insert(productConfig)
    .values({ key: "research_enabled", value: false })
    .onConflictDoUpdate({ target: productConfig.key, set: { value: false } });
  await __resetRuntime();
  return loadProductConfig(ctx.db);
}

interface Authed {
  cookie: string;
  csrf: string;
  userId: string;
}
async function authedUser(role: "USER" | "ADMIN" = "USER"): Promise<Authed> {
  const [u] = await ctx.db.insert(users).values({ role, language: "EN" }).returning();
  const { rawToken } = await createSession(ctx.db, u.id);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { cookie: `atlas_session=${rawToken}`, csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!), userId: u.id };
}
async function betaUser(): Promise<Authed> {
  const c = await authedUser();
  await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(30) });
  return c;
}
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
const get = (path: string, c: Authed): Request =>
  new Request(`http://localhost${path}`, { method: "GET", headers: { cookie: c.cookie, origin: ORIGIN } });
const post = (path: string, c: Authed | null, body: unknown, method = "POST"): Request =>
  new Request(`http://localhost${path}`, {
    method,
    headers: c
      ? { "content-type": "application/json", cookie: c.cookie, origin: ORIGIN, "x-atlas-csrf": c.csrf }
      : { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

async function interpretationFor(userId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(interpretations)
    .values({
      userId,
      originalQuestion: "Does Raydium buy back RAY with protocol fees?",
      status: "READY",
      result: { project_slug: PROJECT, project_slugs: [PROJECT], research_task: "trace fee revenue to the token", route: "DEEP_RESEARCH" },
    })
    .returning();
  return row.id;
}

async function startHttp(c: Authed): Promise<Response> {
  return jobsPOST(post("/api/research-jobs", c, { interpretationId: await interpretationFor(c.userId), idempotencyKey: uniq("idem") }));
}
async function startedJobId(c: Authed): Promise<string> {
  const res = await startHttp(c);
  expect(res.status).toBe(201);
  return ((await res.json()) as { job: { id: string } }).job.id;
}
async function withProof(jobId: string, userId: string): Promise<void> {
  const [row] = await ctx.db.select({ projectId: researchJobs.projectId, topicId: researchJobs.topicId }).from(researchJobs).where(eq(researchJobs.id, jobId));
  await transitionJobState(ctx.db, jobId, "RUNNING", "test: pick up");
  await transitionJobState(ctx.db, jobId, "SUCCEEDED", "test: finished with a Proof");
  await ctx.db.insert(proofs).values({ researchJobId: jobId, ownerUserId: userId, projectId: row.projectId!, topicId: row.topicId, verdict: "SUPPORTED", confidence: 70, layers: {} });
}
async function failAfterStart(jobId: string): Promise<void> {
  await transitionJobState(ctx.db, jobId, "RUNNING", "test: pick up");
  await transitionJobState(ctx.db, jobId, "FAILED", "test: provider failure");
}

// Admitted PRIVATE_BETA jobs of other users, in terminal states, so the
// global count can be brought to an exact value without touching anyone's
// active slot. Every state counts globally; none is active.
async function fillAdmitted(n: number, states: ("FAILED" | "CANCELLED" | "SUCCEEDED" | "BUDGET_LIMIT_REACHED")[] = ["FAILED", "CANCELLED", "SUCCEEDED"]) {
  if (n <= 0) return;
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [filler] = await ctx.db.insert(users).values({ role: "USER" }).returning();
  await ctx.db.insert(researchJobs).values(
    Array.from({ length: n }, (_, i) => ({
      userId: filler.id,
      topicId: topic.id,
      originalQuestion: "filler",
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("fill"),
      entitlementAtStart: "ARI_CORE" as const,
      capabilityAtStart: "FRESH_RESEARCH" as const,
      budgetAtStart: INTERNAL_ALPHA_V1,
      origin: "PRIVATE_BETA" as const,
      state: states[i % states.length],
    })),
  );
}
async function setGlobalHeadroom(headroom: number): Promise<number> {
  const limit = (await countPrivateBetaAdmissions(ctx.db)) + headroom;
  await openBeta({ globalResearchLimit: limit });
  return limit;
}

// Interpreter transport recorder: delegates to the deterministic fake and
// counts every call that would have been a provider call.
function recordingGateway(): { gateway: InterpreterGateway; calls: () => number } {
  let n = 0;
  return {
    gateway: { name: "recording", interpret: (input, model) => ((n += 1), fakeGateway.interpret(input, model)) },
    calls: () => n,
  };
}

/* ------------------------------------------------------------------ */
/* A. global capacity                                                  */
/* ------------------------------------------------------------------ */

describe("A. global creator-beta capacity counts every admitted job and is a hard boundary", () => {
  it("59 admitted → the next starts; 60 admitted → the next is refused, nothing is created, the personal allowance is untouched", async () => {
    await openBeta({ globalResearchLimit: 60 });
    await fillAdmitted(59 - (await countPrivateBetaAdmissions(ctx.db)));
    expect(await countPrivateBetaAdmissions(ctx.db)).toBe(59);

    const first = await betaUser();
    await startedJobId(first); // the 60th admitted job
    expect(await countPrivateBetaAdmissions(ctx.db)).toBe(60);

    const second = await betaUser();
    const before = await countPrivateBetaJobs(ctx.db, second.userId);
    const res = await startHttp(second);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("GLOBAL_BETA_CAPACITY_REACHED");
    expect(await countPrivateBetaAdmissions(ctx.db)).toBe(60);
    expect(await ctx.db.select().from(researchJobs).where(eq(researchJobs.userId, second.userId))).toHaveLength(0);
    expect(await countPrivateBetaJobs(ctx.db, second.userId)).toBe(before);
    const me = (await (await meGET(get("/api/me", second))).json()) as { privateBeta: { remaining: number } };
    expect(me.privateBeta.remaining).toBe(3);
  });

  it("failed, cancelled, succeeded and stopped-at-budget admitted jobs all count globally — while FAILED returns the personal slot", async () => {
    const limit = await setGlobalHeadroom(2);
    const c = await betaUser();
    const failed = await startedJobId(c);
    await failAfterStart(failed);
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(0); // personal: returned (D-169)
    const cancelled = await startedJobId(c);
    await transitionJobState(ctx.db, cancelled, "CANCELLED", "test: cancelled while queued");
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(0); // personal: never started
    expect(await countPrivateBetaAdmissions(ctx.db)).toBe(limit); // global: both count
    const res = await startHttp(c);
    expect(await errorOf(res)).toBe("GLOBAL_BETA_CAPACITY_REACHED");

    const extra = await countPrivateBetaAdmissions(ctx.db);
    await fillAdmitted(2, ["BUDGET_LIMIT_REACHED", "SUCCEEDED"]);
    expect(await countPrivateBetaAdmissions(ctx.db)).toBe(extra + 2);
  });

  it("concurrent starts cannot exceed the cap: 8 users racing for 3 remaining places admit exactly 3", async () => {
    const limit = await setGlobalHeadroom(3);
    const config = await loadProductConfig(ctx.db);
    const racers = await Promise.all(Array.from({ length: 8 }, () => betaUser()));
    const inputs = await Promise.all(racers.map(async (r) => ({ userId: r.userId, interpretationId: await interpretationFor(r.userId), idempotencyKey: uniq("race") })));
    const outcomes = await Promise.allSettled(inputs.map((i) => startPrivateBetaResearch(ctx.db, ctx.boss, config, i)));
    const admitted = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(admitted).toHaveLength(3);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect((r.reason as { code?: string }).code).toBe("GLOBAL_BETA_CAPACITY_REACHED");
    expect(await countPrivateBetaAdmissions(ctx.db)).toBe(limit);
  });

  it("the Ask preview and the admission rule name the same capacity condition; an idempotent replay of an admitted start is not refused", async () => {
    const c = await betaUser();
    await setGlobalHeadroom(1);
    const interpretationId = await interpretationFor(c.userId);
    const key = uniq("idem");
    const ok = await jobsPOST(post("/api/research-jobs", c, { interpretationId, idempotencyKey: key }));
    expect(ok.status).toBe(201);
    const config = await loadProductConfig(ctx.db);
    expect(await evaluatePrivateBetaAdmission(ctx.db, config, { userId: c.userId, projectSlugs: [PROJECT] })).toBe("GLOBAL_BETA_CAPACITY_REACHED");
    const preview = await evaluateGates(ctx.db, config, { userId: c.userId, status: "READY", route: "DEEP_RESEARCH", projectSlugs: [PROJECT] });
    expect(preview.research).toBe("GLOBAL_BETA_CAPACITY_REACHED");
    const replay = await jobsPOST(post("/api/research-jobs", c, { interpretationId, idempotencyKey: key }));
    expect(replay.status).toBe(200);
  });

  it("an absent capacity row fails closed (0), an invalid one fails the config parse, and 60 is the seeded value, not an admission constant", async () => {
    const bare = productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, private_beta_global_research_limit: undefined });
    expect(bare.private_beta_global_research_limit).toBe(0);
    expect(() => productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, private_beta_global_research_limit: -1 })).toThrow();
    expect(() => productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, private_beta_global_research_limit: "60" })).toThrow();
    expect(DEFAULT_PRODUCT_CONFIG.private_beta_global_research_limit).toBe(60);
    expect(DEFAULT_PRODUCT_CONFIG.private_beta_research_limit).toBe(3);
    for (const file of ["src/server/services/private-beta.ts", "src/server/services/start-private-beta-research.ts", "src/server/services/gates.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\b60\b/);
    }
    // Absent row in the database → no new beta Research.
    await ctx.db.delete(productConfig).where(eq(productConfig.key, "private_beta_global_research_limit"));
    await __resetRuntime();
    const c = await betaUser();
    expect(await errorOf(await startHttp(c))).toBe("GLOBAL_BETA_CAPACITY_REACHED");
  });
});

/* ------------------------------------------------------------------ */
/* B. Interpreter safety                                               */
/* ------------------------------------------------------------------ */

describe("B. no paid Interpreter call that cannot lead to Research", () => {
  const QUESTION = "Does Raydium buy back RAY with protocol fees?";

  it("global capacity reached: a beta user is refused before the model — zero transport calls", async () => {
    await setGlobalHeadroom(0);
    const rec = recordingGateway();
    __setInterpreterGateway(rec.gateway);
    const c = await betaUser();
    const res = await interpretPOST(post("/api/interpretations", c, { question: QUESTION }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("GLOBAL_BETA_CAPACITY_REACHED");
    expect(rec.calls()).toBe(0);
  });

  it("personal allowance used up: refused before the model with the existing personal refusal — zero transport calls; one left: served", async () => {
    await setGlobalHeadroom(10);
    await openBeta({ researchLimit: 1, globalResearchLimit: (await countPrivateBetaAdmissions(ctx.db)) + 10 });
    const rec = recordingGateway();
    __setInterpreterGateway(rec.gateway);
    const c = await betaUser();
    expect((await interpretPOST(post("/api/interpretations", c, { question: QUESTION }))).status).toBe(201);
    expect(rec.calls()).toBe(1);
    await withProof(await startedJobId(c), c.userId); // the one Research is spent
    const res = await interpretPOST(post("/api/interpretations", c, { question: QUESTION }));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("BETA_RESEARCH_LIMIT_REACHED");
    expect(rec.calls()).toBe(1); // no second transport call
    // A FAILED run returns the slot (D-169), so the Interpreter reopens.
    const other = await betaUser();
    await failAfterStart(await startedJobId(other));
    expect((await interpretPOST(post("/api/interpretations", other, { question: QUESTION }))).status).toBe(201);
    expect(rec.calls()).toBe(2);
  });

  it("emergency state (beta off, public research off): grant holders and plain users are refused — zero transport calls", async () => {
    await openBeta({ enabled: false });
    const rec = recordingGateway();
    __setInterpreterGateway(rec.gateway);
    for (const c of [await betaUser(), await authedUser()]) {
      const res = await interpretPOST(post("/api/interpretations", c, { question: QUESTION }));
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("RESEARCH_DISABLED");
    }
    expect(rec.calls()).toBe(0);
  });

  it("a valid beta user below capacity interprets normally (one transport call)", async () => {
    await setGlobalHeadroom(5);
    const rec = recordingGateway();
    __setInterpreterGateway(rec.gateway);
    const c = await betaUser();
    const res = await interpretPOST(post("/api/interpretations", c, { question: QUESTION }));
    expect(res.status).toBe(201);
    expect(rec.calls()).toBe(1);
  });

  it("the owner (ADMIN) keeps the Interpreter at capacity and in the emergency state", async () => {
    const rec = recordingGateway();
    __setInterpreterGateway(rec.gateway);
    const admin = await authedUser("ADMIN");
    await setGlobalHeadroom(0);
    expect((await interpretPOST(post("/api/interpretations", admin, { question: QUESTION }))).status).toBe(201);
    await openBeta({ enabled: false });
    expect((await interpretPOST(post("/api/interpretations", admin, { question: QUESTION }))).status).toBe(201);
    expect(rec.calls()).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* C. creator invite                                                   */
/* ------------------------------------------------------------------ */

describe("C. the creator invite writes the ordinary beta grant, for the signed-in user only", () => {
  async function configureInvite(opts: { enabled?: boolean; grantUntil?: Date; maxRedemptions?: number } = {}): Promise<string> {
    const { token, sha256 } = newBetaInviteToken();
    await setPrivateBetaConfig(ctx.db, {
      invite: {
        enabled: opts.enabled ?? true,
        sha256,
        grantUntil: (opts.grantUntil ?? inDays(60)).toISOString(),
        maxRedemptions: opts.maxRedemptions ?? 20,
      },
    });
    await __resetRuntime();
    return `beta_${token}`;
  }
  const redeem = (c: Authed | null, body: unknown) => invitePOST(post("/api/private-beta/invite", c, body));
  const betaRows = (userId: string) =>
    ctx.db.select().from(subscriptions).where(sql`${subscriptions.userId} = ${userId} AND ${subscriptions.billingProvider} = ${PRIVATE_BETA_GRANT_PROVIDER}`);

  it("unauthenticated cannot redeem, and nothing (no user, no grant) is created", async () => {
    const invite = await configureInvite();
    const usersBefore = (await ctx.db.select({ id: users.id }).from(users)).length;
    const res = await redeem(null, { invite });
    expect(res.status).toBe(401);
    expect((await ctx.db.select({ id: users.id }).from(users)).length).toBe(usersBefore);
  });

  it("a valid invite grants the canonical beta entitlement to the session's user, role unchanged; repeating is idempotent", async () => {
    const invite = await configureInvite();
    const c = await authedUser();
    const res = await redeem(c, { invite });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "GRANTED" });
    expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(true);
    const [row] = await betaRows(c.userId);
    expect(row).toMatchObject({ level: "ARI_CORE", status: "ACTIVE", autoRenew: false, billingProvider: PRIVATE_BETA_GRANT_PROVIDER });
    expect((await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, c.userId)))[0].role).toBe("USER");

    const again = await redeem(c, { invite });
    expect(await again.json()).toEqual({ result: "ALREADY_GRANTED" });
    const rows = await betaRows(c.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].validUntil.getTime()).toBe(row.validUntil.getTime());
    // And the grant admits through the same beta path as a manual grant.
    await setGlobalHeadroom(1);
    await startedJobId(c);
  });

  it("a client cannot grant another user by supplying an id", async () => {
    const invite = await configureInvite();
    const caller = await authedUser();
    const victim = await authedUser();
    const res = await redeem(caller, { invite, userId: victim.userId, telegramId: "12345" });
    expect(res.status).toBe(200);
    expect(await hasValidPrivateBetaGrant(ctx.db, caller.userId)).toBe(true);
    expect(await hasValidPrivateBetaGrant(ctx.db, victim.userId)).toBe(false);
    expect(await betaRows(victim.userId)).toHaveLength(0);
  });

  it("an invalid, disabled or expired invite is refused with one answer and grants nothing", async () => {
    const valid = await configureInvite();
    const c = await authedUser();
    for (const wrong of ["beta_" + "A".repeat(32), "nonsense", valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A")]) {
      const res = await redeem(c, { invite: wrong });
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("INVITE_INVALID");
    }
    const disabled = await configureInvite({ enabled: false });
    expect(await errorOf(await redeem(c, { invite: disabled }))).toBe("INVITE_INVALID");
    const expired = await configureInvite({ grantUntil: inDays(-1) });
    expect(await errorOf(await redeem(c, { invite: expired }))).toBe("INVITE_INVALID");
    expect(await betaRows(c.userId)).toHaveLength(0);
  });

  it("an existing manual beta user stays valid and is never re-dated; a revoked user cannot re-grant themselves", async () => {
    const invite = await configureInvite({ grantUntil: inDays(10) });
    const manual = await authedUser();
    await grantPrivateBetaAccess(ctx.db, { userId: manual.userId, validUntil: inDays(90) });
    expect(await (await redeem(manual, { invite })).json()).toEqual({ result: "ALREADY_GRANTED" });
    const [kept] = await betaRows(manual.userId);
    expect(kept.validUntil.getTime()).toBeGreaterThan(inDays(80).getTime());

    const revoked = await betaUser();
    await revokePrivateBetaAccess(ctx.db, { userId: revoked.userId });
    const res = await redeem(revoked, { invite });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("INVITE_NOT_APPLICABLE");
    expect(await hasValidPrivateBetaGrant(ctx.db, revoked.userId)).toBe(false);
  });

  async function creatorHeadroom(n: number): Promise<number> {
    const limit = (await countCreatorBetaUsers(ctx.db)) + n;
    await setPrivateBetaConfig(ctx.db, { creatorUserLimit: limit });
    await __resetRuntime();
    return limit;
  }
  const inviteFor = async (maxRedemptions: number) => {
    const { token, sha256 } = newBetaInviteToken();
    const value = { enabled: true, sha256, grantUntil: inDays(30).toISOString(), maxRedemptions };
    const config = { ...(await loadProductConfig(ctx.db)), private_beta_invite: value };
    return { invite: `beta_${token}`, sha256, config };
  };

  it("Wave 1 bound on ONE invite: the first 20 distinct users are granted, the 21st is told access is full; a repeat by a granted user consumes nothing", async () => {
    await creatorHeadroom(20);
    const invite = await configureInvite({ maxRedemptions: 20 });
    const sha = (await loadProductConfig(ctx.db)).private_beta_invite.sha256;
    const granted: Authed[] = [];
    for (let i = 0; i < 20; i += 1) {
      const c = await authedUser();
      expect(await (await redeem(c, { invite })).json()).toEqual({ result: "GRANTED" });
      granted.push(c);
    }
    expect(await countInviteRedemptions(ctx.db, sha)).toBe(20);
    const late = await authedUser();
    const res = await redeem(late, { invite });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("BETA_ACCESS_FULL");
    expect(await hasValidPrivateBetaGrant(ctx.db, late.userId)).toBe(false);
    // The same granted user again: idempotent, no slot used.
    expect(await (await redeem(granted[0], { invite })).json()).toEqual({ result: "ALREADY_GRANTED" });
    expect(await countInviteRedemptions(ctx.db, sha)).toBe(20);
    // Revoking a granted user does not free a slot, and they cannot come back.
    await revokePrivateBetaAccess(ctx.db, { userId: granted[1].userId });
    expect(await countInviteRedemptions(ctx.db, sha)).toBe(20);
    expect(await errorOf(await redeem(granted[1], { invite }))).toBe("INVITE_NOT_APPLICABLE");
    expect(await errorOf(await redeem(await authedUser(), { invite }))).toBe("BETA_ACCESS_FULL");
    // Everyone granted before the bound stays valid.
    for (const c of granted.filter((_, i) => i !== 1)) expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(true);
    // A manually granted user is not an invite redemption and does not count.
    const manual = await betaUser();
    expect(await (await redeem(manual, { invite })).json()).toEqual({ result: "ALREADY_GRANTED" });
    expect(await countInviteRedemptions(ctx.db, sha)).toBe(20);
    expect(en.home.betaAccessFull).toBe("Private beta access is currently full.");
    expect(ru.home.betaAccessFull).toBeTruthy();
  });

  it("per-invite bound still holds under concurrency: 12 users racing one invite for 5 places, plus one user racing itself, grant exactly 5", async () => {
    await creatorHeadroom(1_000);
    const { invite, sha256, config } = await inviteFor(5);
    const racers = await Promise.all(Array.from({ length: 12 }, () => authedUser()));
    const twice = racers[0];
    const out = await Promise.allSettled([...racers, twice, twice].map((r) => redeemBetaInvite(ctx.db, config, { userId: r.userId, invite })));
    const granted = out.filter((o) => o.status === "fulfilled" && o.value === "GRANTED").length;
    const full = out.filter((o) => o.status === "rejected" && (o.reason as { reason?: string }).reason === "BETA_ACCESS_FULL").length;
    expect(granted).toBe(5);
    expect(await countInviteRedemptions(ctx.db, sha256)).toBe(5);
    expect(granted + full + out.filter((o) => o.status === "fulfilled" && o.value === "ALREADY_GRANTED").length).toBe(14);
    expect((await ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, twice.userId))).length).toBeLessThanOrEqual(1);
  });

  it("the creator ceiling is TOTAL across tokens: 20 users spread over three invites, then the next distinct user on any invite is refused", async () => {
    await creatorHeadroom(20);
    const before = await countCreatorBetaUsers(ctx.db);
    const tokens = [await inviteFor(20), await inviteFor(20), await inviteFor(20)];
    for (let i = 0; i < 20; i += 1) {
      const t = tokens[i % 3];
      expect(await redeemBetaInvite(ctx.db, t.config, { userId: (await authedUser()).userId, invite: t.invite })).toBe("GRANTED");
    }
    expect(await countCreatorBetaUsers(ctx.db)).toBe(before + 20);
    for (const t of tokens) {
      // Each invite is far under its own 20, yet the wave is full.
      expect(await countInviteRedemptions(ctx.db, t.sha256)).toBeLessThan(20);
      await expect(redeemBetaInvite(ctx.db, t.config, { userId: (await authedUser()).userId, invite: t.invite })).rejects.toMatchObject({ reason: "BETA_ACCESS_FULL" });
    }
    const fresh = await inviteFor(20); // a brand-new token does not reopen the wave
    await expect(redeemBetaInvite(ctx.db, fresh.config, { userId: (await authedUser()).userId, invite: fresh.invite })).rejects.toMatchObject({ reason: "BETA_ACCESS_FULL" });
  });

  it("one user redeeming several tokens takes one creator slot; revoked and expired creator users keep theirs; manual grants take none", async () => {
    const limit = await creatorHeadroom(3);
    const a = await inviteFor(20);
    const b = await inviteFor(20);
    const user = await authedUser();
    expect(await redeemBetaInvite(ctx.db, a.config, { userId: user.userId, invite: a.invite })).toBe("GRANTED");
    expect(await redeemBetaInvite(ctx.db, b.config, { userId: user.userId, invite: b.invite })).toBe("ALREADY_GRANTED");
    expect(await countCreatorBetaUsers(ctx.db)).toBe(limit - 2);

    const revoked = await authedUser();
    expect(await redeemBetaInvite(ctx.db, a.config, { userId: revoked.userId, invite: a.invite })).toBe("GRANTED");
    await revokePrivateBetaAccess(ctx.db, { userId: revoked.userId });
    const expired = await authedUser();
    expect(await redeemBetaInvite(ctx.db, b.config, { userId: expired.userId, invite: b.invite })).toBe("GRANTED");
    await ctx.db.update(subscriptions).set({ validUntil: inDays(-1) }).where(eq(subscriptions.userId, expired.userId));
    expect(await countCreatorBetaUsers(ctx.db)).toBe(limit); // still counted

    // Neither can come back through another token, and the wave stays full.
    await expect(redeemBetaInvite(ctx.db, b.config, { userId: revoked.userId, invite: b.invite })).rejects.toMatchObject({ reason: "INVITE_NOT_APPLICABLE" });
    await expect(redeemBetaInvite(ctx.db, a.config, { userId: expired.userId, invite: a.invite })).rejects.toMatchObject({ reason: "INVITE_NOT_APPLICABLE" });
    await expect(redeemBetaInvite(ctx.db, a.config, { userId: (await authedUser()).userId, invite: a.invite })).rejects.toMatchObject({ reason: "BETA_ACCESS_FULL" });

    // Manual owner grants are outside the creator ceiling and still work when it is full.
    const manual = await betaUser();
    expect(await hasValidPrivateBetaGrant(ctx.db, manual.userId)).toBe(true);
    expect(await countCreatorBetaUsers(ctx.db)).toBe(limit);
    expect(await redeemBetaInvite(ctx.db, a.config, { userId: manual.userId, invite: a.invite })).toBe("ALREADY_GRANTED");
    expect(await countCreatorBetaUsers(ctx.db)).toBe(limit);
  });

  it("concurrent redemptions across DIFFERENT tokens cannot exceed the creator ceiling", async () => {
    await creatorHeadroom(5);
    const before = await countCreatorBetaUsers(ctx.db);
    const tokens = [await inviteFor(10), await inviteFor(10), await inviteFor(10)];
    const racers = await Promise.all(Array.from({ length: 15 }, () => authedUser()));
    const out = await Promise.allSettled(
      racers.map((r, i) => redeemBetaInvite(ctx.db, tokens[i % 3].config, { userId: r.userId, invite: tokens[i % 3].invite })),
    );
    expect(out.filter((o) => o.status === "fulfilled" && o.value === "GRANTED")).toHaveLength(5);
    expect(out.filter((o) => o.status === "rejected" && (o.reason as { reason?: string }).reason === "BETA_ACCESS_FULL")).toHaveLength(10);
    expect(await countCreatorBetaUsers(ctx.db)).toBe(before + 5);
  });

  it("the creator ceiling fails closed: absent → 0, invalid → the config parse fails; 20 is the seeded value", async () => {
    expect(productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, private_beta_creator_user_limit: undefined }).private_beta_creator_user_limit).toBe(0);
    expect(() => productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, private_beta_creator_user_limit: -1 })).toThrow();
    expect(() => productConfigSchema.parse({ ...DEFAULT_PRODUCT_CONFIG, private_beta_creator_user_limit: 2.5 })).toThrow();
    expect(DEFAULT_PRODUCT_CONFIG.private_beta_creator_user_limit).toBe(20);
    expect(readFileSync("src/server/services/private-beta.ts", "utf8")).not.toMatch(/\b20\b/);
    const invite = await configureInvite({ maxRedemptions: 20 });
    await ctx.db.delete(productConfig).where(eq(productConfig.key, "private_beta_creator_user_limit"));
    await __resetRuntime();
    expect(await errorOf(await redeem(await authedUser(), { invite }))).toBe("BETA_ACCESS_FULL");
  });

  it("an invite stored without a redemption bound reads 0 and grants nobody", async () => {
    const { token, sha256 } = newBetaInviteToken();
    await ctx.db
      .insert(productConfig)
      .values({ key: "private_beta_invite", value: { enabled: true, sha256, grantUntil: inDays(10).toISOString() } })
      .onConflictDoUpdate({ target: productConfig.key, set: { value: { enabled: true, sha256, grantUntil: inDays(10).toISOString() } } });
    await __resetRuntime();
    expect(await errorOf(await redeem(await authedUser(), { invite: `beta_${token}` }))).toBe("BETA_ACCESS_FULL");
  });

  it("the launch value is opaque, carries no PII, is stored only as a hash, and never collides with the D-168 intake launch", async () => {
    const { token, sha256 } = newBetaInviteToken();
    const launch = `beta_${token}`;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(launch.length).toBeLessThanOrEqual(64);
    expect(startParamOf({ start_param: launch })).toBe(launch); // survives signed-initData parsing
    expect(betaInviteFromStartParam(launch)).toBe(launch);
    expect(intakeIdFromStartParam(launch)).toBeNull();
    const intakeId = "3f1c9a2e-8b7d-4c6e-9f0a-1b2c3d4e5f60";
    expect(intakeIdFromStartParam(intakeId)).toBe(intakeId);
    expect(betaInviteFromStartParam(intakeId)).toBeNull();
    await setPrivateBetaConfig(ctx.db, { invite: { enabled: true, sha256, grantUntil: inDays(5).toISOString(), maxRedemptions: 20 } });
    const [stored] = await ctx.db.select().from(productConfig).where(eq(productConfig.key, "private_beta_invite"));
    expect(JSON.stringify(stored.value)).not.toContain(token);
    // The redeem request names nothing but the invite.
    const api = readFileSync("src/client/api.ts", "utf8");
    expect(api).toContain('JSON.stringify({ invite })');
  });
});

/* ------------------------------------------------------------------ */
/* D. the 3-Research allowance on /api/me                              */
/* ------------------------------------------------------------------ */

describe("D. Private Beta · N Research remaining, by the D-169 count", () => {
  const remaining = async (c: Authed) =>
    ((await (await meGET(get("/api/me", c))).json()) as { privateBeta: { used: number; limit: number; remaining: number } | null }).privateBeta;

  it("3 → 2 → 1 → 0; FAILED and no-Proof runs do not decrement; a cancel after start does", async () => {
    await setGlobalHeadroom(20);
    const c = await betaUser();
    expect(await remaining(c)).toEqual({ used: 0, limit: 3, remaining: 3 });
    await withProof(await startedJobId(c), c.userId);
    expect((await remaining(c))!.remaining).toBe(2);
    await failAfterStart(await startedJobId(c));
    expect((await remaining(c))!.remaining).toBe(2);
    const noProof = await startedJobId(c);
    await transitionJobState(ctx.db, noProof, "RUNNING", "test");
    await transitionJobState(ctx.db, noProof, "SUCCEEDED", "test: no proof");
    expect((await remaining(c))!.remaining).toBe(2);
    await withProof(await startedJobId(c), c.userId);
    expect((await remaining(c))!.remaining).toBe(1);
    const cancelled = await startedJobId(c);
    await transitionJobState(ctx.db, cancelled, "RUNNING", "test: pick up");
    await transitionJobState(ctx.db, cancelled, "CANCELLED", "test: user cancel after start");
    expect(await remaining(c)).toEqual({ used: 3, limit: 3, remaining: 0 });
    expect(await errorOf(await startHttp(c))).toBe("BETA_RESEARCH_LIMIT_REACHED");
  });

  it("reopening the Library and Proofs, and forwarding or opening an intake, never decrement", async () => {
    await setGlobalHeadroom(5);
    const c = await betaUser();
    const jobId = await startedJobId(c);
    await withProof(jobId, c.userId);
    const before = await remaining(c);
    expect((await jobsGET(get("/api/research-jobs", c))).status).toBe(200);
    expect((await jobDetailGET(get(`/api/research-jobs/${jobId}`, c), { params: Promise.resolve({ id: jobId }) })).status).toBe(200);
    const { intake } = await createResearchIntake(ctx.db, {
      userId: c.userId, origin: "TELEGRAM_FORWARD", rawText: "Raydium burns RAY", sourceLabel: null, sourceUrl: null, detectedProjectSlug: PROJECT, externalRef: uniq("tg"),
    });
    expect((await intakeGET(get(`/api/intakes/${intake.id}`, c), { params: Promise.resolve({ id: intake.id }) })).status).toBe(200);
    expect(await remaining(c)).toEqual(before);
  });

  it("only a beta-admitted user sees it; the owner and a plain user do not; the screens say Private Beta, not ARI • CORE", async () => {
    expect(await remaining(await authedUser("ADMIN"))).toBeNull();
    expect(await remaining(await authedUser())).toBeNull();
    const c = await betaUser();
    const me = (await (await meGET(get("/api/me", c))).json()) as { entitlement: { level: string }; privateBeta: unknown };
    expect(me.entitlement.level).toBe("ARI_CORE"); // the grant's storage level
    expect(me.privateBeta).not.toBeNull(); // what the screens show instead
    expect(en.home.betaLabel).toBe("Private Beta");
    expect(en.home.betaRemaining(3)).toBe("3 Research remaining");
    expect(ru.home.betaRemaining(1)).toContain("1");
    const profile = readFileSync("app/(app)/profile/page.tsx", "utf8");
    expect(profile.indexOf("me.privateBeta")).toBeLessThan(profile.indexOf('"ARI • CORE"'));
    expect(readFileSync("app/(app)/home/page.tsx", "utf8")).toContain("dict.home.betaRemaining(me.privateBeta.remaining)");
    expect(en.ask.globalBetaCapacity).toBe("Private beta is at capacity for now. Your previous Research is still available in your Research Library.");
    expect(ru.ask.globalBetaCapacity).toBe("Сейчас лимит private beta исчерпан. Ваши предыдущие Research по-прежнему доступны в Research Library.");
    for (const copy of [en.ask.globalBetaCapacity, ru.ask.globalBetaCapacity]) expect(copy).not.toMatch(/CORE|Pro\b|buy|купи/i);
  });
});

/* ------------------------------------------------------------------ */
/* F. feedback after the second Proof                                  */
/* ------------------------------------------------------------------ */

describe("F. the one-time feedback prompt", () => {
  const due = async (c: Authed) => ((await (await meGET(get("/api/me", c))).json()) as { feedbackDue: boolean }).feedbackDue;
  const send = (c: Authed, body: unknown) => feedbackPOST(post("/api/beta-feedback", c, body));
  async function userWithProofs(n: number): Promise<Authed> {
    await setGlobalHeadroom(10);
    const c = await betaUser();
    for (let i = 0; i < n; i += 1) await withProof(await startedJobId(c), c.userId);
    return c;
  }

  it("not due at signup, not after one Proof, due after the second", async () => {
    const c = await betaUser();
    expect(await due(c)).toBe(false);
    await setGlobalHeadroom(10);
    await withProof(await startedJobId(c), c.userId);
    expect(await due(c)).toBe(false);
    await failAfterStart(await startedJobId(c)); // a failed run is not a Proof
    expect(await due(c)).toBe(false);
    await withProof(await startedJobId(c), c.userId);
    expect(await due(c)).toBe(true);
  });

  it("submission stores bounded, trimmed answers and suppresses the prompt; a second write is refused", async () => {
    const c = await userWithProofs(2);
    const res = await send(c, { action: "SUBMIT", useful: "  the verdict  ", missing: "more projects", keepUsing: "NO", changeNeeded: "faster", userId: "x", telegramUsername: "@x" });
    expect(res.status).toBe(201);
    const [row] = await ctx.db.select().from(researchBetaFeedback).where(eq(researchBetaFeedback.userId, c.userId));
    expect(row).toMatchObject({ status: "SUBMITTED", useful: "the verdict", missing: "more projects", keepUsing: "NO", changeNeeded: "faster" });
    expect(Object.keys(row).sort()).toEqual(["changeNeeded", "createdAt", "id", "keepUsing", "missing", "status", "useful", "userId"]);
    expect(await due(c)).toBe(false);
    expect(await errorOf(await send(c, { action: "DISMISS" }))).toBe("FEEDBACK_ALREADY_RECORDED");
  });

  it("dismissal is permanent and stores no answers", async () => {
    const c = await userWithProofs(2);
    expect((await send(c, { action: "DISMISS" })).status).toBe(201);
    const [row] = await ctx.db.select().from(researchBetaFeedback).where(eq(researchBetaFeedback.userId, c.userId));
    expect(row).toMatchObject({ status: "DISMISSED", useful: null, missing: null, keepUsing: null, changeNeeded: null });
    expect(await due(c)).toBe(false);
    expect(await errorOf(await send(c, { action: "SUBMIT", keepUsing: "YES" }))).toBe("FEEDBACK_ALREADY_RECORDED");
  });

  it("validation: not due, missing answer to question 3, unknown value, over-long text — all refused, nothing stored", async () => {
    const early = await betaUser();
    expect(await errorOf(await send(early, { action: "SUBMIT", keepUsing: "YES" }))).toBe("FEEDBACK_NOT_DUE");
    const c = await userWithProofs(2);
    expect((await send(c, { action: "SUBMIT" })).status).toBe(400);
    expect((await send(c, { action: "SUBMIT", keepUsing: "MAYBE" })).status).toBe(400);
    expect(await errorOf(await send(c, { action: "SUBMIT", keepUsing: "YES", useful: "x".repeat(1001) }))).toBe("FEEDBACK_TOO_LONG");
    expect(await ctx.db.select().from(researchBetaFeedback).where(eq(researchBetaFeedback.userId, c.userId))).toHaveLength(0);
    // The database bound is the backstop.
    await expect(ctx.db.insert(researchBetaFeedback).values({ userId: c.userId, status: "SUBMITTED", keepUsing: "YES", useful: "y".repeat(1001) })).rejects.toThrow();
  });

  it("a user can neither read nor write another user's feedback; there is no read route at all", async () => {
    const a = await userWithProofs(2);
    const b = await authedUser();
    expect((await send(a, { action: "SUBMIT", keepUsing: "YES", useful: "A's answer" })).status).toBe(201);
    expect(await errorOf(await send(b, { action: "SUBMIT", keepUsing: "NO", userId: a.userId }))).toBe("FEEDBACK_NOT_DUE");
    const [row] = await ctx.db.select().from(researchBetaFeedback).where(eq(researchBetaFeedback.userId, a.userId));
    expect(row.useful).toBe("A's answer");
    const route = readFileSync("app/api/beta-feedback/route.ts", "utf8");
    expect(route).not.toMatch(/export async function GET/);
  });

  it("feedback never touches the allowance, and account deletion removes it", async () => {
    const c = await userWithProofs(2);
    const before = { personal: await countPrivateBetaJobs(ctx.db, c.userId), global: await countPrivateBetaAdmissions(ctx.db) };
    await send(c, { action: "SUBMIT", keepUsing: "UNSURE" });
    expect({ personal: await countPrivateBetaJobs(ctx.db, c.userId), global: await countPrivateBetaAdmissions(ctx.db) }).toEqual(before);
    expect(await feedbackDue(ctx.db, c.userId)).toBe(false);
    expect((await meDELETE(post("/api/me", c, {}, "DELETE"))).status).toBe(200);
    expect(await ctx.db.select().from(researchBetaFeedback).where(eq(researchBetaFeedback.userId, c.userId))).toHaveLength(0);
  });

  it("the prompt is mounted only on a finished Result with a Proof when due, with Send feedback and Skip", () => {
    const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf8");
    expect(page).toContain("{finished && detail.proof && me?.feedbackDue && <BetaFeedbackPrompt />}");
    expect(en.feedback.send).toBe("Send feedback");
    expect(en.feedback.skip).toBe("Skip");
    expect([en.feedback.useful, en.feedback.missing, en.feedback.keepUsing, en.feedback.changeNeeded]).toEqual([
      "What was useful?",
      "What was missing or what would you add?",
      "Would you keep using ATLAS?",
      "If not, what would need to change?",
    ]);
    for (const k of ["useful", "missing", "keepUsing", "changeNeeded", "send", "skip"] as const) expect(ru.feedback[k]).toBeTruthy();
    // Never at signup: onboarding does not mount it.
    expect(readFileSync("app/onboarding/page.tsx", "utf8")).not.toContain("BetaFeedbackPrompt");
  });
});
