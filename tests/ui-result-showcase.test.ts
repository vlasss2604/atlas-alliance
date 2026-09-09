import { readFileSync, readdirSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ResultShowcase } from "../src/client/components/result-blocks/result-showcase";
import {
  FIXTURE_CHART,
  FIXTURE_TABLE_ROWS,
} from "../src/client/result-showcase-fixture";
import { PROOF_STATE } from "../src/client/components/result-blocks/types";

// RESULT STRUCTURE V1 — THE PRESENTATION LANGUAGE, BEFORE IT MEETS THE ENGINE.
//
// A dev-only page that renders every analytical block at once from invented
// values, so the STRUCTURE of a result can be judged before the blocks are
// wired to real findings.
//
// Two things must stay true of it, and they are what these tests hold:
//
//   IT IS UNMISTAKABLY A FIXTURE. It shows a complete, confident-looking
//   research result made entirely of numbers nobody researched. If it ever
//   reached a production build, or lost its label, a screenshot of it could
//   circulate as a finding.
//
//   IT TOUCHES NOTHING. No database, no provider, no model, no research
//   state. It is absent from research history by construction — no row was
//   ever written — rather than by being filtered out of a list.

const BLOCKS_DIR = "src/client/components/result-blocks";
const FIXTURE = "src/client/result-showcase-fixture.ts";
const PAGE = "app/(app)/dev/result-showcase/page.tsx";

const html = renderToStaticMarkup(createElement(ResultShowcase));

/* ------------------------------------------------------------------ */
/* 1. IT CANNOT BE MISTAKEN FOR A RESULT                               */
/* ------------------------------------------------------------------ */

describe("the fixture announces itself", () => {
  it("carries an unmissable label at the very top", () => {
    expect(html).toContain('data-testid="fixture-banner"');
    expect(html.toLowerCase()).toContain("not a real research result");
    // The banner is the first thing in the composition, before the answer.
    expect(html.indexOf("fixture-banner")).toBeLessThan(html.indexOf("block-answer"));
  });

  it("is gated out of a production build by the server, not by a hidden link", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain('process.env.NODE_ENV === "production"');
    expect(page).toContain("notFound()");
  });

  it("names no real project, token or address", () => {
    const fixture = readFileSync(FIXTURE, "utf-8");
    for (const name of [
      "Raydium", "RAY", "Pump.fun", "PUMP", "Solana", "Uniswap", "Jupiter", "Ethereum",
    ]) {
      expect(fixture, name).not.toContain(name);
    }
    // The one address prefix a reader might recognise from real fixtures.
    expect(fixture).not.toContain("DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz");
  });
});

/* ------------------------------------------------------------------ */
/* 2. IT READS AND WRITES NOTHING                                      */
/* ------------------------------------------------------------------ */

