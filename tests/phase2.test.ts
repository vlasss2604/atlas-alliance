import { createHmac } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as authPOST } from "../app/api/auth/telegram/route";
import { DELETE as meDELETE, GET as meGET } from "../app/api/me/route";
import { PATCH as languagePATCH } from "../app/api/me/language/route";
import { POST as onboardingPOST } from "../app/api/me/onboarding/route";
import { GET as projectsGET } from "../app/api/projects/route";
import { GET as jobsGET } from "../app/api/research-jobs/route";
import { POST as readPOST } from "../app/api/research-jobs/[id]/read/route";
import { HttpError, requireRole } from "../src/server/auth/guards";
import {
  evidence as evidenceTable,
  productConfig,
  projects,
  proofs,
  researchJobs,
  sessions,
  sources,
  userIdentities,
  users,
} from "../src/server/db/schema";
import {
  createResearchJob,
  transitionJobState,
} from "../src/server/jobs/research-jobs";
import { __resetRuntime } from "../src/server/runtime";
import {
  coreEntitlement,
  setupTestDatabase,
  uniq,
  type TestContext,
} from "./phase1-setup";

const BOT_TOKEN = "123456:TEST_BOT_TOKEN_FOR_PHASE2";
const ORIGIN = "https://app.atlas.test";

let ctx: TestContext;

beforeAll(async () => {
  process.env.BOT_TOKEN = BOT_TOKEN;
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  ctx = await setupTestDatabase(); // ставит DATABASE_URL=TEST_DATABASE_URL
  await __resetRuntime();
});

afterAll(async () => {
  await __resetRuntime();
  await ctx.close();
});

// ─── Независимая референс-реализация подписи initData (тест §9.1) ───────────
// Написана по шагам документации Telegram, НЕ использует продакшн-код:
// data_check_string = отсортированные "key=value" всех полей кроме hash,
// соединённые "\n"; secret = HMAC_SHA256(key="WebAppData", msg=bot_token);
// hash = hex(HMAC_SHA256(key=secret, msg=data_check_string)).
function referenceSign(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

function makeInitData(
  overrides: Partial<Record<string, string>> = {},
  opts: { botToken?: string; keyOrder?: string[]; tamper?: (f: Record<string, string>) => void } = {},
): string {
  const fields: Record<string, string> = {
    user: JSON.stringify({
      id: Number(overrides.__tgId ?? 777000111),
      first_name: "Test",
      username: "test_user",
      language_code: "ru",
    }),
    chat_instance: "-4568751769008412598",
    chat_type: "private",
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (k !== "__tgId" && v !== undefined) fields[k] = v;
  }
  const hash = referenceSign(fields, opts.botToken ?? BOT_TOKEN);
  const withHash: Record<string, string> = { ...fields, hash };
  opts.tamper?.(withHash);
  const keys = opts.keyOrder ?? Object.keys(withHash);
  const qs = new URLSearchParams();
  for (const k of keys) qs.append(k, withHash[k]);
  return qs.toString();
}

function authRequest(body: unknown, origin: string | null = ORIGIN, ip = uniq("ip")): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip,
  };
  if (origin) headers["origin"] = origin;
  return new Request("http://localhost/api/auth/telegram", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface AuthedClient {
  cookie: string;
  csrf: string;
}

async function login(tgId?: string, ip?: string): Promise<AuthedClient> {
  const initData = makeInitData({ __tgId: tgId ?? uniq("id").replace(/\D/g, "9") });
  const res = await authPOST(authRequest({ initData }, ORIGIN, ip ?? uniq("ip")));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0];
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrf: csrfToken };
}

function apiRequest(
  path: string,
  method: string,
  client: Partial<AuthedClient>,
  opts: { origin?: string | null; body?: unknown; csrf?: string | null } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (client.cookie) headers["cookie"] = client.cookie;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin) headers["origin"] = origin;
  const csrf = opts.csrf === undefined ? client.csrf : opts.csrf;
  if (csrf) headers["x-atlas-csrf"] = csrf;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : JSON.stringify(opts.body ?? {}),
  });
}

