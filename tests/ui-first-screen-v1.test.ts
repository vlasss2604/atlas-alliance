import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KeyEvidence, NotEstablished, ProofMap } from "../src/client/components/result-first-screen";
import {
  deriveQuestionFindings,
  deriveResultLadder,
  keyEvidenceFrom,
  MAX_KEY_EVIDENCE,
  PROOF_MAP_STATUS,
  resultBriefing,
  RESULT_STATE_LABELS,
  splitMainLimitation,
  type EvidenceItemLike,
  type RealityState,
} from "../src/client/research-model";

// THE FIRST SCREEN OF A FINISHED RESEARCH (Founder decision 2026-09-19,
// after the first live UI acceptance on Aave, job 2b0f00e4):
//
//   ANSWER → PROOF MAP → KEY EVIDENCE → NOT ESTABLISHED → (full evidence)
//
// with one invariant over all of it: PAGE <= PERSISTED VERIFIED RECORD.
// The surface may simplify, group, hide repetition, prioritise and
// relabel. It may not strengthen a verdict, infer evidence, turn PARTIAL
// into SUPPORTED, turn NOT_ESTABLISHED into a negative claim, or drop a
// limitation. These tests pin that, on a fixture shaped like the Aave
// record (two on-chain rows, everything documentary unresolved) and on
// the derivation helpers directly.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const count = (h: string, id: string) => h.match(new RegExp(`data-testid="${id}"`, "g"))?.length ?? 0;

// THE AAVE SHAPE. The persisted S5 statuses of job 2b0f00e4, and the
// question projection it produced — copied, not invented.
const AAVE_COMPONENTS = [
  { component: "SOURCE_OF_VALUE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], coverage: "BLOCKED" as const },
  { component: "FLOW_PATH", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], coverage: "BLOCKED" as const },
  { component: "MECHANISM_SPEC", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], coverage: "BLOCKED" as const },
  { component: "GOVERNANCE_BASIS", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], coverage: "BLOCKED" as const },
  { component: "EXECUTION_EVIDENCE", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_ADMISSIBLE_ROUTE"], coverage: "BLOCKED" as const },
  { component: "CURRENT_STATE", status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["ev-cs"], coverage: "COMPLETED" as const },
  { component: "DESTINATION", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], coverage: "BLOCKED" as const },
  { component: "RECIPIENT", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], coverage: "BLOCKED" as const },
  { component: "NET_EFFECT", status: "PARTIALLY_SUPPORTED", reasonCodes: ["SUPPLY_REDUCTION_NOT_ESTABLISHED", "INSUFFICIENT_AUTHORITY"], supportingEvidenceIds: ["ev-ne"], coverage: "COMPLETED" as const },
  { component: "DURABILITY_BASIS", status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"], coverage: "BLOCKED" as const },
];
const AAVE_PROJECTION = [
  { label: "Is the project currently buying back its token with protocol revenue?", patternStep: 5, component: "CURRENT_STATE", supportingComponents: [] },
  { label: "Where does the bought-back token go after purchase?", patternStep: 6, component: "DESTINATION", supportingComponents: ["RECIPIENT"] },
  { label: "What is the mechanism for using protocol revenue to acquire the token?", patternStep: 3, component: "MECHANISM_SPEC", supportingComponents: ["FLOW_PATH"] },
  { label: "What happens to token supply through this process?", patternStep: 7, component: "NET_EFFECT", supportingComponents: [] },
];
const ONCHAIN_CS: EvidenceItemLike = {
  id: "ev-cs",
  component: "CURRENT_STATE",
  summary: "The token contract reports a total supply of 16,000,000 tokens at the finalized block.",
  fragment: '{"mint":"0x7Fc6…","amountRaw":"16000000000000000000000000"}',
  doesNotProve: "does not establish whether any buyback executed",
  sourceClass: "ONCHAIN_VERIFIABLE",
  officiality: "CLAIMED",
  retrievedUrl: "atlas-onchain://ethereum/mainnet/project/0x7Fc6/token/",
  sourceTitle: null,
  fetchedAt: "2026-09-19T19:41:55.000Z",
  hasSnapshot: false,
};
const ONCHAIN_NE: EvidenceItemLike = { ...ONCHAIN_CS, id: "ev-ne", component: "NET_EFFECT" };

function aaveFirstScreen() {
  const rows = deriveQuestionFindings(AAVE_PROJECTION, AAVE_COMPONENTS, { CURRENT_STATE: ["ONCHAIN_VERIFIABLE"], NET_EFFECT: ["ONCHAIN_VERIFIABLE"] });
  const briefing = resultBriefing({
    verdict: "INSUFFICIENT_EVIDENCE",
    outcomeKind: "VERDICT",
    projectName: "Fixture Lending",
    components: AAVE_COMPONENTS,
    rows,
  });
  const { answer, limitation } = splitMainLimitation(briefing.shortAnswer);
  const keyEvidence = keyEvidenceFrom({
    jobId: "job-1",
    cited: [],
    contradicting: [],
    supportingByComponent: { CURRENT_STATE: [ONCHAIN_CS], NET_EFFECT: [ONCHAIN_NE] },
    rowComponents: briefing.keyFindings.map((f) => f.component),
  });
  return { rows, briefing, answer, limitation, keyEvidence };
}

