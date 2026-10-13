import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// First Real Run, Stage 2 (pipeline-integration-stage2.md, D-115) — §H
// TRACE != EVIDENCE, structural regression. No store that judges
// evidentiary sufficiency (S5's component reconciler, S6's mechanism
// assembler, S7's claim evaluator) may import researchTraceEvents or
// trace-store.ts. This test fails loudly the moment any of them start
// to, independent of runtime behavior — a static, dedicated, obviously-
// named guard against ever wiring the trace table into a judgment path.

const FORBIDDEN_READERS = [
  "src/server/engine/component-reconciler.ts",
  "src/server/engine/component-reconciliation-store.ts",
  "src/server/engine/mechanism-assembler.ts",
  "src/server/engine/mechanism-assembly-store.ts",
  "src/server/engine/claim-evaluator.ts",
  "src/server/engine/claim-support-store.ts",
];

describe("First Real Run Stage 2 — TRACE != EVIDENCE (static)", () => {
  it.each(FORBIDDEN_READERS)("%s never references research_trace_events / trace-store.ts", async (path) => {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf-8");
    expect(source).not.toMatch(/researchTraceEvents/);
    expect(source).not.toMatch(/trace-store/);
  });

  it("trace-store.ts only ever writes to research_trace_events (no evidence/component-results/mechanism-assembly/claim-support table writes)", async () => {
    const source = await readFile(new URL("../src/server/engine/trace-store.ts", import.meta.url), "utf-8");
    // Matches table identifiers used as drizzle table objects (e.g.
    // ".insert(evidence)"), not substrings inside unrelated field names
    // like "evidenceId" (§J item 18 deliberately carries an evidence id
    // reference — that is not a write to the evidence table).
    for (const forbidden of [/\bevidence\b(?!Id)/, /\bresearchComponentResults\b/, /\bresearchMechanismAssembly\b/, /\bresearchClaimSupport\b/]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});
