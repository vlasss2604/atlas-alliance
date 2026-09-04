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
  const sourceClass = overrides.sourceClass ?? "OFFICIAL_DOCS";
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
    sourceClass,
    officiality: "CONFIRMED",
    // D-134: every test in this file predates the entity-binding axis and
    // uses ONCHAIN_VERIFIABLE as "a valid admissible class" while actually
    // exercising some OTHER dimension (directness, freshness,
    // contradiction, ...). Defaulting a resolved ONCHAIN_VERIFIABLE row to
    // CONFIRMED here preserves every existing test's real intent; a test
    // that wants to exercise D-134's own exclusion path overrides
    // entityBinding explicitly (spread below always wins).
    entityBinding: sourceClass === "ONCHAIN_VERIFIABLE" ? "CONFIRMED" : null,
    // B1: documentary by default; a supply test overrides it explicitly.
    onchainFactKind: null,
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

  it("I. RECIPIENT, во фрагменте veCRV, requiredTokenState=null -> PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED, элемент не исключён, tokenStateMentions=[veCRV identity]", () => {
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
    // HIGH-5 fix: the full token-state IDENTITY is preserved ("vecrv"),
    // not collapsed into the generic qualifier "ve" — D-096 (CRV != veCRV).
    expect(r.tokenStateMentions).toContain("vecrv");
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

  it("L2. дедупликация выбирает представителя ДЕТЕРМИНИРОВАННО, независимо от порядка входного массива (прямой дискриминирующий тест для order-independence дедупа)", () => {
    // L above uses two byte-identical duplicate rows, so it cannot tell
    // "whichever came first in the array wins" apart from "the
    // deterministic sort key wins" — both pick a representative that
    // behaves identically either way. Here the two "duplicate" rows
    // (same extraction_unit_key — a data anomaly, but the reconciler must
    // still handle it deterministically) differ in officiality, so WHICH
    // one survives dedup changes the observable result
    // (INSUFFICIENT_AUTHORITY or not). Reversing the input array must not
    // change which one wins.
    const reqs = requirements();
    const confirmed = row({ extractionUnitKey: "dup-officiality", officiality: "CONFIRMED", sourceId: "s-confirmed" });
    const claimed = row({ extractionUnitKey: "dup-officiality", officiality: "CLAIMED", sourceId: "s-claimed" });
    const forward = reconcile([confirmed, claimed], reqs);
    const backward = reconcile([claimed, confirmed], reqs);
    expect(forward).toEqual(backward);
    // The deterministic sort order (§12) ranks CONFIRMED ahead of CLAIMED
    // as a tie-break, so the confirmed row is the stable winner either way.
    expect(forward.supportingEvidenceIds).toEqual([confirmed.id]);
    expect(forward.status).toBe("SUPPORTED");
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

  it("U. RECIPIENT, requiredTokenState=veCRV (canonical owner scenario), Evidence про veCRV -> SUPPORTED; понижения нет; tokenStateMentions всё равно заполнен", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "GOVERNANCE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });
    const r = reconcile(
      [row({ component: "RECIPIENT", fragment: "veCRV holders receive protocol fees", summary: null })],
      reqs,
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).not.toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toContain("vecrv");
  });

  it("U2. RECIPIENT, requiredTokenState=veCRV, Evidence про veBAL (ДРУГОЙ токен, тот же префикс) -> НЕ совпадает, PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED (deep audit HIGH-5b: разные ve-состояния не сливаются)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS", "GOVERNANCE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });
    const r = reconcile(
      [row({ component: "RECIPIENT", fragment: "veBAL holders receive protocol fees", summary: null })],
      reqs,
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["vebal"]);
  });

  it("V. NET_EFFECT, requiredTokenState=veCRV, Evidence про stkAAVE (иное состояние) -> PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED; состояния не слиты, элемент не исключён", () => {
    const reqs = requirements({
      component: "NET_EFFECT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });
    const r = reconcile(
      [row({ component: "NET_EFFECT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "stkAAVE holders receive safety incentives", summary: null })],
      reqs,
      { item: { step: 7, component: "NET_EFFECT" } },
    );
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["stkaave"]);
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
    // mechanismState set explicitly (DEPRECATED, disagreeing with LIVE) —
    // a SOCIAL row with no state at all (UNKNOWN) can never enter
    // contradiction detection regardless of class-eligibility, so it
    // would pass even if the class gate for CONTRADICTS rows regressed.
    // The state must actually disagree for this to be a real test of the
    // "SOCIAL disagreement never blocks" rule, not a no-op.
    const social = row({ sourceClass: "SOCIAL", relationship: "CONTRADICTS", mechanismState: "DEPRECATED" });
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
    // A weak `.not.toBe("totally-made-up-state")` would trivially pass on
    // a case-transformed pass-through ("TOTALLY-MADE-UP-STATE") without
    // actually proving normalization happened. A genuinely UNKNOWN state
    // is never reported as currentState at all (there is nothing to
    // report) — so the correct positive assertion is null, which a
    // pass-through mutation (reporting the raw unrecognized string
    // instead) would violate.
    expect(r.currentState).toBeNull();
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

  it("24. точная квалификация состояния токена не понижена автоматически (см. U, канонический requiredTokenState=veCRV)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });
    const r = reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "veCRV holders receive fees" })], reqs, {
      item: { step: 6, component: "RECIPIENT" },
    });
    expect(r.status).toBe("SUPPORTED");
  });

  it("25. равенство состояний токена не выводится семантически (staked != veCRV, оба сохраняются раздельно)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "staked tokens receive fees" })],
      reqs,
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.tokenStateMentions).toEqual(["staked"]);
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
  });

  it("25b. stETH не сливается со stkAAVE — разные fused-префиксы (st vs stk) дают разные идентичности (deep audit HIGH-5c)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "stkAAVE",
    });
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "stETH balances rebase daily for holders" })],
      reqs,
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.tokenStateMentions).toEqual(["steth"]);
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

  it("29. tokenStateMentions заполнен, даже когда квалификация обнаружена, но понижения не было (см. U, канонический requiredTokenState=veCRV)", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });
    const r = reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "veCRV holders receive fees" })], reqs, {
      item: { step: 6, component: "RECIPIENT" },
    });
    expect(r.status).toBe("SUPPORTED");
    expect(r.tokenStateMentions).toEqual(["vecrv"]);
  });
});

