import { hitRateLimit, RateLimitedError } from "@/src/server/auth/rate-limit";
import { errorResponse, HttpError, requireMutation } from "@/src/server/auth/guards";
import { BetaInviteRefusal, redeemBetaInvite } from "@/src/server/services/private-beta";
import { getDb, getProductConfig } from "@/src/server/runtime";

// CREATOR BETA INVITE REDEMPTION (D-170).
//
// The user has already signed in the ordinary way (Telegram initData →
// session); this route only turns a valid creator invite into the SAME
// private-beta grant the owner tool writes, for the SESSION's own user.
// The body carries the opaque invite and nothing else — no user id, no
// Telegram id — so a client can never grant anyone but itself. No account
// is created here. Idempotent: a user who already holds a valid grant is
// told so and left untouched.
const REDEEM_RATE_LIMIT = 10;
const REDEEM_RATE_WINDOW_SEC = 600;

export async function POST(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const body = (await req.json().catch(() => null)) as { invite?: unknown } | null;
    if (!body || typeof body.invite !== "string" || body.invite.length > 64) throw new HttpError(400, "BAD_REQUEST");
    await hitRateLimit(db, `betainvite:${session.userId}`, REDEEM_RATE_LIMIT, REDEEM_RATE_WINDOW_SEC);
    try {
      const result = await redeemBetaInvite(db, await getProductConfig(), { userId: session.userId, invite: body.invite });
      return Response.json({ result });
    } catch (e) {
      if (e instanceof BetaInviteRefusal) throw new HttpError(403, e.reason);
      throw e;
    }
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(e.retryAfterSec) } });
    }
    return errorResponse(e);
  }
}
