import { z } from "zod";

// FULL RESEARCH AUDIT PROJECTION — the pure layer.
//
// THE DIVISION OF LABOUR, AND WHY IT IS THE OPPOSITE OF QUESTION PROJECTION.
//
// Question Projection asks a model WHICH findings matter, and omission is
// the whole point: a focused question deserves a small answer. An Audit is
// the other thing entirely. It exists so a professional can check the
// complete relevant record, so omission is the one failure it cannot
// tolerate — and a model must therefore never hold authority over what
// appears.
//
//   The model ORGANISES.  Code GUARANTEES COMPLETENESS.
//
// So this schema carries no content at all. It carries an order, a handful
// of short human labels, and two or three sentences of connective copy.
// Every fact a reader eventually sees — every status, count, reason code,
// evidence link, exclusion and source — is assembled deterministically
// from canonical rows at render time (`src/client/audit-model.ts`), and a
// section that has canonical content is rendered whether or not the model
// mentioned it. A model that returned an empty ordering would cost the
// audit its arrangement and none of its substance.
//
// THE THREE STRUCTURAL GUARDS.
//
//   1. NO FIELD FOR TRUTH. There is nowhere in this shape to put a status,
//      a verdict, an evidence id, a reason code or a count, so a model
//      cannot assert one even by ignoring every word of its prompt.
//   2. CLOSED REFERENCES. A label may only name a canonical object that
//      was in the input. An invented, remembered or drifted reference is
//      rejected here, not rendered.
//   3. NO DIGITS IN PROSE. Counts are arithmetic over canonical rows and
//      belong to code. Barring digits from the model's own sentences is
//      what stops "three sources were excluded" from ever being a claim a
//      model made up rather than a number code computed.

// Bumped by a human when the audit contract changes. Half of the
// (job, version) uniqueness key, so bumping it is the ONLY thing that
// authorises a fresh model call for a job that already has an audit.
export const AUDIT_VERSION = 1;

// The sections an audit may contain, in their canonical default order. A
// model may reorder them; it may not invent one, and it may not make one
// disappear — `orderAuditSections` in the client model re-adds anything
// omitted that has canonical content.
export const AUDIT_SECTIONS = [
  "SUMMARY",
  "COVERAGE",
  "EVIDENCE_MAP",
  "SOURCE_REGISTER",
  "OPEN_QUESTIONS",
  "ONCHAIN",
  "TRACE",
] as const;
export type AuditSection = (typeof AUDIT_SECTIONS)[number];

export const MAX_SUMMARY_LENGTH = 400;
export const MAX_LABEL_LENGTH = 48;

/* ------------------------------------------------------------------ *
 * THE INPUT BOUNDARY
 * ------------------------------------------------------------------ */

// What the model may see. Deliberately: identifiers, statuses, classes and
// counts. NO document text, NO evidence fragments, NO urls beyond a bare
// domain, NO source bodies, NO provider responses.
//
// Statuses ARE included, and for the same considered reason Question
// Projection includes them: a label for a component nobody could verify
// should read differently from one that was settled. The model may READ a
// status to choose a word; it has no field in which to WRITE one.
export interface AuditComponentInput {
  step: number;
  component: string;
  status: string;
  reasonCodes: string[];
  coverage: string;
  supportingCount: number;
  contradictingCount: number;
  excludedCount: number;
}

export interface AuditSourceInput {
  // A stable canonical identifier — the document key the register groups
  // by. Never a url the model could turn into a fetch instruction.
  sourceKey: string;
  domain: string;
  sourceClass: string | null;
  used: boolean;
}

export interface AuditModelInput {
  question: string;
  intent: string | null;
  components: AuditComponentInput[];
  sources: AuditSourceInput[];
  // Which sections have canonical content. The model is told so it can
  // order what exists rather than inventing an empty one — but code, not
  // this list, is what finally decides what renders.
  availableSections: AuditSection[];
}

export function buildAuditInput(args: {
  question: string;
  intent: string | null;
  components: AuditComponentInput[];
  sources: AuditSourceInput[];
  availableSections: AuditSection[];
}): AuditModelInput {
  return {
    question: args.question,
    intent: args.intent,
    components: args.components,
    sources: args.sources,
    availableSections: args.availableSections,
  };
}

/* ------------------------------------------------------------------ *
 * THE OUTPUT CONTRACT
 * ------------------------------------------------------------------ */

export const auditComponentRefSchema = z.object({
  kind: z.literal("COMPONENT"),
  step: z.number().int().min(0).max(99),
  component: z.string().min(1).max(64),
});
export type AuditComponentRef = z.infer<typeof auditComponentRefSchema>;

