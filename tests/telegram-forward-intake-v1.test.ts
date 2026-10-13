import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { POST as authPOST } from "../app/api/auth/telegram/route";
import { GET as intakeGET } from "../app/api/intakes/[id]/route";
import { POST as jobsPOST } from "../app/api/research-jobs/route";
import { POST as webhookPOST, SECRET_HEADER } from "../app/api/telegram/webhook/route";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import {
  askPathForIntake,
  intakeIdFromSearch,
  intakeIdFromStartParam,
  rememberLaunchIntake,
  takeLaunchIntake,
} from "../src/client/intake-launch";
import { authenticateTelegram, startParamOf } from "../src/server/auth/authenticate";
import { deriveCsrfToken } from "../src/server/auth/csrf";
import { computeInitDataHash } from "../src/server/auth/initdata";
import { createSession } from "../src/server/auth/session";
import { loadProductConfig } from "../src/server/config/product";
import {
  demoQuotaReservations,
  interpretations,
  researchIntakes,
  researchJobs,
  sessions,
  userIdentities,
  users,
} from "../src/server/db/schema";
import { MAX_QUESTION_CHARS } from "../src/server/interpreter/interpret";
import { transitionJobState } from "../src/server/jobs/research-jobs";
import { __resetRuntime } from "../src/server/runtime";
import { countPrivateBetaJobs, grantPrivateBetaAccess, setPrivateBetaConfig } from "../src/server/services/private-beta";
import { detectProjectSlug } from "../src/server/services/project-detection";
import {
  INTAKE_TTL_MS,
  MAX_INTAKE_TEXT_CHARS,
  consumeResearchIntake,
  loadResearchIntakeForUser,
} from "../src/server/services/research-intake";
import { TELEGRAM_API_BASE, __setTelegramTransport, buildSendMessagePayload } from "../src/server/telegram/bot-api";
import { excerptOf } from "../src/server/telegram/replies";
import { parseTelegramUpdate } from "../src/server/telegram/update";
import { handleTelegramUpdate, intakeLaunchUrl } from "../src/server/telegram/webhook";
import { setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// TELEGRAM FORWARD → ATLAS → VERIFY → EXISTING RESEARCH (Founder-approved V1).
//
// A forwarded message becomes ONE bounded intake owned by the canonical
// user, and nothing else: no interpretation, no job, no quota, no source,
// no evidence. The Mini App shows the text in the ordinary editable Ask
// composer; Research starts only through the unchanged canonical path,
// which marks the intake consumed once a job exists. Everything here is
// offline: the only outbound call the bot makes is captured by a stub that
// records what WOULD have been sent and sends nothing.

const ORIGIN = "https://app.atlas.test";
const SECRET = "whsec-test-secret";
const WAVE_1 = ["raydium", "pump_fun", "lido"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let ctx: TestContext;

interface Sent {
  url: string;
  body: Record<string, unknown>;
}
let sent: Sent[] = [];
let transportFails = false;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  process.env.MODEL_GATEWAY = "fake";
  process.env.BOT_TOKEN = "123456:TEST_TOKEN";
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  __setTelegramTransport(async (url, body) => {
    if (transportFails) throw new Error("stub: network down");
    sent.push({ url, body: JSON.parse(body) as Record<string, unknown> });
    return { ok: true, status: 200 };
  });
  ctx = await setupTestDatabase();
  await setPrivateBetaConfig(ctx.db, { enabled: true, projectSlugs: WAVE_1, researchLimit: 5 });
  await __resetRuntime();
});

afterAll(async () => {
  __setTelegramTransport(null);
  await __resetRuntime();
  await ctx.close();
});

