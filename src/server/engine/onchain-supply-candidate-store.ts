import { and, desc, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, onchainArtifacts } from "../db/schema";
import type { PersistedObservation } from "./onchain-event-anchored-supply-interval";
import { buildCanonicalOnchainUri } from "./onchain-uri";
import { brandOnchainArtifact } from "./providers/onchain-types";
import type {
  BurnInstructionRef,
  OnchainArtifact,
  OnchainChain,
  OnchainIntent,
  OnchainNetwork,
  TransactionDetailResult,
} from "./providers/onchain-types";
import type { AnchorBurnEvent } from "./onchain-event-anchored-supply-interval";

// HISTORICAL t0 CANDIDATE RETRIEVAL — rows, never a winner.
//
// The one database read the current-proof gate needs, and it is deliberately
// the dumbest thing that could work: a bounded set of PRIOR Research
// total-supply readings of the SAME token, positioned before the event.
// Whether any of them may serve as t0, and which one does, are B2b2's
// questions and are asked over the rows this returns.
//
// WHAT BOUNDS IT, AND WHY EACH BOUND IS RETRIEVAL RATHER THAN SEMANTICS:
//
//   canonical URI    chain, network, anchor, subject kind, subject and
//                    intent in one indexed value. Not a semantic filter —
//                    an observation of a different token or a different
//                    intent is not a candidate at all, it is another row.
//   slot < event     the only positions that could precede the event. A row
//                    after it can never be t0 under any policy.
//   RESEARCH_JOB     standalone owner-script observations are excluded at
//                    the query, matching the product policy B2b2 enforces
//                    again over what comes back. Belt and braces on purpose:
//                    a standalone row must not travel this far.
//   not this job     t0 must come from a PRIOR Research.
//
// It never orders by value, never aggregates, never picks a "best", and
// returns every row it retrieved. The one ordering it applies is by slot
// descending, which is a retrieval bound rather than a choice: the selector
// takes the GREATEST eligible slot before the event, so a limit applied to
// the newest rows cannot remove the row it would have picked.
//
// NO NEW INDEX AND NO SCHEMA CHANGE. `ix_onchain_artifacts_uri` already
// covers the canonical URI predicate.

// A generous bound, not a tuning knob. It exists so an unusually long
// research history cannot turn one gate decision into an unbounded read.
export const MAX_HISTORICAL_SUPPLY_CANDIDATES = 200;

export interface HistoricalSupplyCandidateQuery {
  // The Research asking. Its own readings are never t0.
  currentResearchJobId: string;
  // The project's CURRENTLY ACTIVE token address, resolved by the caller.
  projectAnchor: string;
  chain: OnchainChain;
  network: OnchainNetwork;
  // The deterministic event's slot. Strictly before, never at.
  beforeSlot: number;
  limit?: number;
}

interface SupplyRow {
  mint: unknown;
  amountRaw: unknown;
  decimals: unknown;
}

// Reconstruction hygiene, not selection: a row whose stored result is not a
// well-formed total-supply reading cannot be turned back into an artifact at
// all, so it is not returned. Everything about whether a well-formed one is
// USABLE stays with B2a and B2b2.
function readSupplyResult(
  normalized: unknown,
): { mint: string; amountRaw: string; decimals: number } | null {
  if (typeof normalized !== "object" || normalized === null) return null;
  const row = normalized as SupplyRow & { kind?: unknown };
  if (row.kind !== "TOKEN_SUPPLY") return null;
  if (typeof row.mint !== "string" || row.mint.length === 0) return null;
  if (typeof row.amountRaw !== "string" || row.amountRaw.length === 0) return null;
  if (typeof row.decimals !== "number" || !Number.isInteger(row.decimals)) return null;
  return { mint: row.mint, amountRaw: row.amountRaw, decimals: row.decimals };
}

