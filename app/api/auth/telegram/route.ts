import { authenticateTelegram } from "@/src/server/auth/authenticate";
import {
  errorResponse,
  HttpError,
  requireAllowedOrigin,
} from "@/src/server/auth/guards";
import { RateLimitedError } from "@/src/server/auth/rate-limit";
import { getDb } from "@/src/server/runtime";

// Bootstrap endpoint (phase-2-plan §3.1): единственный state-changing
// endpoint БЕЗ session+CSRF — он их создаёт. Его защита: Origin allowlist →
// IP limit → подпись initData → verified-TG limit.
export async function POST(req: Request): Promise<Response> {
  try {
    requireAllowedOrigin(req);
    const db = getDb();

    const body = (await req.json().catch(() => ({}))) as {
      initData?: string;
      dev?: boolean;
    };

    // Dev-bypass: только development-сборка + явный флаг окружения.
    if (
      process.env.NODE_ENV === "development" &&
      process.env.AUTH_DEV_BYPASS === "1" &&
      body.dev
    ) {
      const { devAuthenticate } = await import("@/src/server/auth/dev-bypass");
      const result = await devAuthenticate(db);
      return Response.json(
        { csrfToken: result.csrfToken, onboardingCompleted: result.onboardingCompleted },
        { status: 200, headers: { "Set-Cookie": result.setCookie } },
      );
    }

    // A browser outside Telegram has no initData, so api.ts sends
    // { dev: true } (src/client/api.ts). In a development build that body
    // can ONLY be served by the bypass above; falling through to
    // authenticateTelegram() guarantees failure, and the failure it
    // produces is actively misleading — getEnv("BOT_TOKEN") throws, which
    // errorResponse() reports as a generic 500 INTERNAL. The owner then
    // sees "Не удалось обработать вопрос" in the UI, with the real cause
    // (AUTH_DEV_BYPASS is not enabled) visible only as a server-log line
    // about a Telegram bot token they never needed for desktop dev.
    //
    // Naming the actual missing prerequisite costs nothing and keeps the
    // security boundary EXACTLY where it was: this branch only rewrites
    // the error for a request that was already going to fail, is reachable
    // only when NODE_ENV === "development", and grants no session. In a
    // production build a { dev: true } body still falls through to real
    // Telegram authentication, byte for byte as before.
    if (process.env.NODE_ENV === "development" && body.dev) {
      throw new HttpError(503, "AUTH_DEV_BYPASS_DISABLED");
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const result = await authenticateTelegram(db, body.initData ?? "", ip);
    return Response.json(
      { csrfToken: result.csrfToken, onboardingCompleted: result.onboardingCompleted },
      { status: 200, headers: { "Set-Cookie": result.setCookie } },
    );
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return Response.json(
        { error: "RATE_LIMITED" },
        { status: 429, headers: { "Retry-After": String(e.retryAfterSec) } },
      );
    }
    return errorResponse(e);
  }
}
