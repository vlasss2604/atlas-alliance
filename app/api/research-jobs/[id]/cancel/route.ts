import { and, eq } from "drizzle-orm";

import { errorResponse, HttpError, requireMutation } from "@/src/server/auth/guards";
import { researchJobs } from "@/src/server/db/schema";
import {
  resolveDemoReservation,
  transitionJobState,
} from "@/src/server/jobs/research-jobs";
import { getDb } from "@/src/server/runtime";

const ACTIVE = ["QUEUED", "RUNNING", "AWAITING_CLARIFICATION"];

function isCheckViolation(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code === "23514";
}

// Cancel (phase-3-plan §4): активный → CANCELLED + возврат DEMO-слота
// в одной транзакции. Идемпотентен. Гонку с worker разруливает state
// machine БД: проигравший переход получает check_violation.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const { id } = await params;

    const [job] = await db
      .select()
      .from(researchJobs)
      .where(and(eq(researchJobs.id, id), eq(researchJobs.userId, session.userId)));
    if (!job) throw new HttpError(404, "NOT_FOUND");

    if (job.state === "CANCELLED") {
      return Response.json({ cancelled: true, already: true });
    }
    if (!ACTIVE.includes(job.state)) {
      throw new HttpError(409, "ALREADY_FINISHED");
    }

    try {
      await db.transaction(async (tx) => {
        await transitionJobState(tx, id, "CANCELLED", "user cancel");
        if (job.entitlementAtStart === "DEMO") {
          await resolveDemoReservation(tx, id, "RELEASED");
        }
      });
    } catch (e) {
      if (isCheckViolation(e)) {
        // Worker успел завершить job между нашим чтением и переходом.
        const [current] = await db
          .select({ state: researchJobs.state })
          .from(researchJobs)
          .where(eq(researchJobs.id, id));
        if (current?.state === "CANCELLED") {
          return Response.json({ cancelled: true, already: true });
        }
        throw new HttpError(409, "ALREADY_FINISHED");
      }
      throw e;
    }
    return Response.json({ cancelled: true });
  } catch (e) {
    return errorResponse(e);
  }
}
