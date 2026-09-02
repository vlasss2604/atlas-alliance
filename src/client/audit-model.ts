import {
  componentLabel,
  exclusionLabel,
  reasonExplanation,
  safeClaimLabel,
  sourceClassCaveat,
  sourceClassLabel,
  type ComponentCoverage,
  type EvidenceItemLike,
} from "./research-model";

// THE FULL RESEARCH AUDIT — A SECOND PROJECTION OF THE SAME CANONICAL TRUTH.
//
// The normal Result answers "what is the answer to my question?". This
// answers a different one: "can I professionally inspect how ATLAS got
// there?". They read the same persisted rows and share no layout, because
// an audit that re-renders the result with more documents attached has
// told a professional nothing they did not already have.
//
// EVERYTHING HERE IS DERIVED, NOTHING IS DECIDED.
//
// Every function below is pure and reads only canonical fields already on
// the detail payload — component statuses, reason codes, coverage,
// evidence links, exclusion reasons, source classes, retrieval times. No
// status is computed, no evidence is re-admitted, no verdict is revisited.
// The model-generated audit projection contributes an ORDER, short human
// LABELS and two sentences of connective copy, and it is merged in here
// where it cannot displace anything canonical.
//
// COMPLETENESS IS THIS FILE'S JOB.
//
// `availableAuditSections` is computed from the data, and
// `orderAuditSections` guarantees that a section with canonical content
// renders whether or not the model ordered it. A model may arrange the
// audit; it may not shorten it.

export const AUDIT_SECTION_IDS = [
  "SUMMARY",
  "COVERAGE",
  "EVIDENCE_MAP",
  "SOURCE_REGISTER",
  "OPEN_QUESTIONS",
  "ONCHAIN",
  "TRACE",
] as const;
export type AuditSectionId = (typeof AUDIT_SECTION_IDS)[number];

export const AUDIT_SECTION_TITLES: Record<AuditSectionId, string> = {
  SUMMARY: "Audit summary",
  COVERAGE: "Research coverage",
  EVIDENCE_MAP: "Evidence map",
  SOURCE_REGISTER: "Source register",
  OPEN_QUESTIONS: "Open questions, conflicts and limitations",
  ONCHAIN: "On-chain verification",
  TRACE: "Research trace",
};

/* ------------------------------------------------------------------ *
 * INPUT — exactly the canonical shapes the detail route already returns
 * ------------------------------------------------------------------ */

