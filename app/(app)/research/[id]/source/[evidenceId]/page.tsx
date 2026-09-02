"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { api, type SourceSnapshotView } from "@/src/client/api";
import { AtlasHeader } from "@/src/client/components/atlas-header";
import { SnapshotDocumentView } from "@/src/client/components/snapshot-document-view";
import { domainOf, retrievedOn } from "@/src/client/research-model";

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

  return (
    <main className="enter flex flex-col gap-5 pb-6">
      <AtlasHeader compact back={back} />

      {/* PROVENANCE FIRST — everything needed to judge the capture before
          reading a word of it. */}
      <section className="panel panel-raised p-5 sm:p-6" data-testid="snapshot-header">
        <p className="eyebrow eyebrow-violet">ATLAS source snapshot</p>
        <h1 className="mt-2 text-[1.16rem] font-semibold leading-snug tracking-tight sm:text-[1.3rem]">
          {domain}
        </h1>
        <p
          className="mt-2 text-[0.82rem] leading-relaxed text-[var(--atlas-text-dim)]"
          data-testid="snapshot-representation-note"
        >
          {REPRESENTATION_NOTE[snapshot.representation]}
        </p>

        <dl className="mt-4 grid gap-x-6 gap-y-2.5 border-t border-[var(--hairline)] pt-4 text-[0.75rem] sm:grid-cols-2">
          <Row label="Captured" value={captured ?? "—"} />
          <Row label="Type" value={snapshot.contentType} />
          <Row label="Response" value={`HTTP ${snapshot.httpStatus}`} />
          <Row label="Size" value={`${snapshot.byteLength.toLocaleString()} bytes`} />
          <Row label="Retrieved from" value={snapshot.retrievedUrl} mono />
          {snapshot.finalUrl !== snapshot.retrievedUrl && (
            <Row label="Landed on" value={snapshot.finalUrl} mono />
          )}
          {/* The hashes cover the WHOLE capture, including anything the
              body below truncates. They say "this is the text that was
              captured" and deliberately nothing more — not a notarisation,
              and published nowhere. */}
          <Row label="Content hash" value={snapshot.contentHash} mono />
          <Row label="Text hash" value={snapshot.textSha256} mono />
        </dl>

        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-[0.78rem] font-medium text-[var(--atlas-cyan)] hover:underline"
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
      </section>

      <section className="panel p-5 sm:p-6" data-testid="snapshot-content">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
          <p className="eyebrow" style={{ color: "var(--atlas-text-dim)" }}>
            Captured content
          </p>
          {/* THE EXACT TEXT STAYS REACHABLE. Typesetting is a reading aid,
              so a reader checking a quotation character by character — or
              checking it against the hash — must be able to see what was
              actually stored. It is opt-in because the readable form is
              the one that answers "what does this source say?". */}
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="text-[0.72rem] text-[var(--atlas-text-dim)] underline-offset-2 hover:text-[var(--atlas-cyan)] hover:underline"
            data-testid="toggle-raw-capture"
          >
            {showRaw ? "Show as document" : "Show exact captured text"}
          </button>
        </div>

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
    "Captured representation of the source ATLAS retrieved. It is a preserved copy of the document, not the live page.",
  EXTRACTED_TEXT:
    "Captured representation of the source ATLAS retrieved — the text extracted from the page. Layout, images and navigation were not kept, so this is not the page as it appears in a browser.",
  TEXT: "Captured representation of the source ATLAS retrieved. It is a preserved copy, not the live page.",
};

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
