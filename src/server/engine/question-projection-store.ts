import { and, eq } from "drizzle-orm";

import { loadProductConfig } from "../config/product";
import type { Database, Transaction } from "../db/client";
import {
  proofs,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchPatterns,
  researchQuestionProjections,
} from "../db/schema";
import { intentRequirementsFor, patternContentSchema } from "../domain/pattern";
import {
  calculateActualCostMicro,
  loadModelCostProfile,
  ModelCostProfileMissingError,
} from "./model-cost-profile";
import {
  buildProjectionInput,
  validateProjection,
  PROJECTION_VERSION,
  type ProjectionModelInput,
} from "./question-projection";
import {
  createAnthropicQuestionProjector,
  QuestionProjectionUnavailableError,
  type ProjectionFailureCode,
  type QuestionProjectionProvider,
} from "./providers/question-projection-anthropic";
import type { ModelUsage } from "./providers/types";

// GENERATE ONCE, AFTER RESEARCH, AND NEVER FROM A READ PATH.
//
// This is the ONLY place a projection model call can originate. Nothing on
// the result route, the finding expansion or the evidence drill-down can
// reach it — they read the persisted row or fall back, which is what makes
// "one model call per Proof" a structural property rather than a habit.
//
// The (job, projection_version) unique index is the enforcement. A
// terminal FAILURE occupies that slot exactly as a success does, so a
// projection that failed is never silently retried by the next page load.
// Regeneration is authorised only by bumping PROJECTION_VERSION, which is
// a code change a human makes deliberately.
//
// FAILURE IS ISOLATED, BY CONSTRUCTION.
//
// Every path in this module returns rather than throws. The caller
// (run-job.ts) invokes it after the Proof is built, and a projection that
// fails leaves the job state, the S7 verdict, the Proof and every
// component result exactly as canonical research left them. A projection
// is how an answer is ARRANGED; it can never be part of what the answer
// says, so its failure cannot mean anything about a project.

export type ProjectionOutcome =
  | { kind: "SKIPPED"; reason: "ALREADY_EXISTS" | "NOT_PROJECTABLE" | "NO_COST_PROFILE" }
  | { kind: "VALID"; findingCount: number }
  | { kind: "FAILED_VALIDATION" }
  | { kind: "FAILED_MODEL" };

// AUDIT ONLY. Model id, real usage, and the cost computed from the
// approved catalogue — never read back as research input, and never
// carrying provider text.
interface ProjectionModelMeta {
  modelId: string;
  role: "PROJECTION";
  priceVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  actualCostMicroUsd: number | null;
  unsupportedBillingUsage: boolean;
  failureCode: ProjectionFailureCode | null;
  rejection: string | null;
}

