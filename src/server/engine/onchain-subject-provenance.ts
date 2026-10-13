import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { onchainArtifacts, onchainDerivedSubjects } from "../db/schema";
import { findAdmittedLocator } from "./documentary-locator-store";
import type { OnchainBindingOutcome } from "./onchain-binding";
import type { OnchainArtifact } from "./providers/onchain-types";

// WHY IS THIS EXACT SUBJECT ELIGIBLE FOR THE NEXT STRUCTURED READ?
//
// Two answers, and they are NOT the same authority:
//
//   DOCUMENTARY_LOCATOR      a document the project confirmed as its own
//                            states this identifier. Carries whatever the
//                            document's route carries.
//
//   DERIVED_ONCHAIN_SUBJECT  a previous CONFIRMED structured read returned
//                            this identifier under deterministic checks.
//                            Carries nothing at all beyond "a chain query
//                            produced it, and here is which one".
//
// Keeping them apart is the point. A token account discovered by
// getTokenAccountsByOwner is not documentary evidence — no page states it —
// and reclassifying it as one would launder an RPC result into a claim the
// project made. It is also not arbitrary, which is why it gets its own
// class rather than being refused outright.
//
// WHAT A DERIVED SUBJECT DOES NOT GET: source class, officiality,
// documentary authority, economic role, burn or buyback semantics. There
// is no field on this type able to express any of them. Eligibility to be
// READ is not authority to be BELIEVED.
//
// LINEAGE IS RE-CHECKED, NOT REMEMBERED. A stored row is a claim about the
// past; the gate re-validates both links every time it answers. If the
// parent wallet's documentary evidence is gone, the derived subject stops
// being eligible on the very next call — no invalidation sweep required.

// CLOSED allowlist, code-owned. The database enum constrains what can be
// stored; this constrains what the gate will honour. Two independent
// places, so adding a derivation method is a reviewed change in both.
export const ALLOWED_DERIVATION_METHODS: ReadonlySet<string> = new Set([
  "TOKEN_ACCOUNTS_BY_OWNER",
]);

export type OnchainSubjectClass = "DOCUMENTARY_LOCATOR" | "DERIVED_ONCHAIN_SUBJECT";

export interface DocumentaryLocatorProvenance {
  class: "DOCUMENTARY_LOCATOR";
  subject: string;
  // Which admitted Evidence rows state it, and under whose authority. The
  // authority is the DOCUMENT's, reported here for the caller to print —
  // never something this module computes or confers.
  documents: {
    evidenceId: string;
    retrievedUrl: string;
    summary: string | null;
    sourceClass: string | null;
    officiality: string | null;
  }[];
}

export interface DerivedOnchainSubjectProvenance {
  class: "DERIVED_ONCHAIN_SUBJECT";
  subject: string;
  subjectKind: string;
  parentSubject: string;
  derivationMethod: string;
  onchainArtifactId: string;
  canonicalUri: string;
  observedSlot: number;
  retrievedAt: Date;
  // Deliberately absent: sourceClass, officiality, any economic label.
  // A derived subject has no such fields to carry.
}

export type OnchainSubjectProvenance =
  | DocumentaryLocatorProvenance
  | DerivedOnchainSubjectProvenance;

export type SubjectDenialReason =
  | "NOT_FOUND"
  | "ANCHOR_MISMATCH"
  | "CHAIN_OR_NETWORK_MISMATCH"
  | "BINDING_NOT_CONFIRMED"
  | "DERIVATION_METHOD_NOT_ALLOWED"
  | "PARENT_PROVENANCE_INVALID"
  | "ARTIFACT_INVALID";

export type OnchainSubjectEligibility =
  | { eligible: true; provenance: OnchainSubjectProvenance }
  | { eligible: false; reason: SubjectDenialReason };

export interface SubjectQuery {
  subject: string;
  chain: string;
  network: string;
  projectAnchor: string;
}

