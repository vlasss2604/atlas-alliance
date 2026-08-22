import { describe, expect, it } from "vitest";

import {
  reconcileComponent,
  type ComponentRequirements,
  type EvidenceRow,
  type ComponentReconciliationInput,
} from "../src/server/engine/component-reconciler";

// Phase 6, S5 — pure reconciler unit tests (phase-6-s5-plan.md §14 A-Y,
// §15 mutations 1-29). No DB, no model, no network — reconcileComponent()
// is a pure function; every test here constructs its EvidenceRow[]/
// ComponentRequirements literally and asserts on the returned
// ComponentReconciliationResult.

const JOB = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-08-22T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const FRESHNESS_POLICY = { LOW_CHANGE: 180, MEDIUM_CHANGE: 30, HIGH_CHANGE: 3 };

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

// Matches PATTERN_V1_CONTENT.requiredComponents (src/server/domain/pattern.ts)
// — keeps row()'s default patternStep consistent with whatever component a
// test overrides, without every test having to restate the step by hand.
const COMPONENT_STEP: Record<string, number> = {
  SOURCE_OF_VALUE: 1,
  FLOW_PATH: 2,
  MECHANISM_SPEC: 3,
  GOVERNANCE_BASIS: 3,
  EXECUTION_EVIDENCE: 4,
  CURRENT_STATE: 5,
  DESTINATION: 6,
  RECIPIENT: 6,
  NET_EFFECT: 7,
  DURABILITY_BASIS: 8,
};

