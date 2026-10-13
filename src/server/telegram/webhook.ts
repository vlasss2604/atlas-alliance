import { and, eq } from "drizzle-orm";

import { getEnv } from "../auth/guards";
import { hitRateLimit, RateLimitedError } from "../auth/rate-limit";
import type { ProductConfig } from "../config/product";
import type { Database } from "../db/client";
import { projects, userIdentities, users } from "../db/schema";
import { privateBetaOpen, privateBetaProjectAllowed } from "../services/private-beta";
import { detectProjectSlug } from "../services/project-detection";
import { createResearchIntake } from "../services/research-intake";
import { sendTelegramMessage, type OutboundMessage, type SendResult } from "./bot-api";
import { excerptOf, repliesFor, type ReplyLanguage } from "./replies";
import { parseTelegramUpdate } from "./update";

// THE TELEGRAM INTAKE ADAPTER — THIN, AT THE EDGE (D-125).
//
//   Telegram update → parse the little V1 reads → sender → canonical user
//   → deterministic project detection → ONE intake row → ONE reply.
//
// It creates no interpretation, no job, no source, no evidence, spends no
// provider budget and consults no model. The Research that may follow
// starts only when the user opens the Mini App and presses Start Proof,
// through the canonical path, which is where every entitlement, scope and
// quota rule is enforced. What this adapter checks is only enough to word
// an honest reply: it never grants and never refuses a Research.
//
// IDENTITY. The sender's Telegram id maps to users.id through the existing
// user_identities (provider='TELEGRAM') row that Mini App sign-in created.
// A sender with no such row is told to open ATLAS first: no account and no
// intake is created on a forward, exactly as the beta grant tool requires
// the user to have signed in once.
//
// RATE. One bounded window per verified sender, on the existing
// auth_rate_limits mechanism under its own bucket, so forwards and sign-ins
// never spend each other's allowance. Over the limit the update is dropped
// silently: a reply would be the thing being spammed.
//
// REPLY FAILURE IS NOT INTAKE FAILURE. The row is committed before the
// reply is attempted; a failed send is reported as a code and the intake
// stays available to the Mini App.
const INTAKE_RATE_LIMIT = 10;
const INTAKE_RATE_WINDOW_SEC = 600;

export type WebhookOutcome =
  | { handled: false; reason: "MALFORMED" | "IGNORED" | "RATE_LIMITED" }
  | { handled: true; action: "SIGN_IN_FIRST" | "NEED_TEXT" | "HINT" | "NOT_IN_BETA"; intakeId: null; send: SendResult }
  | { handled: true; action: "VERIFY" | "OPEN"; intakeId: string; send: SendResult };

// The Mini App origin is the first allowed frontend origin — the same value
// the Origin check trusts, so the bot can only ever send users to ATLAS.
export function miniAppOrigin(): string {
  return getEnv("ALLOWED_ORIGINS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
}

export function intakeLaunchUrl(intakeId: string): string {
  return `${miniAppOrigin()}/ask?intake=${intakeId}`;
}

async function canonicalUser(db: Database, telegramUserId: string): Promise<{ userId: string; language: ReplyLanguage } | null> {
  const [row] = await db
    .select({ userId: userIdentities.userId, language: users.language })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, "TELEGRAM"), eq(userIdentities.providerUserId, telegramUserId)));
  if (!row) return null;
  return { userId: row.userId, language: row.language === "RU" ? "RU" : "EN" };
}

export async function handleTelegramUpdate(
  db: Database,
  config: ProductConfig,
  raw: unknown,
  send: (m: OutboundMessage) => Promise<SendResult> = sendTelegramMessage,
): Promise<WebhookOutcome> {
  const update = parseTelegramUpdate(raw);
  if (update.kind === "MALFORMED") return { handled: false, reason: "MALFORMED" };
  if (update.kind === "IGNORED") return { handled: false, reason: "IGNORED" };

  try {
    await hitRateLimit(db, `tgintake:${update.senderId}`, INTAKE_RATE_LIMIT, INTAKE_RATE_WINDOW_SEC);
  } catch (e) {
    if (e instanceof RateLimitedError) return { handled: false, reason: "RATE_LIMITED" };
    throw e;
  }

  const user = await canonicalUser(db, update.senderId);
  const t = repliesFor(user?.language ?? "EN");
  if (!user) {
    return { handled: true, action: "SIGN_IN_FIRST", intakeId: null, send: await send({ chatId: update.chatId, text: t.signInFirst }) };
  }
  if (update.kind === "NO_TEXT") {
    return { handled: true, action: "NEED_TEXT", intakeId: null, send: await send({ chatId: update.chatId, text: t.needText }) };
  }
  if (update.isCommand) {
    return { handled: true, action: "HINT", intakeId: null, send: await send({ chatId: update.chatId, text: t.hint }) };
  }

  const slug = await detectProjectSlug(db, update.text);
  const project = slug ? (await db.select({ slug: projects.slug, name: projects.name }).from(projects).where(eq(projects.slug, slug)))[0] ?? null : null;

  // Recognised, and the beta in force cannot take it: say so and store
  // nothing — there is no Research for the Mini App to prepare. (With the
  // beta switch off this check does not apply; the Mini App gates decide.)
  if (project && privateBetaOpen(config) && !privateBetaProjectAllowed(config, project.slug)) {
    const text = `${t.project}: ${project.name}\n\n${t.notInBeta(project.name)}`;
    return { handled: true, action: "NOT_IN_BETA", intakeId: null, send: await send({ chatId: update.chatId, text }) };
  }

  const { intake } = await createResearchIntake(db, {
    userId: user.userId,
    origin: "TELEGRAM_FORWARD",
    rawText: update.text,
    sourceLabel: update.source?.label ?? null,
    sourceUrl: update.source?.url ?? null,
    detectedProjectSlug: project?.slug ?? null,
    externalRef: `tg:${update.updateId}`,
  });

  const launch = intakeLaunchUrl(intake.id);
  if (project) {
    const text = `${t.received}\n\n${t.project}: ${project.name}\n\n“${excerptOf(intake.rawText)}”`;
    const result = await send({ chatId: update.chatId, text, buttons: [{ text: t.verify, webAppUrl: launch }] });
    return { handled: true, action: "VERIFY", intakeId: intake.id, send: result };
  }
  const text = `${t.received}\n\n${t.saved}`;
  const result = await send({ chatId: update.chatId, text, buttons: [{ text: t.open, webAppUrl: launch }] });
  return { handled: true, action: "OPEN", intakeId: intake.id, send: result };
}
