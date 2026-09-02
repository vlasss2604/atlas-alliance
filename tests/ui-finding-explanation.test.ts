import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ResultLadder } from "../src/client/components/result-ladder";
import {
  deriveQuestionFindings,
  findingExplanation,
  type EvidenceItemLike,
} from "../src/client/research-model";

// CONNECTED EXPLANATION, INLINE PROOF, INDEPENDENT EXPANSIONS.
//
// The findings were right and reading them was work. Each opened into
// three headed blocks — what ATLAS checked, what the evidence shows, what
// it does not establish — every one accurate, and joining them up was left
// to the reader. Proof lived in a separate document section, so a source
// arrived without the conclusion it was there for. And the rows behaved as
// an accordion, so comparing two conclusions was impossible.
//
// These tests pin the three fixes, and pin that none of them changed what
// a finding is allowed to say.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const LADDER = "src/client/components/result-ladder.tsx";
const PAGE = "app/(app)/research/[id]/page.tsx";

const evidenceItem = (over: Partial<EvidenceItemLike> = {}): EvidenceItemLike => ({
  id: "ev-1",
  component: "DESTINATION",
  summary: "The documentation names the destination.",
  fragment: "a literal passage from the fetched document",
  doesNotProve: "That the transfer has occurred.",
  sourceClass: "OFFICIAL_DOCS",
  officiality: "CONFIRMED",
  retrievedUrl: "https://docs.example.test/fees.md",
  sourceTitle: "fees.md",
  ...over,
});

const QUESTION_FINDINGS = [
  { label: "Where does the value go?", patternStep: 6, component: "DESTINATION", supportingComponents: [] },
  { label: "Is the mechanism running now?", patternStep: 4, component: "EXECUTION_EVIDENCE", supportingComponents: [] },
  { label: "Who receives it?", patternStep: 6, component: "RECIPIENT", supportingComponents: [] },
];

const COMPONENTS = [
  {
    component: "DESTINATION",
    status: "SUPPORTED",
    coverage: "COMPLETED" as const,
    supportingEvidenceIds: ["ev-1"],
  },
  {
    component: "EXECUTION_EVIDENCE",
    status: "INSUFFICIENT_EVIDENCE",
    coverage: "COMPLETED" as const,
    reasonCodes: ["MISSING_EXECUTION_EVIDENCE"],
  },
  { component: "RECIPIENT", status: "SUPPORTED", coverage: "COMPLETED" as const },
];

/* ------------------------------------------------------------------ */
/* 1. ONE CONNECTED EXPLANATION                                        */
/* ------------------------------------------------------------------ */

