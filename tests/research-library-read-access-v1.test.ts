import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GET as meGET } from "../app/api/me/route";
import { GET as auditGET } from "../app/api/research-jobs/[id]/audit/route";
import { GET as jobDetailGET } from "../app/api/research-jobs/[id]/route";
import { GET as snapshotGET } from "../app/api/research-jobs/[id]/snapshots/[evidenceId]/route";
import { GET as jobsGET, POST as jobsPOST } from "../app/api/research-jobs/route";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { deriveProgress, MEMORY_NOT_CONSULTED_LABEL, RESEARCH_STAGES } from "../src/client/research-model";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { createSession } from "../src/server/auth/session";
import { loadProductConfig } from "../src/server/config/product";
import {
  acquiredDocuments,
  demoQuotaReservations,
  evidence,
  interpretations,
  proofs,
  researchAuditProjections,
  researchJobs,
  sources,
  subscriptions,
  users,
} from "../src/server/db/schema";
import { AUDIT_VERSION } from "../src/server/engine/audit-projection";
import { transitionJobState } from "../src/server/jobs/research-jobs";
import { __resetRuntime } from "../src/server/runtime";
import { resolveEntitlement } from "../src/server/services/entitlement";
import {
  countPrivateBetaJobs,
  grantPrivateBetaAccess,
  hasValidPrivateBetaGrant,
  revokePrivateBetaAccess,
  setPrivateBetaConfig,
} from "../src/server/services/private-beta";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// THE RESEARCH LIBRARY SURVIVES THE ALLOWANCE (D-169).
//
// A USER whose beta grant has expired or been revoked — the account now
// resolves to DEMO, and a NEW Research is refused — can still open their
// own finished Research through every HTTP read the Mini App uses: the
// list, the detail, a source snapshot, the persisted audit. Those reads
// create no job, take no reservation, move no beta count and make no
// provider call. Ownership scoping is untouched: another user still sees
// nothing. Everything here is offline; the fetch guard proves it.

const ORIGIN = "https://app.atlas.test";
const PROJECT = "raydium";
const DOC_URL = "https://docs.raydium.test/fees";
let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.MODEL_GATEWAY = "fake";
  ctx = await setupTestDatabase();
  await setPrivateBetaConfig(ctx.db, { enabled: true, projectSlugs: [PROJECT], researchLimit: 5 });
  await __resetRuntime();
});

afterAll(async () => {
  await __resetRuntime();
  await ctx.close();
});

afterEach(async () => {
  await setPrivateBetaConfig(ctx.db, { enabled: true, projectSlugs: [PROJECT], researchLimit: 5 });
  await __resetRuntime();
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

interface Authed {
  cookie: string;
  csrf: string;
  userId: string;
}
async function authedUser(): Promise<Authed> {
  const [u] = await ctx.db.insert(users).values({ role: "USER", language: "EN" }).returning();
  const { rawToken } = await createSession(ctx.db, u.id);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { cookie: `atlas_session=${rawToken}`, csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!), userId: u.id };
}
const get = (path: string, c: Authed): Request =>
  new Request(`http://localhost${path}`, { method: "GET", headers: { cookie: c.cookie, origin: ORIGIN } });
const post = (path: string, c: Authed, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: c.cookie, origin: ORIGIN, "x-atlas-csrf": c.csrf },
    body: JSON.stringify(body),
  });
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

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

