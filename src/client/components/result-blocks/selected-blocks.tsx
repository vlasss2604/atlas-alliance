"use client";

import { componentLabel } from "../../research-model";
import type {
  AnalyticalOutputInputV1,
  AnalyticalOutputPlanV1,
  PlannedBlock,
  PlannedClaim,
} from "../../output-plan";
import { AnalyticalTableBlock } from "./analytical-table";
import { AnswerHeaderBlock } from "./answer-header";
import { DeepProofEntryBlock } from "./deep-proof-entry";
import { EntityListBlock } from "./entity-list";
import { EvidenceSnapshotBlock } from "./evidence-snapshot";
import { MetricGridBlock } from "./metric-grid";
import { ProofMapBlock } from "./proof-map";
import { QuantChartBlock, type ChartSeries } from "./quant-chart";
import { ResearchTimelineBlock } from "./research-timeline";
import type {
  EvidenceKindMeta,
  FlowStage,
  Metric,
  MetricAttribution,
  ProofMapCell,
  TableRow,
  TimelineEvent,
} from "./types";
import { ValueFlowBlock } from "./value-flow";

// SELECTED BLOCKS — THE THIN END OF THE SELECTOR.
//
// `chooseAnalyticalBlocks` says WHICH blocks a record justifies and what
// each rests on; this turns each selected block into the props of the
// existing presentation component and renders them in the plan's order.
// It is a switch and a few formatters. It decides nothing: a block absent
// from the plan is absent from the page, and every state shown is the one
// the plan carries.
//
// PROSE IS HANDED IN, NEVER MADE. The answer sentences come from the caller
// (the fixture, on the dev route; the existing briefing derivation, on a
// real result). The selector produces no text, and neither does this.

const FACT_KIND_LABEL: Record<string, string> = {
  TOKEN_SUPPLY: "Total supply",
  TOTAL_SUPPLY_DELTA: "Observed total supply change",
  BURN: "Observed burns",
  TOKEN_TRANSFER: "Observed transfers",
  NATIVE_TRANSFER: "Observed native transfers",
  DECODED_EXCHANGE: "Observed acquisition activity",
  TOKEN_ACCOUNT_BALANCE: "Account balance",
};

const FLOW_STAGE_LABEL: Record<FlowStage["step"] & string, string> = {
  SOURCE: "Source of value",
  ALLOCATION: "Documented allocation",
  EXECUTION: "Mechanism execution",
  DESTINATION: "Destination",
  EFFECT: "Net supply reduction",
};

const TIMELINE_KIND_LABEL: Record<TimelineEvent["kind"], string> = {
  DOCUMENTED: "Documented",
  APPROVED: "Approved by governance",
  ACTIVATED: "Activated",
  EXECUTED: "Observed executing",
};

// The two propositions the metric strip is not allowed to imply, in the
// same words the Golden Result settled on. The STATE beside each is the
// plan's; only the wording lives here.
const CLAIM_COPY: Record<PlannedClaim["kind"], { label: string; detail: string }> = {
  NET_SUPPLY_REDUCTION: {
    label: "Net supply reduction over the measured interval",
    detail:
      "Settled directly by the measured direction of total supply across the interval, and by nothing else.",
  },
  MECHANISM_ATTRIBUTION: {
    label: "Attribution of any reduction to the documented mechanism",
    detail:
      "A separate question the measurement does not answer. Nothing in this record establishes that the mechanism caused a change in supply, and nothing disproves it.",
  },
};

// Exact integer → number of whole units, then compact display. The exact
// value stays in the plan; this is only how it is read. Rounding happens
// once, here, on the way to the screen.
function toUnits(amountRaw: string, decimals: number): number {
  const negative = amountRaw.startsWith("-");
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const frac = decimals > 0 ? padded.slice(padded.length - decimals) : "";
  const n = Number(`${whole}.${frac || "0"}`);
  return negative ? -n : n;
}

