// OUTPUT PLAN FIXTURES — FIVE MATERIALLY DIFFERENT RESEARCH RECORDS.
//
// Compact, deterministic, invented. Each is the structured record a
// finished Research would hand `chooseAnalyticalBlocks`, shaped so that the
// planner has to make a DIFFERENT decision on each: a full economic chain,
// a supply measurement that contradicts a net reduction, a governance
// progression with no numbers at all, a sparse run, and a wallet-heavy path
// where only some roles were ever established.
//
// NOT A SECOND GOLDEN RESULT. The showcase fixture shows every block at once
// to display the language; these exist to show the planner choosing, and
// choosing NOT to, from records that do not justify everything.
//
// Every number, address, date and sentence is invented. The `answer` prose
// is fixture copy for the dev route only — the planner produces no prose.
import type {
  AnalyticalOutputInputV1,
  PlanComponent,
  PlanEvidence,
  PlanFlow,
  PlanQuantity,
} from "./output-plan";
import type { LadderComponentInput } from "./research-model";

export interface OutputPlanFixture {
  key: string;
  title: string;
  input: AnalyticalOutputInputV1;
  answer: { short: string; paragraphs: string[] };
  // The component rows WITH coverage, for the audit composition — the one
  // thing the selector's input does not carry and the audit needs, so a
  // BLOCKED check can be shown as "not checked". Absent on the research
  // fixtures, which have no blocked check to show.
  auditComponents?: readonly LadderComponentInput[];
}

const FETCHED = "2026-03-02T09:00:00.000Z";

function ev(
  id: string,
  step: number,
  component: string,
  partial: Partial<Omit<PlanEvidence, "id" | "patternStep" | "component">> = {},
): PlanEvidence {
  return {
    id,
    patternStep: step,
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    fragment: `Fixture fragment for ${id}.`,
    summary: `Fixture statement for ${id}.`,
    doesNotProve: `What ${id} does not establish.`,
    mechanismState: null,
    publishedAt: null,
    observedAt: null,
    fetchedAt: FETCHED,
    retrievedUrl: `https://fixture.invalid/${id}`,
    sourceTitle: `Fixture source ${id}`,
    ...partial,
  };
}

function comp(
  step: number,
  component: string,
  status: string,
  supporting: string[] = [],
  contradicting: string[] = [],
  reasonCodes: string[] = [],
): PlanComponent {
  return {
    step,
    component,
    status,
    reasonCodes,
    supportingEvidenceIds: supporting,
    contradictingEvidenceIds: contradicting,
  };
}

const MINT = "FixTokenMint1111111111111111111111111111111";
const DECIMALS = 6;

// Six periods of acquired / burned, as a series. P6 is UNKNOWN: null, not
// zero, and it rests on the aggregate row that records five of six periods
// observed — the row that documents the gap, since no row measures it. P5
// burned is a MEASURED ZERO: "0", a value with its own row.
function periodSeries(
  component: string,
  step: number,
  factKind: string,
  values: (string | null)[],
  unknownRef: string,
): PlanQuantity[] {
  return values.map((amountRaw, i) => {
    const evidenceId =
      amountRaw === null ? unknownRef : `${component.toLowerCase()}-${factKind.toLowerCase()}-p${i + 1}`;
    return {
      evidenceId,
      // One fixture observation per reading, as a real record has.
      observationId: `obs-${evidenceId}`,
      factKind,
      step,
      component,
      mint: MINT,
      decimals: DECIMALS,
      amountRaw,
      position: { key: `P${i + 1}`, ordinal: i + 1 },
    };
  });
}

/* ------------------------------ A ------------------------------ */

const A_ACQUIRED = periodSeries("EXECUTION_EVIDENCE", 4, "DECODED_EXCHANGE", [
  "1600000000000",
  "2100000000000",
  "1900000000000",
  "2400000000000",
  "2000000000000",
  null,
], "a-acquired-total");
const A_BURNED = periodSeries("NET_EFFECT", 7, "BURN", [
  "1600000000000",
  "2100000000000",
  "1200000000000",
  "1800000000000",
  "0",
  null,
], "a-burned-total");

const A_FLOW: PlanFlow = {
  flowId: "a-flow-1",
  lifecycle: "CURRENT",
  shape: "COMPLETE_PATH",
  nodes: [
    { kind: "VALUE_SOURCE", component: "SOURCE_OF_VALUE", componentStatus: "SUPPORTED" },
    { kind: "MECHANISM", component: "MECHANISM_SPEC", componentStatus: "SUPPORTED" },
    { kind: "DESTINATION", component: "DESTINATION", componentStatus: "SUPPORTED" },
  ],
  edges: [
    { from: "VALUE_SOURCE", to: "MECHANISM", basisComponent: "FLOW_PATH", basisStatus: "SUPPORTED", executed: true },
    { from: "MECHANISM", to: "DESTINATION", basisComponent: "EXECUTION_EVIDENCE", basisStatus: "PARTIALLY_SUPPORTED", executed: true },
  ],
  netEffect: { componentStatus: "PARTIALLY_SUPPORTED" },
};

