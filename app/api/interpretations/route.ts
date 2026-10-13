import { errorResponse, requireMutation } from "@/src/server/auth/guards";
import { RateLimitedError } from "@/src/server/auth/rate-limit";
import { createInterpretation } from "@/src/server/interpreter/interpret";
import { getDb, getProductConfig } from "@/src/server/runtime";

// Question Interpreter (phase-4-plan §3.1). Один лёгкий AI-вызов;
// исследование отсюда не запускается — только понимание задачи.
export async function POST(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const body = (await req.json().catch(() => ({}))) as { question?: unknown };
    const out = await createInterpretation(db, await getProductConfig(), {
      userId: session.userId,
      question: body.question,
    });
    return Response.json(out, { status: 201 });
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
