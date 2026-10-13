"use client";

import Link from "next/link";

import { useDict } from "../app-context";
import { displayLanguage } from "../display-language";
import { verifyPathForPulse } from "../pulse-launch";
import { pulsePublishedAt, type PulseItem } from "../pulse-fixtures";
import { relativeAge } from "../research-model";
import { ArrowIcon, ExternalIcon, SocialIcon } from "./icons";
import { ProjectAvatar } from "./project-avatar";

// ONE PULSE CARD, CLAIM-LED (V7, HANDOFF §4.6). Who said it (project,
// account, source type), how fresh it is, what was CLAIMED — the source
// text verbatim — and the question a Research would answer about it. One
// action: Verify. The claim is the record's own words in its own language;
// the labels around it are ATLAS's (EN / RU through the dictionary), and
// the verify question is the fixture's own, in the display language.
//
// No live indicator, no seen/unseen state, no category, no fake link: an
// "Open on X" action renders only when the item carries a genuine URL.
export function PulseCard({ item, now, index = 0 }: { item: PulseItem; now?: number; index?: number }) {
  const dict = useDict();
  const age = relativeAge(pulsePublishedAt(item, now), now);
  const question = item.verifyQuestion[displayLanguage()];
  return (
    <li
      className="pulse-card-v7 rise"
      style={{ animationDelay: `${60 + Math.min(index, 2) * 40}ms` }}
      data-testid="pulse-card"
      data-pulse-id={item.id}
      data-source-type={item.source.type}
    >
      <div className="flex items-start gap-3">
        <ProjectAvatar name={item.project.name} ticker={item.project.ticker} slug={item.project.slug} size={40} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="pulse-name" data-testid="pulse-source-name">
              {item.source.displayName}
            </span>
            <span className="pulse-handle" data-testid="pulse-source-handle">
              {item.source.handle}
            </span>
          </p>
          <p className="pulse-meta">
            <span className="pulse-x">
              <SocialIcon size={12} />
              {dict.pulse.sourceX}
            </span>
            <span className="pulse-type" data-type={item.source.type} data-testid="pulse-source-type">
              {dict.pulse.sourceTypes[item.source.type]}
            </span>
            <span aria-hidden>·</span>
            <span data-testid="pulse-age">{age}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="pulse-claimed" data-testid="pulse-claimed">
          <ClaimIcon />
          {dict.pulse.claimed}
        </span>
        <p className="pulse-text" data-testid="pulse-text">
          {item.text}
        </p>
      </div>

      {/* The question a Research would answer — ATLAS's framing of the
          claim, not a finding about it. Nothing here is verified. */}
      {question && (
        <p className="pulse-question" data-testid="pulse-verify-question">
          {question}
        </p>
      )}

      <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href={verifyPathForPulse(item.id)} className="pulse-cta" data-testid="pulse-verify">
          {dict.pulse.verify}
          <ArrowIcon size={16} />
        </Link>
        {item.sourceUrl && (
          <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="link-action" data-testid="pulse-open-source">
            <ExternalIcon size={14} />
            {dict.pulse.openOnX}
          </a>
        )}
      </p>
    </li>
  );
}

function ClaimIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 7h10v10" />
      <path d="M7 17L17 7" />
    </svg>
  );
}