afterEach(async () => {
  sent = [];
  transportFails = false;
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  await setPrivateBetaConfig(ctx.db, { enabled: true, projectSlugs: WAVE_1, researchLimit: 5 });
  await __resetRuntime();
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

let tgSeq = 7_000_000;
async function telegramUser(language: "EN" | "RU" = "EN"): Promise<{ userId: string; tgId: string }> {
  const [u] = await ctx.db.insert(users).values({ role: "USER", language }).returning();
  tgSeq += 1;
  const tgId = String(tgSeq);
  await ctx.db.insert(userIdentities).values({ userId: u.id, provider: "TELEGRAM", providerUserId: tgId });
  return { userId: u.id, tgId };
}

let updateSeq = 500_000;
interface UpdateOptions {
  text?: string;
  caption?: string;
  chatType?: string;
  chatId?: number;
  forwardOrigin?: Record<string, unknown>;
  isBot?: boolean;
  updateId?: number;
}
function update(tgId: string, o: UpdateOptions = {}): Record<string, unknown> {
  updateSeq += 1;
  const message: Record<string, unknown> = {
    message_id: updateSeq,
    date: 1_790_000_000,
    chat: { id: o.chatId ?? Number(tgId), type: o.chatType ?? "private", first_name: "Private Person" },
    from: { id: Number(tgId), is_bot: o.isBot ?? false, first_name: "Private", last_name: "Person", username: "private_person" },
  };
  if (o.text !== undefined) message.text = o.text;
  if (o.caption !== undefined) {
    message.caption = o.caption;
    message.photo = [{ file_id: "AgAC", file_unique_id: "x", width: 1, height: 1 }];
  }
  if (o.forwardOrigin) message.forward_origin = o.forwardOrigin;
  return { update_id: o.updateId ?? updateSeq, message };
}
const channelOrigin = (over: Record<string, unknown> = {}) => ({
  type: "channel",
  date: 1_789_000_000,
  chat: { id: -1001234567890, type: "channel", title: "Raydium Watch", username: "raydiumwatch" },
  message_id: 4242,
  ...over,
});

function webhook(body: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers[SECRET_HEADER] = secret;
  return new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const outcomeOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

interface Authed {
  cookie: string;
  csrf: string;
  userId: string;
}
async function authedFor(userId: string): Promise<Authed> {
  const { rawToken } = await createSession(ctx.db, userId);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { cookie: `atlas_session=${rawToken}`, csrf: deriveCsrfToken(tokenHash, process.env.CSRF_SECRET!), userId };
}
const get = (path: string, c: Authed | null): Request =>
  new Request(`http://localhost${path}`, { method: "GET", headers: c ? { cookie: c.cookie, origin: ORIGIN } : {} });
const post = (path: string, c: Authed, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: c.cookie, origin: ORIGIN, "x-atlas-csrf": c.csrf },
    body: JSON.stringify(body),
  });

const intakeRow = async (id: string) => (await ctx.db.select().from(researchIntakes).where(eq(researchIntakes.id, id)))[0];
const intakesOf = async (userId: string) => ctx.db.select().from(researchIntakes).where(eq(researchIntakes.userId, userId));
const jobsOf = async (userId: string) => ctx.db.select().from(researchJobs).where(eq(researchJobs.userId, userId));
const demoRowsOf = async (userId: string) =>
  ctx.db.select().from(demoQuotaReservations).where(eq(demoQuotaReservations.userId, userId));
const countUsers = async () => ((await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users`)).rows[0] as { n: number }).n;

// What a forward must never produce, checked after every intake-side step.
async function expectNothingSpent(userId: string) {
  expect(await jobsOf(userId)).toHaveLength(0);
  expect(await demoRowsOf(userId)).toHaveLength(0);
  expect(await countPrivateBetaJobs(ctx.db, userId)).toBe(0);
}

async function forward(tgId: string, o: UpdateOptions = {}): Promise<{ outcome: Record<string, unknown>; intakeId: string | null }> {
  const res = await webhookPOST(webhook(update(tgId, o)));
  expect(res.status).toBe(200);
  const outcome = await outcomeOf(res);
  const row = outcome.handled === true ? (await intakesOf((await ownerOf(tgId)) ?? "00000000-0000-0000-0000-000000000000")).at(-1) : undefined;
  return { outcome, intakeId: row?.id ?? null };
}
async function ownerOf(tgId: string): Promise<string | null> {
  const [row] = await ctx.db.select({ userId: userIdentities.userId }).from(userIdentities).where(eq(userIdentities.providerUserId, tgId));
  return row?.userId ?? null;
}
const buttonUrlOf = (s: Sent): string | null => {
  const markup = s.body.reply_markup as { inline_keyboard?: { text: string; web_app?: { url: string } }[][] } | undefined;
  return markup?.inline_keyboard?.[0]?.[0]?.web_app?.url ?? null;
};

// A READY research interpretation exactly as the Interpreter persists one.
async function interpretationFor(userId: string, slug: string, question = "Does Raydium buy back RAY with protocol fees?"): Promise<string> {
  const [row] = await ctx.db
    .insert(interpretations)
    .values({
      userId,
      originalQuestion: question,
      status: "READY",
      result: { project_slug: slug, project_slugs: [slug], research_task: "trace fee revenue to the token", route: "DEEP_RESEARCH" },
    })
    .returning();
  return row.id;
}
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* 1. the webhook: authentication, shapes, identity                     */
/* ------------------------------------------------------------------ */

describe("1. webhook authentication and update handling", () => {
  it("no secret configured → 503 for everyone, nothing read, nothing sent", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { tgId } = await telegramUser();
    const res = await webhookPOST(webhook(update(tgId, { text: "Raydium buys back RAY" })));
    expect(res.status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it("wrong or missing secret → 401, no intake, no reply", async () => {
    const { tgId, userId } = await telegramUser();
    expect((await webhookPOST(webhook(update(tgId, { text: "Raydium buys back RAY" }), "wrong"))).status).toBe(401);
    expect((await webhookPOST(webhook(update(tgId, { text: "Raydium buys back RAY" }), null))).status).toBe(401);
    expect(await intakesOf(userId)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("malformed body and malformed update → 200, handled:false, nothing stored", async () => {
    expect(await outcomeOf(await webhookPOST(webhook("{not json")))).toEqual({ handled: false, reason: "MALFORMED" });
    expect(await outcomeOf(await webhookPOST(webhook({ hello: "world" })))).toEqual({ handled: false, reason: "MALFORMED" });
    expect(await outcomeOf(await webhookPOST(webhook({ update_id: 1, message: { chat: "nope" } })))).toEqual({ handled: false, reason: "MALFORMED" });
    expect(sent).toHaveLength(0);
  });

  it("unsupported update types are ignored safely: no message, a group chat, a bot sender", async () => {
    const { tgId } = await telegramUser();
    expect(await outcomeOf(await webhookPOST(webhook({ update_id: 2, callback_query: { id: "1" } })))).toEqual({ handled: false, reason: "IGNORED" });
    expect(await outcomeOf(await webhookPOST(webhook(update(tgId, { text: "Raydium", chatType: "supergroup" }))))).toEqual({ handled: false, reason: "IGNORED" });
    expect(await outcomeOf(await webhookPOST(webhook(update(tgId, { text: "Raydium", isBot: true }))))).toEqual({ handled: false, reason: "IGNORED" });
    expect(sent).toHaveLength(0);
  });

  it("a sender with no TELEGRAM identity is told to sign in first; no user and no intake is created", async () => {
    const before = await countUsers();
    const strangerId = "9999999";
    const res = await webhookPOST(webhook(update(strangerId, { text: "Raydium buys back RAY" })));
    expect(await outcomeOf(res)).toMatchObject({ handled: true, action: "SIGN_IN_FIRST", delivered: true });
    expect(await countUsers()).toBe(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toBe("Open ATLAS PROOF and sign in once, then forward the message again.");
    expect(sent[0].body.reply_markup).toBeUndefined();
    const all = await ctx.db.select().from(researchIntakes);
    expect(all.some((r) => r.rawText === "Raydium buys back RAY")).toBe(false);
  });

  it("the sender's language chooses the reply language", async () => {
    const { tgId } = await telegramUser("RU");
    await forward(tgId, { text: "Raydium выкупает RAY" });
    expect(sent[0].body.text).toContain("Утверждение получено");
    expect(buttonUrlOf(sent[0])).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 2. the intake: what is stored, what is not                          */
/* ------------------------------------------------------------------ */

describe("2. a forward becomes one bounded intake and nothing else", () => {
  it("forwarded public-channel text: intake, detection, source, button — and zero Research", async () => {
    const { tgId, userId } = await telegramUser();
    const text = "Raydium now routes 12% of trading fees to RAY buybacks. Is it happening?";
    const { outcome, intakeId } = await forward(tgId, { text, forwardOrigin: channelOrigin() });
    expect(outcome).toMatchObject({ handled: true, action: "VERIFY", delivered: true });
    expect(intakeId).toMatch(UUID);
    const row = await intakeRow(intakeId!);
    expect(row).toMatchObject({
      userId,
      origin: "TELEGRAM_FORWARD",
      rawText: text,
      sourceLabel: "Raydium Watch",
      sourceUrl: "https://t.me/raydiumwatch/4242",
      detectedProjectSlug: "raydium",
      status: "OPEN",
      consumedAt: null,
      researchJobId: null,
    });
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(Math.abs(ttl - INTAKE_TTL_MS)).toBeLessThan(5_000);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${TELEGRAM_API_BASE}/bot${process.env.BOT_TOKEN}/sendMessage`);
    expect(sent[0].body.chat_id).toBe(Number(tgId));
    expect(sent[0].body.text).toContain("Claim received");
    expect(sent[0].body.text).toContain("Project: Raydium");
    expect(sent[0].body.text).toContain(excerptOf(text));
    expect(buttonUrlOf(sent[0])).toBe(`${ORIGIN}/ask?intake=${intakeId}`);
    expect(intakeLaunchUrl(intakeId!)).toBe(`${ORIGIN}/ask?intake=${intakeId}`);
    // The launch carries only the opaque id: no text, no project, no claim.
    expect(buttonUrlOf(sent[0])).not.toContain("Raydium");
    expect(buttonUrlOf(sent[0])!.replace(`${ORIGIN}/ask?intake=`, "")).toMatch(UUID);
    await expectNothingSpent(userId);
    expect(await ctx.db.select().from(interpretations).where(eq(interpretations.userId, userId))).toHaveLength(0);
  });

  it("a forwarded message with a caption stores the caption", async () => {
    const { tgId } = await telegramUser();
    const { intakeId } = await forward(tgId, { caption: "Lido will burn 20% of fees. Source: official blog", forwardOrigin: channelOrigin({ chat: { id: -100, type: "channel", title: "Lido News" } }) });
    const row = await intakeRow(intakeId!);
    expect(row.rawText).toBe("Lido will burn 20% of fees. Source: official blog");
    expect(row.detectedProjectSlug).toBe("lido");
    // A channel without a public username yields a label but no link.
    expect(row.sourceLabel).toBe("Lido News");
    expect(row.sourceUrl).toBeNull();
  });

  it("plain text typed into the chat is an intake with no source", async () => {
    const { tgId } = await telegramUser();
    const { outcome, intakeId } = await forward(tgId, { text: "Does Pump.fun really burn PUMP with buybacks?" });
    expect(outcome).toMatchObject({ action: "VERIFY" });
    expect(await intakeRow(intakeId!)).toMatchObject({ sourceLabel: null, sourceUrl: null, detectedProjectSlug: "pump_fun" });
  });

  it("missing text or caption → a compact reply and no intake; a command → a hint and no intake", async () => {
    const { tgId, userId } = await telegramUser();
    const r1 = await outcomeOf(await webhookPOST(webhook({ update_id: ++updateSeq, message: { message_id: 1, date: 1, chat: { id: Number(tgId), type: "private" }, from: { id: Number(tgId), is_bot: false }, photo: [{ file_id: "x" }] } })));
    expect(r1).toMatchObject({ handled: true, action: "NEED_TEXT" });
    const r2 = await outcomeOf(await webhookPOST(webhook(update(tgId, { text: "/start" }))));
    expect(r2).toMatchObject({ handled: true, action: "HINT" });
    expect(await intakesOf(userId)).toHaveLength(0);
    expect(sent.map((s) => s.body.reply_markup)).toEqual([undefined, undefined]);
  });

  it("forwards from a person or a hidden sender keep no name, no id and no link; private chat ids are stored nowhere", async () => {
    const { tgId, userId } = await telegramUser();
    await forward(tgId, { text: "Raydium claim one", forwardOrigin: { type: "user", date: 1, sender_user: { id: 55, first_name: "Alice", last_name: "Private", username: "alice_p" } } });
    await forward(tgId, { text: "Raydium claim two", forwardOrigin: { type: "hidden_user", date: 1, sender_user_name: "Bob Hidden" } });
    await forward(tgId, { text: "Raydium claim three", forwardOrigin: { type: "chat", date: 1, sender_chat: { id: -200, type: "supergroup", title: "Alpha Group" } } });
    const rows = await intakesOf(userId);
    expect(rows.map((r) => [r.sourceLabel, r.sourceUrl])).toEqual([
      ["Telegram user", null],
      ["Telegram user", null],
      ["Alpha Group", null],
    ]);
    const dump = JSON.stringify(rows);
    for (const leak of ["Alice", "alice_p", "Bob Hidden", "Private Person", "private_person", String(tgId), "-200", "55"]) {
      expect(dump.includes(`"${leak}"`)).toBe(false);
    }
  });

  it("text is bounded to the Interpreter's question limit, trimmed, and never longer", async () => {
    expect(MAX_INTAKE_TEXT_CHARS).toBe(MAX_QUESTION_CHARS);
    const { tgId } = await telegramUser();
    const { intakeId } = await forward(tgId, { text: `  Raydium ${"x".repeat(5_000)}  ` });
    expect((await intakeRow(intakeId!)).rawText).toHaveLength(MAX_QUESTION_CHARS);
    // The CHECK constraint is the backstop beneath the service.
    const { userId } = await telegramUser();
    await expect(
      ctx.db.insert(researchIntakes).values({ userId, origin: "TELEGRAM_FORWARD", rawText: "y".repeat(2_001), expiresAt: inDays(1) }),
    ).rejects.toThrow();
  });

  it("a re-delivered update (same update_id) stores one intake and replies again with the same launch", async () => {
    const { tgId, userId } = await telegramUser();
    const u = update(tgId, { text: "Raydium replay" });
    const a = await outcomeOf(await webhookPOST(webhook(u)));
    const b = await outcomeOf(await webhookPOST(webhook(u)));
    expect(a).toMatchObject({ action: "VERIFY" });
    expect(b).toMatchObject({ action: "VERIFY" });
    expect(await intakesOf(userId)).toHaveLength(1);
    expect(buttonUrlOf(sent[0])).toBe(buttonUrlOf(sent[1]));
  });

  it("over the per-sender window the update is dropped silently", async () => {
    const { tgId, userId } = await telegramUser();
    for (let i = 0; i < 10; i++) await forward(tgId, { text: `Raydium message ${i}` });
    expect(await intakesOf(userId)).toHaveLength(10);
    const { outcome } = await forward(tgId, { text: "Raydium message 11" });
    expect(outcome).toEqual({ handled: false, reason: "RATE_LIMITED" });
    expect(await intakesOf(userId)).toHaveLength(10);
    expect(sent).toHaveLength(10);
  });

  it("a failed reply delivery keeps the intake and reports the failure as a code", async () => {
    const { tgId, userId } = await telegramUser();
    transportFails = true;
    const { outcome } = await forward(tgId, { text: "Raydium while Telegram is down" });
    expect(outcome).toMatchObject({ handled: true, action: "VERIFY", delivered: false });
    const rows = await intakesOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("OPEN");
    // The handler itself names the reason, never the message.
    const direct = await handleTelegramUpdate(ctx.db, await loadProductConfig(ctx.db), update(tgId, { text: "Raydium again" }));
    expect(direct).toMatchObject({ handled: true, send: { sent: false, reason: "TRANSPORT_FAILED" } });
  });

  it("the only outbound call is sendMessage to api.telegram.org, and in tests it is the stub", () => {
    const src = readFileSync("src/server/telegram/bot-api.ts", "utf8");
    expect(src).toContain('export const TELEGRAM_API_BASE = "https://api.telegram.org"');
    expect(src.match(/fetch\(/g)).toHaveLength(1);
    expect(src).toContain('redirect: "error"');
    expect(buildSendMessagePayload({ chatId: 1, text: "t", buttons: [{ text: "b", webAppUrl: "https://x/ask?intake=i" }] })).toEqual({
      chat_id: 1,
      text: "t",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "b", web_app: { url: "https://x/ask?intake=i" } }]] },
    });
  });
});

