import { and, eq, inArray } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchTraceEvents } from "../db/schema";
import { resolveConfirmedIdentity } from "../domain/project-identity";
import { readJobBudgetReserved, reserveJobBudget } from "./budget-reservation";
import { persistOnchainArtifact } from "./onchain-acquisition";
import {
  resolveOnchainSourceOpenReserve,
  unprotectedCeiling,
} from "./onchain-source-open-reserve";
import { gateCurrentProofSupplyAcquisition } from "./onchain-current-proof-supply-gate";
import {
  anchorBurnRef,
  type AnchorBurnEvent,
  type PersistedObservation,
} from "./onchain-event-anchored-supply-interval";
import type { CurrentProofSupplyGate } from "./onchain-current-proof-supply-gate";
import { planPostEventSupplyAcquisition } from "./onchain-post-event-supply-plan";
import {
  loadCurrentJobBurnEvents,
  loadCurrentJobSupplyObservations,
  loadHistoricalSupplyCandidates,
} from "./onchain-supply-candidate-store";
import { buildCanonicalOnchainUri, onchainIntentPath, parseCanonicalOnchainUri } from "./onchain-uri";
import {
  onchainEnvironmentFor,
  onchainRetrievalAvailable,
  resolveOnchainRetriever,
  type OnchainRetriever,
} from "./providers/onchain-retriever";
import type { OnchainArtifact, OnchainIntent } from "./providers/onchain-types";
import { recordTraceEvent } from "./trace-store";

// ONE POST-EVENT TOKEN_SUPPLY ACQUISITION, PER RESEARCH JOB, EVER — and, in
// the one EVM V1 scenario described at ExplicitBlockSupplyRead, ONE read at
// the block before the earliest event. Never more than those two.
//
// WHAT IT COMPLETES. An event-anchored supply interval needs a reading
// strictly after the event. A deterministic burn is stamped with the slot of
// the transaction that contained it; a supply reading is stamped with the
// node's head at read time. Those are different clocks, and a burn this
// Research discovered late — through the locator reactivation pass, say —
// can sit AFTER every reading the job took. When it does, and only when a
// PRIOR Research already holds a reading before that burn, one more read
// completes an interval that otherwise cannot be formed at all.
//
// IT IS NOT REACTIVATION, AND IS DELIBERATELY NOT FOLDED INTO IT. The two
// have different licences. Reactivation's is "a locator admitted inside this
// job made a component's deterministic acquisition newly actionable"; this
// one's is "a deterministic event this job established exposed a TEMPORAL
// gap in what the job observed". Reactivation is per-component and
// component-scoped; this is cross-component and belongs to no component at
// all. Merging them would make both statements false.
//
// OPTIONAL, AND PAID FOR LAST. It holds no protected reservation. Budget
// Reservation V2 protects the scheduled deterministic reads and ONE deepest
// promotion chain — the path that discovers the burn in the first place —
// and this read may proceed only if a source open still remains under the
// job's single unchanged ceiling after all of that. A refusal is a bounded
// diagnostic, never a research failure: the Research continues and B2 is
// simply unavailable for this Proof.
//
// ONE, AND ONE IS ONE. No polling, no sleep, no loop, no second call because
// the slot came back too early, no retry after an error, a malformed
// response or a refused binding. The marker that makes it one-shot is
// written BEFORE the call, so a crash, a redelivery or a resumed job finds
// the opportunity already spent.
//
// A FAILED READ IS A RESEARCH LIMITATION, NEVER A FINDING. An RPC that
// errors, a response that cannot be validated, a binding that will not
// confirm — none of them says anything about the project. They are never
// converted into "supply did not change" or "NET_EFFECT is not established".

