"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type ResearchJobDetail } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { useJobEvents, type JobEvent } from "@/src/client/use-job-events";

type Job = Awaited<ReturnType<typeof api.getResearchJobs>>["jobs"][number];

const ACTIVE_STATES = ["QUEUED", "RUNNING", "AWAITING_CLARIFICATION"];
const TERMINAL_STATES = ["SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"];

// Owner Manual Alpha App Test (D-123) — minimum result-detail experience.
// Reuses the page's existing glass/pill visual language; no new route, no
// redesign. Translates S7's closed status vocabulary and the worker's
// termination-reason vocabulary into plain product language (dict.research
// .detail) rather than showing raw S4/S5/S6/S7 JSON in the primary view.
function JobDetail({ detail }: { detail: ResearchJobDetail }) {
  const { dict } = useApp();
  const d = dict.research.detail;
  const claim = detail.claimSupport;
  const statusText = claim ? d.statusLabel[claim.status] ?? claim.status : null;
  const terminationText = detail.job.terminationReason
    ? d.terminationLabel[detail.job.terminationReason] ?? detail.job.terminationReason
    : null;

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-[var(--atlas-border)] pt-3">
      <section>
        <h3 className="text-xs font-semibold text-[var(--atlas-text-dim)]">
          {d.findingTitle}
        </h3>
        {claim ? (
          <p className="mt-1 text-sm">
            {claim.intent} — <span className="font-medium">{statusText}</span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-[var(--atlas-text-dim)]">
            {terminationText ?? d.noEvidence}
          </p>
        )}
      </section>

      {detail.execution.attemptedSteps > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-[var(--atlas-text-dim)]">
            {d.mechanismTitle}
          </h3>
          {/* Counts come from research_attempts (what the controller
              actually attempted), never from mechanism.flows.length —
              flows are mechanism branches, so an unbranched path read as
              "1 step traced" even when all eight steps were researched. */}
          <p className="mt-1 text-sm text-[var(--atlas-text-dim)]">
            {d.stepsTraced(
              detail.execution.attemptedSteps,
              detail.execution.attemptedComponents,
            )}
          </p>
        </section>
      )}

      {/* Proof evidence is read ONLY from detail.finding, which the API
          scopes to this claim's own components. detail.evidence is the
          whole job and must never be rendered here — doing exactly that
          is what put GOVERNANCE_BASIS rows under a NET_EFFECT finding. */}
      <section>
        <h3 className="text-xs font-semibold text-[var(--atlas-text-dim)]">
          {d.evidenceTitle}
        </h3>
        {detail.finding.supporting.length === 0 ? (
          <p className="mt-1 text-sm text-[var(--atlas-text-dim)]">
            {d.noSupportingEvidence}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {detail.finding.supporting.map((e) => (
              <li key={e.id} className="text-sm">
                <p>{e.summary ?? e.fragment}</p>
                {e.doesNotProve && (
                  <p className="text-xs text-[var(--atlas-text-dim)]">
                    {e.doesNotProve}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.finding.contradicting.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-[var(--atlas-text-dim)]">
            {d.contradictingTitle}
          </h3>
          <ul className="mt-1 flex flex-col gap-2">
            {detail.finding.contradicting.map((e) => (
              <li key={e.id} className="text-sm">
                <p>{e.summary ?? e.fragment}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Excluded material is shown only in its OWN section, never mixed
          into the proof list, and always with the reason it was refused. */}
      {detail.finding.excluded.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-[var(--atlas-text-dim)]">
            {d.excludedTitle}
          </h3>
          <p className="mt-1 text-xs text-[var(--atlas-text-dim)]">{d.excludedNote}</p>
          <ul className="mt-1 flex flex-col gap-2">
            {detail.finding.excluded.map((e) => (
              <li key={e.id} className="text-sm text-[var(--atlas-text-dim)]">
                <p>{e.summary ?? e.fragment}</p>
                <p className="text-xs">
                  {d.exclusionLabel[e.exclusionReason] ?? e.exclusionReason}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.finding.supporting.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-[var(--atlas-text-dim)]">
            {d.sourcesTitle}
          </h3>
          <ul className="mt-1 flex flex-col gap-1">
            {[
              ...new Map(
                detail.finding.supporting.map((e) => [e.retrievedUrl, e]),
              ).values(),
            ].map((e) => (
              <li key={e.retrievedUrl} className="truncate text-xs">
                <a
                  href={e.retrievedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--atlas-cyan)]"
                >
                  {e.sourceTitle ?? e.retrievedUrl}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details>
        <summary className="cursor-pointer text-xs text-[var(--atlas-text-dim)]">
          {d.debugTitle}
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[10px] text-[var(--atlas-text-dim)]">
          {JSON.stringify(detail, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export default function ResearchPage() {
  const { dict, refresh } = useApp();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ResearchJobDetail | "loading" | "error">>({});

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

  const openJob = async (job: Job) => {
    void markRead(job);
    if (!TERMINAL_STATES.includes(job.state)) return;
    if (openJobId === job.id) {
      setOpenJobId(null);
      return;
    }
    setOpenJobId(job.id);
    if (!details[job.id]) {
      setDetails((prev) => ({ ...prev, [job.id]: "loading" }));
      try {
        const detail = await api.getResearchJob(job.id);
        setDetails((prev) => ({ ...prev, [job.id]: detail }));
      } catch {
        setDetails((prev) => ({ ...prev, [job.id]: "error" }));
      }
    }
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
                    onClick={() => void openJob(job)}
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
                  {openJobId === job.id &&
                    (() => {
                      const d = details[job.id];
                      if (d === "loading") {
                        return (
                          <p className="mt-3 text-sm text-[var(--atlas-text-dim)]">
                            {dict.research.detail.loading}
                          </p>
                        );
                      }
                      if (d === "error") {
                        return (
                          <p className="mt-3 text-sm text-[var(--atlas-text-dim)]">
                            {dict.research.detail.error}
                          </p>
                        );
                      }
                      if (d) {
                        return <JobDetail detail={d} />;
                      }
                      return null;
                    })()}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
