import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { researchPatterns, topics } from "../db/schema";
import { componentRequirementsFor, patternContentSchema, PATTERN_V1_CONTENT, type PatternContent } from "./pattern";

// PATTERN SEMANTIC-DRIFT ACTIVATION.
//
// THE MISS THIS CLOSES. The ACTIVE research_patterns row is chosen by
// identity and validated by shape; RC-1 added one CONTENT check — a
// persisted row may not drop a code-owned structural obligation — and the
// activation script activated a successor only when THAT check refused
// the row. Every other content difference was printed and then judged
// "already compatible; nothing to do". So when D-159 narrowed
// DURABILITY_BASIS to GOVERNANCE sources, the database kept admitting
// OFFICIAL_DOCS for it: the persisted contract, not the code, is what the
// S5 reducer reads, and a live run established the component from a docs
// passage the current methodology rejects. Activation was never
// refused, never required, never suggested.
//
// THE RULE. A Pattern field is SEMANTIC when any deterministic Research
// decision reads it, or when it is sent to a provider as an instruction
// about what to acquire:
//
//   steps[].step                     the eight ordered steps (planner,
//                                    contract view, every stage keys on it)
//   steps[].name                     the step's title, printed into the
//                                    proposer's and extractor's prompt
//                                    beside the step number
//   requiredComponents               the work queue itself
//   componentRequirements.*          the S5 admissibility matrix, the
//                                    freshness and currency gates, the
//                                    token-state rule, the structural
//                                    obligations, the fresh-only rule the
//                                    memory paths derive from it, and the
//                                    evidenceGoal the extractor is told to
//                                    look for (D-158 changed a verdict by
//                                    changing that sentence)
//   intentRequirements               what S7 requires of a claim and how
//                                    S8 cites it
//
// PRESENTATION-ONLY — the one field no engine path reads and no prompt
// carries: steps[].question, the human-facing wording of the step. It is
// listed explicitly; a field this list does not name is semantic by
// default, so a new Pattern field can never silently become
// activation-exempt.
//
// The comparison is over the CANONICAL semantic contract: object keys
// sorted (Postgres normalises jsonb key order), arrays kept in order
// (order is meaning for the steps and for establishing classes), the
// presentation-only fields removed. `patternSemanticFingerprint` is the
// sha256 of that canonical form — one string that answers "is this the
// methodology the code defines?" wherever the question is asked.
//
// WHAT ACTIVATION STILL IS. Exactly what the script always did: the ACTIVE
// row's status moves to RETIRED with its content untouched, the code
// contract is inserted as a new ACTIVE row at the next version, inside one
// transaction, and the result is re-read through the production accessor.
// Nothing here edits a row's content, and nothing here runs on its own —
// the script is the only caller of `activatePatternVersions`.

export const PATTERN_PRESENTATION_ONLY_FIELDS: readonly string[] = ["steps[].question"];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonical(src[key]);
    return out;
  }
  return value;
}

export function canonicalPatternJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

// The semantic contract of a content blob: the blob with every
// presentation-only field removed, canonicalised. Works on any parsed
// object shape (a stored row's jsonb included), never only on the typed
// constant, so a drifted or malformed row can still be compared.
export function patternSemanticContract(content: unknown): unknown {
  const c = (content ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(c.steps)
    ? c.steps.map((s) => {
        const step = { ...((s ?? {}) as Record<string, unknown>) };
        delete step.question;
        return step;
      })
    : c.steps;
  return canonical({ ...c, steps });
}

export function patternSemanticFingerprint(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(patternSemanticContract(content))).digest("hex");
}

