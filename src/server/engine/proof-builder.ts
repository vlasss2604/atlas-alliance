import type {
  ClaimReasonCode,
  ClaimRequirementResult,
  ClaimSupportStatus,
  MechanismGapRef,
} from "./claim-evaluator";
import type { ComponentReconciliationStatus } from "./component-reconciler";
import {
  computeProofConfidence,
  type ConfidenceBand,
  type ConfidenceBindingReason,
  type ConfidenceScore,
} from "./proof-confidence";

// Phase 6, S8 — the Proof builder.
//
// S8 IS A PROJECTION LAYER, NOT A REASONING ENGINE. It consumes what S5,
// S6 and S7 already decided and arranges it into the locked Proof shape.
// It has no DB access, calls no model, opens no socket, and reaches no
// conclusion of its own — every value it emits is either copied from
// persisted state or composed by a closed template over persisted state.
//
// The verdict is the sharpest case of that rule. S7's ClaimSupportStatus
// IS the verdict; this module maps it across and nothing else. There is
// no second verdict algorithm, no majority vote over Evidence, no
// confidence-based override, and no path by which a Proof can be more
// certain than the claim support it rests on (D-110: "Proof Core вправе
// рендерить confidence и не вправе самостоятельно изменять суждение
// истины S7").
//
// CONFIDENCE is computed by proof-confidence.ts under D-135 — a closed
// ordinal band (LOW 20 / LIMITED 40 / STRONG 60 / VERY_STRONG 80), never
// a probability and never a percentage. It is kept in its own module
// because it is the one part of S8 with its own ratified contract, and it
// must stay separately testable. D-081/D-110 hold: deterministic, code
// owned, never model-authored.

export const PROOF_LAYERS_VERSION = 1;

// The seven canonical layers (LOCKED §7). Layer 5 is deliberately EMPTY
// in Proof Core (D-083) — "Не наполнять «Подробнее» дублирующим текстом
// ради самого блока" — and no later stage may fill it with restated
// content just to make the block non-empty.
export const PROOF_LAYER_TITLES = [
  "Verdict + Confidence",
  "In plain words",
  "Why ATLAS reached this conclusion",
  "What matters most to keep in mind",
  "More detail",
  "What could change this conclusion",
  "Evidence / Sources / Gaps",
] as const;

export interface ComponentResultProjection {
  step: number;
  component: string;
  status: ComponentReconciliationStatus;
  reasonCodes: string[];
  supportingEvidenceIds: string[];
  excludedEvidence: { evidenceId: string; reason: string }[];
}

export interface ClaimSupportProjection {
  intent: string;
  status: ClaimSupportStatus;
  reasonCodes: ClaimReasonCode[];
  requirementResults: ClaimRequirementResult[];
  contextGaps: MechanismGapRef[];
}

export interface ProofBuilderInput {
  researchJobId: string;
  // The S7 projection. NULL means S7 never produced one for this job.
  claimSupport: ClaimSupportProjection | null;
  // Every S5 result persisted for this job.
  componentResults: ComponentResultProjection[];
  // The ids of Evidence rows that ACTUALLY exist for this job. Citations
  // are filtered against this set, so a Proof structurally cannot carry a
  // dangling reference. Supplied by the caller because this module has no
  // DB access.
  existingEvidenceIds: readonly string[];
}

// One entry per canonical layer. `lines` is closed, templated content —
// never free text, never a model sentence. An empty `lines` is a real
// state (layer 5 always; layer 6 only when nothing at all is unresolved).
export interface ProofLayer {
  layer: number;
  title: string;
  lines: string[];
}

export interface ProofCitation {
  step: number;
  component: string;
  evidenceIds: string[];
}

export interface ProofGapEntry {
  kind: string;
  component: string | null;
  afterStep: number | null;
  origin: "REQUIREMENT_BLOCKING" | "CLAIM_CONTEXT" | "COMPONENT_EXCLUSION" | "COMPONENT_REASON";
}

