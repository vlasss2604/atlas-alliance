"use client";

import { forwardRef } from "react";

import {
  EvidenceDocumentCard,
  type EvidenceRole,
} from "./evidence-document-card";
import { type DocumentGroup, type EvidenceItemLike } from "../research-model";

export interface RoleGroups {
  role: EvidenceRole;
  groups: DocumentGroup<EvidenceItemLike>[];
}

// LEVEL 3 — THE EVIDENCE, FOR SOMEONE WHO WANTS TO CHALLENGE THE RESULT.
//
// Closed by default. This used to be the middle of the default screen, where
// it could produce cards across eight separate role buckets and outweigh the
// conclusion it was supporting. A reader who accepts the answer never needed
// it; a reader who doubts one row now arrives here from that row.
//
// The three lists stay SEPARATE, and the separation is not cosmetic:
//
//   USED / SUPPORTING / CONTRADICTING — bound to this finding by persisted
//   S8 citation provenance and S5 component sets.
//
//   NOT USED — read and refused under a named rule. This is the section that
//   proves the answer was not assembled by picking agreeable sources, and it
//   is the one thing here a chat answer structurally cannot produce.
//
//   OTHER MATERIAL — read during this research and bound to nothing. Listed
//   so a run that read sources and used none does not look like a run that
//   read nothing, and never attributed to the verdict.
export const EvidenceSection = forwardRef<
  HTMLElement,
  {
    admittedDocs: RoleGroups[];
    excludedDocs: DocumentGroup<EvidenceItemLike>[];
    otherDocs: RoleGroups[];
    // COUNTED ONCE, BY THE CALLER, OVER DISTINCT DOCUMENTS.
    //
    // These were derived here by summing group counts across the role
    // buckets, and a document that carries rows in more than one role is
    // present in more than one bucket — so a job with four documents
    // reported "2 used as evidence, 8 read and not used" while the answer
    // above it said "4 sources read". Two numbers for one fact, disagreeing
    // on the same screen, is precisely the arithmetic a reader cannot check
    // and should never have been asked to.
    readCount: number;
    usedCount: number;
    open: boolean;
    onToggle: () => void;
  }
>(function EvidenceSection(
  { admittedDocs, excludedDocs, otherDocs, readCount, usedCount, open, onToggle },
  ref,
) {
  const hasAdmitted = admittedDocs.some((d) => d.groups.length > 0);
  const hasOther = otherDocs.some((d) => d.groups.length > 0);
  const notUsedCount = Math.max(0, readCount - usedCount);

  return (
    <section ref={ref} className="panel p-5 sm:p-6" data-testid="section-evidence">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 text-left"
        data-testid="toggle-evidence"
      >
        <span className="min-w-0 flex-1">
          <span className="eyebrow block">Evidence</span>
          <span className="mt-1.5 block text-[0.82rem] text-[var(--atlas-text-dim)]">
            {readCount === 0
              ? "No sources were bound to this finding."
              : `${usedCount} used as evidence` +
                (notUsedCount > 0 ? `, ${notUsedCount} read and not used` : "")}
          </span>
        </span>
        <span
          className={`shrink-0 text-[var(--atlas-text-dim)] transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="m6 3 5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && (
        <div className="mt-5">
          {!hasAdmitted ? (
            <p className="text-[0.85rem] text-[var(--atlas-text-dim)]">
              No evidence was bound in support of this finding.
            </p>
          ) : (
            <div className="grid gap-2.5 lg:grid-cols-2">
              {admittedDocs.flatMap((d) =>
                d.groups.map((g) => (
                  <EvidenceDocumentCard key={`${d.role}:${g.key}`} group={g} role={d.role} />
                )),
              )}
            </div>
          )}

          {excludedDocs.length > 0 && (
            <div className="mt-6" data-testid="excluded-evidence">
              <p className="eyebrow mb-2">Sources ATLAS checked but did not use</p>
              <p className="mb-3 text-[0.78rem] leading-snug text-[var(--atlas-text-dim)]">
                Each was read and then refused under a stated rule. None of them
                supports anything above.
              </p>
              <div className="grid gap-2.5 lg:grid-cols-2">
                {excludedDocs.map((g) => (
                  <EvidenceDocumentCard key={g.key} group={g} role="EXCLUDED" />
                ))}
              </div>
            </div>
          )}

          {hasOther && (
            <div className="mt-6">
              <p className="eyebrow mb-2">Other material read</p>
              <p className="mb-3 text-[0.78rem] leading-snug text-[var(--atlas-text-dim)]">
                Read during this research but not bound to the result above.
              </p>
              <div className="grid gap-2.5 lg:grid-cols-2">
                {otherDocs.flatMap((d) =>
                  d.groups.map((g) => (
                    <EvidenceDocumentCard key={`${d.role}:${g.key}`} group={g} role={d.role} />
                  )),
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
