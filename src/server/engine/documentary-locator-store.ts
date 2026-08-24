import { eq, or } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, evidenceDocumentaryLocators } from "../db/schema";
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
