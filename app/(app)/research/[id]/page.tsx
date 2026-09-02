"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { api, type ResearchJobDetail } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { DeveloperDetails } from "@/src/client/components/developer-details";
import { type EvidenceRole } from "@/src/client/components/evidence-document-card";
import { ResearchProgress } from "@/src/client/components/research-progress";
import { ResultLadder } from "@/src/client/components/result-ladder";
import { OutcomeBadge } from "@/src/client/components/verdict-badge";
import {
  CONFIDENCE_LABELS,
  deriveQuestionFindings,
  deriveResultLadder,
  findingExplanation,
  groupEvidenceByDocument,
  isTerminal,
  jobOutcome,
  researchAnswer,
  relativeAge,
  type EvidenceItemLike,
} from "@/src/client/research-model";
import { useJobEvents, type JobEvent } from "@/src/client/use-job-events";

// THE RESEARCH SCREEN — one page for a running job and a finished result.
//
// THREE LEVELS, AND NOTHING BETWEEN THEM.
//
//   LEVEL 1, always visible: the question, the answer, what is still
//   unresolved, and a compact list of findings with a state each.
//
//   LEVEL 2, per finding: one connected explanation of why it stands where
//   it does.
//
//   LEVEL 3, per finding: the sources behind that finding, verbatim.
//
// What this replaces is not a styling problem. The previous screen laid out
// nine sections of roughly equal weight — a reality ladder, a gaps panel, an
// evidence grid across eight role buckets, a component grid, a progress log
// and a raw payload — and left the reader to assemble a conclusion from
// them. Every part was individually honest. The assembly was the defect, and
// doing that assembly is most of what this product is for.
//
// ONE COMPOSITION AT THE TOP, NOT A BANNER AND A CARD.
//
// The project identity, the question, the status, the answer, what remains
// unresolved and the evidence footnote are ONE object. They used to be a
// large project name with the question as a grey subtitle, followed by a
// separate panel where the answer began — which read as a page header next
// to an unrelated result window, and buried the one thing a reader most
// needs on returning to a finished research: the question they asked.
export default function ResearchDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = typeof params?.id === "string" ? params.id : null;
  const { refresh } = useApp();
  const [detail, setDetail] = useState<ResearchJobDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Re-read the whole detail. Used when the job reaches a terminal state,
  // because the Proof only exists once the job has finished.
  const load = useCallback(() => {
    if (!jobId) return;
    api
      .getResearchJob(jobId)
      .then((d) => {
        setDetail(d);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    api
      .getResearchJob(jobId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Mark read once, so the nav badge reflects reality.
  useEffect(() => {
    if (!jobId) return;
    void api
      .markRead(jobId)
      .then(() => refresh())
      .catch(() => {});
  }, [jobId, refresh]);

  const live = detail !== null && !isTerminal(detail.job.state);

  // LIVE STATE COMES FROM THE SERVER, ALWAYS.
  //
  // Each event is a fresh read of the job row, so `acquisitionPhase` here is
  // the engine's own persisted phase and not a client guess.
  const onEvent = useCallback(
    (e: JobEvent) => {
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              job: {
                ...prev.job,
                state: e.state,
                progressStage: e.progressStage,
                memoryStatus: e.memoryStatus,
                acquisitionPhase: e.acquisitionPhase,
                finishedAt: e.finishedAt,
              },
            }
          : prev,
      );
      if (isTerminal(e.state)) {
        load();
        void refresh();
      }
    },
    [load, refresh],
  );

  useJobEvents(live ? jobId : null, onEvent);

  if (status === "loading") {
    return (
      <main className="enter flex flex-col gap-6">
        <AtlasHeader compact back={{ href: "/research", label: "Back" }} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">Loading…</div>
      </main>
    );
  }

  if (status === "error" || !detail) {
    return (
      <main className="enter flex flex-col gap-6">
        <AtlasHeader compact back={{ href: "/research", label: "Back" }} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
          This research could not be loaded.
        </div>
      </main>
    );
  }

  const { job, proof, components } = detail;
  const projectName = job.projectName ?? job.projectTicker ?? "Unresolved project";
  const finished = isTerminal(job.state);
  const outcome = jobOutcome({ state: job.state, verdict: proof?.verdict ?? null });
  const answer = researchAnswer({
    verdict: proof?.verdict ?? null,
    outcomeKind: outcome.kind,
    projectName: job.projectName,
    components,
  });

  // Evidence roles come from PERSISTED relationships only — S8's citation
  // binding first, then S5's component sets. An excluded row is labelled
  // EXCLUDED at the source and can never reach the supporting list.
  const citedIds = new Set((proof?.citations ?? []).map((c) => c.evidenceId));
  const used: { data: EvidenceItemLike; role: EvidenceRole }[] = (proof?.citations ?? []).map(
    (c) => ({
      data: {
        id: c.evidenceId,
        component: c.component,
        summary: c.summary,
        fragment: c.fragment,
        doesNotProve: c.doesNotProve,
        sourceClass: c.sourceClass,
        officiality: c.officiality,
        retrievedUrl: c.retrievedUrl,
        fetchedAt: c.fetchedAt,
        sourceTitle: c.source.title,
      },
      role: "USED",
    }),
  );
  const supporting = detail.finding.supporting
    .filter((e) => !citedIds.has(e.id))
    .map((e) => ({ data: toItem(e), role: "SUPPORTING" as const }));
  const contradicting = detail.finding.contradicting.map((e) => ({
    data: toItem(e),
    role: "CONTRADICTING" as const,
  }));
  const admitted = [...used, ...supporting, ...contradicting];

  // OTHER MATERIAL THIS RESEARCH READ is no longer listed on the result.
  // It was never part of the answer, and the audit now accounts for it
  // properly — as a register of what was checked and not used, with the
  // reason each was refused.
  // The job-wide "read but not shown here" grouping went with this
  // page's old audit block. The audit now derives that same set itself,
  // from the same canonical rows, and presents it as a ledger with
  // reasons rather than a fourth document list.

  // ONE ACQUIRED DOCUMENT, ONE CARD — per role, so an excluded document can
  // never be folded together with an admitted one.
  const byRole = (rows: { data: EvidenceItemLike; role: EvidenceRole }[], role: EvidenceRole) =>
    groupEvidenceByDocument(rows.filter((r) => r.role === role).map((r) => r.data));
  const admittedDocs = (["USED", "SUPPORTING", "CONTRADICTING"] as const).map((role) => ({
    role: role as EvidenceRole,
    groups: byRole(admitted, role),
  }));
  // The excluded and merely-read groupings that used to feed this page's
  // own audit block are gone with it. That accounting now lives in the
  // audit's Source Register, where "checked but not used" is a ledger with
  // reasons rather than a second document list under the result.

  // WHICH KINDS OF SOURCE ACTUALLY BACK EACH ROW.
  //
  // Read from persisted evidence links, so "what this does not establish"
  // at Level 2 is a statement about the sources this run really admitted for
  // that step — never a sentence written for the occasion.
  const sourceClassesByComponent: Record<string, string[]> = {};
  for (const e of detail.evidence) {
    if (!e.sourceClass) continue;
    for (const link of e.links) {
      if (link.role === "EXCLUDED") continue;
      const list = (sourceClassesByComponent[link.component] ??= []);
      if (!list.includes(e.sourceClass)) list.push(e.sourceClass);
    }
  }

  // PROOF, RESOLVED TO THE CONCLUSION IT SUPPORTS.
  //
  // Built from PERSISTED component links and nothing else — a row reaches
  // a finding because S5 linked it to that component, never because the
  // text looked relevant. An EXCLUDED link is skipped here: a source the
  // engine read and refused must never appear as proof of anything, and
  // it remains visible in the full audit where it belongs.
  //
  // This is what lets the normal result carry no document list at all. A
  // reader never meets a source without the conclusion it is there for,
  // so "why am I looking at this?" cannot arise.
  const evidenceByComponent: Record<string, EvidenceItemLike[]> = {};
  // WHAT EACH FINDING ACTUALLY FOUND, IN THE ENGINE'S OWN WORDS.
  //
  // SUPPORTING links only, so a contradicting or refused row can never
  // become a finding's answer. The order is S5's own: this picks the
  // engine's first supporting statement rather than applying a judgment
  // of ours about which reads best.
  const supportingSummariesByComponent: Record<string, string[]> = {};
  const admittedById = new Map(admitted.map((e) => [e.data.id, e.data]));
  // WHICH SOURCES ATLAS STILL HOLDS A COPY OF. Resolved server-side from
  // the acquisition rows this job actually owns, so the card can offer the
  // snapshot action only where opening it would show something.
  const snapshotIds = new Set(detail.snapshotEvidenceIds);

  for (const e of detail.evidence) {
    for (const link of e.links) {
      if (link.role === "EXCLUDED") continue;
      const list = (evidenceByComponent[link.component] ??= []);
      if (list.some((x) => x.id === e.id)) continue;
      // Prefer the claim-scoped copy where one exists: it carries S8's
      // citation binding rather than the job-wide projection of the row.
      const item = admittedById.get(e.id) ?? toItem(e);
      list.push({ ...item, hasSnapshot: snapshotIds.has(e.id) });
      if (link.role === "SUPPORTING" && e.summary) {
        (supportingSummariesByComponent[link.component] ??= []).push(e.summary);
      }
    }
  }

  // A QUIET INDICATOR THAT WORK HAPPENED, AND A DELIBERATE UNDERCOUNT.
  //
  // This counts distinct documents that produced at least one evidence row.
  // A document that was fetched and yielded nothing extractable has no row
  // and is not counted here — so the number can only ever be lower than the
  // work actually done, never higher. Under-claiming is the safe direction:
  // this is a footnote about effort, not a measure of authority, and source
  // COUNT is never evidence of anything.

  const usedDocs = admittedDocs.reduce((n, d) => n + d.groups.length, 0);

  const ladder = deriveResultLadder(components, sourceClassesByComponent);
  // WHERE THE EVIDENCE STOPS, ON THE QUESTION'S OWN TERMS.
  //
  // With a projection, the boundary is the first thing the QUESTION asked
  // about that the evidence did not establish — which is what a reader is
  // actually looking for. Without one it falls back to the Pattern
  // ladder's own conservative boundary, which is only drawn where an
  // established run exists to end.
  const questionRows = detail.questionFindings
    ? deriveQuestionFindings(detail.questionFindings, components, sourceClassesByComponent)
    : [];
  // A row established by NOTHING is a harder stop than one established in
  // part, so it is preferred even when the projection ordered a partial
  // row first. "Partly established" is progress; "not established" is the
  // edge of what the evidence reaches, which is what a reader is asking
  // about when they ask where it stops.
  const boundary =
    questionRows.length > 0
      ? (questionRows.find((r) => r.state === "UNRESOLVED") ??
        questionRows.find((r) => r.state === "PARTIAL") ??
        null)
      : ladder.boundary;

  return (
    <main className="enter flex flex-col gap-5 pb-6">
      <AtlasHeader compact back={{ href: "/research", label: "Back" }} />

      {/* ---- 0. WHILE THE RUN IS LIVE, the subject and the question are
           the header — there is no result yet for them to belong to.
           Once it finishes they move INSIDE the result panel below, so the
           finished screen is one composition rather than a banner sitting
           next to an unrelated card. ---------------------------------- */}
      {!finished && (
      <section className="flex items-start gap-4 px-1 pt-1">
        <span
          className="orb h-14 w-14 shrink-0 text-[0.95rem] font-semibold text-[var(--atlas-cyan)] sm:h-16 sm:w-16"
          aria-hidden
        >
          {projectName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow eyebrow-violet">Researching</p>
          <p className="mt-1 text-[1.05rem] font-semibold leading-tight tracking-tight">
            {projectName}
          </p>
          <p className="mt-1.5 text-[0.9rem] leading-snug text-[var(--atlas-text-dim)]">
            {job.originalQuestion}
          </p>
        </div>
      </section>
      )}

      {/* ---- live: progress leads ----------------------------------- */}
      {!finished && (
        <>
          <section className="panel panel-raised panel-hero p-5 sm:p-6" data-testid="live-banner">
            <div className="flex items-center gap-3">
              <span className="pulse-dot" aria-hidden />
              <p className="text-[0.95rem] font-medium">Research in progress</p>
            </div>
            <p className="mt-2 text-[0.85rem] text-[var(--atlas-text-dim)]">
              You can leave this screen. ATLAS keeps working and the result will be
              here when you come back.
            </p>
          </section>
          <div data-testid="progress-slot-live">
            <ResearchProgress job={job} />
          </div>
        </>
      )}

      {/* ---- 1. THE ANSWER ------------------------------------------ */}
      {finished && (
        <section
          className="panel panel-raised tone-edge p-5 sm:p-7"
          style={{ "--edge": edgeColor(outcome.tone) } as React.CSSProperties}
          data-testid="answer-panel"
        >
          {/* THE SUBJECT, INSIDE THE RESULT IT BELONGS TO. */}
          <div className="flex items-center gap-3">
            <span
              className="orb h-10 w-10 shrink-0 text-[0.8rem] font-semibold text-[var(--atlas-cyan)]"
              aria-hidden
            >
              {projectName.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="eyebrow eyebrow-violet">Research result</p>
              <p className="mt-0.5 text-[1rem] font-semibold leading-tight tracking-tight">
                {projectName}
              </p>
            </div>
          </div>

          {/* THE QUESTION IS THE HEADING OF THIS RESULT.
              It used to be a grey subtitle under a 2.15rem project name,
              in a header that sat OUTSIDE this panel — so the screen read
              as an identity banner followed by an unrelated result window,
              and the one thing a reader most needs on returning to a
              finished research ("what did I actually ask?") was the
              smallest text in the composition.
              The project names the subject; the question names the task,
              and this is a question-driven product. */}
          <p className="eyebrow mt-5" style={{ color: "var(--atlas-text-dim)" }}>
            Your question
          </p>
          <h1
            className="mt-2 text-[1.16rem] font-semibold leading-snug tracking-tight sm:text-[1.3rem]"
            data-testid="result-question"
          >
            {job.originalQuestion}
          </h1>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--hairline)] pt-4">
            <OutcomeBadge job={{ state: job.state, verdict: proof?.verdict ?? null }} />
            {proof?.confidence.band && (
              <span className="tone tone-neutral" data-testid="confidence-band">
                {CONFIDENCE_LABELS[proof.confidence.band] ?? proof.confidence.band} confidence
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5 text-[0.72rem] text-[var(--atlas-text-dim)]">
              <ClockIcon />
              {relativeAge(job.finishedAt)}
            </span>
          </div>

          <div
            className="mt-4 flex flex-col gap-2.5 text-[1.02rem] leading-relaxed"
            data-testid="answer-text"
          >
            {answer.map((s) => (
              <p key={s}>{s}</p>
            ))}
          </div>

          {/* WHAT REMAINS UNRESOLVED, AND WHY.
              This said "The evidence stops at: …", which describes ATLAS's
              own workflow rather than the reader's knowledge. Nobody asked
              where our evidence collection ended; they asked what is still
              unknown. So the block now names the unresolved thing and the
              reason it is unresolved, and nothing about the process.
              The heading also separates the two cases the rest of the
              product works hard to keep apart: evidence that was checked
              and did not establish something, versus a research run that
              was blocked from checking at all. */}
          {boundary && (
            // A quiet callout, not a divider-and-text block. A flat
            // border-top read as one more paragraph of the answer; a soft
            // amber wash — restrained enough that it is not the red/alarm
            // tone this product reserves for a positive contradiction —
            // gives the one thing most worth a reader's attention its own
            // visual weight without dramatising it.
            <div
              className="mt-5 rounded-xl border border-[rgba(251,191,36,0.16)] bg-[rgba(251,191,36,0.04)] p-4"
              data-testid="answer-boundary"
            >
              <p className="eyebrow" style={{ color: "#fcd34d" }}>
                {boundary.coverage === "BLOCKED" ? "Research limitation" : "Still unresolved"}
              </p>
              <p className="mt-1.5 text-[0.9rem] font-medium leading-snug text-[var(--atlas-text)]">
                {boundary.label}
              </p>
              <p className="mt-1.5 text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]">
                {findingExplanation(boundary).join(" ")}
              </p>
            </div>
          )}

          {/* WHAT THE ANSWER RESTS ON — ONE NUMBER, AND ONLY THIS ONE.
              This used to read "4 sources read · 2 not used as evidence".
              How many were read and discarded is audit accounting: it
              tells a reader nothing about the answer, and inviting them
              to weigh 4 against 2 is exactly the source-arithmetic this
              product refuses. The full tally stays in the audit.
              What remains is metadata, not a score. A higher count is
              never a stronger result — one official document can settle
              what twenty repetitions of it cannot — so this is styled as
              a quiet footnote and never as a measure. */}
          {usedDocs > 0 && (
            <p
              className="mt-5 border-t border-[var(--hairline)] pt-3.5 text-[0.75rem] text-[var(--atlas-text-dim)]"
              data-testid="answer-metadata"
            >
              {/* One vocabulary for one idea. This read "N sources used as
                  evidence" while the control below said "Show proof" and
                  the card said "Supports:" — three names for the same
                  chain. The context already makes "used as evidence"
                  obvious; the count alone is enough, and staying terse
                  keeps it a footnote rather than a score. */}
              Sources · {usedDocs}
            </p>
          )}
        </section>
      )}

      {/* ---- 2. THE CLAIMS, AND LEVEL 2 INSIDE THEM ------------------ */}
      {finished && (
        <ResultLadder
          components={components}
          jobId={jobId}
          sourceClassesByComponent={sourceClassesByComponent}
          evidenceByComponent={evidenceByComponent}
          supportingSummariesByComponent={supportingSummariesByComponent}
          questionFindings={detail.questionFindings}
        />
      )}

      {/* ---- FULL RESEARCH AUDIT ------------------------------------- *
       * Everything the research did, rather than everything the question
       * needed. When a projection resolved, this is the ONLY place the
       * Pattern's own ten components appear — a reader who asked where
       * fees go should not have to meet SOURCE_OF_VALUE or DURABILITY_BASIS
       * to understand the answer, but an expert who wants to check the
       * work must still be able to see every one of them.
       *
       * It is not a second answer, and it is not renamed developer data:
       * the rows here are the same canonical component results, derived by
       * the same function, under the Pattern's own grouping.
       */}
      {finished && (
        // `group` + `group-open:` is native <details> state driving a CSS
        // rotation — no JS state added, the disclosure itself is untouched.
        // The custom chevron replaces the browser's default triangle
        // marker so this entry point matches the chevrons used everywhere
        // else in the product instead of looking like a leftover form
        // control.
        // THE AUDIT IS A DIFFERENT SURFACE, ON ITS OWN SCREEN.
        //
        // This used to re-render the SAME ResultLadder the reader had just
        // finished, with a document list under it — which gave a
        // professional nothing they did not already have. It is now a
        // link to a dedicated audit view that projects the same canonical
        // truth differently: coverage, evidence relationships, source
        // accounting including what was NOT used, conflicts, limitations
        // and a technical trace.
        //
        // NOTHING IS PREPARED BY RENDERING THIS PAGE. No audit request of
        // any kind is made here; following the link is the explicit
        // request, and the server generates at most one projection per job.
        <div className="flex flex-col gap-4" data-testid="progress-slot-finished">
          <Link
            href={`/research/${jobId}/audit`}
            className="panel flex w-full items-center gap-2.5 px-5 py-4 text-[0.8rem] text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-text)]/85"
            data-testid="audit-entry"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
              <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Full research audit
          </Link>
          <ResearchProgress job={job} />
        </div>
      )}

      {/* ---- engine internals, behind an explicit opt-in ------------- */}
      <DeveloperDetails detail={detail} />
    </main>
  );
}

// Same glyph recent-proof-card.tsx already uses next to a timestamp — one
// icon for "this is an age", reused rather than re-invented here.
function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6 3.4V6l1.8 1.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}


function edgeColor(tone: string): string {
  switch (tone) {
    case "supported":
      return "rgba(45, 212, 191, 0.75)";
    case "partial":
      return "rgba(167, 139, 250, 0.75)";
    case "negative":
      return "rgba(248, 113, 113, 0.75)";
    case "insufficient":
      return "rgba(251, 191, 36, 0.7)";
    case "fault":
      return "rgba(148, 163, 184, 0.55)";
    default:
      return "rgba(148, 163, 184, 0.35)";
  }
}

function toItem(e: {
  id: string;
  component: string | null;
  summary: string | null;
  fragment: string;
  doesNotProve: string | null;
  sourceClass: string | null;
  officiality: string | null;
  retrievedUrl: string;
  fetchedAt: string;
  sourceTitle: string | null;
}): EvidenceItemLike {
  return {
    id: e.id,
    component: e.component,
    summary: e.summary,
    fragment: e.fragment,
    doesNotProve: e.doesNotProve,
    sourceClass: e.sourceClass,
    officiality: e.officiality,
    retrievedUrl: e.retrievedUrl,
    fetchedAt: e.fetchedAt,
    sourceTitle: e.sourceTitle,
  };
}
