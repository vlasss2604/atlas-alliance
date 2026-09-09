"use client";

import { EVIDENCE_KIND_LABEL, type EvidenceKindMeta } from "./types";

// 9. EVIDENCE SNAPSHOTS — THE SURFACE THE PRODUCT ALREADY TRUSTS.
//
// This deliberately reuses the vocabulary the existing evidence card
// established rather than inventing a competing one: the source, then the
// retrieved passage VERBATIM, then what it supports, then — the sentence
// that makes the whole product honest — what it does not establish.
//
// THE FRAGMENT COMES BEFORE ANY PARAPHRASE. A reader should meet the
// source's own words first and our reading of them second, so they can
// disagree with us. That ordering is the point of the block.
const KIND_ACCENT: Record<EvidenceKindMeta["kind"], string> = {
  DOCUMENTARY: "#c4b5fd",
  ON_CHAIN: "#5eead4",
  GOVERNANCE: "#22d3ee",
  QUANTITATIVE: "#fcd34d",
};

export function EvidenceSnapshotBlock({ items }: { items: EvidenceKindMeta[] }) {
  return (
    <section className="flex flex-col gap-2.5" data-testid="block-evidence">
      <p className="eyebrow px-1" style={{ color: "var(--atlas-text-dim)" }}>
        Evidence snapshots
      </p>
      {items.map((item) => (
        <SnapshotCard key={item.source} item={item} />
      ))}
    </section>
  );
}

function SnapshotCard({ item }: { item: EvidenceKindMeta }) {
  const accent = KIND_ACCENT[item.kind];
  return (
    <article
      className="panel overflow-hidden"
      data-testid="evidence-snapshot"
      data-kind={item.kind}
    >
      {/* The kind band: what sort of evidence this is, before anything it
          says. A governance record and a chain read are not interchangeable
          and should not arrive looking identical. */}
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--hairline)] px-4 py-2"
        style={{ background: "rgba(4,7,13,0.4)" }}
      >
        <span
          className="text-[0.6rem] font-semibold uppercase tracking-[0.06em]"
          style={{ color: accent }}
        >
          {EVIDENCE_KIND_LABEL[item.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.72rem] text-[var(--atlas-text-dim)]">
          {item.source}
        </span>
        <span className="text-[0.65rem] tabular-nums text-[var(--atlas-text-dim)]">
          {item.retrievedAt}
        </span>
      </div>

      <div className="px-4 py-3">
        {/* THE SOURCE'S OWN WORDS, marked as a quotation by a rule down the
            left rather than by quote marks that a fragment may itself
            contain. */}
        <blockquote
          className="border-l-2 pl-3 text-[0.83rem] leading-relaxed"
          style={{ borderColor: accent }}
          data-testid="evidence-fragment"
        >
          {item.fragment}
        </blockquote>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
              What it supports
            </p>
            <p className="mt-1 text-[0.78rem] leading-snug">{item.proves}</p>
          </div>
          <div>
            <p className="eyebrow" style={{ color: "#fcd34d" }}>
              What it does not establish
            </p>
            <p className="mt-1 text-[0.78rem] leading-snug text-[var(--atlas-text-dim)]">
              {item.doesNotProve}
            </p>
          </div>
        </div>

        {item.href && (
          <p className="mt-3 border-t border-[var(--hairline)] pt-2.5">
            <span className="text-[0.7rem] text-[var(--atlas-text-dim)]">
              Open source · inspect capture
            </span>
          </p>
        )}
      </div>
    </article>
  );
}
