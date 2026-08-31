"use client";

import { useState } from "react";

import {
  componentLabel,
  exclusionLabel,
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
          {group.components.length > 0 && (
            <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.72rem]">
              <span className="text-[var(--atlas-text-dim)]">
                {role === "EXCLUDED" ? "Considered for:" : "Supports:"}
              </span>
              {group.components.map((c) => (
                <span
                  key={c}
                  className="rounded-md border border-[var(--hairline)] bg-[rgba(255,255,255,0.03)] px-1.5 py-0.5"
                >
                  {componentLabel(c)}
                </span>
              ))}
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
            <p className="mb-4 rounded-lg border border-[rgba(251,191,36,0.28)] bg-[var(--amber-dim)] px-3 py-2 text-[0.78rem] text-[#fcd34d]">
              Excluded — {exclusionLabel(exclusionReason)}. This material
              establishes nothing here and does not support the verdict.
            </p>
          )}

          <div className="flex flex-col gap-5">
            {group.items.map((item) => (
              <div key={item.id} data-testid={`evidence-${item.id}`}>
                {item.component && (
                  <p className="eyebrow eyebrow-cyan mb-2">{componentLabel(item.component)}</p>
                )}
                <p className="eyebrow">What it proves</p>
                <p className="mt-1.5 text-[var(--atlas-text)]">
                  {item.summary ?? item.fragment}
                </p>
                {item.doesNotProve && (
                  <>
                    <p className="eyebrow mt-3">What it does not prove</p>
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
