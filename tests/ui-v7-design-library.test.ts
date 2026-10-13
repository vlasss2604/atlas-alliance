import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResearchJobListItem } from "../src/client/api";
import { ResearchGroupCard } from "../src/client/components/research-group-card";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { LIBRARY_FILTERS, libraryCounts, matchesFilter, verdictBar } from "../src/client/library-filter";
import { groupResearchRuns } from "../src/client/research-model";

// V7 STEP 7 — THE RESEARCH LIBRARY (HANDOFF §4.5, D7).
//
// The overview (count, verdict bar, filter tiles) is new presentation of
// data each row already shows. These tests pin that it stays exactly that:
// a group counts under a verdict only when its pill shows that verdict, the
// bar adds up to every project, and the filter hides rows without changing
// any of them.

const PAGE = "app/(app)/research/page.tsx";
const CARD = "src/client/components/research-group-card.tsx";
const FILTER = "src/client/library-filter.ts";
const CSS = "app/globals.css";

const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function job(over: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    state: "SUCCEEDED",
    progressStage: 5,
    memoryStatus: "NOT_USED",
    acquisitionPhase: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    finishedAt: "2026-10-01T10:20:00.000Z",
    unread: false,
    originalQuestion: "Where do the protocol fees go?",
    projectName: "Project A",
    projectTicker: "PRA",
    projectSlug: "project_a",
    verdict: "SUPPORTED",
    ...over,
  } as ResearchJobListItem;
}

// One group per project; the latest run of each decides its row.
const LIBRARY = groupResearchRuns([
  job({ id: "a1", projectSlug: "a", projectName: "A", verdict: "SUPPORTED" }),
  job({ id: "b1", projectSlug: "b", projectName: "B", verdict: "PARTIALLY_SUPPORTED" }),
  job({ id: "c1", projectSlug: "c", projectName: "C", verdict: "PARTIALLY_SUPPORTED" }),
  job({ id: "d1", projectSlug: "d", projectName: "D", verdict: "INSUFFICIENT_EVIDENCE" }),
  job({ id: "e1", projectSlug: "e", projectName: "E", verdict: "NOT_SUPPORTED" }),
  // A failed latest run — a product fault, not a finding.
  job({ id: "f1", projectSlug: "f", projectName: "F", state: "FAILED", verdict: null }),
  // A budget stop that persisted a verdict: the row's pill shows the
  // stop, so the overview must not count the verdict behind it.
  job({ id: "g1", projectSlug: "g", projectName: "G", state: "BUDGET_LIMIT_REACHED", verdict: "SUPPORTED" }),
  // An older SUPPORTED run of B never outranks its newer partial one.
  job({ id: "b0", projectSlug: "b", projectName: "B", verdict: "SUPPORTED", finishedAt: "2026-09-01T10:00:00.000Z" }),
]);

describe("library overview — counted from what each row shows", () => {
  it("a group counts under a verdict only when its pill is that verdict", () => {
    expect(LIBRARY).toHaveLength(7);
    expect(libraryCounts(LIBRARY)).toEqual({
      ALL: 7,
      SUPPORTED: 1,
      PARTIALLY_SUPPORTED: 2,
      INSUFFICIENT_EVIDENCE: 1,
    });
  });

  it("a failed or budget-stopped latest run is under All alone", () => {
    for (const key of ["f", "g"]) {
      const group = LIBRARY.find((g) => g.key === key)!;
      expect(group, key).toBeDefined();
      expect(LIBRARY_FILTERS.filter((f) => matchesFilter(group, f)), key).toEqual(["ALL"]);
    }
  });

  it("the bar adds up to every project, in a fixed order, grey for no verdict", () => {
    const bar = verdictBar(LIBRARY);
    expect(bar.reduce((n, p) => n + p.count, 0)).toBe(LIBRARY.length);
    expect(bar).toEqual([
      { tone: "supported", count: 1 },
      { tone: "partial", count: 2 },
      { tone: "insufficient", count: 1 },
      { tone: "negative", count: 1 },
      { tone: "neutral", count: 2 },
    ]);
  });

  it("the filter hides rows and never changes one", () => {
    const shown = LIBRARY.filter((g) => matchesFilter(g, "PARTIALLY_SUPPORTED"));
    expect(shown.map((g) => g.key).sort()).toEqual(["b", "c"]);
    expect(shown.every((g) => LIBRARY.includes(g))).toBe(true);
    expect(LIBRARY.filter((g) => matchesFilter(g, "ALL"))).toEqual(LIBRARY);
  });

  it("the module names no project and invents no verdict", () => {
    const code = codeOf(FILTER);
    expect(code).not.toMatch(/raydium|pump|lido|jupiter|jito|aave|morpho/i);
    expect(code).toContain('outcome.kind === "VERDICT"');
  });
});

