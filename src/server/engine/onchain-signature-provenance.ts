import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { onchainArtifacts, onchainObservedSignatures } from "../db/schema";
import type { OnchainBindingOutcome } from "./onchain-binding";
import { resolveOnchainSubject, type OnchainSubjectClass } from "./onchain-subject-provenance";
import type { OnchainArtifact } from "./providers/onchain-types";

// WHY IS THIS EXACT TRANSACTION SIGNATURE ELIGIBLE FOR getTransaction?
//
// A signature returned by getSignaturesForAddress is NOT a documentary
// locator — no document states it, and recording it as one would let an
// RPC result inherit a project's own authority. It is also not arbitrary:
// a confirmed structured read returned it for a subject that itself had
// provenance. So it gets its own record, exactly like a derived subject,
// and for exactly the same reason.
//
// WHAT IT NEVER ESTABLISHES. That an SPL burn occurred, that a buyback
// happened, which tokens moved or in which direction, what the transaction
// contains, or that supply changed. `err` is the RPC's own metadata about
// whether the transaction failed — it is not a claim about what a
// succeeding transaction DID. `memo` is SELECTION metadata: arbitrary text
// written by whoever signed the transaction, useful for choosing what is
// worth reading, and never evidence of what executed. Nothing on this type
// can express any of those, which is the point.
//
// LINEAGE IS RE-CHECKED, NOT REMEMBERED, the same way derived subjects
// work: a stored row is a claim about the past, so the gate re-validates
// the originating artifact AND the parent subject's own provenance on
// every call. If the parent stops being eligible, so does the signature.

// The only intent whose result may produce observed signatures. Closed and
// code-owned, checked independently of the database's own constraint.
export const SIGNATURE_SOURCE_INTENT = "SIGNATURES_FOR_ADDRESS";

// Complete base58 signature (64 bytes -> 87-88 chars; the range is kept
// slightly wider for the same reason the rest of the codebase does).
const COMPLETE_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export interface ObservedSignatureProvenance {
  class: "OBSERVED_SIGNATURE";
  signature: string;
  // The address whose signatures were listed, and how IT was eligible.
  parentSubject: string;
  parentClass: OnchainSubjectClass;
  onchainArtifactId: string;
  canonicalUri: string;
  slot: number;
  blockTime: Date | null;
  err: boolean;
  memo: string | null;
  observedAt: Date;
  // Deliberately absent: sourceClass, officiality, any economic label, any
  // statement about what the transaction did.
}

export type SignatureDenialReason =
  | "NOT_FOUND"
  | "ANCHOR_MISMATCH"
  | "CHAIN_OR_NETWORK_MISMATCH"
  | "BINDING_NOT_CONFIRMED"
  | "WRONG_ORIGINATING_INTENT"
  | "ARTIFACT_INVALID"
  | "PARENT_PROVENANCE_INVALID";

export type ObservedSignatureEligibility =
  | { eligible: true; provenance: ObservedSignatureProvenance }
  | { eligible: false; reason: SignatureDenialReason };

export interface SignatureQuery {
  signature: string;
  chain: string;
  network: string;
  projectAnchor: string;
}

