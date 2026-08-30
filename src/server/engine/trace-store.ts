import { and, desc, eq, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchAttempts, researchJobs, researchTraceEvents } from "../db/schema";
import {
  CONTENT_FETCH_FAILURE_REASONS,
  type ContentFetchFailureReason,
} from "./providers/content-fetcher";
import {
  RENDERED_DOCS_FAILURE_REASONS,
  type RenderedDocsFailureReason,
} from "./providers/rendered-docs-fetcher";

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
  // D-143 — the provider's own categorical failure code, alongside (never
  // instead of) the canonical reasonCode. Typed to the fetch provider's
  // closed set so a caller cannot pass a raw message: the compiler refuses
  // anything that is not one of the provider's own literals, and the
  // writer re-checks membership at runtime.
  diagnosticCode?: ContentFetchFailureReason | RenderedDocsFailureReason | null;
  // S10 (live-provider-enablement.md §7) — AUDIT ONLY. See engine.ts's
  // column comments and model-cost-profile.ts's calculateActualCostMicro.
  actualInputTokens?: number | null;
  actualOutputTokens?: number | null;
  actualCostMicro?: number | null;
}

// §M — a generous but finite bound on target_ref, defense in depth
// against ever persisting an unbounded body/response. Matches the DB
// CHECK constraint (ck_research_trace_events_target_ref_len). Truncation
// happens here BEFORE insert, so in normal operation the CHECK never
// actually fires on this code path — it exists as a second, DB-level
// backstop in case some future writer of this table ever bypasses
// recordTraceEvent, not because this function is expected to let an
// over-length value slip through to the database.
const MAX_TARGET_REF_LENGTH = 2048;

// MEDIUM-1 (Stage 2 acceptance closure, D-116) / S10 pre-live hardening
// (live-provider-enablement.md §13, D-118, now a MANDATORY pre-live
// requirement, not optional): deterministic redaction of common
// credential-bearing query parameters, URL userinfo, and credential-
// bearing URL fragments, applied to EVERY target_ref this module
// persists — not opt-in per call site. A search-result or fetch URL is
// attacker/provider-influenced content (D-070); storing it verbatim in
// an operational trace row would leak whatever query string, userinfo,
// or fragment it happened to carry (confirmed reproducible: a search
// result URL containing `?api_key=SECRET`). Query/text target_refs
// (QUERY_PROPOSED, SEARCH_EXECUTED) are not URLs — the regexes below only
// ever match an explicit `?name=value`/`&name=value`/`#name=value`
// assignment or a `user:pass@host` userinfo shape, so plain query text
// passes through unchanged. This is trace sanitization only: it never
// touches the actual URL passed to ContentFetcher.fetch, and it never
// mutates the Evidence table's own provenance columns or the sources
// table's URL column — S4's admission/provenance semantics are
// unaffected (§7 of the Stage 2 doc). Do NOT overstate the guarantee:
// this is the currently APPROVED list (§6/§13 of the S10 spec), not an
// exhaustive enumeration of every possible credential-bearing URL shape.
const SENSITIVE_URL_PARAM_NAMES = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "auth",
  "authorization",
  "signature",
  "sig",
  "secret",
  "auth_token",
  "refresh_token",
  "client_secret",
  "password",
  "session",
]);

const REDACTED = "[REDACTED]";

// Deliberately string-based rather than round-tripped through the `URL`/
// `URLSearchParams` API: re-serializing via `searchParams.set()` would
// percent-encode "[REDACTED]" (and could re-normalize/reorder the rest
// of the query string) — neither deterministic-looking nor necessary. A
// direct regex replace on the raw text leaves every other character
// untouched and produces the exact literal `key=[REDACTED]` value.
export function redactUrl(raw: string): string {
  const namePattern = [...SENSITIVE_URL_PARAM_NAMES].join("|");
  // §13: query parameters AND credential-bearing fragments (e.g.
  // `#access_token=...`, `#token=...`) — the same closed name list,
  // matched after `?`, `&`, or `#` alike, case-insensitive.
  let out = raw.replace(new RegExp(`([?&#](?:${namePattern})=)[^&#]*`, "gi"), `$1${REDACTED}`);
  // §13: URL userinfo (`https://user:password@host/...`) — redact
  // everything between the scheme separator and `@`, never the host.
  out = out.replace(/(:\/\/)[^/?#@\s]+@/g, `$1${REDACTED}@`);
  return out;
}

function boundTargetRef(ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  const redacted = redactUrl(ref);
  return redacted.length > MAX_TARGET_REF_LENGTH ? redacted.slice(0, MAX_TARGET_REF_LENGTH) : redacted;
}

// The exact canonical form a target_ref takes once persisted (redaction +
// length bound). Exported so the acquisition ledger can compare a LIVE
// candidate URL / query against what trace recorded by applying the same
// transformation to both sides — otherwise a redacted parameter or a
// truncated long URL would silently never match, and the ledger would
// re-buy work it had already recorded. Pure function; no behaviour change
// to what is written.
export function canonicalTargetRef(ref: string): string {
  return boundTargetRef(ref) ?? "";
}

// Is a value READ BACK from trace a lossy copy of the original?
//
// target_ref is written for observability, so it is deliberately
// redacted and length-bounded. That makes it safe to compare against
// (canonicalTargetRef applies the same transformation to both sides) but
// UNSAFE to use as a real URL: a redacted credential parameter or a
// truncated tail produces a different resource, and handing that to the
// fetcher would request the wrong thing. Any consumer that wants to reuse
// a trace value as an actual URL must exclude these first.
export function isLossyTargetRef(ref: string): boolean {
  return ref.includes(REDACTED) || ref.length >= MAX_TARGET_REF_LENGTH;
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
// D-143 — the only values this column may ever hold. Mirrors the
// safeFailureDetail discipline in s4-executor.ts: the closed set is the
// authority, not the caller's word.
// D-146 (owner-ratified) — the union of the TWO existing code-owned
// closed vocabularies, because acquisition now has two transports and
// each already classifies its own failures. Still no second taxonomy: no
// value here was invented for the diagnostic, and a render failure
// records the renderer's own reason rather than a fetch reason that would
// be false.
const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set<string>([
  ...CONTENT_FETCH_FAILURE_REASONS,
  ...RENDERED_DOCS_FAILURE_REASONS,
]);

function safeDiagnosticCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return DIAGNOSTIC_CODES.has(value) ? value : null;
}

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
        // Second, independent gate: a runtime value can violate a
        // compile-time union, so membership is re-checked here rather
        // than trusted. Anything else becomes null — the diagnostic is
        // audit-only and must never become a channel for arbitrary text.
        diagnosticCode: safeDiagnosticCode(input.diagnosticCode),
        actualInputTokens: input.actualInputTokens ?? null,
        actualOutputTokens: input.actualOutputTokens ?? null,
        actualCostMicro: input.actualCostMicro ?? null,
      });
    });
  } catch (e) {
    if (e instanceof TracePersistenceError) throw e;
    throw new TracePersistenceError(`failed to persist trace event (${input.operationType})`, e);
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
