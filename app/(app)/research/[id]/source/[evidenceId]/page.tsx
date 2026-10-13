"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { api, type SourceSnapshotView } from "@/src/client/api";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { SnapshotDocumentView } from "@/src/client/components/snapshot-document-view";
import { domainOf, retrievedOn, sourceClassLabel } from "@/src/client/research-model";
import { preservesStructure } from "@/src/client/snapshot-document";

// ATLAS SOURCE SNAPSHOT — WHAT WAS READ, NOT WHAT THE SITE LOOKS LIKE.
//
// The chain this completes: conclusion → excerpt → the whole document that
// excerpt came out of → the live original. A reader who doubts a quotation
// can read around it in the same text research read.
//
// THE LABEL IS THE FEATURE. Everything here is framed as a capture made by
// ATLAS at a moment in time, never as the publisher's page. That is not
// modesty — a preserved text genuinely is NOT the website: it has no
// styling of its own, no navigation, no images, and for an HTML source it
// is the extracted text rather than the page at all. Presenting it as "the
// original" would be the exact deception the provenance chain exists to
// prevent, so the header says what it is and the original stays one click
// away.
//
// READABLE, AND STILL HONEST. The capture is typeset as a document rather
// than dumped as terminal output, because raw `##` and `**` make genuine
// external documentation look like debug output and read as less
// trustworthy than it is. Typesetting changes nothing: the parser adds no
// words, the styling is ATLAS's own rather than an imitation of the
// publisher's, and the exact captured text stays one click away below.
//
// NOTHING HERE CAN EXECUTE. Content reaches the screen as React children,
// which are escaped — no dangerouslySetInnerHTML, no iframe, no embed. The
// deeper reason it is safe is upstream: the acquisition transport strips
// markup before persisting, so no stored capture contains a tag at all.
export default function SourceSnapshotPage() {
  const params = useParams<{ id: string; evidenceId: string }>();
  const jobId = typeof params?.id === "string" ? params.id : null;
  const evidenceId = typeof params?.evidenceId === "string" ? params.evidenceId : null;

  const [snapshot, setSnapshot] = useState<SourceSnapshotView | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (!jobId || !evidenceId) return;
    let cancelled = false;
    api
      .getSourceSnapshot(jobId, evidenceId)
      .then((r) => {
        if (cancelled) return;
        setSnapshot(r.snapshot);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, evidenceId]);

  const back = { href: `/research/${jobId ?? ""}`, label: "Back to result" };

  if (status === "loading") {
    return (
      <main className="enter flex flex-col gap-5 pb-6">
        <AtlasHeader compact back={back} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">Loading…</div>
      </main>
    );
  }

  if (status === "error" || !snapshot) {
    return (
      <main className="enter flex flex-col gap-5 pb-6">
        <AtlasHeader compact back={back} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">
          No captured copy of this source is available.
        </div>
      </main>
    );
  }

  const sourceUrl = snapshot.finalUrl || snapshot.retrievedUrl;
  const domain = domainOf(sourceUrl);
  const captured = retrievedOn(snapshot.capturedAt);
  // Markdown structure is read only where the source WAS markdown. An
  // HTML-derived capture is extracted prose that never had markdown
  // syntax, so interpreting a stray asterisk in it as emphasis would be
  // this page inventing a structure the document did not have. It is still
  // typeset as a document — proportional text, real paragraphs — because
  // that is a change of setting, not of content.
  const isMarkdown = snapshot.representation === "MARKDOWN_SOURCE";
  // Whether the capture kept the document's STRUCTURE, decided by what was
  // stored rather than by how the text looks. It selects the whole reading
  // experience below: a document, or a cited passage with the flat text
  // behind a control.
  const structured = preservesStructure(snapshot.representation);

  return (
    <main className="enter flex flex-col gap-5 pb-6">
      <AtlasHeader compact back={back} />

      {/* THE SOURCE'S IDENTITY, AND ONLY ITS IDENTITY.
          A reader arrives here asking "whose document am I looking at, and
          when was it taken?". That is four short lines — publisher, kind,
          date, and what this copy is — and they were previously competing
          for attention with eight key/value rows of transport detail. A
          response code and a sha256 answer a DIFFERENT question, asked
          later and by fewer people, so they move behind a disclosure.
          Nothing is dropped: every field that was on this card is still on
          this card. */}
      <section
        className="panel panel-raised px-5 py-7 sm:px-8 sm:py-9"
        data-testid="snapshot-header"
      >
        <div className="flex flex-col items-center text-center">
          <p className="eyebrow eyebrow-cyan">ATLAS source snapshot</p>

          {/* The domain is the headline because it is the strongest
              identity the data actually carries: `sources.title` and
              `sources.publisher` are null on every row, and inventing a
              prettier name for a publisher would be a fabricated
              provenance claim on the one screen that exists to prevent
              them. */}
          <h1 className="mt-3.5 text-[1.32rem] font-semibold leading-tight tracking-tight sm:text-[1.55rem]">
            {domain}
          </h1>

          <div className="mt-3.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[0.76rem]">
            {/* WHAT KIND OF SOURCE, from the engine's own classification.
                A KIND marker, never a score: no number, no ranking, and a
                row that carries no class simply shows no badge. */}
            {snapshot.sourceClass && (
              <span
                className="rounded-full border border-[var(--hairline-strong)] bg-[rgba(255,255,255,0.035)] px-2.5 py-[0.28rem] text-[0.68rem] font-medium tracking-[0.09em] text-[var(--atlas-text)]/80 uppercase"
                data-testid="snapshot-source-class"
              >
                {sourceClassLabel(snapshot.sourceClass)}
              </span>
            )}
            {captured && (
              <span
                className="inline-flex items-center gap-1.5 text-[var(--atlas-text-dim)]"
                data-testid="snapshot-captured"
              >
                <ClockIcon />
                Captured {captured}
              </span>
            )}
          </div>

          <p
            className="mt-4 max-w-[34rem] text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]"
            data-testid="snapshot-representation-note"
          >
            {REPRESENTATION_NOTE[snapshot.representation]}
          </p>

          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex items-center gap-1.5 text-[0.78rem] font-medium text-[var(--atlas-cyan)] hover:underline"
            data-testid="snapshot-open-original"
          >
            Open original
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path
                d="M4 2h6v6M10 2 3 9"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        </div>

        {/* THE TRANSPORT RECORD, KEPT AND DEMOTED. Closed by default
            because it answers "can I check this?" rather than "what am I
            looking at?" — and an audit trail nobody can find is worth
            nothing, so it stays one click away rather than one page away.
            The rows themselves stay a left-aligned key/value grid: centred
            metadata is decoration, and this is the part that has to be
            read precisely. */}
        <details
          className="group mt-7 border-t border-[var(--hairline)] pt-4"
          data-testid="snapshot-technical"
        >
          <summary className="mx-auto flex w-fit cursor-pointer list-none items-center gap-2 text-[0.74rem] text-[var(--atlas-text-dim)] transition-colors select-none hover:text-[var(--atlas-text)]/85 [&::-webkit-details-marker]:hidden">
            <ChevronIcon className="shrink-0 transition-transform duration-200 group-open:rotate-90" />
            Technical details
          </summary>

          <dl className="mt-5 grid gap-x-8 gap-y-3 text-left text-[0.75rem] sm:grid-cols-2">
            <Row label="Type" value={snapshot.contentType} />
            <Row label="Response" value={`HTTP ${snapshot.httpStatus}`} />
            <Row label="Size" value={`${snapshot.byteLength.toLocaleString()} bytes`} />
            <Row label="Captured" value={captured ?? "—"} />
            <Row label="Retrieved from" value={snapshot.retrievedUrl} mono />
            {snapshot.finalUrl !== snapshot.retrievedUrl && (
              <Row label="Landed on" value={snapshot.finalUrl} mono />
            )}
            {/* The hashes cover the WHOLE capture, including anything the
                body below truncates. They say "this is the text that was
                captured" and deliberately nothing more — not a
                notarisation, and published nowhere. */}
            <Row label="Content hash" value={snapshot.contentHash} mono />
            <Row label="Text hash" value={snapshot.textSha256} mono />
          </dl>
        </details>
      </section>

      {/* TWO KINDS OF CAPTURE, TWO WAYS TO READ ONE.
          What was STORED decides this, never what the text looks like. A
          markdown source kept its own structure and opens as the document
          it is. An HTML page was flattened to text by the transport before
          it was ever persisted, so it has no structure to show — and
          leading with all of it means burying the cited passage under an
          average of 18,000 characters of navigation and boilerplate.
          Neither branch guesses: reconstructing headings out of flat text
          would invent a structure ATLAS did not preserve. */}
      <section className="panel p-5 sm:p-6" data-testid="snapshot-content">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
          <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
            {structured ? "Captured content" : "Extracted text snapshot"}
          </p>
          {/* THE EXACT TEXT STAYS REACHABLE. Typesetting is a reading aid,
              so a reader checking a quotation character by character — or
              checking it against the hash — must be able to see what was
              actually stored. It is opt-in because the readable form is
              the one that answers "what does this source say?". */}
          {structured && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="text-[0.72rem] text-[var(--atlas-text-dim)] underline-offset-2 hover:text-[var(--atlas-cyan)] hover:underline"
              data-testid="toggle-raw-capture"
            >
              {showRaw ? "Show as document" : "Show exact captured text"}
            </button>
          )}
        </div>

        {structured ? (
          <div className="mt-4">
            {showRaw ? (
              <pre
                className="overflow-x-auto break-words whitespace-pre-wrap font-mono text-[0.75rem] leading-relaxed text-[var(--atlas-text)]/85"
                data-testid="snapshot-raw"
              >
                {snapshot.content}
              </pre>
            ) : (
              <SnapshotDocumentView
                content={snapshot.content}
                markdown={isMarkdown}
                baseUrl={sourceUrl}
              />
            )}
          </div>
        ) : (
          <div className="mt-3.5">
            {/* SAY WHAT WAS KEPT, PLAINLY. A reader who is shown prose
                where they expected a page deserves the reason, and the
                reason is a fact about the capture rather than an apology
                for it. */}
            <p
              className="text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]"
              data-testid="snapshot-flat-note"
            >
              This is the text representation ATLAS captured from the page. The original
              page structure was not preserved in this snapshot.
            </p>

            {/* THE PASSAGE THE RESEARCH ACTUALLY CITED, FIRST. It is this
                Evidence row's own `fragment` — the same words the finding
                quoted, not a summary of them and not a passage chosen
                here. On a flattened capture it is the ~2% a reader came
                for. */}
            <div className="mt-5" data-testid="snapshot-excerpt">
              <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
                Relevant excerpt
              </p>
              <blockquote className="mt-2 border-l-2 border-[rgba(45,212,191,0.4)] pl-3.5 text-[0.86rem] leading-relaxed text-[var(--atlas-text)]/92">
                {snapshot.fragment}
              </blockquote>
            </div>

            {/* THE WHOLE CAPTURE IS KEPT AND REACHABLE, JUST NOT DEFAULT.
                An audit needs every character; a reader needs the passage.
                Nothing here is hidden, rewritten or shortened — the full
                text is one click away, exactly as stored. */}
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="mt-5 inline-flex items-center gap-2 text-[0.74rem] text-[var(--atlas-text-dim)] underline-offset-2 hover:text-[var(--atlas-cyan)] hover:underline"
              data-testid="toggle-raw-capture"
            >
              <ChevronIcon
                className={`shrink-0 transition-transform duration-200 ${showRaw ? "rotate-90" : ""}`}
              />
              {showRaw ? "Hide full captured text" : "Show full captured text"}
              <span className="text-[var(--atlas-text-dim)]/70">
                ({snapshot.fullLength.toLocaleString()} characters)
              </span>
            </button>

            {showRaw && (
              <pre
                className="mt-4 overflow-x-auto border-t border-[var(--hairline)] pt-4 break-words whitespace-pre-wrap font-mono text-[0.75rem] leading-relaxed text-[var(--atlas-text)]/85"
                data-testid="snapshot-raw"
              >
                {snapshot.content}
              </pre>
            )}
          </div>
        )}

        {snapshot.truncated && (
          <p
            className="mt-5 rounded-lg border border-[rgba(251,191,36,0.2)] bg-[rgba(251,191,36,0.05)] px-3 py-2 text-[0.76rem] leading-snug text-[#fcd34d]"
            data-testid="snapshot-truncated"
          >
            Shown up to {snapshot.content.length.toLocaleString()} of{" "}
            {snapshot.fullLength.toLocaleString()} characters. The hashes above cover the
            whole capture.
          </p>
        )}
      </section>
    </main>
  );
}

// What was actually preserved, per representation. An HTML page did not
// survive as a page and is never described as one.
const REPRESENTATION_NOTE: Record<SourceSnapshotView["representation"], string> = {
  MARKDOWN_SOURCE:
    "Captured representation of the source ATLAS retrieved, and the one this research read. It is a preserved copy of the document, not the live page.",
  EXTRACTED_TEXT:
    "Captured representation of the source ATLAS retrieved, and the one this research read — the text extracted from the page. Layout, images and navigation were not kept, so this is not the page as it appears in a browser.",
  TEXT: "Captured representation of the source ATLAS retrieved, and the one this research read. It is a preserved copy, not the live page.",
};

// The same two glyphs the rest of the product uses: one "this is an age"
// signal, and one disclosure marker, so this screen does not introduce a
// third convention for either.
function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6 3.4V6l1.8 1.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="m6 3 5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.68rem] tracking-wider text-[var(--atlas-text-dim)] uppercase">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-[var(--atlas-text)]/90 ${mono ? "font-mono text-[0.7rem]" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