describe("Phase 2 DoD", () => {
  it("1. initData: known-good vector, param order independence, mutations", async () => {
    // Позитив: валидный вектор
    const valid = makeInitData();
    expect((await authPOST(authRequest({ initData: valid }))).status).toBe(200);

    // Позитив: те же данные, другой порядок query-параметров → 200
    const reordered = makeInitData({}, { keyOrder: ["hash", "auth_date", "chat_type", "user", "chat_instance"] });
    expect((await authPOST(authRequest({ initData: reordered }))).status).toBe(200);

    // Позитив: неизвестное дополнительное поле включено в подпись → 200
    const extraField = makeInitData({ some_future_field: "value42" });
    expect((await authPOST(authRequest({ initData: extraField }))).status).toBe(200);

    // Мутации при сохранении/порче hash → 401
    const mutations: string[] = [
      // изменён один символ в hash
      makeInitData({}, { tamper: (f) => { f.hash = f.hash.slice(0, -1) + (f.hash.endsWith("0") ? "1" : "0"); } }),
      // изменён user при старом hash
      makeInitData({}, { tamper: (f) => { f.user = f.user.replace("Test", "Fake"); } }),
      // изменён auth_date при старом hash
      makeInitData({}, { tamper: (f) => { f.auth_date = String(Number(f.auth_date) - 1); } }),
      // подпись другим BOT_TOKEN
      makeInitData({}, { botToken: "999:WRONG_TOKEN" }),
    ];
    for (const initData of mutations) {
      expect((await authPOST(authRequest({ initData }))).status).toBe(401);
    }
    // hash отсутствует / пустой initData
    const noHash = new URLSearchParams({ user: "{}", auth_date: "1" }).toString();
    expect((await authPOST(authRequest({ initData: noHash }))).status).toBe(401);
    expect((await authPOST(authRequest({ initData: "" }))).status).toBe(401);
  });

  it("1b. auth_date: stale and future are rejected, within-skew accepted", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = makeInitData({ auth_date: String(now - 700) });
    expect((await authPOST(authRequest({ initData: stale }))).status).toBe(401);

    const future = makeInitData({ auth_date: String(now + 120) });
    expect((await authPOST(authRequest({ initData: future }))).status).toBe(401);

    const withinSkew = makeInitData({ auth_date: String(now + 30) });
    expect((await authPOST(authRequest({ initData: withinSkew }))).status).toBe(200);
  });

  it("2. first login creates user+identity; repeat login reuses; race yields one user", async () => {
    const tgId = "555000111";
    await login(tgId);
    await login(tgId);
    const identities = await ctx.db
      .select()
      .from(userIdentities)
      .where(sql`provider_user_id = ${tgId}`);
    expect(identities.length).toBe(1);

    // Гонка двух первых входов нового пользователя
    const raceId = "555000222";
    const [r1, r2] = await Promise.all([
      authPOST(authRequest({ initData: makeInitData({ __tgId: raceId }) })),
      authPOST(authRequest({ initData: makeInitData({ __tgId: raceId }) })),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const raceIdentities = await ctx.db
      .select()
      .from(userIdentities)
      .where(sql`provider_user_id = ${raceId}`);
    expect(raceIdentities.length).toBe(1);
  });

  it("3. session: hashed at rest, cookie attributes, expiry, rotation", async () => {
    const tgId = "555000333";
    const initData = makeInitData({ __tgId: tgId });
    const res = await authPOST(authRequest({ initData }));
    const setCookie = res.headers.get("set-cookie")!;
    for (const attr of ["HttpOnly", "Secure", "SameSite=None", "Path=/", "Max-Age=604800"]) {
      expect(setCookie).toContain(attr);
    }
    const rawToken = setCookie.split(";")[0].split("=").slice(1).join("=");

    // В БД только хэш, сырого токена нет
    const stored = await ctx.db.select().from(sessions);
    expect(stored.some((s) => s.tokenHash === rawToken)).toBe(false);

    const cookie = setCookie.split(";")[0];
    expect((await meGET(apiRequest("/api/me", "GET", { cookie }))).status).toBe(200);

    // Ротация: повторный вход инвалидирует старый токен
    await login(tgId);
    expect((await meGET(apiRequest("/api/me", "GET", { cookie }))).status).toBe(401);

    // Истечение
    const fresh = await login(tgId);
    await ctx.db.execute(sql`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    expect((await meGET(apiRequest("/api/me", "GET", { cookie: fresh.cookie }))).status).toBe(401);
  });

  it("3b. CSRF: token and Origin are both enforced on mutations", async () => {
    const client = await login();
    const ok = await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { body: { language: "RU" } }));
    expect(ok.status).toBe(200);

    expect(
      (await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { body: { language: "RU" }, csrf: null }))).status,
    ).toBe(403);
    expect(
      (await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { body: { language: "RU" }, csrf: "forged-token" }))).status,
    ).toBe(403);
    expect(
      (await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { body: { language: "RU" }, origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect(
      (await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { body: { language: "RU" }, origin: null }))).status,
    ).toBe(403);
    // GET без CSRF-токена → 200
    expect((await meGET(apiRequest("/api/me", "GET", { cookie: client.cookie }))).status).toBe(200);
  });

  it("3c. bootstrap boundary: auth needs no session/CSRF; every other mutation does", async () => {
    // Auth без сессии и CSRF, с валидным initData и Origin → 200 + cookie + csrf
    const res = await authPOST(authRequest({ initData: makeInitData() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("atlas_session=");
    expect(((await res.json()) as { csrfToken: string }).csrfToken).toBeTruthy();
    // Auth с чужим Origin → 403
    expect(
      (await authPOST(authRequest({ initData: makeInitData() }, "https://evil.example"))).status,
    ).toBe(403);

    // Полный список остальных state-changing endpoints: без сессии → 401
    const anon: Partial<AuthedClient> = {};
    expect((await languagePATCH(apiRequest("/api/me/language", "PATCH", anon, { csrf: null }))).status).toBe(401);
    expect((await onboardingPOST(apiRequest("/api/me/onboarding", "POST", anon, { csrf: null }))).status).toBe(401);
    expect(
      (await readPOST(apiRequest("/api/research-jobs/x/read", "POST", anon, { csrf: null }), {
        params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
      })).status,
    ).toBe(401);
    expect((await meDELETE(apiRequest("/api/me", "DELETE", anon, { csrf: null }))).status).toBe(401);

    // С сессией, но без CSRF → 403 (по тому же списку)
    const client = await login();
    expect((await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { csrf: null, body: { language: "EN" } }))).status).toBe(403);
    expect((await onboardingPOST(apiRequest("/api/me/onboarding", "POST", client, { csrf: null }))).status).toBe(403);
    expect(
      (await readPOST(apiRequest("/api/research-jobs/x/read", "POST", client, { csrf: null }), {
        params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
      })).status,
    ).toBe(403);
    expect((await meDELETE(apiRequest("/api/me", "DELETE", client, { csrf: null }))).status).toBe(403);
  });

  it("4. onboarding endpoint is idempotent", async () => {
    const client = await login();
    expect((await onboardingPOST(apiRequest("/api/me/onboarding", "POST", client))).status).toBe(200);
    const [before] = await ctx.db
      .select({ at: users.onboardingCompletedAt, v: users.onboardingVersion })
      .from(users)
      .innerJoin(sessions, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, sqlHash(client.cookie)));
    expect(before.at).not.toBeNull();
    expect(before.v).toBe(1);

    await new Promise((r) => setTimeout(r, 30));
    expect((await onboardingPOST(apiRequest("/api/me/onboarding", "POST", client))).status).toBe(200);
    const [after] = await ctx.db
      .select({ at: users.onboardingCompletedAt })
      .from(users)
      .innerJoin(sessions, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, sqlHash(client.cookie)));
    expect(after.at!.getTime()).toBe(before.at!.getTime());
  });

  it("5. language: default EN, PATCH persists on backend", async () => {
    const client = await login();
    let me = (await (await meGET(apiRequest("/api/me", "GET", client))).json()) as { language: string };
    expect(me.language).toBe("EN");
    await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { body: { language: "RU" } }));
    me = (await (await meGET(apiRequest("/api/me", "GET", client))).json()) as { language: string };
    expect(me.language).toBe("RU");
    // невалидный язык отклоняется
    expect(
      (await languagePATCH(apiRequest("/api/me/language", "PATCH", client, { body: { language: "DE" } }))).status,
    ).toBe(400);
  });

  it("6. projects come from DB, demo availability from product_config", async () => {
    const client = await login();
    const body = (await (await projectsGET(apiRequest("/api/projects", "GET", client))).json()) as {
      projects: { slug: string; researchable: boolean }[];
    };
    expect(body.projects.length).toBe(3);
    expect(body.projects.every((p) => p.researchable)).toBe(true); // все 3 в demo config

    // Смена config меняет ответ без деплоя
    await ctx.db
      .update(productConfig)
      .set({ value: ["pump_fun"] })
      .where(eq(productConfig.key, "demo_project_slugs"));
    await __resetRuntime();
    const changed = (await (await projectsGET(apiRequest("/api/projects", "GET", client))).json()) as {
      projects: { slug: string; researchable: boolean }[];
    };
    expect(changed.projects.filter((p) => p.researchable).map((p) => p.slug)).toEqual(["pump_fun"]);
    // возврат конфига
    await ctx.db
      .update(productConfig)
      .set({ value: ["pump_fun", "hyperliquid", "uniswap"] })
      .where(eq(productConfig.key, "demo_project_slugs"));
    await __resetRuntime();
  });

  it("7. unread flows through /api/me and read endpoint; foreign job → 404", async () => {
    const client = await login();
    const [{ userId }] = await ctx.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.tokenHash, sqlHash(client.cookie)));
    const [topic] = await ctx.db.execute(sql`SELECT id FROM topics WHERE is_active = true`).then((r) => r.rows as { id: string }[]);

    const r = await createResearchJob(ctx.db, ctx.boss, {
      userId,
      topicId: topic.id,
      originalQuestion: "unread test",
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 3,
    });
    await transitionJobState(ctx.db, r.job.id, "RUNNING");
    await transitionJobState(ctx.db, r.job.id, "SUCCEEDED");

    let me = (await (await meGET(apiRequest("/api/me", "GET", client))).json()) as { unreadCount: number };
    expect(me.unreadCount).toBe(1);

    const read = await readPOST(apiRequest(`/api/research-jobs/${r.job.id}/read`, "POST", client), {
      params: Promise.resolve({ id: r.job.id }),
    });
    expect(read.status).toBe(200);
    me = (await (await meGET(apiRequest("/api/me", "GET", client))).json()) as { unreadCount: number };
    expect(me.unreadCount).toBe(0);

    // Чужой job недоступен
    const stranger = await login();
    const foreign = await readPOST(apiRequest(`/api/research-jobs/${r.job.id}/read`, "POST", stranger), {
      params: Promise.resolve({ id: r.job.id }),
    });
    expect(foreign.status).toBe(404);
    // Список jobs — только свои
    const list = (await (await jobsGET(apiRequest("/api/research-jobs", "GET", stranger))).json()) as { jobs: unknown[] };
    expect(list.jobs.length).toBe(0);
  });

  it("8. RBAC: USER is denied on admin guard, ADMIN passes", async () => {
    const client = await login();
    const [{ userId, tokenHash, role }] = await ctx.db
      .select({ userId: sessions.userId, tokenHash: sessions.tokenHash, role: users.role })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, sqlHash(client.cookie)));

    expect(() => requireRole({ userId, tokenHash, role }, "ADMIN")).toThrowError(HttpError);
    await ctx.db.update(users).set({ role: "ADMIN" }).where(eq(users.id, userId));
    expect(() => requireRole({ userId, tokenHash, role: "ADMIN" }, "ADMIN")).not.toThrow();
  });

  it("9. account deletion cascades user data, keeps knowledge, kills session", async () => {
    const client = await login();
    const [{ userId }] = await ctx.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.tokenHash, sqlHash(client.cookie)));
    const [topic] = await ctx.db.execute(sql`SELECT id FROM topics WHERE is_active = true`).then((r) => r.rows as { id: string }[]);
    const [project] = await ctx.db.select().from(projects).limit(1);

    const r = await createResearchJob(ctx.db, ctx.boss, {
      userId,
      topicId: topic.id,
      originalQuestion: "to be deleted",
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 3,
    });
    const [proofRow] = await ctx.db
      .insert(proofs)
      .values({
        researchJobId: r.job.id,
        ownerUserId: userId,
        projectId: project.id,
        topicId: topic.id,
        verdict: "SUPPORTED",
        confidence: 70,
        layers: {},
      })
      .returning();
    const [src] = await ctx.db
      .insert(sources)
      .values({ url: "https://example.com/p2", urlHash: uniq("h") })
      .returning();
    await ctx.db.insert(evidenceTable).values({
      proofId: proofRow.id,
      sourceId: src.id,
      relationship: "SUPPORTS",
      fragment: "frag",
      fetchedAt: sql`now()`,
      retrievedUrl: "https://example.com/p2#a",
      contentHash: "sha256:x",
    });

    const projectsBefore = (await ctx.db.select().from(projects)).length;
    const del = await meDELETE(apiRequest("/api/me", "DELETE", client));
    expect(del.status).toBe(200);
    expect(del.headers.get("set-cookie")).toContain("Max-Age=0");

    expect((await ctx.db.select().from(users).where(eq(users.id, userId))).length).toBe(0);
    expect(
      (await ctx.db.select().from(researchJobs).where(eq(researchJobs.userId, userId))).length,
    ).toBe(0);
    expect((await ctx.db.select().from(projects)).length).toBe(projectsBefore);
    expect((await ctx.db.select().from(sources).where(eq(sources.id, src.id))).length).toBe(1);
    // Сессия мертва
    expect((await meGET(apiRequest("/api/me", "GET", client))).status).toBe(401);
  });

  it("10. rate limit: sequential and concurrent series cannot break the IP cap", async () => {
    const ip = uniq("ratelimit-ip");
    const bad = () => authPOST(authRequest({ initData: "garbage" }, ORIGIN, ip));
    for (let i = 0; i < 20; i++) {
      expect((await bad()).status).toBe(401);
    }
    const overflow = await bad();
    expect(overflow.status).toBe(429);
    expect(Number(overflow.headers.get("retry-after"))).toBeGreaterThan(0);

    // Конкурентная серия на свежем IP: не больше лимита в 401
    const ip2 = uniq("ratelimit-ip");
    const results = await Promise.all(
      Array.from({ length: 30 }, () => authPOST(authRequest({ initData: "garbage" }, ORIGIN, ip2))),
    );
    const s401 = results.filter((r) => r.status === 401).length;
    const s429 = results.filter((r) => r.status === 429).length;
    expect(s401).toBeLessThanOrEqual(20);
    expect(s401 + s429).toBe(30);
  });

  it("10b. lockout protection: forged victim id never touches the TG bucket", async () => {
    const victimId = "666000777";
    // Много невалидных подписей с чужим id (разные IP, чтобы не упереться в IP-лимит)
    for (let i = 0; i < 25; i++) {
      const forged = makeInitData({ __tgId: victimId }, { botToken: "999:WRONG_TOKEN" });
      expect((await authPOST(authRequest({ initData: forged }, ORIGIN, uniq("ip")))).status).toBe(401);
    }
    const tgBucket = await ctx.db.execute(
      sql`SELECT * FROM auth_rate_limits WHERE bucket_key = ${"tg:" + victimId}`,
    );
    expect(tgBucket.rows.length).toBe(0);

    // Жертва логинится штатно
    expect((await authPOST(authRequest({ initData: makeInitData({ __tgId: victimId }) }, ORIGIN, uniq("ip")))).status).toBe(200);

    // Валидная подпись расходует TG-bucket нормально: исчерпание → 429
    for (let i = 0; i < 19; i++) {
      const res = await authPOST(
        authRequest({ initData: makeInitData({ __tgId: victimId }) }, ORIGIN, uniq("ip")),
      );
      expect(res.status).toBe(200);
    }
    const exhausted = await authPOST(
      authRequest({ initData: makeInitData({ __tgId: victimId }) }, ORIGIN, uniq("ip")),
    );
    expect(exhausted.status).toBe(429);
  });
});

// Хэш токена из cookie-строки "atlas_session=<raw>"
function sqlHash(cookie: string): string {
  const raw = cookie.split("=").slice(1).join("=");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:crypto").createHash("sha256").update(raw).digest("hex");
}