// The gate a future TRANSACTION_DETAIL read must pass.
//
// EXACT EQUALITY ONLY, on indexed columns. No LIKE, no prefix, no case
// folding — base58 is case-significant, and a signature that merely
// resembles an observed one is a different transaction. A value copied
// from a prompt, a model, an explorer or a console log fails here unless
// it independently exists in this persisted provenance.
export async function resolveObservedSignature(
  db: Database | Transaction,
  query: SignatureQuery,
): Promise<ObservedSignatureEligibility> {
  const { signature } = query;
  if (typeof signature !== "string" || signature.length === 0) {
    return { eligible: false, reason: "NOT_FOUND" };
  }

  const rows = await db
    .select({
      observed: onchainObservedSignatures,
      artifactId: onchainArtifacts.id,
      artifactChain: onchainArtifacts.chain,
      artifactNetwork: onchainArtifacts.network,
      artifactAnchor: onchainArtifacts.projectAnchor,
      artifactSubject: onchainArtifacts.subject,
      artifactIntent: onchainArtifacts.intentKind,
      canonicalUri: onchainArtifacts.canonicalUri,
    })
    .from(onchainObservedSignatures)
    .innerJoin(
      onchainArtifacts,
      eq(onchainArtifacts.id, onchainObservedSignatures.onchainArtifactId),
    )
    .where(
      and(
        eq(onchainObservedSignatures.signature, signature),
        eq(onchainObservedSignatures.projectAnchor, query.projectAnchor),
      ),
    );

  if (rows.length === 0) {
    // Separate "no such signature anywhere" from "exists, wrong anchor", so
    // a denial is diagnosable rather than uniformly blank.
    const anyAnchor = await db
      .select({ id: onchainObservedSignatures.id })
      .from(onchainObservedSignatures)
      .where(eq(onchainObservedSignatures.signature, signature));
    return { eligible: false, reason: anyAnchor.length > 0 ? "ANCHOR_MISMATCH" : "NOT_FOUND" };
  }

  let lastReason: SignatureDenialReason = "NOT_FOUND";
  for (const row of rows) {
    const o = row.observed;
    if (o.chain !== query.chain || o.network !== query.network) {
      lastReason = "CHAIN_OR_NETWORK_MISMATCH";
      continue;
    }
    if (o.bindingStatus !== "CONFIRMED") {
      lastReason = "BINDING_NOT_CONFIRMED";
      continue;
    }
    // A signature may only come from a signature listing. An artifact of
    // any other intent did not observe it in the sense this record claims.
    if (row.artifactIntent !== SIGNATURE_SOURCE_INTENT) {
      lastReason = "WRONG_ORIGINATING_INTENT";
      continue;
    }
    // The originating artifact must still agree on every identity field,
    // including which subject it was listing. A row pointing at an artifact
    // that describes a different anchor or a different parent is a broken
    // link with a plausible shape, not provenance.
    const artifactAgrees =
      row.artifactChain === o.chain &&
      row.artifactNetwork === o.network &&
      row.artifactAnchor === o.projectAnchor &&
      row.artifactSubject === o.parentSubject;
    if (!artifactAgrees) {
      lastReason = "ARTIFACT_INVALID";
      continue;
    }
    // And the parent must STILL be eligible in its own right — documentary
    // or derived. Re-checked live, so the chain stays true rather than
    // merely once-true.
    const parent = await resolveOnchainSubject(db, {
      subject: o.parentSubject,
      chain: o.chain,
      network: o.network,
      projectAnchor: o.projectAnchor,
    });
    if (!parent.eligible) {
      lastReason = "PARENT_PROVENANCE_INVALID";
      continue;
    }
    return {
      eligible: true,
      provenance: {
        class: "OBSERVED_SIGNATURE",
        signature: o.signature,
        parentSubject: o.parentSubject,
        parentClass: parent.provenance.class,
        onchainArtifactId: row.artifactId,
        canonicalUri: row.canonicalUri,
        slot: o.slot,
        blockTime: o.blockTime,
        err: o.err,
        memo: o.memo,
        observedAt: o.observedAt,
      },
    };
  }
  return { eligible: false, reason: lastReason };
}

// ---------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------
//
// Rows come FROM THE ARTIFACT'S OWN VALIDATED RESULT. There is no
// parameter here through which a caller could supply a signature — not
// from a model, not from a prompt, not from an explorer, not by hand. The
// only way a signature reaches this table is by having been returned by a
// confirmed SIGNATURES_FOR_ADDRESS read.

export interface PersistObservedSignaturesInput {
  db: Database | Transaction;
  artifactId: string;
  artifact: OnchainArtifact;
  binding: OnchainBindingOutcome;
}

export async function persistObservedSignatures(
  input: PersistObservedSignaturesInput,
): Promise<number> {
  const { db, artifactId, artifact, binding } = input;
  // An unbound observation observes nothing durable. Fail closed.
  if (binding.binding !== "CONFIRMED") return 0;
  const result = artifact.result;
  if (result.kind !== SIGNATURE_SOURCE_INTENT) return 0;

  const p = artifact.provenance;
  const seen = new Set<string>();
  const rows = result.signatures
    // A malformed or truncated value is dropped, never repaired. The
    // database CHECK is the second line; refusing here means a bad entry
    // costs nothing rather than failing the whole batch.
    .filter((s) => {
      if (typeof s.signature !== "string" || !COMPLETE_SIGNATURE.test(s.signature)) return false;
      if (seen.has(s.signature)) return false;
      seen.add(s.signature);
      return true;
    })
    .map((s) => ({
      onchainArtifactId: artifactId,
      chain: p.chain,
      network: p.network,
      projectAnchor: p.projectAnchor,
      parentSubject: result.address,
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime === null ? null : new Date(s.blockTime * 1000),
      err: s.err,
      memo: s.memo,
      bindingStatus: "CONFIRMED",
      observedAt: p.retrievedAt,
    }));
  if (rows.length === 0) return 0;
  await db.insert(onchainObservedSignatures).values(rows).onConflictDoNothing();
  return rows.length;
}

// Every observed signature for one artifact, newest slot first.
export async function signaturesForArtifact(
  db: Database | Transaction,
  artifactId: string,
): Promise<
  { signature: string; slot: number; blockTime: Date | null; err: boolean; memo: string | null }[]
> {
  const rows = await db
    .select({
      signature: onchainObservedSignatures.signature,
      slot: onchainObservedSignatures.slot,
      blockTime: onchainObservedSignatures.blockTime,
      err: onchainObservedSignatures.err,
      memo: onchainObservedSignatures.memo,
    })
    .from(onchainObservedSignatures)
    .where(eq(onchainObservedSignatures.onchainArtifactId, artifactId));
  return rows.sort((a, b) => b.slot - a.slot);
}