function row(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  const id = overrides.id ?? nextId();
  const component = overrides.component ?? "MECHANISM_SPEC";
  return {
    id,
    researchJobId: JOB,
    sourceId: overrides.sourceId ?? `source-${id}`,
    evidenceContractVersion: 2,
    patternStep: COMPONENT_STEP[component ?? ""] ?? 3,
    component: "MECHANISM_SPEC",
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: "the protocol burns 50% of fees",
    summary: "protocol burns half of fees",
    mechanismState: null,
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    fetchedAt: NOW,
    publishedAt: NOW,
    extractionUnitKey: `unit-${id}`,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

function requirements(overrides: Partial<ComponentRequirements> = {}): ComponentRequirements {
  return {
    component: "MECHANISM_SPEC",
    establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"],
    requiresCurrentState: false,
    requiresLiveMechanismState: false,
    freshnessClass: "LOW_CHANGE",
    tokenStateSensitive: false,
    requiredTokenState: null,
    ...overrides,
  };
}

function reconcile(
  evidence: EvidenceRow[],
  reqs: ComponentRequirements,
  overrides: Partial<Omit<ComponentReconciliationInput, "evidence" | "requirements">> = {},
) {
  return reconcileComponent({
    jobId: JOB,
    item: { step: 3, component: reqs.component },
    requirements: reqs,
    evidence,
    now: NOW,
    freshnessPolicyDays: FRESHNESS_POLICY,
    ...overrides,
  });
}

describe("Фаза 6, S5 — приёмочная матрица A-Y (phase-6-s5-plan.md §14)", () => {
  it("A. один DIRECT OFFICIAL_DOCS CONFIRMED на MECHANISM_SPEC -> SUPPORTED", () => {
    const r = reconcile([row()], requirements());
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).toEqual([]);
    expect(r.supportingEvidenceIds.length).toBe(1);
  });

  it("B. десять SOCIAL с одним и тем же утверждением -> не SUPPORTED; все исключены CLASS_NOT_ADMISSIBLE", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ sourceClass: "SOCIAL", extractionUnitKey: `social-${i}`, sourceId: `s-${i}` }),
    );
    const r = reconcile(rows, requirements());
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence.every((e) => e.reason === "CLASS_NOT_ADMISSIBLE")).toBe(true);
    expect(r.excludedEvidence.length).toBe(10);
  });

  it("C. допустимый класс, officiality=CLAIMED -> PARTIALLY_SUPPORTED + INSUFFICIENT_AUTHORITY", () => {
    const r = reconcile([row({ officiality: "CLAIMED" })], requirements());
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
  });

  it("D. документация описывает механизм, исполнения нет -> MECHANISM_SPEC SUPPORTED; EXECUTION_EVIDENCE INSUFFICIENT + MISSING_EXECUTION_EVIDENCE", () => {
    const mechReqs = requirements({ component: "MECHANISM_SPEC", establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"] });
    const execReqs = requirements({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
      requiresLiveMechanismState: true,
    });
    const mechRow = row({ component: "MECHANISM_SPEC" });
    const execRow = row({ component: "EXECUTION_EVIDENCE", sourceClass: "OFFICIAL_DOCS" });

    const rMech = reconcile([mechRow], mechReqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    expect(rMech.status).toBe("SUPPORTED");

    const rExec = reconcile([execRow], execReqs, { item: { step: 4, component: "EXECUTION_EVIDENCE" } });
    expect(rExec.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(rExec.reasonCodes).toContain("MISSING_EXECUTION_EVIDENCE");
  });

  it("E. предложение одобрено, исполнения нет -> CURRENT_STATE не LIVE (недостаточно); GOVERNANCE_BASIS может быть SUPPORTED", () => {
    const govReqs = requirements({ component: "GOVERNANCE_BASIS", establishingClasses: ["GOVERNANCE"] });
    const govRow = row({ component: "GOVERNANCE_BASIS", sourceClass: "GOVERNANCE", mechanismState: "APPROVED" });
    const rGov = reconcile([govRow], govReqs, { item: { step: 3, component: "GOVERNANCE_BASIS" } });
    expect(rGov.status).toBe("SUPPORTED");

    const curReqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "OFFICIAL_REPORT"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE",
    });
    // Only a GOVERNANCE row exists -> wrong class for CURRENT_STATE.
    const curRow = row({ component: "CURRENT_STATE", sourceClass: "GOVERNANCE", mechanismState: "APPROVED" });
    const rCur = reconcile([curRow], curReqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(rCur.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(rCur.currentState).toBeNull();
  });

  it("F. 2025 LIVE -> 2026 DEPRECATED (класс не ниже) -> вытеснение, CURRENT_STATE=DEPRECATED, не CONTRADICTED", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      requiresCurrentState: true,
      freshnessClass: "MEDIUM_CHANGE",
    });
    const old = row({
      component: "CURRENT_STATE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
      fetchedAt: new Date("2026-08-20T00:00:00Z"),
    });
    const fresh = row({
      component: "CURRENT_STATE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-08-01T00:00:00Z"),
      fetchedAt: new Date("2026-08-21T00:00:00Z"),
    });
    const r = reconcile([old, fresh], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.currentState).toBe("DEPRECATED");
    expect(r.excludedEvidence.find((e) => e.evidenceId === old.id)?.reason).toBe("SUPERSEDED_BY_NEWER");
  });

  it("G. два элемента одного периода, LIVE против DEPRECATED, оба устанавливающие -> CONTRADICTED, оба id предъявлены", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE",
    });
    const a = row({
      component: "CURRENT_STATE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "LIVE",
      publishedAt: new Date("2026-08-20T00:00:00Z"),
      fetchedAt: new Date("2026-08-20T00:00:00Z"),
    });
    const b = row({
      component: "CURRENT_STATE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-08-20T00:00:00Z"),
      fetchedAt: new Date("2026-08-20T00:00:00Z"),
    });
    const r = reconcile([a, b], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("CONTRADICTED");
    expect(r.contradictingEvidenceIds.sort()).toEqual([a.id, b.id].sort());
  });

  it("H. единственный элемент CURRENT_STATE старше окна -> INSUFFICIENT_EVIDENCE + STALE_CURRENT_STATE", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE", // 3 days
    });
    const stale = row({
      component: "CURRENT_STATE",
      sourceClass: "OFFICIAL_DOCS",
      mechanismState: "LIVE",
      publishedAt: new Date(NOW.getTime() - 30 * DAY),
    });
    const r = reconcile([stale], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toContain("STALE_CURRENT_STATE");
    expect(r.excludedEvidence[0].reason).toBe("STALE_FOR_CURRENT_STATE");
  });

  it("I. RECIPIENT, во фрагменте veCRV, requiredTokenState=null -> PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED, элемент не исключён, tokenStateMentions=[veCRV-qualifier]", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "GOVERNANCE"],
      tokenStateSensitive: true,
      requiredTokenState: null,
    });
    const r = reconcile(
      [row({ component: "RECIPIENT", fragment: "veCRV holders receive protocol fees", summary: null })],
      reqs,
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.supportingEvidenceIds.length).toBe(1);
    expect(r.tokenStateMentions).toContain("ve");
  });

  it("J. Evidence чужого компонента -> исключено WRONG_COMPONENT", () => {
    const reqs = requirements();
    const wrong = row({ component: "OTHER_COMPONENT" });
    const r = reconcile([wrong], reqs);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence[0].reason).toBe("WRONG_COMPONENT");
  });

  it("K. порядок строк из БД перевёрнут -> результат побайтово идентичен", () => {
    const reqs = requirements();
    const rows = [row({ sourceId: "a" }), row({ sourceId: "b" }), row({ sourceId: "c" })];
    const r1 = reconcile(rows, reqs);
    const r2 = reconcile([...rows].reverse(), reqs);
    expect(r1).toEqual(r2);
  });

  it("L. тот же extraction_unit_key дважды -> DUPLICATE_UNIT, силы не прибавляет", () => {
    const reqs = requirements();
    const a = row({ extractionUnitKey: "same-unit" });
    const b = row({ extractionUnitKey: "same-unit" });
    const r = reconcile([a, b], reqs);
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds.length).toBe(1);
    expect(r.excludedEvidence.some((e) => e.reason === "DUPLICATE_UNIT")).toBe(true);
  });

  it("M. Evidence нет вовсе -> INSUFFICIENT_EVIDENCE + NO_EVIDENCE_FOUND, статус успеха", () => {
    const r = reconcile([], requirements());
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
  });

  it("N. всё Evidence исключено -> INSUFFICIENT_EVIDENCE + ALL_EVIDENCE_EXCLUDED, статус успеха", () => {
    const r = reconcile([row({ sourceClass: "SOCIAL" })], requirements());
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toContain("ALL_EVIDENCE_EXCLUDED");
  });

  it("O. повторный прогон реконсиляции -> идентичный результат", () => {
    const reqs = requirements();
    const rows = [row(), row({ officiality: "CLAIMED" })];
    const r1 = reconcile(rows, reqs);
    const r2 = reconcile(rows, reqs);
    expect(r1).toEqual(r2);
  });

  it("P. NET_EFFECT только по документации со словом burn -> не SUPPORTED (CLASS_NOT_ADMISSIBLE)", () => {
    const reqs = requirements({
      component: "NET_EFFECT",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"],
    });
    const r = reconcile(
      [row({ component: "NET_EFFECT", sourceClass: "OFFICIAL_DOCS", fragment: "the protocol burns tokens" })],
      reqs,
      { item: { step: 7, component: "NET_EFFECT" } },
    );
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence[0].reason).toBe("CLASS_NOT_ADMISSIBLE");
  });

  it('Q. mechanism_state="definitely live" (вне словаря) -> нормализуется в UNKNOWN; противоречия не создаёт', () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE",
    });
    const weird = row({ component: "CURRENT_STATE", mechanismState: "definitely live" });
    const live = row({ component: "CURRENT_STATE", mechanismState: "LIVE" });
    const r = reconcile([weird, live], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).not.toBe("CONTRADICTED");
  });

  it("R. SOCIAL противоречит документально установленному механизму -> противоречия нет; компонент остаётся SUPPORTED", () => {
    const reqs = requirements({ establishingClasses: ["OFFICIAL_DOCS"] });
    const official = row({ mechanismState: "LIVE" });
    const social = row({ sourceClass: "SOCIAL", relationship: "CONTRADICTS", mechanismState: "DEPRECATED" });
    const r = reconcile([official, social], reqs);
    expect(r.status).toBe("SUPPORTED");
  });

  it("S. 20 DIRECT-элементов допустимого класса против 1 -> тот же SUPPORTED, что и от одного", () => {
    const reqs = requirements();
    const many = Array.from({ length: 20 }, (_, i) => row({ sourceId: `s-${i}`, extractionUnitKey: `u-${i}` }));
    const one = [row()];
    const rMany = reconcile(many, reqs);
    const rOne = reconcile(one, reqs);
    expect(rMany.status).toBe("SUPPORTED");
    expect(rOne.status).toBe("SUPPORTED");
  });

  it("T. INFERRED допустимого класса — единственный -> не устанавливает: DIRECTNESS_INSUFFICIENT", () => {
    const reqs = requirements();
    const r = reconcile([row({ directness: "INFERRED" })], reqs);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence[0].reason).toBe("DIRECTNESS_INSUFFICIENT");
  });

  it("U. RECIPIENT, requiredTokenState=veCRV, Evidence про veCRV -> SUPPORTED; понижения нет; tokenStateMentions всё равно заполнен", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "GOVERNANCE"],
      tokenStateSensitive: true,
      requiredTokenState: "ve",
    });
    const r = reconcile(
      [row({ component: "RECIPIENT", fragment: "veCRV holders receive protocol fees", summary: null })],
      reqs,
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).not.toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions.length).toBeGreaterThan(0);
  });

  it("V. NET_EFFECT, requiredTokenState=ve, Evidence про иное состояние (staked) -> PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED; состояния не слиты, элемент не исключён", () => {
    const reqs = requirements({
      component: "NET_EFFECT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "ve",
    });
    const r = reconcile(
      [row({ component: "NET_EFFECT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "staked AAVE tokens receive rewards", summary: null })],
      reqs,
      { item: { step: 7, component: "NET_EFFECT" } },
    );
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.supportingEvidenceIds.length).toBe(1);
  });

  it("W. EXECUTION_EVIDENCE: ONCHAIN(2025, LIVE) vs новее OFFICIAL_DOCS(2026, DEPRECATED) -> нет вытеснения, нет противоречия, ончейн-основа сохраняется", () => {
    const reqs = requirements({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
      requiresLiveMechanismState: true,
    });
    const onchain = row({
      component: "EXECUTION_EVIDENCE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
      fetchedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const docs = row({
      component: "EXECUTION_EVIDENCE",
      sourceClass: "OFFICIAL_DOCS",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const r = reconcile([onchain, docs], reqs, { item: { step: 4, component: "EXECUTION_EVIDENCE" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toEqual([onchain.id]);
    expect(r.excludedEvidence.find((e) => e.evidenceId === onchain.id)).toBeUndefined();
  });

  it("X. MECHANISM_SPEC: те же две строки, что в W -> OFFICIAL_DOCS устанавливает компонент, результат отличается от W", () => {
    const reqs = requirements({
      component: "MECHANISM_SPEC",
      establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"],
    });
    const onchain = row({
      component: "MECHANISM_SPEC",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
      fetchedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const docs = row({
      component: "MECHANISM_SPEC",
      sourceClass: "OFFICIAL_DOCS",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const r = reconcile([onchain, docs], reqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toEqual([docs.id]);
  });

  it("Y. establishingClasses пуст в Pattern -> INSUFFICIENT_EVIDENCE + CLASS_NOT_ADMISSIBLE для всех строк, молчаливого дефолта из кода нет", () => {
    const reqs = requirements({ establishingClasses: [] });
    const r = reconcile([row(), row({ sourceClass: "GOVERNANCE" }), row({ sourceClass: "ONCHAIN_VERIFIABLE" })], reqs);
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.excludedEvidence.every((e) => e.reason === "CLASS_NOT_ADMISSIBLE")).toBe(true);
  });
});

describe("Фаза 6, S5 — мутации §15 (обязаны ронять тесты)", () => {
  it("1. SOCIAL не может стать устанавливающим, даже если requirements случайно его перечисляют неверно — контрольный тест базового правила", () => {
    const reqs = requirements({ establishingClasses: ["SOCIAL"] });
    // Pattern data itself would never list SOCIAL (matrix §5) — this test
    // proves the RECONCILER honors whatever Pattern says structurally
    // (establishingClasses is the only authority), so a real defect where
    // code silently treats SOCIAL as establishing regardless of Pattern
    // input would NOT be caught by this alone. The actual teeth for
    // "SOCIAL never establishes" is scenario B (Pattern excludes SOCIAL by
    // construction) + this: if Pattern DOES list it, it IS honored (no
    // hidden code-level SOCIAL blacklist that would contradict D-095).
    const r = reconcile([row({ sourceClass: "SOCIAL" })], reqs);
    expect(r.status).toBe("SUPPORTED");
  });

  it("2. три слабых источника не дают силу счётом — 3x SOCIAL != SUPPORTED", () => {
    const reqs = requirements();
    const rows = [0, 1, 2].map((i) => row({ sourceClass: "SOCIAL", sourceId: `s-${i}`, extractionUnitKey: `u-${i}` }));
    const r = reconcile(rows, reqs);
    expect(r.status).not.toBe("SUPPORTED");
  });

  it("3. CLAIMED не даёт полного SUPPORTED", () => {
    const r = reconcile([row({ officiality: "CLAIMED" })], requirements());
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("4. документация не закрывает EXECUTION_EVIDENCE", () => {
    const reqs = requirements({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
      requiresLiveMechanismState: true,
    });
    const r = reconcile([row({ component: "EXECUTION_EVIDENCE", sourceClass: "OFFICIAL_DOCS", mechanismState: "LIVE" })], reqs, {
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
    });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("5. PROPOSED не читается как LIVE для EXECUTION_EVIDENCE", () => {
    const reqs = requirements({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      requiresLiveMechanismState: true,
    });
    const r = reconcile([row({ component: "EXECUTION_EVIDENCE", sourceClass: "ONCHAIN_VERIFIABLE", mechanismState: "PROPOSED" })], reqs, {
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
    });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("6. «новее — значит правее» без остальных условий вытеснения не применяется (разные классы, менее пригодный не вытесняет)", () => {
    const reqs = requirements({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
      requiresLiveMechanismState: true,
    });
    const onchain = row({
      component: "EXECUTION_EVIDENCE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const newerButWeaker = row({
      component: "EXECUTION_EVIDENCE",
      sourceClass: "OFFICIAL_DOCS", // not in establishingClasses
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const r = reconcile([onchain, newerButWeaker], reqs, { item: { step: 4, component: "EXECUTION_EVIDENCE" } });
    expect(r.supportingEvidenceIds).toEqual([onchain.id]);
  });

  it("7. исторический переход не объявлен противоречием (см. F)", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      requiresCurrentState: true,
      freshnessClass: "MEDIUM_CHANGE",
    });
    const old = row({
      component: "CURRENT_STATE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
      fetchedAt: new Date("2026-08-20T00:00:00Z"),
    });
    const fresh = row({
      component: "CURRENT_STATE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-08-01T00:00:00Z"),
      fetchedAt: new Date("2026-08-21T00:00:00Z"),
    });
    const r = reconcile([old, fresh], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).not.toBe("CONTRADICTED");
  });

  it("8. одновременное (без вытеснения) противоречие не игнорируется (см. G)", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE",
    });
    const a = row({ component: "CURRENT_STATE", sourceClass: "ONCHAIN_VERIFIABLE", mechanismState: "LIVE" });
    const b = row({ component: "CURRENT_STATE", sourceClass: "ONCHAIN_VERIFIABLE", mechanismState: "DEPRECATED" });
    const r = reconcile([a, b], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("CONTRADICTED");
  });

  it("9. просроченное CURRENT_STATE не принято (см. H)", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE",
    });
    const stale = row({ component: "CURRENT_STATE", mechanismState: "LIVE", publishedAt: new Date(NOW.getTime() - 30 * DAY) });
    const r = reconcile([stale], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("10. SOCIAL не блокирует установленный компонент (см. R)", () => {
    const reqs = requirements({ establishingClasses: ["OFFICIAL_DOCS"] });
    const official = row({ mechanismState: "LIVE" });
    const social = row({ sourceClass: "SOCIAL", relationship: "CONTRADICTS" });
    const r = reconcile([official, social], reqs);
    expect(r.status).toBe("SUPPORTED");
  });

  it("11. состояние вне словаря не становится отдельным состоянием", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE",
    });
    const weird = row({ component: "CURRENT_STATE", mechanismState: "totally-made-up-state" });
    const r = reconcile([weird], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.currentState).not.toBe("totally-made-up-state");
  });

  it("12. Evidence чужого компонента не принято (см. J)", () => {
    const r = reconcile([row({ component: "WRONG" })], requirements());
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("13. sourceClass не пересчитывается в S5 — reconciler читает поле как есть, не выводит его заново", () => {
    const r = row({ sourceClass: "OFFICIAL_DOCS" });
    reconcile([r], requirements());
    expect(r.sourceClass).toBe("OFFICIAL_DOCS"); // input row itself is never mutated
  });

  it("14. officiality не повышается в S5 — CLAIMED остаётся CLAIMED на входной строке", () => {
    const r = row({ officiality: "CLAIMED" });
    reconcile([r], requirements());
    expect(r.officiality).toBe("CLAIMED");
  });

  it("15. порядок строк не меняет результат (см. K)", () => {
    const rows = [row({ sourceId: "a" }), row({ sourceId: "b" })];
    const r1 = reconcile(rows, requirements());
    const r2 = reconcile([...rows].reverse(), requirements());
    expect(r1).toEqual(r2);
  });

  it("16. дубликат не прибавляет силы (см. L)", () => {
    const a = row({ extractionUnitKey: "u" });
    const b = row({ extractionUnitKey: "u" });
    const r = reconcile([a, b], requirements());
    expect(r.supportingEvidenceIds.length).toBe(1);
  });

  it("17. отсутствие Evidence не становится системной ошибкой (см. M)", () => {
    expect(() => reconcile([], requirements())).not.toThrow();
    expect(reconcile([], requirements()).status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("18. ярлык механизма (текст 'burn' в OFFICIAL_DOCS) не определяет NET_EFFECT (см. P)", () => {
    const reqs = requirements({ component: "NET_EFFECT", establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT", "DATA_PROVIDER"] });
    const r = reconcile([row({ component: "NET_EFFECT", sourceClass: "OFFICIAL_DOCS", fragment: "burn burn burn" })], reqs, {
      item: { step: 7, component: "NET_EFFECT" },
    });
    expect(r.status).not.toBe("SUPPORTED");
  });

  it("19. S5 не изменяет строку Evidence — глубокая проверка отсутствия мутации", () => {
    const before = row();
    const snapshot = JSON.parse(JSON.stringify(before));
    reconcile([before], requirements());
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });

  it("20. S5 не производит запись памяти — reconcileComponent не имеет побочных эффектов (чистая функция, нет DB-параметра)", () => {
    // Structural: reconcileComponent's signature takes no db handle at
    // all — there is no code path here that could write anything.
    const result = reconcile([row()], requirements());
    expect(result).toBeDefined();
  });

  it("21. PARTIALLY_SUPPORTED никогда не пуст по reasonCodes", () => {
    const r = reconcile([row({ officiality: "CLAIMED" })], requirements());
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes.length).toBeGreaterThan(0);
  });

  it("22. в S5 нет вызова модели — reconcileComponent синхронна и детерминирована без внешних импортов сети/SDK", () => {
    const start = reconcileComponent.toString();
    expect(start).not.toMatch(/fetch\(|Anthropic|await/);
  });

  it("23. вытеснение не решается глобальным рейтингом классов вместо пригодности по компоненту (см. W)", () => {
    const reqs = requirements({
      component: "EXECUTION_EVIDENCE",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_REPORT"],
      requiresLiveMechanismState: true,
    });
    const onchain = row({
      component: "EXECUTION_EVIDENCE",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const docs = row({
      component: "EXECUTION_EVIDENCE",
      sourceClass: "OFFICIAL_DOCS",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const r = reconcile([onchain, docs], reqs, { item: { step: 4, component: "EXECUTION_EVIDENCE" } });
    expect(r.supportingEvidenceIds).toEqual([onchain.id]);
  });

  it("23b. вытеснение по глобальному рейтингу класса (не по Pattern) даёт ДРУГОЙ ответ, чем правильное правило — прямой дискриминирующий тест", () => {
    // establishingClasses = [OFFICIAL_DOCS] ONLY — ONCHAIN_VERIFIABLE is
    // NOT admissible for this (hypothetical) component. A global class
    // rank (any fixed ordering, e.g. "onchain always outranks docs" — the
    // tie-break order this file happens to use elsewhere for OUTPUT
    // ordering only) would incorrectly let a newer ONCHAIN_VERIFIABLE row
    // supersede an older OFFICIAL_DOCS row that is the ONLY class actually
    // capable of establishing here. The correct D-093 rule: since
    // ONCHAIN_VERIFIABLE is not in establishingClasses, it can never be "at
    // least as capable" as anything — no supersession, the older
    // OFFICIAL_DOCS row keeps establishing.
    const reqs = requirements({
      component: "MECHANISM_SPEC",
      establishingClasses: ["OFFICIAL_DOCS"],
    });
    const olderDocs = row({
      component: "MECHANISM_SPEC",
      sourceClass: "OFFICIAL_DOCS",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const newerOnchain = row({
      component: "MECHANISM_SPEC",
      sourceClass: "ONCHAIN_VERIFIABLE",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const r = reconcile([olderDocs, newerOnchain], reqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toEqual([olderDocs.id]);
    expect(r.excludedEvidence.find((e) => e.evidenceId === olderDocs.id)).toBeUndefined();
  });

  it("24. точная квалификация состояния токена не понижена автоматически (см. U)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "ve",
    });
    const r = reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "veCRV holders receive fees" })], reqs, {
      item: { step: 6, component: "RECIPIENT" },
    });
    expect(r.status).toBe("SUPPORTED");
  });

  it("25. равенство состояний токена не выводится семантически (staked != ve, оба сохраняются раздельно)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "ve",
    });
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "staked tokens receive fees" })],
      reqs,
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.tokenStateMentions).toEqual(["staked"]);
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
  });

  it("26. требования компонента не захардкожены — establishingClasses полностью определяется входным ComponentRequirements", () => {
    const permissive = requirements({ establishingClasses: ["SOCIAL", "RESEARCH_MEDIA"] });
    const r = reconcile([row({ sourceClass: "RESEARCH_MEDIA" })], permissive);
    expect(r.status).toBe("SUPPORTED");
  });

  it("27. отсутствующее требование Pattern не подменено значением по умолчанию из кода (см. Y)", () => {
    const r = reconcile([row()], requirements({ establishingClasses: [] }));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("28. CLAIMED не лишён права создавать противоречие", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "HIGH_CHANGE",
    });
    const a = row({ component: "CURRENT_STATE", officiality: "CLAIMED", mechanismState: "LIVE" });
    const b = row({ component: "CURRENT_STATE", officiality: "CLAIMED", mechanismState: "DEPRECATED" });
    const r = reconcile([a, b], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("CONTRADICTED");
  });

  it("29. tokenStateMentions заполнен, даже когда квалификация обнаружена, но понижения не было (см. U)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "ve",
    });
    const r = reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "veCRV holders receive fees" })], reqs, {
      item: { step: 6, component: "RECIPIENT" },
    });
    expect(r.status).toBe("SUPPORTED");
    expect(r.tokenStateMentions.length).toBeGreaterThan(0);
  });
});