describe("a finding explains itself in prose, not in filing cabinets", () => {
  it("TEST 1: the report-style headings are gone from the normal result", () => {
    const src = readFileSync(LADDER, "utf-8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const heading of [
      "What ATLAS checked",
      "What the evidence shows",
      "What it does not establish",
      "Why this status",
    ]) {
      expect(code, heading).not.toContain(heading);
    }
    // And the generic Block wrapper that produced them is gone with them.
    expect(code).not.toContain("function Block(");
  });

  it("TEST 1b: an established finding leads with WHERE IT CAME FROM, not with its status", () => {
    const [row] = deriveQuestionFindings([QUESTION_FINDINGS[0]], COMPONENTS, {
      DESTINATION: ["OFFICIAL_DOCS"],
    });
    const sentences = findingExplanation(row);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(3);

    // THE WHOLE POINT OF OPENING A ROW. The collapsed row already gave the
    // answer and the badge already gave the strength, so an expansion that
    // opened "The checked evidence establishes …" spent the reader's click
    // restating both. Provenance is the thing they could not already know.
    expect(sentences[0]).toBe("This comes from the project's own documentation.");
    expect(sentences.join(" ")).not.toContain("The checked evidence establishes");

    // Then the boundary — where "documented" is kept from reading as
    // "happening".
    expect(sentences.join(" ")).toContain(
      "Documentation alone does not establish that the documented thing is happening.",
    );
    for (const s of sentences) expect(s).toMatch(/\.$/);
  });

  it("TEST 1c: an unresolved finding is explained by its persisted reason alone", () => {
    const [, row] = deriveQuestionFindings(QUESTION_FINDINGS, COMPONENTS);
    const sentences = findingExplanation(row);
    // Nothing was admitted, so there is no provenance to state and no
    // source class to caveat — the reason code IS the explanation.
    expect(sentences).toEqual([
      "The mechanism is described, but nothing checked shows it actually running.",
    ]);
    expect(sentences.join(" ")).not.toContain("This comes from");
  });

  it("TEST 2: a technical limitation stays its own explanation, and its own frame", () => {
    const [row] = deriveQuestionFindings(
      [QUESTION_FINDINGS[1]],
      [
        {
          component: "EXECUTION_EVIDENCE",
          status: "INSUFFICIENT_EVIDENCE",
          reasonCodes: ["NO_EVIDENCE_FOUND"],
          coverage: "BLOCKED",
        },
      ],
    );
    const sentences = findingExplanation(row);
    const text = sentences.join(" ");
    // States the QUESTION's condition and whose limit it is — not a
    // narration of the run's internal stages.
    expect(text).toContain("unavailable during this research run");
    expect(text).toContain("the question remains open");
    expect(text).toContain("not evidence for or against the project");
    // Process language a reader never asked about.
    expect(text).not.toContain("could not complete");
    expect(text).not.toContain("at this stage");
    // It must NOT borrow the evidence-gap sentence, which asserts that
    // checking happened — the whole point of the distinction.
    expect(text).not.toContain("sources checked here");
    expect(text).not.toContain("does not establish");

    // And it renders in the limitation frame, not as ordinary prose.
    const html = render(
      createElement(ResultLadder, {
        components: [
          {
            component: "EXECUTION_EVIDENCE",
            status: "INSUFFICIENT_EVIDENCE",
            reasonCodes: ["NO_EVIDENCE_FOUND"],
            coverage: "BLOCKED" as const,
          },
        ],
        questionFindings: [QUESTION_FINDINGS[1]],
      }),
    );
    expect(html).toContain('data-testid="ladder-row"');
    // Closed by default, so the frame appears only once opened — what is
    // pinned here is that the two paths are separate in the source.
    const src = readFileSync(LADDER, "utf-8");
    expect(src).toContain('data-testid="ladder-limitation"');
    expect(src).toContain('data-testid="finding-explanation"');
    expect(src).toContain("row.limitation ? (");
  });

  it("TEST 3: no explanation is model-written or invents a fact", () => {
    const src = readFileSync("src/client/research-model.ts", "utf-8");
    const fn = src.slice(
      src.indexOf("export function findingExplanation"),
      src.indexOf("function lowerFirst"),
    );
    // Every sentence comes from persisted state: the row's state, its
    // reason-code copy, its coverage, its admitted source classes.
    expect(fn).toContain("row.coverage === \"BLOCKED\"");
    expect(fn).toContain("row.reason");
    expect(fn).toContain("row.sourceClasses");
    expect(fn).toContain("COMPONENT_PHRASES[row.component]");
    // And nothing reaches a provider.
    expect(fn).not.toContain("fetch(");
    expect(fn).not.toContain("await");
  });
});

/* ------------------------------------------------------------------ */
/* 4-6. PROOF LIVES INSIDE ITS FINDING                                 */
/* ------------------------------------------------------------------ */

