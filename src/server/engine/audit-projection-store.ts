import { and, eq } from "drizzle-orm";

import { loadProductConfig } from "../config/product";
import type { Database, Transaction } from "../db/client";
import {
  evidence,
  proofs,
  researchAttempts,
  researchAuditProjections,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
} from "../db/schema";
import {
  buildAuditInput,
  validateAuditProjection,
  AUDIT_VERSION,
  type AuditModelInput,
  type AuditSection,
} from "./audit-projection";
import {
  calculateActualCostMicro,
  loadModelCostProfile,
  ModelCostProfileMissingError,
} from "./model-cost-profile";
import {
  AuditProjectionUnavailableError,
  createAnthropicAuditProjector,
  type AuditFailureCode,
  type AuditProjectionProvider,
} from "./providers/audit-projection-anthropic";
import type { ModelUsage } from "./providers/types";

// GENERATE AT MOST ONCE PER JOB, AND ONLY WHEN A HUMAN ASKS.
//
// Unlike the question projection — which runs after every completed Proof,
// from run-job.ts — an audit is generated ONLY from an explicit request.
// Most Proofs will never have a row here, because most readers never open
// an audit, and generating one for every Proof would be paying for a
// document nobody opened.
//
// That makes this the one projection whose call can originate from a
// request path, so the gate has to be exact:
//
//   - the (job, audit_version) unique index means at most one row exists;
//   - `loadAuditProjection` (the read) NEVER generates;
//   - this function returns SKIPPED/ALREADY_EXISTS the moment a row is
//     found, so a second click, a double-submit or a refresh cannot make
//     a second call;
//   - a terminal FAILURE occupies the slot exactly as a success does, so
//     re-opening a failed audit reads the failure rather than retrying
//     the model on every page load.
//
// FAILURE IS ISOLATED, BY CONSTRUCTION. Every path returns rather than
// throws. An audit is a way of ARRANGING a finished research record for
// inspection; it can never be part of what the research concluded, so its
// failure changes no job state, no verdict, no Proof and no component
// result. The Result page keeps working exactly as before.

export type AuditOutcome =
  | { kind: "SKIPPED"; reason: "ALREADY_EXISTS" | "NOT_AUDITABLE" | "NO_COST_PROFILE" }
  | { kind: "VALID" }
  | { kind: "FAILED_VALIDATION" }
  | { kind: "FAILED_MODEL" };

interface AuditModelMeta {
  modelId: string;
  role: "AUDIT";
  priceVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  actualCostMicroUsd: number | null;
  unsupportedBillingUsage: boolean;
  failureCode: AuditFailureCode | null;
  rejection: string | null;
  // WHICH label or sentence tripped the guard. The rejection CODE alone
  // says a rule fired; it does not say whether the rule was right, and a
  // validator nobody can diagnose is a validator that gets loosened for
  // the wrong reason. Bounded, and it is model output rather than
  // research: audit metadata only, never read back as input.
  rejectionDetail: string | null;
}

export interface PersistedAuditProjection {
  status: "VALID" | "FAILED_VALIDATION" | "FAILED_MODEL";
  content: {
    summary: string;
    sectionOrder: string[];
    scopeLabels: { patternStep: number; component: string; label: string }[];
  };
  createdAt: string;
}