export interface ProofDraft {
  researchJobId: string;
  // Copied from S7. Never recomputed.
  verdict: ProofVerdict;
  // D-135. `score` is the database/API ENCODING of `band`; the band is
  // the semantic value. Never rendered as a percentage.
  confidenceBand: ConfidenceBand;
  confidenceScore: ConfidenceScore;
  confidenceBindingReasons: ConfidenceBindingReason[];
  layers: {
    version: number;
    layers: ProofLayer[];
  };
  // Deduped, sorted, and guaranteed to exist — see existingEvidenceIds.
  citedEvidenceIds: string[];
  citations: ProofCitation[];
  gaps: ProofGapEntry[];
}

// The Proof verdict vocabulary (schema enum `verdict`). Note that
// NOT_APPLICABLE exists in the column but is NOT reachable from S7: the
// ClaimSupportStatus vocabulary has exactly four members and every one of
// them maps to its namesake. S8 therefore never emits NOT_APPLICABLE —
// emitting it would require a judgement S7 did not make. If a future
// stage learns to classify a question as inapplicable, that decision
// belongs there, not here.
export type ProofVerdict =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "NOT_SUPPORTED"
  | "INSUFFICIENT_EVIDENCE"
  | "NOT_APPLICABLE";

// The verdicts S8 can actually emit. NOT_APPLICABLE is excluded at the
// TYPE level, so the compiler — not a convention — guarantees S8 never
// invents it, and confidence's ceiling table stays exhaustive over
// exactly the reachable set.
export type ProofVerdictFromClaim = Exclude<ProofVerdict, "NOT_APPLICABLE">;

const VERDICT_FROM_CLAIM_STATUS: Record<ClaimSupportStatus, ProofVerdictFromClaim> = {
  SUPPORTED: "SUPPORTED",
  PARTIALLY_SUPPORTED: "PARTIALLY_SUPPORTED",
  NOT_SUPPORTED: "NOT_SUPPORTED",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
};

// Why a build produced no Proof. Closed, like every other refusal
// vocabulary in this repository.
export const PROOF_REFUSAL_REASONS = ["NO_CLAIM_SUPPORT"] as const;
export type ProofRefusalReason = (typeof PROOF_REFUSAL_REASONS)[number];

export type ProofBuildOutcome =
  | { proof: ProofDraft; refusal: null }
  | { proof: null; refusal: ProofRefusalReason };

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function keyOf(step: number, component: string): string {
  return `${step}:${component}`;
}

// A one-line, code-owned rendering of a gap. Every part comes from a
// closed vocabulary or a code-owned component name — no model text and no
// operator input can reach it.
function gapLine(g: ProofGapEntry): string {
  const where =
    g.component !== null
      ? ` at component ${g.component}`
      : g.afterStep !== null
        ? ` after step ${g.afterStep}`
        : "";
  return `${g.kind}${where}`;
}

