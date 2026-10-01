// ============================================================
// RESULT PRESENTATION FIXTURES — NOT REAL RESEARCH RESULTS.
// ============================================================
//
// Eight invented detail payloads, one per boundary/presentation state the
// result surface must render truthfully:
//
//   1. mostly confirmed
//   2. mixed confirmed / partially confirmed
//   3. genuine substantive not-established
//   4. technical bounded recovery limit
//   5. configuration boundary (no supported evidence route)
//   6. a contradicted check
//   7. documentary + on-chain evidence together
//   8. evidence-heavy professional view (with excluded material that must
//      never reach the first screen)
//
// Every value is INVENTED. No real project, token, address, page or
// quotation appears. The shapes are the production `ResearchJobDetail`
// exactly, so the same component that renders a real result renders these
// — the review is of the surface, never of a finding.

import type { ResearchJobDetail } from "./api";

export const RESULT_FIXTURE_NOTICE = {
  title: "Design fixture · not a real research result",
  body: "Every value below is invented to show how the result surface renders one research state. Nothing here was researched or verified.",
};

type Status = "SUPPORTED" | "PARTIALLY_SUPPORTED" | "INSUFFICIENT_EVIDENCE" | "CONTRADICTED";
type Coverage = "COMPLETED" | "PARTIAL" | "BLOCKED" | "NOT_ATTEMPTED";

interface ComponentSpec {
  component: string;
  step: number;
  status: Status;
  reasonCodes?: string[];
  coverage?: Coverage;
  // Admitted evidence for this component, in S5 order.
  supporting?: EvidenceSpec[];
  contradicting?: EvidenceSpec[];
  // Read and refused — never on the first screen, always in the audit.
  excluded?: (EvidenceSpec & { reason: string })[];
}

interface EvidenceSpec {
  id: string;
  kind: "DOCS" | "GOV" | "REPORT" | "DATA" | "MEDIA" | "SOCIAL" | "CHAIN";
  summary: string;
  fragment: string;
  doesNotProve?: string;
  publishedAt?: string | null;
  observedAt?: string | null;
  // The lifecycle state the excerpt itself states, when it states one.
  state?: string | null;
  cited?: boolean;
  quantity?: { amountRaw: string; decimals: number };
}