// Every difference between two semantic contracts, as concrete paths, so
// an operator sees exactly what activating would change. Presentation-only
// fields are not walked at all.
export function patternSemanticDifferences(stored: unknown, code: PatternContent): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    const ao = (a ?? {}) as Record<string, unknown>;
    const bo = (b ?? {}) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const p = `${path}.${key}`;
      const va = ao[key];
      const vb = bo[key];
      if (!(key in ao)) {
        out.push(`ONLY-IN-CODE  ${p} = ${JSON.stringify(vb)}`);
        continue;
      }
      if (!(key in bo)) {
        out.push(`ONLY-IN-DB    ${p} = ${JSON.stringify(va)}`);
        continue;
      }
      if (typeof va === "object" && va !== null && !Array.isArray(va) && typeof vb === "object" && vb !== null) {
        walk(va, vb, p);
      } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
        out.push(`DIFFERS       ${p}: db=${JSON.stringify(va)} code=${JSON.stringify(vb)}`);
      }
    }
  };
  walk(patternSemanticContract(stored), patternSemanticContract(code), "content");
  return out.sort();
}

export type ActivationReason = "CONTENT_INVALID" | "GATE_REFUSED" | "SEMANTIC_DRIFT";

export interface ActivationVerdict {
  required: boolean;
  reason: ActivationReason | null;
  // The production gate's own refusal text, when it refused.
  gateRefusal: string | null;
  differences: string[];
  storedFingerprint: string;
  codeFingerprint: string;
}

// The production gate itself, over every component the content defines —
// not a re-implementation of it.
function gateAccepts(content: PatternContent): { ok: true } | { ok: false; reason: string } {
  for (const component of Object.keys(content.componentRequirements ?? {})) {
    try {
      componentRequirementsFor(content, component);
    } catch (e) {
      return { ok: false, reason: `${(e as Error).name}: ${(e as Error).message}` };
    }
  }
  return { ok: true };
}

// Whether the code contract must replace a stored ACTIVE content. Three
// reasons, checked in order: the row does not parse (a successor is
// required, and the row cannot even be gated); the production gate
// refuses it (structural drift, RC-1); the semantic contracts differ
// (everything else that changes admissibility, obligations, freshness,
// acquisition instructions or claim requirements). A row that differs
// only in presentation is not drifted.
export function patternActivationRequired(stored: unknown, code: PatternContent = PATTERN_V1_CONTENT): ActivationVerdict {
  const storedFingerprint = patternSemanticFingerprint(stored);
  const codeFingerprint = patternSemanticFingerprint(code);
  const differences = patternSemanticDifferences(stored, code);
  const parsed = patternContentSchema.safeParse(stored);
  if (!parsed.success) {
    return { required: true, reason: "CONTENT_INVALID", gateRefusal: parsed.error.message.slice(0, 300), differences, storedFingerprint, codeFingerprint };
  }
  const gate = gateAccepts(parsed.data);
  if (!gate.ok) {
    return { required: true, reason: "GATE_REFUSED", gateRefusal: gate.reason, differences, storedFingerprint, codeFingerprint };
  }
  if (storedFingerprint !== codeFingerprint) {
    return { required: true, reason: "SEMANTIC_DRIFT", gateRefusal: null, differences, storedFingerprint, codeFingerprint };
  }
  return { required: false, reason: null, gateRefusal: null, differences, storedFingerprint, codeFingerprint };
}

export interface TopicActivationReport {
  topicId: string;
  topicSlug: string;
  rows: { version: number; status: string; createdAt: Date }[];
  activeVersion: number | null;
  verdict: ActivationVerdict | null;
  // What was, or would be, done.
  action: "NONE" | "NO_ROWS" | "NO_ACTIVE_ROW" | "WOULD_ACTIVATE" | "ACTIVATED";
  nextVersion: number | null;
}