export const auditOutputSchema = z.object({
  // Two or three sentences about the RESEARCH RECORD — its coverage, where
  // it stopped, what a reader should look at. Never a second copy of the
  // answer, and never a number.
  summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
  sectionOrder: z.array(z.enum(AUDIT_SECTIONS)).max(AUDIT_SECTIONS.length),
  // A short human name for each canonical component — "Fee allocation"
  // rather than SOURCE_OF_VALUE. This is the single biggest thing a model
  // adds to an audit: the record is otherwise readable only by someone who
  // already knows the Pattern's vocabulary.
  scopeLabels: z
    .array(
      z.object({
        ref: auditComponentRefSchema,
        label: z.string().min(1).max(MAX_LABEL_LENGTH),
      }),
    )
    .max(32),
});
export type AuditOutput = z.infer<typeof auditOutputSchema>;

/* ------------------------------------------------------------------ *
 * DETERMINISTIC VALIDATION — THE ONLY THING THAT MAY ADMIT AN AUDIT
 * ------------------------------------------------------------------ */

export type AuditRejection =
  | "OUTPUT_SCHEMA_INVALID"
  | "UNKNOWN_REFERENCE"
  | "DUPLICATE_REFERENCE"
  | "LABEL_ASSERTS_STATUS"
  | "LABEL_IS_INTERNAL_VOCABULARY"
  | "PROSE_CONTAINS_NUMBER"
  | "DUPLICATE_SECTION";

export interface AuditValidationOk {
  ok: true;
  summary: string;
  sectionOrder: AuditSection[];
  scopeLabels: { ref: AuditComponentRef; label: string }[];
}
export interface AuditValidationFailed {
  ok: false;
  rejection: AuditRejection;
  detail: string;
}
export type AuditValidation = AuditValidationOk | AuditValidationFailed;

export function componentRefKey(ref: { step: number; component: string }): string {
  return `${ref.step}:${ref.component}`;
}

export function allowedComponentRefKeys(input: AuditModelInput): Set<string> {
  return new Set(input.components.map((c) => componentRefKey(c)));
}

// A label names a thing; it never rates one. The audit renders every
// status itself, from the canonical row, so a label that also carried a
// status would be a second and possibly disagreeing statement of it.
const STATUS_WORDS =
  /\b(establish(ed|es)?|verifi(ed|es)|confirm(ed|s)?|prov(en|ed|es)|support(ed|s)?|contradict(ed|s)?|refut(ed|es)|unproven|unverified|insufficient|conclusive|valid|invalid|true|false)\b/i;

// The Pattern's own vocabulary must not reach a default audit surface —
// that is the whole point of asking for a label. SOURCE_OF_VALUE and
// NET_EFFECT belong in the Research Trace, where they are named honestly.
const INTERNAL_VOCABULARY = /[A-Z][A-Z0-9]*_[A-Z0-9_]+/;

// Counts are arithmetic over canonical rows. Barring digits from the
// model's prose is what makes "three sources were excluded" impossible to
// originate from a model rather than from the data.
const CONTAINS_DIGIT = /\d/;

export function validateAuditProjection(raw: unknown, input: AuditModelInput): AuditValidation {
  const parsed = auditOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      rejection: "OUTPUT_SCHEMA_INVALID",
      detail: parsed.error.issues[0]?.message ?? "schema",
    };
  }
  const out = parsed.data;

  if (CONTAINS_DIGIT.test(out.summary)) {
    return { ok: false, rejection: "PROSE_CONTAINS_NUMBER", detail: "summary" };
  }
  if (STATUS_WORDS.test(out.summary)) {
    // The summary describes the shape of the record — how much was
    // covered, where it stopped. Saying what was established is the
    // canonical layer's job, and it says it a few lines further down.
    return { ok: false, rejection: "LABEL_ASSERTS_STATUS", detail: "summary" };
  }

  const seenSections = new Set<string>();
  for (const s of out.sectionOrder) {
    if (seenSections.has(s)) {
      return { ok: false, rejection: "DUPLICATE_SECTION", detail: s };
    }
    seenSections.add(s);
  }

  const allowed = allowedComponentRefKeys(input);
  const seenRefs = new Set<string>();
  for (const entry of out.scopeLabels) {
    const key = componentRefKey(entry.ref);
    if (!allowed.has(key)) {
      return { ok: false, rejection: "UNKNOWN_REFERENCE", detail: key };
    }
    if (seenRefs.has(key)) {
      return { ok: false, rejection: "DUPLICATE_REFERENCE", detail: key };
    }
    seenRefs.add(key);

    if (STATUS_WORDS.test(entry.label)) {
      return { ok: false, rejection: "LABEL_ASSERTS_STATUS", detail: entry.label };
    }
    if (INTERNAL_VOCABULARY.test(entry.label)) {
      return { ok: false, rejection: "LABEL_IS_INTERNAL_VOCABULARY", detail: entry.label };
    }
    if (CONTAINS_DIGIT.test(entry.label)) {
      return { ok: false, rejection: "PROSE_CONTAINS_NUMBER", detail: entry.label };
    }
  }

  return {
    ok: true,
    summary: out.summary,
    sectionOrder: out.sectionOrder,
    scopeLabels: out.scopeLabels,
  };
}