export type PostEventSupplyOutcome =
  // The gate said no. Its own reason travels on `gate`.
  | "NO_ACTION"
  // This job already had its one opportunity — on this delivery or an
  // earlier one. Nothing is retried, ever.
  | "OPPORTUNITY_ALREADY_CONSUMED"
  // No source open remained under the unchanged job ceiling. B2 is
  // unavailable for this Proof and the Research continues normally.
  | "BUDGET_EXHAUSTED"
  // This process cannot reach a chain. A configuration boundary, and NOT a
  // consumed opportunity: nothing was attempted and nothing was spent.
  | "ACQUISITION_UNAVAILABLE"
  // Read, persisted, and strictly after the acquisition watermark: the
  // interval's right-hand side now exists.
  | "ACQUIRED"
  // Read and persisted — a real observation, kept — but at or before the
  // watermark, so it cannot close the interval. Not retried.
  | "NOT_STRICTLY_AFTER_EVENT"
  // The provider call failed, or its answer could not be validated or bound.
  // A technical limitation of this Research; never a claim about the token.
  | "RETRIEVAL_FAILED";

// THE ONE HISTORICAL READ BEFORE THE EVENT (EVM V1, Founder-approved).
//
// The gate refuses a t1 read when no reading before the event exists
// (NO_HISTORICAL_T0), because a t1 alone completes nothing. For a transaction
// a document named, that is the normal case — nobody observed supply before
// it — so the anchored interval could never form. On an environment that can
// read state AT A NAMED FINALIZED BLOCK, this stage may therefore take ONE
// reading at the block immediately before the earliest event, and only when:
//
//   - every usable event of this Research is a ZERO_ADDRESS_TRANSFER (the
//     approved scenario; burns and Solana are untouched),
//   - the environment is one that serves explicit-block reads
//     (EXPLICIT_BLOCK_SUPPLY_ENVIRONMENTS — Ethereum mainnet only),
//   - the job's unchanged budget can still pay for every read the interval
//     needs (this one, plus the t1 read when none is held after the event),
//     so a t0 is never taken that could only serve a future Research,
//   - and this job has not had the opportunity already.
//
// At most one t0 and at most one t1: two event-anchored supply reads per
// Research job, ever. No retry. An endpoint without archive state errors,
// and that is RETRIEVAL_FAILED — a technical limit, never a finding.
export type ExplicitBlockSupplyReadOutcome =
  | "ACQUIRED"
  | "OPPORTUNITY_ALREADY_CONSUMED"
  | "BUDGET_EXHAUSTED"
  | "ACQUISITION_UNAVAILABLE"
  | "RETRIEVAL_FAILED";

export interface ExplicitBlockSupplyRead {
  outcome: ExplicitBlockSupplyReadOutcome;
  block: number;
  sourceOpensSpent: number;
  artifactId: string | null;
}

export const EXPLICIT_BLOCK_SUPPLY_ENVIRONMENTS: ReadonlySet<string> = new Set(["ethereum/mainnet"]);

export interface PostEventSupplyCompletion {
  outcome: PostEventSupplyOutcome;
  // The t0 read's own outcome, when this stage considered one. Null when the
  // scenario did not arise — every BURN and every Solana job.
  historicalRead: ExplicitBlockSupplyRead | null;
  // The decision this acted on, so a reader never has to re-derive it.
  gate: CurrentProofSupplyGate | null;
  sourceOpensSpent: number;
  // The persisted observation's row id, when one was written.
  artifactId: string | null;
  // The chain position that came back, when a read happened.
  observedSlot: number | null;
  // The coverage bound the answer was measured against. NOT the Proof's
  // event — see the watermark type's own comment.
  watermarkSlot: number | null;
}

