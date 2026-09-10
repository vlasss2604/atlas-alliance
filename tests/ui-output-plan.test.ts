import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResearchJobDetail } from "../src/client/api";
import { SelectedBlocks } from "../src/client/components/result-blocks/selected-blocks";
import {
  ANALYTICAL_BLOCK_TYPES,
  chooseAnalyticalBlocks,
  inputFromResearchJobDetail,
  MIN_CHART_POINTS,
  proofStateOf,
  type AnalyticalBlockType,
  type AnalyticalOutputInputV1,
  type PlannedBlock,
} from "../src/client/output-plan";
import { OUTPUT_PLAN_FIXTURES, outputPlanFixture } from "../src/client/output-plan-fixtures";

// ANALYTICAL OUTPUT INTELLIGENCE V1 — DETERMINISTIC BLOCK SELECTION.
//
// A block exists only when the structured record justifies it. These tests
// hold both halves of that: the selector chooses the right blocks for
// records that earn them, and DECLINES blocks for records that do not —
// with a closed reason, so "none" is visibly a decision. And they pin the
// invariants that make the selector safe to put between a Proof and a
// screen: it computes no quantity, turns no unknown into a zero, states no
// cause a measurement did not establish, draws no solid path through an
// unresolved link, and promotes no address into a role.

const SELECTOR = "src/client/output-plan.ts";
const PAGE = "app/(app)/dev/output-plan/page.tsx";

const fx = (key: string) => outputPlanFixture(key);
const plan = (key: string) => chooseAnalyticalBlocks(fx(key).input);
const types = (key: string): AnalyticalBlockType[] => plan(key).orderedBlocks.map((b) => b.type);
const block = <T extends AnalyticalBlockType>(key: string, type: T) =>
  plan(key).orderedBlocks.find((b): b is Extract<PlannedBlock, { type: T }> => b.type === type) ?? null;
const rejection = (key: string, type: AnalyticalBlockType) =>
  plan(key).rejected.find((r) => r.type === type)?.reason ?? null;

/* ------------------------------------------------------------------ */
/* 1. THE CONTRACT                                                     */
/* ------------------------------------------------------------------ */

describe("the plan contract", () => {
  it("every block type is either selected or rejected with a reason, never silently absent", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const p = chooseAnalyticalBlocks(f.input);
      const seen = new Set<AnalyticalBlockType>([
        ...p.orderedBlocks.map((b) => b.type),
        ...p.rejected.map((r) => r.type),
      ]);
      for (const t of ANALYTICAL_BLOCK_TYPES) expect(seen.has(t), `${f.key}: ${t}`).toBe(true);
      // And never both.
      for (const r of p.rejected) {
        expect(p.orderedBlocks.some((b) => b.type === r.type), `${f.key}: ${r.type}`).toBe(false);
      }
    }
  });

  it("the spine is fixed: answer first, proof map second, deep proof last", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const t = types(f.key);
      expect(t[0]).toBe("ANSWER");
      expect(t[1]).toBe("PROOF_MAP");
      expect(t[t.length - 1]).toBe("DEEP_PROOF");
    }
  });

  it("is deterministic and independent of input order", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const a = chooseAnalyticalBlocks(f.input);
      const b = chooseAnalyticalBlocks(f.input);
      expect(b).toEqual(a);
      const reversed: AnalyticalOutputInputV1 = {
        ...f.input,
        components: [...f.input.components].reverse(),
        evidence: [...f.input.evidence].reverse(),
        flows: [...f.input.flows].reverse(),
        quantities: [...f.input.quantities].reverse(),
        entities: [...f.input.entities].reverse(),
      };
      expect(chooseAnalyticalBlocks(reversed)).toEqual(a);
    }
  });

  it("every selected block points back at the record it rests on", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const known = new Set(f.input.evidence.map((e) => e.id));
      const comps = new Set(f.input.components.map((c) => c.component));
      for (const b of chooseAnalyticalBlocks(f.input).orderedBlocks) {
        for (const id of b.refs.evidenceIds) expect(known.has(id), `${f.key} ${b.type} ${id}`).toBe(true);
        for (const c of b.refs.components) expect(comps.has(c.component), `${f.key} ${b.type} ${c.component}`).toBe(true);
      }
    }
  });

  it("status becomes state with the ladder's asymmetry: only CONTRADICTED is a positive opposite", () => {
    expect(proofStateOf("SUPPORTED")).toBe("ESTABLISHED");
    expect(proofStateOf("PARTIALLY_SUPPORTED")).toBe("PARTLY_ESTABLISHED");
    expect(proofStateOf("CONTRADICTED")).toBe("CONTRADICTED");
    expect(proofStateOf("INSUFFICIENT_EVIDENCE")).toBe("NOT_ESTABLISHED");
    expect(proofStateOf(null)).toBe("NOT_ESTABLISHED");
    expect(proofStateOf("anything else")).toBe("NOT_ESTABLISHED");
  });
});

