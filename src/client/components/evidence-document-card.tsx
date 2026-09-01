"use client";

import { useState } from "react";

import {
  componentClaimLabel,
  exclusionLabel,
  sourceClassCaveat,
  sourceClassLabel,
  type DocumentGroup,
  type EvidenceItemLike,
} from "../research-model";

export type EvidenceRole =
  | "USED"
  | "SUPPORTING"
  | "CONTRADICTING"
  | "EXCLUDED"
  | "READ";

const ROLE_LABEL: Record<EvidenceRole, string> = {
  USED: "Used",
  SUPPORTING: "Supporting",
  CONTRADICTING: "Contradicting",
  // "Excluded" is the engine's word for it and sounds like a verdict on the
  // publisher. What happened is narrower and worth saying plainly: ATLAS
  // read this and did not rest anything on it.
  EXCLUDED: "Not used",
  READ: "Read",
};

const ROLE_TONE: Record<EvidenceRole, string> = {
  USED: "tone-supported",
  SUPPORTING: "tone-supported",
  CONTRADICTING: "tone-negative",
  EXCLUDED: "tone-neutral",
  READ: "tone-neutral",
};

// ONE ACQUIRED DOCUMENT, ONE CARD.
//
// A single official document routinely yields several Evidence rows — one per
// component it establishes. Rendering each row as its own source made one
// document look like several independent corroborating sources, which is
// exactly the illusion research output must never create. The card is now the
// DOCUMENT; the components it supports are listed on it, and each underlying
// Evidence item is still readable in full when expanded.
//
// This is presentation only. Stored Evidence, its component links and its
// admission are untouched; the role is passed in from the persisted
// relationship and never inferred from text.
export function EvidenceDocumentCard({
  group,
  role,
}: {
  group: DocumentGroup<EvidenceItemLike>;
  role: EvidenceRole;
}) {
  const [open, setOpen] = useState(false);
  const exclusionReason =
    group.items.find((i) => i.exclusionReason)?.exclusionReason ?? null;
  const caveat = sourceClassCaveat(group.sourceClass);

  return (
    <div
      className={`row-card overflow-hidden ${role === "EXCLUDED" ? "opacity-85" : ""}`}
      data-testid={`evidence-doc-${group.key}`}
      data-role={role}
      data-source-class={group.sourceClass ?? "NONE"}
      data-components={group.components.join(",")}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
      >
        <span className="orb orb-sm mt-0.5 grid h-9 w-9 shrink-0 place-items-center text-[var(--atlas-cyan)]">
          <DocIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[0.9rem] font-medium">{group.name}</span>
            <span className={`tone ${ROLE_TONE[role]} text-[0.6rem] px-2 py-0.5`}>
              {ROLE_LABEL[role]}
            </span>
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[0.72rem] text-[var(--atlas-text-dim)]">
            <span className="rounded-md border border-[var(--hairline)] px-1.5 py-0.5 uppercase tracking-wider">
              {sourceClassLabel(group.sourceClass)}
            </span>
            <span className="truncate">{group.domain}</span>
          </span>
          {/* A COUNT, NOT A ROW OF COMPONENT CHIPS.
              These chips rendered `componentLabel`, so the Pattern's own
              vocabulary — "Net effect", "Flow path", "Durability basis" —
              reappeared here after the ladder above had stopped showing it.
              Which claims a document touches is named properly inside, once
              the card is open; on the closed card the useful fact is simply
              how much of the mechanism it carries. */}
          {group.components.length > 0 && (
            <span className="mt-2 block text-[0.72rem] text-[var(--atlas-text-dim)]">
              {role === "EXCLUDED" ? "Considered for " : "Supports "}
              {group.components.length}{" "}
              {group.components.length === 1 ? "part" : "parts"} of the mechanism
            </span>
          )}
        </span>
        <span
          className={`mt-1 shrink-0 text-[var(--atlas-text-dim)] transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--hairline)] px-4 py-4 text-[0.85rem]">
          {role === "EXCLUDED" && exclusionReason && (
            <p className="mb-4 rounded-lg border border-[rgba(251,191,36,0.28)] bg-[var(--amber-dim)] px-3 py-2 text-[0.78rem] leading-snug text-[#fcd34d]">
              Not used — {exclusionLabel(exclusionReason)}. ATLAS read this and
              rested nothing on it. That is not a judgement that it is wrong.
            </p>
          )}

          {/* WHAT THIS CLASS OF SOURCE CAN AND CANNOT SETTLE — stated once
              per document rather than per row, and attached to the class
              badge above it. A reader looking at an official document needs
              to know it settles what the project states and nothing about
              whether the stated thing happens. */}
          {caveat && role !== "EXCLUDED" && (
            <p
              className="mb-4 rounded-lg border border-[var(--hairline)] bg-[rgba(255,255,255,0.02)] px-3 py-2 text-[0.75rem] leading-snug text-[var(--atlas-text-dim)]"
              data-testid="source-class-caveat"
            >
              {caveat.can} {caveat.cannot}
            </p>
          )}

          <div className="flex flex-col gap-5">
            {group.items.map((item) => (
              <div key={item.id} data-testid={`evidence-${item.id}`}>
                {item.component && (
                  <p className="eyebrow eyebrow-cyan mb-2">
                    {componentClaimLabel(item.component)}
                  </p>
                )}
                {/* THE VERBATIM FRAGMENT LEADS.
                    This block rendered `summary ?? fragment`, so the model's
                    paraphrase displaced the literal passage whenever one was
                    written — which is almost always. The fragment is the one
                    artifact on this screen that is checked against the
                    fetched document rather than generated: it is the reason
                    to believe any of the rest, and it was the part a reader
                    could not reach. The summary stays, underneath, labelled
                    as the reading rather than the source. */}
                <p className="eyebrow">What the source says</p>
                <blockquote className="mt-1.5 border-l-2 border-[rgba(45,212,191,0.4)] pl-3 text-[var(--atlas-text)]">
                  {item.fragment}
                </blockquote>
                {item.summary && (
                  <>
                    <p className="eyebrow mt-3">What it supports</p>
                    <p className="mt-1.5 text-[var(--atlas-text-dim)]">{item.summary}</p>
                  </>
                )}
                {item.doesNotProve && (
                  <>
                    <p className="eyebrow mt-3">What it does not establish</p>
                    <p className="mt-1.5 text-[var(--atlas-text-dim)]">{item.doesNotProve}</p>
                  </>
                )}
              </div>
            ))}
          </div>

          <a
            href={group.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-[0.78rem] text-[var(--atlas-cyan)] hover:underline"
          >
            Open source
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M4 2h6v6M10 2 3 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
      )}
    </div>
  );
}

function DocIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 2v3h3M6 8.5h4M6 11h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
