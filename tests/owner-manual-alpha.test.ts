import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GET as jobDetailGET } from "../app/api/research-jobs/[id]/route";
import { POST as jobsPOST } from "../app/api/research-jobs/route";
import { POST as interpretPOST } from "../app/api/interpretations/route";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { createSession } from "../src/server/auth/session";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import {
  productConfig,
  projects,
  researchJobs,
  topics,
  users,
} from "../src/server/db/schema";
import { __clearFakeScripts, __failNextCalls } from "../src/server/interpreter/fake";
import {
  OwnerAlphaLiveRefusedError,
  resolveOwnerAlphaWorkExecutor,
} from "../src/server/jobs/owner-alpha-routing";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { __resetRuntime } from "../src/server/runtime";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

const ORIGIN = "https://app.atlas.test";
let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.MODEL_GATEWAY = "fake";
  ctx = await setupTestDatabase();
  await __resetRuntime();
  // Owner Manual Alpha App Test — this stage's whole point is testing the
  // path that is reachable ONLY while the public gate stays closed.
  await setConfig("research_enabled", false);
  await setConfig("internal_alpha_enabled", false);
});

afterAll(async () => {
  await __resetRuntime();
  await ctx.close();
});

afterEach(() => {
  __clearFakeScripts();
  __failNextCalls(0);
});

async function setConfig(key: string, value: unknown) {
  await ctx.db
    .insert(productConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: productConfig.key, set: { value } });
  await __resetRuntime();
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
  return {
    cookie: `atlas_session=${rawToken}`,
    csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!),
    userId: u.id,
  };
}

function req(path: string, c: Authed, body: unknown, method = "POST"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: c.cookie,
      origin: ORIGIN,
      "x-atlas-csrf": c.csrf,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

function getReq(path: string, c: Authed): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: { cookie: c.cookie, origin: ORIGIN },
  });
}

async function readyInterpretation(c: Authed, question: string): Promise<string> {
  const res = await interpretPOST(req("/api/interpretations", c, { question }));
  const body = (await res.json()) as { interpretation: { id: string; status: string } };
  expect(body.interpretation.status).toBe("READY");
  return body.interpretation.id;
}

