import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DictScope } from "../src/client/app-context";
import { EvidenceCardView, ResearchResult } from "../src/client/components/research-result";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { buildResultSurface, PROOF_PATH_ORDER, tableRows } from "../src/client/result-surface";
import { RESULT_FIXTURES, resultFixture } from "../src/client/result-surface-fixtures";

// V7 DESIGN HANDOFF — STEP 4: THE PROOF (docs/design/v7, HANDOFF §4.3).
// The ring, the path strip and the checks bar are new presentations of the
// SAME statuses (D6); "What remains unclear" is one card per unresolved
// link (owner decision 2026-10-13) whose chip is boundaryOf(...).kind and
// nothing else; "What could help" is one template per kind; the excluded
// list holds only what the engine excluded for that component.

const render = (key: string, dict = en) => {
  const { detail } = resultFixture(key);
  return renderToStaticMarkup(createElement(DictScope, { dict }, createElement(ResearchResult, { detail, jobId: detail.job.id })));
};
const attrValues = (h: string, testid: string, attr: string) =>
  [...h.matchAll(new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`, "g"))].map((m) => new RegExp(`data-${attr}="([^"]*)"`).exec(m[0])?.[1] ?? "");
const textOf = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const block = (h: string, from: string) => h.slice(h.indexOf(`data-testid="${from}"`));

describe("answer panel — the ring", () => {
  it("one segment per checked component, in PROOF_PATH_ORDER, in its own status", () => {
    for (const f of RESULT_FIXTURES) {
      const surface = buildResultSurface(f.detail);
      const html = render(f.key);
      const segs = [...html.matchAll(/class="ring-seg" data-status="([A-Z_]+)"/g)].map((m) => m[1]);
      expect(segs, f.key).toEqual(surface.chain.map((n) => n.status));
      const order = surface.chain.map((n) => (PROOF_PATH_ORDER as readonly string[]).indexOf(n.component));
      expect([...order].sort((a, b) => a - b), f.key).toEqual(order);
    }
  });

  it("the centre reads confirmed / total from the same statuses — never animated, never estimated", () => {
    const surface = buildResultSurface(resultFixture("2").detail);
    const confirmed = surface.chain.filter((n) => n.status === "CONFIRMED").length;
    const text = textOf(block(render("2"), "proof-ring"));
    expect(text).toContain(`${confirmed} /${surface.chain.length}`);
    const css = readFileSync("app/globals.css", "utf8");
    for (const sel of [".proof-ring-n {", ".figure-n {"]) {
      const at = css.indexOf(`\n${sel}`);
      expect(css.slice(at, css.indexOf("}", at)), sel).not.toMatch(/animation/);
    }
  });

  it("the old proof map is replaced, not added beside (D6)", () => {
    const code = readFileSync("src/client/components/research-result.tsx", "utf8");
    expect(code).not.toMatch(/ProofMap|proof-map/);
  });
});

describe("path strip and checks bar", () => {
  it("the strip and the bar carry the same components in the same order as the ring", () => {
    const surface = buildResultSurface(resultFixture("4").detail);
    const html = render("4");
    expect(attrValues(html, "path-node", "component")).toEqual(surface.chain.map((n) => n.component));
    const bar = [...html.matchAll(/class="checks-seg" data-status="([A-Z_]+)"/g)].map((m) => m[1]);
    expect(bar).toEqual(surface.chain.map((n) => n.status));
  });

  it("an unresolved check is a compact row: the question and 'Unresolved · its own reason'", () => {
    const surface = buildResultSurface(resultFixture("3").detail);
    const html = render("3");
    for (const r of tableRows(surface.table).filter((r) => r.status === "NOT_ESTABLISHED")) {
      const at = html.indexOf(`data-component="${r.component}" data-status="NOT_ESTABLISHED"`);
      expect(at, r.component).toBeGreaterThan(-1);
      const row = textOf(html.slice(at, html.indexOf("</li>", at)));
      expect(row).toContain(`${en.result.stateWords.NOT_ESTABLISHED} · ${r.established}`);
    }
  });
});

