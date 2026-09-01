import { z } from "zod";

// QUESTION-DRIVEN PROOF PROJECTION — the pure layer.
//
// THE ONE IDEA THIS FILE ENFORCES.
//
//   The model decides RELEVANCE. Canonical research decides REALITY.
//
// A projection may say "this part of the research matters to the question
// that was asked, and here is a short way to name it". It may never say
// what is true, what is supported, what is contradicted, where evidence
// stops, whether a mechanism executed, or which document proves anything.
//
// That boundary is not maintained by asking the model nicely. It is
// structural: the output schema below has NO field for a status, a fact,
// an evidence id or a reason code, so there is nothing in the shape a
// model could use to assert one even if it tried. Everything a reader is
// eventually shown about truth is looked up, at render time, from the
// canonical row that a finding's reference points at.
//
// The second guard is that references are CLOSED. A finding may only name
// a canonical object that was in the input we handed the model. An id that
// was not supplied — invented, remembered, or drifted — is rejected here,
// not rendered.

// Bumped by a human when the projection contract changes. It is half of
// the (job, version) uniqueness key, so bumping it is the ONLY thing that
// authorises a fresh model call for a job that already has a projection.
export const PROJECTION_VERSION = 1;

// A focused question deserves a small answer. These are the bounds the
// validator enforces, not advice to the model: a projection that names one
// thing has not answered a question, and one that names nine has just
// rebuilt the component grid under new labels.
export const MIN_FINDINGS = 2;
export const MAX_FINDINGS = 5;
export const MAX_LABEL_LENGTH = 80;

/* ------------------------------------------------------------------ *
 * THE INPUT BOUNDARY
 * ------------------------------------------------------------------ */

// What the model is allowed to see. Deliberately: statuses and counts, no
// content. No document text, no evidence fragments, no urls, no source
// bodies, no provider responses, no audit log.
//
// The statuses ARE included, and that is a considered choice rather than
// an oversight. Relevance depends on them — "where the evidence stops" is
// often the most relevant thing about a question, and a projection blind
// to status would cheerfully drop every unresolved finding and leave a
// reader with a falsely tidy answer. The model may READ a status to judge
// relevance; it has no way to WRITE one.
export interface ProjectionComponentInput {
  step: number;
  component: string;
  status: string;
  reasonCodes: string[];
  coverage: string;
  evidenceCount: number;
}

export interface ProjectionRequirementInput {
  requirementId: string;
  kind: string;
  status: string;
  evidenceCount: number;
}

export interface ProjectionModelInput {
  question: string;
  intent: string | null;
  components: ProjectionComponentInput[];
  requirements: ProjectionRequirementInput[];
}

/* ------------------------------------------------------------------ *
 * THE OUTPUT CONTRACT
 * ------------------------------------------------------------------ */

// A reference to a canonical, status-bearing object.
//
// COMPONENT ONLY, DELIBERATELY.
//
// S7 requirement results are given to the model as CONTEXT — they say what
// the question's intent actually demanded, which is real signal about
// relevance — but they may not be referenced as findings. Two reasons, and
// the second is the important one:
//
//   Their status vocabulary is different (SATISFIED / PARTIAL /
//   CONTRADICTED / UNSATISFIED, against the component vocabulary the
//   result screen renders). Mixing both would put two status languages on
//   one screen and force a translation nobody could check.
//
//   A requirement result can be UNSATISFIED with no evidence and no
//   component at all — it describes a gap in a chain, not a thing that was
//   examined. Rendering that as a finding with a "view evidence" affordance
//   would promise something the canonical record cannot supply.
//
// So every finding resolves to exactly one component result, and status,
// reason, coverage and evidence all come from that one canonical row.
export const projectionRefSchema = z.object({
  kind: z.literal("COMPONENT"),
  step: z.number().int().min(0).max(64),
  component: z.string().min(1).max(64),
});

export type ProjectionRef = z.infer<typeof projectionRefSchema>;