const FIXTURE_A: OutputPlanFixture = {
  key: "A",
  title: "Value capture — a full economic chain",
  answer: {
    short: "Fees are collected, allocated and spent on the token; how much of the acquired supply was removed is only partly established.",
    paragraphs: [
      "The source of value, the path it takes and the documented allocation are established from confirmed sources.",
      "Acquisitions were observed on chain in five of six periods; their attribution to the documented program rests on documentary provenance rather than a machine-verified causal link.",
      "Burns were observed in the same periods, but the net change in total supply across the interval was not measured, so the effect on supply is partly established.",
    ],
  },
  input: {
    question: { text: "Does the token capture value from protocol fees, and how?", intent: "VALUE_CAPTURE", relevantComponents: ["SOURCE_OF_VALUE", "DESTINATION", "NET_EFFECT"] },
    verdict: "PARTIALLY_SUPPORTED",
    confidenceBand: "LIMITED",
    components: [
      comp(1, "SOURCE_OF_VALUE", "SUPPORTED", ["a-fees"]),
      comp(2, "FLOW_PATH", "SUPPORTED", ["a-path"]),
      comp(3, "MECHANISM_SPEC", "SUPPORTED", ["a-docs"]),
      comp(3, "GOVERNANCE_BASIS", "SUPPORTED", ["a-gov"]),
      comp(4, "EXECUTION_EVIDENCE", "PARTIALLY_SUPPORTED", ["a-acquired-total", ...A_ACQUIRED.slice(0, 5).map((q) => q.evidenceId)], [], ["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]),
      comp(5, "CURRENT_STATE", "SUPPORTED", ["a-state"]),
      comp(6, "DESTINATION", "SUPPORTED", ["a-treasury"]),
      comp(6, "RECIPIENT", "PARTIALLY_SUPPORTED", ["a-treasury"], [], ["INDIRECT_ONLY"]),
      comp(7, "NET_EFFECT", "PARTIALLY_SUPPORTED", ["a-burned-total", ...A_BURNED.slice(0, 5).map((q) => q.evidenceId)], [], ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]),
    ],
    evidence: [
      ev("a-fees", 1, "SOURCE_OF_VALUE", { sourceClass: "ONCHAIN_VERIFIABLE", fragment: '{"program":"FeeProg","lamports":184000000}', summary: "Fees are collected by a program the project confirmed as its own." }),
      ev("a-path", 2, "FLOW_PATH", { sourceClass: "ONCHAIN_VERIFIABLE", summary: "Collected fees are transferred to the treasury account." }),
      ev("a-docs", 3, "MECHANISM_SPEC", { publishedAt: "2025-11-04", fragment: "30% of protocol fees are used to purchase the token on the open market.", summary: "The documentation specifies a 30% fee allocation to token purchases." }),
      ev("a-gov", 3, "GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", publishedAt: "2026-01-22", fragment: "Proposal 41 — Allocate 30% of protocol fees to token purchases. Result: passed.", summary: "A governance vote ratified the allocation.", doesNotProve: "That the decision was implemented. An approval is not an activation." }),
      ev("a-state", 5, "CURRENT_STATE", { publishedAt: "2026-02-09", mechanismState: "LIVE", summary: "Parameters were announced as set on the collecting program." }),
      ev("a-treasury", 6, "DESTINATION", { summary: "The documentation names the treasury account that receives the fee share." }),
      ev("a-acquired-total", 4, "EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: "2026-02-28", fragment: '{"acquiredRaw":"10000000000000","periods":5}', summary: "Token acquisitions observed on chain across five periods." }),
      ...A_ACQUIRED.slice(0, 5).map((q, i) => ev(q.evidenceId, 4, "EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: `2026-0${1 + Math.floor(i / 2)}-1${i}`, fragment: `{"acquiredRaw":"${q.amountRaw}"}` })),
      ev("a-burned-total", 7, "NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: "2026-02-28", fragment: '{"burnedRaw":"6700000000000","periods":5}', summary: "Burns observed on chain across five periods.", doesNotProve: "That total supply fell over the interval — issuance elsewhere is not observed here." }),
      ...A_BURNED.slice(0, 5).map((q, i) => ev(q.evidenceId, 7, "NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: `2026-0${1 + Math.floor(i / 2)}-1${i}`, fragment: `{"burnedRaw":"${q.amountRaw}"}` })),
    ],
    flows: [A_FLOW],
    quantities: [
      { evidenceId: "a-acquired-total", observationId: "obs-a-acquired-total", factKind: "DECODED_EXCHANGE", step: 4, component: "EXECUTION_EVIDENCE", mint: MINT, decimals: DECIMALS, amountRaw: "10000000000000", position: null, coverage: { observed: 5, expected: 6 } },
      { evidenceId: "a-burned-total", observationId: "obs-a-burned-total", factKind: "BURN", step: 7, component: "NET_EFFECT", mint: MINT, decimals: DECIMALS, amountRaw: "6700000000000", position: null, coverage: { observed: 5, expected: 6 } },
      ...A_ACQUIRED,
      ...A_BURNED,
    ],
    entities: [
      { address: "7xK9fVn2QsWmT4aBcDeFgHjKpLmNoPqRsTuVwXyPq21", chain: "Fixture chain", claimedRole: "Protocol treasury", roleComponent: "DESTINATION", evidenceIds: ["a-treasury"] },
      { address: "9Ar2bCdEfGhJkLmNpQrStUvWxYz1234567890AbXm84", chain: "Fixture chain", claimedRole: "Mechanism executor", roleComponent: "EXECUTION_EVIDENCE", evidenceIds: ["a-acquired-total"] },
    ],
  },
};

/* ------------------------------ B ------------------------------ */

const FIXTURE_B: OutputPlanFixture = {
  key: "B",
  title: "Supply effect — a measurement that contradicts a net reduction",
  answer: {
    short: "A burn was observed, and total supply still rose over the measured interval; whether the mechanism reduced supply on net is contradicted, and its causal role is not established.",
    paragraphs: [
      "The burn is a direct on-chain fact of the stated amount. It says nothing about what else happened to supply in the same window.",
      "Two total-supply readings either side of the interval establish that supply ended higher than it began — issuance offset or exceeded the burn.",
      "Rising total supply does not show that the burn was not real, and it does not show what caused the rise. Attribution is unproven, not disproven.",
    ],
  },
  input: {
    question: { text: "Did the buyback-and-burn reduce total supply?", intent: "BURN_OR_SUPPLY_EFFECT", relevantComponents: ["NET_EFFECT", "EXECUTION_EVIDENCE"] },
    verdict: "NOT_SUPPORTED",
    confidenceBand: "STRONG",
    components: [
      comp(1, "SOURCE_OF_VALUE", "PARTIALLY_SUPPORTED", ["b-src"], [], ["INDIRECT_ONLY"]),
      comp(3, "MECHANISM_SPEC", "SUPPORTED", ["b-docs"]),
      comp(4, "EXECUTION_EVIDENCE", "SUPPORTED", ["b-burn"]),
      comp(6, "DESTINATION", "SUPPORTED", ["b-burn"]),
      comp(7, "NET_EFFECT", "CONTRADICTED", ["b-burn", "b-t0", "b-t1"], ["b-delta"], []),
    ],
    evidence: [
      ev("b-src", 1, "SOURCE_OF_VALUE", { directness: "INDIRECT", sourceClass: "OFFICIAL_REPORT", summary: "A quarterly report describes fee revenue funding the programme." }),
      ev("b-docs", 3, "MECHANISM_SPEC", { publishedAt: "2025-09-15", fragment: "Tokens repurchased with fees are burned quarterly.", summary: "The documentation specifies a quarterly burn." }),
      ev("b-burn", 4, "EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: "2026-01-30", fragment: '{"instruction":"Burn","amountRaw":"5000000000000"}', summary: "A Burn instruction of the stated amount was executed on the mint.", doesNotProve: "What funded the burn, or what else happened to supply in the same interval." }),
      ev("b-t0", 7, "NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: "2026-01-02", fragment: '{"supplyRaw":"998400000000000","slot":301000000}', summary: "Total supply at the start of the interval." }),
      ev("b-t1", 7, "NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: "2026-03-01", fragment: '{"supplyRaw":"1005100000000000","slot":315000000}', summary: "Total supply at the end of the interval." }),
      ev("b-delta", 7, "NET_EFFECT", { relationship: "CONTRADICTS", sourceClass: "ONCHAIN_VERIFIABLE", observedAt: "2026-03-01", fragment: '{"deltaRaw":"6700000000000","direction":"INCREASED","slotSpan":14000000}', summary: "Total supply was higher at the end of the interval than at the start.", doesNotProve: "That no tokens were destroyed — only that at least as many were issued or unlocked over the same period as were removed." }),
    ],
    flows: [
      {
        flowId: "b-flow-1",
        lifecycle: "CURRENT",
        shape: "COMPLETE_PATH",
        nodes: [
          { kind: "VALUE_SOURCE", component: "SOURCE_OF_VALUE", componentStatus: "PARTIALLY_SUPPORTED" },
          { kind: "MECHANISM", component: "MECHANISM_SPEC", componentStatus: "SUPPORTED" },
          { kind: "DESTINATION", component: "DESTINATION", componentStatus: "SUPPORTED" },
        ],
        edges: [
          { from: "VALUE_SOURCE", to: "MECHANISM", basisComponent: "SOURCE_OF_VALUE", basisStatus: "PARTIALLY_SUPPORTED", executed: true },
          { from: "MECHANISM", to: "DESTINATION", basisComponent: "EXECUTION_EVIDENCE", basisStatus: "SUPPORTED", executed: true },
        ],
        netEffect: { componentStatus: "CONTRADICTED" },
      },
    ],
    quantities: [
      { evidenceId: "b-burn", observationId: "obs-b-burn", factKind: "BURN", step: 4, component: "EXECUTION_EVIDENCE", mint: MINT, decimals: DECIMALS, amountRaw: "5000000000000", position: null },
      { evidenceId: "b-delta", observationId: "obs-b-delta", factKind: "TOTAL_SUPPLY_DELTA", step: 7, component: "NET_EFFECT", mint: MINT, decimals: DECIMALS, amountRaw: "6700000000000", direction: "INCREASED", position: null },
      { evidenceId: "b-t0", observationId: "obs-b-t0", factKind: "TOKEN_SUPPLY", step: 7, component: "NET_EFFECT", mint: MINT, decimals: DECIMALS, amountRaw: "998400000000000", position: { key: "Start of interval", ordinal: 0 } },
      { evidenceId: "b-t1", observationId: "obs-b-t1", factKind: "TOKEN_SUPPLY", step: 7, component: "NET_EFFECT", mint: MINT, decimals: DECIMALS, amountRaw: "1005100000000000", position: { key: "End of interval", ordinal: 1 } },
    ],
    entities: [],
  },
};

/* ------------------------------ C ------------------------------ */

const FIXTURE_C: OutputPlanFixture = {
  key: "C",
  title: "Governance state — a progression with no numbers",
  answer: {
    short: "The mechanism is documented and approved; its activation is only partly established and it has not been observed running.",
    paragraphs: [
      "The documentation and a passed governance proposal are both established from confirmed sources.",
      "An announcement states the parameters were set, but no on-chain confirmation of the live state was admitted.",
      "No execution was found in the period examined. Absence of an observation is not evidence that nothing ran.",
    ],
  },
  input: {
    question: { text: "Is the fee-share mechanism live right now?", intent: "MECHANISM_CURRENT_STATE", relevantComponents: ["CURRENT_STATE", "GOVERNANCE_BASIS"] },
    verdict: "PARTIALLY_SUPPORTED",
    confidenceBand: "LIMITED",
    components: [
      comp(3, "MECHANISM_SPEC", "SUPPORTED", ["c-docs"]),
      comp(3, "GOVERNANCE_BASIS", "SUPPORTED", ["c-gov"]),
      comp(5, "CURRENT_STATE", "PARTIALLY_SUPPORTED", ["c-state"], [], ["STATE_NOT_FULLY_LIVE"]),
      comp(4, "EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", [], [], ["NO_EVIDENCE_FOUND"]),
    ],
    evidence: [
      ev("c-docs", 3, "MECHANISM_SPEC", { publishedAt: "2025-11-04", fragment: "A share of fees is routed to stakers each epoch.", summary: "The documentation specifies the fee share." }),
      ev("c-gov", 3, "GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", publishedAt: "2026-01-22", fragment: "Proposal 12 passed with quorum.", summary: "Governance approved the fee share.", doesNotProve: "That it was switched on." }),
      ev("c-state", 5, "CURRENT_STATE", { directness: "INDIRECT", publishedAt: "2026-02-09", mechanismState: "IMPLEMENTING", fragment: "Parameters have been set and the share goes live next epoch.", summary: "An announcement describes activation as imminent.", doesNotProve: "That the parameters are live on chain." }),
      ev("c-address", 3, "MECHANISM_SPEC", { relationship: "CONTEXT", fragment: "Distribution program: 3Fz…", summary: "A program address is named in the documentation." }),
    ],
    flows: [],
    quantities: [],
    entities: [
      { address: "3FzQwErTyUiOpAsDfGhJkLzXcVbNm1234567890QwEr", chain: "Fixture chain", claimedRole: "Distribution program", roleComponent: null, evidenceIds: ["c-address"] },
    ],
  },
};

/* ------------------------------ D ------------------------------ */

const FIXTURE_D: OutputPlanFixture = {
  key: "D",
  title: "Sparse — insufficient evidence",
  answer: {
    short: "ATLAS could not establish the mechanism from the sources it could read.",
    paragraphs: [
      "One media article describes a buyback programme; no official documentation, governance record or chain fact was admitted.",
      "Nothing about the source of value, execution or supply effect could be established. This is a limit of what was found, not a finding against the project.",
    ],
  },
  input: {
    question: { text: "Does the protocol buy back its token?", intent: null, relevantComponents: [] },
    verdict: "INSUFFICIENT_EVIDENCE",
    confidenceBand: "LOW",
    components: [
      comp(1, "SOURCE_OF_VALUE", "INSUFFICIENT_EVIDENCE", [], [], ["NO_EVIDENCE_FOUND"]),
      comp(3, "MECHANISM_SPEC", "PARTIALLY_SUPPORTED", ["d-media"], [], ["INSUFFICIENT_AUTHORITY"]),
      comp(4, "EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", [], [], ["NO_EVIDENCE_FOUND"]),
      comp(7, "NET_EFFECT", "INSUFFICIENT_EVIDENCE", [], [], ["NO_EVIDENCE_FOUND"]),
    ],
    evidence: [
      ev("d-media", 3, "MECHANISM_SPEC", { directness: "INDIRECT", sourceClass: "RESEARCH_MEDIA", officiality: "CLAIMED", publishedAt: "2026-02-01", fragment: "The team says 20% of revenue goes to buybacks.", summary: "A media article reports a buyback programme.", doesNotProve: "That the programme exists as described, or that anything was bought." }),
      ev("d-social", 3, "MECHANISM_SPEC", { relationship: "CONTEXT", sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: "Buybacks soon!", summary: null }),
    ],
    flows: [
      {
        flowId: "d-flow-1",
        lifecycle: "NOT_ESTABLISHED",
        shape: "PARTIAL_PATH",
        nodes: [
          { kind: "VALUE_SOURCE", component: "SOURCE_OF_VALUE", componentStatus: "INSUFFICIENT_EVIDENCE" },
          { kind: "MECHANISM", component: "MECHANISM_SPEC", componentStatus: "PARTIALLY_SUPPORTED" },
        ],
        edges: [
          { from: "VALUE_SOURCE", to: "MECHANISM", basisComponent: "SOURCE_OF_VALUE", basisStatus: "INSUFFICIENT_EVIDENCE", executed: false },
        ],
        netEffect: null,
      },
    ],
    quantities: [],
    entities: [
      { address: "5TrEaSuRyAbCdEfGhJkLmNoPqRsTuVwXyZ0987654321Ab", chain: "Fixture chain", claimedRole: "Treasury", roleComponent: "DESTINATION", evidenceIds: ["d-media"] },
    ],
  },
};

/* ------------------------------ E ------------------------------ */

const FIXTURE_E: OutputPlanFixture = {
  key: "E",
  title: "Wallet flow — roles established for some addresses only",
  answer: {
    short: "Fees reach a treasury account the project names as its own; a transfer onward was observed, but the mechanism was not shown to have executed and no recipient was established.",
    paragraphs: [
      "The fee-collecting program and the treasury are established from confirmed documentation and bound chain reads.",
      "One outbound transfer from the treasury was observed. The account it went to appears only in that transaction; no source assigns it a role.",
      "Whether that transfer was the documented mechanism running is not established, so the chain stops at the treasury.",
    ],
  },
  input: {
    question: { text: "Where do protocol fees actually go?", intent: "PROTOCOL_REVENUE_TO_TOKEN", relevantComponents: ["SOURCE_OF_VALUE", "DESTINATION"] },
    verdict: "PARTIALLY_SUPPORTED",
    confidenceBand: "LIMITED",
    components: [
      comp(1, "SOURCE_OF_VALUE", "SUPPORTED", ["e-fees"]),
      comp(2, "FLOW_PATH", "SUPPORTED", ["e-path"]),
      comp(3, "MECHANISM_SPEC", "SUPPORTED", ["e-docs"]),
      comp(4, "EXECUTION_EVIDENCE", "PARTIALLY_SUPPORTED", ["e-tx"], [], ["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]),
      comp(6, "DESTINATION", "SUPPORTED", ["e-treasury"]),
      comp(6, "RECIPIENT", "INSUFFICIENT_EVIDENCE", [], [], ["NO_EVIDENCE_FOUND"]),
    ],
    evidence: [
      ev("e-fees", 1, "SOURCE_OF_VALUE", { sourceClass: "ONCHAIN_VERIFIABLE", summary: "Fees are collected by a program the project confirmed." }),
      ev("e-path", 2, "FLOW_PATH", { sourceClass: "ONCHAIN_VERIFIABLE", summary: "Collected fees are transferred to the treasury." }),
      ev("e-docs", 3, "MECHANISM_SPEC", { publishedAt: "2025-12-01", fragment: "Treasury funds are used for token purchases.", summary: "The documentation describes purchases from the treasury." }),
      ev("e-tx", 4, "EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", observedAt: "2026-02-28", fragment: '{"instruction":"Transfer","amountRaw":"2500000000000","to":"Cp9…"}', summary: "One outbound transfer of the fee asset from the treasury was observed.", doesNotProve: "That this transfer was the documented mechanism, or who the receiving account is." }),
      ev("e-treasury", 6, "DESTINATION", { summary: "The documentation names the treasury account." }),
      ev("e-other", 4, "EXECUTION_EVIDENCE", { relationship: "LIMITS", sourceClass: "SOCIAL", officiality: "CLAIMED", fragment: "The buyback bot is Cp9…", summary: null }),
    ],
    flows: [
      {
        flowId: "e-flow-1",
        lifecycle: "CURRENT",
        shape: "PARTIAL_PATH",
        nodes: [
          { kind: "VALUE_SOURCE", component: "SOURCE_OF_VALUE", componentStatus: "SUPPORTED" },
          { kind: "MECHANISM", component: "MECHANISM_SPEC", componentStatus: "SUPPORTED" },
          { kind: "DESTINATION", component: "DESTINATION", componentStatus: "SUPPORTED" },
        ],
        edges: [
          { from: "VALUE_SOURCE", to: "MECHANISM", basisComponent: "FLOW_PATH", basisStatus: "SUPPORTED", executed: true },
          // A transfer HAPPENED and its basis is partly established — and
          // the assembler did not determine that the mechanism executed.
          { from: "MECHANISM", to: "DESTINATION", basisComponent: "EXECUTION_EVIDENCE", basisStatus: "PARTIALLY_SUPPORTED", executed: false },
        ],
        netEffect: null,
      },
    ],
    quantities: [
      { evidenceId: "e-tx", observationId: "obs-e-tx", factKind: "TOKEN_TRANSFER", step: 4, component: "EXECUTION_EVIDENCE", mint: MINT, decimals: DECIMALS, amountRaw: "2500000000000", position: null },
    ],
    entities: [
      { address: "7xK9fVn2QsWmT4aBcDeFgHjKpLmNoPqRsTuVwXyPq21", chain: "Fixture chain", claimedRole: "Protocol treasury", roleComponent: "DESTINATION", evidenceIds: ["e-treasury"] },
      { address: "FeE1CoLlEcToRpRoGrAm1234567890AbCdEfGhJkLm", chain: "Fixture chain", claimedRole: "Fee collector", roleComponent: "SOURCE_OF_VALUE", evidenceIds: ["e-fees"] },
      // Appears in one transaction. Nobody assigned it a role.
      { address: "Cp9ZxCvBnMaSdFgHjKlQwErTyUiOp0987654321ZxCv", chain: "Fixture chain", claimedRole: null, roleComponent: null, evidenceIds: ["e-tx"] },
      // A social post calls it the buyback bot. That row was not admitted
      // for EXECUTION_EVIDENCE, so the claim grounds nothing.
      { address: "Cp9ZxCvBnMaSdFgHjKlQwErTyUiOp0987654321ZxCw", chain: "Fixture chain", claimedRole: "Buyback executor", roleComponent: "EXECUTION_EVIDENCE", evidenceIds: ["e-other"] },
    ],
  },
};

/* ---------------------------- GOLDEN AUDIT ---------------------------- */

// THE GOLDEN AUDIT FIXTURE — WHAT AN AUDIT CAN EXPRESS.
//
// The real historical job is a truth test and a sparsity test: mostly not
// established, one metric, no flow, no timeline. Designing the audit
// language around it produces a checklist. This record is the other end:
// invented, balanced, and structured enough that the selector justifies
// four metrics, a flow, a table, a chart and a timeline — so the audit's
// analytical middle can be judged at all. It is a design fixture in exactly
// the sense the research showcase is: what ATLAS CAN express, never what a
// given research needs.
//
// BALANCED BY DESIGN: three established checks, two partly established, one
// contradicted, one not established, one that could not be checked — every
// state the audit has to present, once each at least. No entities: nothing
// in this record binds an address to a role, and the fixture does not
// pretend otherwise.

const G_ACQUIRED = periodSeries("EXECUTION_EVIDENCE", 4, "DECODED_EXCHANGE", [
  "1400000000000",
  "1900000000000",
  "2200000000000",
  "1700000000000",
  "2300000000000",
  null,
], "g-acquired-total");
const G_BURNED = periodSeries("NET_EFFECT", 7, "BURN", [
  "1400000000000",
  "1900000000000",
  "1100000000000",
  "1700000000000",
  "0",
  null,
], "g-burned-total");

export const GOLDEN_AUDIT_FIXTURE: OutputPlanFixture = {
  key: "GOLDEN",
  title: "Golden audit — full expressive capability",
  answer: {
    short: "Fees are collected and routed as documented; acquisitions ran in five of six periods; total supply still rose over the interval.",
    paragraphs: [],
  },
  input: {
    question: { text: "Does the buyback-and-burn reduce the token's total supply, and is it running as documented?", intent: "BURN_OR_SUPPLY_EFFECT", relevantComponents: ["NET_EFFECT", "EXECUTION_EVIDENCE", "SOURCE_OF_VALUE"] },
    verdict: "PARTIALLY_SUPPORTED",
    confidenceBand: "LIMITED",
    components: [
      comp(1, "SOURCE_OF_VALUE", "SUPPORTED", ["g-fees"]),
      comp(2, "FLOW_PATH", "SUPPORTED", ["g-path"]),
      comp(3, "MECHANISM_SPEC", "SUPPORTED", ["g-docs"]),
      comp(3, "GOVERNANCE_BASIS", "PARTIALLY_SUPPORTED", ["g-gov"], [], ["INDIRECT_ONLY"]),
      comp(4, "EXECUTION_EVIDENCE", "PARTIALLY_SUPPORTED", ["g-acquired-total", ...G_ACQUIRED.slice(0, 5).map((q) => q.evidenceId)], [], ["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]),
      comp(5, "CURRENT_STATE", "INSUFFICIENT_EVIDENCE", [], [], ["MISSING_CURRENT_STATE"]),
      comp(6, "DESTINATION", "INSUFFICIENT_EVIDENCE", [], [], ["NO_EVIDENCE_FOUND"]),
      comp(7, "NET_EFFECT", "CONTRADICTED", ["g-burned-total", ...G_BURNED.slice(0, 5).map((q) => q.evidenceId)], ["g-delta"], ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"]),
    ],
    evidence: [
      ev("g-fees", 1, "SOURCE_OF_VALUE", { sourceClass: "ONCHAIN_VERIFIABLE", sourceTitle: "Chain read · fee program", observedAt: "2026-04-30", fragment: '{"program":"FeeProg","lamportsRaw":"18400000000000000"}', summary: "Trading fees are collected by a program the project confirmed as its own.", doesNotProve: "Where the collected fees go, or that any of them reach the token." }),
      ev("g-path", 2, "FLOW_PATH", { sourceClass: "ONCHAIN_VERIFIABLE", sourceTitle: "Chain read · treasury inflows", observedAt: "2026-04-30", fragment: '{"from":"FeeProg","to":"Treasury","amountRaw":"5520000000000"}', summary: "Collected fees are transferred to the treasury account named in the documentation.", doesNotProve: "That the treasury spends them as documented." }),
      ev("g-docs", 3, "MECHANISM_SPEC", { sourceTitle: "Protocol documentation · Tokenomics", publishedAt: "2025-11-04", fragment: "30% of protocol fees are used to purchase the token on the open market and burn it each period.", summary: "The documentation specifies a 30% fee allocation to purchases that are then burned.", doesNotProve: "That the purchases happen, or that burning them lowers total supply." }),
      ev("g-gov", 3, "GOVERNANCE_BASIS", { sourceClass: "GOVERNANCE", sourceTitle: "Governance record · proposal 41", directness: "INDIRECT", publishedAt: "2026-01-22", fragment: "Proposal 41 — Allocate 30% of protocol fees to token purchases. Result: passed.", summary: "A governance record refers to the allocation being ratified.", doesNotProve: "That the proposal was executed. Proposal passed is not proposal executed." }),
      ev("g-acquired-total", 4, "EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", sourceTitle: "Chain read · acquisitions, six periods", observedAt: "2026-04-30", fragment: '{"acquiredRaw":"9500000000000","periods":5}', summary: "Token acquisitions were observed on chain across five of six periods.", doesNotProve: "That the acquisitions were the documented mechanism running — the invoking program is not bound to it by any on-chain provenance." }),
      ...G_ACQUIRED.slice(0, 5).map((q, i) => ev(q.evidenceId, 4, "EXECUTION_EVIDENCE", { sourceClass: "ONCHAIN_VERIFIABLE", sourceTitle: `Chain read · acquisitions, period ${i + 1}`, observedAt: `2026-0${2 + Math.floor(i / 2)}-1${i}`, fragment: `{"acquiredRaw":"${q.amountRaw}","period":${i + 1}}`, summary: `Token acquisitions of the stated amount were observed on chain in period ${i + 1}.`, doesNotProve: "That the acquisition was the documented mechanism running, or where the acquired tokens went." })),
      ev("g-burned-total", 7, "NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", sourceTitle: "Chain read · burns, six periods", observedAt: "2026-04-30", fragment: '{"burnedRaw":"6100000000000","periods":5}', summary: "Burn instructions of the stated amounts were executed on the mint across five periods.", doesNotProve: "That total supply fell over the interval — what was issued or unlocked in the same window is a separate measurement." }),
      ...G_BURNED.slice(0, 5).map((q, i) => ev(q.evidenceId, 7, "NET_EFFECT", { sourceClass: "ONCHAIN_VERIFIABLE", sourceTitle: `Chain read · burns, period ${i + 1}`, observedAt: `2026-0${2 + Math.floor(i / 2)}-1${i}`, fragment: `{"burnedRaw":"${q.amountRaw}","period":${i + 1}}`, summary: q.amountRaw === "0" ? `No burn instruction was executed on the mint in period ${i + 1}: a measured zero.` : `A burn instruction of the stated amount was executed on the mint in period ${i + 1}.`, doesNotProve: "That total supply fell over the period — what was issued or unlocked in the same window is a separate measurement." })),
      ev("g-delta", 7, "NET_EFFECT", { relationship: "CONTRADICTS", sourceClass: "ONCHAIN_VERIFIABLE", sourceTitle: "Chain read · total supply, interval", observedAt: "2026-05-01", fragment: '{"supplyStartRaw":"998400000000000","supplyEndRaw":"1005100000000000","direction":"INCREASED","slotSpan":14000000}', summary: "Total supply was higher at the end of the interval than at the start.", doesNotProve: "That no tokens were destroyed — only that at least as many were issued or unlocked over the same period as were removed." }),
    ],
    flows: [
      {
        flowId: "g-flow-1",
        lifecycle: "CURRENT",
        shape: "PARTIAL_PATH",
        nodes: [
          { kind: "VALUE_SOURCE", component: "SOURCE_OF_VALUE", componentStatus: "SUPPORTED" },
          { kind: "MECHANISM", component: "MECHANISM_SPEC", componentStatus: "SUPPORTED" },
          { kind: "DESTINATION", component: "DESTINATION", componentStatus: "INSUFFICIENT_EVIDENCE" },
        ],
        edges: [
          { from: "VALUE_SOURCE", to: "MECHANISM", basisComponent: "FLOW_PATH", basisStatus: "SUPPORTED", executed: true },
          { from: "MECHANISM", to: "DESTINATION", basisComponent: "EXECUTION_EVIDENCE", basisStatus: "PARTIALLY_SUPPORTED", executed: true },
        ],
        netEffect: { componentStatus: "CONTRADICTED" },
      },
    ],
    quantities: [
      // Fees in the chain's native asset — its own unit domain (nine
      // decimals, the native mint id) — and the one movement kind that
      // can stand at SOURCE. A token transfer is a movement; native fee
      // inflow is where the value comes from.
      { evidenceId: "g-fees", observationId: "obs-g-fees", factKind: "NATIVE_TRANSFER", step: 1, component: "SOURCE_OF_VALUE", mint: "So11111111111111111111111111111111111111112", decimals: 9, amountRaw: "18400000000000000", position: null, coverage: { observed: 6, expected: 6 } },
      { evidenceId: "g-acquired-total", observationId: "obs-g-acquired-total", factKind: "DECODED_EXCHANGE", step: 4, component: "EXECUTION_EVIDENCE", mint: MINT, decimals: DECIMALS, amountRaw: "9500000000000", position: null, coverage: { observed: 5, expected: 6 } },
      { evidenceId: "g-burned-total", observationId: "obs-g-burned-total", factKind: "BURN", step: 7, component: "NET_EFFECT", mint: MINT, decimals: DECIMALS, amountRaw: "6100000000000", position: null, coverage: { observed: 5, expected: 6 } },
      { evidenceId: "g-delta", observationId: "obs-g-delta", factKind: "TOTAL_SUPPLY_DELTA", step: 7, component: "NET_EFFECT", mint: MINT, decimals: DECIMALS, amountRaw: "6700000000000", direction: "INCREASED", position: null },
      ...G_ACQUIRED,
      ...G_BURNED,
    ],
    entities: [],
  },
  // The same eight, with coverage: DESTINATION is the check the run could
  // not open sources for — a fact about the run, shown as "not checked".
  auditComponents: [
    { component: "SOURCE_OF_VALUE", status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["g-fees"], contradictingEvidenceIds: [], coverage: "COMPLETED" },
    { component: "FLOW_PATH", status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["g-path"], contradictingEvidenceIds: [], coverage: "COMPLETED" },
    { component: "MECHANISM_SPEC", status: "SUPPORTED", reasonCodes: [], supportingEvidenceIds: ["g-docs"], contradictingEvidenceIds: [], coverage: "COMPLETED" },
    { component: "GOVERNANCE_BASIS", status: "PARTIALLY_SUPPORTED", reasonCodes: ["INDIRECT_ONLY"], supportingEvidenceIds: ["g-gov"], contradictingEvidenceIds: [], coverage: "COMPLETED" },
    { component: "EXECUTION_EVIDENCE", status: "PARTIALLY_SUPPORTED", reasonCodes: ["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"], supportingEvidenceIds: ["g-acquired-total", ...G_ACQUIRED.slice(0, 5).map((q) => q.evidenceId)], contradictingEvidenceIds: [], coverage: "COMPLETED" },
    { component: "CURRENT_STATE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["MISSING_CURRENT_STATE"], supportingEvidenceIds: [], contradictingEvidenceIds: [], coverage: "COMPLETED" },
    { component: "DESTINATION", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"], supportingEvidenceIds: [], contradictingEvidenceIds: [], coverage: "BLOCKED" },
    { component: "NET_EFFECT", status: "CONTRADICTED", reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"], supportingEvidenceIds: ["g-burned-total", ...G_BURNED.slice(0, 5).map((q) => q.evidenceId)], contradictingEvidenceIds: ["g-delta"], coverage: "COMPLETED" },
  ],
};

export const OUTPUT_PLAN_FIXTURES: readonly OutputPlanFixture[] = [
  FIXTURE_A,
  FIXTURE_B,
  FIXTURE_C,
  FIXTURE_D,
  FIXTURE_E,
];

export function outputPlanFixture(key: string | null | undefined): OutputPlanFixture {
  return OUTPUT_PLAN_FIXTURES.find((f) => f.key === (key ?? "").toUpperCase()) ?? FIXTURE_A;
}
