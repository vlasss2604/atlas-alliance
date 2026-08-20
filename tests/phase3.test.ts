import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as cancelPOST } from "../app/api/research-jobs/[id]/cancel/route";
import { GET as eventsGET } from "../app/api/research-jobs/[id]/events/route";
import { POST as jobsPOST } from "../app/api/research-jobs/route";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { createSession } from "../src/server/auth/session";
import {
  demoQuotaReservations,
  interpretations,
  productConfig,
  projects,
  researchJobs,
  topics,
  users,
} from "../src/server/db/schema";
import { __shutdownJobEvents } from "../src/server/events/job-events";
import { transitionJobState } from "../src/server/jobs/research-jobs";
import { __resetRuntime } from "../src/server/runtime";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

const ORIGIN = "https://app.atlas.test";
let ctx: TestContext;

beforeAll(async () => {
  process.env.BOT_TOKEN = "123456:PHASE3";
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  ctx = await setupTestDatabase();
  await __resetRuntime();
  // Фаза 3 тестирует конвейер запуска: включаем калитку в тестовой БД.
  await setResearchEnabled(true);
});

afterAll(async () => {
  await __shutdownJobEvents();
  await __resetRuntime();
  await ctx.close();
});

async function setResearchEnabled(v: boolean) {
  await ctx.db
    .insert(productConfig)
    .values({ key: "research_enabled", value: v })
    .onConflictDoUpdate({ target: productConfig.key, set: { value: v } });
  await __resetRuntime();
}

interface Client2 {
  cookie: string;
  csrf: string;
  userId: string;
}

async function makeAuthedClient(): Promise<Client2> {
  const [u] = await ctx.db.insert(users).values({}).returning();
  const { rawToken } = await createSession(ctx.db, u.id);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return {
    cookie: `atlas_session=${rawToken}`,
    csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!),
    userId: u.id,
  };
}

function req(
  path: string,
  method: string,
  c: Partial<Client2>,
  body?: unknown,
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (c.cookie) headers["cookie"] = c.cookie;
  headers["origin"] = ORIGIN;
  if (c.csrf) headers["x-atlas-csrf"] = c.csrf;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
}

async function makeReadyInterpretation(
  userId: string,
  projectSlug = "pump_fun",
): Promise<string> {
  const [row] = await ctx.db
    .insert(interpretations)
    .values({
      userId,
      originalQuestion: "Does the token capture value?",
      status: "READY",
      result: { project_slug: projectSlug, research_task: uniq("task") },
    })
    .returning();
  return row.id;
}

async function startJob(c: Client2, projectSlug = "pump_fun") {
  const interpretationId = await makeReadyInterpretation(c.userId, projectSlug);
  const res = await jobsPOST(
    req("/api/research-jobs", "POST", c, {
      interpretationId,
      idempotencyKey: uniq("idem"),
    }),
  );
  return { res, interpretationId };
}

async function quotaCount(userId: string): Promise<number> {
  return (
    await ctx.db
      .select()
      .from(demoQuotaReservations)
      .where(eq(demoQuotaReservations.userId, userId))
  ).length;
}

// Чтение SSE-потока: собирает события до закрытия или таймаута.
async function readSse(
  res: Response,
  opts: { maxEvents?: number; timeoutMs?: number } = {},
): Promise<{ events: unknown[]; closed: boolean }> {
  const events: unknown[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), deadline - Date.now())),
    ]);
    if (race === "timeout") break;
    const { done, value } = race;
    if (done) {
      closed = true;
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
    }
    if (opts.maxEvents && events.length >= opts.maxEvents) break;
  }
  if (!closed) await reader.cancel().catch(() => {});
  return { events, closed };
}

