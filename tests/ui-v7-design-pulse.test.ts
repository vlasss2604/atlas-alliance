import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PulsePage from "../app/(app)/pulse/page";
import { DictScope } from "../src/client/app-context";
import { PulseCard } from "../src/client/components/pulse-card";
import { setDisplayLanguage } from "../src/client/display-language";
import { en, type Dict } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { pulseItems } from "../src/client/pulse-fixtures";

// V7 STEP 8 — PULSE, CLAIM-LED (HANDOFF §4.6, §5a).
//
// A card leads with what was CLAIMED and the question a Research would
// answer about it. These tests pin that the new parts are fixture data and
// dictionary words only, that nothing on the screen pretends to be live,
// and that the Verify handoff is unchanged (the claim text, as on 07).

const PAGE = "app/(app)/pulse/page.tsx";
const CARD = "src/client/components/pulse-card.tsx";
const HOME = "app/(app)/home/page.tsx";
const CSS = "app/globals.css";
const NOW = Date.parse("2026-10-13T12:00:00.000Z");

const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const card = (dict: Dict, index = 0) =>
  renderToStaticMarkup(
    createElement(DictScope, { dict }, createElement("ul", null, createElement(PulseCard, { item: pulseItems()[index], now: NOW }))),
  );

describe("Pulse fixtures — every card carries its verify question", () => {
  it("each fixture has a question in EN and RU, a question and never a link", () => {
    for (const item of pulseItems()) {
      const { EN, RU } = item.verifyQuestion;
      expect(EN.trim().length, item.id).toBeGreaterThan(10);
      expect(RU.trim().length, item.id).toBeGreaterThan(10);
      expect(EN.endsWith("?"), item.id).toBe(true);
      expect(RU.endsWith("?"), item.id).toBe(true);
      expect(RU, item.id).toMatch(/[А-Яа-яЁё]/);
      for (const q of [EN, RU]) expect(q, item.id).not.toMatch(/https?:\/\/|x\.com|twitter\.com/i);
      // Still no invented provenance.
      expect(item.sourceUrl, item.id).toBeNull();
    }
  });

  it("the questions are the designer's, verbatim (source/V2-Pulse.dc.html)", () => {
    const raydium = pulseItems().find((i) => i.id === "raydium-buyback-week")!;
    expect(raydium.verifyQuestion.EN).toBe("Does the documented mechanism match actual execution?");
    expect(raydium.verifyQuestion.RU).toBe("Соответствует ли задокументированный механизм реальному исполнению?");
  });
});

describe("Pulse card — claim-led", () => {
  it("source, meta, Claimed, the claim verbatim, the question, one Verify", () => {
    setDisplayLanguage("EN");
    const item = pulseItems()[0];
    const html = card(en);
    const at = (needle: string) => html.indexOf(needle);
    expect(at('data-testid="pulse-source-name"')).toBeLessThan(at('data-testid="pulse-source-type"'));
    expect(at('data-testid="pulse-source-type"')).toBeLessThan(at('data-testid="pulse-claimed"'));
    expect(at('data-testid="pulse-claimed"')).toBeLessThan(at('data-testid="pulse-text"'));
    expect(at('data-testid="pulse-text"')).toBeLessThan(at('data-testid="pulse-verify-question"'));
    expect(at('data-testid="pulse-verify-question"')).toBeLessThan(at('data-testid="pulse-verify"'));
    expect(html).toContain(">Claimed<");
    expect(html).toContain(item.verifyQuestion.EN);
    expect(html).toContain(`href="/home?pulse=${item.id}"`);
    expect(html).toContain("Verify with ATLAS");
    expect(html).not.toContain('data-testid="pulse-open-source"');
  });

  it("the question follows the display language; the claim stays as written", () => {
    setDisplayLanguage("RU");
    const item = pulseItems()[0];
    const html = card(ru);
    expect(html).toContain(item.verifyQuestion.RU);
    expect(html).not.toContain(item.verifyQuestion.EN);
    expect(html).toContain(item.text);
    expect(html).toContain(">Заявлено<");
    expect(html).toContain("Проверить в ATLAS");
    setDisplayLanguage("EN");
  });

  it("the source type is tinted by its kind, from the record", () => {
    const html = renderToStaticMarkup(
      createElement(DictScope, { dict: en }, createElement("ul", null, ...pulseItems().map((item) => createElement(PulseCard, { key: item.id, item, now: NOW })))),
    );
    expect(html).toMatch(/data-type="OFFICIAL_PROJECT" data-testid="pulse-source-type">Project claim</);
    expect(html).toMatch(/data-type="RESEARCH_DATA" data-testid="pulse-source-type">Research &amp; data</);
    const css = readFileSync(CSS, "utf8");
    expect(css).toContain('.pulse-type[data-type="OFFICIAL_PROJECT"] {\n  color: #8ee6ff;');
    expect(css).toContain('.pulse-type[data-type="RESEARCH_DATA"] {\n  color: #b9c4ff;');
  });
});

