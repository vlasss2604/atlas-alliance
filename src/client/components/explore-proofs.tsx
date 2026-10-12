"use client";

import Link from "next/link";

import { useDict } from "../app-context";
import { displayLanguage } from "../display-language";
import { retrievedOn, verdictTone } from "../research-model";
import { publishedProofPath, type ShowcaseProof } from "../showcase-proofs";
import { ProjectAvatar } from "./project-avatar";

// EXPLORE ATLAS PROOFS (V7, HANDOFF §4.1a) — a horizontal strip of
// question-led cards under the composer, one per showcase project. A card
// shows a verdict ONLY when its entry carries an approved published Proof;
// otherwise it is a grey "In quality review" card that is not a link.
// Reading a published Proof never starts a Research.
export function ExploreProofs({ items }: { items: readonly ShowcaseProof[] }) {
  const dict = useDict();
  // The user's display language (set by the app provider; EN by default).
  const lang = displayLanguage();
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" data-testid="explore-proofs" aria-label={dict.explore.title}>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="section-title">{dict.explore.title}</h2>
          <span className="free-chip">
            <LockIcon />
            {dict.explore.free}
          </span>
        </div>
        <p className="text-[13.5px] leading-[19px] text-[var(--atlas-text-dim)]">{dict.explore.sub}</p>
      </div>

      <ul className="snap-strip" data-testid="explore-strip">
        {items.map((p, i) =>
          p.published ? (
            <li key={p.slug} className="rise" style={{ animationDelay: `${Math.min(i, 5) * 40}ms` }}>
              <Link
                href={publishedProofPath(p.slug)}
                className="explore-card"
                data-tone={verdictTone(p.published.verdict)}
                data-testid="explore-card"
                data-published="true"
              >
                <span className="explore-card-line" aria-hidden />
                <span className="flex items-center justify-between gap-2.5">
                  <ProjectHead p={p} lang={lang} />
                  <span className="free-chip free-chip-sm">
                    <EyeIcon />
                    {dict.explore.free}
                  </span>
                </span>
                <span className="explore-question">{p.question[lang]}</span>
                <span className="flex flex-col items-start gap-1.5">
                  <span className={`tone tone-${verdictTone(p.published.verdict)} tone-sm`} data-testid="explore-verdict" data-verdict={p.published.verdict}>
                    {dict.verdict[p.published.verdict]}
                  </span>
                  <span className="text-[11.5px] leading-[14px] text-[#7f93a8]">
                    {dict.explore.checked} {retrievedOn(p.published.checkedAt)}
                  </span>
                </span>
                <span className="explore-read">
                  {dict.explore.read}
                  <ArrowSmall />
                </span>
              </Link>
            </li>
          ) : (
            <li key={p.slug} className="rise" style={{ animationDelay: `${Math.min(i, 5) * 40}ms` }}>
              <div className="explore-card explore-card-review" data-testid="explore-card" data-published="false">
                <span className="opacity-85">
                  <ProjectHead p={p} lang={lang} dim />
                </span>
                <span className="explore-question explore-question-dim">{p.question[lang]}</span>
                <span className="explore-review" data-testid="explore-in-review">
                  <ClockIcon />
                  {dict.explore.inReview}
                </span>
              </div>
            </li>
          ),
        )}
      </ul>
      <p className="text-[12px] leading-[17px] text-[#7f93a8]" data-testid="explore-note">
        {dict.explore.note}
      </p>
    </section>
  );
}

function ProjectHead({ p, lang, dim = false }: { p: ShowcaseProof; lang: "EN" | "RU"; dim?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ProjectAvatar name={p.name} ticker={p.ticker} slug={p.slug} size={40} />
      <span className="flex min-w-0 flex-col gap-px">
        <span className={`text-[15px] leading-[19px] font-extrabold ${dim ? "text-[#dce4ec]" : ""}`}>{p.name}</span>
        <span className="truncate text-[11.5px] leading-[14px] text-[var(--atlas-text-mute)]">{p.topic[lang]}</span>
      </span>
    </span>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function ArrowSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}