/* ------------------------------------------------------------------ */
/* 3. deterministic project detection and the private-beta boundary    */
/* ------------------------------------------------------------------ */

describe("3. detection is the catalog and nothing else; beta scope is the existing config", () => {
  it("resolves one catalog project by slug, name, ticker, alias or two-word name; refuses to guess otherwise", async () => {
    expect(await detectProjectSlug(ctx.db, "Raydium's protocol fees fund RAY buybacks")).toBe("raydium");
    expect(await detectProjectSlug(ctx.db, "Pump.fun burns PUMP")).toBe("pump_fun");
    expect(await detectProjectSlug(ctx.db, "pump fun burns the token")).toBe("pump_fun");
    expect(await detectProjectSlug(ctx.db, "Lido: 20% of fees to stakers")).toBe("lido");
    expect(await detectProjectSlug(ctx.db, "Optimism will use 50% of Superchain revenue to buy back OP.")).toBeNull();
    // Two different projects: not a detection, the Interpreter sorts it out.
    expect(await detectProjectSlug(ctx.db, "Raydium vs Lido: which buyback is real?")).toBeNull();
    expect(await detectProjectSlug(ctx.db, "")).toBeNull();
  });

  it("no recognizable project: the intake is saved and the user is sent to prepare the question", async () => {
    const { tgId, userId } = await telegramUser();
    const { outcome, intakeId } = await forward(tgId, { text: "Optimism will use 50% of Superchain revenue to buy back OP." });
    expect(outcome).toMatchObject({ action: "OPEN" });
    expect((await intakeRow(intakeId!)).detectedProjectSlug).toBeNull();
    expect(sent[0].body.text).toContain("I saved the message. Open ATLAS to review and prepare the Research question.");
    expect(sent[0].body.text).not.toContain("Project:");
    expect(buttonUrlOf(sent[0])).toBe(`${ORIGIN}/ask?intake=${intakeId}`);
    await expectNothingSpent(userId);
  });

  it("a catalog project outside the private beta: told plainly, no intake, no button, nothing started", async () => {
    const { tgId, userId } = await telegramUser();
    const config = await loadProductConfig(ctx.db);
    expect(config.private_beta_project_slugs).not.toContain("uniswap");
    const res = await webhookPOST(webhook(update(tgId, { text: "Uniswap will turn on the fee switch for UNI holders" })));
    expect(await outcomeOf(res)).toMatchObject({ handled: true, action: "NOT_IN_BETA", delivered: true });
    expect(await intakesOf(userId)).toHaveLength(0);
    expect(sent[0].body.text).toBe("Project: Uniswap\n\nUniswap is not currently available in the private beta.");
    expect(sent[0].body.reply_markup).toBeUndefined();
    await expectNothingSpent(userId);
  });

  it("the beta list is read from the canonical config, never a second list", async () => {
    const { tgId, userId } = await telegramUser();
    await setPrivateBetaConfig(ctx.db, { enabled: true, projectSlugs: ["uniswap"], researchLimit: 5 });
    await __resetRuntime();
    const { outcome } = await forward(tgId, { text: "Uniswap fee switch" });
    expect(outcome).toMatchObject({ action: "VERIFY" });
    expect(await intakesOf(userId)).toHaveLength(1);
    expect(readFileSync("src/server/telegram/webhook.ts", "utf8")).not.toMatch(/\[\s*"raydium"/);
  });

  it("with the beta switch off the bot does not apply beta scope; the Mini App gates decide", async () => {
    const { tgId, userId } = await telegramUser();
    await setPrivateBetaConfig(ctx.db, { enabled: false, projectSlugs: [], researchLimit: 5 });
    await __resetRuntime();
    const { outcome } = await forward(tgId, { text: "Uniswap fee switch" });
    expect(outcome).toMatchObject({ action: "VERIFY" });
    expect(await intakesOf(userId)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. the owner's read                                                 */
/* ------------------------------------------------------------------ */

describe("4. GET /api/intakes/[id] — owner, ownership, expiry, bounded view", () => {
  it("the owner reads a bounded view carrying no Telegram identity; opening spends nothing", async () => {
    const { tgId, userId } = await telegramUser();
    const text = "Raydium routes 12% of fees to RAY buybacks";
    const { intakeId } = await forward(tgId, { text, forwardOrigin: channelOrigin() });
    const c = await authedFor(userId);
    const res = await intakeGET(get(`/api/intakes/${intakeId}`, c), { params: Promise.resolve({ id: intakeId! }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intake: Record<string, unknown> };
    expect(body.intake).toEqual({
      intakeId,
      status: "OPEN",
      rawText: text,
      detectedProject: { slug: "raydium", name: "Raydium", availableInPrivateBeta: true },
      sourceLabel: "Raydium Watch",
      sourceUrl: "https://t.me/raydiumwatch/4242",
      researchJobId: null,
    });
    const dump = JSON.stringify(body);
    expect(dump).not.toContain(tgId);
    expect(dump).not.toContain("-1001234567890");
    expect((await intakeRow(intakeId!)).status).toBe("OPEN");
    await expectNothingSpent(userId);
  });

  it("another user, an unknown id, a non-uuid, and no session are all refused without confirming existence", async () => {
    const { tgId } = await telegramUser();
    const { intakeId } = await forward(tgId, { text: "Raydium private claim" });
    const { userId: otherId } = await telegramUser();
    const other = await authedFor(otherId);
    const codes = await Promise.all([
      intakeGET(get(`/api/intakes/${intakeId}`, other), { params: Promise.resolve({ id: intakeId! }) }),
      intakeGET(get(`/api/intakes/00000000-0000-4000-8000-000000000000`, other), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) }),
      intakeGET(get(`/api/intakes/not-a-uuid`, other), { params: Promise.resolve({ id: "not-a-uuid" }) }),
    ]);
    expect(codes.map((r) => r.status)).toEqual([404, 404, 404]);
    const anon = await intakeGET(get(`/api/intakes/${intakeId}`, null), { params: Promise.resolve({ id: intakeId! }) });
    expect(anon.status).toBe(401);
  });

  // A finished job of this user's, for exercising consumption directly.
  async function terminalJobFor(userId: string): Promise<string> {
    const [job] = await ctx.db
      .insert(researchJobs)
      .values({
        userId,
        topicId: (await ctx.db.execute(sql`SELECT id FROM topics WHERE is_active LIMIT 1`)).rows[0]!.id as string,
        originalQuestion: "q",
        normalizedTaskHash: uniq("h"),
        entitlementAtStart: "ARI_CORE",
        capabilityAtStart: "FRESH_RESEARCH",
        budgetAtStart: {},
        idempotencyKey: uniq("k"),
        state: "SUCCEEDED",
      })
      .returning();
    return job.id;
  }

  it("an expired intake is gone for its owner too, and cannot be consumed by a stale id", async () => {
    const { tgId, userId } = await telegramUser();
    const { intakeId } = await forward(tgId, { text: "Raydium yesterday" });
    await ctx.db.update(researchIntakes).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(researchIntakes.id, intakeId!));
    const c = await authedFor(userId);
    expect((await intakeGET(get(`/api/intakes/${intakeId}`, c), { params: Promise.resolve({ id: intakeId! }) })).status).toBe(404);
    expect(await loadResearchIntakeForUser(ctx.db, { id: intakeId!, userId })).toBeNull();
    // Consumption shares the read's predicate: expired is gone for every purpose.
    expect(await consumeResearchIntake(ctx.db, { id: intakeId!, userId, researchJobId: await terminalJobFor(userId) })).toBe(false);
    expect(await intakeRow(intakeId!)).toMatchObject({ status: "OPEN", consumedAt: null, researchJobId: null });
  });

  it("a consumed intake reads as CONSUMED with no text", async () => {
    const { tgId, userId } = await telegramUser();
    const { intakeId } = await forward(tgId, { text: "Raydium consumed" });
    const job = { id: await terminalJobFor(userId) };
    expect(await consumeResearchIntake(ctx.db, { id: intakeId!, userId, researchJobId: job.id })).toBe(true);
    expect(await consumeResearchIntake(ctx.db, { id: intakeId!, userId, researchJobId: job.id })).toBe(false);
    const c = await authedFor(userId);
    const res = await intakeGET(get(`/api/intakes/${intakeId}`, c), { params: Promise.resolve({ id: intakeId! }) });
    expect(((await res.json()) as { intake: Record<string, unknown> }).intake).toMatchObject({ status: "CONSUMED", rawText: null, researchJobId: job.id });
  });
});

/* ------------------------------------------------------------------ */
/* 5. research start: canonical path, quota, consumption               */
/* ------------------------------------------------------------------ */

describe("5. Research starts only through the canonical path, and consumption follows the job", () => {
  async function betaForwarder(text = "Raydium routes 12% of fees to RAY buybacks") {
    const { tgId, userId } = await telegramUser();
    await grantPrivateBetaAccess(ctx.db, { userId, validUntil: inDays(30) });
    const { intakeId } = await forward(tgId, { text });
    return { userId, intakeId: intakeId!, c: await authedFor(userId) };
  }
  const startFrom = (c: Authed, interpretationId: string, intakeId: string | undefined, idempotencyKey = uniq("idem")) =>
    jobsPOST(post("/api/research-jobs", c, intakeId ? { interpretationId, idempotencyKey, intakeId } : { interpretationId, idempotencyKey }));
  const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

  it("a successful start creates the job through private-beta admission and marks the intake consumed", async () => {
    const { userId, intakeId, c } = await betaForwarder();
    await expectNothingSpent(userId);
    const interp = await interpretationFor(userId, "raydium");
    const res = await startFrom(c, interp, intakeId);
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { id: string } };
    const row = await intakeRow(intakeId);
    expect(row.status).toBe("CONSUMED");
    expect(row.consumedAt).not.toBeNull();
    expect(row.researchJobId).toBe(job.id);
    const [created] = await jobsOf(userId);
    expect(created.origin).toBe("PRIVATE_BETA");
    expect(await countPrivateBetaJobs(ctx.db, userId)).toBe(1);
    // A replay of the same start returns the same job and re-stamps nothing.
    const again = await jobsPOST(post("/api/research-jobs", c, { interpretationId: interp, idempotencyKey: created.idempotencyKey, intakeId }));
    expect(again.status).toBe(200);
    expect((await intakeRow(intakeId)).consumedAt?.getTime()).toBe(row.consumedAt?.getTime());
  });

  it("a refused start — project outside the beta — creates no job and leaves the intake OPEN for a retry", async () => {
    const { userId, intakeId, c } = await betaForwarder("Uniswap? no — ask about Raydium fees");
    const interp = await interpretationFor(userId, "uniswap");
    const res = await startFrom(c, interp, intakeId);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("BETA_PROJECT_NOT_AVAILABLE");
    expect((await intakeRow(intakeId)).status).toBe("OPEN");
    await expectNothingSpent(userId);
  });

  it("the beta research limit still applies, and a refusal consumes nothing", async () => {
    const { userId, intakeId, c } = await betaForwarder();
    await setPrivateBetaConfig(ctx.db, { enabled: true, projectSlugs: WAVE_1, researchLimit: 0 });
    await __resetRuntime();
    const res = await startFrom(c, await interpretationFor(userId, "raydium"), intakeId);
    expect(await errorOf(res)).toBe("BETA_RESEARCH_LIMIT_REACHED");
    expect((await intakeRow(intakeId)).status).toBe("OPEN");
    await expectNothingSpent(userId);
  });

  it("the one-active-job rule still applies: the second intake stays OPEN", async () => {
    const { userId, intakeId, c } = await betaForwarder();
    expect((await startFrom(c, await interpretationFor(userId, "raydium"), intakeId)).status).toBe(201);
    const [{ tgId }] = await ctx.db
      .select({ tgId: userIdentities.providerUserId })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId));
    const second = await forward(tgId, { text: "Lido burns 20% of fees" });
    const res = await startFrom(c, await interpretationFor(userId, "lido"), second.intakeId!);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("ACTIVE_JOB_EXISTS");
    expect((await intakeRow(second.intakeId!)).status).toBe("OPEN");
    expect(await jobsOf(userId)).toHaveLength(1);
  });

  it("a user without a grant is refused by the existing admission; nothing is consumed", async () => {
    const { tgId, userId } = await telegramUser();
    const { intakeId } = await forward(tgId, { text: "Raydium fees" });
    const c = await authedFor(userId);
    const res = await startFrom(c, await interpretationFor(userId, "raydium"), intakeId!);
    expect(await errorOf(res)).toBe("BETA_ACCESS_REQUIRED");
    expect((await intakeRow(intakeId!)).status).toBe("OPEN");
    await expectNothingSpent(userId);
  });

  it("someone else's intake id on a start grants nothing and consumes nothing of theirs", async () => {
    const victim = await betaForwarder();
    const attacker = await betaForwarder("Raydium attacker claim");
    const res = await startFrom(attacker.c, await interpretationFor(attacker.userId, "raydium"), victim.intakeId);
    expect(res.status).toBe(201);
    expect((await intakeRow(victim.intakeId)).status).toBe("OPEN");
    expect((await intakeRow(attacker.intakeId)).status).toBe("OPEN");
    expect(await jobsOf(victim.userId)).toHaveLength(0);
    const bad = await startFrom(attacker.c, await interpretationFor(attacker.userId, "raydium"), "not-a-uuid");
    expect(bad.status).toBe(404);
  });

  it("a start without an intake behaves exactly as before", async () => {
    const { userId, c } = await betaForwarder();
    const res = await startFrom(c, await interpretationFor(userId, "raydium"), undefined);
    expect(res.status).toBe(201);
    const [job] = await jobsOf(userId);
    await transitionJobState(ctx.db, job.id, "CANCELLED", "test: release");
    expect((await ctx.db.select().from(sessions).where(eq(sessions.userId, userId))).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6. the launch parameter and the Ask screen                          */
/* ------------------------------------------------------------------ */

describe("6. launch context is one opaque id; the Ask screen prefills an editable composer", () => {
  const id = "0b7f3f2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("start parameter and query parsing accept only a uuid", () => {
    expect(intakeIdFromSearch(`?intake=${id}`)).toBe(id);
    expect(intakeIdFromSearch(`?intake=${id.toUpperCase()}`)).toBe(id);
    expect(intakeIdFromSearch("?intake=Raydium%20buys%20back")).toBeNull();
    expect(intakeIdFromSearch("")).toBeNull();
    expect(intakeIdFromStartParam(id)).toBe(id);
    expect(intakeIdFromStartParam("intake_text_here")).toBeNull();
    expect(intakeIdFromStartParam(null)).toBeNull();
    expect(askPathForIntake(id)).toBe(`/ask?intake=${id}`);
    rememberLaunchIntake(id);
    expect(takeLaunchIntake()).toBe(id);
    expect(takeLaunchIntake()).toBeNull();
    expect(startParamOf({ start_param: id })).toBe(id);
    expect(startParamOf({ start_param: "has space" })).toBeNull();
    expect(startParamOf({ start_param: "x".repeat(65) })).toBeNull();
    expect(startParamOf({})).toBeNull();
  });

  it("the signed initData carries the start parameter through authentication; the dev bypass carries none", async () => {
    const fields: Record<string, string> = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 424242, first_name: "T" }),
      start_param: id,
    };
    fields.hash = computeInitDataHash(fields, process.env.BOT_TOKEN!);
    const initData = new URLSearchParams(fields).toString();
    const result = await authenticateTelegram(ctx.db, initData, "127.0.0.1");
    expect(result.startParam).toBe(id);
    // Tampering with the parameter after signing is a signature failure.
    const tampered = new URLSearchParams({ ...fields, start_param: "00000000-0000-4000-8000-000000000000" }).toString();
    await expect(authenticateTelegram(ctx.db, tampered, "127.0.0.1")).rejects.toMatchObject({ code: "INITDATA_INVALID_SIGNATURE" });
    const route = await authPOST(
      new Request("http://localhost/api/auth/telegram", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ initData }),
      }),
    );
    expect(route.status).toBe(200);
    expect(((await route.json()) as { startParam: string | null }).startParam).toBe(id);
  });

  it("the Ask screen loads the intake from the query, prefills the same editable textarea, and passes the id only to the start", () => {
    const page = readFileSync("app/(app)/ask/page.tsx", "utf8");
    expect(page).toContain("intakeIdFromSearch(window.location.search)");
    expect(page).toContain("api\n      .getIntake(id)");
    expect(page).toContain("setQuestion(view.rawText)");
    expect(page).not.toContain("readOnly");
    expect(page).toContain('intake.kind === "open" ? intake.view.intakeId : undefined');
    // Prefill is state, not a lock: the same onChange edits it.
    expect(page).toContain("onChange={(e) => setQuestion(e.target.value)}");
    // Nothing starts on load: the only start call is the user's tap.
    expect(page.match(/api\.startResearch\(/g)).toHaveLength(1);
    expect(page).toContain('data-testid="intake-notice"');
    expect(page).toContain('data-testid="intake-project-unavailable"');
    expect(page).toContain("intakeProjectNotAvailable");
  });

  it("the app routes a signed launch to /ask and keeps it across onboarding", () => {
    const ctxSrc = readFileSync("src/client/app-context.tsx", "utf8");
    expect(ctxSrc).toContain("intakeIdFromStartParam(auth?.startParam)");
    expect(ctxSrc).toContain("router.replace(askPathForIntake(launchIntake))");
    expect(ctxSrc).toContain("rememberLaunchIntake(launchIntake)");
    const onboarding = readFileSync("app/onboarding/page.tsx", "utf8");
    expect(onboarding).toContain("takeLaunchIntake()");
  });

  it("both dictionaries carry the intake copy", () => {
    for (const key of ["intakeFrom", "intakeViewOriginal", "intakeEditable", "intakeUnavailable", "intakeConsumed", "intakeProjectNotAvailable"] as const) {
      expect(typeof en.ask[key]).toBe("string");
      expect(typeof ru.ask[key]).toBe("string");
    }
    expect(en.ask.intakeProjectNotAvailable).toContain("{project}");
    expect(ru.ask.intakeProjectNotAvailable).toContain("{project}");
  });

  it("the parser reads text or caption, private chats only, and derives a public link only for a public channel", () => {
    const base = { update_id: 1, message: { message_id: 2, chat: { id: 3, type: "private" }, from: { id: 4 } } };
    expect(parseTelegramUpdate({ ...base, message: { ...base.message, text: " hi " } })).toMatchObject({ kind: "MESSAGE", text: " hi ", source: null, isCommand: false });
    expect(parseTelegramUpdate({ ...base, message: { ...base.message, caption: "cap" } })).toMatchObject({ kind: "MESSAGE", text: "cap" });
    expect(parseTelegramUpdate({ ...base, message: { ...base.message, text: "   " } })).toMatchObject({ kind: "NO_TEXT" });
    expect(parseTelegramUpdate({ ...base, message: { ...base.message, text: "x", forward_origin: channelOrigin() } })).toMatchObject({
      source: { label: "Raydium Watch", url: "https://t.me/raydiumwatch/4242" },
    });
    expect(parseTelegramUpdate({ ...base, message: { ...base.message, text: "x", forward_origin: channelOrigin({ chat: { id: 1, type: "channel", username: "bad name!" }, message_id: 1 }) } })).toMatchObject({
      source: { label: "Telegram channel", url: null },
    });
    expect(parseTelegramUpdate({ ...base, message: { ...base.message, text: "x", forward_origin: { type: "something_new" } } })).toMatchObject({ source: { label: "Telegram", url: null } });
    expect(parseTelegramUpdate({ update_id: 1, edited_message: {} })).toEqual({ kind: "IGNORED", reason: "NOT_A_MESSAGE" });
    expect(parseTelegramUpdate(null)).toEqual({ kind: "MALFORMED" });
  });
});