/* ------------------------------------------------------------------ */
/* 2. FIVE RECORDS, FIVE DIFFERENT COMPOSITIONS                        */
/* ------------------------------------------------------------------ */

describe("materially different records produce different plans", () => {
  it("A — value capture: metrics, flow, table, chart, entities, evidence, proof", () => {
    const t = types("A");
    for (const want of ["METRIC", "FLOW", "TABLE", "CHART", "ENTITY", "TIMELINE", "EVIDENCE_SNAPSHOT", "PROOF_MAP", "DEEP_PROOF"]) {
      expect(t, want).toContain(want);
    }
    // Chain order on the strip: SOURCE before ALLOCATION before EXECUTION before EFFECT.
    const steps = block("A", "METRIC")!.spec.metrics.map((m) => m.step);
    expect(steps).toEqual([...steps].sort((a, b) => ["SOURCE", "ALLOCATION", "EXECUTION", "EFFECT", null].indexOf(a) - ["SOURCE", "ALLOCATION", "EXECUTION", "EFFECT", null].indexOf(b)));
    // Two aggregates that observed five of six periods are partly established AS TOTALS.
    for (const m of block("A", "METRIC")!.spec.metrics) {
      expect(m.coverage).toEqual({ observed: 5, expected: 6 });
      expect(m.state).toBe("PARTLY_ESTABLISHED");
    }
  });

  it("B — supply effect: the measurement stands, the net reduction is contradicted, attribution is not established", () => {
    const m = block("B", "METRIC")!;
    const delta = m.spec.metrics.find((x) => x.factKind === "TOTAL_SUPPLY_DELTA")!;
    // The MEASUREMENT is established — a direct chain read — even though the
    // NET_EFFECT component it bears on is CONTRADICTED.
    expect(delta.state).toBe("ESTABLISHED");
    expect(fx("B").input.components.find((c) => c.component === "NET_EFFECT")!.status).toBe("CONTRADICTED");
    expect(block("B", "PROOF_MAP")!.spec.cells.find((c) => c.component === "NET_EFFECT")!.state).toBe("CONTRADICTED");
    // The claim beside it is the engine's NET_EFFECT result, copied — and
    // no attribution claim exists, because upstream carries none.
    expect(m.spec.claims).toEqual([
      { component: "NET_EFFECT", state: "CONTRADICTED", evidenceIds: ["b-delta"] },
    ]);
    // Two supply readings are a two-row table and NOT a chart.
    expect(block("B", "TABLE")!.spec.rows).toHaveLength(2);
    expect(rejection("B", "CHART")).toBe("INSUFFICIENT_ORDERED_POINTS");
    // The flow reaches the effect and says it is contradicted there.
    const effect = block("B", "FLOW")!.spec.stages.find((s) => s.step === "EFFECT")!;
    expect(effect.state).toBe("CONTRADICTED");
    // Supply questions lead with the numbers.
    expect(types("B").indexOf("METRIC")).toBeLessThan(types("B").indexOf("FLOW"));
  });

  it("C — governance state: a timeline, and no quantitative block at all", () => {
    const t = types("C");
    expect(t).toContain("TIMELINE");
    expect(t).not.toContain("METRIC");
    expect(t).not.toContain("TABLE");
    expect(t).not.toContain("CHART");
    expect(t).not.toContain("FLOW");
    expect(rejection("C", "METRIC")).toBe("NO_QUALIFIED_MEASUREMENT");
    expect(rejection("C", "FLOW")).toBe("NO_FLOW");
    // A state question leads with the timeline.
    expect(t.indexOf("TIMELINE")).toBe(2);
    const events = block("C", "TIMELINE")!.spec.events;
    // CURRENT_STATE is in the record and partly established. It dates NO
    // milestone: "live now" is not "was switched on", and the selector does
    // not infer the one from the other.
    expect(events.map((e) => e.kind)).toEqual(["DOCUMENTED", "APPROVED", "EXECUTED"]);
    expect(events.find((e) => e.kind === "EXECUTED")!.date).toBeNull();
    expect(events.find((e) => e.kind === "EXECUTED")!.state).toBe("NOT_ESTABLISHED");
  });

  it("D — sparse: answer, proof map, evidence, deep proof, and nothing analytical", () => {
    expect(types("D")).toEqual(["ANSWER", "PROOF_MAP", "EVIDENCE_SNAPSHOT", "DEEP_PROOF"]);
    expect(rejection("D", "FLOW")).toBe("NO_ESTABLISHED_EDGE");
    expect(rejection("D", "ENTITY")).toBe("NO_ESTABLISHED_ROLE");
    expect(rejection("D", "TIMELINE")).toBe("NO_ORDERED_STATE_CHANGE");
    expect(rejection("D", "METRIC")).toBe("NO_QUALIFIED_MEASUREMENT");
    expect(rejection("D", "TABLE")).toBe("NO_COMPARABLE_ROWS");
    expect(rejection("D", "CHART")).toBe("INSUFFICIENT_ORDERED_POINTS");
    // The one admitted row surfaces; the CONTEXT row does not.
    expect(block("D", "EVIDENCE_SNAPSHOT")!.spec.evidenceIds).toEqual(["d-media"]);
  });

  it("E — wallet flow: roles only where established, a flow that breaks at execution", () => {
    const entities = block("E", "ENTITY")!.spec.entities;
    const byAddr = Object.fromEntries(entities.map((e) => [e.address, e]));
    expect(byAddr["7xK9fVn2QsWmT4aBcDeFgHjKpLmNoPqRsTuVwXyPq21"].role).toBe("Protocol treasury");
    expect(byAddr["7xK9fVn2QsWmT4aBcDeFgHjKpLmNoPqRsTuVwXyPq21"].state).toBe("ESTABLISHED");
    // Appears in a transaction: listed, no role.
    expect(byAddr["Cp9ZxCvBnMaSdFgHjKlQwErTyUiOp0987654321ZxCv"].role).toBeNull();
    expect(byAddr["Cp9ZxCvBnMaSdFgHjKlQwErTyUiOp0987654321ZxCv"].state).toBe("NOT_ESTABLISHED");
    // Claimed by a row the component never admitted: the claim stays a claim.
    const claimed = byAddr["Cp9ZxCvBnMaSdFgHjKlQwErTyUiOp0987654321ZxCw"];
    expect(claimed.claimedRole).toBe("Buyback executor");
    expect(claimed.role).toBeNull();
    expect(claimed.state).toBe("NOT_ESTABLISHED");
    expect(claimed.evidenceIds).toEqual([]);

    const stages = block("E", "FLOW")!.spec.stages;
    const by = Object.fromEntries(stages.map((s) => [s.step, s.state]));
    expect(by.SOURCE).toBe("ESTABLISHED");
    expect(by.ALLOCATION).toBe("ESTABLISHED");
    // The edge's basis is PARTLY established and the assembler said the
    // movement was NOT executed. The stage reads the flag, not the basis.
    expect(by.EXECUTION).toBe("NOT_ESTABLISHED");
    expect(by.DESTINATION).toBe("ESTABLISHED");
    expect(by.EFFECT).toBe("NOT_ESTABLISHED");
    // One point transfer is a metric and nothing more.
    expect(block("E", "METRIC")!.spec.metrics).toHaveLength(1);
    expect(rejection("E", "TABLE")).toBe("NO_COMPARABLE_ROWS");
    expect(rejection("E", "CHART")).toBe("INSUFFICIENT_ORDERED_POINTS");
  });

  it("the five compositions are not the same composition", () => {
    const sets = OUTPUT_PLAN_FIXTURES.map((f) => types(f.key).join(">"));
    expect(new Set(sets).size).toBeGreaterThanOrEqual(4);
    expect(types("A")).not.toEqual(types("D"));
    expect(types("B")).not.toEqual(types("C"));
  });
});