export async function loadHistoricalSupplyCandidates(
  db: Database | Transaction,
  query: HistoricalSupplyCandidateQuery,
): Promise<PersistedObservation[]> {
  const canonicalUri = buildCanonicalOnchainUri({
    kind: "TOKEN_SUPPLY",
    chain: query.chain,
    network: query.network,
    projectAnchor: query.projectAnchor,
    subjectKind: "token",
    subject: query.projectAnchor,
  });

  const rows = await db
    .select()
    .from(onchainArtifacts)
    .where(
      and(
        eq(onchainArtifacts.canonicalUri, canonicalUri),
        lt(onchainArtifacts.slot, query.beforeSlot),
        eq(onchainArtifacts.originKind, "RESEARCH_JOB"),
        isNotNull(onchainArtifacts.researchJobId),
        ne(onchainArtifacts.researchJobId, query.currentResearchJobId),
      ),
    )
    .orderBy(desc(onchainArtifacts.slot))
    .limit(Math.max(1, query.limit ?? MAX_HISTORICAL_SUPPLY_CANDIDATES));

  const out: PersistedObservation[] = [];
  for (const row of rows) {
    const result = readSupplyResult(row.normalizedResult);
    if (result === null) continue;
    const intent = {
      kind: "TOKEN_SUPPLY" as const,
      chain: row.chain as OnchainChain,
      network: row.network as OnchainNetwork,
      projectAnchor: row.projectAnchor,
      subjectKind: "token" as const,
      subject: row.subject,
    };
    const supply = { kind: "TOKEN_SUPPLY" as const, ...result };
    out.push({
      // The row is what the retriever path wrote; rebuilding the in-process
      // artifact from it is transport, not trust. Every rule that decides
      // whether it may be used still runs afterwards, over this object.
      artifact: brandOnchainArtifact({
        intent,
        canonicalUri: row.canonicalUri,
        result: supply,
        normalizedText: JSON.stringify(supply),
        provenance: {
          chain: intent.chain,
          network: intent.network,
          projectAnchor: row.projectAnchor,
          subjectKind: "token",
          subject: row.subject,
          slot: row.slot,
          blockTime: row.blockTime === null ? null : Math.floor(row.blockTime.getTime() / 1000),
          blockHash: row.blockHash,
          finality: row.finality === "finalized" ? "finalized" : "confirmed",
          retrievalMethod: "RPC",
          providerId: row.providerId,
          providerMethod: row.providerMethod,
          requestParams: row.requestParams as Record<string, string | number | boolean>,
          transactionSignature: row.transactionSignature,
          retrievedAt: row.retrievedAt,
          rawResponseHash: row.rawResponseHash,
          artifactHash: row.artifactHash,
        },
      }),
      originKind: "RESEARCH_JOB",
      researchJobId: row.researchJobId,
    });
  }
  return out;
}

// ---- the rest of the current-Research context -------------------------
//
// Same discipline as the historical loader above: these retrieve ROWS the
// pure layer then judges. Neither decides eligibility, neither selects an
// anchor, and neither looks outside the current job.

type ArtifactRow = typeof onchainArtifacts.$inferSelect;

function provenanceOf(row: ArtifactRow): OnchainArtifact["provenance"] {
  return {
    chain: row.chain as OnchainChain,
    network: row.network as OnchainNetwork,
    projectAnchor: row.projectAnchor,
    subjectKind: row.subjectKind as OnchainIntent["subjectKind"],
    subject: row.subject,
    slot: row.slot,
    blockTime: row.blockTime === null ? null : Math.floor(row.blockTime.getTime() / 1000),
    blockHash: row.blockHash,
    finality: row.finality === "finalized" ? "finalized" : "confirmed",
    retrievalMethod: "RPC",
    providerId: row.providerId,
    providerMethod: row.providerMethod,
    requestParams: row.requestParams as Record<string, string | number | boolean>,
    transactionSignature: row.transactionSignature,
    retrievedAt: row.retrievedAt,
    rawResponseHash: row.rawResponseHash,
    artifactHash: row.artifactHash,
  };
}

// THIS Research's own total-supply readings. The gate needs them to answer
// "do I already hold one after the event" and to establish the measurement
// domain; it decides both, this only fetches.
export async function loadCurrentJobSupplyObservations(
  db: Database | Transaction,
  query: {
    currentResearchJobId: string;
    projectAnchor: string;
    chain: OnchainChain;
    network: OnchainNetwork;
  },
): Promise<PersistedObservation[]> {
  const canonicalUri = buildCanonicalOnchainUri({
    kind: "TOKEN_SUPPLY",
    chain: query.chain,
    network: query.network,
    projectAnchor: query.projectAnchor,
    subjectKind: "token",
    subject: query.projectAnchor,
  });
  const rows = await db
    .select()
    .from(onchainArtifacts)
    .where(
      and(
        eq(onchainArtifacts.canonicalUri, canonicalUri),
        eq(onchainArtifacts.originKind, "RESEARCH_JOB"),
        eq(onchainArtifacts.researchJobId, query.currentResearchJobId),
      ),
    )
    .orderBy(desc(onchainArtifacts.slot));

  const out: PersistedObservation[] = [];
  for (const row of rows) {
    const result = readSupplyResult(row.normalizedResult);
    if (result === null) continue;
    const supply = { kind: "TOKEN_SUPPLY" as const, ...result };
    out.push({
      artifact: brandOnchainArtifact({
        intent: {
          kind: "TOKEN_SUPPLY",
          chain: row.chain as OnchainChain,
          network: row.network as OnchainNetwork,
          projectAnchor: row.projectAnchor,
          subjectKind: "token",
          subject: row.subject,
        },
        canonicalUri: row.canonicalUri,
        result: supply,
        normalizedText: JSON.stringify(supply),
        provenance: provenanceOf(row),
      }),
      originKind: "RESEARCH_JOB",
      researchJobId: row.researchJobId,
    });
  }
  return out;
}

