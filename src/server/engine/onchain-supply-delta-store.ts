import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { evidence, evidenceOnchainArtifactInputs, onchainArtifacts } from "../db/schema";
import { ONCHAIN_DOES_NOT_PROVE } from "./onchain-facts";
import type { PersistedObservation } from "./onchain-event-anchored-supply-interval";
import { deriveTotalSupplyDelta, type TotalSupplyDelta } from "./onchain-supply-delta";
import type { OnchainArtifact, TokenSupplyResult } from "./providers/onchain-types";

// TOTAL_SUPPLY_DELTA EVIDENCE — one derived fact, two establishing inputs.
//
// WHAT MAKES THIS DIFFERENT FROM EVERY OTHER ON-CHAIN FACT. All of them are
// synthesized from ONE artifact, and `evidence.onchain_artifact_id` records
// exactly that. A delta is established by a historical reading, a current
// reading and arithmetic, and by neither reading alone — so the singular
// pointer is left NULL and the two endpoints are recorded as canonical
// provenance edges instead. Nothing about this fact is recoverable only by
// parsing prose: FROM and TO are rows, and every number the statement quotes
// is derivable from the artifacts they point at.
//
// THE INPUTS ARE THE ARITHMETIC'S OPERANDS AND NOTHING ELSE. A burn whose
// slot falls inside the interval is NOT written here. It did not establish
// the number — the delta is true from t0 and t1 alone — it only makes the
// interval worth looking at. Burn Evidence already exists separately, and
// asking whether a burn lies inside a delta's interval is a later
// deterministic question over two independent rows, not a third edge here.
//
// RECOMPUTED, NEVER COPIED. The caller hands in a delta it derived; this
// module derives it AGAIN from the two artifacts and refuses to write
// anything unless the two agree in every field. That is what makes a
// caller-supplied number unable to become Evidence: the persisted fact is
// the recomputation, and the argument is only a claim about it.
//
// IT ESTABLISHES NOTHING YET, BY TWO INDEPENDENT MECHANISMS. The kind is
// absent from APPLICABLE_COMPONENTS_BY_KIND, so no component may read it
// across the map; and the row is written CONTEXT, which reconciliation
// documents as "CONTEXT / LIMITS never establish or contradict anything".
// Either alone would keep it out of a verdict.

export const TOTAL_SUPPLY_DELTA_STEP = 7;
export const TOTAL_SUPPLY_DELTA_COMPONENT = "NET_EFFECT";

// The version tag inside every derived identity below. Bumping it would
// mean the interval identity scheme itself changed, which is a decision, not
// an accident — so it is written down rather than implied.
const INTERVAL_SCHEME = "TOTAL_SUPPLY_DELTA_V1";

export type TotalSupplyDeltaRefusal =
  // An endpoint is not a usable deterministic total-supply observation, or
  // the two are not comparable. B2a's own answer, never restated here.
  | "DELTA_NOT_COMPARABLE"
  // The caller's delta and the recomputation from the two artifacts differ.
  // The recomputation wins and nothing is written.
  | "DELTA_DISAGREES_WITH_ENDPOINTS"
  // An endpoint row id names no row, or names a row that is not the
  // observation the caller passed alongside it.
  | "ENDPOINT_ROW_NOT_FOUND"
  | "ENDPOINT_ROW_MISMATCH"
  // t0 must be a PRIOR Research's reading. An owner-script standalone
  // observation is refused for the product reason B2b2 already states, and
  // this job's own earlier reading is not history, it is this run observing
  // twice.
  | "FROM_NOT_RESEARCH_ORIGIN"
  | "FROM_NOT_PRIOR_RESEARCH_JOB"
  // t1 must be the reading THIS Research acquired.
  | "TO_NOT_CURRENT_RESEARCH_JOB"
  // The two endpoints resolved to different canonical source rows. Not
  // possible for one mint's TOKEN_SUPPLY URI, and checked rather than
  // assumed: if it ever happens, the pair is not what it claims to be.
  | "ENDPOINT_SOURCES_DIVERGE";

export interface TotalSupplyDeltaEndpoint {
  // The persisted `onchain_artifacts` row this observation is.
  onchainArtifactId: string;
  observation: PersistedObservation;
}

export interface PersistTotalSupplyDeltaInput {
  currentResearchJobId: string;
  // The delta the caller derived through the B2 stack. Re-derived here and
  // required to agree exactly; it is a claim to be checked, not a value to
  // be trusted.
  delta: TotalSupplyDelta;
  from: TotalSupplyDeltaEndpoint;
  to: TotalSupplyDeltaEndpoint;
}

