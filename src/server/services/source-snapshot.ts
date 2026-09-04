import { and, desc, eq, inArray, or } from "drizzle-orm";

import type { Database } from "../db/client";
import { acquiredDocuments, evidence, researchJobs } from "../db/schema";

// ATLAS SOURCE SNAPSHOT — WHAT WAS ACTUALLY READ, AT THE TIME IT WAS READ.
//
// This service adds NO capture step and NO storage. The acquisition path
// (acquisition-phases.ts -> persistAcquiredDocument) has always written the
// document it fetched into `acquired_documents`, because Stage B replays
// that exact text to extract Evidence from it. The snapshot is therefore
// the very representation research reasoned over — the fetch-once property
// is structural rather than a promise this module makes.
//
// WHAT IS AND IS NOT PRESERVED, STATED HONESTLY.
//
// `normalized_text` is what the transport produced. For a markdown
// resource that is the source verbatim. For an HTML page it is the
// EXTRACTED TEXT — the transport strips markup before persisting, so no
// stored row contains a tag, a script or a handler. Measured across every
// row in the dev database: no `text/html` capture contains markup at all.
//
// That single fact settles the security question this feature would
// otherwise raise. There is no stored HTML to replay, so there is nothing
// to sanitize, no iframe, no active content and no XSS surface — the view
// renders text through React, which escapes it. A snapshot can never be
// presented as the original page, because the original page is not what
// was kept.
//
// LINKAGE IS EXACT AND JOB-SCOPED. A row matches when the url it was
// requested at OR the url it finally landed on equals the Evidence's
// `retrieved_url`, AND the row belongs to this job (it either acquired the
// document or consumed it). A document another job fetched can never
// surface as this job's provenance.

export type SnapshotRepresentation = "MARKDOWN_SOURCE" | "EXTRACTED_TEXT" | "TEXT";

// A capture is bounded at rest by the transport's own 2MB cap and by the
// `ck_acquired_documents_text_bounded` CHECK, so nothing unbounded can
// exist to serve. This second, smaller bound applies to the RESPONSE: an
// audit view is read on a phone, and the largest capture in the dev
// database is 93KB, so 512KB is far above anything real while refusing to
// stream a pathological row. Truncation is always declared, never silent,
// and the hash keeps describing the WHOLE capture rather than the excerpt.
export const SNAPSHOT_BODY_LIMIT = 512_000;

export interface SourceSnapshotView {
  evidenceId: string;
  // The url Evidence was retrieved from, and where the transport landed if
  // a redirect moved it. Never a prettier address than the one used.
  retrievedUrl: string;
  // What KIND of source this is, from `evidence.source_class` — the
  // engine's own classification, not a judgement this view makes. It is
  // the strongest identity the data actually carries here: `sources.title`
  // and `sources.publisher` are null on every row, so the card's headline
  // stays the domain and this says what sort of document it is. Nullable
  // because legacy (contract version 1) Evidence honestly has no value,
  // and the card then shows no badge rather than guessing one.
  sourceClass: string | null;
  // The passage this Evidence row actually cited, verbatim from
  // `evidence.fragment`. It is what a flattened capture leads with: the
  // research quoted a paragraph, and burying that paragraph inside tens
  // of thousands of characters of flattened page serves nobody.
  fragment: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  representation: SnapshotRepresentation;
  byteLength: number;
  // sha256 of the raw response bytes and of the text as persisted. Both
  // come from the capture itself; neither is recomputed here.
  contentHash: string;
  textSha256: string;
  capturedAt: string;
  renderMode: string;
  content: string;
  truncated: boolean;
  fullLength: number;
}

// The stored content type decides how the capture is described. A markdown
// resource kept its own source; an HTML page did not survive as a page and
// must not be described as though it had.
export function representationOf(contentType: string): SnapshotRepresentation {
  const type = contentType.toLowerCase();
  if (type.includes("markdown")) return "MARKDOWN_SOURCE";
  if (type.includes("html")) return "EXTRACTED_TEXT";
  return "TEXT";
}

// Whether that representation kept the document's STRUCTURE is decided by
// `preservesStructure` in `src/client/snapshot-document.ts` — it lives
// there because only the reader asks the question, and this module must
// not be imported into a client bundle.