// NOTE WHAT IS ABSENT: no status, no verdict, no evidence id, no reason
// code, no explanation, no fact. A finding is a POINTER plus a NAME.
export const projectionFindingSchema = z.object({
  // Presentation copy. A short question or noun phrase in the reader's
  // words. This is the one thing the model authors, and it is safe to let
  // it author this because a label makes no claim — the status rendered
  // beside it comes from canonical state and can contradict the label's
  // optimism without either being wrong.
  userFacingLabel: z.string().min(1).max(MAX_LABEL_LENGTH),
  primaryRef: projectionRefSchema,
  supportingRefs: z.array(projectionRefSchema).max(4).default([]),
});

export const projectionOutputSchema = z.object({
  findings: z.array(projectionFindingSchema).min(1).max(12),
});

export type ProjectionFinding = z.infer<typeof projectionFindingSchema>;
export type ProjectionOutput = z.infer<typeof projectionOutputSchema>;

/* ------------------------------------------------------------------ *
 * DETERMINISTIC VALIDATION
 * ------------------------------------------------------------------ */

// Closed vocabulary. A rejection reason is recorded for audit; none of it
// is ever shown to a reader, who sees only the conservative fallback.
export type ProjectionRejection =
  | "SCHEMA_INVALID"
  | "UNKNOWN_REF"
  | "DUPLICATE_PRIMARY"
  | "SELF_SUPPORTING_REF"
  | "TOO_FEW_FINDINGS"
  | "TOO_MANY_FINDINGS"
  | "LABEL_UNUSABLE";

export interface ProjectionValidationOk {
  ok: true;
  findings: ProjectionFinding[];
}

export interface ProjectionValidationFailed {
  ok: false;
  rejection: ProjectionRejection;
}

export type ProjectionValidation = ProjectionValidationOk | ProjectionValidationFailed;

export function refKey(ref: ProjectionRef): string {
  return `COMPONENT:${ref.step}:${ref.component}`;
}

// The set of references the model was actually given. Nothing outside it
// may appear in the output — this is what makes an invented or
// half-remembered canonical id a validation failure rather than a render.
//
// Requirements are NOT in this set. They are context in the prompt and
// nothing more: a model that tries to reference one gets UNKNOWN_REF.
export function allowedRefKeys(input: ProjectionModelInput): Set<string> {
  const keys = new Set<string>();
  for (const c of input.components) {
    keys.add(refKey({ kind: "COMPONENT", step: c.step, component: c.component }));
  }
  return keys;
}

// A label that is really a status word is a label trying to be a claim.
// The status beside it is canonical and might say the opposite, and a
// reader would have no way to tell which one to believe.
const STATUS_WORDS =
  /\b(established|unestablished|supported|unsupported|not supported|contradicted|verified|unverified|proven|disproven|confirmed|insufficient)\b/i;

export function validateProjection(
  raw: unknown,
  input: ProjectionModelInput,
): ProjectionValidation {
  const parsed = projectionOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, rejection: "SCHEMA_INVALID" };

  const allowed = allowedRefKeys(input);
  const seenPrimary = new Set<string>();
  const findings: ProjectionFinding[] = [];

  for (const finding of parsed.data.findings) {
    const label = finding.userFacingLabel.trim();
    // A label must be presentation, not a verdict, and not empty once the
    // model's whitespace is removed.
    if (label.length === 0) return { ok: false, rejection: "LABEL_UNUSABLE" };
    if (STATUS_WORDS.test(label)) return { ok: false, rejection: "LABEL_UNUSABLE" };

    const primaryKey = refKey(finding.primaryRef);
    if (!allowed.has(primaryKey)) return { ok: false, rejection: "UNKNOWN_REF" };
    // Two findings resting on the same canonical object are the same
    // finding said twice, and would show one status under two names.
    if (seenPrimary.has(primaryKey)) return { ok: false, rejection: "DUPLICATE_PRIMARY" };
    seenPrimary.add(primaryKey);

    const supporting: ProjectionRef[] = [];
    const seenSupporting = new Set<string>();
    for (const ref of finding.supportingRefs) {
      const key = refKey(ref);
      if (!allowed.has(key)) return { ok: false, rejection: "UNKNOWN_REF" };
      // A finding cannot support itself; that would double-count one
      // canonical result as its own corroboration.
      if (key === primaryKey) return { ok: false, rejection: "SELF_SUPPORTING_REF" };
      if (seenSupporting.has(key)) continue;
      seenSupporting.add(key);
      supporting.push(ref);
    }

    findings.push({ userFacingLabel: label, primaryRef: finding.primaryRef, supportingRefs: supporting });
  }

  // FAIL CLOSED ON COUNT, IN BOTH DIRECTIONS. Too few has not answered the
  // question; too many has reproduced the component grid the projection
  // exists to replace. Neither is silently trimmed into looking correct —
  // truncating to five would present a model's overflowing output as
  // though it had been deliberate.
  if (findings.length < MIN_FINDINGS) return { ok: false, rejection: "TOO_FEW_FINDINGS" };
  if (findings.length > MAX_FINDINGS) return { ok: false, rejection: "TOO_MANY_FINDINGS" };

  return { ok: true, findings };
}