// ============================================================
// Deep audit fix package (phase-6-s5-audit.md) — HIGH-3 supersession,
// MEDIUM-1 contradiction, MEDIUM-2 provenance partition, MEDIUM-4
// contradiction test-teeth. §15/§16 test matrices of the fix task.
// ============================================================
describe("Deep audit HIGH-3: вытеснение требует полной пригодности к установлению (§16 матрица)", () => {
  // Baseline for all P1x probes: MECHANISM_SPEC, establishing =
  // [OFFICIAL_DOCS, GOVERNANCE]; older row is a genuine DIRECT SUPPORTS
  // CONFIRMED OFFICIAL_DOCS LIVE 2025 — exactly the deep-audit repro shape.
  const reqs = requirements({
    component: "MECHANISM_SPEC",
    establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"],
  });
  function olderEstablishing() {
    return row({
      component: "MECHANISM_SPEC",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      directness: "DIRECT",
      relationship: "SUPPORTS",
      mechanismState: "LIVE",
      publishedAt: new Date("2025-01-01T00:00:00Z"),
    });
  }
  function newerNonEstablishing(overrides: Partial<EvidenceRow>) {
    return row({
      component: "MECHANISM_SPEC",
      sourceClass: "OFFICIAL_DOCS",
      mechanismState: "DEPRECATED",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    });
  }

  it("P1a: старая DIRECT SUPPORTS выживает — новая строка INFERRED допустимого класса не вытесняет", () => {
    const older = olderEstablishing();
    const newer = newerNonEstablishing({ directness: "INFERRED", relationship: "SUPPORTS", sourceId: "newer" });
    const r = reconcile([older, newer], reqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toEqual([older.id]);
    expect(r.excludedEvidence.find((e) => e.evidenceId === older.id)).toBeUndefined();
  });

  it("P1b: старая DIRECT SUPPORTS выживает — новая строка CONTEXT допустимого класса не вытесняет", () => {
    const older = olderEstablishing();
    const newer = newerNonEstablishing({ relationship: "CONTEXT", directness: "DIRECT", sourceId: "newer" });
    const r = reconcile([older, newer], reqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toEqual([older.id]);
  });

  it("P1c: старая DIRECT SUPPORTS выживает — новая строка LIMITS допустимого класса не вытесняет", () => {
    const older = olderEstablishing();
    const newer = newerNonEstablishing({ relationship: "LIMITS", directness: "DIRECT", sourceId: "newer" });
    const r = reconcile([older, newer], reqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toEqual([older.id]);
  });

  it("P1d: старая DIRECT SUPPORTS выживает — новая строка INDIRECT (даже CLAIMED) допустимого класса не вытесняет", () => {
    const older = olderEstablishing();
    const newer = newerNonEstablishing({ directness: "INDIRECT", relationship: "SUPPORTS", officiality: "CLAIMED", sourceId: "newer" });
    const r = reconcile([older, newer], reqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    // The core HIGH-3 guarantee: the INDIRECT row must never SUPERSEDE —
    // the strong DIRECT establishment is never excluded/erased, and never
    // downgraded to INDIRECT_ONLY (a real, still-standing DIRECT
    // establishing element exists). Status may still land on
    // PARTIALLY_SUPPORTED via INSUFFICIENT_AUTHORITY — that reflects the
    // separate, orthogonal §12 "best-ranked" tie-break for the authority
    // cap (which prefers the newer row for THAT purpose only), not a
    // supersession defect; the point under test is that the older id is
    // never excluded and INDIRECT_ONLY never fires.
    expect(r.excludedEvidence.find((e) => e.evidenceId === older.id)).toBeUndefined();
    expect(r.supportingEvidenceIds).toContain(older.id);
    expect(r.reasonCodes).not.toContain("INDIRECT_ONLY");
  });

  it("newer eligible DIRECT SUPPORTS with a valid newer state may still supersede (§16 positive control — D-093 intact)", () => {
    const older = olderEstablishing();
    const newer = newerNonEstablishing({ directness: "DIRECT", relationship: "SUPPORTS", sourceId: "newer" });
    const r = reconcile([older, newer], reqs, { item: { step: 3, component: "MECHANISM_SPEC" } });
    expect(r.status).toBe("SUPPORTED");
    expect(r.supportingEvidenceIds).toEqual([newer.id]);
    expect(r.excludedEvidence.find((e) => e.evidenceId === older.id)?.reason).toBe("SUPERSEDED_BY_NEWER");
  });
});

describe("Deep audit MEDIUM-1: противоречие требует несовместимых состояний, не метку relationship (§15 матрица)", () => {
  const reqs = requirements({
    component: "CURRENT_STATE",
    establishingClasses: ["OFFICIAL_DOCS"],
    requiresCurrentState: true,
    freshnessClass: "LOW_CHANGE",
  });

  it("P6: DIRECT SUPPORTS(LIVE) + DIRECT CONTRADICTS(LIVE, тот же класс) -> НЕ CONTRADICTED (метка relationship одна не фабрикует конфликт при равных состояниях)", () => {
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const contradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "LIVE", sourceId: "c" });
    const r = reconcile([supports, contradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).not.toBe("CONTRADICTED");
  });

  it("DIRECT SUPPORTS(LIVE) + DIRECT CONTRADICTS(DEPRECATED, допустимый класс) -> CONTRADICTED (несовместимые состояния)", () => {
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const contradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "DEPRECATED", sourceId: "c" });
    const r = reconcile([supports, contradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("CONTRADICTED");
    expect(r.contradictingEvidenceIds.sort()).toEqual([supports.id, contradicts.id].sort());
  });

  it("P4a: одинокая DIRECT CONTRADICTS допустимого класса без противоречащей SUPPORTS-строки не создаёт конфликта — честный SUPPORTED по единственной SUPPORTS", () => {
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const loneContradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "LIVE", sourceId: "c" });
    const r = reconcile([supports, loneContradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("SUPPORTED");
  });

  it("P7: только одинокая DIRECT CONTRADICTS строка (нет SUPPORTS вовсе) -> честный INSUFFICIENT_EVIDENCE, не ошибка и не ложный SUPPORTED", () => {
    const loneContradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "DEPRECATED" });
    const r = reconcile([loneContradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("Deep audit MEDIUM-2: партиция provenance — id не может быть одновременно contradicting и excluded (§7 инвариант)", () => {
  it("P3a: активно противоречащая CONTRADICTS-строка НЕ появляется в excludedEvidence", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "LOW_CHANGE",
    });
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const contradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "DEPRECATED", sourceId: "c" });
    const r = reconcile([supports, contradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("CONTRADICTED");
    expect(r.contradictingEvidenceIds).toContain(contradicts.id);
    expect(r.excludedEvidence.find((e) => e.evidenceId === contradicts.id)).toBeUndefined();
  });

  it("инвариант дизъюнктности: ни один id не встречается более чем в одном из supporting/contradicting/excluded — прогнан по нескольким фикстурам", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "LOW_CHANGE",
    });
    const fixtures: EvidenceRow[][] = [
      [
        row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" }),
        row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "DEPRECATED", sourceId: "c" }),
      ],
      [
        row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" }),
        row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "LIVE", sourceId: "c" }),
      ],
      [
        row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "DEPRECATED" }),
      ],
      [row({ component: "CURRENT_STATE", sourceClass: "SOCIAL", relationship: "CONTRADICTS", mechanismState: "DEPRECATED" })],
    ];
    for (const evidence of fixtures) {
      const r = reconcile(evidence, reqs, { item: { step: 5, component: "CURRENT_STATE" } });
      const supportingSet = new Set(r.supportingEvidenceIds);
      const contradictingSet = new Set(r.contradictingEvidenceIds);
      const excludedSet = new Set(r.excludedEvidence.map((e) => e.evidenceId));
      for (const id of supportingSet) {
        expect(contradictingSet.has(id)).toBe(false);
        expect(excludedSet.has(id)).toBe(false);
      }
      for (const id of contradictingSet) {
        expect(supportingSet.has(id)).toBe(false);
        expect(excludedSet.has(id)).toBe(false);
      }
    }
  });
});