// THE ONE-SHOT MARKER, DERIVED FROM TRACE RATHER THAN STORED.
//
// No new column, no new table and no new enum value: a row this job already
// writes for every real external action is enough, provided it can be
// recognised unambiguously. The recognisable shape is
//
//   component IS NULL  +  target_ref parses as a canonical on-chain URI
//                         whose intent is TOKEN_SUPPLY
//
// and nothing else in the engine writes it. The two on-chain writers — the
// executor's own branch and the reactivation pass — always carry the
// component they acted for, and the documentary fetch phase, which does write
// component-less FETCH_ATTEMPTED rows, carries an https url that the
// canonical parser refuses. A test holds both halves of that.
//
// It is written BEFORE the call and also on a budget refusal, which is what
// makes it a genuine one-shot rather than a retry gate: a failure spends the
// opportunity exactly as a success does.
const ONE_SHOT_OPERATIONS = ["FETCH_ATTEMPTED", "CANDIDATE_SKIPPED_BUDGET"] as const;
const TOKEN_SUPPLY_INTENT_PATH = onchainIntentPath("TOKEN_SUPPLY");

export async function postEventSupplyOpportunityConsumed(
  db: Database | Transaction,
  jobId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      component: researchTraceEvents.component,
      targetRef: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(
      and(
        eq(researchTraceEvents.researchJobId, jobId),
        inArray(researchTraceEvents.operationType, [...ONE_SHOT_OPERATIONS]),
      ),
    );
  for (const r of rows) {
    if (r.component !== null) continue;
    if (!r.targetRef) continue;
    const parsed = parseCanonicalOnchainUri(r.targetRef);
    if (parsed === null) continue;
    if (parsed.intentPath !== TOKEN_SUPPLY_INTENT_PATH) continue;
    // An explicit-block (t0) read is its own opportunity, with its own
    // marker below; it never spends this one.
    if (parsed.block !== null) continue;
    return true;
  }
  return false;
}

// THE t0 ONE-SHOT (EVM V1), recognised the same way and kept disjoint from
// the t1 marker above by the one thing that differs: its target names an
// explicit block. Written before the call and on a budget refusal, so a
// failure spends it exactly as a success does.
export async function explicitBlockSupplyOpportunityConsumed(
  db: Database | Transaction,
  jobId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      component: researchTraceEvents.component,
      targetRef: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(
      and(
        eq(researchTraceEvents.researchJobId, jobId),
        inArray(researchTraceEvents.operationType, [...ONE_SHOT_OPERATIONS]),
      ),
    );
  for (const r of rows) {
    if (r.component !== null) continue;
    if (!r.targetRef) continue;
    const parsed = parseCanonicalOnchainUri(r.targetRef);
    if (parsed === null) continue;
    if (parsed.intentPath !== TOKEN_SUPPLY_INTENT_PATH) continue;
    if (parsed.block === null) continue;
    return true;
  }
  return false;
}

// THE APPROVED SCENARIO, AND WHERE ITS t0 GOES. Returns the earliest usable
// event slot when every usable event of this Research is a
// ZERO_ADDRESS_TRANSFER of the active token, and null otherwise — so a job
// with any burn, and every job with no event, keeps exactly its old path.
// Usability is anchorBurnRef's, the rule every B2 layer shares.
export function explicitBlockScenarioEarliestSlot(
  events: readonly AnchorBurnEvent[],
  jobId: string,
  anchor: string,
): number | null {
  let earliest: number | null = null;
  for (const event of events) {
    if (event.researchJobId !== jobId) continue;
    const kind = event.eventKind ?? "BURN";
    const ref = anchorBurnRef(event.artifact, event.burnIndex, jobId, kind);
    if (ref === null || ref.mint !== anchor) continue;
    if (event.artifact.provenance.projectAnchor !== anchor) continue;
    if (!Number.isInteger(ref.slot) || ref.slot < 0) continue;
    if (kind !== "ZERO_ADDRESS_TRANSFER") return null;
    if (earliest === null || ref.slot < earliest) earliest = ref.slot;
  }
  return earliest;
}

