"use client";

import Link from "next/link";

import {
  proofMapStatus,
  type KeyEvidenceItem,
  type KeyFinding,
  type UnresolvedItem,
  type VerdictTone,
} from "../research-model";

// THE FIRST SCREEN OF A FINISHED RESEARCH — ONE OBJECT, FOUR BLOCKS.
//
//   ANSWER           (rendered by the page: verdict, confidence, 2-4 sentences)
//   PROOF MAP        the chain the question turns on, one status per link
//   KEY EVIDENCE     the few rows a reader needs to understand the conclusion
//   NOT ESTABLISHED  the boundary, stated once
//
// Everything deeper — every ladder row with its excerpts, the verification
// composition, the audit — sits behind one disclosure below these.
//
// PRESENTATION ONLY, AND DELIBERATELY DUMB. Every value here arrives
// already derived in `research-model` from persisted rows. No status is
// computed in this file, no sentence is written in this file, and no
// evidence is chosen in this file. So the page can simplify, group, hide
// repetition and translate — and can never strengthen a verdict, infer a
// missing piece of evidence, or turn "not established" into "does not
// happen". PAGE <= PERSISTED VERIFIED RECORD.

// Row status colours — the same four the ladder and the briefing table
// use, so one state reads in one colour everywhere on the screen. Red is
// reserved for a positive contradiction; missing evidence is amber.
const TONE_COLORS: Record<VerdictTone, string> = {
  supported: "#5eead4",
  partial: "#c4b5fd",
  negative: "#fca5a5",
  insufficient: "#fcd34d",
  fault: "#cbd5e1",
  neutral: "#cbd5e1",
};

/* ------------------------------------------------------------------ */
/* PROOF MAP                                                           */
/* ------------------------------------------------------------------ */

// THE CHAIN, TOP TO BOTTOM. The rows are the question's own findings where
// a projection resolved, the Pattern ladder otherwise — the identical rows
// the answer above summarises and the ladder below details, so the three
// surfaces cannot disagree. Each link carries one status word from the
// closed PROOF_MAP_STATUS vocabulary. No reason copy here: the boundary
// block below explains the open links, once.
export function ProofMap({ rows }: { rows: readonly KeyFinding[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="panel px-4 py-3.5 sm:px-6 sm:py-4" data-testid="proof-map">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Proof map
      </p>
      <ol className="mt-2.5 flex flex-col" data-testid="proof-map-rows">
        {rows.map((r, i) => (
          <li
            key={r.component}
            className="flex items-start gap-3 border-t border-[var(--hairline)] py-2 first:border-t-0"
            data-testid="proof-map-row"
            data-component={r.component}
            data-state={r.state}
          >
            {/* The link marker: a dot on the row's colour, and a hairline
                down to the next link. Purely decorative; the order of the
                list is the chain. */}
            <span className="relative mt-[0.45rem] flex w-3 shrink-0 justify-center" aria-hidden>
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: TONE_COLORS[r.tone], boxShadow: `0 0 0 3px ${TONE_COLORS[r.tone]}22` }}
              />
              {i < rows.length - 1 && (
                <span
                  className="absolute left-1/2 top-3 h-[calc(100%+0.5rem)] w-px -translate-x-1/2"
                  style={{ background: "var(--hairline)" }}
                />
              )}
            </span>
            <p className="min-w-0 flex-1 text-[0.82rem] font-medium leading-snug">{r.check}</p>
            <span
              className="shrink-0 pt-[0.1rem] text-[0.6rem] font-semibold uppercase leading-tight tracking-[0.05em]"
              style={{ color: TONE_COLORS[r.tone] }}
              data-testid="proof-map-status"
            >
              {proofMapStatus(r.state)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* KEY EVIDENCE                                                        */
/* ------------------------------------------------------------------ */

// THE FEW ROWS THAT CARRY THE CONCLUSION. Each item answers: what it
// shows, for which claim, from which source, retrieved when — and where
// to read it in full. Selection and order are `keyEvidenceFrom`'s
// (contradicting, cited, then supporting in proof-map order); this only
// lays them out. No JSON, no excerpt walls: the reading is one sentence,
// and depth is one click away in the ladder and the snapshot.
export function KeyEvidence({ items }: { items: readonly KeyEvidenceItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="panel px-4 py-3.5 sm:px-6 sm:py-4" data-testid="key-evidence">
      <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
        Key evidence
      </p>
      <ul className="mt-2 flex flex-col">
        {items.map((e) => (
          <li
            key={e.id}
            className="border-t border-[var(--hairline)] py-3 first:border-t-0"
            data-testid="key-evidence-item"
            data-evidence-id={e.id}
            data-relation={e.relation}
          >
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.04em]" style={{ color: e.relation === "CONTRADICTS" ? TONE_COLORS.negative : "var(--atlas-text-dim)" }}>
              {e.relation === "CONTRADICTS" ? "Contradicts" : "Supports"} · {e.claim}
            </p>
            <p className="mt-1 text-[0.86rem] leading-relaxed" data-testid="key-evidence-proves">
              {e.proves}
            </p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-[var(--atlas-text-dim)]" data-testid="key-evidence-source">
              <span className="font-medium text-[var(--atlas-text)]/80">{e.sourceName}</span>
              <span>· {e.sourceClass}</span>
              {e.retrievedDate && <span>· retrieved {e.retrievedDate}</span>}
            </p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 text-[0.74rem] font-medium">
              {e.snapshotHref && (
                <Link href={e.snapshotHref} className="text-[var(--atlas-cyan)] hover:underline" data-testid="key-evidence-snapshot">
                  View source snapshot
                </Link>
              )}
              <a
                href={e.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--atlas-text-dim)] hover:text-[var(--atlas-cyan)] hover:underline"
                data-testid="key-evidence-open"
              >
                Open original
              </a>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* NOT ESTABLISHED                                                     */
/* ------------------------------------------------------------------ */

// THE BOUNDARY, ONCE. The short answer's "Main limitation" sentence leads
// it; then the open checks, at most three, with their persisted reasons;
// then a count of the rest. Every sentence describes the EVIDENCE. A check
// that came back short means ATLAS did not find enough to establish the
// claim — never that the claim is false. Amber is the product's
// "unresolved", deliberately not the red it reserves for a contradiction.
export function NotEstablished({
  limitation,
  items,
  more,
}: {
  limitation: string | null;
  items: readonly UnresolvedItem[];
  more: number;
}) {
  if (!limitation && items.length === 0) return null;
  return (
    <section className="panel px-4 py-3.5 sm:px-6 sm:py-4" data-testid="unresolved-section">
      <p className="eyebrow" style={{ color: "#fcd34d" }}>
        Not established
      </p>
      {limitation && (
        <p className="mt-2 text-[0.84rem] leading-relaxed" data-testid="main-limitation">
          {limitation}
        </p>
      )}
      {items.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((u) => (
            <li key={u.component} className="text-[0.8rem] leading-snug" data-testid="unresolved-item" data-component={u.component}>
              <span className="font-medium">{u.label}</span>
              <span className="text-[var(--atlas-text-dim)]"> — {u.detail}</span>
              {u.blocked && (
                <span className="text-[var(--atlas-text-dim)]"> This is a limit of the run, not evidence for or against the project.</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="mt-2 text-[0.72rem] text-[var(--atlas-text-dim)]" data-testid="unresolved-more">
          {more} more in the full evidence below.
        </p>
      )}
    </section>
  );
}