export type PersistTotalSupplyDeltaOutcome =
  | {
      persisted: true;
      evidenceId: string;
      // False when an identical interval was already written for this job:
      // the row is the same one, and nothing was duplicated.
      created: boolean;
      extractionUnitKey: string;
    }
  | { persisted: false; reason: TotalSupplyDeltaRefusal };

function isSupply(
  artifact: OnchainArtifact,
): artifact is OnchainArtifact & { result: TokenSupplyResult } {
  return artifact.result.kind === "TOKEN_SUPPLY";
}

function sha256(parts: readonly (string | number)[]): string {
  return `sha256:${createHash("sha256").update(parts.map(String).join(" ")).digest("hex")}`;
}

// THE IDENTITY OF AN INTERVAL, not of an observation.
//
// Built from what cannot change about the two endpoints — each one's content
// address and the chain position it was read at — plus the job and the
// (step, component) this Evidence is filed under. So:
//
//   the same two observations, recomputed  -> the same key -> idempotent
//   the same VALUES at different slots     -> a different key
//
// Deliberately not `retrievedAt` (a wall clock, and two nodes' clocks are
// not comparable) and deliberately not random. And deliberately NOT the
// shared `extractionUnitKey` helper: that one identifies an extraction unit
// of ONE artifact, and widening it for this case would change the identity
// of every documentary and single-artifact on-chain row in the engine.
// Neither endpoint's own artifactHash is redefined; both are quoted as they
// already stand.
export function totalSupplyDeltaUnitKey(input: {
  currentResearchJobId: string;
  fromArtifactHash: string;
  fromSlot: number;
  toArtifactHash: string;
  toSlot: number;
}): string {
  return sha256([
    INTERVAL_SCHEME,
    input.currentResearchJobId,
    TOTAL_SUPPLY_DELTA_STEP,
    TOTAL_SUPPLY_DELTA_COMPONENT,
    input.fromArtifactHash,
    input.fromSlot,
    input.toArtifactHash,
    input.toSlot,
  ]);
}

// The content address of what this fact quotes — the INTERVAL, addressed by
// both endpoints. `evidence.content_hash` has never meant "hash of a fetched
// document": a deterministic chain fact already stores an RPC response hash
// there, and the fixture executor stores a synthetic label. Nothing
// dereferences it (the source snapshot resolves by retrieved_url against
// acquired_documents); it is used as an opaque dedup and ordering key. So a
// content address of the pair is the honest value, and it is job-independent
// on purpose: the same interval is the same content wherever it is read.
export function totalSupplyDeltaContentHash(input: {
  fromArtifactHash: string;
  fromSlot: number;
  toArtifactHash: string;
  toSlot: number;
}): string {
  return sha256([
    INTERVAL_SCHEME,
    input.fromArtifactHash,
    input.fromSlot,
    input.toArtifactHash,
    input.toSlot,
  ]);
}

// The quoted excerpt, as canonical JSON — the same discipline every
// synthesized fact follows, so a reader sees exactly which values the
// statement rests on. It is NOT the authority for endpoint identity: the two
// provenance rows are, and every number here is derivable from the artifacts
// they point at.
export function totalSupplyDeltaFragment(delta: TotalSupplyDelta): string {
  return JSON.stringify({
    chain: delta.chain,
    network: delta.network,
    mint: delta.mint,
    decimals: delta.decimals,
    fromSlot: delta.from.slot,
    toSlot: delta.to.slot,
    fromAmountRaw: delta.from.amountRaw,
    toAmountRaw: delta.to.amountRaw,
    deltaRaw: delta.deltaRaw,
    direction: delta.direction,
    slotSpan: delta.slotSpan,
  });
}

// A code template over validated values, exactly as the other synthesized
// statements are. Every direction is stated the same way: a decrease is not
// announced as a success and an increase is not announced as a failure.
export function totalSupplyDeltaStatement(delta: TotalSupplyDelta): string {
  const movement =
    delta.direction === "UNCHANGED"
      ? "did not change"
      : delta.direction === "DECREASED"
        ? `changed by ${delta.deltaRaw} (decrease)`
        : `changed by ${delta.deltaRaw} (increase)`;
  return (
    `On-chain total supply of token ${delta.mint} ${movement} between slot ${delta.from.slot} and ` +
    `slot ${delta.to.slot} (raw units, ${delta.decimals} decimals), a span of ${delta.slotSpan} slots, ` +
    `computed from two deterministic total-supply observations.`
  );
}

