"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { BetaStatusNotice } from "@/src/client/components/beta-status-notice";
import { ExploreProofs } from "@/src/client/components/explore-proofs";
import { PulseIcon } from "@/src/client/components/icons";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchComposer } from "@/src/client/components/research-composer";
import { betaBlockOf } from "@/src/client/beta-status";
import { pulseItemById, type PulseItem } from "@/src/client/pulse-fixtures";
import { pulseIdFromSearch } from "@/src/client/pulse-launch";
import { groupResearchRuns } from "@/src/client/research-model";
import { showcaseBySlug, showcaseProofs, showcaseSlugFromSearch } from "@/src/client/showcase-proofs";

// HOME — THE VERIFY SCREEN (D-172 names it Verify; the route stays /home).
//
// V7 (docs/design/v7, HANDOFF §4.1, §4.1a), top to bottom: the title, the
// one input box and the example chips; "Explore ATLAS Proofs" — the
// published read-only Proofs (a verdict only where an approved published
// Proof exists); and the projects this user has already researched, as a
// horizontal strip of cards. No marketing, no statistics. Every card is a
// real record from the server; no verdict is invented for a job that has
// none.
//
// OPENED FROM A PULSE CARD (`?pulse=<id>`): the card's text lands in the
// same editable input, verbatim, with a pill above the title saying where
// it came from. Nothing starts and nothing is spent by opening it; the
// start flow after that is the composer's own, unchanged.
type PulseLaunch = { kind: "none" } | { kind: "open"; item: PulseItem } | { kind: "unavailable" };

export default function HomePage() {
  const { dict, me, inviteNotice } = useApp();
  // D-171: when the beta cannot take a new Research for this user, Home
  // stops promoting one and points to the Research Library instead.
  const block = betaBlockOf(me);
  const [jobs, setJobs] = useState<ResearchJobListItem[] | null>(null);
  const [pulse, setPulse] = useState<PulseLaunch>({ kind: "none" });
  // "Run your own verification" from a published Proof (`?proof=<slug>`):
  // that Proof's question lands in the composer, editable. Nothing starts.
  const [proofSlug, setProofSlug] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getResearchJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]));
  }, []);

  useEffect(() => {
    const id = pulseIdFromSearch(window.location.search);
    if (!id) return;
    // Resolved after mount: the id is read from the URL in the browser, so
    // the server-rendered markup and the first client render agree.
    const t = window.setTimeout(() => {
      const item = pulseItemById(id);
      setPulse(item ? { kind: "open", item } : { kind: "unavailable" });
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const slug = showcaseSlugFromSearch(window.location.search);
    if (!slug) return;
    const t = window.setTimeout(() => setProofSlug(slug), 0);
    return () => window.clearTimeout(t);
  }, []);
  const lang = me?.language === "RU" ? "RU" : "EN";
  const proofQuestion = proofSlug ? (showcaseBySlug(proofSlug)?.question[lang] ?? null) : null;

  const recent = groupResearchRuns(jobs ?? [])
    .flatMap((group) => group.questions.map((q) => q.latest))
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
    .slice(0, 6);

  const pulseNotice =
    pulse.kind === "none" ? null : (
      <p className="from-pulse rise" data-testid="pulse-notice" data-kind={pulse.kind}>
        <PulseIcon size={16} strokeWidth={2} className="from-pulse-icon" />
        <span>
          {pulse.kind === "open" ? (
            <>
              <span className="font-bold text-[var(--atlas-cyan-strong)]">{dict.pulse.fromPulse(pulse.item.source.handle)}</span>
              {" · "}
              {dict.pulse.fromPulseEditable}
            </>
          ) : (
            dict.pulse.unavailable
          )}
        </span>
      </p>
    );

  return (
    <main className="relative flex flex-col gap-8 pt-2">
      {/* A static, faint 8-segment ring behind the top-right corner. */}
      <VerifyRing />

      {block ? (
        <BetaStatusNotice />
      ) : (
        <section className="relative pt-3" data-testid="home-composer">
          {/* A remount per Pulse item puts its text into the composer's own
              state; the composer itself is unchanged. */}
          {proofQuestion && pulse.kind === "none" ? (
            <ResearchComposer key={`proof-${proofSlug}-${lang}`} initialQuestion={proofQuestion} />
          ) : (
            <ResearchComposer
              key={pulse.kind === "open" ? pulse.item.id : "plain"}
              initialQuestion={pulse.kind === "open" ? pulse.item.text : ""}
              notice={pulseNotice}
            />
          )}
        </section>
      )}

      {/* PRIVATE BETA ALLOWANCE (D-170) — the server's own count, shown only
          while private beta is what admits this user and a start is
          possible (D-171: never "N remaining" when the beta is full). */}
      {me?.privateBeta && !block && (
        <p className="-mt-4 px-1 text-center text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="beta-allowance">
          <span className="font-medium text-[var(--atlas-cyan-strong)]">{dict.home.betaLabel}</span>
          {" · "}
          {dict.home.betaRemaining(me.privateBeta.remaining)}
        </p>
      )}
      {!me?.privateBeta && !me?.betaPaused && inviteNotice && (
        <p className="-mt-4 px-1 text-center text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="beta-invite-notice" data-notice={inviteNotice}>
          {inviteNotice === "FULL" ? dict.home.betaAccessFull : dict.home.betaInviteUnavailable}
        </p>
      )}

      <ExploreProofs items={showcaseProofs()} />

      <section className="flex flex-col gap-3" data-testid="recent-research">
        <div className="flex h-11 items-center justify-between">
          <h2 className="section-title">{dict.home.previouslyResearched}</h2>
          <Link href="/research" className="flex h-11 items-center text-[13px] font-semibold text-[var(--atlas-cyan)] hover:text-[var(--atlas-cyan-strong)]">
            {dict.home.viewAll}
          </Link>
        </div>
        {jobs === null ? (
          <ul className="snap-strip" aria-busy data-testid="recent-loading">
            {[0, 1].map((i) => (
              <li key={i} className="recent-card recent-card-skeleton">
                <span className="skeleton h-[38px] w-[38px] rounded-[28%]" />
                <span className="skeleton block h-4 w-40" />
                <span className="skeleton block h-4 w-28" />
              </li>
            ))}
          </ul>
        ) : recent.length === 0 ? (
          <p className="px-1 text-[0.98rem] text-[var(--atlas-text-dim)]" data-testid="recent-empty">
            {dict.home.recentEmpty}
          </p>
        ) : (
          <ul className="snap-strip">
            {recent.map((job, i) => (
              <RecentProofCard key={job.id} job={job} memoryEnabled={me?.memoryEnabled ?? false} variant="card" index={i} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

// Eight equal arcs at very low opacity — decoration only, never animated.
function VerifyRing() {
  const segments = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="verify-ring" aria-hidden>
      <svg width="260" height="260" viewBox="0 0 120 120">
        <g transform="rotate(-90 60 60)" fill="none" strokeWidth="6">
          {segments.map((i) => (
            <circle key={i} cx="60" cy="60" r="50" stroke="rgba(30, 197, 245, 0.12)" strokeDasharray="34.27 279.89" strokeDashoffset={-2.5 - i * 39.27} />
          ))}
        </g>
        <circle cx="60" cy="60" r="38" fill="none" stroke="rgba(30, 197, 245, 0.1)" strokeWidth="0.6" strokeDasharray="1.5 3" />
      </svg>
    </div>
  );
}
