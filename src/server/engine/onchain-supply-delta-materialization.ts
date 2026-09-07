import type { Database, Transaction } from "../db/client";
import { resolveConfirmedIdentity } from "../domain/project-identity";
import {
  selectBurnSpanningSupplyInterval,
  type BurnEventSpan,
} from "./onchain-burn-spanning-supply-interval";
import {
  loadCurrentJobBurnEvents,
  loadCurrentJobSupplyObservations,
  loadHistoricalSupplyCandidates,
  type LoadedSupplyObservation,
} from "./onchain-supply-candidate-store";
import { persistTotalSupplyDeltaEvidence } from "./onchain-supply-delta-store";
import type { PersistedObservation } from "./onchain-event-anchored-supply-interval";

// MATERIALIZE THE DELTA THIS RESEARCH CAN ALREADY PROVE.
//
// WHAT THIS STAGE IS. The last deterministic step of a Research job, and the
// only one that consumes nothing but rows the job already paid for. It reads
// the burns this Research established, the readings it and earlier Research
// took, chooses one interval that contains every burn, and files the exact
// supply change across it as Evidence.
//
// IT ACQUIRES NOTHING. No RPC, no search, no fetch, no model call, no attempt
// row, no budget reservation — this module imports no provider and no
// retriever, and there is no seam for one. If the reading it needs does not
// exist, the answer is that no delta is materialized. B2c3 already had the
// job's one optional chance to acquire a post-event observation, and asking
// for a second here would make that "one" a lie.
//
// AN ABSENT DELTA IS NEVER A FINDING. No historical reading, no reading after
// the burns, two readings that disagree at one slot, endpoints of different
// unit scales — every one of those is a limit on what this Research observed,
// and none of them may be read as "supply did not change". Each is returned
// as its own bounded outcome so the difference stays visible.
//
// IT CHANGES NO VERDICT. The kind it files has no applicability entry, and
// the row is written CONTEXT, which reconciliation documents as never
// establishing or contradicting anything. Persisting stronger Evidence and
// consuming it for a verdict are separate reviewed changes.

export type SupplyDeltaMaterializationOutcome =
  // Written, or already written on an earlier delivery of this same job.
  | "MATERIALIZED"
  | "ALREADY_MATERIALIZED"
  // The project has no confirmed identity this stage may address.
  | "NO_ACTIVE_IDENTITY"
  // This Research established no deterministic burn of this mint. Without an
  // event there is no interval worth measuring, and an unanchored one would
  // be a number chosen by our own observation cadence.
  | "NO_USABLE_BURN_EVENT"
  // The readings needed to close the interval are not held. Acquisition
  // boundaries, never statements about supply.
  | "NO_CURRENT_OBSERVATION_AFTER_SPAN"
  | "NO_HISTORICAL_CANDIDATES"
  | "NO_ELIGIBLE_HISTORICAL_OBSERVATION"
  // Two readings at the chosen boundary slot disagree about the supply. The
  // record contradicts itself; picking one would invent an answer.
  | "AMBIGUOUS_CURRENT_OBSERVATION"
  | "AMBIGUOUS_HISTORICAL_OBSERVATION"
  // The two endpoints are not of the same measurable thing.
  | "NOT_COMPARABLE"
  // The writer's own fail-closed verification refused. Selection may never
  // weaken it, so this is reported rather than worked around.
  | "WRITER_REFUSED";

export interface SupplyDeltaMaterialization {
  outcome: SupplyDeltaMaterializationOutcome;
  evidenceId: string | null;
  // SELECTION DIAGNOSTICS, NOT PROVENANCE. Which burns made ATLAS measure
  // this interval. The delta is established by its two endpoints alone and
  // stays true whatever the reason for choosing them, so none of this is ever
  // written as an establishing input.
  span: BurnEventSpan | null;
  fromSlot: number | null;
  toSlot: number | null;
  // The writer's refusal, when there was one.
  writerRefusal: string | null;
}

function endpointFor(
  loaded: readonly LoadedSupplyObservation[],
  observation: PersistedObservation,
): LoadedSupplyObservation | null {
  const p = observation.artifact.provenance;
  return (
    loaded.find(
      (o) =>
        o.observation.artifact.provenance.artifactHash === p.artifactHash &&
        o.observation.artifact.provenance.slot === p.slot &&
        o.observation.researchJobId === observation.researchJobId,
    ) ?? null
  );
}