// Reconstruction hygiene for a transaction, exactly as for a supply row: a
// stored result that cannot be turned back into the shape the pure layer
// reads is skipped rather than repaired.
function readTransactionResult(normalized: unknown): TransactionDetailResult | null {
  if (typeof normalized !== "object" || normalized === null) return null;
  const row = normalized as Record<string, unknown>;
  if (row.kind !== "TRANSACTION_DETAIL") return null;
  if (typeof row.signature !== "string" || row.signature.length === 0) return null;
  if (!Number.isInteger(row.slot)) return null;
  if (!Array.isArray(row.burns)) return null;
  for (const burn of row.burns) {
    if (typeof burn !== "object" || burn === null) return null;
    const b = burn as Record<string, unknown>;
    if (typeof b.mint !== "string" || b.mint.length === 0) return null;
    if (typeof b.sourceAccount !== "string" || b.sourceAccount.length === 0) return null;
    if (typeof b.amountRaw !== "string" || b.amountRaw.length === 0) return null;
  }
  return row as unknown as TransactionDetailResult;
}

// THE DETERMINISTIC EVENTS THIS RESEARCH ESTABLISHED.
//
// A transaction artifact of this job is not by itself an event: what makes
// it one is that deterministic synthesis filed a BURN fact from it. So the
// artifacts are narrowed to those an `evidence` row with
// `onchain_fact_kind = 'BURN'` actually points at — "established by this
// Research" read literally, from the row that establishes it.
//
// It emits ONE candidate per decoded burn of the ACTIVE mint, and ranks
// none of them. Which event an interval is anchored on is the pure layer's
// decision; which slot bounds acquisition coverage is the gate's.
export async function loadCurrentJobBurnEvents(
  db: Database | Transaction,
  query: {
    currentResearchJobId: string;
    projectAnchor: string;
  },
): Promise<AnchorBurnEvent[]> {
  const established = await db
    .selectDistinct({ artifactId: evidence.onchainArtifactId })
    .from(evidence)
    .where(
      and(
        eq(evidence.researchJobId, query.currentResearchJobId),
        eq(evidence.onchainFactKind, "BURN"),
        isNotNull(evidence.onchainArtifactId),
      ),
    );
  const artifactIds = established
    .map((r) => r.artifactId)
    .filter((id): id is string => id !== null);
  if (artifactIds.length === 0) return [];

  const rows = await db
    .select()
    .from(onchainArtifacts)
    .where(
      and(
        inArray(onchainArtifacts.id, artifactIds),
        eq(onchainArtifacts.researchJobId, query.currentResearchJobId),
        eq(onchainArtifacts.projectAnchor, query.projectAnchor),
      ),
    )
    .orderBy(desc(onchainArtifacts.slot));

  const out: AnchorBurnEvent[] = [];
  for (const row of rows) {
    const result = readTransactionResult(row.normalizedResult);
    if (result === null) continue;
    const artifact = brandOnchainArtifact({
      intent: {
        kind: "TRANSACTION_DETAIL",
        chain: row.chain as OnchainChain,
        network: row.network as OnchainNetwork,
        projectAnchor: row.projectAnchor,
        subjectKind: "tx",
        subject: row.subject,
      },
      canonicalUri: row.canonicalUri,
      result,
      normalizedText: JSON.stringify(result),
      provenance: provenanceOf(row),
    });
    result.burns.forEach((burn: BurnInstructionRef, burnIndex: number) => {
      if (burn.mint !== query.projectAnchor) return;
      out.push({ artifact, burnIndex, researchJobId: row.researchJobId });
    });
  }
  return out;
}
