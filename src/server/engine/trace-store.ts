import { and, desc, eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts, researchJobs, researchTraceEvents } from "../db/schema";

// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) — the
// only writer of research_trace_events. Append-only by discipline: no
// function in this module updates or deletes a trace row, ever.
//
// Sequence allocation reuses the exact row-lock pattern controller.ts's
// claimAttempt already uses for research_attempts.attemptNumber
// (`SELECT id FROM research_jobs WHERE id = $1 FOR UPDATE`) — Postgres
// serializes concurrent transactions on the same job row, so two
// concurrent trace writes for the same job can never compute the same
// next sequence number. No new column on research_jobs, no separate
// synchronization primitive.

export interface TraceEventInput {
  researchJobId: string;
  researchAttemptId?: string | null;
  operationType: (typeof researchTraceEvents.$inferInsert)["operationType"];
  providerKind?: (typeof researchTraceEvents.$inferInsert)["providerKind"];
  providerName?: string | null;
  patternStep?: number | null;
  component?: string | null;
  targetRef?: string | null;
  status: (typeof researchTraceEvents.$inferInsert)["status"];
  reasonCode?: (typeof researchTraceEvents.$inferInsert)["reasonCode"];
  sourceId?: string | null;
  evidenceId?: string | null;
  budgetAxis?: (typeof researchTraceEvents.$inferInsert)["budgetAxis"];
  budgetAmount?: number | null;
}

// §M — a generous but finite bound on target_ref, defense in depth
// against ever persisting an unbounded body/response. Matches the DB
// CHECK constraint (ck_research_trace_events_target_ref_len); truncating
// here means a too-long value fails loudly in dev (the CHECK still
// exists) while normal operation never approaches the limit.
const MAX_TARGET_REF_LENGTH = 2048;

function boundTargetRef(ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  return ref.length > MAX_TARGET_REF_LENGTH ? ref.slice(0, MAX_TARGET_REF_LENGTH) : ref;
}

export class TracePersistenceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TracePersistenceError";
  }
}

// §5/§I — if a mandatory trace event cannot be persisted, this throws
// rather than swallowing the failure: a caller that treats a thrown
// TracePersistenceError as "research still completed normally" would be
// exactly the forbidden "trace persistence failure -> INSUFFICIENT_
// EVIDENCE" collapse. Callers that consider a given event optional/
// best-effort catch this explicitly at the call site instead of this
// function silently deciding that for them.
export async function recordTraceEvent(db: Database | Transaction, input: TraceEventInput): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`SELECT id FROM ${researchJobs} WHERE id = ${input.researchJobId} FOR UPDATE`);
      if (locked.rows.length === 0) {
        throw new TracePersistenceError(`trace event for unknown research job: ${input.researchJobId}`);
      }
      const [{ nextSeq }] = (
        await tx.execute(
          sql`SELECT COALESCE(MAX(sequence), 0) + 1 AS "nextSeq" FROM ${researchTraceEvents} WHERE research_job_id = ${input.researchJobId}`,
        )
      ).rows as [{ nextSeq: number }];

      await tx.insert(researchTraceEvents).values({
        researchJobId: input.researchJobId,
        researchAttemptId: input.researchAttemptId ?? null,
        sequence: nextSeq,
        operationType: input.operationType,
        providerKind: input.providerKind ?? null,
        providerName: input.providerName ?? null,
        patternStep: input.patternStep ?? null,
        component: input.component ?? null,
        targetRef: boundTargetRef(input.targetRef),
        status: input.status,
        reasonCode: input.reasonCode ?? "NONE",
        sourceId: input.sourceId ?? null,
        evidenceId: input.evidenceId ?? null,
        budgetAxis: input.budgetAxis ?? null,
        budgetAmount: input.budgetAmount ?? null,
      });
    });
  } catch (e) {
    if (e instanceof TracePersistenceError) throw e;
    throw new TracePersistenceError(`failed to persist trace event (${input.operationType})`, e);
  }
}

// Best-effort variant for genuinely optional/observational events — logs
// and swallows rather than failing the caller's attempt. Used ONLY where
// the caller has explicitly decided the event is non-mandatory; the
// default (recordTraceEvent) always propagates a persistence failure.
export async function recordTraceEventBestEffort(db: Database | Transaction, input: TraceEventInput): Promise<void> {
  try {
    await recordTraceEvent(db, input);
  } catch (e) {
    console.error("[trace-store] best-effort trace event failed to persist", e);
  }
}

// Looks up the current attempt's own id (claimAttempt in controller.ts
// does not thread it into WorkExecutor.execute's ctx) so trace events
// emitted from inside an executor can link to research_attempt_id
// without any change to controller.ts's signature or semantics.
export async function findAttemptId(
  db: Database | Transaction,
  jobId: string,
  step: number,
  component: string,
  attemptNumber: number,
): Promise<string | null> {
  const [row] = await db
    .select({ id: researchAttempts.id })
    .from(researchAttempts)
    .where(
      and(
        eq(researchAttempts.researchJobId, jobId),
        eq(researchAttempts.patternStep, step),
        eq(researchAttempts.component, component),
        eq(researchAttempts.attemptNumber, attemptNumber),
      ),
    )
    .orderBy(desc(researchAttempts.createdAt))
    .limit(1);
  return row?.id ?? null;
}