// The gate. Documentary provenance is checked first because it is the
// stronger and simpler answer; a subject that is both is reported as
// documentary, since that is the record with more behind it.
//
// EXACT EQUALITY ONLY. Every comparison below is `eq`, on indexed columns.
// There is no LIKE, no prefix match and no normalization step — a partial
// address is a different address, and an address that "looks like" an
// admitted one is not one.
export async function resolveOnchainSubject(
  db: Database | Transaction,
  query: SubjectQuery,
): Promise<OnchainSubjectEligibility> {
  const { subject } = query;
  if (typeof subject !== "string" || subject.length === 0) {
    return { eligible: false, reason: "NOT_FOUND" };
  }

  const documents = await findAdmittedLocator(db, subject);
  if (documents.length > 0) {
    return {
      eligible: true,
      provenance: {
        class: "DOCUMENTARY_LOCATOR",
        subject,
        documents: documents.map((d) => ({
          evidenceId: d.evidenceId,
          retrievedUrl: d.retrievedUrl,
          summary: d.summary,
          sourceClass: d.sourceClass,
          officiality: d.officiality,
        })),
      },
    };
  }

  // Scoped by anchor at the query, so a subject derived under a DIFFERENT
  // project cannot answer here even if the row exists.
  const rows = await db
    .select({
      derived: onchainDerivedSubjects,
      artifactId: onchainArtifacts.id,
      artifactChain: onchainArtifacts.chain,
      artifactNetwork: onchainArtifacts.network,
      artifactAnchor: onchainArtifacts.projectAnchor,
      artifactSubject: onchainArtifacts.subject,
      canonicalUri: onchainArtifacts.canonicalUri,
    })
    .from(onchainDerivedSubjects)
    .innerJoin(onchainArtifacts, eq(onchainArtifacts.id, onchainDerivedSubjects.onchainArtifactId))
    .where(
      and(
        eq(onchainDerivedSubjects.subject, subject),
        eq(onchainDerivedSubjects.projectAnchor, query.projectAnchor),
      ),
    );

  if (rows.length === 0) {
    // Distinguish "no such subject at all" from "exists, wrong anchor", so
    // a denial is diagnosable rather than uniformly blank.
    const anyAnchor = await db
      .select({ id: onchainDerivedSubjects.id })
      .from(onchainDerivedSubjects)
      .where(eq(onchainDerivedSubjects.subject, subject));
    return { eligible: false, reason: anyAnchor.length > 0 ? "ANCHOR_MISMATCH" : "NOT_FOUND" };
  }

  let lastReason: SubjectDenialReason = "NOT_FOUND";
  for (const row of rows) {
    const d = row.derived;
    if (d.chain !== query.chain || d.network !== query.network) {
      lastReason = "CHAIN_OR_NETWORK_MISMATCH";
      continue;
    }
    if (d.bindingStatus !== "CONFIRMED") {
      lastReason = "BINDING_NOT_CONFIRMED";
      continue;
    }
    if (!ALLOWED_DERIVATION_METHODS.has(d.derivationMethod)) {
      lastReason = "DERIVATION_METHOD_NOT_ALLOWED";
      continue;
    }
    // THE ORIGINATING ARTIFACT MUST STILL AGREE. A row pointing at an
    // artifact that describes a different anchor, chain, network or parent
    // subject is not provenance — it is a broken link with a plausible
    // shape.
    const artifactAgrees =
      row.artifactChain === d.chain &&
      row.artifactNetwork === d.network &&
      row.artifactAnchor === d.projectAnchor &&
      row.artifactSubject === d.parentSubject;
    if (!artifactAgrees) {
      lastReason = "ARTIFACT_INVALID";
      continue;
    }
    // THE PARENT MUST STILL BE DOCUMENTED. Re-checked live: this is what
    // keeps the lineage true rather than merely once-true.
    const parentDocs = await findAdmittedLocator(db, d.parentSubject);
    if (parentDocs.length === 0) {
      lastReason = "PARENT_PROVENANCE_INVALID";
      continue;
    }
    return {
      eligible: true,
      provenance: {
        class: "DERIVED_ONCHAIN_SUBJECT",
        subject: d.subject,
        subjectKind: d.subjectKind,
        parentSubject: d.parentSubject,
        derivationMethod: d.derivationMethod,
        onchainArtifactId: row.artifactId,
        canonicalUri: row.canonicalUri,
        observedSlot: d.observedSlot,
        retrievedAt: d.retrievedAt,
      },
    };
  }
  return { eligible: false, reason: lastReason };
}

// ---------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------
//
// Rows are derived FROM THE ARTIFACT'S OWN VALIDATED RESULT. There is no
// parameter here through which a caller could supply an address — not from
// a model, not from a prompt, not from an explorer URL, not by hand. The
// only way a subject reaches this table is by having been returned by a
// confirmed structured read that the adapter already bound.

export interface PersistDerivedSubjectsInput {
  db: Database | Transaction;
  // The artifact row this observation was stored as.
  artifactId: string;
  // The validated artifact it came from.
  artifact: OnchainArtifact;
  // The entity-binding outcome for that artifact.
  binding: OnchainBindingOutcome;
}

export async function persistDerivedOnchainSubjects(
  input: PersistDerivedSubjectsInput,
): Promise<number> {
  const { db, artifactId, artifact, binding } = input;
  // An unbound observation derives nothing. Fail closed.
  if (binding.binding !== "CONFIRMED") return 0;
  const result = artifact.result;
  // Only the allowlisted derivation shape produces subjects. A future
  // intent must be added deliberately, here and in the enum.
  if (result.kind !== "TOKEN_ACCOUNTS_BY_OWNER") return 0;
  if (!ALLOWED_DERIVATION_METHODS.has("TOKEN_ACCOUNTS_BY_OWNER")) return 0;

  const p = artifact.provenance;
  const rows = result.accounts
    // The adapter already checked each account's parsed owner and mint;
    // re-stating the owner check here is cheap and keeps this module
    // independent of that one having been run.
    .filter((a) => a.owner === result.owner && a.mint === result.mint && a.account !== result.owner)
    .map((a) => ({
      onchainArtifactId: artifactId,
      chain: p.chain,
      network: p.network,
      projectAnchor: p.projectAnchor,
      subject: a.account,
      subjectKind: "TOKEN_ACCOUNT" as const,
      parentSubject: result.owner,
      derivationMethod: "TOKEN_ACCOUNTS_BY_OWNER" as const,
      bindingStatus: "CONFIRMED",
      observedSlot: p.slot,
      retrievedAt: p.retrievedAt,
    }));
  if (rows.length === 0) return 0;
  await db.insert(onchainDerivedSubjects).values(rows).onConflictDoNothing();
  return rows.length;
}