describe("proof is attached to the conclusion it proves", () => {
  it("TEST 4: a finding carries only its own component's evidence", () => {
    const html = render(
      createElement(ResultLadder, {
        components: COMPONENTS,
        questionFindings: QUESTION_FINDINGS,
        evidenceByComponent: {
          DESTINATION: [evidenceItem({ id: "ev-dest", fragment: "destination passage" })],
          RECIPIENT: [evidenceItem({ id: "ev-recip", fragment: "recipient passage" })],
        },
      }),
    );
    // Rows are closed by default, so neither fragment is on screen yet —
    // which is itself the point: no document appears before its
    // conclusion is opened.
    expect(html).not.toContain("destination passage");
    expect(html).not.toContain("recipient passage");
    expect(html).not.toContain('data-testid="finding-evidence"');
  });

  it("TEST 4b: the evidence map is keyed per component, so no cross-contamination is possible", () => {
    // The structural guarantee: a row is handed evidenceByComponent[its own
    // component] and has no access to any other key.
    const src = readFileSync(LADDER, "utf-8");
    expect(src).toContain("evidence: evidenceByComponent?.[row.component] ?? []");
    // FindingEvidence receives that array and renders it — it never
    // filters, joins or looks anything up itself.
    expect(src).toContain("items: EvidenceItemLike[]");
    expect(src).not.toContain("evidenceByComponent[");
  });

  it("TEST 5: evidence under a finding comes only from persisted links, never text", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain("const evidenceByComponent: Record<string, EvidenceItemLike[]> = {}");
    expect(page).toContain("for (const link of e.links)");
    // An EXCLUDED link can never become proof of anything.
    expect(page).toContain('if (link.role === "EXCLUDED") continue');
    expect(page).toContain("evidenceByComponent[link.component]");
  });

  it("TEST 6: the strongest source leads and the rest stay behind a count", () => {
    const src = readFileSync(LADDER, "utf-8");
    expect(src).toContain("const [primary, ...rest] = items");
    expect(src).toContain('data-testid="toggle-supporting-sources"');

    // PROVENANCE, THEN THE PASSAGE, THEN WHAT IT CANNOT SETTLE.
    // The card opens by naming who said it and what kind of source they
    // are, because a card that opened straight into a quotation looked
    // like text this product had written about itself.
    const item = src.slice(src.indexOf("function EvidenceItem"));
    expect(item.indexOf("Source\n")).toBeLessThan(item.indexOf("Relevant excerpt"));
    expect(item.indexOf("Relevant excerpt")).toBeLessThan(item.indexOf("Why this source"));
    expect(item.indexOf("Why this source")).toBeLessThan(item.indexOf("Source limit"));
    expect(item).toContain("<blockquote");
    expect(item).toContain("{item.fragment}");

    // The model's paraphrase of the passage is NOT here: it is the same
    // sentence the collapsed row already showed, and reading one fact
    // three times on the way down is what made depth feel like padding.
    expect(item).not.toContain("{item.summary}");
    expect(item).not.toContain("Supports:");
  });
});

/* ------------------------------------------------------------------ */
/* 7. NO GENERIC EVIDENCE WALL ON THE NORMAL RESULT                    */
/* ------------------------------------------------------------------ */

describe("the normal result carries no document list", () => {
  it("TEST 7: EvidenceSection renders only inside the full audit", () => {
    const page = readFileSync(PAGE, "utf-8");
    const auditAt = page.indexOf("Full research audit");
    const sectionAt = page.indexOf("<EvidenceSection");
    expect(auditAt).toBeGreaterThan(-1);
    expect(sectionAt).toBeGreaterThan(-1);
    // The only EvidenceSection on the page is below the audit summary.
    expect(sectionAt).toBeGreaterThan(auditAt);
    expect((page.match(/<EvidenceSection/g) ?? [])).toHaveLength(1);
    // And the answer panel no longer offers a route into a document pile.
    expect(page).not.toContain('data-testid="answer-view-evidence"');
    expect(page).not.toContain("View evidence");
  });

  it("TEST 8: the full audit still holds the complete inventory", () => {
    const page = readFileSync(PAGE, "utf-8");
    const audit = page.slice(page.indexOf("Full research audit"));
    // Used, refused and merely-read all still reach it, with counts.
    for (const prop of ["admittedDocs", "excludedDocs", "otherDocs", "readCount", "usedCount"]) {
      expect(audit, prop).toContain(prop);
    }
    // The complete Pattern component view is there too.
    expect(audit).toContain('data-testid="audit-full-ladder"');
    // And the section itself still separates refused from used.
    const section = readFileSync("src/client/components/evidence-section.tsx", "utf-8");
    expect(section).toContain("Sources ATLAS checked but did not use");
    expect(section).toContain("Other material read");
  });
});

/* ------------------------------------------------------------------ */
/* 9-11. INDEPENDENT EXPANSION                                         */
/* ------------------------------------------------------------------ */

