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
// SCOPED TO THE PROJECT, NOT THE JOB. Job scoping looked safer and was
// unusable: EXECUTION_EVIDENCE is step 4 and DESTINATION is step 6, so the
// component that needs a documented account runs two steps before the one
// that admits it, and a fresh job reached the on-chain path with nothing to
// address. A document stating where a project sends its tokens does not
// stop being true because a different job read it.
//
// The project boundary is the SAME deterministic boundary the rest of the
// engine uses: a locator is reachable only through an Evidence row whose
// research job belongs to this job's project_id. Never a ticker, never a
// name, never a domain — an address admitted while researching another
// project is unreachable here, and a job with no project is refused
// outright rather than falling back to "all locators".
//
// SAME PROJECT IS NOT ENOUGH AUTHORITY. Reuse additionally requires that
// the originating fact was itself admissible documentary evidence:
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
// NOTHING IS COPIED. The historical Evidence row is read, never rewritten,
// never duplicated into this job — the new job addresses the same account
// through the original fact's provenance, which is why a reused locator
// can still be traced to the document that stated it.
//
// THIS IS NOT RESEARCH MEMORY. No lesson, no confidence, no reuse policy
// and no learning writeback: it is one exact identifier, still attached to
// the document that stated it, still validated the same way.
const ADMISSIBLE_LOCATOR_SOURCE_CLASSES = [
  "OFFICIAL_DOCS",
  "GOVERNANCE",
  "OFFICIAL_REPORT",
] as const;

export async function admittedLocatorsForJob(
  db: Database | Transaction,
  jobId: string,
  limit = MAX_ADMITTED_LOCATORS_PER_JOB,
): Promise<ConfirmedLocator[]> {
  if (typeof jobId !== "string" || jobId.length === 0) return [];

  // The project boundary is resolved from the JOB, never passed in — a
  // caller cannot widen the scope by handing over a different project.
  const [job] = await db
    .select({ projectId: researchJobs.projectId })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  // No job, or a job with no project, has no project boundary to enforce.
  // Fail closed rather than returning every locator ever admitted.
  if (!job?.projectId) return [];

  const rows = await db
    .select({
      value: evidenceDocumentaryLocators.value,
      shape: evidenceDocumentaryLocators.shape,
      ordinal: evidenceDocumentaryLocators.ordinal,
    })
    .from(evidenceDocumentaryLocators)
    .innerJoin(evidence, eq(evidence.id, evidenceDocumentaryLocators.evidenceId))
    // INNER joins throughout: an Evidence row whose job or source no longer
    // resolves drops out instead of being reused on trust.
    .innerJoin(researchJobs, eq(researchJobs.id, evidence.researchJobId))
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .where(
      and(
        eq(researchJobs.projectId, job.projectId),
        eq(evidenceDocumentaryLocators.literallyPresent, true),
        eq(evidenceDocumentaryLocators.validationResult, "CONFIRMED"),
        eq(evidence.officiality, "CONFIRMED"),
        inArray(evidence.sourceClass, [...ADMISSIBLE_LOCATOR_SOURCE_CLASSES]),
        ne(sources.health, "BROKEN"),
      ),
    );

  // Deterministic order, and one entry per distinct address: the same
  // account documented by two facts is one subject, not two reads.
  const seen = new Set<string>();
  const out: ConfirmedLocator[] = [];
  for (const r of [...rows].sort((a, b) =>
    a.value === b.value ? a.ordinal - b.ordinal : a.value.localeCompare(b.value),
  )) {
    if (seen.has(r.value)) continue;
    seen.add(r.value);
    out.push({ value: r.value, shape: r.shape as LocatorShape });
    if (out.length >= limit) break;
  }
  return out;
}

// Ceiling on how many documented accounts one job may address. Not a
// research limit — a bound on how much a single document full of addresses
// can cost, before the per-call budget reservation even applies.
export const MAX_ADMITTED_LOCATORS_PER_JOB = 8;