describe("library page — the overview panel and the tiles", () => {
  const page = codeOf(PAGE);

  it("the count is the real number of groups, shown at once", () => {
    expect(page).toContain("{groups.length}");
    expect(page).not.toMatch(/setInterval|requestAnimationFrame|setTimeout/);
  });

  it("four tiles from LIBRARY_FILTERS, pressed state, disabled when empty", () => {
    expect([...LIBRARY_FILTERS]).toEqual(["ALL", "SUPPORTED", "PARTIALLY_SUPPORTED", "INSUFFICIENT_EVIDENCE"]);
    expect(page).toContain("LIBRARY_FILTERS.map((key) => (");
    expect(page).toContain("aria-pressed={active === key}");
    expect(page).toContain("disabled={counts[key] === 0}");
    expect(page).toContain('role="group" aria-label={dict.research.filterLabel}');
    // A filter left with nothing behind it falls back to All.
    expect(page).toContain('counts[filter] > 0 ? filter : "ALL"');
  });

  it("the list is the filtered groups, through the same row component", () => {
    expect(page).toContain("const shown = groups.filter((group) => matchesFilter(group, active));");
    expect(page).toContain("{shown.map((group) => (");
    expect(page).toContain("<ResearchGroupCard key={group.key} group={group} />");
    // The page derives no verdict of its own.
    expect(page).not.toMatch(/\.verdict\b/);
  });

  it("running work stays first, above the overview", () => {
    expect(page.indexOf("dict.research.inProgress")).toBeLessThan(page.indexOf('data-testid="library-overview"'));
    expect(page.indexOf('data-testid="library-overview"')).toBeLessThan(page.indexOf('data-testid="library-list"'));
  });

  it("every tile label exists in EN and RU", () => {
    for (const key of LIBRARY_FILTERS) {
      expect(en.research.filters[key], key).toBeTruthy();
      expect((ru.research.filters as Record<string, string>)[key], key).toBeTruthy();
    }
    expect(en.research.filterLabel).toBe("Filter by verdict");
    expect(ru.research.filterLabel).toBeTruthy();
  });
});

describe("library row — the V7 list row", () => {
  it("the avatar dot is the pill's own tone, never a second judgement", () => {
    const groups = groupResearchRuns([job({ verdict: "INSUFFICIENT_EVIDENCE" }), job({ id: "job-2", finishedAt: "2026-09-20T10:00:00.000Z" })]);
    const html = renderToStaticMarkup(createElement(ResearchGroupCard, { group: groups[0] }));
    expect(html).toMatch(/class="tone tone-insufficient"[^>]*data-testid="group-latest"/);
    expect(html).toMatch(/class="lib-avatar-dot dot-insufficient"[^>]*data-testid="group-dot"/);
    expect(html).toContain("2 runs");
    expect(html).toContain("last researched");
    expect(readFileSync(CARD, "utf8")).toContain("href={`/research/${");
  });

  it("a failed latest run gets a grey dot and its state pill", () => {
    const groups = groupResearchRuns([job({ state: "FAILED", verdict: null })]);
    const html = renderToStaticMarkup(createElement(ResearchGroupCard, { group: groups[0] }));
    expect(html).toContain("lib-avatar-dot dot-fault");
    expect(html).toContain('data-verdict="NONE"');
  });
});

describe("library motion and colour", () => {
  const css = readFileSync(CSS, "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("the bar parts grow once, with transform only, and stop under reduced motion", () => {
    expect(rule(".lib-bar-part")).toContain("animation: ap-grow 280ms");
    // Staggered 30ms from 60ms: three parts settle by 0.4s (HANDOFF §4.9).
    expect(codeOf(PAGE)).toContain("animationDelay: `${60 + Math.min(i, 4) * 30}ms`");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .lib-bar-part"));
    expect(reduced.slice(0, 120)).toContain("animation: none");
  });

  it("a tile changes by style, not by an animated shadow", () => {
    expect(rule(".lib-filter")).not.toMatch(/transition:[^;]*box-shadow/);
  });

  it("a part with no verdict is grey with no glow — not a result colour", () => {
    const neutral = css.slice(css.indexOf('.lib-bar-part[data-tone="neutral"]'));
    const body = neutral.slice(0, neutral.indexOf("}"));
    expect(body).toContain("#33465c");
    expect(body).not.toContain("box-shadow");
  });
});
