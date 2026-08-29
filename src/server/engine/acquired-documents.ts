import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { acquiredDocuments } from "../db/schema";
import { ContentFetchError } from "./providers/content-fetcher";
import type { ContentFetcher } from "./providers/content-fetcher";
import type { ContentType, FetchedDocument } from "./providers/types";
import type { ResolvedSourceRoute } from "./source-authority";

// THE HANDOFF between document acquisition (Stage A) and model extraction
// (Stage B). See the schema comment on `acquired_documents` for why the
// seam exists; this module is everything either stage may do with it.
//
// AN ACQUIRED DOCUMENT IS NOT EVIDENCE. Nothing here writes Sources,
// Evidence, locators or component results, and nothing here is imported
// by S5/S6/S7. Stage B reaches Evidence exclusively by replaying the
// document through the ordinary S4 executor — this module only stores,
// verifies and serves bytes that already passed the production transport
// gates.

const MAX_PERSISTED_TEXT_CHARS = 2_000_000; // mirrors the transport's byte cap

export interface AcquiredAuthoritySnapshot {
  officiality: string;
  routeClass: string | null;
  matchedPathPrefix: string | null;
}

// The SAME gate alpha-acquire-url.ts applies before spending anything:
// a human-confirmed route that actually carries documentary authority.
// Used by Stage A at acquisition and AGAIN by Stage B at resume — the
// both-ends rule, so neither a later classification nor a later
// revocation can silently change what a persisted document may become.
export function authorityPermitsAcquisition(route: {
  officiality: string;
  routeClass: string | null;
}): boolean {
  return route.officiality === "CONFIRMED" && route.routeClass !== null;
}

export function textSha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export type PersistAcquiredRefusal = "TEXT_TOO_LARGE" | "AUTHORITY_NOT_CONFIRMED";

// D-136 — WHICH ADMISSION RULE SEALED THIS DOCUMENT.
//
// OWNER_STRICT is D-128's rule, unchanged and default: only a
// human-CONFIRMED, classified route may be sealed, and the same predicate
// is re-checked at resume (the both-ends rule). Every existing caller
// keeps it by omission.
//
// PRODUCT_ACQUISITION exists because the canonical product path
// researches beyond first-party documentation: a search-discovered page
// must be sealable so a later phase can extract from it in a different
// network environment. It means EXACTLY ONE THING —
//
//   "the bounded transport produced this document, and it may be
//    replayed to an extractor later"
//
// — and it means NONE of: official docs, confirmed authority, established
// project identity, Evidence, fact truth, or claim support. The authority
// snapshot is recorded AS RESOLVED, including UNKNOWN/unclassified, and is
// never upgraded because a fetch happened to succeed. Evidence authority
// stays where it already is: computed by resolveSourceClass on the
// production path at extraction time.
//
// Both modes still fail closed on the size bound, because a row that
// could not have come from the bounded transport must not be creatable
// through this function either.
export const ACQUISITION_ADMISSIONS = ["OWNER_STRICT", "PRODUCT_ACQUISITION"] as const;
export type AcquisitionAdmission = (typeof ACQUISITION_ADMISSIONS)[number];

export type PersistAcquiredResult =
  | { ok: false; refusal: PersistAcquiredRefusal; detail: string }
  | { ok: true; id: string; textSha256: string };

export async function persistAcquiredDocument(
  db: Database | Transaction,
  input: {
    projectId: string;
    acquiringJobId: string | null;
    doc: FetchedDocument;
    route: ResolvedSourceRoute;
    renderMode: "STATIC" | "RENDERED";
    // Defaults to OWNER_STRICT so every pre-D-136 caller is byte-for-byte
    // unchanged: omitting it cannot silently relax the gate.
    admission?: AcquisitionAdmission;
  },
): Promise<PersistAcquiredResult> {
  // Fail closed on both bounds even though the transport already enforces
  // them — a row that could not have come from the bounded path must not
  // be creatable through this function either.
  if (input.doc.normalizedText.length > MAX_PERSISTED_TEXT_CHARS) {
    return { ok: false, refusal: "TEXT_TOO_LARGE", detail: "normalized text exceeds the transport bound" };
  }
  const admission: AcquisitionAdmission = input.admission ?? "OWNER_STRICT";
  // The authority GATE applies to OWNER_STRICT only. Under
  // PRODUCT_ACQUISITION the same authority is still resolved and recorded
  // below — it simply does not decide admission, because sealing is a
  // statement about the transport, not about authority.
  if (admission === "OWNER_STRICT" && !authorityPermitsAcquisition(input.route)) {
    return {
      ok: false,
      refusal: "AUTHORITY_NOT_CONFIRMED",
      detail: "acquisition requires a CONFIRMED route with a non-null routeClass",
    };
  }
  const authority: AcquiredAuthoritySnapshot = {
    officiality: input.route.officiality,
    routeClass: input.route.routeClass,
    matchedPathPrefix: input.route.matchedPathPrefix,
  };
  const [row] = await db
    .insert(acquiredDocuments)
    .values({
      projectId: input.projectId,
      url: input.doc.requestedUrl,
      finalUrl: input.doc.finalUrl,
      httpStatus: input.doc.httpStatus,
      contentType: input.doc.contentType,
      byteLength: input.doc.byteLength,
      staticTextLength: input.doc.staticTextLength ?? input.doc.normalizedText.length,
      normalizedText: input.doc.normalizedText,
      contentHash: input.doc.contentHash,
      textSha256: textSha256(input.doc.normalizedText),
      renderMode: input.renderMode,
      authority,
      acquiringJobId: input.acquiringJobId,
    })
    .returning({ id: acquiredDocuments.id, textSha256: acquiredDocuments.textSha256 });
  return { ok: true, id: row.id, textSha256: row.textSha256 };
}