// A finished beta Research with everything the Library reopens: a durable
// Proof, one Evidence row with its source, the acquired document behind it
// (so the snapshot route has something to show) and a persisted audit.
async function finishedResearch(c: Authed): Promise<{ jobId: string; evidenceId: string }> {
  const res = await jobsPOST(post("/api/research-jobs", c, { interpretationId: await interpretationFor(c.userId), idempotencyKey: uniq("idem") }));
  expect(res.status).toBe(201);
  const { job } = (await res.json()) as { job: { id: string } };
  const [row] = await ctx.db.select({ projectId: researchJobs.projectId, topicId: researchJobs.topicId }).from(researchJobs).where(eq(researchJobs.id, job.id));
  await transitionJobState(ctx.db, job.id, "RUNNING", "test: pick up");
  await transitionJobState(ctx.db, job.id, "SUCCEEDED", "test: finished with a Proof");
  await ctx.db.insert(proofs).values({
    researchJobId: job.id,
    ownerUserId: c.userId,
    projectId: row.projectId!,
    topicId: row.topicId,
    verdict: "SUPPORTED",
    confidence: 70,
    layers: {},
  });
  const url = `${DOC_URL}/${uniq("doc")}`;
  const [source] = await ctx.db
    .insert(sources)
    .values({ url, urlHash: createHash("sha256").update(url).digest("hex"), title: "Raydium fees" })
    .returning({ id: sources.id });
  const [ev] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: job.id,
      sourceId: source.id,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: "12% of trading fees are used to buy back RAY.",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CLAIMED",
      entityBinding: "CONFIRMED",
      fetchedAt: new Date(),
      retrievedUrl: url,
      contentHash: "sha256:fixture",
    })
    .returning({ id: evidence.id });
  await ctx.db.insert(acquiredDocuments).values({
    projectId: row.projectId!,
    acquiringJobId: job.id,
    url,
    finalUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    byteLength: 46,
    normalizedText: "12% of trading fees are used to buy back RAY.",
    contentHash: "sha256:fixture",
    textSha256: "0".repeat(64),
    authority: { officiality: "CLAIMED", routeClass: null, matchedPathPrefix: null },
    acquisitionStrategy: "CONTENT_NEGOTIATION",
    admission: "PRODUCT_ACQUISITION",
  });
  await ctx.db.insert(researchAuditProjections).values({
    researchJobId: job.id,
    auditVersion: AUDIT_VERSION,
    status: "VALID",
    content: { summary: "Prepared while the grant was valid.", sectionOrder: [], scopeLabels: [] },
  });
  return { jobId: job.id, evidenceId: ev.id };
}

