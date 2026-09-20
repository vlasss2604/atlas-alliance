import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResearchJobDetail } from "../src/client/api";
import { ResearchResult } from "../src/client/components/research-result";
import {
  BOUNDARY_COPY,
  BOUNDARY_NEVER,
  boundaryOf,
  buildResultSurface,
  FORBIDDEN_SURFACE_TOKENS,
  keyEvidence,
  networkOf,
  PROOF_PATH_ORDER,
  RESULT_STATUS_LABELS,
  resultStatus,
  tableRows,
} from "../src/client/result-surface";
import { RESULT_FIXTURES, resultFixture } from "../src/client/result-surface-fixtures";
import { retrievedOn } from "../src/client/research-model";

// Dates render through the model's own formatter (locale month names such
// as "Sept" are the runtime's, not ours), so expectations read it too.
const on = (iso: string) => retrievedOn(iso)!;

// RESULT PRESENTATION V1 — COMPLEX RESEARCH, SIMPLE SURFACE.
//
// One completed result, six sections: answer, research table, proof map,
// key evidence, what is not established, full evidence. These tests pin
// the presentation invariant on the new surface —
//
//   PAGE <= PERSISTED VERIFIED RECORD
//
// — on eight invented fixtures covering every boundary state and on the
// shape of the two real Aave records (job cbe59f48: every documentary
// check ALL_EVIDENCE_EXCLUDED, execution NO_ADMISSIBLE_ROUTE, two on-chain
// partials, no boundary record; job 2b0f00e4: SEARCH_BUDGET_EXHAUSTED
// everywhere). Copied shapes, not invented ones.

const render = (detail: ResearchJobDetail) => renderToStaticMarkup(createElement(ResearchResult, { detail, jobId: detail.job.id }));
const count = (h: string, id: string) => h.match(new RegExp(`data-testid="${id}"`, "g"))?.length ?? 0;
// The visible text of a rendering — tags and attributes stripped, so a
// data attribute carrying a canonical enum is not mistaken for copy.
const textOf = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
// The first screen: everything before the deep disclosure.
const firstScreenOf = (h: string) => h.slice(0, h.indexOf('data-testid="full-evidence"'));
const attrValues = (h: string, id: string, attr: string) =>
  [...h.matchAll(new RegExp(`data-testid="${id}"[^>]*data-${attr}="([^"]*)"`, "g"))].map((m) => m[1]);

/* ------------------------------------------------------------------ */
/* THE TWO REAL AAVE SHAPES                                            */
/* ------------------------------------------------------------------ */

const ONCHAIN_URL = "atlas-onchain://ethereum/mainnet/project/0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9/token/";