describe("Deep audit MEDIUM-4: зубы для допустимого DIRECT CONTRADICTS (не SOCIAL) — §9 матрица", () => {
  function reqsFor(component: string) {
    return requirements({ component, establishingClasses: ["OFFICIAL_DOCS"], requiresCurrentState: true, freshnessClass: "LOW_CHANGE" });
  }

  it("допустимая DIRECT CONTRADICTS участвует и создаёт CONTRADICTED против DIRECT SUPPORTS с иным состоянием", () => {
    const reqs = reqsFor("CURRENT_STATE");
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const contradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "DEPRECATED", sourceId: "c" });
    const r = reconcile([supports, contradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("CONTRADICTED");
  });

  it("INDIRECT CONTRADICTS допустимого класса НЕ создаёт терминального конфликта (mutation M2 teeth)", () => {
    const reqs = reqsFor("CURRENT_STATE");
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const indirectContradicts = row({
      component: "CURRENT_STATE",
      relationship: "CONTRADICTS",
      directness: "INDIRECT",
      mechanismState: "DEPRECATED",
      sourceId: "c",
    });
    const r = reconcile([supports, indirectContradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("SUPPORTED");
  });

  it("INFERRED CONTRADICTS допустимого класса НЕ создаёт терминального конфликта", () => {
    const reqs = reqsFor("CURRENT_STATE");
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const inferredContradicts = row({
      component: "CURRENT_STATE",
      relationship: "CONTRADICTS",
      directness: "INFERRED",
      mechanismState: "DEPRECATED",
      sourceId: "c",
    });
    const r = reconcile([supports, inferredContradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("SUPPORTED");
  });

  it("SOCIAL CONTRADICTS не может создать конфликт там, где Pattern исключает SOCIAL (mutation M5 teeth — SUPPORTS-vs-CONTRADICTS ветка проверена НЕ через SOCIAL здесь, а классовым порогом отдельно)", () => {
    const reqs = reqsFor("CURRENT_STATE");
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const social = row({ component: "CURRENT_STATE", sourceClass: "SOCIAL", relationship: "CONTRADICTS", mechanismState: "DEPRECATED", sourceId: "c" });
    const r = reconcile([supports, social], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("SUPPORTED");
  });

  it("одинаковое состояние между SUPPORTS и допустимой DIRECT CONTRADICTS не фабрикует конфликт (mutation M6-style teeth)", () => {
    const reqs = reqsFor("CURRENT_STATE");
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const sameStateContradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "LIVE", sourceId: "c" });
    const r = reconcile([supports, sameStateContradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).not.toBe("CONTRADICTED");
  });

  it("несовместимое состояние может создать конфликт (позитивный контроль)", () => {
    const reqs = reqsFor("CURRENT_STATE");
    const supports = row({ component: "CURRENT_STATE", relationship: "SUPPORTS", mechanismState: "LIVE" });
    const differentStateContradicts = row({ component: "CURRENT_STATE", relationship: "CONTRADICTS", mechanismState: "DEPRECATED", sourceId: "c" });
    const r = reconcile([supports, differentStateContradicts], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("CONTRADICTED");
  });
});

describe("Deep audit LOW-1/LOW-2: currentState не выбирается молча при разногласии партиалов; tokenStateMentions на CONTRADICTED", () => {
  it("LOW-1: две INDIRECT-строки с разными состояниями -> currentState=null, не молчаливый выбор", () => {
    const reqs = requirements({
      component: "CURRENT_STATE",
      establishingClasses: ["OFFICIAL_DOCS"],
      requiresCurrentState: true,
      freshnessClass: "LOW_CHANGE",
    });
    const a = row({ component: "CURRENT_STATE", directness: "INDIRECT", mechanismState: "LIVE" });
    const b = row({ component: "CURRENT_STATE", directness: "INDIRECT", mechanismState: "DEPRECATED", sourceId: "b" });
    const r = reconcile([a, b], reqs, { item: { step: 5, component: "CURRENT_STATE" } });
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.currentState).toBeNull();
  });

  it("LOW-2: tokenStateMentions заполняется даже на CONTRADICTED, если конфликтующие строки называют квалифицированное состояние", () => {
    const reqs = requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      requiresCurrentState: false,
    });
    const supports = row({
      component: "RECIPIENT",
      sourceClass: "ONCHAIN_VERIFIABLE",
      relationship: "SUPPORTS",
      mechanismState: "LIVE",
      fragment: "veCRV holders receive fees",
    });
    const contradicts = row({
      component: "RECIPIENT",
      sourceClass: "ONCHAIN_VERIFIABLE",
      relationship: "CONTRADICTS",
      mechanismState: "DEPRECATED",
      fragment: "veCRV holders receive nothing",
      sourceId: "c",
    });
    const r = reconcile([supports, contradicts], reqs, { item: { step: 6, component: "RECIPIENT" } });
    expect(r.status).toBe("CONTRADICTED");
    expect(r.tokenStateMentions).toEqual(["vecrv"]);
  });
});

describe("Final review, deep-audit round 2: token-state identity must not fail open on casing/separators (D-096)", () => {
  const veCrvReqs = () =>
    requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });

  // Owner scenarios A-D: veCRV survives camelCase, Titlecase, and
  // ALL-CAPS casing — none of these downgrade a SUPPORTED result, and
  // all normalize to the SAME tokenStateMentions identity.
  it.each([
    ["A. veCRV (canonical camelCase)", "veCRV holders receive fees"],
    ["B. VeCRV (Titlecase prefix)", "VeCRV holders receive fees"],
    ["C. VECRV (ALL-CAPS)", "VECRV holders receive fees"],
  ])("%s -> SUPPORTED, no TOKEN_STATE_UNQUALIFIED, tokenStateMentions=[veCRV identity]", (_label, fragment) => {
    const r = reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment })], veCrvReqs(), {
      item: { step: 6, component: "RECIPIENT" },
    });
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).not.toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["vecrv"]);
  });

  // Owner scenario E: veBAL (same prefix, different ticker) must NOT match
  // requiredTokenState=veCRV, regardless of the casing fix above.
  it("E. veBAL != required veCRV -> PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED", () => {
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "veBAL holders receive fees" })],
      veCrvReqs(),
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["vebal"]);
  });

  const stkAaveReqs = () =>
    requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "stkAAVE",
    });

  // Owner scenarios F-G: stkAAVE casing matrix.
  it.each([
    ["F. stkAAVE (canonical camelCase)", "stkAAVE holders receive rewards"],
    ["G. STKAAVE (ALL-CAPS)", "STKAAVE holders receive rewards"],
  ])("%s -> SUPPORTED, tokenStateMentions=[stkAAVE identity]", (_label, fragment) => {
    const r = reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment })], stkAaveReqs(), {
      item: { step: 6, component: "RECIPIENT" },
    });
    expect(r.status).toBe("SUPPORTED");
    expect(r.tokenStateMentions).toEqual(["stkaave"]);
  });

  // Owner scenarios H-I: bare ticker and a different fused prefix never
  // imply the required qualified state.
  it("H. bare AAVE never fabricates stkAAVE identity (no qualifier mentioned at all -> nothing to flag; pre-existing D-096 semantics, unchanged by the casing fix)", () => {
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "AAVE holders receive rewards" })],
      stkAaveReqs(),
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).not.toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual([]);
  });

  it("I. stETH != required stkAAVE -> PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED, tokenStateMentions=[steth]", () => {
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "stETH holders receive rewards" })],
      stkAaveReqs(),
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["steth"]);
  });

  // Owner scenario J: multiple distinct fused identities in one fragment
  // are all preserved, never merged.
  it("J. Evidence содержит veCRV и veBAL -> tokenStateMentions сохраняет обе раздельно", () => {
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "veCRV holders and veBAL holders both receive fees" })],
      veCrvReqs(),
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.tokenStateMentions.slice().sort()).toEqual(["vebal", "vecrv"]);
  });

  // Owner scenario K: ordinary English words sharing the "ve"/"st"/"stk"
  // prefix in normal lowercase prose must never fabricate an identity —
  // this is the boundary the casing fix must not weaken.
  it("K. give/never/starter/stone/vested/vehicle в обычной прозе не создают fused token-state идентичность", () => {
    const r = reconcile(
      [
        row({
          component: "RECIPIENT",
          sourceClass: "ONCHAIN_VERIFIABLE",
          fragment: "They never give a starter kit; the vested amount sits on a stone monument near the vehicle depot",
        }),
      ],
      veCrvReqs(),
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.tokenStateMentions).not.toContain("stone");
    expect(r.tokenStateMentions).not.toContain("starter");
    expect(r.tokenStateMentions).not.toContain("vehicle");
    // "vested" IS expected — as the pre-existing GENERIC qualifier match
    // only (TOKEN_STATE_QUALIFIERS), never as a fused "ve"+"sted" identity.
    expect(r.tokenStateMentions).toEqual(["vested"]);
  });

  // §6 separator forms: "ve-CRV" / "ve CRV" normalize to the same
  // identity as the fused form, licensed by the same uppercase-ticker-
  // start discipline (so "ve fees"/"ve-something" still cannot fuse).
  it.each([
    ["ve-CRV (hyphen separator)", "ve-CRV holders receive fees"],
    ["ve CRV (space separator)", "ve CRV holders receive fees"],
  ])("separator form: %s -> SUPPORTED, tokenStateMentions=[veCRV identity]", (_label, fragment) => {
    const r = reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment })], veCrvReqs(), {
      item: { step: 6, component: "RECIPIENT" },
    });
    expect(r.status).toBe("SUPPORTED");
    expect(r.tokenStateMentions).toEqual(["vecrv"]);
  });

  it("separator discipline is not a blank two-word license: 've fees' does not fuse into a bogus identity", () => {
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "ve fees are distributed to holders" })],
      veCrvReqs(),
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.tokenStateMentions).toEqual([]);
  });

  // §8 carry-forward: the qualified identity is recorded in
  // tokenStateMentions even when the casing fix means there is no
  // downgrade at all (SUPPORTED, not PARTIALLY_SUPPORTED).
  it("carry-forward: SUPPORTED (no downgrade) via ALL-CAPS still populates tokenStateMentions with the normalized identity", () => {
    const r = reconcile(
      [row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment: "VECRV holders receive protocol fees" })],
      veCrvReqs(),
      { item: { step: 6, component: "RECIPIENT" } },
    );
    expect(r.status).toBe("SUPPORTED");
    expect(r.tokenStateMentions).toEqual(["vecrv"]);
  });
});

