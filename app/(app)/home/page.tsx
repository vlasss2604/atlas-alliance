"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type ResearchJobListItem } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { BetaStatusNotice } from "@/src/client/components/beta-status-notice";
import { RecentProofCard } from "@/src/client/components/recent-proof-card";
import { ResearchComposer } from "@/src/client/components/research-composer";
import { betaBlockOf } from "@/src/client/beta-status";
import { pulseItemById, type PulseItem } from "@/src/client/pulse-fixtures";
import { pulseIdFromSearch } from "@/src/client/pulse-launch";
import { groupResearchRuns } from "@/src/client/research-model";

// HOME — THE VERIFY SCREEN (D-172 names it Verify; the route stays /home).
//
// Top to bottom: the composer as one raised surface, led by the search
// emblem (the brand is the compact lockup in the app header, the same on
// every screen — the large centred brand this screen used to carry is
// gone, per the approved design); the projects ATLAS has already
// researched, one card each with an avatar, the outcome, the question and
// when it was checked. No marketing cards, no statistics. Every row is a
// real record from the server; no verdict is invented for a job that has
// none.
//
// OPENED FROM A PULSE CARD (`?pulse=<id>`): the card's text lands in the
// same editable input, verbatim, with a line saying where it came from.
// Nothing starts and nothing is spent by opening it; the start flow after
// that is the composer's own, unchanged.
type PulseLaunch = { kind: "none" } | { kind: "open"; item: PulseItem } | { kind: "unavailable" };

export default function HomePage() {
  const { dict, me, inviteNotice } = useApp();
  // D-171: when the beta cannot take a new Research for this user, Home
  // stops promoting one and points to the Research Library instead.
  const block = betaBlockOf(me);
  const [jobs, setJobs] = useState<ResearchJobListItem[] | null>(null);
  const [pulse, setPulse] = useState<PulseLaunch>({ kind: "none" });

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

  const recent = groupResearchRuns(jobs ?? [])
    .flatMap((group) => group.questions.map((q) => q.latest))
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
    .slice(0, 6);

  return (
    <main className="enter flex flex-col gap-7 pt-1 sm:gap-9 sm:pt-2">
      {block ? (
        <BetaStatusNotice />
      ) : (
        <section className="panel panel-hero px-5 py-5 sm:px-8 sm:py-7" data-testid="home-composer">
          {pulse.kind !== "none" && (
            <p className="mb-4 text-[0.92rem] text-[var(--atlas-text-dim)]" data-testid="pulse-notice" data-kind={pulse.kind}>
              {pulse.kind === "open" ? (
                <>
                  <span className="font-medium text-[var(--atlas-cyan-strong)]">{dict.pulse.fromPulse(pulse.item.source.handle)}</span>
                  {" · "}
                  {dict.pulse.fromPulseEditable}
                </>
              ) : (
                dict.pulse.unavailable
              )}
            </p>
          )}
          {/* A remount per Pulse item puts its text into the composer's own
              state; the composer itself is unchanged. */}
          <ResearchComposer
            hero
            key={pulse.kind === "open" ? pulse.item.id : "plain"}
            initialQuestion={pulse.kind === "open" ? pulse.item.text : ""}
          />
        </section>
      )}

      {/* PRIVATE BETA ALLOWANCE (D-170) — the server's own count, shown only
          while private beta is what admits this user and a start is
          possible (D-171: never "N remaining" when the beta is full). */}
      {me?.privateBeta && !block && (
        <p className="-mt-3 px-1 text-center text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="beta-allowance">
          <span className="font-medium text-[var(--atlas-cyan-strong)]">{dict.home.betaLabel}</span>
          {" · "}
          {dict.home.betaRemaining(me.privateBeta.remaining)}
        </p>
      )}
      {!me?.privateBeta && !me?.betaPaused && inviteNotice && (
        <p className="-mt-3 px-1 text-center text-[0.95rem] text-[var(--atlas-text-dim)]" data-testid="beta-invite-notice" data-notice={inviteNotice}>
          {inviteNotice === "FULL" ? dict.home.betaAccessFull : dict.home.betaInviteUnavailable}
        </p>
      )}

      <section data-testid="recent-research">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">{dict.home.previouslyResearched}</h2>
          <Link href="/research" className="text-[0.92rem] font-medium text-[var(--atlas-cyan-strong)] hover:underline">
            {dict.home.viewAll}
          </Link>
        </div>
        {jobs === null ? (
          <ul className="history-list mt-3" aria-busy data-testid="recent-loading">
            {[0, 1, 2].map((i) => (
              <li key={i} className="history-row">
                <span className="skeleton h-11 w-11 rounded-[28%]" />
                <span className="skeleton block h-4 w-32" />
                <span className="skeleton block h-3.5 w-3/4" />
                <span className="skeleton block h-3 w-20" />
              </li>
            ))}
          </ul>
        ) : recent.length === 0 ? (
          <p className="mt-3 px-1 text-[0.98rem] text-[var(--atlas-text-dim)]" data-testid="recent-empty">
            {dict.home.recentEmpty}
          </p>
        ) : (
          <ul className="history-list mt-3">
            {recent.map((job) => (
              <RecentProofCard key={job.id} job={job} memoryEnabled={me?.memoryEnabled ?? false} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
