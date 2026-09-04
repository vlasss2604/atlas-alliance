import { and, eq, inArray, ne, or } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import {
  evidence,
  evidenceDocumentaryLocators,
  researchJobs,
  sources,
} from "../db/schema";
import {
  validateDocumentaryLocator,
  type DocumentaryLocatorOutcome,
  type LocatorRejection,
  type LocatorShape,
} from "./documentary-locator";

// ONE FACT, MANY LOCATORS — validation and persistence.
//
// A single admitted documentary fact can identify more than one concrete
// on-chain account. A page listing two burn addresses under one heading
// states one fact about two accounts, and the scalar column forced a
// choice between them.
//
// EVERY LOCATOR IS VALIDATED INDEPENDENTLY. That is the property this
// module exists to guarantee, and it cuts both ways:
//
//   * one bad locator never contaminates a good one — a fact proposing a
//     valid address and a truncated one keeps the valid address;
//   * one good locator never launders a bad one — passing validation is
//     per-value, so a confirmed neighbour confers nothing.
//
// AND A BAD LOCATOR NEVER COSTS THE FACT. Rejections are reported for
// tracing; the caller still admits the Evidence row. "The page says
// tokens go to an address it displays as 99mRw3…pm4F3c" is true and
// useful documentary evidence that happens to locate nothing.
//
// The model has no path around any of this: it proposes strings, and only
// values this module's validator confirmed are ever written.

export interface ConfirmedLocator {
  value: string;
  shape: LocatorShape;
}

// WHAT AN ADMITTED LOCATOR CARRIES BACK.
//
// `ConfirmedLocator` is the validator's verdict about a string and stays
// exactly that — every existing producer and consumer of it is unchanged.
// An ADMITTED locator is a different claim: this job may address this
// account, BECAUSE of this Evidence row, read from this source, in this
// job. Those three ids are what makes the subject attributable, and the
// only reason they can be stated flatly is that the boundary is now the
// job — there is no historical case left to distinguish.
export interface AdmittedLocator extends ConfirmedLocator {
  evidenceId: string;
  sourceId: string;
  researchJobId: string;
}

export interface RejectedLocator {
  // The proposal, kept for tracing. Never written to the locator table.
  claimed: string;
  reason: Exclude<LocatorRejection, "NOT_CLAIMED">;
}

export interface LocatorValidationOutcome {
  confirmed: ConfirmedLocator[];
  rejected: RejectedLocator[];
}

// Ceiling on how many locators one fact may carry. Not a research limit —
// a bound on untrusted model output, so a single fact cannot be used to
// insert an unbounded number of rows.
export const MAX_LOCATORS_PER_FACT = 10;

// Validates every proposal a fact makes, in order, independently.
//
// Duplicates collapse to the first occurrence rather than erroring: a
// model naming the same account twice in one fact has said one thing
// twice, which is not a defect and not two locators.
export function validateFactLocators(input: {
  claimed: readonly (string | null | undefined)[];
  documentText: string;
}): LocatorValidationOutcome {
  const confirmed: ConfirmedLocator[] = [];
  const rejected: RejectedLocator[] = [];
  const seen = new Set<string>();

  for (const claimed of input.claimed) {
    if (confirmed.length >= MAX_LOCATORS_PER_FACT) break;
    const outcome: DocumentaryLocatorOutcome = validateDocumentaryLocator({
      claimedLocator: claimed,
      documentText: input.documentText,
    });
    if (outcome.locator === "CONFIRMED") {
      if (seen.has(outcome.value)) continue;
      seen.add(outcome.value);
      confirmed.push({ value: outcome.value, shape: outcome.shape });
      continue;
    }
    // A fact that simply claims nothing is the ordinary case, not a
    // rejection worth recording.
    if (outcome.reason === "NOT_CLAIMED") continue;
    rejected.push({ claimed: String(claimed ?? ""), reason: outcome.reason });
  }
  return { confirmed, rejected };
}

// Writes the validated locators for one Evidence row.
//
// Takes ConfirmedLocator values only — there is deliberately no parameter
// through which an unvalidated string could arrive, so "persist without
// validating" is not an available mistake. The database's own CHECKs are
// the second line: an incomplete shape or an unconfirmed row cannot exist
// at rest even if a future caller reaches the table directly.
export async function persistFactLocators(
  db: Database | Transaction,
  evidenceId: string,
  locators: readonly ConfirmedLocator[],
): Promise<number> {
  if (locators.length === 0) return 0;
  const rows = locators.slice(0, MAX_LOCATORS_PER_FACT).map((l, ordinal) => ({
    evidenceId,
    ordinal,
    value: l.value,
    shape: l.shape,
    literallyPresent: true,
    validationResult: "CONFIRMED",
  }));
  await db
    .insert(evidenceDocumentaryLocators)
    .values(rows)
    // At-least-once replay of the same extraction unit is a no-op, matching
    // the Evidence insert's own idempotency rather than inventing a second
    // discipline.
    .onConflictDoNothing();
  return rows.length;
}

