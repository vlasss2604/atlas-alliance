"use client";

import type { ResearchJobDetail } from "../api";
import { composeAudit } from "../audit-composition";
import { chooseAnalyticalBlocks, inputFromResearchJobDetail } from "../output-plan";
import { jobOutcome, type JobState } from "../research-model";
import { AuditCompositionView } from "./result-blocks/audit-composition";

// VERIFICATION FOR ONE COMPLETED JOB — A PURE PROJECTION OF THE DETAIL
// PAYLOAD THE RESULT SCREEN ALREADY HOLDS.
//
// This is the bridge between the loaded `ResearchJobDetail` and the
// approved Verification composition, and the whole point of it is how
// little it does: the payload goes through `inputFromResearchJobDetail`,
// that goes through `chooseAnalyticalBlocks`, and the plan goes through
// `composeAudit`. No fetch, no second data path, no model, no research
// run — the same object that rendered the Research view is read again in a
// different emphasis. Switching a finished result between Research and
// Verification therefore costs nothing but a render.
//
// HISTORICAL SEMANTICS. Every component status here was reduced by the
// engine semantics in force when the job ran, and nothing on this surface
// re-derives it. The payload carries no version of those semantics, so the
// note is stated for every finished job rather than for an unknowable
// subset: a status is never made to look more current than it is.
export function JobVerification({ detail, historicalNote = true }: { detail: ResearchJobDetail; historicalNote?: boolean }) {
  const outcome = jobOutcome({ state: detail.job.state as JobState, verdict: detail.proof?.verdict ?? null });
  // A TERMINAL PRODUCT STATE OUTRANKS A PERSISTED VERDICT — the rule the
  // Research view already applies through `jobOutcome`. The verdict the
  // composition presents is the outcome's, so a run that did not finish as
  // a Proof cannot show one here either.
  const input = { ...inputFromResearchJobDetail(detail), verdict: outcome.verdict };
  const plan = chooseAnalyticalBlocks(input);
  const components = detail.components.map((c) => ({
    component: c.component,
    status: c.status,
    reasonCodes: c.reasonCodes,
    supportingEvidenceIds: c.supportingEvidenceIds,
    contradictingEvidenceIds: c.contradictingEvidenceIds,
    excludedEvidence: c.excludedEvidence,
    coverage: c.coverage,
  }));
  const audit = composeAudit({ input, components, outcomeKind: outcome.kind, projectName: detail.job.projectName, plan });

  return (
    <div className="flex flex-col gap-3 sm:gap-4" data-testid="job-verification">
      {historicalNote && (
        <p className="px-1 text-[0.68rem] leading-snug text-[var(--atlas-text-dim)]" data-testid="verification-historical-note">
          States below were reduced by the research semantics in force when this research ran and are not
          re-derived here. A check may read differently from what the same evidence would yield today.
        </p>
      )}
      <AuditCompositionView audit={audit} input={input} asOf={detail.job.finishedAt ?? detail.job.createdAt} />
    </div>
  );
}
