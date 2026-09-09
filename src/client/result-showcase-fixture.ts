// ============================================================
// DESIGN FIXTURE — NOT A REAL RESEARCH RESULT.
// ============================================================
//
// Every value in this file is INVENTED to make each presentation block
// visible. Nothing here was researched, retrieved, measured or verified, no
// project is named, and no address exists on any chain. It must never be
// read as a finding about anything.
//
// It exists so the complete result experience can be judged in one page
// before the presentation language is wired to the real engine. The blocks
// it feeds take typed props and know nothing about this file; when the real
// result arrives it supplies the same shapes and this fixture is deleted.
//
// DELIBERATELY MIXED STATES. A fixture where everything is established
// proves nothing about the layout — the hard cases are a chain that breaks
// halfway, a metric nobody could establish, a contradicted check and a
// period with no measurement, so all four are here.
import type {
  AnswerHeader,
  ChartPoint,
  EntityRef,
  EvidenceKindMeta,
  FlowStage,
  Metric,
  ProofMapCell,
  ProofState,
  TableColumn,
  TableRow,
  TimelineEvent,
} from "./components/result-blocks/types";

export const FIXTURE_NOTICE = {
  title: "Design fixture",
  body: "Not a real research result. Every number, address, date and quotation below is invented to show the structure of an ATLAS result. Nothing here was researched or verified.",
};

export const FIXTURE_HEADER: AnswerHeader = {
  question:
    "Does the token capture real economic value from this protocol's fees today, and if so, how exactly?",
  verdict: "Partially supported",
  confidence: "Limited",
  asOf: "Fixture · no run",
  answer: [
    "The protocol documents a fee split that routes a share of revenue into buying the token on the open market, and the checked sources establish that this is what the documentation specifies.",
    "The origin of that value and the path it takes are established: fees are collected by a program the project confirmed as its own, and the sources trace those fees to a treasury account.",
    "What the evidence does not reach is whether the mechanism ran in the period examined. No execution was observed, so the destination of the acquired tokens and their effect on supply are not established.",
    "One check points the other way: the measured supply over the period did not fall, which is inconsistent with a durable reduction.",
  ],
};

export const FIXTURE_PROOF_MAP: ProofMapCell[] = [
  { label: "Mechanism", state: "ESTABLISHED", note: "Documented by the project" },
  { label: "Source of value", state: "ESTABLISHED", note: "Fees, attributed on chain" },
  { label: "Execution", state: "NOT_ESTABLISHED", note: "No run observed" },
  { label: "Recipient", state: "PARTLY_ESTABLISHED", note: "Account known, role not" },
  { label: "Net effect", state: "CONTRADICTED", note: "Supply did not fall" },
];

export const FIXTURE_METRICS: Metric[] = [
  {
    value: "$18.4M",
    label: "Protocol revenue",
    state: "ESTABLISHED",
    period: "6 periods",
    source: "Data provider",
  },
  {
    value: "30",
    unit: "%",
    label: "Mechanism allocation",
    state: "ESTABLISHED",
    period: "Stated policy",
    source: "Official docs",
  },
  {
    value: "11.2M",
    unit: "tokens",
    label: "Tokens acquired",
    state: "PARTLY_ESTABLISHED",
    period: "5 of 6 periods",
    source: "On-chain",
  },
  {
    value: "−6.7M",
    unit: "tokens",
    label: "Measured supply change",
    state: "CONTRADICTED",
    period: "Interval net",
    source: "On-chain",
  },
];

export const FIXTURE_FLOW: FlowStage[] = [
  { label: "Economic activity", state: "ESTABLISHED", detail: "Trading on the protocol" },
  { label: "Protocol fees", state: "ESTABLISHED", detail: "Collected by a confirmed program" },
  { label: "Token mechanism", state: "ESTABLISHED", detail: "Allocation stated in docs" },
  { label: "Token action", state: "NOT_ESTABLISHED", detail: "No execution observed" },
  { label: "Destination", state: "NOT_ESTABLISHED", detail: "Not reached" },
  { label: "Final effect", state: "CONTRADICTED", detail: "Supply did not fall" },
];

export const FIXTURE_TABLE_COLUMNS: TableColumn[] = [
  { key: "period", label: "Period" },
  { key: "revenue", label: "Revenue", numeric: true, unit: "$M" },
  { key: "allocation", label: "Allocation", numeric: true, unit: "$M" },
  { key: "acquired", label: "Acquired", numeric: true, unit: "M tok" },
  { key: "burned", label: "Burned", numeric: true, unit: "M tok" },
  { key: "treasury", label: "Treasury", numeric: true, unit: "M tok" },
];

export const FIXTURE_TABLE_ROWS: TableRow[] = [
  { key: "p1", state: "ESTABLISHED", cells: { period: "Period 1", revenue: "2.60", allocation: "0.78", acquired: "1.60", burned: "1.60", treasury: "0.00" } },
  { key: "p2", state: "ESTABLISHED", cells: { period: "Period 2", revenue: "3.40", allocation: "1.02", acquired: "2.10", burned: "2.10", treasury: "0.00" } },
  { key: "p3", state: "ESTABLISHED", cells: { period: "Period 3", revenue: "3.10", allocation: "0.93", acquired: "1.90", burned: "1.20", treasury: "0.70" } },
  { key: "p4", state: "ESTABLISHED", cells: { period: "Period 4", revenue: "3.90", allocation: "1.17", acquired: "2.40", burned: "1.80", treasury: "0.60" } },
  { key: "p5", state: "ESTABLISHED", cells: { period: "Period 5", revenue: "3.30", allocation: "0.99", acquired: "2.00", burned: "0.00", treasury: "2.00" } },
  { key: "p6", state: "NOT_ESTABLISHED", cells: { period: "Period 6", revenue: "2.10", allocation: "0.63", acquired: "—", burned: "—", treasury: "—" } },
];