describe("what remains unclear", () => {
  it("one card per unresolved link, in path order; the chip is the boundary kind's own word", () => {
    for (const f of RESULT_FIXTURES) {
      const surface = buildResultSurface(f.detail);
      const html = render(f.key);
      const expected = surface.outcomeKind === "VERDICT" ? surface.chain.filter((n) => n.status === "NOT_ESTABLISHED") : [];
      expect(attrValues(html, "unclear-group", "component"), f.key).toEqual(expected.map((n) => n.component));
      for (const n of expected) {
        const row = surface.table.find((r) => r.component === n.component)!;
        const kind = row.boundary?.kind ?? "SUBSTANTIVE";
        const at = html.indexOf(`data-testid="unclear-group" data-kind="${kind}" data-component="${n.component}"`);
        expect(at, `${f.key}/${n.component}`).toBeGreaterThan(-1);
        const card = html.slice(at, html.indexOf("</li>", at));
        expect(card).toContain(`>${en.result.boundaryChips[kind]}<`);
        expect(textOf(card)).toContain(en.result.helpTemplates[kind]);
      }
    }
  });

  it("'Not fully checked' appears only for a technical boundary; 'No supported verification route' only for configuration", () => {
    for (const f of RESULT_FIXTURES) {
      const html = render(f.key);
      const kinds = attrValues(html, "unclear-group", "kind");
      const t = textOf(block(html, "unclear-section"));
      expect(t.split(en.result.boundaryChips.TECHNICAL).length - 1, f.key).toBe(kinds.filter((k) => k === "TECHNICAL").length);
      expect(t.split(en.result.boundaryChips.CONFIGURATION).length - 1, f.key).toBe(kinds.filter((k) => k === "CONFIGURATION").length);
    }
  });

  it("the excluded list holds only what the engine excluded for that component, and is absent when there is none", () => {
    for (const f of RESULT_FIXTURES) {
      const html = render(f.key);
      const surface = buildResultSurface(f.detail);
      for (const component of attrValues(html, "unclear-group", "component")) {
        const at = html.indexOf(`data-component="${component}"`, html.indexOf('data-testid="unclear-section"'));
        const card = html.slice(at, html.indexOf("</li>", at));
        const excluded = f.detail.components.find((c) => c.component === component)?.excludedEvidence ?? [];
        if (excluded.length === 0) expect(card, `${f.key}/${component}`).not.toContain("excluded-toggle");
        else expect(textOf(card), `${f.key}/${component}`).toContain(en.result.excludedToggle(excluded.length));
      }
      expect(surface).toBeTruthy();
    }
  });

  it("the copy never says blocked, not found or no evidence — in either language", () => {
    for (const dict of [en, ru]) {
      const all = [
        ...Object.values(dict.result.boundaryChips),
        ...Object.values(dict.result.boundaryHints),
        ...Object.values(dict.result.helpTemplates),
        dict.result.unclearClosing,
        dict.result.unclearSub,
      ].join(" ").toLowerCase();
      expect(all).not.toMatch(/blocked|not found|no evidence|заблокир|не найден|нет доказательств/);
    }
    expect(Object.keys(ru.result.helpTemplates).sort()).toEqual(Object.keys(en.result.helpTemplates).sort());
  });

  it("one card is open on arrival and the rest keep their content hidden until opened", () => {
    const html = render("4");
    const open = (html.match(/class="unclear-card unclear-card-open"/g) ?? []).length;
    expect(open).toBe(1);
    const hidden = (html.match(/hidden="" data-testid="unclear-copy"/g) ?? []).length;
    expect(hidden).toBe(attrValues(html, "unclear-group", "component").length - 1);
  });
});

describe("evidence rows", () => {
  it("open evidence: the excerpt marked, what this kind of source establishes, and what this passage does not establish", () => {
    const surface = buildResultSurface(resultFixture("2").detail);
    const card = tableRows(surface.table).flatMap((r) => r.evidence).find((c) => !c.onchain && c.doesNotProve)!;
    const html = renderToStaticMarkup(createElement(DictScope, { dict: en }, createElement(EvidenceCardView, { card, jobId: null, open: true })));
    expect(html).toContain('<mark class="highlight">');
    expect(textOf(html)).toContain(en.result.evidenceRows.establishes);
    expect(textOf(html)).toContain(en.result.evidenceRows.notEstablishes);
    expect(textOf(html)).toContain(card.doesNotProve!);
  });
});

describe("motion (HANDOFF §4.9)", () => {
  it("segments draw once, bars grow once; all stop under reduced motion", () => {
    const css = readFileSync("app/globals.css", "utf8");
    for (const sel of [".ring-seg {", ".checks-seg {", ".path-mark-v7 {"]) {
      const at = css.indexOf(`\n${sel}`);
      expect(css.slice(at, css.indexOf("}", at)), sel).not.toContain("infinite");
    }
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    for (const sel of [".ring-seg", ".proof-ring-center", ".confidence-on", ".checks-seg", ".path-mark-v7"]) expect(reduced, sel).toContain(sel);
  });
});
