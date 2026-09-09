"use client";

import {
  FIXTURE_CHART,
  FIXTURE_DEEP_PROOF,
  FIXTURE_ENTITIES,
  FIXTURE_EVIDENCE,
  FIXTURE_FLOW,
  FIXTURE_HEADER,
  FIXTURE_METRICS,
  FIXTURE_NOTICE,
  FIXTURE_PROOF_MAP,
  FIXTURE_TABLE_COLUMNS,
  FIXTURE_TABLE_NOTE,
  FIXTURE_TABLE_ROWS,
  FIXTURE_TIMELINE,
} from "../../result-showcase-fixture";
import { AnalyticalTableBlock } from "./analytical-table";
import { AnswerHeaderBlock } from "./answer-header";
import { DeepProofEntryBlock } from "./deep-proof-entry";
import { EntityListBlock } from "./entity-list";
import { EvidenceSnapshotBlock } from "./evidence-snapshot";
import { MetricGridBlock } from "./metric-grid";
import { ProofMapBlock } from "./proof-map";
import { QuantChartBlock } from "./quant-chart";
import { ResearchTimelineBlock } from "./research-timeline";
import { ValueFlowBlock } from "./value-flow";

// THE COMPLETE RESULT, COMPOSED FROM BLOCKS.
//
// The order is the reading order of an analytical result: understand it,
// see its shape, read its numbers, follow its logic, inspect its data,
// check its evidence, then verify it.
//
// EVERY BLOCK IS A DIFFERENT SHAPE ON PURPOSE. The failure this composition
// exists to avoid is ten identical full-width cards each holding more prose
// — which is a text report with borders drawn on it. A grid, a metric strip,
// a diagram, a dense table, a chart, a dated rail and an evidence card do
// not look alike, and a reader should be able to tell what kind of thing
// they are looking at before reading a word of it.
//
// NOTHING HERE SELECTS BLOCKS. A real result will render only the blocks its
// findings actually justify, and the rule that decides that is deliberately
// not written yet — the presentation language is agreed first. This page
// shows every block at once, which no real result ever would.
export function ResultShowcase() {
  return (
    <main className="enter flex flex-col gap-4 pb-6" data-testid="result-showcase">
      <FixtureBanner />

      {/* 1 — the only substantial prose on the page */}
      <AnswerHeaderBlock data={FIXTURE_HEADER} />

      {/* 2 — the shape of the research, before any of its detail */}
      <ProofMapBlock cells={FIXTURE_PROOF_MAP} />

      {/* 3 — the numbers, as numbers */}
      <MetricGridBlock metrics={FIXTURE_METRICS} />

      {/* 4 — the logic, as a diagram that shows where it stops */}
      <ValueFlowBlock stages={FIXTURE_FLOW} />

      {/* 5 — the underlying data, dense enough to inspect */}
      <AnalyticalTableBlock
        title="By period"
        columns={FIXTURE_TABLE_COLUMNS}
        rows={FIXTURE_TABLE_ROWS}
        note={FIXTURE_TABLE_NOTE}
      />

      {/* 6 — one measure over time */}
      <QuantChartBlock
        title="Tokens acquired by period"
        unit="millions of tokens"
        period="6 periods"
        source="Fixture values. A period with no established measurement is drawn as an empty slot, never as zero."
        points={FIXTURE_CHART}
      />

      {/* 7 — the four claims that must not be conflated */}
      <ResearchTimelineBlock events={FIXTURE_TIMELINE} />

      {/* 8 — addresses as objects, not words */}
      <EntityListBlock entities={FIXTURE_ENTITIES} />

      {/* 9 — the source's own words, and what they do not settle */}
      <EvidenceSnapshotBlock items={FIXTURE_EVIDENCE} />

      {/* 10 — the handover to verification */}
      <DeepProofEntryBlock rows={FIXTURE_DEEP_PROOF} />
    </main>
  );
}

// THE LABEL IS NOT A FOOTNOTE. This page shows a complete, confident-looking
// research result built entirely from invented values; anything less than an
// unmissable banner risks a screenshot of it circulating as a finding.
function FixtureBanner() {
  return (
    <section
      className="rounded-xl border px-4 py-3"
      style={{
        borderColor: "rgba(251, 191, 36, 0.32)",
        background: "rgba(251, 191, 36, 0.07)",
      }}
      data-testid="fixture-banner"
    >
      <p
        className="text-[0.7rem] font-semibold uppercase tracking-[0.08em]"
        style={{ color: "#fcd34d" }}
      >
        {FIXTURE_NOTICE.title} · not a real research result
      </p>
      <p className="mt-1 text-[0.78rem] leading-snug text-[var(--atlas-text-dim)]">
        {FIXTURE_NOTICE.body}
      </p>
    </section>
  );
}
