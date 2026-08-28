import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { projects } from "./catalog";
import { researchJobs } from "./research";

// ACQUIRED DOCUMENTS — the durable handoff between document acquisition
// (Stage A) and model extraction (Stage B).
//
// WHY THIS EXISTS. The exact-URL acquisition coupled two external
// capabilities in one process: fetching the document and calling the
// model provider. Two live windows proved their working network
// conditions are not currently identical — the document fetch succeeded
// where the provider returned 403, and the provider succeeded where the
// document host was unreachable. When extraction failed, the successfully
// fetched content was simply lost and the operator had to spend another
// external fetch. This table is the seam: Stage A persists the validated
// document and stops; Stage B consumes it later without touching the
// external source again.
//
// A ROW HERE IS NOT EVIDENCE. It is not a Source, not a fact, not a
// component input, and it establishes nothing — exactly like an on-chain
// artifact before composition. It carries the provenance later Evidence
// creation needs (url, hashes, authority snapshot), but evidentiary
// authority is decided by the normal production path at Evidence-creation
// time, never inherited from this row. Nothing in S5/S6/S7 reads this
// table.
//
// IMMUTABLE BY CONTRACT. Rows are inserted once and never updated except
// for the single consumption mark. `text_sha256` binds the stored text;
// resume recomputes and refuses on mismatch, so silent tampering cannot
// reach extraction.
export const acquiredDocuments = pgTable(
  "acquired_documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    // The url the owner named and the url the transport actually landed
    // on — the same pair FetchedDocument carries, already containment-
    // checked by the fetch/render path before this row can exist.
    url: text("url").notNull(),
    finalUrl: text("final_url").notNull(),
    httpStatus: integer("http_status").notNull(),
    contentType: text("content_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    staticTextLength: integer("static_text_length"),
    // The document text exactly as the production transport produced it
    // (HTML already normalized, Markdown/plain kept verbatim, embedded
    // payloads already merged). Stage B replays THIS, byte for byte.
    normalizedText: text("normalized_text").notNull(),
    // sha256 of the raw response bytes, from the fetch itself.
    contentHash: text("content_hash").notNull(),
    // sha256 of normalized_text as persisted — the tamper seal resume
    // verifies before the text may reach extraction.
    textSha256: text("text_sha256").notNull(),
    // STATIC or RENDERED — which transport produced the text. Audit only.
    renderMode: text("render_mode").notNull().default("STATIC"),
    // Route authority AS RESOLVED AT ACQUISITION TIME:
    // { officiality, routeClass, matchedPathPrefix }. A snapshot for the
    // both-ends authority rule — it never substitutes for the re-resolve
    // Stage B performs, and Evidence authority itself is still computed
    // by the production path at extraction time.
    authority: jsonb("authority").notNull(),
    acquiringJobId: uuid("acquiring_job_id").references(() => researchJobs.id, {
      onDelete: "set null",
    }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The single permitted mutation: set once when a Stage B run has
    // actually persisted Evidence from this document. A consumed document
    // is refused for further resumes (fail closed); a FAILED Stage B run
    // leaves these null so the document stays resumable.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByJobId: uuid("consumed_by_job_id").references(() => researchJobs.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("ix_acquired_documents_project").on(t.projectId),
    // Size-bounded at rest, matching the transport's own 2MB cap — a row
    // that could not have come from the bounded fetch path cannot exist.
    check(
      "ck_acquired_documents_text_bounded",
      sql`char_length(${t.normalizedText}) <= 2000000`,
    ),
  ],
);