export async function runSupplyDeltaMaterialization(
  db: Database | Transaction,
  input: { jobId: string; projectId: string | null },
): Promise<SupplyDeltaMaterialization> {
  const none: SupplyDeltaMaterialization = {
    outcome: "NO_ACTIVE_IDENTITY",
    evidenceId: null,
    span: null,
    fromSlot: null,
    toSlot: null,
    writerRefusal: null,
  };

  // Identity through the canonical ACTIVE mechanism, never read back off a
  // historical observation: an old mint's readings stay comparable with each
  // other and stop being about this project.
  const identity = await resolveConfirmedIdentity(db, input.projectId);
  if (!identity?.tokenAddress || identity.chain !== "solana") return none;
  const anchor = identity.tokenAddress;

  const events = await loadCurrentJobBurnEvents(db, {
    currentResearchJobId: input.jobId,
    projectAnchor: anchor,
  });
  if (events.length === 0) return { ...none, outcome: "NO_USABLE_BURN_EVENT" };

  const current = await loadCurrentJobSupplyObservations(db, {
    currentResearchJobId: input.jobId,
    projectAnchor: anchor,
    chain: "solana",
    network: "mainnet",
  });

  // The historical query is bounded by the EARLIEST burn, because a reading
  // taken between two burns already reflects the ones before it and cannot
  // open an interval that contains them. Which of the retrieved rows may
  // actually serve as t0 is still the pure layer's decision.
  const historicalLoaded = await loadHistoricalSupplyCandidates(db, {
    currentResearchJobId: input.jobId,
    projectAnchor: anchor,
    chain: "solana",
    network: "mainnet",
    beforeSlot: earliestBurnSlotOf(events, input.jobId, anchor),
  });

  const selected = selectBurnSpanningSupplyInterval({
    currentResearchJobId: input.jobId,
    currentProjectAnchor: anchor,
    events,
    current: current.map((o) => o.observation),
    historical: historicalLoaded.map((o) => o.observation),
  });

  if (!selected.selected) {
    return { ...none, outcome: selected.reason, span: selected.span };
  }
  const { interval } = selected;

  // The row ids the writer needs, matched back to the observations the pure
  // layer chose — from the SAME rows it was given, never re-queried and never
  // guessed. An endpoint that cannot be paired with the row it came from is
  // not written.
  const from = endpointFor(historicalLoaded, interval.from);
  const to = endpointFor(current, interval.to);
  const diagnostics = {
    span: interval.span,
    fromSlot: interval.from.artifact.provenance.slot,
    toSlot: interval.to.artifact.provenance.slot,
  };
  if (!from || !to) {
    return { ...none, outcome: "WRITER_REFUSED", ...diagnostics, writerRefusal: "ENDPOINT_ROW_NOT_FOUND" };
  }

  // THE ONE WRITER, WITH ITS OWN VERIFICATION INTACT. It re-derives the delta
  // from the two artifacts and refuses unless everything agrees — selection
  // above cannot weaken that, and is not trusted by it.
  const written = await persistTotalSupplyDeltaEvidence(db, {
    currentResearchJobId: input.jobId,
    delta: interval.delta,
    from,
    to,
  });
  if (!written.persisted) {
    return { ...none, outcome: "WRITER_REFUSED", ...diagnostics, writerRefusal: written.reason };
  }
  return {
    outcome: written.created ? "MATERIALIZED" : "ALREADY_MATERIALIZED",
    evidenceId: written.evidenceId,
    writerRefusal: null,
    ...diagnostics,
  };
}

// The left retrieval bound, computed from the same admission rules the pure
// span uses. A retrieval bound only: nothing is selected here.
function earliestBurnSlotOf(
  events: readonly { artifact: { provenance: { slot: number; projectAnchor: string } }; researchJobId: string | null }[],
  jobId: string,
  anchor: string,
): number {
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const e of events) {
    if (e.researchJobId !== jobId) continue;
    if (e.artifact.provenance.projectAnchor !== anchor) continue;
    const slot = e.artifact.provenance.slot;
    if (Number.isInteger(slot) && slot >= 0 && slot < earliest) earliest = slot;
  }
  return earliest;
}