const STEP: Record<string, number> = {
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

const SOURCE: Record<EvidenceSpec["kind"], { url: (id: string) => string; sourceClass: string; title: string | null; publisher: string; sourceType: string }> = {
  DOCS: { url: (id) => `https://docs.fixture-protocol.example/tokenomics/${id}`, sourceClass: "OFFICIAL_DOCS", title: "Fixture Protocol documentation", publisher: "fixture-protocol.example", sourceType: "OFFICIAL_DOCS" },
  GOV: { url: (id) => `https://gov.fixture-protocol.example/proposals/${id}`, sourceClass: "GOVERNANCE", title: "Fixture governance proposal", publisher: "gov.fixture-protocol.example", sourceType: "GOVERNANCE" },
  REPORT: { url: (id) => `https://fixture-protocol.example/reports/${id}`, sourceClass: "OFFICIAL_REPORT", title: "Fixture treasury report", publisher: "fixture-protocol.example", sourceType: "OFFICIAL_REPORT" },
  DATA: { url: (id) => `https://data.fixture.example/protocol/fixture/${id}`, sourceClass: "DATA_PROVIDER", title: null, publisher: "data.fixture.example", sourceType: "DATA_PROVIDER" },
  MEDIA: { url: (id) => `https://news.fixture.example/articles/${id}`, sourceClass: "RESEARCH_MEDIA", title: "Fixture news article", publisher: "news.fixture.example", sourceType: "RESEARCH_MEDIA" },
  SOCIAL: { url: (id) => `https://social.fixture.example/posts/${id}`, sourceClass: "SOCIAL", title: null, publisher: "social.fixture.example", sourceType: "SOCIAL" },
  CHAIN: { url: () => "atlas-onchain://ethereum/mainnet/project/0xf1x7u2e000000000000000000000000000000000/token/", sourceClass: "ONCHAIN_VERIFIABLE", title: null, publisher: "ethereum", sourceType: "ONCHAIN" },
};

const FINISHED_AT = "2026-09-18T14:20:00.000Z";
const FETCHED_AT = "2026-09-18T14:05:00.000Z";

const QUESTION = "Does Fixture Protocol use its fee revenue to buy back FXT, and where do the bought-back tokens go?";

const FINDINGS = [
  { label: "Is Fixture Protocol currently buying back FXT with fee revenue?", patternStep: 5, component: "CURRENT_STATE", supportingComponents: ["SOURCE_OF_VALUE", "FLOW_PATH"] },
  { label: "Where do the bought-back FXT tokens go?", patternStep: 6, component: "DESTINATION", supportingComponents: ["RECIPIENT"] },
  { label: "What mechanism specifies the buyback?", patternStep: 3, component: "MECHANISM_SPEC", supportingComponents: ["GOVERNANCE_BASIS"] },
  { label: "Does the buyback reduce FXT supply?", patternStep: 7, component: "NET_EFFECT", supportingComponents: ["EXECUTION_EVIDENCE"] },
];

function build(opts: {
  id: string;
  verdict: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "INSUFFICIENT_EVIDENCE" | "NOT_SUPPORTED";
  band: "LOW" | "LIMITED" | "STRONG" | "VERY_STRONG";
  components: ComponentSpec[];
  technical?: { component: string; codes: string[]; remainingPaths?: { kind: string; count: number }[] }[];
  substantive?: { component: string; codes: string[] }[];
  findings?: typeof FINDINGS;
  boundaryRecord?: boolean;
}): ResearchJobDetail {
  const score = { LOW: 20, LIMITED: 40, STRONG: 60, VERY_STRONG: 80 }[opts.band];
  const evidence: ResearchJobDetail["evidence"] = [];
  const quantities: ResearchJobDetail["quantities"] = [];
  const citations: NonNullable<ResearchJobDetail["proof"]>["citations"] = [];
  const components: ResearchJobDetail["components"] = [];
  const snapshotIds: string[] = [];

  const push = (spec: EvidenceSpec, component: string, step: number, role: "SUPPORTING" | "CONTRADICTING" | "EXCLUDED", exclusionReason: string | null) => {
    const src = SOURCE[spec.kind];
    const existing = evidence.find((e) => e.id === spec.id);
    if (existing) {
      existing.links.push({ patternStep: step, component, role, exclusionReason });
      return;
    }
    const url = src.url(spec.id);
    evidence.push({
      id: spec.id,
      patternStep: step,
      component,
      relationship: role === "CONTRADICTING" ? "CONTRADICTS" : "SUPPORTS",
      directness: "DIRECT",
      fragment: spec.fragment,
      summary: spec.summary,
      doesNotProve: spec.doesNotProve ?? null,
      // Fixtures model what the engine writes today: a documentary caveat in
      // the v1 claim form carries its marker; a chain row's caveat is
      // code-written and is identified by its fact kind (never BURN here, so
      // no burn-only ceiling is implied).
      doesNotProveRuleVersion: spec.doesNotProve && spec.kind !== "CHAIN" ? 1 : null,
      onchainFactKind: spec.kind === "CHAIN" ? (spec.quantity ? "TOKEN_SUPPLY" : "SIGNATURES_FOR_ADDRESS") : null,
      mechanismState: spec.state ?? null,
      // Fixtures model what the engine writes today: dates produced under
      // the strict publication-date rule.
      publishedAtRuleVersion: 1,
      valueSource: null,
      sourceClass: src.sourceClass,
      officiality: spec.kind === "DOCS" || spec.kind === "GOV" || spec.kind === "REPORT" ? "CONFIRMED" : "CLAIMED",
      observedAt: spec.observedAt ?? null,
      dataAsOf: null,
      publishedAt: spec.publishedAt ?? null,
      retrievedUrl: url,
      fetchedAt: FETCHED_AT,
      sourceTitle: src.title,
      sourcePublisher: src.publisher,
      sourceType: src.sourceType,
      hasSnapshot: spec.kind !== "CHAIN",
      links: [{ patternStep: step, component, role, exclusionReason }],
    });
    if (spec.kind !== "CHAIN") snapshotIds.push(spec.id);
    if (spec.quantity) {
      quantities.push({ evidenceId: spec.id, observationId: `obs-${spec.id}`, factKind: "TOKEN_SUPPLY", step, component, mint: "0xf1x7u2e", decimals: spec.quantity.decimals, amountRaw: spec.quantity.amountRaw });
    }
    if (spec.cited && role !== "EXCLUDED") {
      citations.push({
        evidenceId: spec.id,
        patternStep: step,
        component,
        relationship: role === "CONTRADICTING" ? "CONTRADICTS" : "SUPPORTS",
        directness: "DIRECT",
        summary: spec.summary,
        fragment: spec.fragment,
        doesNotProve: spec.doesNotProve ?? null,
        mechanismState: spec.state ?? null,
        sourceClass: src.sourceClass,
        officiality: "CONFIRMED",
        entityBinding: "CONFIRMED",
        publishedAt: spec.publishedAt ?? null,
        retrievedUrl: url,
        fetchedAt: FETCHED_AT,
        source: { title: src.title, publisher: src.publisher, sourceType: src.sourceType },
      });
    }
  };

  for (const c of opts.components) {
    const step = c.step;
    for (const s of c.supporting ?? []) push(s, c.component, step, "SUPPORTING", null);
    for (const s of c.contradicting ?? []) push(s, c.component, step, "CONTRADICTING", null);
    for (const s of c.excluded ?? []) push(s, c.component, step, "EXCLUDED", s.reason);
    components.push({
      patternStep: step,
      component: c.component,
      status: c.status,
      reasonCodes: c.reasonCodes ?? [],
      supportingEvidenceIds: (c.supporting ?? []).map((s) => s.id),
      contradictingEvidenceIds: (c.contradicting ?? []).map((s) => s.id),
      excludedEvidence: (c.excluded ?? []).map((s) => ({ evidenceId: s.id, reason: s.reason })),
      coverage: c.coverage ?? "COMPLETED",
    });
  }

  const boundedBy = opts.boundaryRecord === false
    ? null
    : {
        version: 1,
        technical: (opts.technical ?? []).map((t) => ({ step: STEP[t.component] ?? 0, component: t.component, codes: t.codes, ...(t.remainingPaths ? { remainingPaths: t.remainingPaths } : {}) })),
        substantive: (opts.substantive ?? []).map((t) => ({ step: STEP[t.component] ?? 0, component: t.component, codes: t.codes })),
      };

  const claimStatus = opts.verdict === "NOT_SUPPORTED" ? "NOT_SUPPORTED" : opts.verdict;
  return {
    job: {
      id: `fixture-${opts.id}`,
      state: "SUCCEEDED",
      progressStage: 5,
      memoryStatus: "NOT_USED",
      acquisitionPhase: null,
      acquisitionPhaseAt: null,
      projectName: "Fixture Protocol",
      projectSlug: "fixture-protocol",
      projectTicker: "FXT",
      originalQuestion: QUESTION,
      terminationReason: "WORK_QUEUE_EXHAUSTED",
      errorCode: null,
      origin: "PRODUCT",
      createdAt: "2026-09-18T13:50:00.000Z",
      startedAt: "2026-09-18T13:50:10.000Z",
      finishedAt: FINISHED_AT,
    },
    proof: {
      proofId: `proof-${opts.id}`,
      researchJobId: `fixture-${opts.id}`,
      projectId: "project-fixture",
      topicId: "topic-fixture",
      verdict: opts.verdict,
      confidence: { band: opts.band, score },
      verificationStatus: "DRAFT",
      visibility: "PRIVATE",
      layers: { version: 1, layers: [] },
      citations,
      researchCutoff: null,
      createdAt: FINISHED_AT,
      boundedBy,
    },
    claimSupport: { intent: "PROTOCOL_REVENUE_TO_TOKEN", status: claimStatus, reasonCodes: [], requirementResults: [], contextGaps: [] },
    mechanism: null,
    execution: { attemptedSteps: 8, attemptedComponents: components.length, succeededComponents: components.length, establishedComponents: components.filter((c) => c.status === "SUPPORTED").length },
    finding: {
      componentKeys: components.map((c) => ({ step: c.patternStep, component: c.component })),
      supporting: evidence.filter((e) => e.links.some((l) => l.role === "SUPPORTING")),
      contradicting: evidence.filter((e) => e.links.some((l) => l.role === "CONTRADICTING")),
      excluded: evidence.filter((e) => e.links.some((l) => l.role === "EXCLUDED")).map((e) => ({ ...e, exclusionReason: e.links.find((l) => l.role === "EXCLUDED")?.exclusionReason ?? "CLASS_NOT_ADMISSIBLE" })),
    },
    questionFindings: opts.findings ?? FINDINGS,
    quantities,
    components,
    snapshotEvidenceIds: snapshotIds,
    evidence,
  };
}

/* ---------------------------- evidence ---------------------------- */

const DOC_REVENUE: EvidenceSpec = {
  id: "ev-docs-revenue",
  kind: "DOCS",
  summary: "Protocol fees from lending and swaps accrue to the Fixture treasury contract before any allocation.",
  fragment: "All protocol fees collected by the lending and swap modules are transferred to the Treasury contract at the end of each epoch.",
  doesNotProve: "the share of revenue allocated to buybacks",
  publishedAt: "2026-08-02T00:00:00.000Z",
  cited: true,
};
const DOC_MECHANISM: EvidenceSpec = {
  id: "ev-docs-mechanism",
  kind: "DOCS",
  summary: "The buyback module spends up to 30% of epoch revenue purchasing FXT on approved venues.",
  fragment: "The Buyback module may spend up to 30% of the epoch's collected fees to purchase FXT through approved on-chain venues.",
  doesNotProve: "that purchases have taken place",
  publishedAt: "2026-08-02T00:00:00.000Z",
  cited: true,
};
const GOV_APPROVAL: EvidenceSpec = {
  id: "ev-gov-approval",
  kind: "GOV",
  summary: "Proposal FP-41 approving the buyback module passed with 82% of votes in favour.",
  fragment: "FP-41: Activate the Buyback module at 30% of epoch revenue. Result: Passed (82% for, 18% against).",
  doesNotProve: "that the module was switched on after the vote",
  publishedAt: "2026-07-21T00:00:00.000Z",
};
const DOC_ACTIVE: EvidenceSpec = {
  id: "ev-docs-active",
  kind: "DOCS",
  summary: "The buyback module is listed as active on the protocol's current modules page.",
  fragment: "Active modules: Lending v3, Swap v2, Buyback (since epoch 118).",
  doesNotProve: "a purchase transaction",
  publishedAt: "2026-09-10T00:00:00.000Z",
  // "listed as active" — the excerpt states the mechanism is live.
  state: "LIVE",
  cited: true,
};
const CHAIN_SUPPLY: EvidenceSpec = {
  id: "ev-chain-supply",
  kind: "CHAIN",
  summary: "On-chain total supply of the FXT token is 100,000,000 at the finalized block.",
  fragment: '{"kind":"TOKEN_SUPPLY","mint":"0xf1x7u2e","decimals":18,"amountRaw":"100000000000000000000000000"}',
  doesNotProve: "does not establish whether any buyback reduced total supply",
  observedAt: "2026-09-18T14:03:00.000Z",
  quantity: { amountRaw: "100000000000000000000000000", decimals: 18 },
};
const CHAIN_BURN: EvidenceSpec = {
  id: "ev-chain-burn",
  kind: "CHAIN",
  summary: "A burn of 250,000 FXT from the buyback module's account was recorded at the finalized block.",
  fragment: '{"kind":"BURN","amountRaw":"250000000000000000000000"}',
  doesNotProve: "does not establish that total supply is lower overall",
  observedAt: "2026-09-17T09:12:00.000Z",
};
const CHAIN_SUPPLY_ROSE: EvidenceSpec = {
  id: "ev-chain-supply-rose",
  kind: "CHAIN",
  summary: "Total FXT supply was higher at the end of the measured interval than at its start.",
  fragment: '{"kind":"TOTAL_SUPPLY_DELTA","amountRaw":"+1200000000000000000000000"}',
  doesNotProve: "does not rule out burns offset by issuance",
  observedAt: "2026-09-18T14:03:00.000Z",
};
const DOC_DESTINATION: EvidenceSpec = {
  id: "ev-docs-destination",
  kind: "DOCS",
  summary: "Purchased FXT is transferred to the Ecosystem Reserve and held there.",
  fragment: "Tokens purchased by the Buyback module are sent to the Ecosystem Reserve (0x…) and are not burned.",
  doesNotProve: "does not show a transfer occurring",
  publishedAt: "2026-08-02T00:00:00.000Z",
  cited: true,
};
const REPORT_RECIPIENT: EvidenceSpec = {
  id: "ev-report-recipient",
  kind: "REPORT",
  summary: "The Q2 treasury report lists the Ecosystem Reserve as holding 1.4M FXT acquired through buybacks.",
  fragment: "Ecosystem Reserve holdings: 1,400,000 FXT (acquired via Buyback module, epochs 118–130).",
  doesNotProve: "independent confirmation of the reported figures",
  publishedAt: "2026-07-30T00:00:00.000Z",
};
const MEDIA_EXECUTION: EvidenceSpec = {
  id: "ev-media-execution",
  kind: "MEDIA",
  summary: "A news article reports weekly FXT purchases by the buyback module.",
  fragment: "Fixture's buyback module has been purchasing roughly 90,000 FXT a week since August, according to a dashboard maintained by the team.",
  publishedAt: "2026-09-01T00:00:00.000Z",
};
const SOCIAL_CLAIM: EvidenceSpec = {
  id: "ev-social-claim",
  kind: "SOCIAL",
  summary: "A public post claims the buyback burns every token it purchases.",
  fragment: "Every FXT the module buys gets burned. Supply only goes down from here.",
  publishedAt: "2026-09-05T00:00:00.000Z",
};
const DATA_TREASURY: EvidenceSpec = {
  id: "ev-data-treasury",
  kind: "DATA",
  summary: "A data provider lists the Fixture treasury as holding 2.1M FXT.",
  fragment: "Treasury: 2,100,000 FXT · 12,300,000 USDC",
  publishedAt: null,
};

/* ---------------------------- fixtures ---------------------------- */

const ok = (component: string, supporting: EvidenceSpec[], extra: Partial<ComponentSpec> = {}): ComponentSpec => ({
  component,
  step: STEP[component],
  status: "SUPPORTED",
  supporting,
  ...extra,
});
const partial = (component: string, supporting: EvidenceSpec[], reasonCodes: string[]): ComponentSpec => ({
  component,
  step: STEP[component],
  status: "PARTIALLY_SUPPORTED",
  reasonCodes,
  supporting,
});
const gap = (component: string, reasonCodes: string[], extra: Partial<ComponentSpec> = {}): ComponentSpec => ({
  component,
  step: STEP[component],
  status: "INSUFFICIENT_EVIDENCE",
  reasonCodes,
  ...extra,
});

export interface ResultFixture {
  key: string;
  title: string;
  // What the state proves about the surface — shown on the dev page only.
  note: string;
  detail: ResearchJobDetail;
}

export const RESULT_FIXTURES: ResultFixture[] = [
  {
    key: "1",
    title: "Mostly confirmed",
    note: "Every check on the path confirmed except the supply effect, which is partially confirmed. No boundary section.",
    detail: build({
      id: "mostly-confirmed",
      verdict: "SUPPORTED",
      band: "STRONG",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE]),
        ok("FLOW_PATH", [DOC_MECHANISM]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM]),
        ok("GOVERNANCE_BASIS", [GOV_APPROVAL]),
        ok("CURRENT_STATE", [DOC_ACTIVE, CHAIN_SUPPLY]),
        ok("EXECUTION_EVIDENCE", [CHAIN_BURN]),
        ok("DESTINATION", [DOC_DESTINATION]),
        ok("RECIPIENT", [REPORT_RECIPIENT]),
        partial("NET_EFFECT", [CHAIN_BURN, CHAIN_SUPPLY], ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]),
      ],
      substantive: [{ component: "NET_EFFECT", codes: ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"] }],
    }),
  },
  {
    key: "2",
    title: "Mixed confirmed / partially confirmed",
    note: "Documentation confirms the mechanism; execution and destination are only partially confirmed by weaker sources.",
    detail: build({
      id: "mixed",
      verdict: "PARTIALLY_SUPPORTED",
      band: "LIMITED",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE]),
        ok("FLOW_PATH", [DOC_MECHANISM]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM]),
        partial("GOVERNANCE_BASIS", [GOV_APPROVAL], ["APPROVAL_NOT_ESTABLISHED"]),
        partial("CURRENT_STATE", [DOC_ACTIVE], ["INSUFFICIENT_AUTHORITY"]),
        partial("EXECUTION_EVIDENCE", [MEDIA_EXECUTION], ["INSUFFICIENT_AUTHORITY"]),
        partial("DESTINATION", [DOC_DESTINATION], ["INDIRECT_ONLY"]),
        partial("RECIPIENT", [REPORT_RECIPIENT], ["INSUFFICIENT_AUTHORITY"]),
        partial("NET_EFFECT", [CHAIN_SUPPLY], ["SUPPLY_REDUCTION_NOT_ESTABLISHED"]),
      ],
      substantive: [
        { component: "GOVERNANCE_BASIS", codes: ["APPROVAL_NOT_ESTABLISHED"] },
        { component: "CURRENT_STATE", codes: ["INSUFFICIENT_AUTHORITY"] },
        { component: "EXECUTION_EVIDENCE", codes: ["INSUFFICIENT_AUTHORITY"] },
        { component: "DESTINATION", codes: ["INDIRECT_ONLY"] },
        { component: "RECIPIENT", codes: ["INSUFFICIENT_AUTHORITY"] },
        { component: "NET_EFFECT", codes: ["SUPPLY_REDUCTION_NOT_ESTABLISHED"] },
      ],
    }),
  },
  {
    key: "3",
    title: "Genuine substantive not-established",
    note: "The mechanism is documented, but destination, recipient and execution were checked against the available sources and not found. Substantive boundary only.",
    detail: build({
      id: "substantive",
      verdict: "INSUFFICIENT_EVIDENCE",
      band: "LOW",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE]),
        ok("FLOW_PATH", [DOC_MECHANISM]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM]),
        ok("GOVERNANCE_BASIS", [GOV_APPROVAL]),
        gap("CURRENT_STATE", ["MISSING_CURRENT_STATE"]),
        gap("EXECUTION_EVIDENCE", ["MISSING_EXECUTION_EVIDENCE"], { excluded: [{ ...SOCIAL_CLAIM, reason: "CLASS_NOT_ADMISSIBLE" }] }),
        gap("DESTINATION", ["NO_EVIDENCE_FOUND"]),
        gap("RECIPIENT", ["NO_EVIDENCE_FOUND"]),
        gap("NET_EFFECT", ["NO_EVIDENCE_FOUND"]),
      ],
      substantive: [
        { component: "CURRENT_STATE", codes: ["MISSING_CURRENT_STATE"] },
        { component: "EXECUTION_EVIDENCE", codes: ["MISSING_EXECUTION_EVIDENCE"] },
        { component: "DESTINATION", codes: ["NO_EVIDENCE_FOUND"] },
        { component: "RECIPIENT", codes: ["NO_EVIDENCE_FOUND"] },
        { component: "NET_EFFECT", codes: ["NO_EVIDENCE_FOUND"] },
      ],
    }),
  },
  {
    key: "4",
    title: "Technical bounded recovery limit",
    note: "The current state closed on stale evidence with four known official pages left unread after the bounded second look; destination stopped at the search limit. Both must read as a research limit, never as absence.",
    detail: build({
      id: "technical",
      verdict: "PARTIALLY_SUPPORTED",
      band: "LOW",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE]),
        ok("FLOW_PATH", [DOC_MECHANISM]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM]),
        ok("GOVERNANCE_BASIS", [GOV_APPROVAL]),
        gap("CURRENT_STATE", ["STALE_CURRENT_STATE"], { excluded: [{ ...DOC_ACTIVE, id: "ev-docs-active-stale", publishedAt: "2025-03-01T00:00:00.000Z", reason: "STALE_FOR_CURRENT_STATE" }] }),
        gap("EXECUTION_EVIDENCE", ["MISSING_EXECUTION_EVIDENCE"]),
        gap("DESTINATION", ["SEARCH_BUDGET_EXHAUSTED"], { coverage: "BLOCKED" }),
        gap("RECIPIENT", ["SEARCH_BUDGET_EXHAUSTED"], { coverage: "BLOCKED" }),
        partial("NET_EFFECT", [CHAIN_SUPPLY], ["SUPPLY_REDUCTION_NOT_ESTABLISHED"]),
      ],
      technical: [
        { component: "CURRENT_STATE", codes: ["RECOVERY_BOUND_REACHED"], remainingPaths: [{ kind: "SEALED_UNEXTRACTED", count: 4 }] },
        { component: "DESTINATION", codes: ["SEARCH_BUDGET_EXHAUSTED"] },
        { component: "RECIPIENT", codes: ["SEARCH_BUDGET_EXHAUSTED"] },
      ],
      substantive: [
        { component: "CURRENT_STATE", codes: ["STALE_CURRENT_STATE"] },
        { component: "EXECUTION_EVIDENCE", codes: ["MISSING_EXECUTION_EVIDENCE"] },
        { component: "NET_EFFECT", codes: ["SUPPLY_REDUCTION_NOT_ESTABLISHED"] },
      ],
    }),
  },
  {
    key: "5",
    title: "Configuration boundary (no supported evidence route)",
    note: "Execution can only be established through routes ATLAS does not yet have for this project. Must never read as 'the mechanism is not executing'.",
    detail: build({
      id: "configuration",
      verdict: "PARTIALLY_SUPPORTED",
      band: "LIMITED",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE]),
        ok("FLOW_PATH", [DOC_MECHANISM]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM]),
        ok("GOVERNANCE_BASIS", [GOV_APPROVAL]),
        ok("CURRENT_STATE", [DOC_ACTIVE]),
        gap("EXECUTION_EVIDENCE", ["NO_ADMISSIBLE_ROUTE"]),
        ok("DESTINATION", [DOC_DESTINATION]),
        partial("RECIPIENT", [REPORT_RECIPIENT], ["INSUFFICIENT_AUTHORITY"]),
        gap("NET_EFFECT", ["NO_ADMISSIBLE_ROUTE"]),
      ],
      technical: [
        { component: "EXECUTION_EVIDENCE", codes: ["NO_ADMISSIBLE_ROUTE"] },
        { component: "NET_EFFECT", codes: ["NO_ADMISSIBLE_ROUTE"] },
      ],
      substantive: [{ component: "RECIPIENT", codes: ["INSUFFICIENT_AUTHORITY"] }],
    }),
  },
  {
    key: "6",
    title: "A contradicted check",
    note: "Burns are confirmed, but the measured total supply rose over the interval: the net reduction is contradicted, and the contradiction leads the key evidence.",
    detail: build({
      id: "contradicted",
      verdict: "PARTIALLY_SUPPORTED",
      band: "LIMITED",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE]),
        ok("FLOW_PATH", [DOC_MECHANISM]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM]),
        ok("GOVERNANCE_BASIS", [GOV_APPROVAL]),
        ok("CURRENT_STATE", [DOC_ACTIVE]),
        ok("EXECUTION_EVIDENCE", [CHAIN_BURN]),
        ok("DESTINATION", [DOC_DESTINATION]),
        ok("RECIPIENT", [REPORT_RECIPIENT]),
        { component: "NET_EFFECT", step: 7, status: "CONTRADICTED", reasonCodes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"], supporting: [CHAIN_BURN], contradicting: [CHAIN_SUPPLY_ROSE] },
      ],
      substantive: [{ component: "NET_EFFECT", codes: ["NET_SUPPLY_NOT_REDUCED_OVER_INTERVAL"] }],
    }),
  },
  {
    key: "7",
    title: "Documentary + on-chain evidence together",
    note: "The current state rests on the project's own documentation and an on-chain supply reading; the reading is translated for a reader, never shown raw.",
    detail: build({
      id: "documentary-onchain",
      verdict: "SUPPORTED",
      band: "STRONG",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE]),
        ok("FLOW_PATH", [DOC_MECHANISM]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM]),
        ok("GOVERNANCE_BASIS", [GOV_APPROVAL]),
        ok("CURRENT_STATE", [CHAIN_SUPPLY, DOC_ACTIVE]),
        ok("EXECUTION_EVIDENCE", [CHAIN_BURN]),
        ok("DESTINATION", [DOC_DESTINATION]),
        partial("NET_EFFECT", [CHAIN_BURN, CHAIN_SUPPLY], ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]),
      ],
      substantive: [{ component: "NET_EFFECT", codes: ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"] }],
    }),
  },
  {
    key: "8",
    title: "Evidence-heavy professional view",
    note: "Many sources per check, several read and refused. The refused material is in the full audit and never on the first screen.",
    detail: build({
      id: "evidence-heavy",
      verdict: "PARTIALLY_SUPPORTED",
      band: "LIMITED",
      components: [
        ok("SOURCE_OF_VALUE", [DOC_REVENUE, { ...DATA_TREASURY, id: "ev-data-revenue", summary: "A data provider reports 30-day protocol revenue of 4.2M USDC.", fragment: "30d revenue: 4,200,000 USDC" }], {
          excluded: [{ ...SOCIAL_CLAIM, id: "ev-social-revenue", reason: "CLASS_NOT_ADMISSIBLE" }],
        }),
        ok("FLOW_PATH", [DOC_MECHANISM, { ...MEDIA_EXECUTION, id: "ev-media-flow", summary: "Reporting describes the fee split between the treasury and the buyback module." }]),
        ok("MECHANISM_SPEC", [DOC_MECHANISM, GOV_APPROVAL], {
          excluded: [{ ...MEDIA_EXECUTION, id: "ev-media-mech-dup", summary: "A syndicated copy of the same article restates the buyback share.", fragment: "Syndicated: Fixture's buyback module spends 30% of fees on FXT purchases, the team's dashboard shows.", reason: "DUPLICATE_UNIT" }],
        }),
        ok("GOVERNANCE_BASIS", [GOV_APPROVAL, { ...GOV_APPROVAL, id: "ev-gov-followup", summary: "A follow-up proposal FP-47 raised the buyback share to 35%.", fragment: "FP-47: Raise the Buyback share to 35%. Result: Passed.", publishedAt: "2026-08-25T00:00:00.000Z" }]),
        partial("CURRENT_STATE", [DOC_ACTIVE, CHAIN_SUPPLY, MEDIA_EXECUTION], ["INSUFFICIENT_AUTHORITY"]),
        partial("EXECUTION_EVIDENCE", [CHAIN_BURN, MEDIA_EXECUTION], ["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"]),
        ok("DESTINATION", [DOC_DESTINATION, REPORT_RECIPIENT, DATA_TREASURY], { excluded: [{ ...SOCIAL_CLAIM, reason: "RELATIONSHIP_NOT_SUPPORTING" }] }),
        ok("RECIPIENT", [REPORT_RECIPIENT, DATA_TREASURY]),
        partial("NET_EFFECT", [CHAIN_BURN, CHAIN_SUPPLY], ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"]),
        ok("DURABILITY_BASIS", [{ ...GOV_APPROVAL, id: "ev-gov-durability", summary: "The buyback module can be halted only by a governance vote.", fragment: "The Buyback module runs each epoch unless a governance vote halts it." }]),
      ],
      substantive: [
        { component: "CURRENT_STATE", codes: ["INSUFFICIENT_AUTHORITY"] },
        { component: "EXECUTION_EVIDENCE", codes: ["MECHANICAL_PROVENANCE_NOT_ESTABLISHED"] },
        { component: "NET_EFFECT", codes: ["NET_SUPPLY_CHANGE_NOT_ESTABLISHED"] },
      ],
    }),
  },
];

export function resultFixture(key: string | undefined): ResultFixture {
  return RESULT_FIXTURES.find((f) => f.key === key) ?? RESULT_FIXTURES[0];
}