/* ------------------------------------------------------------------ */
/* 1. THE PROOF MAP                                                    */
/* ------------------------------------------------------------------ */

describe("PROOF MAP — one status word per link, read from the persisted state", () => {
  it("the vocabulary is closed, one word per canonical reality state, and never stronger than the state", () => {
    expect(PROOF_MAP_STATUS).toEqual({
      VERIFIED: "Supported",
      PARTIAL: "Partial",
      UNRESOLVED: "Not established",
      NOT_HAPPENING: "Contradicted",
      NOT_ASSESSED: "Not assessed",
    });
    // "Supported" is reserved for VERIFIED alone; nothing else may read as it.
    for (const [state, word] of Object.entries(PROOF_MAP_STATUS)) {
      if (state !== "VERIFIED") expect(word.toLowerCase()).not.toContain("supported");
    }
    // The unresolved word is the evidence's state, never a negative claim.
    expect(PROOF_MAP_STATUS.UNRESOLVED).not.toMatch(/not happening|does not|false|denied/i);
    // And the ladder's fuller labels map to the same five states — two
    // wordings, one meaning.
    expect(Object.keys(RESULT_STATE_LABELS).sort()).toEqual(Object.keys(PROOF_MAP_STATUS).sort());
  });

  it("on the Aave shape: four question rows, two Partial, two Not established, nothing Supported, nothing Contradicted", () => {
    const { briefing } = aaveFirstScreen();
    const html = render(createElement(ProofMap, { rows: briefing.keyFindings }));
    expect(count(html, "proof-map-row")).toBe(4);
    const statuses = [...html.matchAll(/data-testid="proof-map-status"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(statuses.sort()).toEqual(["Not established", "Not established", "Partial", "Partial"]);
    expect(html).not.toContain(">Supported<");
    expect(html).not.toContain(">Contradicted<");
    // Each row carries the claim in the question's own words and the raw
    // state only as a data attribute — never the component enum as text.
    expect(html).toContain("Where does the bought-back token go after purchase?");
    expect(html).not.toMatch(/>\s*(CURRENT_STATE|DESTINATION|NET_EFFECT|MECHANISM_SPEC)\s*</);
  });

  it("every state renders its own word; a contradiction is never softened, a partial never promoted", () => {
    const states: RealityState[] = ["VERIFIED", "PARTIAL", "UNRESOLVED", "NOT_HAPPENING"];
    const rows = states.map((state, i) => ({
      component: `C${i}`,
      check: `Claim ${i}`,
      result: RESULT_STATE_LABELS[state],
      tone: "neutral" as const,
      state,
    }));
    const html = render(createElement(ProofMap, { rows }));
    const statuses = [...html.matchAll(/data-testid="proof-map-status"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(statuses).toEqual(["Supported", "Partial", "Not established", "Contradicted"]);
  });

  it("renders nothing for an empty index rather than an empty frame", () => {
    expect(render(createElement(ProofMap, { rows: [] }))).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* 2. KEY EVIDENCE                                                     */
/* ------------------------------------------------------------------ */

describe("KEY EVIDENCE — the few rows that carry the conclusion, from admitted links only", () => {
  const doc = (id: string, component: string, url: string, extra: Partial<EvidenceItemLike> = {}): EvidenceItemLike => ({
    id,
    component,
    summary: `Summary for ${id}`,
    fragment: `Fragment for ${id}`,
    doesNotProve: null,
    sourceClass: "OFFICIAL_DOCS",
    officiality: "CONFIRMED",
    retrievedUrl: url,
    sourceTitle: null,
    fetchedAt: "2026-09-19T00:00:00.000Z",
    hasSnapshot: true,
    ...extra,
  });

  it("order: contradicting first, then the Proof's citations, then supporting rows in proof-map order; capped", () => {
    const items = keyEvidenceFrom({
      jobId: "j",
      cited: [doc("cited", "SOURCE_OF_VALUE", "https://a.test/one")],
      contradicting: [doc("contra", "NET_EFFECT", "https://a.test/contra")],
      supportingByComponent: {
        DESTINATION: [doc("d1", "DESTINATION", "https://a.test/d1"), doc("d2", "DESTINATION", "https://a.test/d2")],
        CURRENT_STATE: [doc("c1", "CURRENT_STATE", "https://a.test/c1")],
      },
      rowComponents: ["CURRENT_STATE", "DESTINATION"],
    });
    expect(items.map((i) => i.id)).toEqual(["contra", "cited", "c1", "d1"]);
    expect(items.length).toBe(MAX_KEY_EVIDENCE);
    expect(items[0].relation).toBe("CONTRADICTS");
    expect(items[1].relation).toBe("SUPPORTS");
  });

  it("one entry per document: the same page supporting two claims is listed once, under the first claim it was met for", () => {
    const items = keyEvidenceFrom({
      jobId: "j",
      cited: [],
      contradicting: [],
      supportingByComponent: {
        SOURCE_OF_VALUE: [doc("s1", "SOURCE_OF_VALUE", "https://docs.test/page")],
        DESTINATION: [doc("s2", "DESTINATION", "https://docs.test/page/")],
      },
      rowComponents: ["SOURCE_OF_VALUE", "DESTINATION"],
    });
    expect(items.map((i) => i.id)).toEqual(["s1"]);
    expect(items[0].claim).toBe("Where the value comes from");
  });

  it("what it proves is the engine's persisted reading, the passage when there is none — never a sentence written here", () => {
    const withSummary = keyEvidenceFrom({ jobId: "j", cited: [doc("a", "SOURCE_OF_VALUE", "https://x.test/a")], contradicting: [], supportingByComponent: {}, rowComponents: [] });
    expect(withSummary[0].proves).toBe("Summary for a");
    const noSummary = keyEvidenceFrom({ jobId: "j", cited: [doc("b", "SOURCE_OF_VALUE", "https://x.test/b", { summary: null })], contradicting: [], supportingByComponent: {}, rowComponents: [] });
    expect(noSummary[0].proves).toBe("Fragment for b");
    const blank = keyEvidenceFrom({ jobId: "j", cited: [doc("c", "SOURCE_OF_VALUE", "https://x.test/c", { summary: "   " })], contradicting: [], supportingByComponent: {}, rowComponents: [] });
    expect(blank[0].proves).toBe("Fragment for c");
  });

  it("carries source, class, date and the two ways to read it — the snapshot only where a capture exists", () => {
    const [withSnap, noSnap] = keyEvidenceFrom({
      jobId: "job-9",
      cited: [doc("a", "SOURCE_OF_VALUE", "https://docs.test/fees/overview"), doc("b", "DESTINATION", "https://docs.test/reserve", { hasSnapshot: false, sourceTitle: "Reserve policy" })],
      contradicting: [],
      supportingByComponent: {},
      rowComponents: [],
    });
    expect(withSnap.sourceName).toBe("overview");
    expect(withSnap.sourceClass).toBe("Official docs");
    expect(withSnap.retrievedDate).toBe("19 Sept 2026");
    expect(withSnap.snapshotHref).toBe("/research/job-9/source/a");
    expect(noSnap.sourceName).toBe("Reserve policy");
    expect(noSnap.snapshotHref).toBeNull();
    const html = render(createElement(KeyEvidence, { items: [withSnap, noSnap] }));
    expect(count(html, "key-evidence-item")).toBe(2);
    expect(count(html, "key-evidence-snapshot")).toBe(1);
    expect(count(html, "key-evidence-open")).toBe(2);
    expect(html).toContain("Supports · Where the value comes from");
    expect(html).toContain("retrieved 19 Sept 2026");
    // No raw JSON, no enum as text.
    expect(html).not.toMatch(/>\s*\{"/);
    expect(html).not.toMatch(/>\s*(SOURCE_OF_VALUE|DESTINATION)\s*</);
  });

  it("on the Aave shape: ONE on-chain reading is the key evidence — the same artifact read for two claims is listed once, under the first claim in map order", () => {
    const { keyEvidence } = aaveFirstScreen();
    expect(keyEvidence.map((e) => e.id)).toEqual(["ev-cs"]);
    expect(keyEvidence[0].claim).toBe("It is currently active");
    expect(keyEvidence[0].sourceClass).toBe("On-chain");
    const html = render(createElement(KeyEvidence, { items: keyEvidence }));
    expect(html).toContain("total supply of 16,000,000 tokens");
    expect(html).not.toContain("amountRaw");
  });

  it("renders nothing when there is nothing admitted", () => {
    expect(render(createElement(KeyEvidence, { items: [] }))).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE ANSWER AND THE BOUNDARY                                      */
/* ------------------------------------------------------------------ */

describe("ANSWER + NOT ESTABLISHED — the limitation moves, it is never dropped", () => {
  it("splitMainLimitation is total: every sentence is in the answer or is the limitation, order kept", () => {
    const sentences = ["Established: A.", "Partly established: B — the evidence goes part of the way.", "Not established: C.", "Main limitation — C: the search budget was exhausted."];
    const { answer, limitation } = splitMainLimitation(sentences);
    expect(answer).toEqual(sentences.slice(0, 3));
    expect(limitation).toBe(sentences[3]);
    expect([...answer, limitation]).toEqual(sentences);
    const none = splitMainLimitation(["Established: A."]);
    expect(none).toEqual({ answer: ["Established: A."], limitation: null });
  });

  it("on the Aave shape: the answer is short and names what is partly established and what is not; the limitation leads the boundary block", () => {
    const { answer, limitation, briefing } = aaveFirstScreen();
    expect(answer.length).toBeGreaterThanOrEqual(2);
    expect(answer.length).toBeLessThanOrEqual(4);
    expect(answer.join(" ")).toContain("Partly established");
    expect(answer.join(" ")).toContain("Not established");
    expect(answer.join(" ")).not.toContain("Main limitation");
    expect(limitation).toMatch(/^Main limitation/);
    const html = render(createElement(NotEstablished, { limitation, items: briefing.unresolved, more: briefing.unresolvedMore }));
    expect(count(html, "main-limitation")).toBe(1);
    expect(html.split("Main limitation").length - 1).toBe(1);
    expect(count(html, "unresolved-item")).toBe(briefing.unresolved.length);
    expect(html).toContain("Not established");
    // A blocked check says whose limit it is, and never blames the project.
    expect(html).toContain("This is a limit of the run, not evidence for or against the project.");
    expect(html).not.toMatch(/does not (buy back|happen)|no buyback|is false/i);
  });

  it("a contradicted check is never listed as not established, and the block is absent when there is nothing open", () => {
    const rows = deriveQuestionFindings(
      [{ label: "Is supply reduced?", patternStep: 7, component: "NET_EFFECT", supportingComponents: [] }],
      [{ component: "NET_EFFECT", status: "CONTRADICTED", coverage: "COMPLETED" }],
    );
    const b = resultBriefing({ verdict: "NOT_SUPPORTED", outcomeKind: "VERDICT", projectName: "P", components: [{ component: "NET_EFFECT", status: "CONTRADICTED" }], rows });
    expect(b.unresolved).toEqual([]);
    const { limitation } = splitMainLimitation(b.shortAnswer);
    expect(limitation).toBeNull();
    expect(render(createElement(NotEstablished, { limitation, items: b.unresolved, more: 0 }))).toBe("");
  });

  it("the ladder fallback feeds the same surfaces when no projection resolved", () => {
    const ladder = deriveResultLadder(AAVE_COMPONENTS, {});
    const rows = [...ladder.mechanism, ...ladder.value];
    const b = resultBriefing({ verdict: "INSUFFICIENT_EVIDENCE", outcomeKind: "VERDICT", projectName: "P", components: AAVE_COMPONENTS, rows });
    const html = render(createElement(ProofMap, { rows: b.keyFindings }));
    expect(count(html, "proof-map-row")).toBe(b.keyFindings.length);
    expect(b.keyFindings.every((f) => f.state !== "NOT_ASSESSED")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. STRUCTURAL: PRESENTATION ONLY                                    */
/* ------------------------------------------------------------------ */

describe("presentation only: no status decided, no sentence written, no call made", () => {
  it("the first-screen components import nothing that could fetch, persist or reason", () => {
    const src = readFileSync("src/client/components/result-first-screen.tsx", "utf-8")
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["fetch(", "anthropic", "db.", "useEffect", "useState", "verdict", "SUPPORTED\"", "status ===", "reasonCodes"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // Only the closed vocabulary decides a status word.
    expect(src).toContain("proofMapStatus(r.state)");
  });

  it("the page composes the four blocks from briefing/keyEvidence values only and hides the deep material behind one disclosure", () => {
    const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf-8");
    expect(page).toContain("<ProofMap rows={briefing.keyFindings} />");
    expect(page).toContain("<KeyEvidence items={keyEvidence} />");
    expect(page).toContain("<NotEstablished limitation={limitation} items={briefing.unresolved} more={briefing.unresolvedMore} />");
    expect(page).toContain('data-testid="full-evidence"');
    expect(page.indexOf('data-testid="full-evidence"')).toBeLessThan(page.indexOf("<ResultLadder"));
    // Key evidence is built from admitted roles only: citations, S5
    // contradicting rows and the SUPPORTING-linked map — never from
    // `detail.evidence` wholesale (which includes EXCLUDED links).
    const call = page.slice(page.indexOf("keyEvidenceFrom({"), page.indexOf("});", page.indexOf("keyEvidenceFrom({")));
    expect(call).toContain("cited: used.map(");
    expect(call).toContain("contradicting: contradicting.map(");
    expect(call).toContain("supportingByComponent: evidenceByComponent");
    expect(call).not.toContain("detail.evidence");
  });
});
