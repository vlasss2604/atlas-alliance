"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { api, type SourceSnapshotView } from "@/src/client/api";
import { useDict } from "@/src/client/app-context";
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
//
// TWO LANGUAGES (D-171). The interface words come from the dictionary. The
// capture itself — the domain, the excerpt, the stored text, URLs, hashes,
// the content type — is shown exactly as stored.
export default function SourceSnapshotPage() {
  const params = useParams<{ id: string; evidenceId: string }>();
  const dict = useDict();
  const jobId = typeof params?.id === "string" ? params.id : null;
  const evidenceId = typeof params?.evidenceId === "string" ? params.evidenceId : null;

  const [snapshot, setSnapshot] = useState<SourceSnapshotView | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // The whole capture, and (structured only) its exact text: both opt-in.
  const [showFull, setShowFull] = useState(false);
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

  const back = { href: `/research/${jobId ?? ""}`, label: dict.audit.back };

  if (status === "loading") {
    return (
      <main className="enter flex flex-col gap-5 pb-6">
        <AtlasHeader compact back={back} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">{dict.common.loading}</div>
      </main>
    );
  }

  if (status === "error" || !snapshot) {
    return (
      <main className="enter flex flex-col gap-5 pb-6">
        <AtlasHeader compact back={back} />
        <div className="panel px-5 py-6 text-sm text-[var(--atlas-text-dim)]">{dict.snapshot.unavailable}</div>
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
    <main className="flex flex-col gap-3.5 pb-6">
      <AtlasHeader compact back={back} />

      {/* ONE HERO PANEL (V7, HANDOFF §4.4): the source's identity, the
          captured content as an inner article, then a two-cell footer —
          the way out to the live page, and the transport record behind a
          disclosure. Nothing is dropped from what the card carried: the
          same fields, regrouped. */}
      <section className="source-hero rise" data-testid="snapshot-header">
        <span className="source-hero-light" aria-hidden />

        {/* THE SOURCE'S IDENTITY, AND ONLY ITS IDENTITY.
            A reader arrives here asking "whose document am I looking at,
            and when was it taken?" — publisher, kind, date, and what this
            copy is. A response code and a sha256 answer a DIFFERENT
            question, asked later and by fewer people, so they sit behind
            the disclosure in the footer. */}
        <div className="source-id">
          <p className="source-eyebrow">
            <ShieldIcon />
            {dict.snapshot.eyebrow}
          </p>

          <div className="source-domain">
            <LockIcon />
            {/* The domain is the headline because it is the strongest
                identity the data actually carries: `sources.title` and
                `sources.publisher` are null on every row, and inventing a
                prettier name for a publisher would be a fabricated
                provenance claim on the one screen that exists to prevent
                them. */}
            <h1>{domain}</h1>
            {/* WHAT KIND OF SOURCE, from the engine's own classification.
                A KIND marker, never a score: no number, no ranking, and a
                row that carries no class simply shows no badge. */}
            {snapshot.sourceClass && (
              <span className="kind-chip" data-testid="snapshot-source-class">
                {dict.result.sourceKindChips[sourceClassLabel(snapshot.sourceClass)] ?? sourceClassLabel(snapshot.sourceClass)}
              </span>
            )}
          </div>

          <div className="source-capture">
            <span className="source-capture-icon" aria-hidden>
              <CameraIcon />
            </span>
            <div className="min-w-0 flex-1">
              {captured && (
                <p className="source-capture-title" data-testid="snapshot-captured">
                  {dict.snapshot.captured(captured)}
                </p>
              )}
              <p className="source-capture-note" data-testid="snapshot-representation-note">
                {dict.snapshot.representation[snapshot.representation]}
              </p>
            </div>
          </div>
        </div>

        {/* ONE ORDER FOR EVERY CAPTURE (owner decision, step 6 review):
            what the capture is, the passage the research cited, and only
            then the whole capture behind one control. Leading with the
            document buries the cited passage — under an average of 18,000
            characters of navigation on a flattened page, and under tables
            and headings on a structured one.

            What was STORED still decides how the whole capture reads, never
            what the text looks like. A markdown source kept its own
            structure and opens as the document it is; an HTML page was
            flattened to text by the transport before it was persisted, so it
            opens as that text. Neither branch guesses: reconstructing
            headings out of flat text would invent a structure ATLAS did not
            preserve. */}
        <article className="source-article" data-testid="snapshot-content">
          <div className="source-article-head">
            <div className="min-w-0">
              <h2>{structured ? dict.snapshot.capturedContent : dict.snapshot.extractedText}</h2>
              {/* THE EXACT TEXT STAYS REACHABLE. Typesetting is a reading
                  aid, so a reader checking a quotation character by
                  character — or checking it against the hash — must be
                  able to see what was actually stored. Offered once the
                  document is open, because that is what it switches. */}
              {structured && showFull && (
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="source-article-toggle"
                  data-testid="toggle-raw-capture"
                >
                  {showRaw ? dict.snapshot.showDocument : dict.snapshot.showExact}
                </button>
              )}
            </div>
            <span className="source-doc-icon" aria-hidden>
              <DocumentIcon />
            </span>
          </div>

          {/* SAY WHAT WAS KEPT, PLAINLY. A reader who is shown prose where
              they expected a page deserves the reason, and the reason is a
              fact about the capture rather than an apology for it. */}
          {!structured && (
            <p className="mt-4 text-[13px] leading-[19px] text-[#afc0d1]" data-testid="snapshot-flat-note">
              {dict.snapshot.flatNote}
            </p>
          )}

          {/* THE PASSAGE THE RESEARCH ACTUALLY CITED, FIRST. It is this
              Evidence row's own `fragment` — the same words the finding
              quoted, not a summary of them and not a passage chosen here. */}
          {snapshot.fragment && (
            <div className="mt-4" data-testid="snapshot-excerpt">
              <p className="source-excerpt-label">{dict.snapshot.relevantExcerpt}</p>
              <blockquote className="source-quote">
                <QuoteIcon />
                <mark className="highlight">{snapshot.fragment}</mark>
              </blockquote>
            </div>
          )}

          {/* THE WHOLE CAPTURE IS KEPT AND REACHABLE, JUST NOT DEFAULT.
              An audit needs every character; a reader needs the passage.
              Nothing here is hidden, rewritten or shortened — the full
              capture is one tap away, exactly as stored. */}
          <div className="mt-5">
            <button
              type="button"
              onClick={() => setShowFull((v) => !v)}
              className="source-article-toggle inline-flex items-center gap-2"
              aria-expanded={showFull}
              data-testid="toggle-full-capture"
            >
              <ChevronIcon
                className={`shrink-0 transition-transform duration-200 ${showFull ? "rotate-90" : ""}`}
              />
              {showFull ? dict.snapshot.hideFull : dict.snapshot.showFull}
              <span className="opacity-70">
                {dict.snapshot.characters(snapshot.fullLength.toLocaleString())}
              </span>
            </button>
          </div>

          {showFull && (
            <div className="mt-4 border-t border-[var(--hairline)] pt-4">
              {structured && !showRaw ? (
                <SnapshotDocumentView
                  content={snapshot.content}
                  markdown={isMarkdown}
                  baseUrl={sourceUrl}
                />
              ) : (
                <pre
                  className="overflow-x-auto break-words whitespace-pre-wrap font-mono text-[0.75rem] leading-relaxed text-[var(--atlas-text)]/85"
                  data-testid="snapshot-raw"
                >
                  {snapshot.content}
                </pre>
              )}
            </div>
          )}

          {/* Truncation is a fact about the capture, not a finding about
              the project, so it is neutral rather than amber. */}
          {snapshot.truncated && (
            <p className="source-note mt-5" data-testid="snapshot-truncated">
              {dict.snapshot.truncated(snapshot.content.length.toLocaleString(), snapshot.fullLength.toLocaleString())}
            </p>
          )}
        </article>

        <div className="source-foot">
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="source-original"
            data-testid="snapshot-open-original"
          >
            {dict.result.openOriginal}
            <ArrowIcon />
          </a>

          {/* THE TRANSPORT RECORD, KEPT AND DEMOTED. Closed by default
              because it answers "can I check this?" rather than "what am I
              looking at?" — and an audit trail nobody can find is worth
              nothing, so it stays one tap away. The rows stay a
              left-aligned key/value list: centred metadata is decoration,
              and this is the part that has to be read precisely. */}
          <details className="source-tech-details" data-testid="snapshot-technical">
            <summary className="source-tech-summary">
              <span>{dict.snapshot.technical}</span>
              <ChevronDownIcon />
            </summary>

            <dl className="source-tech rise grid text-left sm:grid-cols-2">
              <Row label={dict.snapshot.rows.type} value={snapshot.contentType} />
              <Row label={dict.snapshot.rows.response} value={`HTTP ${snapshot.httpStatus}`} />
              <Row label={dict.snapshot.rows.size} value={dict.snapshot.bytes(snapshot.byteLength.toLocaleString())} />
              <Row label={dict.snapshot.rows.captured} value={captured ?? "—"} />
              <Row label={dict.snapshot.rows.retrievedFrom} value={snapshot.retrievedUrl} mono />
              {snapshot.finalUrl !== snapshot.retrievedUrl && (
                <Row label={dict.snapshot.rows.landedOn} value={snapshot.finalUrl} mono />
              )}
              {/* The hashes cover the WHOLE capture, including anything the
                  body above truncates. They say "this is the text that was
                  captured" and deliberately nothing more — not a
                  notarisation, and published nowhere. */}
              <Row label={dict.snapshot.rows.contentHash} value={snapshot.contentHash} mono />
              <Row label={dict.snapshot.rows.textHash} value={snapshot.textSha256} mono />
            </dl>
          </details>
        </div>
      </section>
    </main>
  );
}

// The glyphs of the V7 snapshot board: a shield for ATLAS's own label, a
// lock for the source's address, a camera for the capture, a page for the
// captured document, and a quote mark for the cited passage. All static.
function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--atlas-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 9.5-4-1.2-7-5-7-9.5V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#35D1A2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--atlas-cyan)" aria-hidden>
      <path d="M4 17V11c0-3 2-5.5 5-6l.7 1.6C8 7.3 7.2 8.6 7 10h3v7zm9 0V11c0-3 2-5.5 5-6l.7 1.6C17 7.3 16.2 8.6 16 10h3v7z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// The disclosure marker of the flat capture's "full text" control.
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
    <div className="source-tech-row">
      <dt>{label}</dt>
      <dd className={mono ? "font-mono text-[0.72rem]" : ""}>{value}</dd>
    </div>
  );
}