describe("findings open and close independently", () => {
  it("TEST 9: open state is a set, not a single slot", () => {
    const src = readFileSync(LADDER, "utf-8");
    // The accordion is gone: a Set holds every open row at once.
    expect(src).toContain("useState<ReadonlySet<string>>(new Set())");
    // The single-slot accordion is gone: no row is compared against one
    // "currently open" value, and no setter assigns one.
    expect(src).not.toContain("openRow === row.component");
    expect(src).not.toMatch(/setOpenRow\b/);
    expect(src).toContain("openRows.has(row.component)");
    // Toggling adds or removes ONE key and leaves the others untouched —
    // this is what makes opening B not close A, and closing A not close B.
    const toggle = src.slice(src.indexOf("const toggle ="), src.indexOf("const view ="));
    expect(toggle).toContain("const next = new Set(prev)");
    expect(toggle).toContain("next.delete(component)");
    expect(toggle).toContain("next.add(component)");
    expect(toggle).not.toContain("new Set()");
  });

  it("TEST 10: proof state is local to its own row", () => {
    const src = readFileSync(LADDER, "utf-8");
    const rowFn = src.slice(src.indexOf("function LadderRow"), src.indexOf("function FindingEvidence"));
    // Declared INSIDE LadderRow, so each row owns its own proof state and
    // opening proof cannot reach another finding or close its own.
    expect(rowFn).toContain("const [proofOpen, setProofOpen] = useState(false)");
    expect(rowFn).toContain("onToggle={() => setProofOpen((v) => !v)}");
    // Toggling proof never touches the row's own open state: the row's
    // `onToggle` is wired to its header button and nothing else.
    expect(rowFn).toContain("onClick={onToggle}");
    expect((rowFn.match(/onClick=\{onToggle\}/g) ?? [])).toHaveLength(1);
  });

  it("TEST 11: every row exposes its own open state for inspection", () => {
    const html = render(
      createElement(ResultLadder, {
        components: COMPONENTS,
        questionFindings: QUESTION_FINDINGS,
      }),
    );
    expect(html.match(/data-testid="ladder-row"/g) ?? []).toHaveLength(3);
    // All closed initially, each carrying its own state attribute.
    expect(html.match(/data-open="false"/g) ?? []).toHaveLength(3);
    expect(html).not.toContain('data-open="true"');
  });
});

/* ------------------------------------------------------------------ */
/* 12-15. NOTHING CANONICAL MOVED                                      */
/* ------------------------------------------------------------------ */

describe("presentation only — no conclusion was strengthened or weakened", () => {
  it("TEST 12: status still comes from the canonical component row", () => {
    const rows = deriveQuestionFindings(QUESTION_FINDINGS, COMPONENTS);
    expect(rows.map((r) => r.stateLabel)).toEqual([
      "Established",
      "Not established",
      "Established",
    ]);
    // A prettier explanation cannot lift an unresolved row.
    expect(rows[1].state).toBe("UNRESOLVED");
    expect(findingExplanation(rows[1]).join(" ")).not.toContain("establishes ");
  });

  it("TEST 13: a contradiction stays distinct from an unresolved finding", () => {
    const [contradicted] = deriveQuestionFindings(
      [QUESTION_FINDINGS[0]],
      [{ component: "DESTINATION", status: "CONTRADICTED", coverage: "COMPLETED" }],
    );
    expect(contradicted.stateLabel).toBe("Evidence indicates otherwise");
    // Still a statement about what the SOURCES show, never a bare
    // assertion of the negative.
    expect(findingExplanation(contradicted).join(" ")).toContain("the sources point the other way");
  });

  it("TEST 14: no model call and no research call was added", () => {
    for (const file of [LADDER, PAGE, "src/client/research-model.ts"]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("question-projection-anthropic");
      expect(src, file).not.toContain("generateQuestionProjection");
      expect(src, file).not.toContain("anthropic");
    }
    // The projection contract itself is untouched by this round.
    const projection = readFileSync("src/server/engine/question-projection.ts", "utf-8");
    expect(projection).toContain("export const PROJECTION_VERSION = 1");
  });

  it("TEST 15: no project-specific rule reaches the presentation layer", () => {
    for (const file of [LADDER, "src/client/research-model.ts"]) {
      const src = readFileSync(file, "utf-8");
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      for (const token of ["Raydium", "raydium", "RAY", "pump", "Solana", "buyback"]) {
        expect(code, `${file}:${token}`).not.toContain(token);
      }
    }
  });
});
