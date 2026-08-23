"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { useJobEvents, type JobEvent } from "@/src/client/use-job-events";

type Job = Awaited<ReturnType<typeof api.getResearchJobs>>["jobs"][number];

const ACTIVE_STATES = ["QUEUED", "RUNNING", "AWAITING_CLARIFICATION"];
const TERMINAL_STATES = ["SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"];

export default function ResearchPage() {
  const { dict, refresh } = useApp();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  useEffect(() => {
    void api.getResearchJobs().then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
  }, []);

  // Инвариант «один активный job на пользователя» ⇒ максимум одна подписка.
  const activeJob = useMemo(
    () => jobs?.find((j) => ACTIVE_STATES.includes(j.state)) ?? null,
    [jobs],
  );

  const onJobEvent = useCallback(
    (e: JobEvent) => {
      setJobs((prev) =>
        prev
          ? prev.map((j) =>
              j.id === activeJob?.id
                ? {
                    ...j,
                    state: e.state,
                    progressStage: e.progressStage,
                    unread: e.unread,
                    finishedAt: e.finishedAt,
                  }
                : j,
            )
          : prev,
      );
      // Терминал → обновить unread-точку на ARI-кнопке.
      if (TERMINAL_STATES.includes(e.state)) void refresh();
    },
    [activeJob?.id, refresh],
  );

  useJobEvents(activeJob?.id ?? null, onJobEvent);

  const markRead = async (job: Job) => {
    if (!job.unread) return;
    setJobs((prev) =>
      prev ? prev.map((j) => (j.id === job.id ? { ...j, unread: false } : j)) : prev,
    );
    await api.markRead(job.id).catch(() => {});
    void refresh();
  };

  const cancelJob = async (job: Job) => {
    if (cancelling) return;
    setCancelling(job.id);
    try {
      await api.cancelJob(job.id);
      setJobs((prev) =>
        prev
          ? prev.map((j) => (j.id === job.id ? { ...j, state: "CANCELLED" } : j))
          : prev,
      );
    } catch {
      /* job уже завершился — придёт актуальное состояние по SSE/poll */
    } finally {
      setCancelling(null);
    }
  };

  const statusText = (job: Job): string =>
    job.state === "RUNNING"
      ? dict.research.stages[job.progressStage - 1]
      : (dict.research.states[job.state] ?? job.state);

  return (
    <main className="enter flex flex-col gap-4">
      <h1 className="pt-4 text-xl font-semibold">{dict.research.title}</h1>
      {jobs === null ? (
        <p className="text-sm text-[var(--atlas-text-dim)]">{dict.common.loading}</p>
      ) : jobs.length === 0 ? (
        <div className="glass px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
          {dict.research.empty}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {jobs.map((job) => {
            const active = ACTIVE_STATES.includes(job.state);
            return (
              <li key={job.id}>
                <div
                  className={`glass relative w-full px-4 py-3 text-left ${
                    job.unread ? "unread-dot" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void markRead(job)}
                    className="block w-full text-left"
                  >
                    <span className="block truncate text-sm">
                      {job.originalQuestion}
                    </span>
                    <span
                      className={`mt-1 block text-xs ${
                        active
                          ? "text-[var(--atlas-cyan)]"
                          : "text-[var(--atlas-text-dim)]"
                      }`}
                      data-testid={`job-status-${job.id}`}
                    >
                      {statusText(job)}
                    </span>
                  </button>
                  {active && (
                    <button
                      type="button"
                      onClick={() => void cancelJob(job)}
                      disabled={cancelling === job.id}
                      className="pill mt-2 border border-[var(--atlas-border)] px-3 py-1 text-xs text-[var(--atlas-text-dim)]"
                    >
                      {dict.research.cancel}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
