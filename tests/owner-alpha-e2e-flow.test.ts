import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as jobDetailGET } from "../app/api/research-jobs/[id]/route";
import { GET as jobsGET, POST as jobsPOST } from "../app/api/research-jobs/route";
import { POST as interpretPOST } from "../app/api/interpretations/route";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { createSession } from "../src/server/auth/session";
import {
  productConfig,
  projects,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  users,
} from "../src/server/db/schema";
import { createNonLiveS4WorkExecutor } from "../src/server/engine/non-live-executor";
import { resolveSearchGateway } from "../src/server/engine/providers/search-gateway";
import { resolveOwnerAlphaWorkExecutor } from "../src/server/jobs/owner-alpha-routing";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { __resetRuntime } from "../src/server/runtime";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// THE OWNER'S REAL BROWSER PATH, END TO END, WITH ZERO LIVE CALLS.
//
// Why this file exists: every seam below already had unit coverage, and
// the owner's actual click still failed. Unit tests prove each link in
// isolation; nothing proved the CHAIN. This walks the real product path in
// order — the same route handlers the browser posts to, the same service
// layer, the same worker entry point, the same result endpoint — so a
// break anywhere between "interpretation is READY" and "the result view
// can render it" fails HERE, before the owner spends a paid live Proof
// discovering it by hand.
//
// Live-call safety is structural, not a promise:
//   * tests/setup-provider-env.ts removes every provider credential from
//     process.env, so no resolver can reach a real provider even by
//     accident (asserted below).
//   * The engine runs under createNonLiveS4WorkExecutor, which supplies
//     all four S4 provider roles AND both cost profiles as fixtures, so
//     s4-executor.ts's preflight never falls back to a production
//     resolver. Its evidence extractor throws if ever invoked.
// Together: zero Anthropic calls, zero Brave calls, zero network.

const ORIGIN = "https://app.atlas.test";
const QUESTION = "Does Pump.fun revenue reach token holders?";

let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  // The interpreter runs off the explicit fake gateway, never a real model.
  process.env.MODEL_GATEWAY = "fake";
  ctx = await setupTestDatabase();
  await __resetRuntime();
  // The exact owner-alpha configuration: the public product gate is CLOSED
  // and the internal alpha path is OPEN. If these two ever stop combining
  // into a usable owner path, this file fails.
  await setConfig("research_enabled", false);
  await setConfig("internal_alpha_enabled", true);
});

