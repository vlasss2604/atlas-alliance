"use client";

import Link from "next/link";

import { useDict } from "../app-context";
import { verifyPathForPulse } from "../pulse-launch";
import { pulsePublishedAt, type PulseItem } from "../pulse-fixtures";
import { relativeAge } from "../research-model";
import { ArrowIcon, ExternalIcon, SocialIcon } from "./icons";
import { ProjectAvatar } from "./project-avatar";

// ONE PULSE CARD. Who said it (project, account, source type), what was
// said — the source text verbatim — how fresh it is, and one action:
// Verify. The text is the record's own words in its own language; only
// the labels around it are ATLAS's (EN / RU through the dictionary).
//
// No live indicator, no seen/unseen state, no category, no fake link: an
// "Open on X" action renders only when the item carries a genuine URL.
export function PulseCard({ item, now }: { item: PulseItem; now?: number }) {
  const dict = useDict();
  const age = relativeAge(pulsePublishedAt(item, now), now);
  return (
    <li className="panel px-5 py-5 sm:px-6" data-testid="pulse-card" data-pulse-id={item.id} data-source-type={item.source.type}>
      <div className="flex items-start gap-3">
        <ProjectAvatar name={item.project.name} ticker={item.project.ticker} slug={item.project.slug} size={40} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[1.02rem] font-semibold text-[var(--atlas-text-strong)]" data-testid="pulse-source-name">
              {item.source.displayName}
            </span>
            <span className="text-[0.9rem] text-[var(--atlas-text-dim)]" data-testid="pulse-source-handle">
              {item.source.handle}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.82rem] text-[var(--atlas-text-dim)]">
            <span className="kind kind-social">
              <SocialIcon size={12} />
              {dict.pulse.sourceX}
            </span>
            <span data-testid="pulse-source-type">{dict.pulse.sourceTypes[item.source.type]}</span>
            <span aria-hidden>·</span>
            <span data-testid="pulse-age">{age}</span>
          </p>
        </div>
      </div>

      <p className="mt-3.5 text-[1.02rem] leading-[1.5] text-[var(--atlas-text)]" data-testid="pulse-text">
        {item.text}
      </p>

      <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href={verifyPathForPulse(item.id)} className="cta pill inline-flex items-center gap-2 px-5 py-2.5 text-[0.95rem] font-semibold" data-testid="pulse-verify">
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
