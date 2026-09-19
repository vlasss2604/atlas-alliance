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
import { JobVerification } from "@/src/client/components/job-verification";
import { KeyEvidence, NotEstablished, ProofMap } from "@/src/client/components/result-first-screen";
import { ResultLadder } from "@/src/client/components/result-ladder";
import { OutcomeBadge } from "@/src/client/components/verdict-badge";
import {
  CONFIDENCE_LABELS,
  deriveQuestionFindings,
  deriveResultLadder,
  groupEvidenceByDocument,
  isTerminal,
  jobOutcome,
  keyEvidenceFrom,
  relativeAge,
  resultBriefing,
  splitMainLimitation,
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
//
// TWO VIEWS OF ONE FINISHED RESULT: RESEARCH | VERIFICATION.
//
// ONE RESEARCH OBJECT. A finished result used to offer two competing
// readings of the same payload — "Research" and "Verification" — behind a
// switch in the result header. A reader met two modes for one answer and
// had to decide which to trust. There is one composition now: the answer,
// the proof map, the key evidence and the boundary on the first screen,
// and everything deeper (every ladder row, the verification composition,
// the audit) behind one disclosure beneath them. A link that still says
// `?view=verification` (or `?view=full`) opens that disclosure; nothing is
// fetched or recomputed for it and the switch itself is gone.
function deepOpenFromLocation(): boolean {
  if (typeof window === "undefined") return false;
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "verification" || view === "full";
}

export default function ResearchDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = typeof params?.id === "string" ? params.id : null;
  const { refresh } = useApp();
  const [detail, setDetail] = useState<ResearchJobDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // Initialised from the URL on the client; the server render has no
  // location and defaults to closed. Nothing rendered before the payload
  // loads depends on it, so the two cannot disagree on screen.
  const [deepOpen] = useState<boolean>(deepOpenFromLocation);

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
  // VERIFICATION NEEDS A RESEARCH RESULT TO VERIFY. A failed or cancelled
  // run is a product fault, not a finding, and the answer already says so;
  // composing a verification of it would present an empty gap list as
  // "every check was established". The composition is simply absent there.
  const verifiable = finished && outcome.kind !== "FAILED" && outcome.kind !== "CANCELLED";
  // The briefing is derived further down, once the finding rows it reads
  // exist — it must summarise exactly the rows this page renders below it,
  // never a separately-derived set that could disagree with them.

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
  // THE QUESTION'S OWN FINDINGS, WHERE A PROJECTION RESOLVED.
  //
  // These are the rows a reader asked about, in the question's terms
  // rather than the Pattern's. The briefing summarises them and the ladder
  // renders them, so both surfaces answer the same question.
  //
  // The single "boundary" row that used to be picked out here — the first
  // thing the question asked about that the evidence did not establish —
  // is gone with the callout it fed. The short answer's own "Main
  // limitation" sentence names it, and "Still open" lists it with the
  // others, so choosing one row for a third treatment only repeated them.
  const questionRows = detail.questionFindings
    ? deriveQuestionFindings(detail.questionFindings, components, sourceClassesByComponent)
    : [];

  // THE BRIEFING — QUICK UNDERSTANDING, ABOVE THE PROOF AND NEVER INSTEAD
  // OF IT.
  //
  // It reads the SAME rows the ladder below renders: the question
  // projection where one resolved, the Pattern ladder otherwise. Deriving
  // it from anything else would let the summary at the top of the page
  // disagree with the detail underneath it, which is the one failure this
  // layer must not have.
  //
  // Nothing is recomputed and nothing is re-decided: statuses, reason copy
  // and coverage are all canonical and arrive here already resolved.
  const briefingRows =
    questionRows.length > 0 ? questionRows : [...ladder.mechanism, ...ladder.value];
  const briefing = resultBriefing({
    verdict: proof?.verdict ?? null,
    outcomeKind: outcome.kind,
    projectName: job.projectName,
    components,
    rows: briefingRows,
  });
  // The answer stays at the findings; its "Main limitation" sentence leads
  // the "Not established" block below instead, so the boundary is stated
  // once. Nothing is dropped — see `splitMainLimitation`.
  const { answer, limitation } = splitMainLimitation(briefing.shortAnswer);

  // THE FEW ROWS A READER NEEDS FIRST — S5's contradicting rows, S8's
  // citations, then supporting rows in proof-map order; one per document;
  // capped. Built only from links the engine recorded as SUPPORTING or
  // CONTRADICTING (evidenceByComponent skips EXCLUDED), so a refused
  // source can never lead the screen.
  const keyEvidence = keyEvidenceFrom({
    jobId,
    cited: used.map((u) => ({ ...u.data, hasSnapshot: snapshotIds.has(u.data.id) })),
    contradicting: contradicting.map((c) => ({ ...c.data, hasSnapshot: snapshotIds.has(c.data.id) })),
    supportingByComponent: evidenceByComponent,
    rowComponents: briefing.keyFindings.map((f) => f.component),
  });

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
            <div className="min-w-0 flex-1">
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

          {/* THE UNRESOLVED CALLOUT THAT USED TO SIT HERE IS GONE.
              It named the single most important open check and explained
              it — which the short answer's own "Main limitation" sentence
              now does, two paragraphs above, in the same words drawn from
              the same persisted reason code. On a live Raydium result the
              two rendered back to back and said the same thing twice, and
              the "Still open" section below said it a third time.
              Nothing is lost: the limitation is still stated in the
              answer, every open check is listed below, and each one is
              read in full in the ladder. */}

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

      {/* ---- 2. PROOF MAP — the chain the question turns on. The rows are
           the briefing's own (the question projection where one resolved,
           the Pattern ladder otherwise), so this, the answer above and the
           ladder below read the identical persisted states. ------------ */}
      {finished && <ProofMap rows={briefing.keyFindings} />}

      {/* ---- 3. KEY EVIDENCE — the few rows that carry the conclusion,
           each with its claim, source, date and a way to read it in full.
           Selection is `keyEvidenceFrom`'s; nothing is chosen here. ---- */}
      {finished && <KeyEvidence items={keyEvidence} />}

      {/* ---- 4. NOT ESTABLISHED — the boundary, stated once: the answer's
           limitation sentence, then the open checks with their persisted
           reasons. Never "this does not happen". ----------------------- */}
      {finished && (
        <NotEstablished limitation={limitation} items={briefing.unresolved} more={briefing.unresolvedMore} />
      )}

      {/* ---- 5. FULL EVIDENCE AND AUDIT — everything deeper, behind one
           disclosure. The ladder with every row and excerpt, the
           verification composition over the same payload (absent for a
           failed or cancelled run, which has nothing to verify), the
           audit entry and the research process. Nothing below is fetched
           or recomputed: it is the same object, read further down.
           A `?view=verification` or `?view=full` link opens it. ------- */}
      {finished && (
        <details
          className="panel group px-4 py-3.5 sm:px-6 sm:py-4"
          open={deepOpen}
          data-testid="full-evidence"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[0.8rem] font-medium text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-text)]/85 [&::-webkit-details-marker]:hidden">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 transition-transform group-open:rotate-90">
              <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Full evidence and audit
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <ResultLadder
              components={components}
              jobId={jobId}
              sourceClassesByComponent={sourceClassesByComponent}
              evidenceByComponent={evidenceByComponent}
              supportingSummariesByComponent={supportingSummariesByComponent}
              questionFindings={detail.questionFindings}
            />
            {verifiable && (
              <div data-testid="verification-view">
                <JobVerification detail={detail} />
              </div>
            )}
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
          </div>
        </details>
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
