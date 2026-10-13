import { errorResponse, requireMutation, requireUuid } from "@/src/server/auth/guards";
import { RateLimitedError } from "@/src/server/auth/rate-limit";
import { clarifyInterpretation } from "@/src/server/interpreter/interpret";
import { getDb, getProductConfig } from "@/src/server/runtime";

// Уточнение (phase-4-plan §3.2). Максимум 2 попытки — дальше flow
// закрывается фиксированным сообщением, без бесконечного переспрашивания.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const { id } = await params;
    requireUuid(id);
    const body = (await req.json().catch(() => ({}))) as { answer?: unknown };
    const out = await clarifyInterpretation(db, await getProductConfig(), {
      userId: session.userId,
      parentId: id,
      answer: body.answer,
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