export const FIXTURE_TABLE_NOTE =
  "Revenue and allocation come from a data provider; acquired, burned and treasury figures come from chain reads. A dash is a figure this research did not establish — never a zero.";

export const FIXTURE_CHART: ChartPoint[] = [
  { label: "P1", value: 1.6, state: "ESTABLISHED" },
  { label: "P2", value: 2.1, state: "ESTABLISHED" },
  { label: "P3", value: 1.9, state: "ESTABLISHED" },
  { label: "P4", value: 2.4, state: "ESTABLISHED" },
  { label: "P5", value: 2.0, state: "ESTABLISHED" },
  { label: "P6", value: null, state: "NOT_ESTABLISHED" },
];

export const FIXTURE_TIMELINE: TimelineEvent[] = [
  { date: "2025-11-04", kind: "DOCUMENTED", state: "ESTABLISHED", label: "Fee split published in protocol documentation", note: "Official docs" },
  { date: "2026-01-22", kind: "APPROVED", state: "ESTABLISHED", label: "Allocation ratified by a governance vote", note: "Governance record" },
  { date: "2026-02-09", kind: "ACTIVATED", state: "PARTLY_ESTABLISHED", label: "Parameters set on the collecting program", note: "Announcement; no on-chain confirmation admitted" },
  { date: "2026-02-28", kind: "EXECUTED", state: "ESTABLISHED", label: "First transaction attributed to the mechanism" },
  { date: "—", kind: "EXECUTED", state: "NOT_ESTABLISHED", label: "Most recent execution in the period examined", note: "Nothing observed in the latest period" },
];

// SYNTHETIC ADDRESSES. Valid in shape and in no ledger — they are derived
// from fixed strings so they cannot collide with a deployed account, and no
// claim whatsoever is made about any real address.
export const FIXTURE_ENTITIES: EntityRef[] = [
  {
    role: "Protocol treasury",
    address: "7xK9fVn2QsWmT4aBcDeFgHjKpLmNoPqRsTuVwXyPq21",
    chain: "Fixture chain",
    state: "ESTABLISHED",
    evidenceRef: "Named in the project's own documentation",
  },
  {
    role: "Mechanism executor",
    address: "9Ar2bCdEfGhJkLmNpQrStUvWxYz1234567890AbXm84",
    chain: "Fixture chain",
    state: "PARTLY_ESTABLISHED",
    evidenceRef: "Account exists; its role is not established",
  },
  {
    role: "Burn address",
    address: "4Qm7nBvCxZaSdFgHjKlPoIuYtReWqMnBvCxZaSdVd92",
    chain: "Fixture chain",
    state: "NOT_ESTABLISHED",
    evidenceRef: "No admitted evidence binds this address to the mechanism",
  },
];

export const FIXTURE_EVIDENCE: EvidenceKindMeta[] = [
  {
    kind: "DOCUMENTARY",
    source: "Protocol documentation · docs.example-fixture.invalid",
    fragment:
      "Thirty percent of protocol trading fees are allocated to open-market purchases of the token, with the remainder retained by the treasury.",
    proves: "That the project's own documentation specifies this allocation.",
    doesNotProve:
      "That the allocation was ever carried out, in what period, or by which account. A stated policy is not an execution.",
    retrievedAt: "2026-03-02",
    href: "#",
  },
  {
    kind: "ON_CHAIN",
    source: "Transaction read · slot 444414083",
    fragment:
      "Transaction 5xQ…f2A moved 1,600,000 raw units of the fee asset into account 7xK9…Pq21, in an instruction invoked by program 9Ar2…Xm84.",
    proves:
      "That this transfer happened, and that the invoking program caused it.",
    doesNotProve:
      "That the transfer was this mechanism, that the destination is a treasury, or that anyone economically received it. A movement is not a purpose.",
    retrievedAt: "2026-03-02",
    href: "#",
  },
  {
    kind: "GOVERNANCE",
    source: "Governance record · proposal 41",
    fragment:
      "Proposal 41 — Allocate 30% of protocol fees to token purchases. Result: passed, 82% in favour, quorum met.",
    proves: "That the allocation was authorised by a governance decision.",
    doesNotProve:
      "That the decision was implemented, or that it remains in force today. An approval is not an activation.",
    retrievedAt: "2026-03-01",
    href: "#",
  },
  {
    kind: "QUANTITATIVE",
    source: "Supply measurement · interval read",
    fragment:
      "Total supply at the start of the interval: 998.4M. Total supply at the end of the interval: 1,005.1M.",
    proves:
      "That the measured total supply was higher at the end of the interval than at the start.",
    doesNotProve:
      "That no tokens were destroyed — only that at least as many were issued or unlocked over the same period as were removed.",
    retrievedAt: "2026-03-02",
    href: "#",
  },
];

export const FIXTURE_DEEP_PROOF: { label: string; state: ProofState; sources: number }[] = [
  { label: "The project documents the mechanism", state: "ESTABLISHED", sources: 3 },
  { label: "A governing decision authorises it", state: "ESTABLISHED", sources: 1 },
  { label: "It is currently active", state: "PARTLY_ESTABLISHED", sources: 2 },
  { label: "It has been observed executing", state: "NOT_ESTABLISHED", sources: 0 },
  { label: "Where the value comes from", state: "ESTABLISHED", sources: 4 },
  { label: "Effect on token supply", state: "CONTRADICTED", sources: 2 },
];
