"use client";

import { useEffect, useState } from "react";

import { api, type ResearchJobDetail } from "../../api";
import { authenticate } from "../../api";
import { composeAudit } from "../../audit-composition";
import { chooseAnalyticalBlocks, inputFromResearchJobDetail } from "../../output-plan";
import {
  deriveQuestionFindings,
  deriveResultLadder,
  jobOutcome,
  researchAnswer,
  resultBriefing,
  type JobState,
} from "../../research-model";
import { AuditCompositionView } from "./audit-composition";
import { SelectedBlocks } from "./selected-blocks";

// THE DEV BRIDGE — A REAL COMPLETED RESEARCH THROUGH THE SELECTOR.
//
// The whole point of this component is how little it does. It reads a
// finished job through the SAME endpoint the result screen already uses,
// hands the payload to `inputFromResearchJobDetail`, hands that to
// `chooseAnalyticalBlocks`, and renders whatever came back through the
// existing blocks. There is no second data path, no server code, no new
// truth: ownership, admission and every persisted status arrive exactly as
// the production screen receives them, because it is the production
// response.
//
// THE ANSWER PROSE IS NOT WRITTEN HERE EITHER. `researchAnswer` and
// `resultBriefing` are the derivations the result screen already runs —
// each sentence a restatement of one persisted component status, no model
// call. This component picks no words of its own.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not fill a gap in the payload.
// The detail response carries no typed quantities and no documentary
// entities today, so METRIC, TABLE, CHART and ENTITY are declined — and
// that is the correct result, printed as such, rather than a number parsed
// out of a fragment to make the page look analytical.
export function RealJobPlan({ jobId, view = "result" }: { jobId: string; view?: "result" | "audit" }) {
  const [detail, setDetail] = useState<ResearchJobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await authenticate();
        const d = await api.getResearchJob(jobId);
        if (live) setDetail(d);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "failed to load");
      }
    })();
    return () => {
      live = false;
    };
  }, [jobId]);

  if (error) {
    return (
      <section className="panel px-4 py-3" data-testid="real-job-error">
        <p className="text-[0.78rem]">Could not load {jobId}: {error}</p>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="panel px-4 py-3" data-testid="real-job-loading">
        <p className="text-[0.78rem] text-[var(--atlas-text-dim)]">Loading {jobId}…</p>
      </section>
    );
  }

  const input = inputFromResearchJobDetail(detail);
  const plan = chooseAnalyticalBlocks(input);

  // The same rows the result screen derives, so the answer this page shows
  // is the answer that page shows.
  const outcome = jobOutcome({ state: detail.job.state as JobState, verdict: detail.proof?.verdict ?? null });
  const components = detail.components.map((c) => ({
    component: c.component,
    status: c.status,
    reasonCodes: c.reasonCodes,
    supportingEvidenceIds: c.supportingEvidenceIds,
    contradictingEvidenceIds: c.contradictingEvidenceIds,
    excludedEvidence: c.excludedEvidence,
    coverage: c.coverage,
  }));
  const rows =
    detail.questionFindings !== null
      ? deriveQuestionFindings(detail.questionFindings, components)
      : (() => {
          // The ladder is two deliberately separate groups; the briefing
          // wants one set of rows, in the order the screen shows them.
          const ladder = deriveResultLadder(components);
          return [...ladder.mechanism, ...ladder.value];
        })();
  const briefing = resultBriefing({
    verdict: outcome.verdict,
    outcomeKind: outcome.kind,
    projectName: detail.job.projectName,
    components,
    rows,
  });
  const paragraphs = researchAnswer({
    verdict: outcome.verdict,
    outcomeKind: outcome.kind,
    projectName: detail.job.projectName,
    components,
  });

  return (
    <div className="flex flex-col gap-4" data-testid="real-job-plan">
      <details className="panel px-4 py-3 sm:px-5" data-testid="plan-summary">
        <summary className="eyebrow cursor-pointer" style={{ color: "var(--atlas-text-dim)" }}>
          Selector decision · real job {detail.job.id} · show
        </summary>
        <p className="mt-1 text-[0.78rem]">
          <span className="text-[var(--atlas-text-dim)]">Selected: </span>
          {plan.orderedBlocks.map((b) => b.type).join(" → ")}
        </p>
        <ul className="mt-1 text-[0.72rem] text-[var(--atlas-text-dim)]">
          {plan.rejected.map((r) => (
            <li key={r.type} data-testid="rejected-block">
              Not shown: {r.type} — {r.reason.replace(/_/g, " ").toLowerCase()}
            </li>
          ))}
          {plan.rejected.length === 0 && <li>Nothing declined.</li>}
        </ul>
        <p className="mt-1.5 text-[0.7rem] text-[var(--atlas-text-dim)]">
          Payload carries {input.components.length} component results, {input.evidence.length} admitted
          evidence rows, {input.flows.length} mechanism flows, {input.quantities.length} typed quantities,{" "}
          {input.entities.length} entities.
        </p>
      </details>

      {view === "audit" ? (
        <AuditCompositionView
          audit={composeAudit({ input, components, outcomeKind: outcome.kind, plan })}
          input={input}
          asOf={detail.job.finishedAt ?? detail.job.createdAt}
        />
      ) : (
        <SelectedBlocks
          plan={plan}
          input={input}
          answer={{ short: briefing.shortAnswer.join(" "), paragraphs }}
          asOf={detail.job.finishedAt ?? detail.job.createdAt}
        />
      )}
    </div>
  );
}
