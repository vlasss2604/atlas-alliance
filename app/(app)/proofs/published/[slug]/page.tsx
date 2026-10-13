"use client";

import { useParams } from "next/navigation";

import { useApp } from "@/src/client/app-context";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { ProjectAvatar } from "@/src/client/components/project-avatar";
import { showcaseBySlug } from "@/src/client/showcase-proofs";

// A PUBLISHED, READ-ONLY PROOF (HANDOFF §4.8) — `/proofs/published/[slug]`.
//
// The Proof shown here is a completed job the Founder approved for
// publishing, rendered by the same ResearchResult in `published` mode (see
// /dev/published-proof). THE PUBLISHED SOURCE DOES NOT EXIST YET: the
// server's `published_proofs` list and its read-only route arrive in
// Phase 3 (D16). Until then this page FAILS CLOSED — it says the Proof is
// not published yet and shows no verdict, no figures and no evidence. It
// never reads a job the reader does not own and never starts a Research.
export default function PublishedProofPage() {
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const { dict, me } = useApp();
  const entry = showcaseBySlug(slug);
  const lang = me?.language === "RU" ? "RU" : "EN";
  return (
    <main className="flex flex-col gap-4 pb-6" data-testid="published-proof-page" data-state="unavailable">
      <AtlasHeader compact back={{ href: "/home", label: dict.detailPage.back }} />
      {entry && (
        <header className="rise flex flex-col gap-3">
          <p className="flex h-8 items-center gap-2.5">
            <ProjectAvatar name={entry.name} ticker={entry.ticker} slug={entry.slug} size={32} />
            <span className="text-[15px] leading-5 font-bold text-[var(--atlas-text-strong)]">{entry.name}</span>
            <span className="text-[13px] leading-5 text-[var(--atlas-text-dim)]">{dict.published.label}</span>
          </p>
          <h1 className="result-title">{entry.question[lang]}</h1>
        </header>
      )}
      <section className="process-panel rise" style={{ animationDelay: "40ms" }} data-testid="published-unavailable">
        <h2 className="process-title">{dict.published.unavailableTitle}</h2>
        <p className="text-[14px] leading-[21px] text-[var(--atlas-text-dim)]">{dict.published.unavailableText}</p>
      </section>
    </main>
  );
}