describe("the showcase is inert", () => {
  it("no block reaches a database, a provider or a model", () => {
    const files = readdirSync(BLOCKS_DIR).map((f) => `${BLOCKS_DIR}/${f}`);
    for (const file of [...files, FIXTURE, PAGE]) {
      const src = readFileSync(file, "utf-8");
      for (const forbidden of [
        "anthropic", "getDb", "drizzle", "pg-boss", "researchJobs", "api.", "fetch(",
      ]) {
        expect(src, `${file} :: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the route creates no research job, so history has nothing to filter", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page).not.toContain("insert");
    expect(page).not.toContain("createResearchJob");
    // It renders a constant component and nothing else.
    expect(page).toContain("<ResultShowcase />");
  });
});

/* ------------------------------------------------------------------ */
/* 3. EVERY BLOCK IS PRESENT, IN ORDER                                 */
/* ------------------------------------------------------------------ */

describe("the ten blocks compose one result", () => {
  const ORDER = [
    "block-answer",
    "block-proof-map",
    "block-metrics",
    "block-flow",
    "block-table",
    "block-chart",
    "block-timeline",
    "block-entities",
    "block-evidence",
    "block-deep-proof",
  ];

  it("all ten render", () => {
    for (const id of ORDER) expect(html, id).toContain(`data-testid="${id}"`);
  });

  it("they appear in the intended reading order", () => {
    const positions = ORDER.map((id) => html.indexOf(`data-testid="${id}"`));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("each kind of information gets its own structure, not a card of prose", () => {
    // The failure this page exists to avoid is ten identical panels. These
    // are the structures that make them different from each other.
    expect(html).toContain('data-testid="proof-cell"'); // a grid
    expect(html).toContain('data-testid="metric-tile"'); // a number strip
    expect(html).toContain('data-testid="flow-connector"'); // a diagram
    expect(html).toContain("<table"); // a real table
    expect(html).toContain('data-testid="chart-svg"'); // a chart
    expect(html).toContain('data-testid="timeline-event"'); // a dated rail
    expect(html).toContain('data-testid="entity-address"'); // an address object
    expect(html).toContain('data-testid="evidence-fragment"'); // a quotation
  });
});

/* ------------------------------------------------------------------ */
/* 4. THE PRODUCT'S DISCIPLINE SURVIVES THE REDESIGN                   */
/* ------------------------------------------------------------------ */

describe("structure did not cost the epistemic rules", () => {
  it("an unestablished period is an empty slot in the chart, never a zero", () => {
    // A zero is a measurement — "no tokens were acquired" — and it is a
    // different claim from "this research could not establish how many".
    const missing = FIXTURE_CHART.filter((p) => p.value === null);
    expect(missing.length).toBeGreaterThan(0);
    for (const p of missing) expect(p.value).not.toBe(0);
    expect(html).toContain("established</tspan>");
  });

  it("an unestablished table figure is a dash, never a zero", () => {
    const open = FIXTURE_TABLE_ROWS.find((r) => r.state === "NOT_ESTABLISHED")!;
    expect(open.cells.acquired).toBe("—");
    expect(open.cells.burned).toBe("—");
  });

  it("the flow shows where the proof stops, in words", () => {
    expect(html).toContain('data-testid="flow-break"');
    expect(html).toContain("Evidence stops here");
    // Once, not once per broken link — the first break is the finding.
    expect(html.split('data-testid="flow-break"').length - 1).toBe(1);
  });

  it("every evidence snapshot states what it does NOT establish", () => {
    const count = html.split('data-testid="evidence-snapshot"').length - 1;
    expect(count).toBeGreaterThanOrEqual(4);
    expect(html.split("What it does not establish").length - 1).toBe(count);
  });

  it("the timeline keeps documented, approved, activated and executed apart", () => {
    for (const kind of ["DOCUMENTED", "APPROVED", "ACTIVATED", "EXECUTED"]) {
      expect(html, kind).toContain(`data-kind="${kind}"`);
    }
  });

  it("no state is carried by colour alone", () => {
    // Every state's own words appear in the markup wherever its colour does.
    for (const [, meta] of Object.entries(PROOF_STATE)) {
      if (!html.includes(meta.color)) continue;
      expect(html, meta.label).toContain(meta.label);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. MOBILE SAFETY                                                    */
/* ------------------------------------------------------------------ */

describe("430px is the design target, not an afterthought", () => {
  it("the table is the ONLY block allowed a fixed minimum width", () => {
    // It is the one surface where six comparable measures cannot honestly
    // fit a phone, so it scrolls inside its own frame with the key column
    // pinned. Everywhere else a fixed width is how a column silently ends
    // up off-screen.
    for (const f of readdirSync(BLOCKS_DIR)) {
      const src = readFileSync(`${BLOCKS_DIR}/${f}`, "utf-8");
      if (f === "analytical-table.tsx") {
        expect(src).toContain("min-w-[38rem]");
        expect(src).toContain("overflow-x-auto");
        expect(src).toContain("sticky left-0");
        continue;
      }
      expect(src, `${f} must not set a minimum width`).not.toContain("min-w-[");
      expect(src, `${f} must not scroll sideways`).not.toContain("overflow-x-auto");
    }
  });

  it("the deliberate scroll is announced rather than silent", () => {
    expect(html).toContain('data-testid="table-scroll-hint"');
    expect(html).toContain("swipe for all columns");
  });

  it("an address is never truncated — a clipped address is a different address", () => {
    const src = readFileSync(`${BLOCKS_DIR}/entity-list.tsx`, "utf-8");
    expect(src).toContain("break-all");
    expect(src).not.toContain("truncate");
    for (const e of ["7xK9fVn2QsWmT4aBcDeFgHjKpLmNoPqRsTuVwXyPq21"]) {
      expect(html).toContain(e);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. NO SELECTION LOGIC WAS BUILT                                     */
/* ------------------------------------------------------------------ */

describe("the adapter is deliberately absent", () => {
  it("nothing decides which block a finding belongs in", () => {
    // That rule is the NEXT decision, and writing it before the language is
    // approved would encode a layout nobody has agreed to.
    for (const f of readdirSync(BLOCKS_DIR)) {
      const src = readFileSync(`${BLOCKS_DIR}/${f}`, "utf-8");
      expect(src, f).not.toContain("ComponentResult");
      expect(src, f).not.toContain("reconcile");
      expect(src, f).not.toContain("questionFindings");
    }
  });

  it("no chart dependency was added to the project", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const lib of ["recharts", "chart.js", "d3", "victory", "nivo", "visx", "echarts"]) {
      expect(Object.keys(all), lib).not.toContain(lib);
    }
  });
});