describe("Pulse screen — nothing pretends to be live", () => {
  it("the heartbeat is a static drawing", () => {
    const page = codeOf(PAGE);
    expect(page).toContain("<HeartbeatLine />");
    expect(page).not.toMatch(/<animate|strokeDasharray|ap-line/);
    const css = readFileSync(CSS, "utf8");
    const rule = css.slice(css.indexOf("\n.pulse-heartbeat {"), css.indexOf("}", css.indexOf("\n.pulse-heartbeat {")));
    expect(rule).not.toMatch(/animation|transition/);
  });

  it("the sample notice is grey, never amber", () => {
    const page = codeOf(PAGE);
    expect(page).not.toMatch(/amber/i);
    const css = readFileSync(CSS, "utf8");
    const block = css.slice(css.indexOf("\n.pulse-sample {"), css.indexOf("\n.pulse-h2 {"));
    expect(block).not.toMatch(/--atlas-amber|#e6b54d|251, 191, 36/i);
    expect(block).toContain("dashed");
  });

  it("cards enter once, settle by ~0.4s, and the CTA stops under reduced motion", () => {
    expect(codeOf(CARD)).toContain("animationDelay: `${60 + Math.min(index, 2) * 40}ms`");
    const css = readFileSync(CSS, "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .pulse-cta"));
    expect(reduced.slice(0, 120)).toContain("transition: none");
  });

  it("the whole screen renders every fixture, the notice, Fresh and Earlier", () => {
    setDisplayLanguage("EN");
    const html = renderToStaticMarkup(createElement(DictScope, { dict: en }, createElement(PulsePage)));
    const escaped = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");
    for (const item of pulseItems()) {
      expect(html).toContain(escaped(item.text));
      expect(html).toContain(escaped(item.verifyQuestion.EN));
    }
    expect(html).toContain('data-testid="pulse-sample-notice"');
    expect(html).toContain('data-testid="pulse-fresh"');
    expect(html).toContain('data-testid="pulse-earlier"');
    expect(html).toContain(">Fresh<");
  });
});

describe("Pulse in Russian", () => {
  it("every ATLAS-owned word on the screen is Russian, the new question included", () => {
    setDisplayLanguage("RU");
    const html = renderToStaticMarkup(createElement(DictScope, { dict: ru }, createElement(PulsePage)));
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"");
    // The record's own words (claim, handles, names, tickers) stay as written.
    const record = pulseItems()
      .flatMap((i) => [i.text, i.source.handle, i.source.displayName, i.project.name, i.project.ticker ?? ""])
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    let rest = text;
    for (const r of record) rest = rest.split(r).join(" ");
    const latin = [...rest.matchAll(/[A-Za-z][A-Za-z'’]*/g)]
      .map((m) => m[0])
      .filter((w) => !["ATLAS", "X", "Pulse", "PUM", "JI"].includes(w));
    expect(latin).toEqual([]);
    for (const item of pulseItems()) expect(text).toContain(item.verifyQuestion.RU);
    setDisplayLanguage("EN");
  });
});

describe("Pulse copy (HANDOFF §5a) and the unchanged handoff", () => {
  it("EN and RU carry the approved words", () => {
    expect(en.pulse.claimed).toBe("Claimed");
    expect(ru.pulse.claimed).toBe("Заявлено");
    expect(en.pulse.verify).toBe("Verify with ATLAS");
    expect(ru.pulse.verify).toBe("Проверить в ATLAS");
    expect(en.pulse.fresh).toBe("Fresh");
    expect(ru.pulse.fresh).toBe("Свежие");
    expect(en.pulse.sourceTypes).toEqual({ OFFICIAL_PROJECT: "Project claim", RESEARCH_DATA: "Research & data" });
    expect(ru.pulse.sourceTypes).toEqual({ OFFICIAL_PROJECT: "Заявление проекта", RESEARCH_DATA: "Исследования и данные" });
    expect(Object.keys(ru.pulse).sort()).toEqual(Object.keys(en.pulse).sort());
  });

  it("Verify still prefills the claim text, as 07-verify-from-pulse shows", () => {
    expect(codeOf(HOME)).toContain('initialQuestion={pulse.kind === "open" ? pulse.item.text : ""}');
  });
});