describe("Owner Manual PUMP App Test (D-123)", () => {
  it("A. normal user + research_enabled=false → still rejected", async () => {
    const c = await makeAuthedClient("USER");
    const interpretationId = await readyInterpretation(c, "Does Pump.fun revenue reach token holders?");
    const res = await jobsPOST(
      req("/api/research-jobs", c, { interpretationId, idempotencyKey: uniq("idem") }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("RESEARCH_DISABLED");
  });

  it("B. ADMIN owner-manual-alpha request → passes the public gate, job persists origin=OWNER_MANUAL_ALPHA", async () => {
    const c = await makeAuthedClient("ADMIN");
    const interpretationId = await readyInterpretation(c, "Does Pump.fun revenue reach token holders?");
    const res = await jobsPOST(
      req("/api/research-jobs", c, { interpretationId, idempotencyKey: uniq("idem") }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { id: string } };
    const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, body.job.id));
    expect(row.origin).toBe("OWNER_MANUAL_ALPHA");
    expect(row.userId).toBe(c.userId);
  });

  it("B2. interpretation preview (drives the real Proof button): ADMIN sees research=AVAILABLE, USER still DISABLED (D-124)", async () => {
    await setConfig("internal_alpha_enabled", true);
    try {
      const admin = await makeAuthedClient("ADMIN");
      const adminRes = await interpretPOST(
        req("/api/interpretations", admin, { question: "Does Pump.fun revenue reach token holders?" }),
      );
      const adminBody = (await adminRes.json()) as {
        interpretation: { status: string; route: string };
        gates: { research: string; scope: string; entitlement: string };
      };
      expect(adminBody.interpretation.status).toBe("READY");
      expect(adminBody.interpretation.route).toBe("DEEP_RESEARCH");
      // Exactly what ask/page.tsx's canStart reads — no client-side ADMIN
      // special-casing needed, the server preview already says AVAILABLE.
      expect(adminBody.gates.research).toBe("AVAILABLE");

      const user = await makeAuthedClient("USER");
      const userRes = await interpretPOST(
        req("/api/interpretations", user, { question: "Does Pump.fun revenue reach token holders?" }),
      );
      const userBody = (await userRes.json()) as { gates: { research: string } };
      expect(userBody.gates.research).toBe("DISABLED");
    } finally {
      await setConfig("internal_alpha_enabled", false);
    }
  });

  it("C. owner job + internal_alpha_enabled=false → live execution refused", async () => {
    const [pumpProject] = await ctx.db.select().from(projects).where(eq(projects.slug, "pump_fun"));
    const [admin] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
    await expect(
      resolveOwnerAlphaWorkExecutor({
        db: ctx.db,
        job: { userId: admin.id, origin: "OWNER_MANUAL_ALPHA" },
        project: pumpProject,
        internalAlphaEnabled: false,
      }),
    ).rejects.toThrow(/internal_alpha_enabled/);
  });

  it("D. owner job + project not in allowlist → live execution refused", async () => {
    const [offAllowlist] = await ctx.db
      .insert(projects)
      .values({ slug: uniq("not_allowlisted"), name: "Not Allowlisted", status: "ACTIVE_CORE" })
      .returning();
    const [admin] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
    await expect(
      resolveOwnerAlphaWorkExecutor({
        db: ctx.db,
        job: { userId: admin.id, origin: "OWNER_MANUAL_ALPHA" },
        project: offAllowlist,
        internalAlphaEnabled: true,
      }),
    ).rejects.toThrow(OwnerAlphaLiveRefusedError);
  });

  it("D2. non-ADMIN actor at execution time → live execution refused even if job is marked owner-manual-alpha", async () => {
    const [pumpProject] = await ctx.db.select().from(projects).where(eq(projects.slug, "pump_fun"));
    const [demoted] = await ctx.db.insert(users).values({ role: "USER" }).returning();
    await expect(
      resolveOwnerAlphaWorkExecutor({
        db: ctx.db,
        job: { userId: demoted.id, origin: "OWNER_MANUAL_ALPHA" },
        project: pumpProject,
        internalAlphaEnabled: true,
      }),
    ).rejects.toThrow(OwnerAlphaLiveRefusedError);
  });

  it("E. owner job + pump_fun + internal_alpha_enabled=true → worker resolves a live executor (no real provider calls)", async () => {
    const [pumpProject] = await ctx.db.select().from(projects).where(eq(projects.slug, "pump_fun"));
    const [admin] = await ctx.db.insert(users).values({ role: "ADMIN" }).returning();
    // Resolves without throwing — constructing the live executor never
    // itself performs a network call (createS4WorkExecutor only wires
    // resolvers; the first real provider call would happen inside
    // runS4ResearchJob, which this test deliberately never invokes).
    const executor = await resolveOwnerAlphaWorkExecutor({
      db: ctx.db,
      job: { userId: admin.id, origin: "OWNER_MANUAL_ALPHA" },
      project: pumpProject,
      internalAlphaEnabled: true,
    });
    expect(executor).toBeDefined();
  });

  it("F. a normal PRODUCT job never selects the live path, even with internal_alpha_enabled=true", async () => {
    await setConfig("internal_alpha_enabled", true);
    try {
      const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
      const [project] = await ctx.db
        .insert(projects)
        .values({ slug: uniq("product_job_project"), name: "Product Job Project", status: "ACTIVE_CORE" })
        .returning();
      const [user] = await ctx.db.insert(users).values({ role: "USER" }).returning();
      const { job } = await createResearchJob(ctx.db, ctx.boss, {
        userId: user.id,
        topicId: topic.id,
        projectId: project.id,
        originalQuestion: "does protocol revenue reach token holders?",
        normalizedTask: {
          project_slug: project.slug,
          project_slugs: [project.slug],
          task: "does protocol revenue reach token holders",
        },
        normalizedTaskHash: uniq("hash"),
        idempotencyKey: uniq("idem"),
        entitlement: coreEntitlement(),
        demoLifetimeProofLimit: 3,
        // origin intentionally omitted — defaults to "PRODUCT".
      });
      const [row] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, job.id));
      expect(row.origin).toBe("PRODUCT");

      // Runs to completion via the deterministic zero-network non-live
      // path even though internal_alpha_enabled=true — proves origin,
      // not the config flag, gates the live branch.
      const result = await handleResearchJobTask(ctx.db, job.id);
      expect(result.claimed).toBe(true);
      const [finished] = await ctx.db
        .select({ state: researchJobs.state })
        .from(researchJobs)
        .where(eq(researchJobs.id, job.id));
      expect(["SUCCEEDED", "BUDGET_LIMIT_REACHED", "FAILED"]).toContain(finished.state);
      // A live-executor refusal would surface as errorCode naming the
      // owner-alpha routing module — must never appear for a PRODUCT job.
      const [errRow] = await ctx.db
        .select({ errorCode: researchJobs.errorCode })
        .from(researchJobs)
        .where(eq(researchJobs.id, job.id));
      expect(errRow.errorCode).not.toBe("OwnerAlphaLiveRefusedError");
      expect(errRow.errorCode).not.toBe("InternalAlphaGateClosedError");
    } finally {
      await setConfig("internal_alpha_enabled", false);
    }
  });

  it("G. result-detail endpoint respects authorization (ownership-only)", async () => {
    const owner = await makeAuthedClient("ADMIN");
    const stranger = await makeAuthedClient("USER");
    const interpretationId = await readyInterpretation(owner, "Does Pump.fun revenue reach token holders?");
    const created = await jobsPOST(
      req("/api/research-jobs", owner, { interpretationId, idempotencyKey: uniq("idem") }),
    );
    const { job } = (await created.json()) as { job: { id: string } };

    const ownRes = await jobDetailGET(getReq(`/api/research-jobs/${job.id}`, owner), {
      params: Promise.resolve({ id: job.id }),
    });
    expect(ownRes.status).toBe(200);
    const ownBody = (await ownRes.json()) as { job: { id: string } };
    expect(ownBody.job.id).toBe(job.id);

    const strangerRes = await jobDetailGET(getReq(`/api/research-jobs/${job.id}`, stranger), {
      params: Promise.resolve({ id: job.id }),
    });
    expect(strangerRes.status).toBe(404);
  });

  it("H. result-detail translation dictionaries cover every S7 status and worker termination reason, in both languages", () => {
    const statuses = ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE"];
    const terminations = [
      "BUDGET_EXHAUSTED",
      "WORK_QUEUE_EXHAUSTED",
      "SYSTEM_OR_PROVIDER_FAILURE",
      "CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK",
    ];
    const jobStates = ["QUEUED", "AWAITING_CLARIFICATION", "SUCCEEDED", "CANCELLED", "FAILED", "BUDGET_LIMIT_REACHED"];
    for (const dict of [en, ru]) {
      for (const s of statuses) {
        expect(dict.research.detail.statusLabel[s]).toBeTruthy();
      }
      for (const t of terminations) {
        expect(dict.research.detail.terminationLabel[t]).toBeTruthy();
      }
      for (const st of jobStates) {
        expect(dict.research.states[st]).toBeTruthy();
      }
      // RUNNING is rendered via dict.research.stages (progress-stage text),
      // never dict.research.states — all 5 stages must be present.
      expect(dict.research.stages).toHaveLength(5);
    }
  });
});
