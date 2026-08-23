import { authenticateTelegram } from "@/src/server/auth/authenticate";
import {
  errorResponse,
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