function sameDelta(a: TotalSupplyDelta, b: TotalSupplyDelta): boolean {
  return (
    a.chain === b.chain &&
    a.network === b.network &&
    a.mint === b.mint &&
    a.decimals === b.decimals &&
    a.deltaRaw === b.deltaRaw &&
    a.direction === b.direction &&
    a.slotSpan === b.slotSpan &&
    a.from.slot === b.from.slot &&
    a.to.slot === b.to.slot &&
    a.from.amountRaw === b.from.amountRaw &&
    a.to.amountRaw === b.to.amountRaw &&
    a.from.artifactHash === b.from.artifactHash &&
    a.to.artifactHash === b.to.artifactHash
  );
}

export async function persistTotalSupplyDeltaEvidence(
  db: Database | Transaction,
  input: PersistTotalSupplyDeltaInput,
): Promise<PersistTotalSupplyDeltaOutcome> {
  const fromArtifact = input.from.observation.artifact;
  const toArtifact = input.to.observation.artifact;

  // --- provenance admission, before any arithmetic is trusted ------------
  if (
    input.from.observation.originKind !== "RESEARCH_JOB" ||
    input.from.observation.researchJobId === null
  ) {
    return { persisted: false, reason: "FROM_NOT_RESEARCH_ORIGIN" };
  }
  if (input.from.observation.researchJobId === input.currentResearchJobId) {
    return { persisted: false, reason: "FROM_NOT_PRIOR_RESEARCH_JOB" };
  }
  if (
    input.to.observation.originKind !== "RESEARCH_JOB" ||
    input.to.observation.researchJobId !== input.currentResearchJobId
  ) {
    return { persisted: false, reason: "TO_NOT_CURRENT_RESEARCH_JOB" };
  }
  if (!isSupply(fromArtifact) || !isSupply(toArtifact)) {
    return { persisted: false, reason: "DELTA_NOT_COMPARABLE" };
  }

  // --- THE RECOMPUTATION. B2a's arithmetic, run again, here --------------
  // It also enforces every comparability rule the caller's delta claims to
  // satisfy — same chain, network, mint and unit scale, both finalized,
  // both provenance-complete, and FROM strictly before TO.
  const recomputed = deriveTotalSupplyDelta(fromArtifact, toArtifact);
  if (!recomputed.comparable) return { persisted: false, reason: "DELTA_NOT_COMPARABLE" };
  if (!sameDelta(recomputed.delta, input.delta)) {
    return { persisted: false, reason: "DELTA_DISAGREES_WITH_ENDPOINTS" };
  }
  const delta = recomputed.delta;

  // --- the endpoint ROWS must be the observations they were passed as ----
  const rows = await db
    .select({
      id: onchainArtifacts.id,
      researchJobId: onchainArtifacts.researchJobId,
      originKind: onchainArtifacts.originKind,
      sourceId: onchainArtifacts.sourceId,
      intentKind: onchainArtifacts.intentKind,
      artifactHash: onchainArtifacts.artifactHash,
      slot: onchainArtifacts.slot,
      canonicalUri: onchainArtifacts.canonicalUri,
    })
    .from(onchainArtifacts)
    .where(
      inArray(onchainArtifacts.id, [input.from.onchainArtifactId, input.to.onchainArtifactId]),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fromRow = byId.get(input.from.onchainArtifactId);
  const toRow = byId.get(input.to.onchainArtifactId);
  if (!fromRow || !toRow) return { persisted: false, reason: "ENDPOINT_ROW_NOT_FOUND" };

  const endpointMatches = (
    row: (typeof rows)[number],
    observation: PersistedObservation,
    artifact: OnchainArtifact & { result: TokenSupplyResult },
  ): boolean =>
    row.intentKind === "TOKEN_SUPPLY" &&
    row.originKind === "RESEARCH_JOB" &&
    row.researchJobId === observation.researchJobId &&
    row.artifactHash === artifact.provenance.artifactHash &&
    row.slot === artifact.provenance.slot &&
    row.canonicalUri === artifact.canonicalUri &&
    row.sourceId !== null;
  if (
    !endpointMatches(fromRow, input.from.observation, fromArtifact) ||
    !endpointMatches(toRow, input.to.observation, toArtifact)
  ) {
    return { persisted: false, reason: "ENDPOINT_ROW_MISMATCH" };
  }
  // One mint's TOKEN_SUPPLY canonical URI resolves to one `sources` row, so
  // both endpoints share it and the NOT NULL source of the derived Evidence
  // names something both observations really came from.
  if (fromRow.sourceId !== toRow.sourceId) {
    return { persisted: false, reason: "ENDPOINT_SOURCES_DIVERGE" };
  }

  // --- the write ---------------------------------------------------------
  const extractionUnitKey = totalSupplyDeltaUnitKey({
    currentResearchJobId: input.currentResearchJobId,
    fromArtifactHash: delta.from.artifactHash,
    fromSlot: delta.from.slot,
    toArtifactHash: delta.to.artifactHash,
    toSlot: delta.to.slot,
  });

  const [inserted] = await db
    .insert(evidence)
    .values({
      researchJobId: input.currentResearchJobId,
      proofId: null,
      sourceId: toRow.sourceId!,
      // NULL ON PURPOSE. The singular legacy pointer means "the one artifact
      // this fact came from", and two established this one. The truth is in
      // evidence_onchain_artifact_inputs below.
      onchainArtifactId: null,
      onchainFactKind: "TOTAL_SUPPLY_DELTA",
      patternStep: TOTAL_SUPPLY_DELTA_STEP,
      component: TOTAL_SUPPLY_DELTA_COMPONENT,
      // THE DIRECTION IS THE RELATIONSHIP, and this is the only place it is
      // decided — once, by the code that did the subtraction, never by a
      // model and never by anything reading the fragment back.
      //
      // Honest because the row is scoped to step 7 / NET_EFFECT and to no
      // other component: for the question "what was the net supply effect", a
      // measured decrease is evidence in favour of a net decrease, and a
      // measured increase or no change is evidence against one. Neither says
      // anything about CAUSE — the relationship positions the measurement
      // relative to the component's question, and `doesNotProve` states in
      // the same row that no mechanism is attributed.
      //
      // It is what lets reconciliation read the direction from a typed field
      // instead of parsing prose, and it is why a delta cannot silently
      // establish anything: SUPPORTS still leaves a limitation code standing,
      // and CONTRADICTS never contradicts that the burn happened.
      relationship: delta.direction === "DECREASED" ? "SUPPORTS" : "CONTRADICTS",
      directness: "DIRECT",
      fragment: totalSupplyDeltaFragment(delta),
      summary: totalSupplyDeltaStatement(delta),
      mechanismState: null,
      sourceClass: "ONCHAIN_VERIFIABLE",
      // A canonical chain read is not a project's own published claim.
      officiality: "CLAIMED",
      entityBinding: "CONFIRMED",
      // The moment THIS Research completed the interval: the later of the two
      // readings, which is the one it acquired.
      fetchedAt: delta.to.retrievedAt,
      publishedAt: null,
      doesNotProve: ONCHAIN_DOES_NOT_PROVE.TOTAL_SUPPLY_DELTA,
      retrievedUrl: toArtifact.canonicalUri,
      contentHash: totalSupplyDeltaContentHash({
        fromArtifactHash: delta.from.artifactHash,
        fromSlot: delta.from.slot,
        toArtifactHash: delta.to.artifactHash,
        toSlot: delta.to.slot,
      }),
      extractionUnitKey,
    })
    // Mirrors the partial index's own predicate — Postgres cannot infer the
    // arbiter index otherwise. The unit key already carries the job id, so
    // idempotency stays job-scoped without narrowing the clause here.
    .onConflictDoNothing({
      target: evidence.extractionUnitKey,
      where: sql`${evidence.extractionUnitKey} IS NOT NULL`,
    })
    .returning({ id: evidence.id });

  if (inserted) {
    // The two operands, in a fixed order the CHECK constrains: ordinal 0 is
    // FROM, ordinal 1 is TO. Written after the fact row and in one statement,
    // so a delta never exists with one endpoint recorded.
    await db.insert(evidenceOnchainArtifactInputs).values([
      { evidenceId: inserted.id, ordinal: 0, inputRole: "FROM", onchainArtifactId: fromRow.id },
      { evidenceId: inserted.id, ordinal: 1, inputRole: "TO", onchainArtifactId: toRow.id },
    ]);
    return { persisted: true, evidenceId: inserted.id, created: true, extractionUnitKey };
  }

  // The exact same interval was already recomputed and written for this job.
  // Idempotent by identity, not by luck: the same two observations produce
  // the same unit key.
  const [existing] = await db
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(
        eq(evidence.researchJobId, input.currentResearchJobId),
        eq(evidence.extractionUnitKey, extractionUnitKey),
      ),
    );
  if (!existing) return { persisted: false, reason: "ENDPOINT_ROW_NOT_FOUND" };
  return { persisted: true, evidenceId: existing.id, created: false, extractionUnitKey };
}