export interface AdmittedLocatorRow {
  evidenceId: string;
  value: string;
  shape: LocatorShape | null;
  retrievedUrl: string;
  contentHash: string;
  summary: string | null;
  sourceClass: string | null;
  officiality: string | null;
}

// THE ON-CHAIN PROVENANCE GATE'S QUESTION: is THIS exact address an
// admitted documentary locator, and which document states it?
//
// Matches the normalized table AND the legacy scalar column, so historical
// rows written before the one-to-many model are answerable through the
// same call and no caller needs a second code path. Equality only — never
// a LIKE or a substring, which over identifiers would admit an address
// nobody documented.
//
// Returns the parent Evidence row's authority fields alongside each match,
// because the authority is the DOCUMENT's: it comes from the confirmed
// source route on the Evidence row, never from the locator and never from
// the external link the identifier was recovered from.
export async function findAdmittedLocator(
  db: Database | Transaction,
  value: string,
): Promise<AdmittedLocatorRow[]> {
  if (typeof value !== "string" || value.length === 0) return [];
  const rows = await db
    .select({
      evidenceId: evidence.id,
      locatorValue: evidenceDocumentaryLocators.value,
      shape: evidenceDocumentaryLocators.shape,
      scalar: evidence.documentaryLocator,
      retrievedUrl: evidence.retrievedUrl,
      contentHash: evidence.contentHash,
      summary: evidence.summary,
      sourceClass: evidence.sourceClass,
      officiality: evidence.officiality,
    })
    .from(evidence)
    .leftJoin(
      evidenceDocumentaryLocators,
      eq(evidenceDocumentaryLocators.evidenceId, evidence.id),
    )
    .where(
      or(eq(evidenceDocumentaryLocators.value, value), eq(evidence.documentaryLocator, value)),
    );

  const byEvidence = new Map<string, AdmittedLocatorRow>();
  for (const row of rows) {
    // The join can produce one row per locator on a multi-locator fact;
    // only the ones matching THIS value are the answer.
    const matched = row.locatorValue === value ? row.locatorValue : row.scalar === value ? row.scalar : null;
    if (matched === null) continue;
    if (byEvidence.has(row.evidenceId)) continue;
    byEvidence.set(row.evidenceId, {
      evidenceId: row.evidenceId,
      value: matched,
      shape: row.locatorValue === value ? (row.shape as LocatorShape) : null,
      retrievedUrl: row.retrievedUrl,
      contentHash: row.contentHash,
      summary: row.summary,
      sourceClass: row.sourceClass,
      officiality: row.officiality,
    });
  }
  return [...byEvidence.values()];
}

// Every admitted locator for one Evidence row, in ordinal order.
export async function locatorsForEvidence(
  db: Database | Transaction,
  evidenceId: string,
): Promise<ConfirmedLocator[]> {
  const rows = await db
    .select({
      value: evidenceDocumentaryLocators.value,
      shape: evidenceDocumentaryLocators.shape,
      ordinal: evidenceDocumentaryLocators.ordinal,
    })
    .from(evidenceDocumentaryLocators)
    .where(eq(evidenceDocumentaryLocators.evidenceId, evidenceId));
  return rows
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => ({ value: r.value, shape: r.shape as LocatorShape }));
}

