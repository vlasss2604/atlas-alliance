import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResearchJobDetail } from "../src/client/api";
import { buildAuditContent } from "../src/client/audit-model";
import { ResearchResult } from "../src/client/components/research-result";
import {
  TYPED_VALUE_ABSENT_LIMIT,
  requiresTypedValue,
  typedMechanismValueOf,
  typedValueAbsent,
} from "../src/client/mechanism-typed-value";
import { buildResultSurface, type ResultStatus } from "../src/client/result-surface";
import { RESULT_FIXTURES, resultFixture } from "../src/client/result-surface-fixtures";

// PRESENTATION MUST NOT CREATE NEW TRUTH. PAGE <= PERSISTED VERIFIED RECORD.
//
// The primary Result may present a recipient or a destination as known only
// when a stored mechanism flow carries a specific typed value for it. The
// stored component status is never rewritten; the page just does not say
// more than the record holds.

const RECIPIENT_LIMIT = "Sources were read on this point, but the record does not identify a specific recipient.";
const DESTINATION_LIMIT = "Sources were read on this point, but the record does not establish a specific destination.";

type Flow = { lineage: { step: number; component: string; evidenceIds: string[] }[]; attributes: Record<string, unknown>; gaps?: unknown[] };
const withMechanism = (d: ResearchJobDetail, flows: Flow[] | null): ResearchJobDetail => ({
  ...d,
  mechanism: flows === null ? null : { flows, unassignedGaps: [] },
});
const idsOf = (d: ResearchJobDetail, component: string) => d.components.find((c) => c.component === component)!.supportingEvidenceIds;
const flowOf = (d: ResearchJobDetail, components: string[], attributes: Record<string, unknown>): Flow => ({
  lineage: components.map((c) => ({ step: d.components.find((x) => x.component === c)!.patternStep, component: c, evidenceIds: [...idsOf(d, c)] })),
  attributes,
});
const rowOf = (d: ResearchJobDetail, component: string) => buildResultSurface(d).table.find((r) => r.component === component)!;
const render = (d: ResearchJobDetail) => renderToStaticMarkup(createElement(ResearchResult, { detail: d, jobId: d.job.id }));
const textOf = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const RANK: Record<ResultStatus, number> = { CONTRADICTED: 0, NOT_ESTABLISHED: 1, PARTIAL: 2, CONFIRMED: 3 };

// Fixture "1": every component SUPPORTED, recipient and destination typed.
const STRONG = resultFixture("1").detail;