export async function generateQuestionProjection(
  db: Database | Transaction,
  jobId: string,
  deps?: { provider?: QuestionProjectionProvider },
): Promise<ProjectionOutcome> {
  // ---- one row per (job, version): the call gate ------------------------
  const [existing] = await db
    .select({ id: researchQuestionProjections.id })
    .from(researchQuestionProjections)
    .where(
      and(
        eq(researchQuestionProjections.researchJobId, jobId),
        eq(researchQuestionProjections.projectionVersion, PROJECTION_VERSION),
      ),
    );
  if (existing) return { kind: "SKIPPED", reason: "ALREADY_EXISTS" };

  const [job] = await db
    .select({
      id: researchJobs.id,
      state: researchJobs.state,
      topicId: researchJobs.topicId,
      originalQuestion: researchJobs.originalQuestion,
    })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  if (!job) return { kind: "SKIPPED", reason: "NOT_PROJECTABLE" };

  // Only a run that produced a projectable canonical result. A job that
  // broke or was cancelled has nothing to arrange, and arranging a partial
  // result as though it were an answer is exactly the failure mode the
  // fallback exists to avoid.
  if (job.state !== "SUCCEEDED" && job.state !== "BUDGET_LIMIT_REACHED") {
    return { kind: "SKIPPED", reason: "NOT_PROJECTABLE" };
  }

  const [proof] = await db.select({ id: proofs.id }).from(proofs).where(eq(proofs.researchJobId, jobId));
  if (!proof) return { kind: "SKIPPED", reason: "NOT_PROJECTABLE" };

  const componentRows = await db
    .select({
      patternStep: researchComponentResults.patternStep,
      component: researchComponentResults.component,
      status: researchComponentResults.status,
      reasonCodes: researchComponentResults.reasonCodes,
      supportingEvidenceIds: researchComponentResults.supportingEvidenceIds,
      contradictingEvidenceIds: researchComponentResults.contradictingEvidenceIds,
    })
    .from(researchComponentResults)
    .where(eq(researchComponentResults.researchJobId, jobId))
    .orderBy(researchComponentResults.patternStep);
  if (componentRows.length === 0) return { kind: "SKIPPED", reason: "NOT_PROJECTABLE" };

  // ---- coverage, the same conservative rule the result view uses --------
  const attemptRows = await db
    .select({
      patternStep: researchAttempts.patternStep,
      component: researchAttempts.component,
      status: researchAttempts.status,
    })
    .from(researchAttempts)
    .where(eq(researchAttempts.researchJobId, jobId));
  const attempts = new Map<string, { ok: number; failed: number; other: number }>();
  for (const a of attemptRows) {
    const key = `${a.patternStep}:${a.component}`;
    const acc = attempts.get(key) ?? { ok: 0, failed: 0, other: 0 };
    if (a.status === "SUCCEEDED") acc.ok += 1;
    else if (a.status === "FAILED") acc.failed += 1;
    else acc.other += 1;
    attempts.set(key, acc);
  }
  const coverageOf = (step: number, component: string): string => {
    const acc = attempts.get(`${step}:${component}`);
    if (!acc) return "NOT_ATTEMPTED";
    if (acc.ok === 0 && acc.failed === 0) return "NOT_ATTEMPTED";
    if (acc.ok === 0 && acc.failed > 0) return "BLOCKED";
    if (acc.failed === 0 && acc.other === 0) return "COMPLETED";
    return "PARTIAL";
  };

  // ---- S7 requirements, joined to their Pattern definitions -------------
  const [claim] = await db
    .select({
      intent: researchClaimSupport.intent,
      patternVersion: researchClaimSupport.patternVersion,
      requirementResults: researchClaimSupport.requirementResults,
    })
    .from(researchClaimSupport)
    .where(eq(researchClaimSupport.researchJobId, jobId));

  const patternVersion = claim?.patternVersion ?? 0;

  // THE REQUIREMENT'S KIND COMES FROM THE PATTERN THE JOB RAN UNDER.
  //
  // The persisted result carries only `requirementId`. Reading the kind
  // from the Pattern at exactly that version is what keeps this join
  // honest: a requirement the Pattern no longer declares is DROPPED rather
  // than given an invented kind, and a projection is never offered a
  // reference it could not describe.
  //
  // Every failure here is tolerated, because a projection is presentation:
  // a missing or unparseable Pattern costs the requirement inputs and
  // nothing else. The component results alone are still a valid input.
  const requirements: { requirementId: string; kind: string; status: string; evidenceCount: number }[] = [];
  if (claim) {
    try {
      const [patternRow] = await db
        .select({ content: researchPatterns.content })
        .from(researchPatterns)
        .where(
          and(
            eq(researchPatterns.topicId, job.topicId),
            eq(researchPatterns.version, claim.patternVersion),
          ),
        );
      if (patternRow) {
        const content = patternContentSchema.parse(patternRow.content);
        const byId = new Map(
          intentRequirementsFor(content, claim.intent).requirements.map((r) => [r.requirementId, r.kind]),
        );
        for (const rr of claim.requirementResults ?? []) {
          const kind = byId.get(rr.requirementId);
          if (!kind) continue;
          requirements.push({
            requirementId: rr.requirementId,
            kind,
            status: rr.status,
            evidenceCount: rr.provenance?.evidenceIds?.length ?? 0,
          });
        }
      }
    } catch {
      requirements.length = 0;
    }
  }

  const input: ProjectionModelInput = buildProjectionInput({
    question: job.originalQuestion,
    intent: claim?.intent ?? null,
    components: componentRows.map((c) => ({
      patternStep: c.patternStep,
      component: c.component,
      status: c.status,
      reasonCodes: Array.isArray(c.reasonCodes) ? c.reasonCodes : [],
      coverage: coverageOf(c.patternStep, c.component),
      supportingEvidenceIds: Array.isArray(c.supportingEvidenceIds) ? c.supportingEvidenceIds : [],
      contradictingEvidenceIds: Array.isArray(c.contradictingEvidenceIds) ? c.contradictingEvidenceIds : [],
    })),
    requirements,
  });

  // ---- the one bounded call ---------------------------------------------
  const config = await loadProductConfig(db);
  const modelId = config.projection_model;
  let profile;
  try {
    profile = loadModelCostProfile("PROJECTION", modelId);
  } catch (e) {
    // D-090 fail-closed: an unapproved (role, model) pair never calls.
    if (e instanceof ModelCostProfileMissingError) return { kind: "SKIPPED", reason: "NO_COST_PROFILE" };
    throw e;
  }

  let usage: ModelUsage | null = null;
  const provider =
    deps?.provider ??
    createAnthropicQuestionProjector(modelId, profile.maxOutputTokens, profile.maxInputTokens, (u) => {
      usage = u;
    });

  const meta = (over: Partial<ProjectionModelMeta>): ProjectionModelMeta => ({
    modelId,
    role: "PROJECTION",
    priceVersion: profile.priceVersion,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    actualCostMicroUsd: usage ? calculateActualCostMicro(profile, usage) : null,
    unsupportedBillingUsage: usage?.unsupportedBillingUsage ?? false,
    failureCode: null,
    rejection: null,
    ...over,
  });

  const persist = async (
    status: "VALID" | "FAILED_VALIDATION" | "FAILED_MODEL",
    findings: unknown[],
    modelMeta: ProjectionModelMeta,
  ) => {
    await db
      .insert(researchQuestionProjections)
      .values({
        researchJobId: jobId,
        projectionVersion: PROJECTION_VERSION,
        patternVersion,
        status,
        findings,
        modelMeta,
      })
      // A concurrent worker may have written the same slot first. That is
      // the uniqueness guarantee doing its job, not an error.
      .onConflictDoNothing();
  };

  let raw: unknown;
  try {
    raw = await provider.project(input);
  } catch (e) {
    const code: ProjectionFailureCode =
      e instanceof QuestionProjectionUnavailableError ? e.code : "PROVIDER_ERROR";
    await persist("FAILED_MODEL", [], meta({ failureCode: code }));
    return { kind: "FAILED_MODEL" };
  }

  // ---- deterministic validation: the only thing that may admit ----------
  const validated = validateProjection(raw, input);
  if (!validated.ok) {
    // Nothing partial is stored. Half a relevance judgment is not a safer
    // relevance judgment, and a reader would have no way to know which
    // half was missing.
    await persist("FAILED_VALIDATION", [], meta({ rejection: validated.rejection }));
    return { kind: "FAILED_VALIDATION" };
  }

  await persist("VALID", validated.findings, meta({}));
  return { kind: "VALID", findingCount: validated.findings.length };
}

// The caller's wrapper: a projection failure must never surface as a
// research failure. Everything is already returned rather than thrown
// inside, so this catches only the genuinely unexpected — a database
// error, a bug — and swallows it for the same reason.
export async function generateQuestionProjectionSafely(
  db: Database | Transaction,
  jobId: string,
  deps?: { provider?: QuestionProjectionProvider },
): Promise<ProjectionOutcome> {
  try {
    return await generateQuestionProjection(db, jobId, deps);
  } catch {
    return { kind: "FAILED_MODEL" };
  }
}
