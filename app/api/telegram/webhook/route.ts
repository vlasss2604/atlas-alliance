import { timingSafeEqual } from "node:crypto";

import { handleTelegramUpdate } from "@/src/server/telegram/webhook";
import { getDb, getProductConfig } from "@/src/server/runtime";

// TELEGRAM BOT WEBHOOK — POST only, server-to-server.
//
// AUTHENTICATION. Telegram sends the secret given at webhook registration
// back in the `X-Telegram-Bot-Api-Secret-Token` header on every delivery.
// The route compares it in constant time against TELEGRAM_WEBHOOK_SECRET
// and refuses everything else. With no secret configured the route does
// not exist for anyone (503): an unregistered webhook must not be a public
// endpoint by accident. There is no session and no CSRF here because there
// is no browser — the only caller is Telegram, and the secret is what
// proves it.
//
// RESPONSES. Once authenticated the route answers 200 to everything,
// malformed and ignored updates included: Telegram re-delivers any update
// that did not get a 200, and re-delivering a malformed one changes
// nothing. What happened is reported in the body for the operator and
// logged as a code — never the message text, never a sender.
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return Response.json({ error: "WEBHOOK_NOT_CONFIGURED" }, { status: 503 });
  if (!secretMatches(req.headers.get(SECRET_HEADER), expected)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const raw = await req.json().catch(() => null);
  if (raw === null) return Response.json({ handled: false, reason: "MALFORMED" });
  try {
    const outcome = await handleTelegramUpdate(getDb(), await getProductConfig(), raw);
    if (outcome.handled && !outcome.send.sent) {
      console.warn(`[telegram] reply not delivered: ${outcome.send.reason} (${outcome.action})`);
    }
    return Response.json(
      outcome.handled ? { handled: true, action: outcome.action, delivered: outcome.send.sent } : outcome,
    );
  } catch (e) {
    console.error("[telegram] update failed:", e instanceof Error ? e.name : "error");
    return Response.json({ handled: false, reason: "INTERNAL" });
  }
}