export function compactAmount(amountRaw: string, decimals: number, signed = false): string {
  const units = toUnits(amountRaw, decimals);
  const abs = Math.abs(units);
  const body =
    abs >= 1e9
      ? `${(abs / 1e9).toFixed(1)}B`
      : abs >= 1e6
        ? `${(abs / 1e6).toFixed(1)}M`
        : abs >= 1e3
          ? `${(abs / 1e3).toFixed(1)}K`
          : abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${units < 0 ? "−" : signed && abs > 0 ? "+" : ""}${body}`;
}

function millions(amountRaw: string, decimals: number): number {
  return toUnits(amountRaw, decimals) / 1e6;
}

function dateOnly(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export function SelectedBlocks({
  plan,
  input,
  answer,
  asOf,
}: {
  plan: AnalyticalOutputPlanV1;
  input: AnalyticalOutputInputV1;
  answer: { short: string; paragraphs: string[] };
  asOf: string;
}) {
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]));
  return (
    <div className="flex flex-col gap-4" data-testid="selected-blocks">
      {plan.orderedBlocks.map((block, i) => (
        <Block key={`${block.type}-${i}`} block={block} answer={answer} asOf={asOf} evidenceById={evidenceById} />
      ))}
    </div>
  );
}

function Block({
  block,
  answer,
  asOf,
  evidenceById,
}: {
  block: PlannedBlock;
  answer: { short: string; paragraphs: string[] };
  asOf: string;
  evidenceById: Map<string, AnalyticalOutputInputV1["evidence"][number]>;
}) {
  switch (block.type) {
    case "ANSWER":
      return (
        <section className="panel panel-raised p-4 sm:p-5 lg:p-6" data-testid="block-masthead">
          <AnswerHeaderBlock
            data={{
              question: block.spec.question,
              verdict: block.spec.verdict ?? "No verdict",
              confidence: block.spec.confidenceBand ?? "—",
              short: answer.short,
              answer: answer.paragraphs,
              asOf,
            }}
          />
        </section>
      );
    case "PROOF_MAP": {
      const cells: ProofMapCell[] = block.spec.cells.map((c) => ({
        label: componentLabel(c.component),
        state: c.state,
      }));
      return (
        <section className="panel p-4 sm:p-5">
          <ProofMapBlock cells={cells} />
        </section>
      );
    }
    case "METRIC": {
      const metrics: Metric[] = block.spec.metrics.map((m) => ({
        step: m.step ?? undefined,
        value: compactAmount(m.amountRaw, m.decimals, m.factKind === "TOTAL_SUPPLY_DELTA"),
        unit: "tokens",
        label: FACT_KIND_LABEL[m.factKind] ?? m.factKind,
        state: m.state,
        period: m.coverage ? `${m.coverage.observed} of ${m.coverage.expected} periods observed` : undefined,
        source: "On-chain reads",
      }));
      const claims: MetricAttribution[] = block.spec.claims.map((c) => ({
        label: CLAIM_COPY[c.kind].label,
        state: c.state,
        detail: CLAIM_COPY[c.kind].detail,
      }));
      return <MetricGridBlock metrics={metrics} claims={claims} />;
    }
    case "FLOW": {
      const stages: FlowStage[] = block.spec.stages.map((s) => ({
        step: s.step,
        label: FLOW_STAGE_LABEL[s.step],
        state: s.state,
        detail: s.component ? componentLabel(s.component) : "Not reached",
      }));
      return <ValueFlowBlock stages={stages} />;
    }
    case "TABLE": {
      const columns = [
        { key: "position", label: "Position" },
        ...block.spec.columns.map((k) => ({ key: k, label: FACT_KIND_LABEL[k] ?? k, numeric: true, unit: "tokens" })),
      ];
      const rows: TableRow[] = block.spec.rows.map((r) => ({
        key: r.position.key,
        state: r.state,
        cells: {
          position: r.position.key,
          ...Object.fromEntries(
            block.spec.columns.map((k) => {
              const cell = r.cells[k];
              // A dash is a value the research did not establish. It is
              // never a zero; a zero here is a measured zero.
              return [k, cell ? compactAmount(cell.amountRaw, block.spec.decimals) : "—"];
            }),
          ),
        },
      }));
      return (
        <AnalyticalTableBlock
          title="Observed values"
          columns={columns}
          rows={rows}
          note="A dash is a figure this research did not establish; 0 is a figure it did establish, and the two are different claims."
        />
      );
    }
    case "CHART": {
      const palette = ["#2dd4bf", "#38bdf8", "#c4b5fd", "#fcd34d"];
      const series: ChartSeries[] = block.spec.series.map((s, i) => ({
        key: s.factKind,
        label: FACT_KIND_LABEL[s.factKind] ?? s.factKind,
        color: palette[i % palette.length],
        points: s.points.map((p) => ({
          label: p.position.key,
          // Null stays null: an empty slot, never a zero.
          value: p.amountRaw === null ? null : millions(p.amountRaw, block.spec.decimals),
          state: p.state,
        })),
      }));
      return (
        <QuantChartBlock
          title="Observed series"
          unit="millions of tokens"
          period={`${block.spec.series[0]?.points.length ?? 0} positions`}
          source="Values are the typed on-chain facts referenced by the plan. A position the research did not establish is drawn as an empty slot."
          series={series}
        />
      );
    }
    case "TIMELINE": {
      const events: TimelineEvent[] = block.spec.events.map((e) => ({
        date: dateOnly(e.date),
        kind: e.kind,
        state: e.state,
        label: `${TIMELINE_KIND_LABEL[e.kind]} · ${componentLabel(e.component)}`,
      }));
      return <ResearchTimelineBlock events={events} />;
    }
    case "ENTITY":
      return (
        <EntityListBlock
          entities={block.spec.entities.map((e) => ({
            // A role is shown only when the plan established it. Otherwise
            // the address is listed as an address, and the claim as a claim.
            role: e.role ?? (e.claimedRole ? `Claimed: ${e.claimedRole} — role not established` : "Role not established"),
            address: e.address,
            chain: e.chain,
            state: e.state,
            evidenceRef: e.roleComponent && e.role ? componentLabel(e.roleComponent) : undefined,
          }))}
        />
      );
    case "EVIDENCE_SNAPSHOT": {
      const items: EvidenceKindMeta[] = block.spec.evidenceIds.flatMap((id) => {
        const e = evidenceById.get(id);
        if (!e) return [];
        return [
          {
            kind:
              e.sourceClass === "ONCHAIN_VERIFIABLE"
                ? "ON_CHAIN"
                : e.sourceClass === "GOVERNANCE"
                  ? "GOVERNANCE"
                  : e.sourceClass === "DATA_PROVIDER"
                    ? "QUANTITATIVE"
                    : "DOCUMENTARY",
            source: e.sourceTitle ?? e.retrievedUrl,
            fragment: e.fragment,
            proves: e.summary ?? "",
            doesNotProve: e.doesNotProve ?? "",
            retrievedAt: dateOnly(e.fetchedAt),
            href: e.retrievedUrl,
          },
        ];
      });
      return <EvidenceSnapshotBlock items={items} />;
    }
    case "DEEP_PROOF":
      return (
        <DeepProofEntryBlock
          rows={block.spec.rows.map((r) => ({
            label: componentLabel(r.component),
            state: r.state,
            sources: r.sources,
          }))}
        />
      );
  }
}
