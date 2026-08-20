"use client";

import { useEffect, useState } from "react";

import { api } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";

type Job = Awaited<ReturnType<typeof api.getResearchJobs>>["jobs"][number];

export default function ResearchPage() {
  const { dict, refresh } = useApp();
  const [jobs, setJobs] = useState<Job[] | null>(null);

  useEffect(() => {
    void api.getResearchJobs().then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
  }, []);

  const markRead = async (job: Job) => {
    if (!job.unread) return;
    setJobs((prev) =>
      prev ? prev.map((j) => (j.id === job.id ? { ...j, unread: false } : j)) : prev,
    );
    await api.markRead(job.id).catch(() => {});
    void refresh();
  };

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
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => void markRead(job)}
                className={`glass pill relative w-full px-4 py-3 text-left ${
                  job.unread ? "unread-dot" : ""
                }`}
              >
                <span className="block truncate text-sm">{job.originalQuestion}</span>
                <span className="mt-1 block text-xs text-[var(--atlas-text-dim)]">
                  {job.state === "RUNNING" || job.state === "QUEUED"
                    ? dict.research.stages[job.progressStage - 1]
                    : new Date(job.finishedAt ?? job.createdAt).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