afterAll(async () => {
  await __resetRuntime();
  await ctx.close();
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

// A real session + real CSRF token, exactly as /api/auth/telegram would
// mint them — the owner's ADMIN identity, not a mocked session object.
async function makeAuthedClient(role: "USER" | "ADMIN"): Promise<Authed> {
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

describe("owner alpha — real product path end to end (no live providers)", () => {
  it("the whole chain: interpretation READY -> preview gate -> Proof start -> job -> worker -> S4..S7 -> result view", async () => {
    const owner = await makeAuthedClient("ADMIN");

    // ---- 1. Interpretation (real POST /api/interpretations) ------------
    const interpretRes = await interpretPOST(req("/api/interpretations", owner, { question: QUESTION }));
    expect(interpretRes.status).toBe(201);
    const interpretBody = (await interpretRes.json()) as {
      interpretation: { id: string; status: string; route: string };
      gates: { research: string };
    };
    expect(interpretBody.interpretation.status).toBe("READY");
    expect(interpretBody.interpretation.route).toBe("DEEP_RESEARCH");

    // ---- 2. Preview gate MUST agree with what enforcement will do ------
    // This is the specific seam that strands the owner: a READY
    // interpretation whose preview says the Proof button is live, followed
    // by an enforcement path that refuses it. Asserting the preview alone
    // is not enough — step 3 immediately proves enforcement agrees.
    expect(interpretBody.gates.research).toBe("AVAILABLE");

    // ---- 3. Proof start (real POST /api/research-jobs) -----------------
    const startRes = await jobsPOST(
      req("/api/research-jobs", owner, {
        interpretationId: interpretBody.interpretation.id,
        idempotencyKey: uniq("idem"),
      }),
    );
    // Preview said AVAILABLE, so enforcement must create the job. A 403
    // here is exactly the "preview and enforcement disagree" break.
    expect(startRes.status).toBe(201);
    const startBody = (await startRes.json()) as { job: { id: string; state: string } };
    const jobId = startBody.job.id;

    // ---- 4. Persistence: OWNER_MANUAL_ALPHA origin actually stored -----
    const [jobRow] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(jobRow.origin).toBe("OWNER_MANUAL_ALPHA");
    expect(jobRow.userId).toBe(owner.userId);
    expect(jobRow.projectId).toBeTruthy();

    // ---- 5. Owner-alpha worker ROUTING accepts this exact job ----------
    // Resolution only (no execution): proves a real queued owner job is
    // admitted by the live-routing rules — ADMIN actor, allowlisted
    // project, internal alpha open. Execution itself then runs on the
    // non-live executor below, so no provider is ever contacted.
    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, jobRow.projectId!));
    expect(project.slug).toBe("pump_fun");
    await expect(
      resolveOwnerAlphaWorkExecutor({
        db: ctx.db,
        job: { userId: jobRow.userId, origin: jobRow.origin },
        project,
        internalAlphaEnabled: true,
      }),
    ).resolves.toBeTruthy();

    // ---- 6. Worker consumes the queued job (real worker entry point) ---
    const result = await handleResearchJobTask(
      ctx.db,
      jobId,
      createNonLiveS4WorkExecutor({ db: ctx.db, project }),
    );
    expect(result.claimed).toBe(true);

    // ---- 7. The job reached a terminal state, not a stuck/RUNNING one --
    const [afterRow] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(["QUEUED", "RUNNING"]).not.toContain(afterRow.state);
    expect(afterRow.finishedAt).toBeTruthy();
    // An honest evidentiary outcome, never a technical failure: the
    // non-live executor finds no candidates, which is a legitimate
    // research result. A SYSTEM_OR_PROVIDER_FAILURE here means the
    // pipeline broke rather than concluded.
    expect(afterRow.terminationReason).not.toBe("SYSTEM_OR_PROVIDER_FAILURE");

    // ---- 8. S5/S6/S7 projections were produced -------------------------
    const componentRows = await ctx.db
      .select()
      .from(researchComponentResults)
      .where(eq(researchComponentResults.researchJobId, jobId));
    expect(componentRows.length).toBeGreaterThan(0); // S5 ran

    const [claim] = await ctx.db
      .select()
      .from(researchClaimSupport)
      .where(eq(researchClaimSupport.researchJobId, jobId));
    expect(claim).toBeTruthy(); // S7 ran
    expect(claim.status).toBe("INSUFFICIENT_EVIDENCE"); // honest: nothing was fetched

    // ---- 9. The result VIEW can actually read it back ------------------
    // The last mile the owner sees. A result that exists in the DB but
    // cannot be served is still a broken product path.
    const detailRes = await jobDetailGET(getReq(`/api/research-jobs/${jobId}`, owner), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      job: { id: string; state: string; origin: string };
      claimSupport: { status: string } | null;
      evidence: unknown[];
    };
    expect(detail.job.id).toBe(jobId);
    expect(detail.job.origin).toBe("OWNER_MANUAL_ALPHA");
    expect(detail.claimSupport?.status).toBe("INSUFFICIENT_EVIDENCE");

    // ---- 10. And it appears in the owner's job list --------------------
    const listRes = await jobsGET(getReq("/api/research-jobs", owner));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { jobs: { id: string }[] };
    expect(list.jobs.map((j) => j.id)).toContain(jobId);
  });

  it("no provider credential is reachable from this suite, so the run above could not have gone live", () => {
    // The structural guarantee behind every assertion in this file.
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.BRAVE_SEARCH_API_KEY).toBeUndefined();
    expect(() => resolveSearchGateway()).toThrow();
  });

  it("the public path stays closed for a normal user throughout (owner alpha is additive, not an opening)", async () => {
    // The same configuration that just let the owner through must still
    // refuse everyone else — otherwise this harness would be validating an
    // accidental product-wide opening.
    const user = await makeAuthedClient("USER");
    const interpretRes = await interpretPOST(req("/api/interpretations", user, { question: QUESTION }));
    const body = (await interpretRes.json()) as {
      interpretation: { id: string };
      gates: { research: string };
    };
    expect(body.gates.research).toBe("DISABLED");

    const startRes = await jobsPOST(
      req("/api/research-jobs", user, {
        interpretationId: body.interpretation.id,
        idempotencyKey: uniq("idem"),
      }),
    );
    expect(startRes.status).toBe(403);
    expect(((await startRes.json()) as { error: string }).error).toBe("RESEARCH_DISABLED");
  });
});