// THE READ PATH, WHICH NEVER GENERATES. Separated from the generator
// deliberately: a read that could fall through to a model call is exactly
// how "one call per job" quietly becomes "one call per render".
export async function loadAuditProjection(
  db: Database | Transaction,
  jobId: string,
): Promise<PersistedAuditProjection | null> {
  const [row] = await db
    .select({
      status: researchAuditProjections.status,
      content: researchAuditProjections.content,
      createdAt: researchAuditProjections.createdAt,
    })
    .from(researchAuditProjections)
    .where(
      and(
        eq(researchAuditProjections.researchJobId, jobId),
        eq(researchAuditProjections.auditVersion, AUDIT_VERSION),
      ),
    );
  if (!row) return null;

  const content = (row.content ?? {}) as PersistedAuditProjection["content"];
  return {
    status: row.status,
    content: {
      summary: typeof content.summary === "string" ? content.summary : "",
      sectionOrder: Array.isArray(content.sectionOrder) ? content.sectionOrder : [],
      scopeLabels: Array.isArray(content.scopeLabels) ? content.scopeLabels : [],
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export async function generateAuditProjection(
  db: Database | Transaction,
  jobId: string,
  deps?: { provider?: AuditProjectionProvider },
): Promise<AuditOutcome> {
  // ---- one row per (job, version): the call gate ------------------------
  const [existing] = await db
    .select({ id: researchAuditProjections.id })
    .from(researchAuditProjections)
    .where(
      and(
        eq(researchAuditProjections.researchJobId, jobId),
        eq(researchAuditProjections.auditVersion, AUDIT_VERSION),
      ),
    );
  if (existing) return { kind: "SKIPPED", reason: "ALREADY_EXISTS" };

  const [job] = await db
    .select({
      id: researchJobs.id,
      state: researchJobs.state,
      originalQuestion: researchJobs.originalQuestion,
    })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId));
  if (!job) return { kind: "SKIPPED", reason: "NOT_AUDITABLE" };

  // Only a run that produced a canonical record worth inspecting. A broken
  // or cancelled run has no audit to prepare, and presenting one would
  // imply a completeness the record does not have.
  if (job.state !== "SUCCEEDED" && job.state !== "BUDGET_LIMIT_REACHED") {
    return { kind: "SKIPPED", reason: "NOT_AUDITABLE" };
  }
  const [proof] = await db
    .select({ id: proofs.id })
    .from(proofs)
    .where(eq(proofs.researchJobId, jobId));
  if (!proof) return { kind: "SKIPPED", reason: "NOT_AUDITABLE" };

  const componentRows = await db
    .select({
      patternStep: researchComponentResults.patternStep,
      component: researchComponentResults.component,
      status: researchComponentResults.status,
      reasonCodes: researchComponentResults.reasonCodes,
      supportingEvidenceIds: researchComponentResults.supportingEvidenceIds,
      contradictingEvidenceIds: researchComponentResults.contradictingEvidenceIds,
      excludedEvidence: researchComponentResults.excludedEvidence,
    })
    .from(researchComponentResults)
    .where(eq(researchComponentResults.researchJobId, jobId))
    .orderBy(researchComponentResults.patternStep);
  if (componentRows.length === 0) return { kind: "SKIPPED", reason: "NOT_AUDITABLE" };

  // ---- coverage, the same conservative rule every other surface uses ----
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

  const [claim] = await db
    .select({ intent: researchClaimSupport.intent })
    .from(researchClaimSupport)
    .where(eq(researchClaimSupport.researchJobId, jobId));

  // ---- sources, as CLASS + DOMAIN only ---------------------------------
  //
  // The model is told which kinds of source this run read and whether each
  // was used, because that is what its two summary sentences are about. It
  // is never given a document, a fragment, a title or a full url — there
  // is nothing here it could quote, and nothing it could turn into a fetch.
  const evidenceRows = await db
    .select({
      id: evidence.id,
      retrievedUrl: evidence.retrievedUrl,
      sourceClass: evidence.sourceClass,
    })
    .from(evidence)
    .where(eq(evidence.researchJobId, jobId));

  const usedEvidenceIds = new Set<string>();
  for (const c of componentRows) {
    for (const id of asStringArray(c.supportingEvidenceIds)) usedEvidenceIds.add(id);
    for (const id of asStringArray(c.contradictingEvidenceIds)) usedEvidenceIds.add(id);
  }
  const sourceByKey = new Map<string, { domain: string; sourceClass: string | null; used: boolean }>();
  for (const row of evidenceRows) {
    const key = row.retrievedUrl || row.id;
    const prev = sourceByKey.get(key);
    const used = usedEvidenceIds.has(row.id) || prev?.used === true;
    sourceByKey.set(key, {
      domain: domainOf(row.retrievedUrl),
      sourceClass: row.sourceClass ?? null,
      used,
    });
  }

  // Which sections canonical data can actually fill. The model orders what
  // exists; code decides what exists, and code re-adds anything the model
  // leaves out when the audit renders.
  const hasEvidenceLinks = componentRows.some(
    (c) =>
      asStringArray(c.supportingEvidenceIds).length > 0 ||
      asStringArray(c.contradictingEvidenceIds).length > 0 ||
      asExclusions(c.excludedEvidence).length > 0,
  );
  const availableSections: AuditSection[] = ["SUMMARY", "COVERAGE"];
  if (hasEvidenceLinks) availableSections.push("EVIDENCE_MAP");
  if (sourceByKey.size > 0) availableSections.push("SOURCE_REGISTER");
  availableSections.push("OPEN_QUESTIONS", "TRACE");

  const input: AuditModelInput = buildAuditInput({
    question: job.originalQuestion,
    intent: claim?.intent ?? null,
    components: componentRows.map((c) => ({
      step: c.patternStep,
      component: c.component,
      status: c.status,
      reasonCodes: asStringArray(c.reasonCodes),
      coverage: coverageOf(c.patternStep, c.component),
      supportingCount: asStringArray(c.supportingEvidenceIds).length,
      contradictingCount: asStringArray(c.contradictingEvidenceIds).length,
      excludedCount: asExclusions(c.excludedEvidence).length,
    })),
    sources: [...sourceByKey.entries()].map(([sourceKey, s]) => ({
      sourceKey,
      domain: s.domain,
      sourceClass: s.sourceClass,
      used: s.used,
    })),
    availableSections,
  });

  // ---- the one bounded call ---------------------------------------------
  const config = await loadProductConfig(db);
  const modelId = config.audit_model;
  let profile;
  try {
    profile = loadModelCostProfile("AUDIT", modelId);
  } catch (e) {
    // D-090 fail-closed: an unapproved (role, model) pair never calls.
    if (e instanceof ModelCostProfileMissingError) {
      return { kind: "SKIPPED", reason: "NO_COST_PROFILE" };
    }
    throw e;
  }

  let usage: ModelUsage | null = null;
  const provider =
    deps?.provider ??
    createAnthropicAuditProjector(modelId, profile.maxOutputTokens, profile.maxInputTokens, (u) => {
      usage = u;
    });

  const meta = (over: Partial<AuditModelMeta>): AuditModelMeta => ({
    modelId,
    role: "AUDIT",
    priceVersion: profile.priceVersion,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    actualCostMicroUsd: usage ? calculateActualCostMicro(profile, usage) : null,
    unsupportedBillingUsage: usage?.unsupportedBillingUsage ?? false,
    failureCode: null,
    rejection: null,
    rejectionDetail: null,
    ...over,
  });

  const persist = async (
    status: "VALID" | "FAILED_VALIDATION" | "FAILED_MODEL",
    content: unknown,
    modelMeta: AuditModelMeta,
  ) => {
    await db
      .insert(researchAuditProjections)
      .values({ researchJobId: jobId, auditVersion: AUDIT_VERSION, status, content, modelMeta })
      // A concurrent request may have written the same slot first. That is
      // the uniqueness guarantee working, not an error.
      .onConflictDoNothing();
  };

  const empty = { summary: "", sectionOrder: [], scopeLabels: [] };

  let raw: unknown;
  try {
    raw = await provider.project(input);
  } catch (e) {
    const code: AuditFailureCode =
      e instanceof AuditProjectionUnavailableError ? e.code : "PROVIDER_ERROR";
    await persist("FAILED_MODEL", empty, meta({ failureCode: code }));
    return { kind: "FAILED_MODEL" };
  }

  // ---- deterministic validation: the only thing that may admit ----------
  const validated = validateAuditProjection(raw, input);
  if (!validated.ok) {
    await persist(
      "FAILED_VALIDATION",
      empty,
      meta({
        rejection: validated.rejection,
        rejectionDetail: validated.detail.slice(0, 200),
      }),
    );
    return { kind: "FAILED_VALIDATION" };
  }

  await persist(
    "VALID",
    {
      summary: validated.summary,
      sectionOrder: validated.sectionOrder,
      scopeLabels: validated.scopeLabels.map((l) => ({
        patternStep: l.ref.step,
        component: l.ref.component,
        label: l.label,
      })),
    },
    meta({}),
  );
  return { kind: "VALID" };
}

// The caller's wrapper: an audit failure must never surface as anything
// other than "the audit could not be prepared". Everything is already
// returned rather than thrown inside, so this catches only the genuinely
// unexpected and treats it the same way.
export async function generateAuditProjectionSafely(
  db: Database | Transaction,
  jobId: string,
  deps?: { provider?: AuditProjectionProvider },
): Promise<AuditOutcome> {
  try {
    return await generateAuditProjection(db, jobId, deps);
  } catch {
    return { kind: "FAILED_MODEL" };
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asExclusions(value: unknown): { evidenceId: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is { evidenceId: string; reason: string } =>
      typeof v === "object" && v !== null && "evidenceId" in v && "reason" in v,
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