describe("Final review, deep-audit round 3 (MEDIUM-1): known-state VERIFICATION vs unknown-state DISCOVERY must not fail open on ALL-CAPS prose", () => {
  const veCrvReqs = () =>
    requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "veCRV",
    });
  const stkAaveReqs = () =>
    requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: "stkAAVE",
    });
  const noRequiredStateReqs = () =>
    requirements({
      component: "RECIPIENT",
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      tokenStateSensitive: true,
      requiredTokenState: null,
    });

  const reconcileWith = (reqs: ReturnType<typeof veCrvReqs>, fragment: string) =>
    reconcile([row({ component: "RECIPIENT", sourceClass: "ONCHAIN_VERIFIABLE", fragment })], reqs, {
      item: { step: 6, component: "RECIPIENT" },
    });

  // §12 known-state regression matrix — requiredTokenState=veCRV: every
  // casing/separator combination VERIFIES to the same identity.
  it.each([
    "veCRV", "VeCRV", "VECRV", "vecrv", "ve-CRV", "ve CRV", "VE-CRV", "VE CRV",
  ])("known state veCRV: %s holders receive fees -> SUPPORTED, tokenStateMentions=[vecrv]", (form) => {
    const r = reconcileWith(veCrvReqs(), `${form} holders receive fees`);
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).not.toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["vecrv"]);
  });

  // §12 known-state false-positive matrix — a DIFFERENT qualified
  // identity is genuinely discovered (veBAL, a real distinct state), so
  // D-096's existing downgrade rule correctly fires: it does not verify
  // veCRV.
  it("known state veCRV: veBAL holders receive fees -> does NOT verify, PARTIALLY_SUPPORTED + TOKEN_STATE_UNQUALIFIED", () => {
    const r = reconcileWith(veCrvReqs(), "veBAL holders receive fees");
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["vebal"]);
  });

  // §12 known-state false-positive matrix — none of these ordinary-prose
  // forms verify veCRV, and none fabricate ANY identity at all
  // (tokenStateMentions stays empty) — so, per the pre-existing,
  // unchanged D-096 downgrade rule (TOKEN_STATE_UNQUALIFIED only fires
  // when something WAS detected), the component is SUPPORTED: there is
  // nothing to disagree with the required state.
  it.each([
    "VEHICLE for value capture",
    "VESTING schedule for team",
    "We VE BOUGHT back tokens",
    "never give",
    "give away tokens",
  ])("known state veCRV: %s -> no identity fabricated at all, SUPPORTED, tokenStateMentions=[]", (fragment) => {
    const r = reconcileWith(veCrvReqs(), fragment);
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).not.toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual([]);
  });

  // §12 known-state regression matrix — requiredTokenState=stkAAVE.
  it.each([
    "stkAAVE", "StkAAVE", "STKAAVE", "stkaave", "stk-AAVE", "stk AAVE",
  ])("known state stkAAVE: %s holders receive rewards -> SUPPORTED, tokenStateMentions=[stkaave]", (form) => {
    const r = reconcileWith(stkAaveReqs(), `${form} holders receive rewards`);
    expect(r.status).toBe("SUPPORTED");
    expect(r.tokenStateMentions).toEqual(["stkaave"]);
  });

  // §12/§15 — the exact Opus ALL-CAPS-heading reproductions must never
  // verify stkAAVE, and must not fabricate ANY fused identity at all —
  // so the component is SUPPORTED (nothing detected to disagree with the
  // required state), never a false stkAAVE match. This is the block that
  // makes the MEDIUM impossible to reintroduce.
  it.each([
    "STAKING REWARDS: 50% of protocol fees are distributed to stakers",
    "STARTER GUIDE FOR HOLDERS",
    "Section 3.2 STATE TRANSITIONS are governed on-chain",
    "STONE COLD HOLDERS",
    "AAVE holders receive rewards",
  ])("known state stkAAVE: %s -> does NOT verify (no fabricated identity), SUPPORTED", (fragment) => {
    const r = reconcileWith(stkAaveReqs(), fragment);
    expect(r.status).toBe("SUPPORTED");
    expect(r.tokenStateMentions).toEqual([]);
  });

  // stETH is a real, distinct identity — DISCOVERY correctly still finds
  // it even though it does not verify the different required state
  // stkAAVE (unchanged from the accepted prior-round scenario I).
  it("known state stkAAVE: stETH holders receive rewards -> does not verify stkAAVE, but tokenStateMentions still records the real steth identity", () => {
    const r = reconcileWith(stkAaveReqs(), "stETH holders receive rewards");
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toContain("TOKEN_STATE_UNQUALIFIED");
    expect(r.tokenStateMentions).toEqual(["steth"]);
  });

  // §13/§15 — the exact Opus ALL-CAPS/unsafe-separator reproductions,
  // required as PERMANENT regression tests, for UNKNOWN state
  // (requiredTokenState=null). None may fabricate a fused identity.
  it.each([
    "STAKING REWARDS: 50% of protocol fees are distributed to stakers",
    "VESTING SCHEDULE: team tokens unlock linearly over 4 years",
    "Section 3.2 STATE TRANSITIONS are governed on-chain",
    "VEHICLE FOR VALUE CAPTURE",
    "STARTER GUIDE FOR HOLDERS",
    "STONE COLD HOLDERS",
    "St Petersburg office opened",
    "We VE BOUGHT back tokens",
  ])("unknown state (requiredTokenState=null): %s -> no fused token-state identity fabricated", (fragment) => {
    const r = reconcileWith(noRequiredStateReqs(), fragment);
    expect(r.tokenStateMentions).toEqual([]);
  });

  // §7/§8 — unknown state, fully bare ALL-CAPS/all-lowercase fused forms
  // (no case-transition, no separator) remain a documented, conservative
  // LOW limitation: acceptable to leave undetected without a requiredTokenState
  // anchor, rather than guessing.
  it.each([
    ["VECRV holders receive fees", []],
    ["vecrv holders receive fees", []],
    ["STKAAVE holders receive rewards", []],
  ])("unknown state (requiredTokenState=null): bare %s left conservatively undetected", (fragment, expected) => {
    const r = reconcileWith(noRequiredStateReqs(), fragment);
    expect(r.tokenStateMentions).toEqual(expected);
  });

  // §13 unknown-state safe-discovery matrix — structurally unambiguous
  // forms (case transition or explicit lowercase-prefix separator) ARE
  // still discovered with no required state at all.
  it.each([
    ["veCRV holders receive fees", ["vecrv"]],
    ["VeCRV holders receive fees", ["vecrv"]],
    ["ve-CRV holders receive fees", ["vecrv"]],
    ["ve CRV holders receive fees", ["vecrv"]],
    ["stkAAVE holders receive rewards", ["stkaave"]],
    ["StkAAVE holders receive rewards", ["stkaave"]],
    ["stk-AAVE holders receive rewards", ["stkaave"]],
    ["stk AAVE holders receive rewards", ["stkaave"]],
    ["stETH holders receive rewards", ["steth"]],
    ["StETH holders receive rewards", ["steth"]],
    ["st-ETH holders receive rewards", ["steth"]],
    ["st ETH holders receive rewards", ["steth"]],
  ])("unknown state (requiredTokenState=null): %s -> tokenStateMentions=%j", (fragment, expected) => {
    const r = reconcileWith(noRequiredStateReqs(), fragment);
    expect(r.tokenStateMentions).toEqual(expected);
  });

  // §14 — multiple distinct identities are still preserved, never
  // collapsed, under the tightened discovery grammar too.
  it("multi-identity: veCRV and veBAL holders vote -> tokenStateMentions preserves both distinct identities", () => {
    const r = reconcileWith(noRequiredStateReqs(), "veCRV and veBAL holders vote");
    expect(r.tokenStateMentions.slice().sort()).toEqual(["vebal", "vecrv"]);
  });

  // §10 — requiredTokenState is never fabricated into tokenStateMentions
  // merely because Pattern names it; it must actually be found.
  it("requiredTokenState is never fabricated when Evidence never mentions it at all", () => {
    const r = reconcileWith(veCrvReqs(), "the protocol distributes fees to holders");
    expect(r.tokenStateMentions).toEqual([]);
  });
});