describe("Phase 3 DoD", () => {
  it("1. full pipeline creates job, reservation, queue task, links interpretation", async () => {
    const c = await makeAuthedClient();
    const before = (
      await ctx.db.execute(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'research'`)
    ).rows[0] as { n: number };

    const { res, interpretationId } = await startJob(c);
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { id: string; state: string } };
    expect(job.state).toBe("QUEUED");

    expect(await quotaCount(c.userId)).toBe(1); // DEMO reservation
    const after = (
      await ctx.db.execute(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'research'`)
    ).rows[0] as { n: number };
    expect(after.n).toBe(before.n + 1);
    const [interp] = await ctx.db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, interpretationId));
    expect(interp.researchJobId).toBe(job.id);
    await cancelPOST(req(`/api/research-jobs/${job.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: job.id }),
    });
  });

  it("2. research_enabled=false → 403; missing/未READY interpretation → 409; quota untouched", async () => {
    const c = await makeAuthedClient();
    await setResearchEnabled(false);
    const r1 = await startJob(c);
    expect(r1.res.status).toBe(403);
    expect(((await r1.res.json()) as { error: string }).error).toBe("RESEARCH_DISABLED");
    await setResearchEnabled(true);

    const r2 = await jobsPOST(
      req("/api/research-jobs", "POST", c, {
        interpretationId: "00000000-0000-0000-0000-000000000000",
        idempotencyKey: uniq("idem"),
      }),
    );
    expect(r2.status).toBe(409);

    const [needsClar] = await ctx.db
      .insert(interpretations)
      .values({
        userId: c.userId,
        originalQuestion: "q",
        status: "NEEDS_CLARIFICATION",
        result: { project_slug: "pump_fun", research_task: "t" },
      })
      .returning();
    const r3 = await jobsPOST(
      req("/api/research-jobs", "POST", c, {
        interpretationId: needsClar.id,
        idempotencyKey: uniq("idem"),
      }),
    );
    expect(r3.status).toBe(409);
    expect(await quotaCount(c.userId)).toBe(0);
  });

  it("3. scope and entitlement gates reject without spending quota", async () => {
    const c = await makeAuthedClient();

    // Проект вне ACTIVE_CORE
    await ctx.db
      .insert(projects)
      .values({ slug: "aave", name: "Aave", ticker: "AAVE", status: "CANDIDATE" })
      .onConflictDoNothing({ target: projects.slug });
    const r1 = await startJob(c, "aave");
    expect(r1.res.status).toBe(403);
    expect(((await r1.res.json()) as { error: string }).error).toBe("OUT_OF_SCOPE");

    // ACTIVE_CORE, но не в demo_project_slugs → CORE_REQUIRED для DEMO
    await ctx.db
      .insert(projects)
      .values({ slug: "ethena", name: "Ethena", ticker: "ENA", status: "ACTIVE_CORE" })
      .onConflictDoNothing({ target: projects.slug });
    const r2 = await startJob(c, "ethena");
    expect(r2.res.status).toBe(403);
    expect(((await r2.res.json()) as { error: string }).error).toBe("CORE_REQUIRED");

    // Неактивная тема
    await ctx.db.update(topics).set({ isActive: false });
    const r3 = await startJob(c);
    expect(r3.res.status).toBe(403);
    await ctx.db.update(topics).set({ isActive: true });

    expect(await quotaCount(c.userId)).toBe(0);
  });

  it("4. idempotency key replays same job; second active job → 409", async () => {
    const c = await makeAuthedClient();
    const interpretationId = await makeReadyInterpretation(c.userId);
    const key = uniq("idem");
    const first = await jobsPOST(
      req("/api/research-jobs", "POST", c, { interpretationId, idempotencyKey: key }),
    );
    expect(first.status).toBe(201);
    const firstJob = ((await first.json()) as { job: { id: string } }).job;

    const replay = await jobsPOST(
      req("/api/research-jobs", "POST", c, { interpretationId, idempotencyKey: key }),
    );
    // interpretation уже связана — конвейер отвечает 409 ALREADY_USED?
    // Нет: idempotent replay должен вернуть тот же job ДО проверки "already used".
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { job: { id: string } }).job.id).toBe(firstJob.id);

    const second = await startJob(c);
    expect(second.res.status).toBe(409);
    expect(((await second.res.json()) as { error: string }).error).toBe("ACTIVE_JOB_EXISTS");

    await cancelPOST(req(`/api/research-jobs/${firstJob.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: firstJob.id }),
    });
  });

  it("5. raw LISTEN client receives research_job_events on state change", async () => {
    const c = await makeAuthedClient();
    const { res } = await startJob(c);
    const { job } = (await res.json()) as { job: { id: string } };

    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    await listener.query("LISTEN research_job_events");
    const notification = new Promise<{ job_id: string }>((resolve) => {
      listener.on("notification", (msg) => resolve(JSON.parse(msg.payload!)));
    });

    await transitionJobState(ctx.db, job.id, "RUNNING");
    const payload = await Promise.race([
      notification,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    await listener.end();
    expect(payload?.job_id).toBe(job.id);
    await transitionJobState(ctx.db, job.id, "CANCELLED");
  });

  it("6. SSE delivers snapshot then transitions, closes on terminal; foreign job → 404", async () => {
    const c = await makeAuthedClient();
    const { res } = await startJob(c);
    const { job } = (await res.json()) as { job: { id: string } };

    const sse = await eventsGET(req(`/api/research-jobs/${job.id}/events`, "GET", c), {
      params: Promise.resolve({ id: job.id }),
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");

    const collected = (async () => readSse(sse, { timeoutMs: 6000 }))();
    await new Promise((r) => setTimeout(r, 300));
    await transitionJobState(ctx.db, job.id, "RUNNING");
    await new Promise((r) => setTimeout(r, 300));
    await transitionJobState(ctx.db, job.id, "SUCCEEDED");

    const { events, closed } = await collected;
    const states = (events as { state: string }[]).map((e) => e.state);
    expect(states[0]).toBe("QUEUED"); // мгновенный снапшот из БД
    expect(states).toContain("RUNNING");
    expect(states[states.length - 1]).toBe("SUCCEEDED");
    expect(closed).toBe(true); // терминал закрывает поток

    // Чужой job → 404
    const stranger = await makeAuthedClient();
    const foreign = await eventsGET(
      req(`/api/research-jobs/${job.id}/events`, "GET", stranger),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(foreign.status).toBe(404);
  });

  it("7. cancel: releases DEMO slot atomically; idempotent; finished → 409; foreign → 404", async () => {
    const c = await makeAuthedClient();
    const { res } = await startJob(c);
    const { job } = (await res.json()) as { job: { id: string } };

    const cancel1 = await cancelPOST(req(`/api/research-jobs/${job.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: job.id }),
    });
    expect(cancel1.status).toBe(200);
    const [reservation] = await ctx.db
      .select()
      .from(demoQuotaReservations)
      .where(eq(demoQuotaReservations.researchJobId, job.id));
    expect(reservation.state).toBe("RELEASED");
    const [jobRow] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, job.id));
    expect(jobRow.state).toBe("CANCELLED");

    const cancel2 = await cancelPOST(req(`/api/research-jobs/${job.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: job.id }),
    });
    expect(cancel2.status).toBe(200);
    expect(((await cancel2.json()) as { already?: boolean }).already).toBe(true);

    // Завершённый job отменить нельзя
    const done = await startJob(c);
    const doneJob = ((await done.res.json()) as { job: { id: string } }).job;
    await transitionJobState(ctx.db, doneJob.id, "RUNNING");
    await transitionJobState(ctx.db, doneJob.id, "SUCCEEDED");
    const cancel3 = await cancelPOST(req(`/api/research-jobs/${doneJob.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: doneJob.id }),
    });
    expect(cancel3.status).toBe(409);

    const stranger = await makeAuthedClient();
    const cancel4 = await cancelPOST(
      req(`/api/research-jobs/${doneJob.id}/cancel`, "POST", stranger),
      { params: Promise.resolve({ id: doneJob.id }) },
    );
    expect(cancel4.status).toBe(404);
  });

  it("8. cancel vs worker race keeps invariants under both orderings", async () => {
    for (let round = 0; round < 4; round++) {
      const c = await makeAuthedClient();
      const { res } = await startJob(c);
      const { job } = (await res.json()) as { job: { id: string } };

      // Worker-путь: QUEUED→RUNNING→SUCCEEDED; параллельно cancel.
      const workerPath = (async () => {
        try {
          await transitionJobState(ctx.db, job.id, "RUNNING");
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          await transitionJobState(ctx.db, job.id, "SUCCEEDED");
          return "finished";
        } catch {
          return "lost";
        }
      })();
      const cancelPath = (async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        const r2 = await cancelPOST(req(`/api/research-jobs/${job.id}/cancel`, "POST", c), {
          params: Promise.resolve({ id: job.id }),
        });
        return r2.status;
      })();
      const [workerOutcome, cancelStatus] = await Promise.all([workerPath, cancelPath]);

      const [finalJob] = await ctx.db
        .select()
        .from(researchJobs)
        .where(eq(researchJobs.id, job.id));
      const [reservation] = await ctx.db
        .select()
        .from(demoQuotaReservations)
        .where(eq(demoQuotaReservations.researchJobId, job.id));

      // Ровно один терминал; резервация согласована с исходом.
      expect(["SUCCEEDED", "CANCELLED"]).toContain(finalJob.state);
      if (finalJob.state === "CANCELLED") {
        expect(cancelStatus).toBe(200);
        expect(reservation.state).toBe("RELEASED");
      } else {
        expect(workerOutcome).toBe("finished");
        expect(cancelStatus).toBe(409);
        expect(reservation.state).toBe("RESERVED"); // расход решит pipeline (Фаза 6)
      }
      // Журнал не содержит переходов ИЗ терминального состояния.
      const transitions = await ctx.db.execute(
        sql`SELECT from_state FROM research_job_transitions WHERE job_id = ${job.id}
            AND from_state IN ('SUCCEEDED','CANCELLED')`,
      );
      expect(transitions.rows.length).toBe(0);
    }
  });

  it("9. third SSE connection evicts the oldest for the same user", async () => {
    const c = await makeAuthedClient();
    const { res } = await startJob(c);
    const { job } = (await res.json()) as { job: { id: string } };

    const open = async () =>
      eventsGET(req(`/api/research-jobs/${job.id}/events`, "GET", c), {
        params: Promise.resolve({ id: job.id }),
      });
    const s1 = await open();
    const s2 = await open();
    const r1 = readSse(s1, { timeoutMs: 4000 });
    const r2 = readSse(s2, { timeoutMs: 1500 });
    await new Promise((r) => setTimeout(r, 200));
    const s3 = await open();
    const r3 = readSse(s3, { timeoutMs: 1500 });

    const first = await r1;
    expect(first.closed).toBe(true); // вытеснено третьим подключением
    await Promise.all([r2, r3]);
    await cancelPOST(req(`/api/research-jobs/${job.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: job.id }),
    });
  });
});

describe("Phase 3 — adversarial review regressions", () => {
  it("R2. replaying an old idempotency key with a NEW interpretation is rejected, interpretation stays reusable", async () => {
    const c = await makeAuthedClient();
    const interpA = await makeReadyInterpretation(c.userId);
    const key = uniq("idem");
    const first = await jobsPOST(
      req("/api/research-jobs", "POST", c, { interpretationId: interpA, idempotencyKey: key }),
    );
    expect(first.status).toBe(201);
    const job1 = ((await first.json()) as { job: { id: string } }).job;

    // Новая interpretation + старый ключ → 409, НЕ приваривается к job1
    const interpB = await makeReadyInterpretation(c.userId);
    const captured = await jobsPOST(
      req("/api/research-jobs", "POST", c, { interpretationId: interpB, idempotencyKey: key }),
    );
    expect(captured.status).toBe(409);
    expect(((await captured.json()) as { error: string }).error).toBe("IDEMPOTENCY_KEY_REUSED");
    const [b] = await ctx.db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, interpB));
    expect(b.researchJobId).toBeNull(); // interpretation B не потеряна

    // B остаётся полноценно используемой со свежим ключом (после終 job1)
    await cancelPOST(req(`/api/research-jobs/${job1.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: job1.id }),
    });
    const fresh = await jobsPOST(
      req("/api/research-jobs", "POST", c, { interpretationId: interpB, idempotencyKey: uniq("idem") }),
    );
    expect(fresh.status).toBe(201);
    const job2 = ((await fresh.json()) as { job: { id: string } }).job;
    expect(job2.id).not.toBe(job1.id);
    await cancelPOST(req(`/api/research-jobs/${job2.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: job2.id }),
    });
  });

  it("R2b. self-heal: job created but link crashed — same interpretation + same key relinks and returns the job", async () => {
    const c = await makeAuthedClient();
    const interpId = await makeReadyInterpretation(c.userId);
    const key = uniq("idem");
    const first = await jobsPOST(
      req("/api/research-jobs", "POST", c, { interpretationId: interpId, idempotencyKey: key }),
    );
    const job = ((await first.json()) as { job: { id: string } }).job;
    // Имитация сбоя между созданием и связкой
    await ctx.db
      .update(interpretations)
      .set({ researchJobId: null })
      .where(eq(interpretations.id, interpId));

    const replay = await jobsPOST(
      req("/api/research-jobs", "POST", c, { interpretationId: interpId, idempotencyKey: key }),
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { job: { id: string } }).job.id).toBe(job.id);
    const [relinked] = await ctx.db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, interpId));
    expect(relinked.researchJobId).toBe(job.id);
    await cancelPOST(req(`/api/research-jobs/${job.id}/cancel`, "POST", c), {
      params: Promise.resolve({ id: job.id }),
    });
  });

  it("R4. malformed job id → 404 on cancel, events and read (not 500)", async () => {
    const c = await makeAuthedClient();
    const bad = "not-a-uuid";
    const cancel = await cancelPOST(req(`/api/research-jobs/${bad}/cancel`, "POST", c), {
      params: Promise.resolve({ id: bad }),
    });
    expect(cancel.status).toBe(404);
    const events = await eventsGET(req(`/api/research-jobs/${bad}/events`, "GET", c), {
      params: Promise.resolve({ id: bad }),
    });
    expect(events.status).toBe(404);
    const { POST: readPOST } = await import("../app/api/research-jobs/[id]/read/route");
    const read = await readPOST(req(`/api/research-jobs/${bad}/read`, "POST", c), {
      params: Promise.resolve({ id: bad }),
    });
    expect(read.status).toBe(404);
  });

  it("R6. periodic DB refresh closes the stream of a deleted job even without NOTIFY", async () => {
    process.env.SSE_REFRESH_MS = "400";
    try {
      const c = await makeAuthedClient();
      const { res } = await startJob(c);
      const { job } = (await res.json()) as { job: { id: string } };

      const sse = await eventsGET(req(`/api/research-jobs/${job.id}/events`, "GET", c), {
        params: Promise.resolve({ id: job.id }),
      });
      const collected = readSse(sse, { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 200));
      // Удаление в обход NOTIFY-триггера (как каскад при удалении аккаунта)
      await ctx.db.delete(researchJobs).where(eq(researchJobs.id, job.id));
      const { closed } = await collected;
      expect(closed).toBe(true); // сверка с БД закрыла поток
    } finally {
      delete process.env.SSE_REFRESH_MS;
    }
  });
});
