"use client";

import { useDict } from "../app-context";
import { stageText } from "../localize";
import { deriveProgress, type ProgressInput } from "../research-model";

// LIVE RESEARCH STATE.
//
// The stage shown is chosen by research-model's deriveProgress, which reads
// the engine's PERSISTED acquisition phase first and only falls back to the
// stage counter before acquisition begins. That is the whole reason this
// component cannot show "checking previous research" for a job that is
// already fetching or extracting.
//
// V7 (HANDOFF §4.2): a vertical rail — done stages carry a green-tinted
// check and a green connector; the active stage a cyan circle with a small
// spinning arc (only while the job runs), its label white and bold, and a
// "now" tag ("waiting for you" while awaiting a clarification); pending
// stages a grey number and a faint label. STAGES ONLY: the engine does not
// emit per-stage action lines or source events yet (D4), so none are drawn
// — a line is never invented. Under the rail, while live, one note says a
// found source is not evidence yet.
export function ResearchProgress({ job, memoryEnabled = false }: { job: ProgressInput; memoryEnabled?: boolean }) {
  const progress = deriveProgress(job, { memoryEnabled });
  const dict = useDict();
  const awaiting = job.state === "AWAITING_CLARIFICATION";

  return (
    <section className="process-panel rise" style={{ animationDelay: "80ms" }} data-testid="research-progress">
      <h2 className="process-title">{dict.progress.title}</h2>
      <ol className="process-rail" data-progress-source={progress.source}>
        {progress.stages.map((stage, i) => {
          const last = i === progress.stages.length - 1;
          const active = stage.state === "ACTIVE";
          return (
            <li key={stage.key} className="process-step" data-stage={stage.key} data-state={stage.state}>
              <span className="process-col" aria-hidden>
                <span className={`process-mark process-mark-${stage.state.toLowerCase()}`}>
                  {stage.state === "DONE" ? (
                    <CheckIcon />
                  ) : active && awaiting ? (
                    "?"
                  ) : (
                    <>
                      {active && progress.running && (
                        <svg className="process-spin" width="28" height="28" viewBox="0 0 28 28">
                          <circle cx="14" cy="14" r="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="20 62" />
                        </svg>
                      )}
                      {i + 1}
                    </>
                  )}
                </span>
                {!last && <span className={`process-line ${stage.state === "DONE" ? "process-line-done" : ""}`} />}
              </span>
              <span className="process-label-row">
                <span className={`process-label process-label-${stage.state.toLowerCase()}`}>{stageText(stage, dict)}</span>
                {active && (progress.running || awaiting) && (
                  <span className="process-tag" data-testid="stage-tag">
                    {awaiting ? dict.progress.tags.waiting : dict.progress.tags.now}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {progress.running && (
        <p className="process-note" data-testid="found-note">
          <InfoIcon />
          <span>{dict.progress.foundNote}</span>
        </p>
      )}
    </section>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="mt-0.5 flex-none">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