export type ResumeLoadRefusal =
  | "NOT_FOUND"
  | "PROJECT_MISMATCH"
  | "CONTENT_TAMPERED"
  | "ALREADY_CONSUMED"
  | "SNAPSHOT_AUTHORITY_INVALID";

export type AcquiredDocumentRow = typeof acquiredDocuments.$inferSelect;

export type ResumeLoadResult =
  | { ok: false; refusal: ResumeLoadRefusal; detail: string }
  | { ok: true; row: AcquiredDocumentRow; doc: FetchedDocument };

// Loads ONE acquired document for resume, fail-closed on every axis:
// existence, project ownership, the tamper seal, prior consumption, and
// the acquisition-time authority snapshot. The CURRENT route authority is
// deliberately NOT checked here — the resume runner re-resolves it
// through the live resolver so the both-ends rule reads today's truth,
// not a stored one.
export async function loadAcquiredDocumentForResume(
  db: Database | Transaction,
  input: { documentId: string; projectId: string },
): Promise<ResumeLoadResult> {
  const [row] = await db
    .select()
    .from(acquiredDocuments)
    .where(eq(acquiredDocuments.id, input.documentId));
  if (!row) return { ok: false, refusal: "NOT_FOUND", detail: "no acquired document with that id" };
  if (row.projectId !== input.projectId) {
    return {
      ok: false,
      refusal: "PROJECT_MISMATCH",
      detail: "the document belongs to a different project",
    };
  }
  if (row.consumedAt !== null) {
    return {
      ok: false,
      refusal: "ALREADY_CONSUMED",
      detail: "this document already produced Evidence; a fresh look is a new acquisition",
    };
  }
  if (textSha256(row.normalizedText) !== row.textSha256) {
    return {
      ok: false,
      refusal: "CONTENT_TAMPERED",
      detail: "stored text does not match its seal",
    };
  }
  const snapshot = row.authority as AcquiredAuthoritySnapshot | null;
  if (!snapshot || !authorityPermitsAcquisition(snapshot)) {
    return {
      ok: false,
      refusal: "SNAPSHOT_AUTHORITY_INVALID",
      detail: "the acquisition-time authority snapshot does not permit evidentiary use",
    };
  }
  const doc: FetchedDocument = {
    finalUrl: row.finalUrl,
    requestedUrl: row.url,
    httpStatus: row.httpStatus,
    contentType: row.contentType as ContentType,
    normalizedText: row.normalizedText,
    contentHash: row.contentHash,
    fetchedAt: row.acquiredAt,
    byteLength: row.byteLength,
    staticTextLength: row.staticTextLength ?? row.normalizedText.length,
  };
  return { ok: true, row, doc };
}

// The Stage B transport: a ContentFetcher that can serve EXACTLY ONE
// document for EXACTLY ONE url, from storage. It performs no network
// activity of any kind — a request for any other url is a hard error, so
// the resumed executor structurally cannot reach the external source even
// if its candidate handling changed.
export function replayContentFetcher(doc: FetchedDocument): ContentFetcher {
  return {
    // D-137: this fetcher opens nothing. It serves one already-acquired,
    // already-accounted document and refuses every other url, so the job
    // must not be charged a source open for using it.
    metering: "REPLAY" as const,
    name: "acquired-document-replay",
    async fetch(url: string): Promise<FetchedDocument> {
      if (url !== doc.requestedUrl && url !== doc.finalUrl) {
        throw new ContentFetchError(
          "INVALID_URL",
          "replay serves only the acquired document's own url",
          url,
        );
      }
      return doc;
    },
  };
}

// The single permitted mutation, applied only after a Stage B run has
// actually persisted Evidence. Atomic: the WHERE clause claims the row
// only if it is still unconsumed, so a concurrent second resume observes
// false and fails closed rather than double-marking.
export async function markAcquiredDocumentConsumed(
  db: Database | Transaction,
  documentId: string,
  consumedByJobId: string,
): Promise<boolean> {
  const rows = await db
    .update(acquiredDocuments)
    .set({ consumedAt: new Date(), consumedByJobId })
    .where(and(eq(acquiredDocuments.id, documentId), isNull(acquiredDocuments.consumedAt)))
    .returning({ id: acquiredDocuments.id });
  return rows.length === 1;
}
