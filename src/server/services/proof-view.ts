import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { evidence, proofs, sources } from "../db/schema";
import { bandOfScore, CONFIDENCE_SCORES, type ConfidenceBand, type ConfidenceScore } from "../engine/proof-confidence";

// Phase 6, S9 — THE PRODUCT BOUNDARY.
//
// ATLAS CORE PRODUCES THE PROOF; CLIENTS RENDER THE PROOF. This module is
// the one canonical projection from persisted S8 state into a client-safe
// shape, so no route has to assemble its own and two representations
// cannot drift apart. Any future route — a dedicated Proof resource, an
// external API, another client — calls this and nothing else.
//
// S9 READS S8. It recomputes nothing: not the verdict, not the
// confidence, not the layers, not the citation set. Every field below is
// copied from a persisted row, and the module imports no provider, no
// network client and no engine stage. If a value is wrong here, it was
// wrong in the database.
//
// PLATFORM INDEPENDENT (D-125). No Telegram field, no markdown, no
// formatting, no presentation logic — the layers are carried exactly as
// S8 wrote them. A DTO that knew about a client would make Telegram the
// product instead of the first interface.
//
// WHAT IS DELIBERATELY ABSENT: S5 component rows, S6 assembly, S7 claim
// support, exclusion plumbing and ResultReasonCode internals. They are
// not deleted — they stay in the database and in the engine, where the
// reasoning lives — but a client never has to consume them to read a
// Proof. That is the whole point of the boundary.

export interface ProofConfidenceView {
  // The SEMANTIC value (D-135). Null only when the stored encoding is not
  // one of the four bands — see the decoding note in toConfidenceView.
  band: ConfidenceBand | null;
  // The database/API ENCODING of the band. NEVER a percentage and never a
  // probability; nothing may render it with a "%" or interpolate it.
  score: number;
}

// The smallest projection of one cited Evidence row that lets a reader
// inspect what the Proof rests on. Everything here is already-admitted,
// already-structured research output.
//
// NOT EXPOSED, by omission rather than by filtering: raw model output,
// raw source bodies, provider identifiers or secrets, internal error
// text, stack traces, acquisition metadata (content hashes, fetch
// mechanics, trace rows), and the on-chain artifact payload. SOURCE !=
// EVIDENCE != FACT != PROOF CLAIM: the source is named only by its
// public title/publisher/type and the url that was retrieved.
export interface ProofCitationView {
  evidenceId: string;
  // Nullable because the columns are: the DTO reflects what the row
  // actually holds rather than coercing a missing value into a number or
  // an empty string, which would invent structure the Evidence lacks.
  patternStep: number | null;
  component: string | null;
  relationship: string;
  directness: string | null;
  summary: string | null;
  fragment: string;
  doesNotProve: string | null;
  mechanismState: string | null;
  sourceClass: string | null;
  officiality: string | null;
  entityBinding: string | null;
  publishedAt: string | null;
  retrievedUrl: string;
  fetchedAt: string;
  source: {
    title: string | null;
    publisher: string | null;
    sourceType: string;
  };
}

export interface ProofView {
  proofId: string;
  researchJobId: string;
  projectId: string;
  topicId: string;
  verdict: string;
  confidence: ProofConfidenceView;
  // The real persisted field, copied exactly. NEVER inferred from
  // confidence, verdict or citation count — verification is a human act
  // (D-041/D-055) and confidence is a structural indicator; conflating
  // them would let a machine mark its own work verified.
  verificationStatus: string;
  visibility: string;
  // Exactly what S8 wrote. Not regenerated, not reformatted, not
  // reinterpreted.
  layers: unknown;
  citations: ProofCitationView[];
  researchCutoff: string | null;
  createdAt: string;
}

const BAND_ENCODINGS: ReadonlySet<number> = new Set<number>(CONFIDENCE_SCORES);

// DECODING, not computing. The column stores the band's encoding, so the
// band is read back from it — but the CHECK constraint admits any 0..100
// integer, and rows written before D-135 (or by hand in a test fixture)
// can hold a value outside the four encodings. Such a row is reported
// with `band: null` and its raw score, never with a guessed or rounded
// band: inventing one would be inventing confidence, which is exactly
// what D-081/D-110/D-135 forbid. Fail closed, stay honest.
function toConfidenceView(score: number): ProofConfidenceView {
  if (!BAND_ENCODINGS.has(score)) return { band: null, score };
  return { band: bandOfScore(score as ConfidenceScore), score };
}

