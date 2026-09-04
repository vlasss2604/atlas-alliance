import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { auditProjectionStatus, questionProjectionStatus } from "./enums";
import { researchJobs } from "./research";

// QUESTION-DRIVEN PROOF PROJECTION — a DERIVED PRESENTATION ARTIFACT.
//
// Its own table, deliberately, and NOT a field on `proofs`. The Proof is
// the canonical research answer; this decides which of that answer's parts
// are relevant to the question a person actually asked, in what order, and
// under what wording. Storing presentation inside the Proof would make a
// model's relevance judgment part of the canonical artifact — the second
// truth layer this whole design exists to avoid.
//
// The same reasoning rules out every engine-owned derived table
// (research_component_results, research_mechanism_assembly,
// research_claim_support). Each of those carries a replay contract: delete
// the rows, re-run from the same inputs, get the same result. A projection
// involves a model call and cannot honour that contract, so it must not
// share a table with artifacts that do.
//
// WHAT IS AND IS NOT IN `findings`.
//
// Only REFERENCES and LABELS. Every finding names a canonical object that
// already carries a status — a component result key, or an S7 requirement
// id — plus a short user-facing label. No status, no fact, no evidence id,
// no reason code is stored here, because none of those may originate from
// a model. The reader's status, explanation and evidence are all resolved
// at render time from the canonical row the reference points at, which is
// what keeps this artifact incapable of contradicting research.
//
// Because the references are canonical ids and nothing else, a stale
// projection degrades safely: a reference that no longer resolves is
// dropped, not guessed at.
export const researchQuestionProjections = pgTable(
  "research_question_projections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    // Bumped by a human when the projection contract changes. It is part
    // of the uniqueness key, so bumping it is what authorises exactly one
    // fresh model call per job — never a retry loop, never a read path.
    projectionVersion: integer("projection_version").notNull(),
    // The Pattern the canonical results were produced under. Recorded so a
    // projection can be recognised as belonging to a superseded research
    // shape rather than silently rendered against a newer one.
    patternVersion: integer("pattern_version").notNull(),
    status: questionProjectionStatus("status").notNull(),
    // VALID: the validated findings. Either failure: an empty array. A
    // failed projection stores no partial findings — half a relevance
    // judgment is not a safer relevance judgment.
    findings: jsonb("findings").notNull().default(sql`'[]'::jsonb`),
    // Model id, token usage and the cost computed from the approved
    // catalogue, plus a closed failure code on the failure paths. AUDIT
    // ONLY — nothing here is ever read back as research input, and no
    // provider text is stored.
    modelMeta: jsonb("model_meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // ONE ROW PER (job, projection version) — the structural guarantee
    // behind "one model call per Proof". A terminal failure occupies this
    // slot exactly as a success does, which is what stops a failed
    // projection from being retried on every subsequent read.
    uniqueIndex("uq_research_question_projections_job_version").on(
      t.researchJobId,
      t.projectionVersion,
    ),
    index("ix_research_question_projections_job").on(t.researchJobId),
  ],
);

// FULL RESEARCH AUDIT PROJECTION — a second DERIVED PRESENTATION artifact,
// and deliberately its own table rather than a status on the one above.
//
// The two projections answer different questions and have different
// lifecycles. A question projection is generated once, after research,
// for every Proof. An audit is generated only if a human ever asks for
// one — most Proofs will never have a row here at all — so folding it into
// the question projection's row would mean either generating an audit
// nobody asked for or leaving a half-populated row behind.
//
// The canon rule is unchanged and is what matters most: this is NOT
// allowed inside `proofs`, `research_claim_support`,
// `research_component_results` or any other engine-owned artifact. Those
// carry a replay contract — delete the rows, re-run from the same inputs,
// reproduce the same result — and anything involving a model call cannot
// honour it.
//
// WHAT `content` MAY CONTAIN: an ORDER, short human LABELS for canonical
// component references, and two or three sentences of connective copy.
// No status, no count, no evidence id, no reason code — the audit's every
// fact is assembled at render time from canonical rows, so a stale or
// failed projection costs the audit its arrangement and none of its
// substance.
export const researchAuditProjections = pgTable(
  "research_audit_projections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    researchJobId: uuid("research_job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    // Bumped by a human when the audit contract changes — the only thing
    // that authorises a fresh model call for a job that already has one.
    auditVersion: integer("audit_version").notNull(),
    status: auditProjectionStatus("status").notNull(),
    content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
    // Model id, real token usage and the cost computed from the approved
    // catalogue, plus a closed failure code. AUDIT ONLY — never read back
    // as research input, never carrying provider text.
    modelMeta: jsonb("model_meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // ONE ROW PER (job, audit version). A terminal failure occupies the
    // slot exactly as a success does, so re-opening a failed audit reads
    // the failure rather than retrying the model.
    uniqueIndex("uq_research_audit_projections_job_version").on(
      t.researchJobId,
      t.auditVersion,
    ),
    index("ix_research_audit_projections_job").on(t.researchJobId),
  ],
);