function snapshotMatch(retrievedUrls: string[], jobId: string) {
  return and(
    or(
      inArray(acquiredDocuments.url, retrievedUrls),
      inArray(acquiredDocuments.finalUrl, retrievedUrls),
    ),
    or(
      eq(acquiredDocuments.acquiringJobId, jobId),
      eq(acquiredDocuments.consumedByJobId, jobId),
    ),
  );
}

// WHICH EVIDENCE ROWS HAVE A SNAPSHOT — so the result card can offer the
// action only where it leads somewhere. A dead button on a card whose
// document predates capture would be worse than no button.
export async function evidenceIdsWithSnapshot(
  db: Database,
  jobId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: evidence.id, retrievedUrl: evidence.retrievedUrl })
    .from(evidence)
    .where(eq(evidence.researchJobId, jobId));
  if (rows.length === 0) return new Set();

  const urls = [...new Set(rows.map((r) => r.retrievedUrl))];
  const captured = await db
    .select({
      url: acquiredDocuments.url,
      finalUrl: acquiredDocuments.finalUrl,
    })
    .from(acquiredDocuments)
    .where(snapshotMatch(urls, jobId));

  const capturedUrls = new Set<string>();
  for (const c of captured) {
    capturedUrls.add(c.url);
    capturedUrls.add(c.finalUrl);
  }
  return new Set(rows.filter((r) => capturedUrls.has(r.retrievedUrl)).map((r) => r.id));
}

// ONE SNAPSHOT, OWNERSHIP-SCOPED AT THE QUERY.
//
// Same rule as every other job-scoped read: the job must belong to this
// caller, enforced as a WHERE predicate rather than a role check. Null
// means "no snapshot this caller may see" — a job that is not theirs, an
// evidence row from another job, or a document captured before this
// feature existed. The caller renders that as absence, never as an error
// about the source.
export async function loadSourceSnapshot(
  db: Database,
  jobId: string,
  evidenceId: string,
  ownerUserId: string,
): Promise<SourceSnapshotView | null> {
  const [row] = await db
    .select({
      retrievedUrl: evidence.retrievedUrl,
      sourceClass: evidence.sourceClass,
      fragment: evidence.fragment,
    })
    .from(evidence)
    .innerJoin(researchJobs, eq(evidence.researchJobId, researchJobs.id))
    .where(
      and(
        eq(evidence.id, evidenceId),
        eq(evidence.researchJobId, jobId),
        eq(researchJobs.userId, ownerUserId),
      ),
    );
  if (!row) return null;

  // Most recent capture of this url for this job. A url fetched twice in
  // one job is the same document acquired again, and the one the research
  // actually went on to read is the later row.
  const [doc] = await db
    .select({
      url: acquiredDocuments.url,
      finalUrl: acquiredDocuments.finalUrl,
      httpStatus: acquiredDocuments.httpStatus,
      contentType: acquiredDocuments.contentType,
      byteLength: acquiredDocuments.byteLength,
      normalizedText: acquiredDocuments.normalizedText,
      contentHash: acquiredDocuments.contentHash,
      textSha256: acquiredDocuments.textSha256,
      renderMode: acquiredDocuments.renderMode,
      acquiredAt: acquiredDocuments.acquiredAt,
    })
    .from(acquiredDocuments)
    .where(snapshotMatch([row.retrievedUrl], jobId))
    .orderBy(desc(acquiredDocuments.acquiredAt))
    .limit(1);
  if (!doc) return null;

  const full = doc.normalizedText;
  const truncated = full.length > SNAPSHOT_BODY_LIMIT;

  return {
    evidenceId,
    retrievedUrl: row.retrievedUrl,
    sourceClass: row.sourceClass,
    fragment: row.fragment,
    finalUrl: doc.finalUrl,
    httpStatus: doc.httpStatus,
    contentType: doc.contentType,
    representation: representationOf(doc.contentType),
    byteLength: doc.byteLength,
    contentHash: doc.contentHash,
    textSha256: doc.textSha256,
    capturedAt: doc.acquiredAt.toISOString(),
    renderMode: doc.renderMode,
    content: truncated ? full.slice(0, SNAPSHOT_BODY_LIMIT) : full,
    truncated,
    fullLength: full.length,
  };
}
