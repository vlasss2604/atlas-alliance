import { and, eq } from "drizzle-orm";

import { errorResponse, HttpError, requireSession } from "@/src/server/auth/guards";
import { researchJobs } from "@/src/server/db/schema";
import { subscribeJobEvents } from "@/src/server/events/job-events";
import { getDb } from "@/src/server/runtime";

export const dynamic = "force-dynamic";

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"];
const HEARTBEAT_MS = 15_000;
const MAX_STREAMS_PER_USER = 2;

// Реестр активных SSE процесса: не более 2 на пользователя,
// третье подключение вытесняет старейшее (phase-3-plan §3).
const activeStreams = new Map<string, Array<() => void>>();

function registerStream(userId: string, close: () => void): () => void {
  const list = activeStreams.get(userId) ?? [];
  list.push(close);
  if (list.length > MAX_STREAMS_PER_USER) {
    const oldest = list.shift();
    oldest?.();
  }
  activeStreams.set(userId, list);
  return () => {
    const cur = activeStreams.get(userId) ?? [];
    const idx = cur.indexOf(close);
    if (idx >= 0) cur.splice(idx, 1);
    if (cur.length === 0) activeStreams.delete(userId);
    else activeStreams.set(userId, cur);
  };
}

// SSE — только транспорт уведомлений; source of truth — PostgreSQL.
// Каждое событие — свежее чтение из БД; подключение начинается с текущего
// состояния, поэтому пропущенные во время разрыва события не имеют значения.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireSession(db, req);
    const { id } = await params;

    const readJob = async () => {
      const [job] = await db
        .select({
          state: researchJobs.state,
          progressStage: researchJobs.progressStage,
          memoryStatus: researchJobs.memoryStatus,
          unread: researchJobs.unread,
          finishedAt: researchJobs.finishedAt,
        })
        .from(researchJobs)
        .where(and(eq(researchJobs.id, id), eq(researchJobs.userId, session.userId)));
      return job ?? null;
    };

    const initial = await readJob();
    if (!initial) throw new HttpError(404, "NOT_FOUND");

    const encoder = new TextEncoder();
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup?.();
          try {
            controller.close();
          } catch {
            /* уже закрыт */
          }
        };

        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            close();
          }
        };

        // Сериализация конкурентных уведомлений: одно чтение за раз + один
        // отложенный повтор — последнее состояние никогда не теряется.
        let reading = false;
        let pending = false;
        const emit = async () => {
          if (closed) return;
          if (reading) {
            pending = true;
            return;
          }
          reading = true;
          try {
            const job = await readJob();
            if (!job) return close(); // job удалён (удаление аккаунта)
            send(job);
            if (TERMINAL.includes(job.state)) close();
          } finally {
            reading = false;
            if (pending && !closed) {
              pending = false;
              void emit();
            }
          }
        };

        const unsubscribe = await subscribeJobEvents(id, () => void emit());
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: hb\n\n`));
          } catch {
            close();
          }
        }, HEARTBEAT_MS);
        const unregister = registerStream(session.userId, close);
        const onAbort = () => close();
        req.signal.addEventListener("abort", onAbort);

        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          unregister();
          req.signal.removeEventListener("abort", onAbort);
        };

        // Стартовое событие — текущее состояние из БД.
        send(initial);
        if (TERMINAL.includes(initial.state)) close();
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