export async function runPostEventSupplyCompletion(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string | null;
    maxSourceOpens: number;
    // Same declaration the reactivation pass carries: this stage runs after
    // documentary acquisition is over, so units held for a component with
    // no subject can be released into the unprotected pool this read
    // draws on. Absent means "not known": nothing is released.
    documentaryAcquisitionFinished?: boolean;
    // Test seam only, exactly as the acquisition leaf's own. Absent means
    // "resolve the production retriever, if this process has one".
    retriever?: OnchainRetriever | null;
  },
): Promise<PostEventSupplyCompletion> {
  const none: PostEventSupplyCompletion = {
    outcome: "NO_ACTION",
    historicalRead: null,
    gate: null,
    sourceOpensSpent: 0,
    artifactId: null,
    observedSlot: null,
    watermarkSlot: null,
  };

  // --- identity, through the canonical mechanism and nowhere else --------
  // Never read back off a historical observation: an old mint's readings are
  // arithmetically comparable with each other and are not about this project
  // any more.
  const identity = await resolveConfirmedIdentity(db, input.projectId);
  if (!identity?.tokenAddress) return none;
  // The identity's own deterministic environment, from the registry. A
  // chain with no implementation has none, and this completion — like
  // every other chain read — simply does not exist for it.
  const environment = onchainEnvironmentFor(identity.chain);
  if (environment === null) return none;
  const anchor = identity.tokenAddress;

  // --- the events this Research established ------------------------------
  const events = await loadCurrentJobBurnEvents(db, {
    currentResearchJobId: input.jobId,
    projectAnchor: anchor,
  });
  if (events.length === 0) return none;

  // The row ids the loader also returns are the delta materializer's need,
  // not this stage's: the gate judges observations, never rows.
  const observations = (
    await loadCurrentJobSupplyObservations(db, {
      currentResearchJobId: input.jobId,
      projectAnchor: anchor,
      chain: environment.chain,
      network: environment.network,
    })
  ).map((o) => o.observation);

  // The coverage bound, computed by the same pure planner the gate uses, so
  // the historical query and the gate cannot disagree about where "before
  // the event" ends.
  const watermark = planPostEventSupplyAcquisition({
    currentResearchJobId: input.jobId,
    currentProjectAnchor: anchor,
    events,
    observations,
  });
  if (watermark.eventSlot === null) return none;

  const loadHistorical = async () =>
    (
      await loadHistoricalSupplyCandidates(db, {
        currentResearchJobId: input.jobId,
        projectAnchor: anchor,
        chain: environment.chain,
        network: environment.network,
        beforeSlot: watermark.eventSlot!,
      })
    ).map((o) => o.observation);
  const decide = (historicalCandidates: PersistedObservation[]) =>
    gateCurrentProofSupplyAcquisition({
      currentResearchJobId: input.jobId,
      currentProjectAnchor: anchor,
      events,
      observations,
      historicalCandidates,
    });

  let gate = decide(await loadHistorical());

  // An unconfigured environment simply has no structured capability. Nothing
  // is attempted, nothing is spent, and no marker is written — a process that
  // cannot reach a chain must not spend the opportunity of one that can.
  const resolveRetriever = (): OnchainRetriever | null => {
    if (input.retriever) return input.retriever;
    if (input.retriever === null) return null;
    if (onchainRetrievalAvailable(environment.chain, environment.network)) {
      return resolveOnchainRetriever(environment.chain, environment.network);
    }
    return null;
  };

  // COMPONENT-LESS BY CONSTRUCTION, for both reads. This completion belongs
  // to no component: it is cross-component temporal research. Carrying one
  // would consume that component's own bounded reactivation opportunity.
  const traceFor = (targetRef: string) =>
    async (
      operationType: (typeof ONE_SHOT_OPERATIONS)[number] | "FETCH_OK" | "FETCH_FAILED",
      status: "OK" | "FAILED" | "SKIPPED",
      reasonCode: "NONE" | "SOURCE_OPEN_BUDGET_EXHAUSTED" | "PROVIDER_ERROR",
    ): Promise<void> => {
      await recordTraceEvent(db, {
        researchJobId: input.jobId,
        researchAttemptId: null,
        operationType,
        providerKind: "FETCH",
        targetRef,
        status,
        reasonCode,
        budgetAxis: "sourceOpens",
        budgetAmount: 1,
      });
    };

  // THE UNPROTECTED CEILING — see the t1 read below for why it is not the
  // job ceiling. Resolved once per call, after documentary acquisition.
  const unprotected = async (): Promise<number> => {
    const supplyReserve = await resolveOnchainSourceOpenReserve(db, {
      jobId: input.jobId,
      projectId: input.projectId,
      maxSourceOpens: input.maxSourceOpens,
      documentaryAcquisitionFinished: input.documentaryAcquisitionFinished,
    });
    return unprotectedCeiling(supplyReserve);
  };

  // --- the t0 read, only in the approved scenario --------------------------
  let historicalRead: ExplicitBlockSupplyRead | null = null;
  const earliestEventSlot = explicitBlockScenarioEarliestSlot(events, input.jobId, anchor);
  if (
    gate.decision === "NO_ACTION" &&
    gate.reason === "NO_HISTORICAL_T0" &&
    earliestEventSlot !== null &&
    earliestEventSlot > 0 &&
    EXPLICIT_BLOCK_SUPPLY_ENVIRONMENTS.has(`${environment.chain}/${environment.network}`)
  ) {
    const block = earliestEventSlot - 1;
    const t0Intent: OnchainIntent = {
      kind: "TOKEN_SUPPLY",
      chain: environment.chain,
      network: environment.network,
      projectAnchor: anchor,
      subjectKind: "token",
      subject: anchor,
      block,
    };
    const t0Uri = buildCanonicalOnchainUri(t0Intent);
    const t0Trace = traceFor(t0Uri);
    const read = (outcome: ExplicitBlockSupplyReadOutcome, spent = 0, artifactId: string | null = null) =>
      ({ outcome, block, sourceOpensSpent: spent, artifactId });

    if (await explicitBlockSupplyOpportunityConsumed(db, input.jobId)) {
      historicalRead = read("OPPORTUNITY_ALREADY_CONSUMED");
    } else {
      const retriever = resolveRetriever();
      if (retriever === null || !retriever.supports(t0Intent.chain, t0Intent.network, t0Intent.kind)) {
        historicalRead = read("ACQUISITION_UNAVAILABLE");
      } else {
        // NOT FOR THE FUTURE. The t0 is worth taking only if the interval can
        // be completed in THIS Research: a t1 already held after the event,
        // or budget left for the one t1 read as well.
        const needed = gate.observation.decision === "POST_EVENT_SUPPLY_REQUIRED" ? 2 : 1;
        const ceiling = await unprotected();
        const reservedSoFar = (await readJobBudgetReserved(db, input.jobId))?.sourceOpens ?? null;
        const affordable = reservedSoFar !== null && reservedSoFar + needed <= ceiling;
        if (!affordable || !(await reserveJobBudget(db, input.jobId, "sourceOpens", 1, ceiling))) {
          await t0Trace("CANDIDATE_SKIPPED_BUDGET", "SKIPPED", "SOURCE_OPEN_BUDGET_EXHAUSTED");
          historicalRead = read("BUDGET_EXHAUSTED");
        } else {
          await t0Trace("FETCH_ATTEMPTED", "OK", "NONE");
          let t0: OnchainArtifact | null = null;
          try {
            t0 = await retriever.retrieve(t0Intent);
          } catch {
            t0 = null;
          }
          const persisted =
            t0 === null
              ? null
              : await persistOnchainArtifact({
                  db,
                  origin: { kind: "RESEARCH_JOB", jobId: input.jobId },
                  artifact: t0,
                  identity,
                });
          // The adapter pins the read to the requested block; anything else
          // is not the observation that was asked for.
          if (
            t0 === null ||
            persisted === null ||
            persisted.rejectedReason !== null ||
            persisted.artifactId === null ||
            t0.provenance.slot !== block
          ) {
            await t0Trace("FETCH_FAILED", "FAILED", "PROVIDER_ERROR");
            historicalRead = read("RETRIEVAL_FAILED", 1);
          } else {
            await t0Trace("FETCH_OK", "OK", "NONE");
            historicalRead = read("ACQUIRED", 1, persisted.artifactId);
            // The gate asked again, over the rows now held. Nothing else.
            gate = decide(await loadHistorical());
          }
        }
      }
    }
  }

  const base = { gate, watermarkSlot: watermark.eventSlot, historicalRead };
  if (gate.decision === "NO_ACTION") return { ...none, ...base };

  // --- the t1 one-shot ------------------------------------------------------
  if (await postEventSupplyOpportunityConsumed(db, input.jobId)) {
    return { ...none, ...base, outcome: "OPPORTUNITY_ALREADY_CONSUMED" };
  }

  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: environment.chain,
    network: environment.network,
    projectAnchor: anchor,
    subjectKind: "token",
    subject: anchor,
  };
  const uri = buildCanonicalOnchainUri(intent);

  const retriever = resolveRetriever();
  if (retriever === null) return { ...none, ...base, outcome: "ACQUISITION_UNAVAILABLE" };
  if (!retriever.supports(intent.chain, intent.network, intent.kind)) {
    return { ...none, ...base, outcome: "ACQUISITION_UNAVAILABLE" };
  }

  const trace = traceFor(uri);

  // THE UNPROTECTED CEILING — not the job ceiling, because this read holds
  // no protected allocation and must not be able to take one.
  //
  // It proceeds only on capacity nothing else needed. A guaranteed anchor
  // read and a still-reachable promotion chain both keep their protection
  // against it exactly as they do against documentary acquisition, so this
  // opportunistic read cannot make deterministic work unaffordable. When
  // only protected capacity remains it refuses cleanly and says so, which is
  // a limit on what this run observed and never a statement about the token.
  //
  // The job's own maxSourceOpens is unchanged and still bounds everything:
  // this is protection inside the existing hard ceiling, never an extra
  // allowance.
  const reserved = await reserveJobBudget(db, input.jobId, "sourceOpens", 1, await unprotected());
  if (!reserved) {
    await trace("CANDIDATE_SKIPPED_BUDGET", "SKIPPED", "SOURCE_OPEN_BUDGET_EXHAUSTED");
    return { ...none, ...base, outcome: "BUDGET_EXHAUSTED" };
  }
  await trace("FETCH_ATTEMPTED", "OK", "NONE");

  let artifact: OnchainArtifact;
  try {
    artifact = await retriever.retrieve(intent);
  } catch {
    await trace("FETCH_FAILED", "FAILED", "PROVIDER_ERROR");
    return { ...none, ...base, outcome: "RETRIEVAL_FAILED", sourceOpensSpent: 1 };
  }

  // The canonical persistence path, artifact only. Deliberately NOT the
  // fact-writing one: a TOKEN_SUPPLY Evidence row filed here would enter
  // reconciliation, and no component asked for this reading.
  const persisted = await persistOnchainArtifact({
    db,
    origin: { kind: "RESEARCH_JOB", jobId: input.jobId },
    artifact,
    identity,
  });
  if (persisted.rejectedReason !== null || persisted.artifactId === null) {
    await trace("FETCH_FAILED", "FAILED", "PROVIDER_ERROR");
    return { ...none, ...base, outcome: "RETRIEVAL_FAILED", sourceOpensSpent: 1 };
  }
  await trace("FETCH_OK", "OK", "NONE");

  // TEMPORAL USEFULNESS IS A SEPARATE QUESTION FROM VALIDITY. The observation
  // is real and stays persisted either way; whether it can close the interval
  // is decided by the same strict comparison the selector applies, and a
  // reading at the watermark's own slot is refused for the same fail-closed
  // reason. Either way: no second call.
  const observedSlot = artifact.provenance.slot;
  return {
    ...none,
    ...base,
    outcome:
      observedSlot > watermark.eventSlot ? "ACQUIRED" : "NOT_STRICTLY_AFTER_EVENT",
    sourceOpensSpent: 1,
    artifactId: persisted.artifactId,
    observedSlot,
  };
}