export interface AuditComponentRow {
  patternStep: number;
  component: string;
  status: string;
  reasonCodes: unknown[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  excludedEvidence: { evidenceId: string; reason: string }[];
  coverage: ComponentCoverage;
}

export interface AuditEvidenceRow extends EvidenceItemLike {
  id: string;
  links?: { patternStep: number; component: string; role: string }[];
}

export interface AuditProjectionRow {
  summary: string;
  sectionOrder: string[];
  scopeLabels: { patternStep: number; component: string; label: string }[];
}

/* ------------------------------------------------------------------ *
 * 1. AUDIT SUMMARY — about the RECORD, never a second copy of the answer
 * ------------------------------------------------------------------ */

export interface AuditCounts {
  componentsTotal: number;
  established: number;
  partial: number;
  unresolved: number;
  contradicted: number;
  sourcesUsed: number;
  sourcesCheckedNotUsed: number;
  exclusions: number;
  technicalLimitations: number;
}

// Every number a reader sees is computed here, from canonical rows. The
// model is barred from emitting digits precisely so that no count on this
// screen can have come from anywhere else.
export function auditCounts(
  components: AuditComponentRow[],
  register: SourceRegister,
): AuditCounts {
  let established = 0;
  let partial = 0;
  let unresolved = 0;
  let contradicted = 0;
  let exclusions = 0;
  let technical = 0;
  for (const c of components) {
    switch (c.status) {
      case "SUPPORTED":
        established += 1;
        break;
      case "PARTIALLY_SUPPORTED":
        partial += 1;
        break;
      case "CONTRADICTED":
        contradicted += 1;
        break;
      default:
        unresolved += 1;
    }
    exclusions += c.excludedEvidence.length;
    if (limitationKind(c) === "TECHNICAL") technical += 1;
  }
  return {
    componentsTotal: components.length,
    established,
    partial,
    unresolved,
    contradicted,
    sourcesUsed: register.used.length,
    sourcesCheckedNotUsed: register.checkedNotUsed.length,
    exclusions,
    technicalLimitations: technical,
  };
}

/* ------------------------------------------------------------------ *
 * 2. RESEARCH SCOPE / COVERAGE
 * ------------------------------------------------------------------ */

export type AuditLimitationKind = "TECHNICAL" | "EVIDENCE" | null;

// THE DISTINCTION THE NORMAL RESULT CANNOT MAKE, AND THE SINGLE MOST
// USEFUL THING IN THIS AUDIT.
//
// "Could not verify" covers two completely different situations, and
// conflating them misleads in opposite directions:
//
//   TECHNICAL — the research run could not reach a source it needed.
//               Coverage is BLOCKED. This says nothing whatever about the
//               project; it is a fact about the run.
//   EVIDENCE  — the run looked successfully and the evidence was not
//               there, or every candidate was refused on admission.
//
// A reader who cannot tell these apart will read a proxy timeout as an
// absent mechanism. Coverage is canonical (derived from research attempts
// by the detail route), so this classification adds no judgement of its
// own — it only names a distinction the data already draws.
export function limitationKind(c: AuditComponentRow): AuditLimitationKind {
  if (c.status === "SUPPORTED" || c.status === "CONTRADICTED") return null;
  if (c.coverage === "BLOCKED") return "TECHNICAL";
  if (c.status === "PARTIALLY_SUPPORTED") return "EVIDENCE";
  return "EVIDENCE";
}

export interface AuditScopeItem {
  patternStep: number;
  component: string;
  // The model's human label where it supplied one, the canonical label
  // otherwise. A component is NEVER dropped for want of a label.
  label: string;
  labelSource: "PROJECTION" | "CANONICAL";
  status: string;
  // The single word a reader sees, derived from status + coverage.
  outcome: AuditOutcomeKind;
  outcomeLabel: string;
  // Canonical, and kept: shown on expansion and in the trace.
  coverage: ComponentCoverage;
  coverageLabel: string;
  reasonCodes: string[];
  reason: string | null;
  limitation: AuditLimitationKind;
  supportingCount: number;
  contradictingCount: number;
  excludedCount: number;
}

// ONE HUMAN-FACING OUTCOME, DERIVED FROM TWO CANONICAL AXES.
//
// Claim status and coverage are genuinely different things and both stay
// canonical — but showing them as two adjacent badges made a reader learn
// ATLAS's state machine before they could read a result. "NOT ESTABLISHED
// / NOT CHECKED" is precise and teaches nothing.
//
// So the pair is TRANSLATED, deterministically, into the one word a
// professional actually needs. The translation is total and lossless in
// the direction that matters: it never merges an evidence gap with a
// technical block, which is the distinction the whole audit exists to
// draw. It only stops making the reader compute it.
//
//   SUPPORTED                      -> Confirmed
//   PARTIALLY_SUPPORTED            -> Partially confirmed
//   CONTRADICTED                   -> Contradicted
//   INSUFFICIENT + coverage BLOCKED-> Research blocked   (a fact about the run)
//   INSUFFICIENT + anything else   -> Could not verify   (a fact about the record)
//
// Nothing canonical moves: status, coverage and reason codes are all
// still carried on the row, shown on expansion where they explain the
// outcome, and listed in full in the trace.
export type AuditOutcomeKind =
  | "CONFIRMED"
  | "PARTIALLY_CONFIRMED"
  | "CONTRADICTED"
  | "COULD_NOT_VERIFY"
  | "RESEARCH_BLOCKED";

export const AUDIT_OUTCOME_LABELS: Record<AuditOutcomeKind, string> = {
  CONFIRMED: "Confirmed",
  PARTIALLY_CONFIRMED: "Partially confirmed",
  CONTRADICTED: "Contradicted",
  COULD_NOT_VERIFY: "Could not verify",
  RESEARCH_BLOCKED: "Research blocked",
};

export function auditOutcome(status: string, coverage: ComponentCoverage): AuditOutcomeKind {
  if (status === "SUPPORTED") return "CONFIRMED";
  if (status === "PARTIALLY_SUPPORTED") return "PARTIALLY_CONFIRMED";
  if (status === "CONTRADICTED") return "CONTRADICTED";
  // The one branch that matters: a point nobody could reach is not a
  // point that was checked and came back empty.
  if (coverage === "BLOCKED") return "RESEARCH_BLOCKED";
  return "COULD_NOT_VERIFY";
}

// Coverage words are kept for the expansion and the trace, where they
// explain an outcome rather than compete with it.
export const COVERAGE_LABELS: Record<ComponentCoverage, string> = {
  COMPLETED: "Fully checked",
  PARTIAL: "Partly checked",
  BLOCKED: "Could not be reached",
  NOT_ATTEMPTED: "Not checked",
};

export function auditScope(
  components: AuditComponentRow[],
  projection: AuditProjectionRow | null,
): AuditScopeItem[] {
  const labels = new Map<string, string>();
  for (const l of projection?.scopeLabels ?? []) {
    labels.set(`${l.patternStep}:${l.component}`, l.label);
  }
  return components.map((c) => {
    const key = `${c.patternStep}:${c.component}`;
    const projected = labels.get(key);
    const reasonCodes = (c.reasonCodes ?? []).filter(
      (r): r is string => typeof r === "string",
    );
    return {
      patternStep: c.patternStep,
      component: c.component,
      // THE SAME SEMANTIC-ENVELOPE GUARD THE RESULT USES.
      //
      // A model label that leaves its component's canonical meaning is
      // REPLACED by that component's own label, never reworded. The live
      // Raydium audit produced exactly the drift this exists to catch:
      // NET_EFFECT — canonically a durable effect on token SUPPLY — came
      // back as "Token value effect", and a reader sees "value" and reads
      // price, a question this research never asked. The rule is per
      // COMPONENT and never looks at the question or the project, which
      // is what keeps it a research invariant rather than a keyword patch.
      label: projected
        ? safeClaimLabel(c.component, projected)
        : componentLabel(c.component),
      labelSource: projected ? "PROJECTION" : "CANONICAL",
      status: c.status,
      outcome: auditOutcome(c.status, c.coverage),
      outcomeLabel: AUDIT_OUTCOME_LABELS[auditOutcome(c.status, c.coverage)],
      coverage: c.coverage,
      coverageLabel: COVERAGE_LABELS[c.coverage] ?? c.coverage,
      reasonCodes,
      reason: reasonExplanation(reasonCodes),
      limitation: limitationKind(c),
      supportingCount: c.supportingEvidenceIds.length,
      contradictingCount: c.contradictingEvidenceIds.length,
      excludedCount: c.excludedEvidence.length,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 3. EVIDENCE MAP — research point -> evidence -> what it can/cannot settle
 * ------------------------------------------------------------------ */

export interface AuditEvidenceUse {
  evidence: AuditEvidenceRow;
  role: "SUPPORTING" | "CONTRADICTING" | "EXCLUDED";
  // Why this KIND of source is the right one to ask, and where its
  // authority stops. Both come from the shared source-class vocabulary, so
  // an audit and a result describe a source identically.
  canEstablish: string | null;
  cannotEstablish: string | null;
  // The extractor's own record for THIS passage, where it left one. More
  // specific than the class-level limit, so it is preferred when shown.
  doesNotProve: string | null;
  exclusionReason: string | null;
}

// ONE ROW PER (research point, SOURCE) — not per evidence row.
//
// The first version rendered a full source identity card for every
// Evidence row, so `docs.raydium.io` appeared with its class, its
// suitability, its limits and its two links under nearly every research
// point, and then again in the register. The evidence map's job is
// RELATIONSHIPS — which source carried which point, and what that kind of
// source can and cannot settle. Identity belongs to the register, once.
export interface AuditEvidenceLink {
  sourceKey: string;
  domain: string;
  sourceClass: string | null;
  sourceClassLabel: string;
  role: AuditEvidenceUse["role"];
  // How many Evidence rows from this one document carried this point. A
  // count, because the rows are the same document read more than once.
  evidenceCount: number;
  evidenceIds: string[];
  canEstablish: string | null;
  cannotEstablish: string | null;
  doesNotProve: string | null;
  exclusionReasons: string[];
  hasSnapshot: boolean;
  retrievedUrl: string;
}

export interface AuditEvidenceGroup {
  patternStep: number;
  component: string;
  label: string;
  status: string;
  outcomeLabel: string;
  // Admitted material, grouped by document.
  admitted: AuditEvidenceLink[];
  // Refused material, grouped by document — so a point that refused four
  // rows from one blog reads as "four items from one source, for this
  // reason" rather than four near-identical cards.
  excluded: AuditEvidenceLink[];
}

// One group per component that actually has evidence attached — supporting,
// contradicting or excluded. A component with nothing attached is not an
// evidence-map row; it is a coverage row, and it is already in section 2.
export function auditEvidenceMap(
  scope: AuditScopeItem[],
  components: AuditComponentRow[],
  evidence: AuditEvidenceRow[],
): AuditEvidenceGroup[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const scopeByKey = new Map(scope.map((s) => [`${s.patternStep}:${s.component}`, s]));
  const groups: AuditEvidenceGroup[] = [];

  for (const c of components) {
    const key = `${c.patternStep}:${c.component}`;
    const item = scopeByKey.get(key);
    const byDocument = new Map<string, AuditEvidenceLink>();

    const add = (
      id: string,
      role: AuditEvidenceUse["role"],
      exclusionReason: string | null,
    ) => {
      const row = byId.get(id);
      // A referenced row that is not in the payload is DROPPED, never
      // invented. An audit that fabricated a source to fill a link would
      // be worse than an audit with a shorter list.
      if (!row) return;
      // Grouped by DOCUMENT and by role: three Evidence rows from one
      // document are one relationship with a count, never three sources.
      const docKey = `${role}:${documentKeyOf(row)}`;
      const existing = byDocument.get(docKey);
      if (existing) {
        existing.evidenceCount += 1;
        existing.evidenceIds.push(row.id);
        if (row.hasSnapshot) existing.hasSnapshot = true;
        if (exclusionReason && !existing.exclusionReasons.includes(exclusionLabel(exclusionReason))) {
          existing.exclusionReasons.push(exclusionLabel(exclusionReason));
        }
        // The per-passage limit is kept only while it is the SAME for
        // every row; one document speaking with two voices about its own
        // limits is not something to average.
        if (existing.doesNotProve !== (row.doesNotProve ?? null)) existing.doesNotProve = null;
        return;
      }
      const caveat = sourceClassCaveat(row.sourceClass ?? null);
      byDocument.set(docKey, {
        sourceKey: documentKeyOf(row),
        domain: domainOfUrl(row.retrievedUrl ?? ""),
        sourceClass: row.sourceClass ?? null,
        sourceClassLabel: sourceClassLabel(row.sourceClass ?? null),
        role,
        evidenceCount: 1,
        evidenceIds: [row.id],
        canEstablish: caveat?.can ?? null,
        cannotEstablish: caveat?.cannot ?? null,
        doesNotProve: row.doesNotProve ?? null,
        exclusionReasons: exclusionReason ? [exclusionLabel(exclusionReason)] : [],
        hasSnapshot: row.hasSnapshot === true,
        retrievedUrl: row.retrievedUrl ?? "",
      });
    };

    for (const id of c.supportingEvidenceIds) add(id, "SUPPORTING", null);
    for (const id of c.contradictingEvidenceIds) add(id, "CONTRADICTING", null);
    for (const x of c.excludedEvidence) add(x.evidenceId, "EXCLUDED", x.reason);

    const links = [...byDocument.values()];
    if (links.length === 0) continue;
    groups.push({
      patternStep: c.patternStep,
      component: c.component,
      label: item?.label ?? componentLabel(c.component),
      status: c.status,
      outcomeLabel:
        item?.outcomeLabel ?? AUDIT_OUTCOME_LABELS[auditOutcome(c.status, c.coverage)],
      admitted: links.filter((l) => l.role !== "EXCLUDED"),
      excluded: links.filter((l) => l.role === "EXCLUDED"),
    });
  }
  return groups;
}

/* ------------------------------------------------------------------ *
 * 4. SOURCE REGISTER — used, and checked but not used
 * ------------------------------------------------------------------ */

export interface AuditSourceEntry {
  // The canonical document this row stands for. One acquired document is
  // ONE register entry however many Evidence rows it produced — the same
  // rule the result's evidence cards follow, for the same reason: three
  // rows from one document are not three corroborating sources.
  sourceKey: string;
  domain: string;
  sourceClass: string | null;
  sourceClassLabel: string;
  retrievedUrl: string;
  fetchedAt: string | null;
  evidenceIds: string[];
  hasSnapshot: boolean;
  // Which research points this document actually contributed to.
  contributedTo: { patternStep: number; component: string; label: string }[];
  // Populated only on the not-used side: why the material was refused,
  // in the engine's own closed vocabulary, rendered in ordinary words.
  notUsedReasons: string[];
  suitability: { can: string; cannot: string } | null;
}

export interface SourceRegister {
  used: AuditSourceEntry[];
  checkedNotUsed: AuditSourceEntry[];
}

function documentKeyOf(row: AuditEvidenceRow): string {
  return row.retrievedUrl || row.id;
}

function domainOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// THE ACCOUNTING THE NORMAL RESULT DELIBERATELY DOES NOT SHOW.
//
// A result shows a source under the finding it supports. An audit has to
// answer a harder question — what did you read and NOT use, and why? —
// because unused material is where over-claiming would have happened and
// did not. Both sides are canonical: "used" means a component result
// actually cites the row; "checked but not used" means the run read it and
// no component result cites it, with any recorded exclusion reason
// attached.
export function auditSourceRegister(
  components: AuditComponentRow[],
  evidence: AuditEvidenceRow[],
  scope: AuditScopeItem[],
): SourceRegister {
  const scopeByKey = new Map(scope.map((s) => [`${s.patternStep}:${s.component}`, s]));
  const usedEvidenceIds = new Set<string>();
  const contributions = new Map<string, { patternStep: number; component: string; label: string }[]>();
  const exclusionByEvidence = new Map<string, Set<string>>();

  for (const c of components) {
    const key = `${c.patternStep}:${c.component}`;
    const item = scopeByKey.get(key);
    const entry = {
      patternStep: c.patternStep,
      component: c.component,
      label: item?.label ?? componentLabel(c.component),
    };
    for (const id of [...c.supportingEvidenceIds, ...c.contradictingEvidenceIds]) {
      usedEvidenceIds.add(id);
      const list = contributions.get(id) ?? [];
      if (!list.some((x) => x.patternStep === entry.patternStep && x.component === entry.component)) {
        list.push(entry);
      }
      contributions.set(id, list);
    }
    for (const x of c.excludedEvidence) {
      const set = exclusionByEvidence.get(x.evidenceId) ?? new Set<string>();
      set.add(x.reason);
      exclusionByEvidence.set(x.evidenceId, set);
    }
  }

  const byDocument = new Map<string, AuditEvidenceRow[]>();
  for (const row of evidence) {
    const key = documentKeyOf(row);
    const list = byDocument.get(key) ?? [];
    list.push(row);
    byDocument.set(key, list);
  }

  const used: AuditSourceEntry[] = [];
  const checkedNotUsed: AuditSourceEntry[] = [];

  for (const [sourceKey, rows] of byDocument) {
    const head = rows[0];
    const caveat = sourceClassCaveat(head.sourceClass ?? null);
    const contributedTo: AuditSourceEntry["contributedTo"] = [];
    const reasons = new Set<string>();
    let anyUsed = false;

    for (const row of rows) {
      if (usedEvidenceIds.has(row.id)) {
        anyUsed = true;
        for (const entry of contributions.get(row.id) ?? []) {
          if (!contributedTo.some((x) => x.patternStep === entry.patternStep && x.component === entry.component)) {
            contributedTo.push(entry);
          }
        }
      }
      for (const reason of exclusionByEvidence.get(row.id) ?? []) reasons.add(reason);
      if (row.exclusionReason) reasons.add(row.exclusionReason);
    }

    const entry: AuditSourceEntry = {
      sourceKey,
      domain: domainOfUrl(head.retrievedUrl ?? ""),
      sourceClass: head.sourceClass ?? null,
      sourceClassLabel: sourceClassLabel(head.sourceClass ?? null),
      retrievedUrl: head.retrievedUrl ?? "",
      fetchedAt: head.fetchedAt ?? null,
      evidenceIds: rows.map((r) => r.id),
      hasSnapshot: rows.some((r) => r.hasSnapshot === true),
      contributedTo,
      notUsedReasons: [...reasons].map((r) => exclusionLabel(r)),
      suitability: caveat ? { can: caveat.can, cannot: caveat.cannot } : null,
    };

    // A document is USED when a component result actually cites one of its
    // rows. Everything else the run read belongs on the other side of the
    // ledger, with its reason where the engine recorded one.
    if (anyUsed) used.push(entry);
    else checkedNotUsed.push(entry);
  }

  return { used, checkedNotUsed };
}

/* ------------------------------------------------------------------ *
 * 5. OPEN QUESTIONS / CONFLICTS / LIMITATIONS
 * ------------------------------------------------------------------ */

export type AuditOpenItemKind = "CONFLICT" | "TECHNICAL_LIMITATION" | "OPEN_EVIDENCE_QUESTION";

export interface AuditOpenItem {
  kind: AuditOpenItemKind;
  patternStep: number;
  component: string;
  label: string;
  outcomeLabel: string;
  detail: string;
  // WHAT WOULD CLOSE IT. An audit that lists open questions without
  // saying what answering them requires has described a hole rather than
  // a route out of it. Each string is derived from the KIND of gap, never
  // from the project — a blocked point needs access, a refused-evidence
  // point needs a source of sufficient authority, an empty point needs
  // any admissible evidence at all.
  needed: string;
  reasonCodes: string[];
}

// THREE DIFFERENT THINGS, NEVER MERGED.
//
// A conflict exists only where canonical research actually recorded
// contradicting evidence — two sources merely differing is not a conflict,
// and manufacturing one would be inventing a finding. A technical
// limitation is a fact about the run. An open evidence question is a fact
// about the record. Each is stated as what it is, and the technical one
// says explicitly that it is not evidence of absence.
export function auditOpenItems(
  scope: AuditScopeItem[],
  components: AuditComponentRow[],
): AuditOpenItem[] {
  const byKey = new Map(components.map((c) => [`${c.patternStep}:${c.component}`, c]));
  const items: AuditOpenItem[] = [];

  for (const s of scope) {
    const c = byKey.get(`${s.patternStep}:${s.component}`);
    if (!c) continue;

    if (c.contradictingEvidenceIds.length > 0 || c.status === "CONTRADICTED") {
      items.push({
        kind: "CONFLICT",
        patternStep: s.patternStep,
        component: s.component,
        label: s.label,
        outcomeLabel: s.outcomeLabel,
        detail:
          "Canonical research recorded evidence on both sides of this point. The reconciliation state shown is the engine's own, not a preference between sources.",
        needed:
          "A source of higher authority than both, or a direct on-chain observation, to settle which account of this point holds.",
        reasonCodes: s.reasonCodes,
      });
      continue;
    }

    if (s.limitation === "TECHNICAL") {
      items.push({
        kind: "TECHNICAL_LIMITATION",
        patternStep: s.patternStep,
        component: s.component,
        label: s.label,
        outcomeLabel: s.outcomeLabel,
        detail:
          "A source this point needed could not be reached during the research run. This is a limitation of the run, not evidence that the mechanism is absent.",
        needed: "A repeat run with access to the source this point requires.",
        reasonCodes: s.reasonCodes,
      });
      continue;
    }

    if (s.limitation === "EVIDENCE") {
      items.push({
        kind: "OPEN_EVIDENCE_QUESTION",
        patternStep: s.patternStep,
        component: s.component,
        label: s.label,
        outcomeLabel: s.outcomeLabel,
        detail:
          s.reason ??
          "The run completed for this point and the evidence needed to settle it was not established.",
        // An exclusion-driven gap and an empty-handed one need different
        // things, and the reason code already distinguishes them.
        needed: s.reasonCodes.includes("ALL_EVIDENCE_EXCLUDED")
          ? "A source whose class carries enough authority for this kind of claim."
          : s.reasonCodes.includes("INSUFFICIENT_AUTHORITY")
            ? "A source of sufficient authority for this claim, or a direct on-chain observation."
            : "Any admissible evidence bearing on this point; none was found in this run.",
        reasonCodes: s.reasonCodes,
      });
    }
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * 6. ON-CHAIN VERIFICATION — present only where canonical artifacts are
 * ------------------------------------------------------------------ */

export interface AuditOnchain {
  available: boolean;
  // Named honestly when absent, so a reader knows this run produced no
  // on-chain artifacts rather than wondering whether the audit forgot.
  missingFields: string[];
  entries: { evidenceId: string; locator: string }[];
}

// NEVER FABRICATED. A verification section built from documentary
// excerpts, or from fields the client does not actually carry, would make
// a document look like a receipt — the exact confusion the product's
// transfer-is-not-a-buyback rules exist to prevent.
export function auditOnchain(evidence: AuditEvidenceRow[]): AuditOnchain {
  const entries: { evidenceId: string; locator: string }[] = [];
  for (const row of evidence) {
    const locator = (row as { documentaryLocator?: string | null }).documentaryLocator;
    const artifactId = (row as { onchainArtifactId?: string | null }).onchainArtifactId;
    if (artifactId && locator) entries.push({ evidenceId: row.id, locator });
  }
  return {
    available: entries.length > 0,
    missingFields: entries.length > 0 ? [] : ["onchain_artifact_id", "documentary_locator"],
    entries,
  };
}

/* ------------------------------------------------------------------ *
 * COMPLETENESS — WHICH SECTIONS EXIST, AND THE ORDER THEY RENDER IN
 * ------------------------------------------------------------------ */

export interface AuditContent {
  counts: AuditCounts;
  scope: AuditScopeItem[];
  evidenceMap: AuditEvidenceGroup[];
  register: SourceRegister;
  openItems: AuditOpenItem[];
  onchain: AuditOnchain;
}

export function buildAuditContent(
  components: AuditComponentRow[],
  evidence: AuditEvidenceRow[],
  projection: AuditProjectionRow | null,
): AuditContent {
  const scope = auditScope(components, projection);
  const register = auditSourceRegister(components, evidence, scope);
  return {
    counts: auditCounts(components, register),
    scope,
    evidenceMap: auditEvidenceMap(scope, components, evidence),
    register,
    openItems: auditOpenItems(scope, components),
    onchain: auditOnchain(evidence),
  };
}

// A section is AVAILABLE when canonical data gives it something to say.
// Empty sections are not created mechanically — an audit with an empty
// "Conflicts" heading implies a conflict was looked for and none of the
// rest of the record is any more trustworthy for saying so.
export function availableAuditSections(content: AuditContent): AuditSectionId[] {
  const out: AuditSectionId[] = ["SUMMARY"];
  if (content.scope.length > 0) out.push("COVERAGE");
  if (content.evidenceMap.length > 0) out.push("EVIDENCE_MAP");
  if (content.register.used.length > 0 || content.register.checkedNotUsed.length > 0) {
    out.push("SOURCE_REGISTER");
  }
  if (content.openItems.length > 0) out.push("OPEN_QUESTIONS");
  if (content.onchain.available) out.push("ONCHAIN");
  if (content.scope.length > 0) out.push("TRACE");
  return out;
}

// THE COMPLETENESS GUARANTEE, IN ONE FUNCTION.
//
// The model proposes an order. This applies it — and then appends every
// available section the model left out, in canonical order. A section that
// canonical research gave content to CANNOT disappear because a model did
// not mention it, which is the property that separates an audit from a
// summary. Anything the model named that has no content is dropped, so a
// model cannot conjure an empty section either.
export function orderAuditSections(
  proposed: string[] | null | undefined,
  available: AuditSectionId[],
): AuditSectionId[] {
  const availableSet = new Set(available);
  const ordered: AuditSectionId[] = [];
  for (const id of proposed ?? []) {
    if (availableSet.has(id as AuditSectionId) && !ordered.includes(id as AuditSectionId)) {
      ordered.push(id as AuditSectionId);
    }
  }
  for (const id of AUDIT_SECTION_IDS) {
    if (availableSet.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}