// The activation lifecycle, unchanged in what it writes: RETIRE the
// ACTIVE row (status only), insert the code contract as the next
// version, re-read and re-verify. `apply: false` writes nothing.
export async function activatePatternVersions(
  db: Database,
  opts: { apply: boolean; code?: PatternContent; log?: (line: string) => void },
): Promise<TopicActivationReport[]> {
  const code = opts.code ?? PATTERN_V1_CONTENT;
  const log = opts.log ?? (() => {});
  const reports: TopicActivationReport[] = [];
  const activeTopics = await db.select().from(topics).where(eq(topics.isActive, true));
  if (activeTopics.length === 0) throw new Error("no active topic — refusing to guess which topic to activate against");

  for (const topic of activeTopics) {
    const rows = await db.select().from(researchPatterns).where(eq(researchPatterns.topicId, topic.id)).orderBy(desc(researchPatterns.version));
    const report: TopicActivationReport = {
      topicId: topic.id,
      topicSlug: topic.slug,
      rows: rows.map((r) => ({ version: r.version, status: r.status, createdAt: r.createdAt })),
      activeVersion: null,
      verdict: null,
      action: "NONE",
      nextVersion: null,
    };
    reports.push(report);
    log(`\n=== topic ${topic.slug} (${topic.id}) ===`);
    if (rows.length === 0) {
      report.action = "NO_ROWS";
      log("  no research_patterns rows — nothing to activate (run the seed first)");
      continue;
    }
    for (const r of rows) log(`  v${r.version} ${r.status} created=${r.createdAt.toISOString()}`);
    const current = rows.find((r) => r.status === "ACTIVE");
    if (!current) {
      report.action = "NO_ACTIVE_ROW";
      log("  no ACTIVE row — refusing to choose one; activate deliberately");
      continue;
    }
    report.activeVersion = current.version;
    const verdict = patternActivationRequired(current.content, code);
    report.verdict = verdict;
    log(`  ACTIVE v${current.version} gate: ${verdict.reason === "GATE_REFUSED" || verdict.reason === "CONTENT_INVALID" ? "REFUSED" : "ACCEPTED"}`);
    if (verdict.gateRefusal) log(`    ${verdict.gateRefusal}`);
    log(`  semantic fingerprint: db=${verdict.storedFingerprint.slice(0, 16)} code=${verdict.codeFingerprint.slice(0, 16)}`);
    log(`  semantic differences vs code contract: ${verdict.differences.length}`);
    for (const d of verdict.differences) log(`    ${d}`);
    if (!verdict.required) {
      log("  -> semantically identical to the code contract; nothing to do.");
      continue;
    }
    log(`  -> activation REQUIRED (${verdict.reason})`);

    const nextVersion = Math.max(...rows.map((r) => r.version)) + 1;
    report.nextVersion = nextVersion;
    if (!opts.apply) {
      report.action = "WOULD_ACTIVATE";
      log(`  -> DRY RUN: would RETIRE v${current.version} (content untouched) and insert v${nextVersion} ACTIVE with the code contract.`);
      log("     Re-run with --apply to perform it.");
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.update(researchPatterns).set({ status: "RETIRED" }).where(eq(researchPatterns.id, current.id));
      await tx.insert(researchPatterns).values({ topicId: topic.id, version: nextVersion, status: "ACTIVE", content: code });
    });

    const [after] = await db
      .select()
      .from(researchPatterns)
      .where(and(eq(researchPatterns.topicId, topic.id), eq(researchPatterns.status, "ACTIVE")));
    if (!after || after.version !== nextVersion) throw new Error(`activation did not take effect for topic ${topic.slug}`);
    const afterVerdict = patternActivationRequired(after.content, code);
    if (afterVerdict.required) {
      throw new Error(`activated v${nextVersion} is still not the code contract (${afterVerdict.reason}): ${afterVerdict.differences.join("; ")}`);
    }
    const [preserved] = await db.select().from(researchPatterns).where(eq(researchPatterns.id, current.id));
    if (!preserved || preserved.status !== "RETIRED" || canonicalPatternJson(preserved.content) !== canonicalPatternJson(current.content)) {
      throw new Error(`v${current.version} was not preserved as RETIRED with its content unchanged`);
    }
    report.action = "ACTIVATED";
    log(`  -> APPLIED: v${nextVersion} ACTIVE, semantically identical to the code contract.`);
    log(`     v${current.version} preserved as RETIRED, content unchanged.`);
  }
  return reports;
}
