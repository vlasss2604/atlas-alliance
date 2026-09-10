"use client";

import {
  FIXTURE_CHART,
  FIXTURE_CHART_BURNED,
  FIXTURE_DEEP_PROOF,
  FIXTURE_ENTITIES,
  FIXTURE_EVIDENCE,
  FIXTURE_FLOW,
  FIXTURE_HEADER,
  FIXTURE_METRICS,
  FIXTURE_METRIC_CLAIMS,
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
// PROGRESSIVE DEPTH, IN FOUR STEPS. The composition is built so a reader can
// stop at any of them and have got something whole:
//
//   FAST UNDERSTANDING     the masthead — question, one-sentence answer,
//                          verdict, and how much of the claim stands up
//   ANALYTICAL EXPLANATION the measure chain, the flow, the table, the chart
//   EVIDENCE               entities, timeline, the sources' own words
//   DEEP PROOF             the verification layer
//
// WHAT THIS REVISION FIXED. The previous composition was ten full-width
// panels in a column, so the first screen of a result was four paragraphs of
// prose and the first number was two scrolls away — a text report with
// borders drawn on it. The answer is now one sentence with the coverage of
// the proof beside it, the four headline numbers are named as the economic
// chain they belong to, and the blocks that read as a pair on a wide screen
// are laid out as a pair instead of stacked.
//
// EVERY BLOCK IS STILL A DIFFERENT SHAPE ON PURPOSE. A coverage map, a
// measure strip, a diagram, a dense table, a chart, a dated rail and an
// evidence card do not look alike, and a reader should be able to tell what
// kind of thing they are looking at before reading a word of it.
//
// NOTHING HERE SELECTS BLOCKS. A real result will render only the blocks its
// findings actually justify, and the rule that decides that is deliberately
// not written yet — the presentation language is agreed first. This page
// shows every block at once, which no real result ever would.
export function ResultShowcase() {
  return (
    <main className="enter flex flex-col gap-4 pb-6" data-testid="result-showcase">
      <FixtureBanner />

      {/* 1 + 2 — ONE MASTHEAD, NOT TWO PANELS. "What is the answer" and
          "how much of it stands up" are a single thought, and a reader
          should not have to scroll from one to the other. */}
      <section className="panel panel-raised p-4 sm:p-5 lg:p-6" data-testid="block-masthead">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-7">
          <AnswerHeaderBlock data={FIXTURE_HEADER} />
          <div className="border-t border-[var(--hairline)] pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <ProofMapBlock cells={FIXTURE_PROOF_MAP} />
          </div>
        </div>
      </section>

      {/* 3 — the numbers, as the chain they argue, with the claims they are
          NOT allowed to imply stated separately underneath, each with the
          state its own evidence supports */}
      <MetricGridBlock metrics={FIXTURE_METRICS} claims={FIXTURE_METRIC_CLAIMS} />

      {/* 4 — the same chain as a diagram, which shows where it stops */}
      <ValueFlowBlock stages={FIXTURE_FLOW} />

      {/* 5 — the underlying data: exact values, periods, completeness */}
      <AnalyticalTableBlock
        title="By period"
        columns={FIXTURE_TABLE_COLUMNS}
        rows={FIXTURE_TABLE_ROWS}
        note={FIXTURE_TABLE_NOTE}
      />

      {/* 6 + 7 — two readings of the same six periods, side by side on a
          wide screen: what the quantities did, and what was actually
          settled about them and when. */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="[&>section]:h-full lg:col-span-7">
          <QuantChartBlock
            title="Acquired against burned"
            unit="millions of tokens"
            period="6 periods"
            source="The acquired and burned columns of the table above. P5 burned is a measured zero and is drawn as one; P6 was not established and is drawn as an empty slot. They are different claims."
            series={[
              { key: "acquired", label: "Acquired", color: "#2dd4bf", points: FIXTURE_CHART },
              { key: "burned", label: "Burned", color: "#38bdf8", points: FIXTURE_CHART_BURNED },
            ]}
          />
        </div>
        <div className="[&>section]:h-full lg:col-span-5">
          <ResearchTimelineBlock events={FIXTURE_TIMELINE} />
        </div>
      </div>

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
//
// IT IS ONE LINE TALLER THAN IT NEEDS TO BE AND NO MORE. It used to take a
// fifth of the first screen on a handset, which is a fifth of the screen the
// result itself did not get; it is now a single dense block that still says
// the whole thing.
function FixtureBanner() {
  return (
    <section
      className="rounded-xl border px-3.5 py-2.5"
      style={{
        borderColor: "rgba(251, 191, 36, 0.32)",
        background: "rgba(251, 191, 36, 0.07)",
      }}
      data-testid="fixture-banner"
    >
      <p
        className="text-[0.68rem] font-semibold uppercase tracking-[0.08em]"
        style={{ color: "#fcd34d" }}
      >
        {FIXTURE_NOTICE.title} · not a real research result
      </p>
      <p className="mt-0.5 text-[0.7rem] leading-snug text-[var(--atlas-text-dim)]">
        {FIXTURE_NOTICE.body}
      </p>
    </section>
  );
}