/* ------------------------------------------------------------------ */
/* 3. NEGATIVE SELECTION                                               */
/* ------------------------------------------------------------------ */

const base = fx("A").input;
const q = (over: Partial<AnalyticalOutputInputV1["quantities"][number]>) => ({
  evidenceId: "a-acquired-total",
  factKind: "DECODED_EXCHANGE",
  step: 4,
  component: "EXECUTION_EVIDENCE",
  mint: "FixTokenMint1111111111111111111111111111111",
  decimals: 6,
  amountRaw: "1000000",
  position: null,
  ...over,
});

describe("choosing NOT to render is a decision", () => {
  it("one isolated number is a metric and never a chart or a table", () => {
    const p = chooseAnalyticalBlocks({ ...base, quantities: [q({})] });
    expect(p.orderedBlocks.some((b) => b.type === "METRIC")).toBe(true);
    expect(p.rejected).toContainEqual({ type: "CHART", reason: "INSUFFICIENT_ORDERED_POINTS" });
    expect(p.rejected).toContainEqual({ type: "TABLE", reason: "NO_COMPARABLE_ROWS" });
  });

  it("two numbers of different mints are two facts, not a table", () => {
    const p = chooseAnalyticalBlocks({
      ...base,
      quantities: [
        q({ position: { key: "P1", ordinal: 1 } }),
        q({ evidenceId: "a-burned-total", component: "NET_EFFECT", mint: "OtherMint2222222222222222222222222222222222", position: { key: "P2", ordinal: 2 } }),
      ],
    });
    expect(p.rejected).toContainEqual({ type: "TABLE", reason: "NO_COMPARABLE_ROWS" });
  });

  it("an interval is a table; a trend needs at least MIN_CHART_POINTS positions", () => {
    const two = chooseAnalyticalBlocks({
      ...base,
      quantities: [q({ position: { key: "P1", ordinal: 1 } }), q({ position: { key: "P2", ordinal: 2 } })],
    });
    expect(two.orderedBlocks.some((b) => b.type === "TABLE")).toBe(true);
    expect(two.rejected).toContainEqual({ type: "CHART", reason: "INSUFFICIENT_ORDERED_POINTS" });
    expect(MIN_CHART_POINTS).toBeGreaterThanOrEqual(3);
  });

  it("an unknown measurement is not a metric, and is never a zero anywhere in the plan", () => {
    const p = chooseAnalyticalBlocks({ ...base, quantities: [q({ amountRaw: null })] });
    expect(p.rejected).toContainEqual({ type: "METRIC", reason: "NO_QUALIFIED_MEASUREMENT" });
    expect(JSON.stringify(p)).not.toContain('"amountRaw":"0"');
  });

  it("a series with unknown positions keeps them as null points, never as zeros", () => {
    const chart = block("A", "CHART")!;
    for (const s of chart.spec.series) {
      const p6 = s.points.find((p) => p.position.key === "P6")!;
      expect(p6.amountRaw).toBeNull();
      expect(p6.evidenceId).toBeNull();
      expect(p6.state).toBe("NOT_ESTABLISHED");
    }
    // And a measured zero stays a value.
    const burned = chart.spec.series.find((s) => s.factKind === "BURN")!;
    expect(burned.points.find((p) => p.position.key === "P5")!.amountRaw).toBe("0");
    const table = block("A", "TABLE")!;
    expect(table.spec.rows.find((r) => r.position.key === "P6")!.state).toBe("NOT_ESTABLISHED");
    expect(table.spec.rows.find((r) => r.position.key === "P6")!.cells.BURN).toBeNull();
  });

  it("pure prose evidence yields no quantitative block, however many rows there are", () => {
    const p = chooseAnalyticalBlocks({ ...base, quantities: [] });
    for (const t of ["METRIC", "TABLE", "CHART"] as const) {
      expect(p.orderedBlocks.some((b) => b.type === t), t).toBe(false);
    }
  });

  it("a number is not a metric without an admitted evidence row to stand on", () => {
    const p = chooseAnalyticalBlocks({ ...base, quantities: [q({ evidenceId: "no-such-row" })] });
    expect(p.rejected).toContainEqual({ type: "METRIC", reason: "NO_QUALIFIED_MEASUREMENT" });
    const ctx = chooseAnalyticalBlocks({
      ...base,
      evidence: base.evidence.map((e) => (e.id === "a-acquired-total" ? { ...e, relationship: "CONTEXT" } : e)),
      quantities: [q({})],
    });
    expect(ctx.rejected).toContainEqual({ type: "METRIC", reason: "NO_QUALIFIED_MEASUREMENT" });
  });

  it("an unresolved causal chain gets no flow", () => {
    const f = fx("A").input.flows[0];
    const unresolved = chooseAnalyticalBlocks({
      ...base,
      flows: [
        {
          ...f,
          edges: f.edges.map((e) => ({ ...e, basisStatus: "INSUFFICIENT_EVIDENCE", executed: false })),
        },
      ],
    });
    expect(unresolved.rejected).toContainEqual({ type: "FLOW", reason: "NO_ESTABLISHED_EDGE" });
    expect(chooseAnalyticalBlocks({ ...base, flows: [] }).rejected).toContainEqual({ type: "FLOW", reason: "NO_FLOW" });
  });

  it("no meaningful chronological state change gets no timeline", () => {
    const p = chooseAnalyticalBlocks({
      ...base,
      evidence: base.evidence.map((e) => (e.id === "a-docs" ? e : { ...e, publishedAt: null, observedAt: null })),
    });
    expect(p.rejected).toContainEqual({ type: "TIMELINE", reason: "NO_ORDERED_STATE_CHANGE" });
  });

  it("an address with an unknown role gets no entity block", () => {
    const p = chooseAnalyticalBlocks({
      ...base,
      entities: [{ address: "Some111", chain: "Fixture chain", claimedRole: "Treasury", roleComponent: null, evidenceIds: ["a-treasury"] }],
    });
    expect(p.rejected).toContainEqual({ type: "ENTITY", reason: "NO_ESTABLISHED_ROLE" });
  });

  it("a run that assessed nothing has no proof map and no deep proof", () => {
    const p = chooseAnalyticalBlocks({ ...base, components: [], flows: [], quantities: [], entities: [] });
    expect(p.rejected).toContainEqual({ type: "PROOF_MAP", reason: "NO_COMPONENT_RESULTS" });
    expect(p.rejected).toContainEqual({ type: "DEEP_PROOF", reason: "NO_COMPONENT_RESULTS" });
    expect(p.orderedBlocks.map((b) => b.type)).toEqual(["ANSWER"]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. INVARIANTS                                                       */
/* ------------------------------------------------------------------ */

describe("the selector cannot make a claim the record did not", () => {
  it("performs no arithmetic: every amount in a plan is an amount in the input", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const given = new Set(f.input.quantities.map((x) => x.amountRaw).filter((x): x is string => x !== null));
      const amounts = [...JSON.stringify(chooseAnalyticalBlocks(f.input)).matchAll(/"amountRaw":"(-?\d+)"/g)].map((m) => m[1]);
      for (const a of amounts) expect(given.has(a), `${f.key}: ${a}`).toBe(true);
    }
    const src = readFileSync(SELECTOR, "utf-8");
    expect(src).not.toMatch(/BigInt\(/);
    expect(src).not.toMatch(/parseFloat|parseInt|Number\(q\.amountRaw|reduce\(/);
  });

  it("states no cause: upstream carries no attribution proposition, so the plan carries none", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const json = JSON.stringify(chooseAnalyticalBlocks(f.input));
      expect(json, f.key).not.toMatch(/ATTRIBUTION|CAUSAL|CAUSE/i);
    }
    // And the selector does not hold a verdict of its own to hand out.
    const src = readFileSync(SELECTOR, "utf-8");
    expect(src).not.toMatch(/ATTRIBUTION/);
    expect(src).not.toMatch(/state:\s*"(NOT_ESTABLISHED|CONTRADICTED|ESTABLISHED|PARTLY_ESTABLISHED)"\s*,?\s*evidenceIds/);
  });

  it("does not become a second NET_EFFECT reducer: the measured direction grades nothing", () => {
    const b = fx("B").input;
    // Upstream NET_EFFECT absent: the delta is still a metric, and there is
    // no claim beside it — nothing is manufactured from INCREASED.
    const without = chooseAnalyticalBlocks({
      ...b,
      components: b.components.filter((c) => c.component !== "NET_EFFECT"),
      quantities: b.quantities.filter((x) => x.component !== "NET_EFFECT" || x.factKind === "TOTAL_SUPPLY_DELTA").map((x) => (x.factKind === "TOTAL_SUPPLY_DELTA" ? { ...x, component: "EXECUTION_EVIDENCE", step: 4 } : x)),
    });
    const m = without.orderedBlocks.find((x) => x.type === "METRIC") as Extract<PlannedBlock, { type: "METRIC" }>;
    expect(m.spec.metrics.some((x) => x.factKind === "TOTAL_SUPPLY_DELTA")).toBe(true);
    expect(m.spec.claims).toEqual([]);
    // Upstream NET_EFFECT present: its state is copied EXACTLY, whatever the
    // measured direction says. A DECREASED delta beside a CONTRADICTED
    // component still shows CONTRADICTED; SUPPORTED shows ESTABLISHED.
    for (const [status, state] of [
      ["SUPPORTED", "ESTABLISHED"],
      ["PARTIALLY_SUPPORTED", "PARTLY_ESTABLISHED"],
      ["CONTRADICTED", "CONTRADICTED"],
      ["INSUFFICIENT_EVIDENCE", "NOT_ESTABLISHED"],
    ] as const) {
      for (const direction of ["DECREASED", "INCREASED", "UNCHANGED"] as const) {
        const p = chooseAnalyticalBlocks({
          ...b,
          components: b.components.map((c) => (c.component === "NET_EFFECT" ? { ...c, status } : c)),
          quantities: b.quantities.map((x) => (x.factKind === "TOTAL_SUPPLY_DELTA" ? { ...x, direction } : x)),
        });
        const metric = p.orderedBlocks.find((x) => x.type === "METRIC") as Extract<PlannedBlock, { type: "METRIC" }>;
        expect(metric.spec.claims, `${status} ${direction}`).toEqual([{ component: "NET_EFFECT", state, evidenceIds: ["b-delta"] }]);
        // The measurement's own state is unaffected by the verdict it bears on.
        expect(metric.spec.metrics.find((x) => x.factKind === "TOTAL_SUPPLY_DELTA")!.state).toBe("ESTABLISHED");
      }
    }
  });

  it("CURRENT_STATE alone cannot create an ACTIVATED milestone", () => {
    const c = fx("C").input;
    const p = chooseAnalyticalBlocks({
      ...c,
      components: c.components.map((x) => (x.component === "CURRENT_STATE" ? { ...x, status: "SUPPORTED" } : x)),
      evidence: c.evidence.map((e) => (e.id === "c-state" ? { ...e, mechanismState: "LIVE", directness: "DIRECT" } : e)),
    });
    expect(JSON.stringify(p)).not.toContain("ACTIVATED");
    const events = (p.orderedBlocks.find((b) => b.type === "TIMELINE") as Extract<PlannedBlock, { type: "TIMELINE" }>).spec.events;
    expect(events.map((e) => e.kind)).toEqual(["DOCUMENTED", "APPROVED", "EXECUTED"]);
    // Only components with milestone propositions date one.
    for (const f of OUTPUT_PLAN_FIXTURES) {
      expect(JSON.stringify(chooseAnalyticalBlocks(f.input)), f.key).not.toContain("ACTIVATED");
    }
  });

  it("a flow's execution stage reads the executed flag, never the basis or an observed transfer", () => {
    const f = fx("A").input.flows[0];
    const p = chooseAnalyticalBlocks({
      ...base,
      flows: [{ ...f, edges: f.edges.map((e) => (e.to === "DESTINATION" ? { ...e, basisStatus: "SUPPORTED", executed: false } : e)) }],
    });
    const flow = p.orderedBlocks.find((b) => b.type === "FLOW") as Extract<PlannedBlock, { type: "FLOW" }>;
    expect(flow.spec.stages.find((s) => s.step === "EXECUTION")!.state).toBe("NOT_ESTABLISHED");
  });

  it("a later milestone never backfills an earlier one", () => {
    const p = chooseAnalyticalBlocks({
      ...base,
      components: base.components.map((c) => (c.component === "GOVERNANCE_BASIS" ? { ...c, status: "INSUFFICIENT_EVIDENCE", supportingEvidenceIds: [] } : c)),
    });
    const events = (p.orderedBlocks.find((b) => b.type === "TIMELINE") as Extract<PlannedBlock, { type: "TIMELINE" }>).spec.events;
    expect(events.find((e) => e.kind === "EXECUTED")!.state).toBe("PARTLY_ESTABLISHED");
    const approved = events.find((e) => e.kind === "APPROVED")!;
    expect(approved.state).toBe("NOT_ESTABLISHED");
    expect(approved.date).toBeNull();
  });

  it("dates milestones from the thing's own date, never from retrieval", () => {
    const events = block("A", "TIMELINE")!.spec.events;
    for (const e of events) if (e.date !== null) expect(e.date.startsWith("2026-03-02")).toBe(false);
  });

  it("an entity's role state never exceeds its component and needs that component's own evidence", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const p = chooseAnalyticalBlocks(f.input);
      const byComp = new Map(f.input.components.map((c) => [c.component, c]));
      for (const b of p.orderedBlocks) {
        if (b.type !== "ENTITY") continue;
        for (const e of b.spec.entities) {
          if (e.state === "NOT_ESTABLISHED") {
            expect(e.role).toBeNull();
            continue;
          }
          const comp = byComp.get(e.roleComponent!)!;
          expect(e.state).toBe(proofStateOf(comp.status));
          const admitted = new Set([...comp.supportingEvidenceIds, ...comp.contradictingEvidenceIds]);
          expect(e.evidenceIds.length).toBeGreaterThan(0);
          for (const id of e.evidenceIds) expect(admitted.has(id)).toBe(true);
        }
      }
    }
  });

  it("relevance orders blocks and never admits one", () => {
    const withRelevance = chooseAnalyticalBlocks(fx("D").input);
    const without = chooseAnalyticalBlocks({ ...fx("D").input, question: { ...fx("D").input.question, relevantComponents: ["NET_EFFECT", "EXECUTION_EVIDENCE"], intent: "BURN_OR_SUPPLY_EFFECT" } });
    expect(without.orderedBlocks.map((b) => b.type)).toEqual(withRelevance.orderedBlocks.map((b) => b.type));
    expect(without.rejected).toEqual(withRelevance.rejected);
  });

  it("contains no project-specific rule and imports nothing from the server", () => {
    const src = readFileSync(SELECTOR, "utf-8");
    expect(src).not.toMatch(/projectSlug|projectName|projectTicker|project\s*===|slug\s*===/);
    expect(src).not.toMatch(/raydium|pump|jupiter|uniswap/i);
    expect(src).not.toMatch(/from\s+["'][^"']*server\//);
    // And no model, no fetch, no persistence.
    expect(src).not.toMatch(/fetch\(|anthropic|openai|drizzle|localStorage/i);
  });
});

/* ------------------------------------------------------------------ */
/* 5. THE ADAPTER FROM THE DETAIL PAYLOAD                              */
/* ------------------------------------------------------------------ */

describe("the detail-payload adapter", () => {
  const detail = {
    job: { originalQuestion: "Where do fees go?" },
    proof: { verdict: "PARTIALLY_SUPPORTED", confidence: { band: "LIMITED", score: 40 } },
    claimSupport: { intent: "VALUE_CAPTURE" },
    mechanism: {
      flows: [
        fx("A").input.flows[0],
        // Malformed rows are dropped, not repaired.
        { flowId: "broken", nodes: "no" },
        null,
      ],
    },
    questionFindings: [{ label: "Where value comes from", patternStep: 1, component: "SOURCE_OF_VALUE", supportingComponents: ["FLOW_PATH"] }],
    components: fx("A").input.components.map((c) => ({
      patternStep: c.step,
      component: c.component,
      status: c.status,
      reasonCodes: [...c.reasonCodes, { notAString: true }],
      supportingEvidenceIds: [...c.supportingEvidenceIds],
      contradictingEvidenceIds: [...c.contradictingEvidenceIds],
      excludedEvidence: [],
      coverage: "COMPLETED",
    })),
    evidence: fx("A").input.evidence.map((e) => ({ ...e, hasSnapshot: false, links: [], sourceType: "WEB", dataAsOf: null, valueSource: null, sourcePublisher: null })),
  } as unknown as ResearchJobDetail;

  it("maps what the payload carries and leaves quantities and entities empty rather than guessed", () => {
    const input = inputFromResearchJobDetail(detail);
    expect(input.question).toEqual({ text: "Where do fees go?", intent: "VALUE_CAPTURE", relevantComponents: ["FLOW_PATH", "SOURCE_OF_VALUE"] });
    expect(input.verdict).toBe("PARTIALLY_SUPPORTED");
    expect(input.confidenceBand).toBe("LIMITED");
    expect(input.flows).toHaveLength(1);
    expect(input.components.every((c) => c.reasonCodes.every((r) => typeof r === "string"))).toBe(true);
    expect(input.quantities).toEqual([]);
    expect(input.entities).toEqual([]);
    // So on a real payload today the quantitative and entity blocks are
    // correctly declined, and everything else is chosen from the record.
    const p = chooseAnalyticalBlocks(input);
    expect(p.orderedBlocks.map((b) => b.type)).toEqual(["ANSWER", "PROOF_MAP", "FLOW", "TIMELINE", "EVIDENCE_SNAPSHOT", "DEEP_PROOF"]);
  });

  it("a payload with no Proof yields a null verdict, never an invented one", () => {
    const input = inputFromResearchJobDetail({ ...detail, proof: null, claimSupport: null, questionFindings: null, mechanism: null });
    expect(input.verdict).toBeNull();
    expect(input.question.intent).toBeNull();
    expect(input.flows).toEqual([]);
    const answer = chooseAnalyticalBlocks(input).orderedBlocks[0];
    expect(answer.type === "ANSWER" && answer.spec.verdict).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. THE SELECTED BLOCKS RENDER, AND ONLY THEY RENDER                 */
/* ------------------------------------------------------------------ */

const TESTID: Record<AnalyticalBlockType, string> = {
  ANSWER: "block-answer",
  PROOF_MAP: "block-proof-map",
  METRIC: "block-metrics",
  TABLE: "block-table",
  CHART: "block-chart",
  FLOW: "block-flow",
  TIMELINE: "block-timeline",
  ENTITY: "block-entities",
  EVIDENCE_SNAPSHOT: "block-evidence",
  DEEP_PROOF: "block-deep-proof",
};

describe("the dev route renders exactly the selected blocks", () => {
  it("each fixture renders its selected blocks and none of its rejected ones", () => {
    for (const f of OUTPUT_PLAN_FIXTURES) {
      const p = chooseAnalyticalBlocks(f.input);
      const html = renderToStaticMarkup(
        createElement(SelectedBlocks, { plan: p, input: f.input, answer: f.answer, asOf: "Fixture" }),
      );
      for (const b of p.orderedBlocks) expect(html, `${f.key} ${b.type}`).toContain(`data-testid="${TESTID[b.type]}"`);
      for (const r of p.rejected) expect(html, `${f.key} ${r.type}`).not.toContain(`data-testid="${TESTID[r.type]}"`);
    }
  });

  it("an unknown value renders as a dash, never as 0", () => {
    const f = fx("A");
    const html = renderToStaticMarkup(
      createElement(SelectedBlocks, { plan: chooseAnalyticalBlocks(f.input), input: f.input, answer: f.answer, asOf: "Fixture" }),
    );
    expect(html).toContain("P6");
    // The table's P6 row: two dashes, no numerals.
    const p6 = html.slice(html.indexOf(">P6<"), html.indexOf(">P6<") + 600);
    expect(p6).toContain("—");
    expect(p6).not.toMatch(/>0<|>0\.0</);
  });

  it("the page is gated out of production and touches nothing", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain('process.env.NODE_ENV === "production"');
    expect(page).toContain("notFound()");
    expect(page).toContain("fixture-banner");
    expect(page).not.toMatch(/db\.|drizzle|fetch\(|api\./);
  });
});
