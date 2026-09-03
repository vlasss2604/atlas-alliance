import { and, eq, inArray } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchTraceEvents } from "../db/schema";
import { resolveConfirmedIdentity } from "../domain/project-identity";
import { reserveJobBudget } from "./budget-reservation";
import { persistOnchainArtifact } from "./onchain-acquisition";
import { gateCurrentProofSupplyAcquisition } from "./onchain-current-proof-supply-gate";
import type { CurrentProofSupplyGate } from "./onchain-current-proof-supply-gate";
import { planPostEventSupplyAcquisition } from "./onchain-post-event-supply-plan";
import {
  loadCurrentJobBurnEvents,
  loadCurrentJobSupplyObservations,
  loadHistoricalSupplyCandidates,
} from "./onchain-supply-candidate-store";
import { buildCanonicalOnchainUri, parseCanonicalOnchainUri } from "./onchain-uri";
import {
  onchainRetrievalAvailable,
  resolveOnchainRetriever,
  type OnchainRetriever,
} from "./providers/onchain-retriever";
import type { OnchainArtifact, OnchainIntent } from "./providers/onchain-types";
import { recordTraceEvent } from "./trace-store";

// ONE POST-EVENT TOKEN_SUPPLY ACQUISITION, PER RESEARCH JOB, EVER.
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

export interface PostEventSupplyCompletion {
  outcome: PostEventSupplyOutcome;
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
const TOKEN_SUPPLY_INTENT_PATH = buildCanonicalOnchainUri({
  kind: "TOKEN_SUPPLY",
  chain: "solana",
  network: "mainnet",
  projectAnchor: "A",
  subjectKind: "token",
  subject: "A",
}).split("/").pop()!;

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
    return true;
  }
  return false;
}

export async function runPostEventSupplyCompletion(
  db: Database | Transaction,
  input: {
    jobId: string;
    projectId: string | null;
    maxSourceOpens: number;
    // Test seam only, exactly as the acquisition leaf's own. Absent means
    // "resolve the production retriever, if this process has one".
    retriever?: OnchainRetriever | null;
  },
): Promise<PostEventSupplyCompletion> {
  const none: PostEventSupplyCompletion = {
    outcome: "NO_ACTION",
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
  if (!identity?.tokenAddress || identity.chain !== "solana") return none;
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
      chain: "solana",
      network: "mainnet",
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

  const historicalCandidates = (
    await loadHistoricalSupplyCandidates(db, {
      currentResearchJobId: input.jobId,
      projectAnchor: anchor,
      chain: "solana",
      network: "mainnet",
      beforeSlot: watermark.eventSlot,
    })
  ).map((o) => o.observation);

  const gate = gateCurrentProofSupplyAcquisition({
    currentResearchJobId: input.jobId,
    currentProjectAnchor: anchor,
    events,
    observations,
    historicalCandidates,
  });
  const base = { gate, watermarkSlot: watermark.eventSlot };
  if (gate.decision === "NO_ACTION") return { ...none, ...base };

  // --- the one-shot -------------------------------------------------------
  if (await postEventSupplyOpportunityConsumed(db, input.jobId)) {
    return { ...none, ...base, outcome: "OPPORTUNITY_ALREADY_CONSUMED" };
  }

  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "token",
    subject: anchor,
  };
  const uri = buildCanonicalOnchainUri(intent);

  // An unconfigured environment simply has no structured capability. Nothing
  // is attempted, nothing is spent, and no marker is written — a process that
  // cannot reach a chain must not spend the opportunity of one that can.
  let retriever: OnchainRetriever;
  if (input.retriever) retriever = input.retriever;
  else if (input.retriever === null) return { ...none, ...base, outcome: "ACQUISITION_UNAVAILABLE" };
  else if (onchainRetrievalAvailable()) retriever = resolveOnchainRetriever();
  else return { ...none, ...base, outcome: "ACQUISITION_UNAVAILABLE" };
  if (!retriever.supports(intent.chain, intent.network, intent.kind)) {
    return { ...none, ...base, outcome: "ACQUISITION_UNAVAILABLE" };
  }

  // COMPONENT-LESS BY CONSTRUCTION. This completion belongs to no component:
  // it is cross-component temporal research. Carrying one would consume that
  // component's own bounded reactivation opportunity, which it has not had.
  const trace = async (
    operationType: (typeof ONE_SHOT_OPERATIONS)[number] | "FETCH_OK" | "FETCH_FAILED",
    status: "OK" | "FAILED" | "SKIPPED",
    reasonCode: "NONE" | "SOURCE_OPEN_BUDGET_EXHAUSTED" | "PROVIDER_ERROR",
  ): Promise<void> => {
    await recordTraceEvent(db, {
      researchJobId: input.jobId,
      researchAttemptId: null,
      operationType,
      providerKind: "FETCH",
      targetRef: uri,
      status,
      reasonCode,
      budgetAxis: "sourceOpens",
      budgetAmount: 1,
    });
  };

  // THE FULL, UNCHANGED JOB CEILING — not a protected allocation, because
  // this read has none. It proceeds only on capacity nothing else needed.
  const reserved = await reserveJobBudget(db, input.jobId, "sourceOpens", 1, input.maxSourceOpens);
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