function iso(v: Date | null): string | null {
  return v === null ? null : v.toISOString();
}

// Reads the Proof for ONE research job, scoped to ONE owner.
//
// OWNERSHIP IS A QUERY PREDICATE, not a post-hoc check: the Proof is
// selected `WHERE researchJobId = … AND ownerUserId = …`, so another
// user's private Proof is not merely hidden from the response — it is
// never loaded. Proof is PRIVATE by default and there are no public Proof
// URLs in v1, so a caller who is not the owner gets the same `null` as a
// caller whose job has no Proof yet, and can distinguish neither.
//
// READ ONLY. No insert, no update, no transaction: a GET must never
// create a Proof, and this function has no code path that could.
export async function loadProofForJob(
  db: Database,
  researchJobId: string,
  ownerUserId: string,
): Promise<ProofView | null> {
  const [row] = await db
    .select({
      id: proofs.id,
      researchJobId: proofs.researchJobId,
      projectId: proofs.projectId,
      topicId: proofs.topicId,
      verdict: proofs.verdict,
      confidence: proofs.confidence,
      verificationStatus: proofs.verificationStatus,
      visibility: proofs.visibility,
      layers: proofs.layers,
      researchCutoff: proofs.researchCutoff,
      createdAt: proofs.createdAt,
    })
    .from(proofs)
    .where(and(eq(proofs.researchJobId, researchJobId), eq(proofs.ownerUserId, ownerUserId)));
  // NO PROOF IS EVER FABRICATED. A job that finished without one, a job
  // still running, and a job belonging to someone else all return null;
  // the caller decides what that means in its own vocabulary.
  if (!row) return null;

  // CITATIONS COME FROM THE BINDING, never from job membership. Only rows
  // S8 actually bound (`evidence.proof_id`) appear — excluded evidence,
  // context evidence and rows belonging to another component are absent
  // because they carry no binding, not because a filter dropped them.
  // The composite FK already guarantees a bound row belongs to this
  // Proof's own job.
  const cited = await db
    .select({
      id: evidence.id,
      patternStep: evidence.patternStep,
      component: evidence.component,
      relationship: evidence.relationship,
      directness: evidence.directness,
      summary: evidence.summary,
      fragment: evidence.fragment,
      doesNotProve: evidence.doesNotProve,
      mechanismState: evidence.mechanismState,
      sourceClass: evidence.sourceClass,
      officiality: evidence.officiality,
      entityBinding: evidence.entityBinding,
      publishedAt: evidence.publishedAt,
      retrievedUrl: evidence.retrievedUrl,
      fetchedAt: evidence.fetchedAt,
      sourceTitle: sources.title,
      sourcePublisher: sources.publisher,
      sourceType: sources.sourceType,
    })
    .from(evidence)
    .innerJoin(sources, eq(evidence.sourceId, sources.id))
    .where(eq(evidence.proofId, row.id))
    .orderBy(evidence.patternStep, evidence.createdAt);

  return {
    proofId: row.id,
    researchJobId: row.researchJobId,
    projectId: row.projectId,
    topicId: row.topicId,
    verdict: row.verdict,
    confidence: toConfidenceView(row.confidence),
    verificationStatus: row.verificationStatus,
    visibility: row.visibility,
    layers: row.layers,
    citations: cited.map((c) => ({
      evidenceId: c.id,
      patternStep: c.patternStep,
      component: c.component,
      relationship: c.relationship,
      directness: c.directness,
      summary: c.summary,
      fragment: c.fragment,
      doesNotProve: c.doesNotProve,
      mechanismState: c.mechanismState,
      sourceClass: c.sourceClass,
      officiality: c.officiality,
      entityBinding: c.entityBinding,
      publishedAt: iso(c.publishedAt),
      retrievedUrl: c.retrievedUrl,
      fetchedAt: c.fetchedAt.toISOString(),
      source: {
        title: c.sourceTitle,
        publisher: c.sourcePublisher,
        sourceType: c.sourceType,
      },
    })),
    researchCutoff: iso(row.researchCutoff),
    createdAt: row.createdAt.toISOString(),
  };
}
