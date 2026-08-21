"use client";

import { useEffect, useRef } from "react";

export interface JobEvent {
  state: string;
  progressStage: number;
  memoryStatus: string;
  unread: boolean;
  finishedAt: string | null;
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"];
const MAX_SSE_RETRIES = 3;
const POLL_MS = 5000;

// Живой прогресс job (phase-3-plan §5). Source of truth — сервер/БД:
// хук лишь доставляет свежее состояние; при недоступности SSE молча
// деградирует в polling. Комплексность невидима пользователю (директива §2).
export function useJobEvents(
  jobId: string | null,
  onUpdate: (e: JobEvent) => void,
): void {
  const onUpdateRef = useRef(onUpdate);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let es: EventSource | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const handle = (e: JobEvent) => {
      if (stopped) return;
      onUpdateRef.current(e);
      if (TERMINAL.includes(e.state)) stop();
    };

    const startPolling = () => {
      if (stopped || pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/research-jobs`, { credentials: "include" });
          if (!res.ok) return;
          const { jobs } = (await res.json()) as {
            jobs: (JobEvent & { id: string })[];
          };
          const job = jobs.find((j) => j.id === jobId);
          if (job) handle(job);
        } catch {
          /* следующая попытка по таймеру */
        }
      }, POLL_MS);
    };

    const connect = () => {
      if (stopped) return;
      es = new EventSource(`/api/research-jobs/${jobId}/events`);
      es.onmessage = (msg) => {
        retries = 0;
        try {
          handle(JSON.parse(msg.data) as JobEvent);
        } catch {
          /* мусор игнорируем — придёт следующее событие или poll */
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (stopped) return;
        retries += 1;
        if (retries <= MAX_SSE_RETRIES) {
          retryTimer = setTimeout(connect, 1000 * 2 ** (retries - 1));
        } else {
          startPolling();
        }
      };
    };

    const stop = () => {
      stopped = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
    };

    connect();
    return stop;
  }, [jobId]);
}