describe("1. the typed value is read from the stored mechanism record and nothing else", () => {
  it("only RECIPIENT and DESTINATION need one", () => {
    expect(requiresTypedValue("RECIPIENT")).toBe(true);
    expect(requiresTypedValue("DESTINATION")).toBe(true);
    for (const c of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "CURRENT_STATE", "EXECUTION_EVIDENCE", "NET_EFFECT"]) {
      expect(requiresTypedValue(c), c).toBe(false);
    }
  });

  it("a specific kind on a flow that carries the component is the value; UNKNOWN, NONE, off-lineage and no record are not", () => {
    const lineage = [{ step: 6, component: "RECIPIENT", evidenceIds: ["e1", "e2"] }];
    expect(typedMechanismValueOf([{ lineage, attributes: { recipientKind: "TREASURY" } }], "RECIPIENT")).toEqual({ kind: "TREASURY", evidenceIds: ["e1", "e2"] });
    for (const kind of ["UNKNOWN", "NONE", null, undefined, 7]) {
      expect(typedMechanismValueOf([{ lineage, attributes: { recipientKind: kind } }], "RECIPIENT"), String(kind)).toBeNull();
    }
    // The kind is on the flow, but the flow does not carry the component.
    expect(typedMechanismValueOf([{ lineage: [{ step: 1, component: "SOURCE_OF_VALUE", evidenceIds: ["s"] }], attributes: { recipientKind: "TREASURY" } }], "RECIPIENT")).toBeNull();
    // The destination attribute never answers the recipient, and vice versa.
    expect(typedMechanismValueOf([{ lineage, attributes: { destinationKind: "BURN" } }], "RECIPIENT")).toBeNull();
    for (const none of [null, undefined, []]) expect(typedMechanismValueOf(none, "RECIPIENT")).toBeNull();
    // The first flow WITH a value, in stored order.
    expect(
      typedMechanismValueOf(
        [
          { lineage, attributes: { recipientKind: "UNKNOWN" } },
          { lineage: [{ step: 6, component: "RECIPIENT", evidenceIds: ["e9"] }], attributes: { recipientKind: "STAKER" } },
        ],
        "RECIPIENT",
      ),
    ).toEqual({ kind: "STAKER", evidenceIds: ["e9"] });
  });

  it("absence applies only to a (partly) established recipient / destination", () => {
    expect(typedValueAbsent("RECIPIENT", "SUPPORTED", null)).toBe(true);
    expect(typedValueAbsent("DESTINATION", "PARTIALLY_SUPPORTED", [])).toBe(true);
    expect(typedValueAbsent("RECIPIENT", "INSUFFICIENT_EVIDENCE", null)).toBe(false);
    expect(typedValueAbsent("RECIPIENT", "CONTRADICTED", null)).toBe(false);
    expect(typedValueAbsent("SOURCE_OF_VALUE", "SUPPORTED", null)).toBe(false);
  });

  it("the reader never classifies text: no server import, no passage field, no pattern matching", () => {
    const src = readFileSync("src/client/mechanism-typed-value.ts", "utf-8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/from ["'][^"']*server/);
    expect(src).not.toMatch(/fragment|summary|proves|RegExp|\.test\(|\.match\(/);
  });
});

