import { Client } from "pg";

// Единый LISTEN-клиент процесса (phase-3-plan §3). PostgreSQL — source of
// truth: подписчик получает только сигнал «job изменился» и сам перечитывает
// состояние из БД. Потеря уведомления не критична — reconnect/поллинг
// восстанавливают картину.

type Subscriber = () => void;

const subscribers = new Map<string, Set<Subscriber>>(); // jobId -> callbacks
let client: Client | null = null;
let connecting: Promise<void> | null = null;
let reconnectDelayMs = 1000;

async function ensureListener(): Promise<void> {
  if (client) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query("LISTEN research_job_events");
    c.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        const { job_id } = JSON.parse(msg.payload) as { job_id: string };
        subscribers.get(job_id)?.forEach((fn) => fn());
      } catch {
        /* мусор в канале игнорируем — истина в БД */
      }
    });
    c.on("error", () => void restartListener());
    c.on("end", () => void restartListener());
    client = c;
    reconnectDelayMs = 1000;
  })();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

async function restartListener(): Promise<void> {
  const old = client;
  client = null;
  old?.removeAllListeners();
  await old?.end().catch(() => {});
  if (subscribers.size === 0) return;
  await new Promise((r) => setTimeout(r, reconnectDelayMs));
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  // Падение LISTEN не роняет API: подписчики продолжают жить, клиент
  // деградирует в собственный polling; после reconnect сигналим всем —
  // пусть перечитают состояние (могли пропустить события).
  await ensureListener().catch(() => {});
  for (const subs of subscribers.values()) subs.forEach((fn) => fn());
}

export async function subscribeJobEvents(
  jobId: string,
  onChange: Subscriber,
): Promise<() => void> {
  await ensureListener();
  let set = subscribers.get(jobId);
  if (!set) {
    set = new Set();
    subscribers.set(jobId, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) subscribers.delete(jobId);
  };
}

// Для тестов: полное закрытие слушателя.
export async function __shutdownJobEvents(): Promise<void> {
  subscribers.clear();
  const old = client;
  client = null;
  old?.removeAllListeners();
  await old?.end().catch(() => {});
}
