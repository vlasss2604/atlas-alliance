// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) —
// strictly READ-ONLY inspection script. No INSERT/UPDATE/DELETE
// anywhere in this file, on any table. Repeated execution against an
// unchanged job produces semantically identical output — every section
// below is a deterministic SELECT/format of already-persisted rows,
// nothing computed from wall-clock time or randomness.
//
// Usage: tsx scripts/alpha-inspect.ts <jobId>
import { desc, eq, sql } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { readAcquisitionPhase } from "../src/server/jobs/acquisition-phase-worker";
import {
  evidence,
  interpretations,
  memoryRetrievals,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchMechanismAssembly,
  researchPlans,
  researchTraceEvents,
} from "../src/server/db/schema";

function line(label: string, value: unknown) {
  console.log(`  ${label}: ${value === null || value === undefined ? "(none)" : String(value)}`);
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("usage: tsx scripts/alpha-inspect.ts <jobId>");
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  try {
    const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    if (!job) {
      console.error(`no research job found: ${jobId}`);
      process.exit(1);
    }

    section("JOB");
    line("id", job.id);
    line("state", job.state);
    line("createdAt", job.createdAt.toISOString());
    line("startedAt", job.startedAt?.toISOString() ?? null);
    line("finishedAt", job.finishedAt?.toISOString() ?? null);
    line("entitlementAtStart", job.entitlementAtStart);
    line("capabilityAtStart", job.capabilityAtStart);

    // D-136 — which network-capability phase this job is crossing, and
    // whether that phase still has work in front of it. NULL means the
    // job does not use the phased path at all (every historical row).
    section("ACQUISITION PHASE (D-136)");
    const phase = await readAcquisitionPhase(db, jobId);
    if (!phase || phase.phase === null) {
      line("acquisitionPhase", "(none — single-process job)");
    } else {
      line("acquisitionPhase", phase.phase);
      line("lastTransition", phase.at ? phase.at.toISOString() : null);
      line("pendingFetchTargets", phase.pendingTargets);
      line("sealedDocuments", phase.sealedDocuments);
    }

    section("INPUT");
    line("originalQuestion", job.originalQuestion);
    line("normalizedTask", job.normalizedTask ? JSON.stringify(job.normalizedTask) : null);

    section("NORMALIZED INTENT");
    const [interp] = await db
      .select()
      .from(interpretations)
      .where(eq(interpretations.researchJobId, jobId))
      .orderBy(desc(interpretations.createdAt))
      .limit(1);
    if (interp && interp.result && typeof interp.result === "object") {
      const r = interp.result as { normalized_intent?: unknown; task_type?: unknown; intent_confidence?: unknown };
      line("normalized_intent", r.normalized_intent ?? null);
      line("task_type", r.task_type ?? null);
      line("intent_confidence", r.intent_confidence ?? null);
    } else {
      console.log("  (no interpretation row for this job)");
    }

    section("PLAN / CONTRACT");
    const [plan] = await db
      .select()
      .from(researchPlans)
      .where(eq(researchPlans.researchJobId, jobId))
      .orderBy(desc(researchPlans.version))
      .limit(1);
    if (plan) {
      line("version", plan.version);
      line("mode", plan.mode);
      line("memoryUsed", plan.memoryUsed);
      const contract = plan.contract as { alreadySatisfiedSteps?: unknown; patternVersion?: unknown };
      line("patternVersion", contract.patternVersion ?? null);
      line("alreadySatisfiedSteps", JSON.stringify(contract.alreadySatisfiedSteps ?? []));
    } else {
      console.log("  (no plan persisted for this job)");
    }

    section("MEMORY");
    if (plan) {
      const retrievals = await db.select().from(memoryRetrievals).where(eq(memoryRetrievals.planId, plan.id));
      if (retrievals.length === 0) {
        console.log("  (no memory retrieval recorded)");
      }
      for (const r of retrievals) {
        console.log(`  retrieved=${r.retrievedCount} applied=${r.appliedCount} durationMs=${r.durationMs}`);
      }
    } else {
      console.log("  (no plan, no memory retrieval)");
    }

    section("S4 ATTEMPTS");
    const attempts = await db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    if (attempts.length === 0) console.log("  (no attempts persisted)");
    for (const a of attempts.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
      console.log(
        `  step=${a.patternStep} component=${a.component} attempt#${a.attemptNumber} status=${a.status} reason=${a.reason ?? "(none)"}`,
      );
    }

    const traceRows = await db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
    const sorted = [...traceRows].sort((a, b) => a.sequence - b.sequence);
    const byOp = (ops: string[]) => sorted.filter((t) => ops.includes(t.operationType));

    // §9 (S10 final pre-smoke closure, D-120): every real external model
    // generation attempt (QueryProposer or EvidenceExtractor) — including
    // a FAILED attempt that preceded a successful retry — must be
    // inspectable: role/provider/status/budget authorization/safe reason/
    // tokens/cost where available. Never prompts/completions/CoT/raw
    // errors (those are never persisted to trace at all, §A/§M).
    section("MODEL CALLS");
    const modelCallEvents = byOp(["MODEL_CALL_ATTEMPTED", "MODEL_CALL_SKIPPED"]);
    if (modelCallEvents.length === 0) console.log("  (no model-call trace)");
    for (const t of modelCallEvents) {
      // LOW (S10 LAST HIGH CLOSURE, D-121): providerName distinguishes a
      // fixture MODEL_CALL_ATTEMPTED ("non-live-fixture") from a real
      // live call ("anthropic") — shown explicitly, never just providerKind
      // (role), so this cannot be visually mistaken for live traffic.
      console.log(
        `  [#${t.sequence}] ${t.operationType} role=${t.providerKind ?? "(none)"} providerName=${t.providerName ?? "(none)"} status=${t.status} reason=${t.reasonCode} ` +
          `budgetAmount=${t.budgetAmount ?? "(none)"} inputTokens=${t.actualInputTokens ?? "(n/a)"} outputTokens=${t.actualOutputTokens ?? "(n/a)"} ` +
          `actualCostMicro=${t.actualCostMicro ?? "(n/a)"}`,
      );
    }

    section("SEARCH");
    const searchEvents = byOp(["QUERY_PROPOSED", "SEARCH_EXECUTED", "MODEL_CALL_SKIPPED"]);
    if (searchEvents.length === 0) console.log("  (no search trace)");
    for (const t of searchEvents) {
      console.log(`  [#${t.sequence}] ${t.operationType} status=${t.status} reason=${t.reasonCode} target=${t.targetRef ?? "(none)"}`);
    }

    section("SOURCE CANDIDATES");
    const candidateEvents = byOp(["CANDIDATE_RETURNED", "CANDIDATE_DEDUPED", "CANDIDATE_SKIPPED_BUDGET"]);
    if (candidateEvents.length === 0) console.log("  (no candidate trace)");
    for (const t of candidateEvents) {
      console.log(`  [#${t.sequence}] ${t.operationType} status=${t.status} reason=${t.reasonCode} target=${t.targetRef ?? "(none)"}`);
    }

    section("FETCHES");
    const fetchEvents = byOp(["FETCH_ATTEMPTED", "FETCH_OK", "FETCH_FAILED"]);
    if (fetchEvents.length === 0) console.log("  (no fetch trace)");
    for (const t of fetchEvents) {
      console.log(`  [#${t.sequence}] ${t.operationType} status=${t.status} reason=${t.reasonCode} target=${t.targetRef ?? "(none)"}`);
    }

    const extractEvents = byOp(["EXTRACT_ATTEMPTED", "EXTRACT_OK", "EXTRACT_FAILED", "REJECTED_WRONG_PROJECT", "REJECTED_WRONG_COMPONENT", "REJECTED_NOT_TRACEABLE"]);
    section("EXTRACTION");
    if (extractEvents.length === 0) console.log("  (no extraction trace)");
    for (const t of extractEvents) {
      console.log(
        `  [#${t.sequence}] ${t.operationType} status=${t.status} reason=${t.reasonCode} target=${t.targetRef ?? "(none)"}` +
          (t.evidenceId ? ` evidenceId=${t.evidenceId}` : ""),
      );
    }

    section("EVIDENCE");
    const evidenceRows = await db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    if (evidenceRows.length === 0) console.log("  (no admissible evidence persisted)");
    for (const e of evidenceRows) {
      console.log(`  id=${e.id} step=${e.patternStep} component=${e.component} sourceId=${e.sourceId} relationship=${e.relationship}`);
    }

    section("S5");
    const s5 = await db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
    if (s5.length === 0) console.log("  (no S5 component results)");
    for (const r of s5) {
      console.log(`  step=${r.patternStep} component=${r.component} status=${r.status}`);
    }

    section("S6");
    const [s6] = await db.select().from(researchMechanismAssembly).where(eq(researchMechanismAssembly.researchJobId, jobId));
    if (!s6) {
      console.log("  (no S6 assembly persisted)");
    } else {
      line("flows", s6.flows.length);
      line("unassignedGaps", s6.unassignedGaps.length);
    }

    section("S7");
    const [s7] = await db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
    if (!s7) {
      console.log("  (no S7 claim support persisted)");
    } else {
      line("intent", s7.intent);
      line("status", s7.status);
      line("reasonCodes", JSON.stringify(s7.reasonCodes));
    }

    section("BUDGET");
    const budget = job.budgetAtStart as { maxSearchQueries: number; maxSourceOpens: number; maxModelCostMicro: number };
    console.log(`  search queries:   ${job.searchQueriesReserved} / ${budget.maxSearchQueries}`);
    console.log(`  source opens:     ${job.sourceOpensReserved} / ${budget.maxSourceOpens}`);
    // S10 (live-provider-enablement.md §7) — MODEL COST distinguishes
    // reserved (the authoritative execution ceiling, research_jobs.*
    // Reserved) from actual (audit-only, summed from real provider usage
    // persisted on the operational trace) from limit (the job's budget
    // envelope) — never conflated, never a second budget authority.
    // S10 acceptance closure (MEDIUM-1, D-119): actual cost is calculated
    // from MODEL_CALL_ATTEMPTED audit rows only (QUERY_PROPOSED/EXTRACT_OK
    // no longer carry usage) — no ::int narrowing, SUM(bigint) stays
    // numeric-safe.
    const [{ actualCostMicroSum }] = (
      await db.execute(
        sql`SELECT COALESCE(SUM(actual_cost_micro), 0) AS "actualCostMicroSum" FROM research_trace_events WHERE research_job_id = ${jobId} AND operation_type = 'MODEL_CALL_ATTEMPTED'`,
      )
    ).rows as [{ actualCostMicroSum: number }];
    console.log(`  model cost micro: reserved=${job.modelCostMicroReserved} actual=${actualCostMicroSum} limit=${budget.maxModelCostMicro}`);

    section("TERMINATION");
    line("state", job.state);
    line("termination_reason", job.terminationReason);
    line("error_code", job.errorCode);

    section("WARNINGS");
    const warnings: string[] = [];
    if (["QUEUED", "RUNNING", "AWAITING_CLARIFICATION"].includes(job.state)) {
      warnings.push("job has not reached a terminal state yet");
    }
    if (attempts.length > 0 && traceRows.length === 0) {
      warnings.push("attempts exist but no trace events were recorded for this job");
    }
    if (warnings.length === 0) console.log("  (none)");
    for (const w of warnings) console.log(`  - ${w}`);
    console.log("");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