describe("2. no typed value → the primary Result shows NOT_ESTABLISHED, never Confirmed or Partially confirmed", () => {
  // Wave 1A (job fd1252ef): RECIPIENT stored SUPPORTED on fee-allocation
  // sentences; the stored flows carry it with recipientKind UNKNOWN.
  const wave1a = withMechanism(STRONG, [flowOf(STRONG, ["RECIPIENT", "DESTINATION"], { recipientKind: "UNKNOWN", destinationKind: "TREASURY" })]);

  it("Wave 1A shape: SUPPORTED RECIPIENT + typed UNKNOWN is not established, with the code-owned sentence", () => {
    expect(wave1a.components.find((c) => c.component === "RECIPIENT")!.status).toBe("SUPPORTED");
    const row = rowOf(wave1a, "RECIPIENT");
    expect(row.status).toBe("NOT_ESTABLISHED");
    expect(row.statusLabel).toBe("Not established");
    expect(row.established).toBe(RECIPIENT_LIMIT);
    expect(TYPED_VALUE_ABSENT_LIMIT.RECIPIENT).toBe(RECIPIENT_LIMIT);
    // The destination on the same flow IS typed and keeps its status.
    expect(rowOf(wave1a, "DESTINATION").status).toBe("CONFIRMED");
  });

  it("the top answer, the path strip and every 'rests on' line follow the row", () => {
    const surface = buildResultSurface(wave1a);
    const confirm = surface.answer.sentences.find((s) => s.startsWith("The sources confirm")) ?? "";
    const partly = surface.answer.sentences.find((s) => s.startsWith("There is evidence")) ?? "";
    expect(confirm).not.toContain("who ultimately receives it");
    expect(partly).not.toContain("who ultimately receives it");
    expect(surface.answer.sentences.join(" ")).toMatch(/does not show[^.]*who ultimately receives it/);
    expect(surface.chain.find((n) => n.component === "RECIPIENT")!.status).toBe("NOT_ESTABLISHED");
    for (const r of surface.table) {
      for (const dep of r.restsOn) if (dep.component === "RECIPIENT") expect(dep.status).not.toBe("CONFIRMED");
    }
    // With the typed value the same record folds the recipient under the
    // destination row as confirmed, and the answer lists no gap for it.
    const typed = buildResultSurface(STRONG);
    expect(typed.table.find((r) => r.component === "DESTINATION")!.restsOn.map((x) => [x.component, x.status])).toEqual([["RECIPIENT", "CONFIRMED"]]);
    expect(typed.answer.sentences.join(" ")).not.toMatch(/does not show[^.]*who ultimately receives it/);
    expect(surface.table.find((r) => r.component === "DESTINATION")!.restsOn).toEqual([]);
  });

  it("the rendered page never says the recipient is confirmed, and the evidence cards stay", () => {
    const text = textOf(render(wave1a));
    expect(text).not.toMatch(/The sources confirm[^.]*who ultimately receives it/);
    expect(text).toContain(RECIPIENT_LIMIT);
    const row = rowOf(wave1a, "RECIPIENT");
    expect(row.evidence.map((e) => e.id)).toEqual(rowOf(STRONG, "RECIPIENT").evidence.map((e) => e.id));
    expect(row.evidence.length).toBeGreaterThan(0);
  });

  it("SUPPORTED DESTINATION + no typed destination is not established", () => {
    const d = withMechanism(STRONG, [flowOf(STRONG, ["RECIPIENT", "DESTINATION"], { recipientKind: "TREASURY", destinationKind: "UNKNOWN" })]);
    const row = rowOf(d, "DESTINATION");
    expect(row.status).toBe("NOT_ESTABLISHED");
    expect(row.established).toBe(DESTINATION_LIMIT);
    expect(buildResultSurface(d).answer.sentences.find((s) => s.startsWith("The sources confirm")) ?? "").not.toMatch(/where the (?:bought tokens go|value goes)/);
    expect(rowOf(d, "RECIPIENT").status).toBe("CONFIRMED");
  });

  it("a component absent from every flow is not established, whatever the flows' attributes say", () => {
    const d = withMechanism(STRONG, [flowOf(STRONG, ["SOURCE_OF_VALUE"], { recipientKind: "TREASURY", destinationKind: "BURN" })]);
    expect(rowOf(d, "RECIPIENT").status).toBe("NOT_ESTABLISHED");
    expect(rowOf(d, "DESTINATION").status).toBe("NOT_ESTABLISHED");
  });

  it("no mechanism record at all is not established", () => {
    for (const d of [withMechanism(STRONG, null), withMechanism(STRONG, [])]) {
      expect(rowOf(d, "RECIPIENT").status).toBe("NOT_ESTABLISHED");
      expect(rowOf(d, "RECIPIENT").established).toBe(RECIPIENT_LIMIT);
      expect(rowOf(d, "DESTINATION").status).toBe("NOT_ESTABLISHED");
      expect(rowOf(d, "DESTINATION").established).toBe(DESTINATION_LIMIT);
    }
  });

  it("PARTIALLY_SUPPORTED without a typed value is not established either — never 'there is evidence who receives it'", () => {
    const partial = withMechanism(resultFixture("2").detail, null);
    expect(partial.components.find((c) => c.component === "RECIPIENT")!.status).toBe("PARTIALLY_SUPPORTED");
    expect(rowOf(partial, "RECIPIENT").status).toBe("NOT_ESTABLISHED");
    expect(rowOf(partial, "DESTINATION").status).toBe("NOT_ESTABLISHED");
    const partly = buildResultSurface(partial).answer.sentences.find((s) => s.startsWith("There is evidence")) ?? "";
    expect(partly).not.toMatch(/who ultimately receives it|where the (?:bought tokens go|value goes)/);
  });

  it("legacy chain / account context without a typed value is not established", () => {
    const base = withMechanism(STRONG, [flowOf(STRONG, ["RECIPIENT", "DESTINATION"], { recipientKind: "UNKNOWN", destinationKind: "UNKNOWN" })]);
    const chainIds = new Set([...idsOf(base, "RECIPIENT"), ...idsOf(base, "DESTINATION")]);
    const legacy: ResearchJobDetail = {
      ...base,
      components: base.components.map((c) =>
        c.component === "RECIPIENT" || c.component === "DESTINATION" ? { ...c, status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"] } : c,
      ),
      evidence: base.evidence.map((e) => (chainIds.has(e.id) ? { ...e, sourceClass: "ONCHAIN_VERIFIABLE", onchainFactKind: "ACCOUNT_INFO", officiality: "CLAIMED" } : e)),
    };
    expect(rowOf(legacy, "RECIPIENT").status).toBe("NOT_ESTABLISHED");
    expect(rowOf(legacy, "DESTINATION").status).toBe("NOT_ESTABLISHED");
  });

  it("a run that ended without a verdict gets the same ceiling in its answer", () => {
    const stopped: ResearchJobDetail = { ...withMechanism(STRONG, null), job: { ...STRONG.job, state: "BUDGET_LIMIT_REACHED" } };
    const answer = buildResultSurface(stopped).answer.sentences.join(" ");
    expect(answer).not.toMatch(/confirm[^.]*(?:who ultimately receives it|where the value ends up)/i);
  });
});

describe("3. a typed value present → the stored status is preserved and the row speaks from that flow", () => {
  it("typed recipient and typed destination keep SUPPORTED as Confirmed", () => {
    expect(rowOf(STRONG, "RECIPIENT").status).toBe("CONFIRMED");
    expect(rowOf(STRONG, "DESTINATION").status).toBe("CONFIRMED");
    expect(rowOf(STRONG, "RECIPIENT").established).not.toBe(RECIPIENT_LIMIT);
  });

  it("PARTIALLY_SUPPORTED + a typed value remains partial", () => {
    const partial = resultFixture("2").detail;
    expect(rowOf(partial, "RECIPIENT").status).toBe("PARTIAL");
    expect(rowOf(partial, "DESTINATION").status).toBe("PARTIAL");
  });

  it("the sentence and the source come from the flow carrying the typed value, not from the first supporting row", () => {
    // Fixture "8": RECIPIENT rests on two rows, the report first.
    const two = resultFixture("8").detail;
    const [first, second] = idsOf(two, "RECIPIENT");
    expect(first).toBe("ev-report-recipient");
    expect(second).toBe("ev-data-treasury");
    const summaryOf = (id: string) => two.evidence.find((e) => e.id === id)!.summary!;
    const onFlow = (ids: string[]) =>
      withMechanism(two, [{ lineage: [{ step: 6, component: "RECIPIENT", evidenceIds: ids }, ...flowOf(two, ["DESTINATION"], {}).lineage], attributes: { recipientKind: "TREASURY", destinationKind: "TREASURY" } }]);
    const fromSecond = rowOf(onFlow([second]), "RECIPIENT");
    expect(fromSecond.status).toBe("CONFIRMED");
    expect(fromSecond.established).toContain(summaryOf(second));
    expect(fromSecond.established).not.toContain(summaryOf(first));
    expect(fromSecond.evidence[0].id).toBe(second);
    const fromFirst = rowOf(onFlow([first]), "RECIPIENT");
    expect(fromFirst.established).toContain(summaryOf(first));
    // Every card stays visible either way; only the order moves.
    expect(fromSecond.evidence.map((e) => e.id).sort()).toEqual([first, second].sort());
  });
});

describe("4. nothing else moves, and nothing gets stronger", () => {
  it("removing the mechanism record changes only RECIPIENT / DESTINATION rows, and only downward — on every fixture", () => {
    for (const f of RESULT_FIXTURES) {
      const before = buildResultSurface(f.detail).table;
      const after = buildResultSurface(withMechanism(f.detail, null)).table;
      expect(after.map((r) => r.component), f.key).toEqual(before.map((r) => r.component));
      for (const b of before) {
        const a = after.find((r) => r.component === b.component)!;
        if (b.component === "RECIPIENT" || b.component === "DESTINATION") {
          expect(RANK[a.status], `${f.key}/${b.component}`).toBeLessThanOrEqual(RANK[b.status]);
          if (b.status === "CONFIRMED" || b.status === "PARTIAL") expect(a.status, `${f.key}/${b.component}`).toBe("NOT_ESTABLISHED");
        } else {
          expect(a.status, `${f.key}/${b.component}`).toBe(b.status);
          expect(a.established, `${f.key}/${b.component}`).toBe(b.established);
        }
      }
    }
  });

  it("SOURCE_OF_VALUE and FLOW_PATH are unchanged with no typed value anywhere", () => {
    const untyped = withMechanism(STRONG, [flowOf(STRONG, ["SOURCE_OF_VALUE", "FLOW_PATH", "RECIPIENT", "DESTINATION"], { valueSource: "UNKNOWN", direction: "UNKNOWN", recipientKind: "UNKNOWN", destinationKind: "UNKNOWN" })]);
    for (const c of ["SOURCE_OF_VALUE", "FLOW_PATH"]) {
      expect(rowOf(untyped, c).status, c).toBe("CONFIRMED");
      expect(rowOf(untyped, c).established, c).toBe(rowOf(STRONG, c).established);
    }
  });

  it("a typed value never lifts a status: INSUFFICIENT stays not established, PARTIAL never becomes Confirmed", () => {
    const weak: ResearchJobDetail = {
      ...STRONG,
      components: STRONG.components.map((c) => (c.component === "RECIPIENT" ? { ...c, status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], supportingEvidenceIds: [] } : c)),
    };
    expect(rowOf(weak, "RECIPIENT").status).toBe("NOT_ESTABLISHED");
    expect(rowOf(resultFixture("2").detail, "RECIPIENT").status).not.toBe("CONFIRMED");
  });

  it("the stored record is untouched: component status, proof verdict and evidence are read, never rewritten", () => {
    const d = withMechanism(STRONG, null);
    const snapshot = JSON.stringify(d);
    buildResultSurface(d);
    expect(JSON.stringify(d)).toBe(snapshot);
    expect(buildResultSurface(d).verdict).toBe(buildResultSurface(STRONG).verdict);
  });
});