// THE BUILD. Pure: same input, same output, no clock, no randomness, no
// IO. Returns a refusal rather than a placeholder whenever the canonical
// S7 result is absent — an empty or UNKNOWN Proof would assert that a
// conclusion was reached when none was.
export function buildProof(input: ProofBuilderInput): ProofBuildOutcome {
  if (input.claimSupport === null) {
    // FAIL CLOSED (§9). No S7 projection means no claim was evaluated;
    // there is nothing to project and nothing to guess.
    return { proof: null, refusal: "NO_CLAIM_SUPPORT" };
  }
  const cs = input.claimSupport;
  const verdict = VERDICT_FROM_CLAIM_STATUS[cs.status];

  const existing = new Set(input.existingEvidenceIds);
  const componentByKey = new Map(input.componentResults.map((r) => [keyOf(r.step, r.component), r]));

  // ---- citations -----------------------------------------------------
  // Only Evidence the CLAIM itself cites, and only through the component
  // results it actually rests on. Evidence belonging to a component this
  // claim never referenced contributes nothing — the same rule the job
  // API already applies when rendering findings.
  //
  // SOURCE != EVIDENCE != FACT != PROOF CLAIM: nothing here promotes a
  // source row or an on-chain artifact into a citation. Only ids that
  // exist as Evidence rows for this job survive the filter.
  const citations: ProofCitation[] = [];
  const citedIds = new Set<string>();
  for (const req of cs.requirementResults) {
    for (const k of req.provenance.componentResultKeys) {
      const row = componentByKey.get(keyOf(k.step, k.component));
      if (!row) continue;
      // Intersect what the requirement cites with what the component
      // actually established, then with what exists.
      const supporting = new Set(row.supportingEvidenceIds);
      const ids = sortedUnique(
        req.provenance.evidenceIds.filter((id) => supporting.has(id) && existing.has(id)),
      );
      if (ids.length === 0) continue;
      for (const id of ids) citedIds.add(id);
      const already = citations.find((c) => c.step === k.step && c.component === k.component);
      if (already) already.evidenceIds = sortedUnique([...already.evidenceIds, ...ids]);
      else citations.push({ step: k.step, component: k.component, evidenceIds: ids });
    }
  }
  citations.sort((a, b) => a.step - b.step || a.component.localeCompare(b.component));

  // ---- gaps ----------------------------------------------------------
  // Layer 6 is MANDATORY and must never be filler, so it is assembled
  // from four kinds of ALREADY-RECORDED unresolved state. If none of them
  // exists the layer is genuinely empty, which is itself honest.
  const gaps: ProofGapEntry[] = [];
  const seenGap = new Set<string>();
  function addGap(g: ProofGapEntry): void {
    const k = `${g.origin}|${g.kind}|${g.component ?? ""}|${g.afterStep ?? ""}`;
    if (seenGap.has(k)) return;
    seenGap.add(k);
    gaps.push(g);
  }
  for (const req of cs.requirementResults) {
    for (const g of req.blockingGaps) {
      addGap({ kind: g.kind, component: g.component, afterStep: g.afterStep, origin: "REQUIREMENT_BLOCKING" });
    }
  }
  for (const g of cs.contextGaps) {
    addGap({ kind: g.kind, component: g.component, afterStep: g.afterStep, origin: "CLAIM_CONTEXT" });
  }
  // A component that reconciled to anything other than SUPPORTED carries
  // its own closed reason codes; those are exactly "what would have to
  // change".
  for (const row of input.componentResults) {
    if (row.status === "SUPPORTED") continue;
    for (const code of row.reasonCodes) {
      addGap({ kind: code, component: row.component, afterStep: row.step, origin: "COMPONENT_REASON" });
    }
    for (const ex of row.excludedEvidence) {
      addGap({ kind: ex.reason, component: row.component, afterStep: row.step, origin: "COMPONENT_EXCLUSION" });
    }
  }

  // ---- layers --------------------------------------------------------
  const satisfied = cs.requirementResults.filter((r) => r.status === "SATISFIED");
  const partial = cs.requirementResults.filter((r) => r.status === "PARTIAL");
  const contradicted = cs.requirementResults.filter((r) => r.status === "CONTRADICTED");
  const unsatisfied = cs.requirementResults.filter((r) => r.status === "UNSATISFIED");
  const requiredUnmet = cs.requirementResults.filter(
    (r) => r.optionality === "REQUIRED" && r.status !== "SATISFIED",
  );

  // D-135. Computed from persisted closed state only, over EVERY
  // component result of the job (see ConfidenceInput's doc comment for
  // why all of them and not just the cited ones).
  const confidence = computeProofConfidence({
    verdict,
    hasRequiredBlockingGap: cs.requirementResults.some(
      (r) => r.optionality === "REQUIRED" && r.blockingGaps.length > 0,
    ),
    hasClaimContextGap: cs.contextGaps.length > 0,
    componentResults: input.componentResults.map((r) => ({ status: r.status, reasonCodes: r.reasonCodes })),
  });

  const layer1: string[] = [`Verdict: ${verdict}.`];
  // The band is the statement; the score is named as its encoding, never
  // as a percentage, so a reader cannot mistake it for a probability.
  layer1.push(
    `Confidence: ${confidence.band} (band encoding ${confidence.score}; ` +
      `a structural indicator for this verdict, not a probability).`,
  );
  // WHY it landed there — only the caps that actually bound it.
  layer1.push(`Confidence bounded by: ${confidence.bindingReasons.join(", ")}.`);

  const layer2: string[] = [`For the question "${cs.intent}", the evidence gathered is: ${verdict}.`];

  const layer3: string[] = [
    `${cs.requirementResults.length} claim requirement(s) were evaluated: ` +
      `${satisfied.length} satisfied, ${partial.length} partial, ` +
      `${contradicted.length} contradicted, ${unsatisfied.length} unsatisfied.`,
  ];
  for (const r of cs.requirementResults) {
    const codes = r.reasonCodes.length > 0 ? ` (${sortedUnique(r.reasonCodes).join(", ")})` : "";
    layer3.push(`${r.optionality} requirement ${r.requirementId}: ${r.status}${codes}.`);
  }
  if (citations.length > 0) {
    layer3.push(
      `Supported by ${citedIds.size} evidence row(s) across ` +
        `${citations.length} component result(s).`,
    );
  } else {
    layer3.push("No evidence row is cited in support of this conclusion.");
  }

  // Layer 4 — the single most important limitation, taken from what was
  // recorded rather than chosen for emphasis.
  const layer4: string[] = [];
  if (requiredUnmet.length > 0) {
    layer4.push(
      `${requiredUnmet.length} required claim requirement(s) are not satisfied: ` +
        `${sortedUnique(requiredUnmet.map((r) => r.requirementId)).join(", ")}.`,
    );
  }
  if (cs.reasonCodes.length > 0) {
    layer4.push(`Claim-level reasons: ${sortedUnique(cs.reasonCodes).join(", ")}.`);
  }
  const excludedCount = input.componentResults.reduce((n, r) => n + r.excludedEvidence.length, 0);
  if (excludedCount > 0) {
    layer4.push(
      `${excludedCount} evidence row(s) were excluded by component reconciliation and establish nothing here.`,
    );
  }
  if (layer4.length === 0) {
    layer4.push("No claim-level limitation was recorded for this conclusion.");
  }

  // Layer 5 — deliberately empty (D-083). Proof Core does not restate.
  const layer5: string[] = [];

  const layer6: string[] = gaps.map(gapLine);

  const layer7: string[] = [];
  for (const c of citations) {
    layer7.push(`step ${c.step} / ${c.component}: ${c.evidenceIds.length} evidence row(s).`);
  }
  if (layer7.length === 0) layer7.push("No evidence is cited.");
  layer7.push(`${gaps.length} recorded gap(s).`);

  const layers: ProofLayer[] = [
    { layer: 1, title: PROOF_LAYER_TITLES[0], lines: layer1 },
    { layer: 2, title: PROOF_LAYER_TITLES[1], lines: layer2 },
    { layer: 3, title: PROOF_LAYER_TITLES[2], lines: layer3 },
    { layer: 4, title: PROOF_LAYER_TITLES[3], lines: layer4 },
    { layer: 5, title: PROOF_LAYER_TITLES[4], lines: layer5 },
    { layer: 6, title: PROOF_LAYER_TITLES[5], lines: layer6 },
    { layer: 7, title: PROOF_LAYER_TITLES[6], lines: layer7 },
  ];

  return {
    proof: {
      researchJobId: input.researchJobId,
      verdict,
      confidenceBand: confidence.band,
      confidenceScore: confidence.score,
      confidenceBindingReasons: confidence.bindingReasons,
      layers: { version: PROOF_LAYERS_VERSION, layers },
      citedEvidenceIds: sortedUnique(citedIds),
      citations,
      gaps,
    },
    refusal: null,
  };
}