// EVERY ADMITTED DOCUMENTARY LOCATOR THIS JOB MAY ADDRESS.
//
// The gate that made structured on-chain research unreachable in
// production: acquisition accepted a `locators` parameter and nothing ever
// filled it, so the only subject a normal research job could address was
// the project's own mint. This is the query that fills it.
//
// SCOPED TO THE JOB. An earlier round scoped this to the PROJECT, so a
// fresh job silently consumed an address a previous job had established.
// That is reuse of a research conclusion, and it was made without the
// things reuse requires: no freshness bound, no revalidation, no
// revocation act, and — because the returned value carried no provenance —
// no way for a Proof to say whether an address was established in THIS run
// or inherited from an old one. A fresh Proof could plan account-level
// reads against a historical locator while presenting as if it had found
// it. Until an explicit Research Memory design supplies provenance,
// freshness, revalidation, revocation and transparent historical reuse,
// the honest boundary is the job.
//
// The ordering cost is REAL and is accepted deliberately: EXECUTION_EVIDENCE
// is pattern step 4 and DESTINATION is step 6, so a fresh job reaches the
// account-kind components before the component that documents an account.
// The outcome is then no subject, which is an ordinary acquisition boundary
// and an honest INSUFFICIENT_EVIDENCE — never a fallback, and never a claim
// that a mechanism is absent.
//
// CONFIRMED PROJECT IDENTITY IS A DIFFERENT THING AND IS UNTOUCHED. A
// canonical mint/address stored as confirmed identity keeps its existing
// semantics and still supplies the anchor for token-level reads
// (`eligibleSubjects` in onchain-acquisition.ts). Identity is a stored fact
// about what the project IS; a documentary locator is a research
// conclusion about where a mechanism runs. Only the second is bounded here.
//
// THE SAME JOB IS NOT ENOUGH AUTHORITY. Admission additionally requires
// that the originating fact was itself admissible documentary evidence,
// and not one of these bars is relaxed by the narrower boundary:
//
//   * validation_result = CONFIRMED and literally_present = true — the
//     deterministic validator's own verdict, restated here so the
//     guarantee survives someone loosening the schema CHECK;
//   * officiality = CONFIRMED — a CLAIMED or UNVERIFIED source may state
//     an address, and that is a claim about an address, not a locator;
//   * a documentary source class — SOCIAL, NEWS, RESEARCH_MEDIA and
//     DATA_PROVIDER never independently establish anything, so they never
//     hand the on-chain path a subject either;
//   * the source row still resolves and is not BROKEN — provenance that
//     cannot be re-checked is provenance that cannot be relied on.
//
// Every one of those is an AND. Anything unresolvable fails closed: the
// locator is simply not returned, and research continues without it.
//
// The scalar `documentary_locator` column is deliberately NOT read here.
// Migration 0028 backfilled every scalar into this table as ordinal 0, so
// the child rows are complete and reading both would return historical
// rows twice.
//
// NOTHING IS COPIED AND NOTHING IS ADOPTED. The Evidence row is read, never
// rewritten; no standalone observation, no owner-script artifact, no model
// proposal and no address parsed out of arbitrary text can reach this
// result — the ONLY path in is a validated locator row on this job's own
// admitted Evidence.
//
// THIS IS NOT RESEARCH MEMORY, and narrowing the boundary is what keeps
// that true: no lesson, no confidence, no reuse policy, no freshness
// window and no learning writeback. One exact identifier, still attached to
// the document THIS job read, still validated the same way.
const ADMISSIBLE_LOCATOR_SOURCE_CLASSES = [
  "OFFICIAL_DOCS",
  "GOVERNANCE",
  "OFFICIAL_REPORT",
] as const;

export async function admittedLocatorsForJob(
  db: Database | Transaction,
  jobId: string,
  limit = MAX_ADMITTED_LOCATORS_PER_JOB,
): Promise<AdmittedLocator[]> {
  if (typeof jobId !== "string" || jobId.length === 0) return [];

  const rows = await db
    .select({
      value: evidenceDocumentaryLocators.value,
      shape: evidenceDocumentaryLocators.shape,
      ordinal: evidenceDocumentaryLocators.ordinal,
      evidenceId: evidence.id,
      sourceId: sources.id,
      researchJobId: researchJobs.id,
    })
    .from(evidenceDocumentaryLocators)
    .innerJoin(evidence, eq(evidence.id, evidenceDocumentaryLocators.evidenceId))
    // INNER joins throughout: an Evidence row whose job or source no longer
    // resolves drops out instead of being addressed on trust.
    .innerJoin(researchJobs, eq(researchJobs.id, evidence.researchJobId))
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .where(
      and(
        // THE BOUNDARY. Stated on the Evidence row's own job, so it is the
        // narrowest possible predicate: this job's own admitted Evidence,
        // and nothing else. A project-scoped variant of this line is what
        // let a fresh Proof inherit an old run's address. Cross-project is
        // then impossible by construction — a job has exactly one project —
        // rather than by a second predicate that would imply the project
        // still means something here.
        eq(researchJobs.id, jobId),
        eq(evidenceDocumentaryLocators.literallyPresent, true),
        eq(evidenceDocumentaryLocators.validationResult, "CONFIRMED"),
        eq(evidence.officiality, "CONFIRMED"),
        inArray(evidence.sourceClass, [...ADMISSIBLE_LOCATOR_SOURCE_CLASSES]),
        ne(sources.health, "BROKEN"),
      ),
    );

  // Deterministic order, and one entry per distinct address: the same
  // account documented by two facts is one subject, not two reads. The
  // FIRST row for an address wins, so the surviving provenance is a real
  // Evidence row that established it, chosen the same way every time.
  const seen = new Set<string>();
  const out: AdmittedLocator[] = [];
  for (const r of [...rows].sort((a, b) => {
    if (a.value !== b.value) return a.value.localeCompare(b.value);
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    // Two Evidence rows can document the same account at the same ordinal.
    // Once provenance is returned, "which one" stops being cosmetic, so the
    // tie is broken on the evidence id rather than left to row order.
    return a.evidenceId.localeCompare(b.evidenceId);
  })) {
    if (seen.has(r.value)) continue;
    seen.add(r.value);
    out.push({
      value: r.value,
      shape: r.shape as LocatorShape,
      evidenceId: r.evidenceId,
      sourceId: r.sourceId,
      researchJobId: r.researchJobId,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Ceiling on how many documented accounts one job may address. Not a
// research limit — a bound on how much a single document full of addresses
// can cost, before the per-call budget reservation even applies.
export const MAX_ADMITTED_LOCATORS_PER_JOB = 8;