describe("5. the deep audit keeps the raw record but never words it as 'recipient / destination confirmed'", () => {
  const scopeOf = (d: ResearchJobDetail, component: string) =>
    buildAuditContent(d.components, d.evidence, null, d.mechanism?.flows ?? null).scope.find((s) => s.component === component)!;

  it("no typed value: the raw status stays visible, the outcome is not 'Confirmed', the reason says why", () => {
    const d = withMechanism(STRONG, null);
    for (const [component, limit] of [["RECIPIENT", RECIPIENT_LIMIT], ["DESTINATION", DESTINATION_LIMIT]] as const) {
      const item = scopeOf(d, component);
      expect(item.status, component).toBe("SUPPORTED");
      expect(item.outcomeLabel, component).toBe("Not confirmed");
      expect(item.reason, component).toBe(`${limit} Stored component status: SUPPORTED.`);
    }
    const typedCounts = buildAuditContent(STRONG.components, STRONG.evidence, null, STRONG.mechanism?.flows ?? null).counts;
    const untypedCounts = buildAuditContent(d.components, d.evidence, null, null).counts;
    expect(untypedCounts.established).toBe(typedCounts.established - 2);
    expect(untypedCounts.unresolved).toBe(typedCounts.unresolved + 2);
  });

  it("a typed value: the audit outcome is the stored status, as before", () => {
    expect(scopeOf(STRONG, "RECIPIENT").outcomeLabel).toBe("Confirmed");
    expect(scopeOf(STRONG, "DESTINATION").outcomeLabel).toBe("Confirmed");
    expect(scopeOf(STRONG, "SOURCE_OF_VALUE").outcomeLabel).toBe(scopeOf(withMechanism(STRONG, null), "SOURCE_OF_VALUE").outcomeLabel);
  });

  it("no client surface shows a typed recipient / destination kind, so UNKNOWN can never be dressed up", () => {
    for (const file of ["src/client/result-surface.ts", "src/client/audit-model.ts", "src/client/components/research-result.tsx", "src/client/components/research-audit.tsx"]) {
      expect(readFileSync(file, "utf-8"), file).not.toMatch(/recipientKind|destinationKind/);
    }
  });
});
