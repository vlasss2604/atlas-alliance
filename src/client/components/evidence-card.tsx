"use client";

import { useState } from "react";

import { componentLabel, domainOf, exclusionLabel, sourceClassLabel } from "../research-model";

// USED — bound by S8 as a citation of the Proof.
// SUPPORTING / CONTRADICTING / EXCLUDED — S5's own component sets.
// READ — extracted and admitted, but no component result references it. A
// neutral, accurate label: it says the engine read this and nothing more, and
// it is never counted as support for anything.
export type EvidenceRole =
  | "USED"
  | "SUPPORTING"
  | "CONTRADICTING"
  | "EXCLUDED"
  | "READ";

export interface EvidenceCardData {
  id: string;
  component: string | null;
  summary: string | null;
  fragment: string;
  doesNotProve: string | null;
  sourceClass: string | null;
  officiality: string | null;
  retrievedUrl: string;
  sourceTitle: string | null;
  exclusionReason?: string | null;
}

const ROLE_LABEL: Record<EvidenceRole, string> = {
  USED: "Used",
  SUPPORTING: "Supporting",
  CONTRADICTING: "Contradicting",
  EXCLUDED: "Excluded",
  READ: "Read",
};

const ROLE_TONE: Record<EvidenceRole, string> = {
  USED: "tone-supported",
  SUPPORTING: "tone-supported",
  CONTRADICTING: "tone-negative",
  EXCLUDED: "tone-neutral",
  READ: "tone-neutral",
};

// EVIDENCE & SOURCES.
//
// The role is passed in by the caller from the PERSISTED relationship — S8's
// citation binding, or S5's supporting / contradicting / excluded sets — and
// is never inferred from the text. An excluded row therefore cannot be
// rendered as support: it arrives labelled EXCLUDED, carries the reason it
// was refused, and is visually separated from anything the verdict rests on.
//
// "What it proves" is the engine's own summary; "what it does not prove" is
// the persisted doesNotProve field. Neither is generated here, and the
// section is simply absent when the field is null.
export function EvidenceCard({
  evidence,
  role,
}: {
  evidence: EvidenceCardData;
  role: EvidenceRole;
}) {
  const [open, setOpen] = useState(false);
  const title = evidence.sourceTitle ?? domainOf(evidence.retrievedUrl);

  return (
    <div
      className={`row-card overflow-hidden ${role === "EXCLUDED" ? "opacity-80" : ""}`}
      data-testid={`evidence-${evidence.id}`}
      data-role={role}
      data-source-class={evidence.sourceClass ?? "NONE"}
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
            <span className="truncate text-[0.9rem] font-medium">{title}</span>
            <span className={`tone ${ROLE_TONE[role]} text-[0.6rem] px-2 py-0.5`}>
              {ROLE_LABEL[role]}
            </span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-[0.72rem] text-[var(--atlas-text-dim)]">
            <span className="rounded-md border border-[var(--hairline)] px-1.5 py-0.5">
              {sourceClassLabel(evidence.sourceClass)}
            </span>
            {evidence.component && <span>{componentLabel(evidence.component)}</span>}
            <span className="truncate">{domainOf(evidence.retrievedUrl)}</span>
          </span>
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
          {role === "EXCLUDED" && evidence.exclusionReason && (
            <p className="mb-3 rounded-lg border border-[rgba(251,191,36,0.28)] bg-[var(--amber-dim)] px-3 py-2 text-[0.78rem] text-[#fcd34d]">
              Excluded — {exclusionLabel(evidence.exclusionReason)}. This material
              establishes nothing here and does not support the verdict.
            </p>
          )}

          <p className="eyebrow">What it proves</p>
          <p className="mt-1.5 text-[var(--atlas-text)]">
            {evidence.summary ?? evidence.fragment}
          </p>

          {evidence.doesNotProve && (
            <>
              <p className="eyebrow mt-4">What it does not prove</p>
              <p className="mt-1.5 text-[var(--atlas-text-dim)]">{evidence.doesNotProve}</p>
            </>
          )}

          <a
            href={evidence.retrievedUrl}
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