/* ------------------------------------------------------------------ *
 * RESOLVING A STORED PROJECTION AGAINST CANONICAL ROWS
 * ------------------------------------------------------------------ */

// What the client receives. STILL NO STATUS — only a label and the
// canonical component keys it points at. The reader's status, reason,
// coverage and evidence are all derived on the client from the component
// rows in the same response, exactly as they were before this feature
// existed.
export interface ResolvedQuestionFinding {
  label: string;
  patternStep: number;
  component: string;
  supportingComponents: string[];
}

// RE-VALIDATED ON THE WAY OUT.
//
// The projection was validated when it was written, but what decides a
// reader's status is the canonical component row — so the reference is
// checked again, here, against the rows in this very response. A component
// that has since vanished (a replayed job, a Pattern change) drops its
// finding rather than rendering a label against some other row's status.
//
// If every finding drops, the caller gets null and the UI falls back to
// the canonical result. Presentation degrades; it never guesses.
export function resolveProjectionFindings(
  stored: unknown,
  components: readonly { patternStep: number; component: string }[],
): ResolvedQuestionFinding[] | null {
  if (!Array.isArray(stored)) return null;
  const live = new Set(components.map((c) => `${c.patternStep}:${c.component}`));

  const resolved: ResolvedQuestionFinding[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    const parsed = projectionFindingSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { userFacingLabel, primaryRef, supportingRefs } = parsed.data;
    const key = `${primaryRef.step}:${primaryRef.component}`;
    if (!live.has(key) || seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      label: userFacingLabel,
      patternStep: primaryRef.step,
      component: primaryRef.component,
      supportingComponents: supportingRefs
        .filter((r) => live.has(`${r.step}:${r.component}`) && `${r.step}:${r.component}` !== key)
        .map((r) => r.component),
    });
  }
  return resolved.length > 0 ? resolved : null;
}

/* ------------------------------------------------------------------ *
 * BUILDING THE INPUT
 * ------------------------------------------------------------------ */

// Compact by construction. Statuses, closed codes, counts and stable ids —
// enough to judge what matters to a question, and nothing that could let a
// model form an opinion about what is true.
export function buildProjectionInput(args: {
  question: string;
  intent: string | null;
  components: readonly {
    patternStep: number;
    component: string;
    status: string;
    reasonCodes: readonly unknown[];
    coverage: string;
    supportingEvidenceIds: readonly string[];
    contradictingEvidenceIds: readonly string[];
  }[];
  requirements: readonly {
    requirementId: string;
    kind: string;
    status: string;
    evidenceCount: number;
  }[];
}): ProjectionModelInput {
  return {
    question: args.question,
    intent: args.intent,
    components: args.components.map((c) => ({
      step: c.patternStep,
      component: c.component,
      status: c.status,
      reasonCodes: c.reasonCodes.filter((r): r is string => typeof r === "string"),
      coverage: c.coverage,
      evidenceCount: c.supportingEvidenceIds.length + c.contradictingEvidenceIds.length,
    })),
    requirements: args.requirements.map((r) => ({
      requirementId: r.requirementId,
      kind: r.kind,
      status: r.status,
      evidenceCount: r.evidenceCount,
    })),
  };
}