// Everything a read must leave alone, captured before and compared after.
async function ledgerOf(userId: string) {
  const jobs = (await ctx.db.select({ id: researchJobs.id }).from(researchJobs).where(eq(researchJobs.userId, userId))).length;
  const reservations = (await ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.userId, userId))).length;
  const beta = await countPrivateBetaJobs(ctx.db, userId);
  const queued = ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created','active','retry')`)).rows[0] as { n: number }).n;
  const audits = ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM research_audit_projections`)).rows[0] as { n: number }).n;
  return { jobs, reservations, beta, queued, audits };
}

// No read may leave the process: fetch is replaced for the duration.
async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("network call during a Library read");
  }) as typeof fetch;
  try {
    const out = await fn();
    expect(calls).toBe(0);
    return out;
  } finally {
    globalThis.fetch = real;
  }
}

async function readsAllWork(c: Authed, jobId: string, evidenceId: string) {
  const before = await ledgerOf(c.userId);
  await withNoNetwork(async () => {
    const list = await jobsGET(get("/api/research-jobs", c));
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { jobs: { id: string; verdict: string | null; state: string }[] }).jobs;
    expect(listed.map((j) => j.id)).toContain(jobId);
    expect(listed.find((j) => j.id === jobId)).toMatchObject({ state: "SUCCEEDED", verdict: "SUPPORTED" });

    const detail = await jobDetailGET(get(`/api/research-jobs/${jobId}`, c), params(jobId));
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { job: { id: string; state: string; originalQuestion: string }; proof: { verdict: string } | null };
    expect(body.job).toMatchObject({ id: jobId, state: "SUCCEEDED" });
    expect(body.job.originalQuestion).toContain("Raydium");
    expect(body.proof).toMatchObject({ verdict: "SUPPORTED" });

    const snapshot = await snapshotGET(get(`/api/research-jobs/${jobId}/snapshots/${evidenceId}`, c), { params: Promise.resolve({ id: jobId, evidenceId }) });
    expect(snapshot.status).toBe(200);
    expect(JSON.stringify(await snapshot.json())).toContain("buy back RAY");

    const audit = await auditGET(get(`/api/research-jobs/${jobId}/audit`, c), params(jobId));
    expect(audit.status).toBe(200);
    expect((await audit.json()) as { audit: { status: string } }).toMatchObject({ audit: { status: "VALID" } });
  });
  expect(await ledgerOf(c.userId)).toEqual(before);
}

/* ------------------------------------------------------------------ */

describe("1. an expired grant: the account is DEMO, a new Research is refused, the Library still opens", () => {
  it("list, detail, snapshot and persisted audit all read; nothing is created, reserved, counted or fetched", async () => {
    const c = await authedUser();
    await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(30) });
    const { jobId, evidenceId } = await finishedResearch(c);
    expect(await countPrivateBetaJobs(ctx.db, c.userId)).toBe(1);

    // The grant expires. Entitlement falls to DEMO; the beta gate closes.
    await ctx.db.update(subscriptions).set({ validUntil: inDays(-1) }).where(eq(subscriptions.userId, c.userId));
    expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(false);
    expect((await resolveEntitlement(ctx.db, c.userId, await loadProductConfig(ctx.db))).snapshot.level).toBe("DEMO");
    const me = (await (await meGET(get("/api/me", c))).json()) as { entitlement: { level: string }; memoryEnabled: boolean };
    expect(me.entitlement.level).toBe("DEMO");
    expect(me.memoryEnabled).toBe(false);

    // A NEW Research still goes through admission, and is refused before any job.
    const refused = await jobsPOST(post("/api/research-jobs", c, { interpretationId: await interpretationFor(c.userId), idempotencyKey: uniq("idem") }));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("BETA_ACCESS_REQUIRED");

    await readsAllWork(c, jobId, evidenceId);
    // The finished Research kept what it started under.
    const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(row).toMatchObject({ state: "SUCCEEDED", entitlementAtStart: "ARI_CORE", origin: "PRIVATE_BETA" });
  });

  it("a revoked grant reads the same way", async () => {
    const c = await authedUser();
    await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(30) });
    const { jobId, evidenceId } = await finishedResearch(c);
    expect((await revokePrivateBetaAccess(ctx.db, { userId: c.userId })).revoked).toBe(1);
    expect(await hasValidPrivateBetaGrant(ctx.db, c.userId)).toBe(false);
    await readsAllWork(c, jobId, evidenceId);
  });

  it("with the beta switch off as well, the finished Research is still the owner's to read", async () => {
    const c = await authedUser();
    await grantPrivateBetaAccess(ctx.db, { userId: c.userId, validUntil: inDays(30) });
    const { jobId, evidenceId } = await finishedResearch(c);
    await ctx.db.update(subscriptions).set({ validUntil: inDays(-1) }).where(eq(subscriptions.userId, c.userId));
    await setPrivateBetaConfig(ctx.db, { enabled: false, projectSlugs: [], researchLimit: 5 });
    await __resetRuntime();
    await readsAllWork(c, jobId, evidenceId);
  });
});

describe("2. ownership is untouched by expiry", () => {
  it("another user, with or without a grant, still gets 404 on every read of the expired user's Research", async () => {
    const owner = await authedUser();
    await grantPrivateBetaAccess(ctx.db, { userId: owner.userId, validUntil: inDays(30) });
    const { jobId, evidenceId } = await finishedResearch(owner);
    await ctx.db.update(subscriptions).set({ validUntil: inDays(-1) }).where(eq(subscriptions.userId, owner.userId));
    const stranger = await authedUser();
    const granted = await authedUser();
    await grantPrivateBetaAccess(ctx.db, { userId: granted.userId, validUntil: inDays(30) });
    for (const other of [stranger, granted]) {
      expect((await jobDetailGET(get(`/api/research-jobs/${jobId}`, other), params(jobId))).status).toBe(404);
      expect((await snapshotGET(get(`/api/research-jobs/${jobId}/snapshots/${evidenceId}`, other), { params: Promise.resolve({ id: jobId, evidenceId }) })).status).toBe(404);
      expect(await (await auditGET(get(`/api/research-jobs/${jobId}/audit`, other), params(jobId))).json()).toEqual({ audit: null });
      const listed = ((await (await jobsGET(get("/api/research-jobs", other))).json()) as { jobs: { id: string }[] }).jobs;
      expect(listed.map((j) => j.id)).not.toContain(jobId);
    }
  });
});

describe("3. the Library says what it is, in both languages; the progress rail never claims Memory that is off", () => {
  it("the Research Library copy is in both dictionaries and the screens read it", async () => {
    const { readFileSync } = await import("node:fs");
    expect(en.research.title).toBe("Research Library");
    expect(en.research.keepNote).toBe("Your completed Research stays here. Reopening it never uses another Research.");
    expect(ru.research.keepNote).toBe("Все завершённые исследования сохраняются здесь. Повторное открытие не расходует Research.");
    for (const dict of [en, ru]) {
      for (const key of ["title", "subtitle", "keepNote", "loading", "inProgress", "projectsResearched", "empty"] as const) {
        expect(typeof dict.research[key]).toBe("string");
      }
      for (const key of ["previouslyResearched", "viewAll", "recentEmpty"] as const) {
        expect(typeof dict.home[key]).toBe("string");
      }
      // Deletion copy describes what deletion does: the account's own
      // Research goes; shared sources and project-level Memory remain.
      expect(dict.profile.deleteConfirm1).toMatch(/Research Memory/);
    }
    const list = readFileSync("app/(app)/research/page.tsx", "utf8");
    for (const key of ["dict.research.title", "dict.research.subtitle", "dict.research.keepNote", "dict.research.empty", "dict.research.inProgress", "dict.research.projectsResearched"]) {
      expect(list).toContain(key);
    }
    for (const literal of ["Everything ATLAS has verified", "Nothing here yet", "Projects researched", "In progress"]) {
      expect(list).not.toContain(`>${literal}`);
    }
    const home = readFileSync("app/(app)/home/page.tsx", "utf8");
    for (const key of ["dict.home.previouslyResearched", "dict.home.viewAll", "dict.home.recentEmpty"]) {
      expect(home).toContain(key);
    }
    // No "research again" or refresh action anywhere on the history surfaces.
    for (const file of [list, home, readFileSync("src/client/components/research-result.tsx", "utf8")]) {
      expect(file).not.toMatch(/research again|Research again|refresh|Refresh/);
    }
  });

  it("with Memory off the rail labels the planning step as planning; only an explicit memoryEnabled=true says Memory is checked", () => {
    const running = { state: "RUNNING" as const, progressStage: 2, acquisitionPhase: null };
    const memoryStage = RESEARCH_STAGES.findIndex((s) => s.key === "MEMORY");
    expect(deriveProgress(running).stages[memoryStage].label).toBe(MEMORY_NOT_CONSULTED_LABEL);
    expect(deriveProgress(running, { memoryEnabled: false }).stages[memoryStage].label).toBe(MEMORY_NOT_CONSULTED_LABEL);
    expect(deriveProgress(running, { memoryEnabled: true }).stages[memoryStage].label).toBe("Checking previous research");
    expect(MEMORY_NOT_CONSULTED_LABEL).not.toMatch(/memory|previous|accumulated/i);
    // The other stages are unchanged either way.
    const on = deriveProgress(running, { memoryEnabled: true }).stages.map((s) => s.label);
    const off = deriveProgress(running).stages.map((s) => s.label);
    expect(on.filter((_, i) => i !== memoryStage)).toEqual(off.filter((_, i) => i !== memoryStage));
  });

  it("the Mini App passes the flag from /api/me into the rail, so a deployment with Memory off never shows the recall label", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("app/api/me/route.ts", "utf8")).toContain("memoryEnabled: config.memory_enabled");
    expect(readFileSync("app/(app)/research/[id]/page.tsx", "utf8")).toContain("memoryEnabled={me?.memoryEnabled ?? false}");
    expect(readFileSync("app/(app)/research/page.tsx", "utf8")).toContain("memoryEnabled={me?.memoryEnabled ?? false}");
    expect(readFileSync("app/(app)/home/page.tsx", "utf8")).toContain("memoryEnabled={me?.memoryEnabled ?? false}");
    // Nothing enables Memory: the config default is unchanged.
    expect((await loadProductConfig(ctx.db)).memory_enabled).toBe(false);
  });
});
