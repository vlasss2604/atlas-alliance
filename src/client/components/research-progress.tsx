"use client";

import { deriveProgress, type ProgressInput } from "../research-model";

// LIVE RESEARCH STATE.
//
// The stage shown is chosen by research-model's deriveProgress, which reads
// the engine's PERSISTED acquisition phase first and only falls back to the
// stage counter before acquisition begins. That is the whole reason this
// component cannot show "checking previous research" for a job that is
// already fetching or extracting.
export function ResearchProgress({ job }: { job: ProgressInput }) {
  const progress = deriveProgress(job);

  return (
    <section className="panel p-5 sm:p-6" data-testid="research-progress">
      <p className="eyebrow eyebrow-cyan">Research process</p>
      <div className="rail mt-4" data-progress-source={progress.source}>
        {progress.stages.map((stage, i) => (
          <div key={stage.key} className="rail-item" data-stage={stage.key} data-state={stage.state}>
            <span
              className={
                "rail-mark " +
                (stage.state === "DONE"
                  ? "rail-mark-done"
                  : stage.state === "ACTIVE"
                    ? "rail-mark-active"
                    : "")
              }
            >
              {stage.state === "DONE" ? <CheckIcon /> : i + 1}
            </span>
            <span
              className={
                "pt-0.5 text-[0.9rem] " +
                (stage.state === "PENDING"
                  ? "text-[var(--atlas-text-dim)]"
                  : stage.state === "ACTIVE"
                    ? "font-medium text-[var(--atlas-text)]"
                    : "text-[var(--atlas-text)]")
              }
            >
              {stage.label}
              {stage.state === "ACTIVE" && progress.running && (
                <span className="pulse-dot ml-2 h-1.5 w-1.5 align-middle" aria-hidden />
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="m2.5 6.3 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