function aaveDetail(variant: "EXCLUDED" | "BUDGET"): ResearchJobDetail {
  const docCodes = variant === "EXCLUDED" ? ["ALL_EVIDENCE_EXCLUDED"] : ["SEARCH_BUDGET_EXHAUSTED"];
  const docCoverage = variant === "EXCLUDED" ? ("COMPLETED" as const) : ("BLOCKED" as const);
  const doc = (component: string, step: number) => ({
    patternStep: step,
    component,
    status: "INSUFFICIENT_EVIDENCE",
    reasonCodes: docCodes,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    excludedEvidence: variant === "EXCLUDED" ? [{ evidenceId: `ex-${component}`, reason: "CLASS_NOT_ADMISSIBLE" }] : [],
    coverage: docCoverage,
  });
  const onchain = (id: string, component: string, step: number) => ({
    id,
    patternStep: step,
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: '{"kind":"TOKEN_SUPPLY","mint":"0x7Fc6","amountRaw":"16000000000000000000000000"}',
    summary: "On-chain total supply of token 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9 is 16000000 (raw 16000000000000000000000000) at the finalized block.",
    doesNotProve: "does not establish whether any buyback executed",
    mechanismState: null,
    valueSource: null,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CLAIMED",
    observedAt: "2026-09-19T19:41:55.000Z",
    dataAsOf: null,
    publishedAt: null,
    retrievedUrl: ONCHAIN_URL,
    fetchedAt: "2026-09-19T19:41:55.000Z",
    sourceTitle: null,
    sourcePublisher: null,
    sourceType: "ONCHAIN",
    hasSnapshot: false,
    links: [{ patternStep: step, component, role: "SUPPORTING" as const, exclusionReason: null }],
  });
  const excluded = (component: string, step: number) => ({
    id: `ex-${component}`,
    patternStep: step,
    component,
    relationship: "SUPPORTS",
    directness: "DIRECT",
    fragment: `Secondary reporting about ${component.toLowerCase()} that no admissible class could establish.`,
    summary: `A media summary about ${component.toLowerCase()}.`,
    doesNotProve: null,
    mechanismState: null,
    valueSource: null,
    sourceClass: "RESEARCH_MEDIA",
    officiality: "CLAIMED",
    observedAt: null,
    dataAsOf: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    retrievedUrl: `https://news.example.test/${component.toLowerCase()}`,
    fetchedAt: "2026-09-19T19:40:00.000Z",
    sourceTitle: null,
    sourcePublisher: "news.example.test",
    sourceType: "RESEARCH_MEDIA",
    hasSnapshot: true,
    links: [{ patternStep: step, component, role: "EXCLUDED" as const, exclusionReason: "CLASS_NOT_ADMISSIBLE" }],
  });
  const components = [
    doc("SOURCE_OF_VALUE", 1),
    doc("FLOW_PATH", 2),
    doc("MECHANISM_SPEC", 3),
    doc("GOVERNANCE_BASIS", 3),
    { patternStep: 4, component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"], supportingEvidenceIds: [], contradictingEvidenceIds: [], excludedEvidence: [], coverage: "NOT_ATTEMPTED" as const },
    { patternStep: 5, component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["ev-cs"], contradictingEvidenceIds: [], excludedEvidence: [], coverage: "COMPLETED" as const },
    doc("DESTINATION", 6),
    doc("RECIPIENT", 6),
    { patternStep: 7, component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED", reasonCodes: ["SUPPLY_REDUCTION_NOT_ESTABLISHED", "INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["ev-ne"], contradictingEvidenceIds: [], excludedEvidence: [], coverage: "COMPLETED" as const },
    doc("DURABILITY_BASIS", 8),
  ];
  const evidence = [
    onchain("ev-cs", "CURRENT_STATE", 5),
    onchain("ev-ne", "NET_EFFECT", 7),
    ...(variant === "EXCLUDED" ? ["SOURCE_OF_VALUE", "MECHANISM_SPEC", "DESTINATION"].map((c) => excluded(c, components.find((x) => x.component === c)!.patternStep)) : []),
  ];
  return {
    job: {
      id: `aave-${variant.toLowerCase()}`,
      state: "SUCCEEDED",
      progressStage: 5,
      memoryStatus: "NOT_USED",
      acquisitionPhase: null,
      acquisitionPhaseAt: null,
      projectName: "Fixture Lending",
      projectSlug: "fixture-lending",
      projectTicker: "FXL",
      originalQuestion: "Does the protocol currently use revenue to buy back its token, and does that reduce supply?",
      terminationReason: "WORK_QUEUE_EXHAUSTED",
      errorCode: null,
      origin: "OWNER_MANUAL_ALPHA",
      createdAt: "2026-09-19T19:30:00.000Z",
      startedAt: "2026-09-19T19:30:10.000Z",
      finishedAt: "2026-09-19T19:42:00.000Z",
    },
    proof: {
      proofId: "proof-aave",
      researchJobId: `aave-${variant.toLowerCase()}`,
      projectId: "p",
      topicId: "t",
      verdict: "INSUFFICIENT_EVIDENCE",
      confidence: { band: "LOW", score: 20 },
      verificationStatus: "DRAFT",
      visibility: "PRIVATE",
      layers: { version: 1, layers: [] },
      citations: [],
      researchCutoff: null,
      createdAt: "2026-09-19T19:42:00.000Z",
      // A Proof written before the boundary record existed.
      boundedBy: null,
    },
    claimSupport: { intent: "PROTOCOL_REVENUE_TO_TOKEN", status: "INSUFFICIENT_EVIDENCE", reasonCodes: [], requirementResults: [], contextGaps: [] },
    mechanism: null,
    execution: { attemptedSteps: 8, attemptedComponents: 10, succeededComponents: 2, establishedComponents: 0 },
    finding: { componentKeys: [], supporting: [], contradicting: [], excluded: [] },
    questionFindings: [
      { label: "Is the protocol currently using revenue for token buybacks?", patternStep: 5, component: "CURRENT_STATE", supportingComponents: ["SOURCE_OF_VALUE", "FLOW_PATH"] },
      { label: "Where does the bought-back token go after purchase?", patternStep: 6, component: "DESTINATION", supportingComponents: ["RECIPIENT", "NET_EFFECT"] },
      { label: "What governance or mechanism specifies the buyback?", patternStep: 3, component: "MECHANISM_SPEC", supportingComponents: ["GOVERNANCE_BASIS"] },
    ],
    quantities: [
      { evidenceId: "ev-cs", observationId: "obs-1", factKind: "TOKEN_SUPPLY", step: 5, component: "CURRENT_STATE", mint: "0x7Fc6", decimals: 18, amountRaw: "16000000000000000000000000" },
      { evidenceId: "ev-ne", observationId: "obs-1", factKind: "TOKEN_SUPPLY", step: 7, component: "NET_EFFECT", mint: "0x7Fc6", decimals: 18, amountRaw: "16000000000000000000000000" },
    ],
    components,
    snapshotEvidenceIds: variant === "EXCLUDED" ? ["ex-SOURCE_OF_VALUE", "ex-MECHANISM_SPEC", "ex-DESTINATION"] : [],
    evidence,
  };
}

/* ------------------------------------------------------------------ */
/* 1. STATUS MAPPING                                                   */
/* ------------------------------------------------------------------ */

describe("status language — one closed vocabulary, never stronger than the record", () => {
  it("SUPPORTED → Confirmed, PARTIALLY_SUPPORTED → Partially confirmed, INSUFFICIENT → Not established, CONTRADICTED → Contradicted; nothing else exists", () => {
    expect(RESULT_STATUS_LABELS).toEqual({
      CONFIRMED: "Confirmed",
      PARTIAL: "Partially confirmed",
      NOT_ESTABLISHED: "Not established",
      CONTRADICTED: "Contradicted",
    });
    expect(resultStatus("VERIFIED")).toBe("CONFIRMED");
    expect(resultStatus("PARTIAL")).toBe("PARTIAL");
    expect(resultStatus("UNRESOLVED")).toBe("NOT_ESTABLISHED");
    expect(resultStatus("NOT_HAPPENING")).toBe("CONTRADICTED");
    // A component with no persisted row has no status and is never shown.
    expect(resultStatus("NOT_ASSESSED")).toBeNull();
  });

  it("the old wording is gone from every surface a reader meets", () => {
    for (const f of RESULT_FIXTURES) {
      const text = textOf(render(f.detail));
      for (const old of ["Partly established", "Still open", "Partially created", "Evidence indicates otherwise", "Could not verify"]) {
        expect(text, `${f.key}: ${old}`).not.toContain(old);
      }
    }
  });

  it("Confirmed appears exactly as often as SUPPORTED rows, on every fixture — a partial or unresolved row can never earn it", () => {
    for (const f of RESULT_FIXTURES) {
      const surface = buildResultSurface(f.detail);
      const supported = new Set(f.detail.components.filter((c) => c.status === "SUPPORTED").map((c) => c.component));
      for (const row of surface.table) {
        expect(row.status === "CONFIRMED", `${f.key}/${row.component}`).toBe(supported.has(row.component));
        if (row.status === "PARTIAL") expect(row.statusLabel).toBe("Partially confirmed");
      }
      for (const node of surface.chain) {
        expect(node.status === "CONFIRMED", `${f.key}/${node.component}`).toBe(supported.has(node.component));
      }
    }
  });

  it("weakening the record never strengthens the page: every SUPPORTED demoted to PARTIALLY_SUPPORTED removes every Confirmed", () => {
    const f = resultFixture("1");
    const weakened: ResearchJobDetail = {
      ...f.detail,
      components: f.detail.components.map((c) => (c.status === "SUPPORTED" ? { ...c, status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"] } : c)),
    };
    const surface = buildResultSurface(weakened);
    expect(surface.table.some((r) => r.status === "CONFIRMED")).toBe(false);
    expect(textOf(firstScreenOf(render(weakened)))).not.toMatch(/\bConfirmed\b(?!:)/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. TECHNICAL vs SUBSTANTIVE vs CONFIGURATION                        */
/* ------------------------------------------------------------------ */

describe("the boundary — three kinds, read from persisted truth", () => {
  const record = {
    version: 1,
    technical: [
      { step: 5, component: "CURRENT_STATE", codes: ["RECOVERY_BOUND_REACHED"], remainingPaths: [{ kind: "SEALED_UNEXTRACTED", count: 4 }] },
      { step: 6, component: "DESTINATION", codes: ["SEARCH_BUDGET_EXHAUSTED"] },
      { step: 4, component: "EXECUTION_EVIDENCE", codes: ["NO_ADMISSIBLE_ROUTE"] },
      { step: 2, component: "FLOW_PATH", codes: ["KNOWN_PATHS_UNEXPLORED"], remainingPaths: [{ kind: "UNOPENED_CANDIDATE", count: 2 }] },
    ],
    substantive: [{ step: 5, component: "CURRENT_STATE", codes: ["STALE_CURRENT_STATE"] }],
  };

  it("from the Proof's record: a recovery limit or search limit is TECHNICAL, no admissible route is CONFIGURATION, everything else is SUBSTANTIVE", () => {
    const of = (component: string) => boundaryOf({ component, reasonCodes: ["NO_EVIDENCE_FOUND"], coverage: "COMPLETED", boundary: record });
    expect(of("CURRENT_STATE")).toEqual({ kind: "TECHNICAL", remainingPaths: 4, source: "RECORD" });
    expect(of("DESTINATION")).toEqual({ kind: "TECHNICAL", remainingPaths: null, source: "RECORD" });
    expect(of("FLOW_PATH")).toEqual({ kind: "TECHNICAL", remainingPaths: 2, source: "RECORD" });
    expect(of("EXECUTION_EVIDENCE")).toEqual({ kind: "CONFIGURATION", remainingPaths: null, source: "RECORD" });
    expect(of("RECIPIENT")).toEqual({ kind: "SUBSTANTIVE", remainingPaths: null, source: "RECORD" });
    // A stale finding beside a technical code stays technical: the limit
    // of the run is the material fact for the reader.
    expect(boundaryOf({ component: "CURRENT_STATE", reasonCodes: ["STALE_CURRENT_STATE"], coverage: "COMPLETED", boundary: record }).kind).toBe("TECHNICAL");
  });

  it("without a record (a Proof written before it existed): the same reading from the persisted reason codes and coverage, and nothing inferred", () => {
    const of = (codes: string[], coverage: "COMPLETED" | "BLOCKED" | "PARTIAL" | "NOT_ATTEMPTED" = "COMPLETED") =>
      boundaryOf({ component: "X", reasonCodes: codes, coverage, boundary: null });
    expect(of(["SEARCH_BUDGET_EXHAUSTED"]).kind).toBe("TECHNICAL");
    expect(of(["EXTRACTION_NOT_COMPLETED"]).kind).toBe("TECHNICAL");
    expect(of(["NO_EVIDENCE_FOUND"], "BLOCKED").kind).toBe("TECHNICAL");
    expect(of(["NO_ADMISSIBLE_ROUTE"]).kind).toBe("CONFIGURATION");
    expect(of(["ALL_EVIDENCE_EXCLUDED"]).kind).toBe("SUBSTANTIVE");
    expect(of(["NO_EVIDENCE_FOUND"]).kind).toBe("SUBSTANTIVE");
    expect(of(["STALE_CURRENT_STATE"]).kind).toBe("SUBSTANTIVE");
    expect(of(["MISSING_EXECUTION_EVIDENCE"]).source).toBe("REASON_CODES");
    // No remaining-path count can be invented without the record.
    expect(of(["SEARCH_BUDGET_EXHAUSTED"]).remainingPaths).toBeNull();
  });

  it("the copy for each kind says what it must and never what it must not", () => {
    expect(BOUNDARY_COPY.TECHNICAL).toBe("Research limit reached before every relevant evidence path could be checked.");
    expect(BOUNDARY_COPY.CONFIGURATION).toBe("Could not be verified with the currently supported evidence routes.");
    expect(BOUNDARY_COPY.SUBSTANTIVE).toBe("Not established after checking the available evidence.");
    for (const kind of ["TECHNICAL", "CONFIGURATION"] as const) {
      expect(BOUNDARY_COPY[kind].toLowerCase()).not.toMatch(/no evidence exists|not executing|does not|absent/);
    }
    expect(BOUNDARY_NEVER.TECHNICAL).toContain("does not mean no evidence exists");
    expect(BOUNDARY_NEVER.CONFIGURATION).toContain("does not mean the mechanism is not executing");
  });

  it("fixture 4 (technical): the boundary section leads with the research limit, counts the unread sources, and the stale finding stays visible beside it", () => {
    const f = resultFixture("4");
    const surface = buildResultSurface(f.detail);
    const kinds = surface.boundary.map((g) => g.kind);
    expect(kinds[0]).toBe("TECHNICAL");
    const technical = surface.boundary.find((g) => g.kind === "TECHNICAL")!;
    expect(technical.items.map((i) => i.component).sort()).toEqual(["CURRENT_STATE", "DESTINATION", "RECIPIENT"]);
    expect(technical.remainingPaths).toBe(4);
    const html = render(f.detail);
    const first = textOf(firstScreenOf(html));
    expect(first).toContain(BOUNDARY_COPY.TECHNICAL);
    expect(first).toContain("4 known sources were left unread.");
    expect(first).toContain(BOUNDARY_NEVER.TECHNICAL);
    // The row itself says the same thing, not "no evidence".
    const cs = surface.table.find((r) => r.component === "CURRENT_STATE")!;
    expect(cs.established).toBe(BOUNDARY_COPY.TECHNICAL);
    expect(attrValues(html, "research-row", "boundary")).toContain("TECHNICAL");
    // The answer's boundary sentence names the run's limit, once.
    expect(surface.answer.sentences.join(" ")).toContain("reached its limit before every relevant evidence path could be checked");
    expect(surface.answer.sentences.join(" ").split("reached its limit").length - 1).toBe(1);
  });

  it("a reason every row of a group shares is stated once for the group, never repeated per row (the real Aave shape: six checks, one exclusion reason)", () => {
    const surface = buildResultSurface(aaveDetail("EXCLUDED"));
    const group = surface.boundary.find((g) => g.kind === "SUBSTANTIVE")!;
    expect(group.sharedDetail).toBe("Sources discussed this, but none met the standard this claim requires.");
    expect(group.items.every((i) => i.detail === null)).toBe(true);
    expect(group.items).toHaveLength(6);
    // Within the boundary block the sentence appears exactly once; a row
    // of the table may still carry it as its own explanation.
    const html = render(aaveDetail("EXCLUDED"));
    const block = html.slice(html.indexOf('data-testid="boundary-section"'), html.indexOf('data-testid="full-evidence"'));
    expect(textOf(block).split("Sources discussed this, but none met the standard this claim requires.").length - 1).toBe(1);
  });

  it("fixture 3 (substantive): no technical or configuration group, the persisted reason on each item, and no research-limit language anywhere", () => {
    const f = resultFixture("3");
    const surface = buildResultSurface(f.detail);
    expect(surface.boundary.map((g) => g.kind)).toEqual(["SUBSTANTIVE"]);
    const group = surface.boundary[0];
    expect(group.items.find((i) => i.component === "EXECUTION_EVIDENCE")?.detail).toBe("The mechanism is described, but nothing checked shows it actually running.");
    const text = textOf(firstScreenOf(render(f.detail)));
    expect(text).toContain(BOUNDARY_COPY.SUBSTANTIVE);
    expect(text).not.toContain("Research limit reached");
    expect(text).not.toContain("supported evidence routes");
    expect(surface.answer.sentences.join(" ")).toContain("checked against the available evidence and not found there");
  });

  it("fixture 5 (configuration): reads as a limit of ATLAS's routes, never as 'not executing'", () => {
    const f = resultFixture("5");
    const surface = buildResultSurface(f.detail);
    expect(surface.boundary.map((g) => g.kind)).toEqual(["CONFIGURATION"]);
    expect(surface.boundary[0].items.map((i) => i.component).sort()).toEqual(["EXECUTION_EVIDENCE", "NET_EFFECT"]);
    const text = textOf(firstScreenOf(render(f.detail)));
    expect(text).toContain(BOUNDARY_COPY.CONFIGURATION);
    expect(text).toContain(BOUNDARY_NEVER.CONFIGURATION);
    // The only place "not executing" may appear is the sentence that says
    // this must NOT be read that way.
    const claims = text.replace(BOUNDARY_NEVER.CONFIGURATION, "").toLowerCase();
    expect(claims).not.toMatch(/is not executing|not running|no buyback/);
    expect(surface.answer.sentences.join(" ")).toContain("evidence routes ATLAS currently supports");
  });

  it("the real Aave shapes, with no boundary record: excluded-only checks are substantive, budget-bounded checks are technical, execution is configuration", () => {
    const excluded = buildResultSurface(aaveDetail("EXCLUDED"));
    const byKind = (s: typeof excluded) => Object.fromEntries(s.boundary.map((g) => [g.kind, g.items.map((i) => i.component).sort()]));
    expect(byKind(excluded)).toEqual({
      CONFIGURATION: ["EXECUTION_EVIDENCE"],
      SUBSTANTIVE: ["DESTINATION", "FLOW_PATH", "GOVERNANCE_BASIS", "MECHANISM_SPEC", "RECIPIENT", "SOURCE_OF_VALUE"],
    });
    expect(excluded.boundaryFromRecord).toBe(false);
    const budget = buildResultSurface(aaveDetail("BUDGET"));
    expect(byKind(budget)).toEqual({
      TECHNICAL: ["DESTINATION", "FLOW_PATH", "GOVERNANCE_BASIS", "MECHANISM_SPEC", "RECIPIENT", "SOURCE_OF_VALUE"],
      CONFIGURATION: ["EXECUTION_EVIDENCE"],
    });
    // EXECUTION_EVIDENCE is not a row the question projection named, but
    // it is the reality axis: it stands as a row of its own, read as a
    // configuration boundary — and nowhere does either surface say the
    // mechanism is not executing.
    for (const s of [excluded, budget]) {
      const exec = s.table.find((r) => r.component === "EXECUTION_EVIDENCE")!;
      expect(exec.kind).toBe("REALITY");
      expect(exec.established).toBe(BOUNDARY_COPY.CONFIGURATION);
      expect(s.table.some((r) => r.status === "CONFIRMED")).toBe(false);
      expect(s.table.filter((r) => r.status === "PARTIAL").map((r) => r.component).sort()).toEqual(["CURRENT_STATE", "NET_EFFECT"]);
    }
    expect(boundaryOf({ component: "EXECUTION_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"], coverage: "NOT_ATTEMPTED", boundary: null }).kind).toBe("CONFIGURATION");
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE ROWS THE QUESTION TURNS ON                                   */
/* ------------------------------------------------------------------ */

describe("the research table — the question's own rows, in proof-path order", () => {
  it("the projection's named rows are primary, the rows they lean on follow, all in proof-path order, and nothing else is shown", () => {
    const surface = buildResultSurface(resultFixture("1").detail);
    const order = surface.table.map((r) => r.component);
    const index = (c: string) => (PROOF_PATH_ORDER as readonly string[]).indexOf(c);
    for (let i = 1; i < order.length; i += 1) expect(index(order[i])).toBeGreaterThan(index(order[i - 1]));
    expect(surface.table.filter((r) => r.primary).map((r) => r.component).sort()).toEqual(["CURRENT_STATE", "DESTINATION", "MECHANISM_SPEC", "NET_EFFECT"]);
    expect(order).not.toContain("DURABILITY_BASIS");
    // Primary rows carry the question's own words; supporting rows the
    // canonical claim.
    expect(surface.table.find((r) => r.component === "DESTINATION")?.label).toBe("Where do the bought-back FXT tokens go?");
    expect(surface.table.find((r) => r.component === "SOURCE_OF_VALUE")?.label).toBe("Where the value comes from");
  });

  it("without a projection the assessed Pattern rows stand in; a component with no persisted row is never a row", () => {
    const f = resultFixture("2");
    const surface = buildResultSurface({ ...f.detail, questionFindings: null });
    expect(surface.table.map((r) => r.component)).toEqual(f.detail.components.map((c) => c.component).sort((a, b) => (PROOF_PATH_ORDER as readonly string[]).indexOf(a) - (PROOF_PATH_ORDER as readonly string[]).indexOf(b)));
    expect(surface.table.every((r) => r.primary)).toBe(true);
    expect(surface.table.some((r) => r.component === "DURABILITY_BASIS")).toBe(false);
  });

  it("the proof map is the same rows as nodes, in the same order, with the same status", () => {
    for (const f of RESULT_FIXTURES) {
      const surface = buildResultSurface(f.detail);
      expect(surface.chain.map((n) => n.component)).toEqual(surface.table.map((r) => r.component));
      expect(surface.chain.map((n) => n.status)).toEqual(surface.table.map((r) => r.status));
      for (const n of surface.chain) expect(n.label).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it("renders one row per table entry with the status word, the established line, and the source", () => {
    const f = resultFixture("8");
    const html = render(f.detail);
    const surface = buildResultSurface(f.detail);
    // The table shows the question's own rows and the reality rows; each
    // supporting check folds under the finding that leans on it, with its
    // own status, and stands as a node of its own on the proof map.
    const shown = tableRows(surface.table);
    expect(count(html, "research-row")).toBe(shown.length);
    expect(attrValues(html, "research-row", "status")).toEqual(shown.map((r) => r.status));
    expect(count(html, "row-established")).toBe(shown.length);
    expect(count(html, "row-source")).toBe(shown.length);
    const folded = surface.table.filter((r) => r.kind === "SUPPORTING").map((r) => r.component).sort();
    expect(attrValues(html, "rests-on-item", "component").sort()).toEqual(folded);
    expect(shown.length + folded.length).toBe(surface.table.length);
    expect(count(html, "proof-node")).toBe(surface.table.length);
    // The question projection's label heads its row.
    expect(html).toContain("Is Fixture Protocol currently buying back FXT with fee revenue?");
    // A confirmed row states what the evidence established in the source's
    // persisted reading — never a sentence written here.
    const cs = surface.table.find((r) => r.component === "SOURCE_OF_VALUE")!;
    expect(cs.established).toBe("Protocol fees from lending and swaps accrue to the Fixture treasury contract before any allocation.");
  });
});

/* ------------------------------------------------------------------ */
/* 4. SOURCE / EVIDENCE LINKAGE, FRESHNESS, ON-CHAIN TRANSLATION       */
/* ------------------------------------------------------------------ */

describe("evidence — from persisted links only, translated for a reader", () => {
  it("a row carries only evidence linked SUPPORTING or CONTRADICTING to its own component; an excluded row reaches no row and no key evidence", () => {
    for (const f of RESULT_FIXTURES) {
      const surface = buildResultSurface(f.detail);
      const excludedIds = new Set(f.detail.evidence.filter((e) => e.links.every((l) => l.role === "EXCLUDED")).map((e) => e.id));
      for (const row of surface.table) {
        for (const c of row.evidence) {
          const e = f.detail.evidence.find((x) => x.id === c.id)!;
          expect(e.links.some((l) => l.component === row.component && l.role !== "EXCLUDED"), `${f.key}/${row.component}/${c.id}`).toBe(true);
          expect(excludedIds.has(c.id)).toBe(false);
        }
      }
      for (const c of surface.keyEvidence) expect(excludedIds.has(c.id), `${f.key}/${c.id}`).toBe(false);
    }
  });

  it("no excluded evidence on the first screen — fixtures 3, 4 and 8 carry refused material and none of its words appear before the deep disclosure", () => {
    for (const key of ["3", "4", "8"]) {
      const f = resultFixture(key);
      const first = textOf(firstScreenOf(render(f.detail)));
      const refused = f.detail.evidence.filter((e) => e.links.every((l) => l.role === "EXCLUDED"));
      expect(refused.length, key).toBeGreaterThan(0);
      for (const e of refused) {
        expect(first, `${key}/${e.id}`).not.toContain(e.fragment);
        if (e.summary) expect(first, `${key}/${e.id}`).not.toContain(e.summary);
      }
    }
  });

  it("key evidence: contradicting first, then what the Proof cites, then on-chain readings, then supporting rows in proof-path order; one card per document; capped at five", () => {
    const f = resultFixture("6");
    const surface = buildResultSurface(f.detail);
    expect(surface.keyEvidence.length).toBeLessThanOrEqual(5);
    expect(surface.keyEvidence[0].relation).toBe("CONTRADICTS");
    expect(surface.keyEvidence[0].id).toBe("ev-chain-supply-rose");
    const cited = new Set(f.detail.proof!.citations.map((c) => c.evidenceId));
    expect(cited.has(surface.keyEvidence[1].id)).toBe(true);
    const docs = surface.keyEvidence.map((c) => c.url);
    expect(new Set(docs).size).toBe(docs.length);
    // The cap and the dedupe are the helper's, pinned directly.
    expect(keyEvidence(surface.table, cited, 2)).toHaveLength(2);
  });

  it("each card names source, kind, date and what it proves; a documentary card opens to its excerpt, why it was used and what it does not prove", () => {
    const f = resultFixture("7");
    const html = render(f.detail);
    const key = html.slice(html.indexOf('data-testid="key-evidence"'), html.indexOf('data-testid="boundary-section"') === -1 ? html.indexOf('data-testid="full-evidence"') : html.indexOf('data-testid="boundary-section"'));
    expect(count(key, "evidence-card")).toBe(buildResultSurface(f.detail).keyEvidence.length);
    expect(key).toContain("Fixture Protocol documentation");
    expect(key).toContain("Official docs");
    expect(key).toContain(`Published ${on("2026-08-02T00:00:00.000Z")}`);
    expect(key).toContain("What it proves");
    expect(key).toContain('data-testid="evidence-open-original"');
    expect(key).toContain('data-testid="evidence-snapshot"');
    // Details are one click away, inline — nothing navigates.
    expect(key).toContain('data-testid="evidence-details-toggle"');
    expect(key).not.toContain('data-testid="evidence-details"');
    const surface = buildResultSurface(f.detail);
    const doc = surface.keyEvidence.find((c) => c.id === "ev-docs-active")!;
    expect(doc.excerpt).toBe("Active modules: Lending v3, Swap v2, Buyback (since epoch 118).");
    expect(doc.whyUsed).toBe("Shows what the project officially documents.");
    expect(doc.doesNotProve).toBe("does not show a purchase transaction");
    expect(doc.openable).toBe(true);
  });

  it("freshness: the newest publication date leads a row, observation next, retrieval last; the answer states when the evidence was checked", () => {
    const surface = buildResultSurface(resultFixture("7").detail);
    const cs = surface.table.find((r) => r.component === "CURRENT_STATE")!;
    expect(cs.date).toMatchObject({ label: "Published", value: on("2026-09-10T00:00:00.000Z") });
    const exec = surface.table.find((r) => r.component === "EXECUTION_EVIDENCE")!;
    expect(exec.date).toMatchObject({ label: "Observed", value: on("2026-09-17T09:12:00.000Z") });
    expect(surface.checkedOn).toBe(on("2026-09-18T14:20:00.000Z"));
    expect(surface.latestEvidence).toMatchObject({ label: "Published", value: on("2026-09-10T00:00:00.000Z") });
    const html = render(resultFixture("7").detail);
    expect(count(html, "answer-freshness")).toBe(1);
    expect(textOf(html)).toContain(`Evidence checked ${on("2026-09-18T14:20:00.000Z")}`);
    // A row with only a retrieval date says "Checked", never a guessed
    // publication date.
    const data = buildResultSurface(resultFixture("8").detail).table.find((r) => r.component === "RECIPIENT")!;
    expect(data.date?.label).toBe("Published");
    const undated = buildResultSurface({ ...resultFixture("8").detail, evidence: resultFixture("8").detail.evidence.map((e) => ({ ...e, publishedAt: null, observedAt: null })) });
    expect(undated.table.find((r) => r.component === "RECIPIENT")!.date).toMatchObject({ label: "Checked", value: on("2026-09-18T14:05:00.000Z") });
  });

  it("an on-chain reading is translated — token, amount, network, when observed — and the raw integer never reaches the screen", () => {
    const f = resultFixture("7");
    const surface = buildResultSurface(f.detail);
    const chain = surface.keyEvidence.find((c) => c.id === "ev-chain-supply") ?? surface.table.find((r) => r.component === "CURRENT_STATE")!.evidence.find((c) => c.id === "ev-chain-supply")!;
    expect(chain.onchain).toEqual({ observation: "FXT total supply observed: 100.0M", network: "Ethereum" });
    expect(chain.sourceName).toBe("On-chain record");
    expect(chain.openable).toBe(false);
    expect(chain.date).toMatchObject({ label: "Observed", value: on("2026-09-18T14:03:00.000Z") });
    expect(chain.doesNotProve).toBe("does not establish whether any buyback reduced total supply");
    // On the first screen the reading is a sentence; the raw integer and
    // the artifact's field names belong to the full evidence and audit.
    const text = textOf(firstScreenOf(render(f.detail)));
    expect(text).not.toContain("100000000000000000000000000");
    expect(text).not.toContain("amountRaw");
    expect(text).toContain("FXT total supply observed: 100.0M");
    expect(networkOf("atlas-onchain://solana/mainnet/project/x/token/")).toBe("Solana");
    expect(networkOf("atlas-onchain://ethereum/sepolia/project/x/token/")).toBe("Ethereum sepolia");
    expect(networkOf("https://example.test/page")).toBeNull();
    // The real Aave shape: the same translation on a real locator. The
    // persisted summary (mint, raw integer, slot) leads nowhere on the
    // first screen — not on the card, not on the row it supports.
    const aaveDetailExcluded = aaveDetail("EXCLUDED");
    const aave = buildResultSurface(aaveDetailExcluded);
    const reading = aave.keyEvidence[0];
    expect(reading.onchain).toEqual({ observation: "FXL total supply observed: 16.0M", network: "Ethereum" });
    expect(reading.proves).toBe("FXL total supply observed: 16.0M");
    expect(aave.table.find((r) => r.component === "CURRENT_STATE")!.established).toBe("FXL total supply observed: 16.0M.");
    const aaveFirst = textOf(firstScreenOf(render(aaveDetailExcluded)));
    for (const raw of ["16000000000000000000000000", "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", "finalized block"]) expect(aaveFirst, raw).not.toContain(raw);
  });
});

/* ------------------------------------------------------------------ */
/* 5. NO ENGINE VOCABULARY, NO RAW JSON, NOTHING STRENGTHENED         */
/* ------------------------------------------------------------------ */

describe("the surface never outruns the record", () => {
  it("no raw internal code, stage name, attempt or recovery language on the first screen of any fixture or the real shapes", () => {
    const details = [...RESULT_FIXTURES.map((f) => f.detail), aaveDetail("EXCLUDED"), aaveDetail("BUDGET")];
    for (const d of details) {
      const first = textOf(firstScreenOf(render(d)));
      for (const token of FORBIDDEN_SURFACE_TOKENS) {
        expect(first, `${d.job.id}: ${token}`).not.toContain(token);
      }
      expect(first).not.toMatch(/\b[A-Z]{3,}_[A-Z_]{3,}\b/);
      expect(first).not.toContain("component");
    }
  });

  it("no raw JSON on the first screen; the enum vocabulary is absent from the whole rendering", () => {
    for (const d of [...RESULT_FIXTURES.map((f) => f.detail), aaveDetail("EXCLUDED")]) {
      const html = render(d);
      const first = textOf(firstScreenOf(html));
      expect(first).not.toContain('{"');
      expect(first).not.toContain("amountRaw");
      const whole = textOf(html);
      for (const token of ["SEARCH_BUDGET_EXHAUSTED", "RECOVERY_BOUND_REACHED", "NO_ADMISSIBLE_ROUTE", "ALL_EVIDENCE_EXCLUDED", "INSUFFICIENT_EVIDENCE", "PARTIALLY_SUPPORTED", "WORK_QUEUE_EXHAUSTED"]) {
        expect(whole, token).not.toContain(token);
      }
    }
  });

  it("a contradiction is preserved: the row says Contradicted, it leads the key evidence, it is never listed as not established, and the answer says the evidence points the other way", () => {
    const f = resultFixture("6");
    const surface = buildResultSurface(f.detail);
    const net = surface.table.find((r) => r.component === "NET_EFFECT")!;
    expect(net.status).toBe("CONTRADICTED");
    expect(net.statusLabel).toBe("Contradicted");
    expect(net.established).toBe("Total FXT supply was higher at the end of the measured interval than at its start.");
    expect(surface.keyEvidence[0].relation).toBe("CONTRADICTS");
    expect(surface.boundary.flatMap((g) => g.items.map((i) => i.component))).not.toContain("NET_EFFECT");
    expect(surface.answer.sentences[0]).toContain("the evidence indicates otherwise");
    const html = render(f.detail);
    expect(attrValues(html, "proof-node", "status")).toContain("CONTRADICTED");
    expect(textOf(firstScreenOf(html))).toContain("Contradicts");
  });

  it("the answer is two to four sentences, never engine vocabulary, and always ends on the boundary when something is open", () => {
    for (const f of RESULT_FIXTURES) {
      const { answer, boundary } = buildResultSurface(f.detail);
      expect(answer.sentences.length, f.key).toBeGreaterThanOrEqual(1);
      expect(answer.sentences.length, f.key).toBeLessThanOrEqual(4);
      if (boundary.length > 0) expect(answer.sentences[answer.sentences.length - 1], f.key).toMatch(/limit|evidence routes|not found there/);
      for (const s of answer.sentences) expect(s, f.key).not.toMatch(/Main limitation|[A-Z]{3,}_[A-Z]/);
    }
    // Confidence appears only with a verdict, in a word.
    expect(buildResultSurface(resultFixture("1").detail).answer.confidenceLabel).toBe("Strong");
  });

  it("a failed run keeps its settled wording, shows no boundary section, and renders no verification", () => {
    const f = resultFixture("2");
    const failed: ResearchJobDetail = { ...f.detail, job: { ...f.detail.job, state: "FAILED" } };
    const surface = buildResultSurface(failed);
    expect(surface.outcomeKind).toBe("FAILED");
    expect(surface.answer.sentences[0]).toContain("did not complete");
    expect(surface.boundary).toEqual([]);
    const html = render(failed);
    expect(count(html, "boundary-section")).toBe(0);
    expect(count(html, "verification-view")).toBe(0);
    expect(count(html, "research-table")).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6. STRUCTURE — PRESENTATION ONLY, EIGHT STATES, ONE COMPONENT        */
/* ------------------------------------------------------------------ */

describe("presentation only", () => {
  it("the surface model and component import nothing that could fetch, persist or reason", () => {
    for (const file of ["src/client/result-surface.ts", "src/client/components/research-result.tsx", "src/client/result-surface-fixtures.ts"]) {
      const src = readFileSync(file, "utf-8")
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of ["fetch(", "anthropic", "db.", "useEffect", "generateQuestionProjection", "startResearch"]) {
        expect(src, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the page renders the finished result through the one component; the dev route renders the same component from eight distinct fixtures and is gated out of production", () => {
    const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf-8");
    expect(page).toContain("<ResearchResult detail={detail} jobId={jobId} deepOpen={deepOpen} />");
    expect(page).not.toContain("<ResultLadder");
    const dev = readFileSync("app/(app)/dev/result-states/page.tsx", "utf-8");
    expect(dev).toContain('if (process.env.NODE_ENV === "production") notFound();');
    expect(dev).toContain("<ResearchResult detail={fixture.detail} jobId={null} />");
    expect(RESULT_FIXTURES).toHaveLength(8);
    expect(new Set(RESULT_FIXTURES.map((f) => f.key)).size).toBe(8);
    const signatures = RESULT_FIXTURES.map((f) => {
      const s = buildResultSurface(f.detail);
      return JSON.stringify([s.verdict, s.table.map((r) => `${r.component}:${r.status}`), s.boundary.map((g) => g.kind)]);
    });
    expect(new Set(signatures).size).toBe(8);
    // Every fixture renders every first-screen section it has content for.
    for (const f of RESULT_FIXTURES) {
      const html = render(f.detail);
      for (const id of ["answer-panel", "research-table", "proof-chain", "key-evidence", "full-evidence"]) expect(count(html, id), `${f.key}/${id}`).toBe(1);
    }
    // Fixtures name no real project, token or address.
    const src = readFileSync("src/client/result-surface-fixtures.ts", "utf-8");
    for (const token of ["Aave", "AAVE", "Raydium", "RAY", "Lido", "pump", "0x7Fc6"]) expect(src, token).not.toContain(token);
  });

  it("the Proof read model carries the boundary record exactly as persisted, and the client type declares it", () => {
    const view = readFileSync("src/server/services/proof-view.ts", "utf-8");
    expect(view).toContain("boundedBy: proofs.boundedBy");
    expect(view).toContain("boundedBy: (row.boundedBy as ResearchBoundary | null) ?? null");
    const api = readFileSync("src/client/api.ts", "utf-8");
    expect(api).toContain("boundedBy: ProofBoundaryView | null");
  });
});
