import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { RecentProofCard } from "../src/client/components/recent-proof-card";
import { ResearchGroupCard } from "../src/client/components/research-group-card";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { setDisplayLanguage } from "../src/client/display-language";
import { groupResearchRuns } from "../src/client/research-model";
import { buildResultSurface, RESULT_STATE_WORDS, type AnswerKind } from "../src/client/result-surface";
import { RESULT_FIXTURES } from "../src/client/result-surface-fixtures";

// UI V7 — THE APPROVED FIGMA DIRECTION, APPLIED TO THE REAL PRODUCT.
//
// A visual pass: surfaces, pills, cards, the compact header everywhere,
// a growing composer field, the answer under headings. These tests pin
// the properties that keep it a visual pass — nothing routed, decided,
// strengthened or invented — and the two layout defects it fixes.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CHROME = "src/client/components/app-chrome.tsx";
const COMPOSER = "src/client/components/research-composer.tsx";
const HOME = "app/(app)/home/page.tsx";
const RESULT = "src/client/components/research-result.tsx";
const SURFACE = "src/client/result-surface.ts";
const CSS = "app/globals.css";

const KINDS: AnswerKind[] = ["CONTRADICTED", "CONFIRMED", "PARTIAL", "OPEN", "NONE"];

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
    originalQuestion: "Does Aave currently use protocol revenue to buy back AAVE, and does the bought-back AAVE go to a treasury or reserve rather than being burned?",
    projectName: "Aave",
    projectTicker: "AAVE",
    projectSlug: "aave",
    verdict: "INSUFFICIENT_EVIDENCE",
    ...over,
  } as Parameters<typeof RecentProofCard>[0]["job"];
}

describe("navigation and routes are untouched by the visual pass", () => {
  it("Pulse → /pulse, Verify (the shield) → /home, Proofs → /research, Profile top-right; the dock is three cells", () => {
    const chrome = codeOf(CHROME);
    expect(chrome).toContain('pulse: { href: "/pulse" }');
    expect(chrome).toContain('proofs: { href: "/research" }');
    expect(chrome).toContain('const VERIFY_HREF = "/home";');
    expect(chrome).toContain('const PROFILE_HREF = "/profile";');
    expect(chrome).toMatch(/className=\{`profile-link ml-auto sm:ml-0/);
    expect(readFileSync(CSS, "utf8")).toMatch(/\.dock \{[^}]*grid-template-columns: repeat\(3, 1fr\)/);
    // The compact lockup is now shown on Verify too: the class that used
    // to hide it no longer does.
    expect(readFileSync(CSS, "utf8")).toMatch(/\.brand-lockup-home \{\s*display: flex;\s*\}/);
    expect(codeOf(HOME)).not.toContain("home-brand");
  });
});

describe("the composer field grows but the flow is the same", () => {
  it("one textarea with the same test id, Enter submits, the same interpret → gate → start chain", () => {
    const code = codeOf(COMPOSER);
    expect(code).toContain("<textarea");
    expect(code).toContain('data-testid="composer-input"');
    expect(code).toContain('if (e.key === "Enter" && !e.shiftKey) {');
    expect(code).toContain("const [question, setQuestion] = useState(initialQuestion);");
    expect(code).toContain("setResult(await api.interpret(question));");
    expect(code).toContain("await api.startResearch(interp.id, crypto.randomUUID());");
    // Sized to its content by script, capped by the stylesheet — never a
    // field that swallows the screen.
    expect(code).toContain("el.style.height = `${el.scrollHeight}px`;");
    expect(readFileSync(CSS, "utf8")).toMatch(/\.field-grow \{[^}]*max-height: 11rem;/);
  });
});

describe("list rows: the pill shares the name's line, the question runs full width", () => {
  it("a previously-researched card puts the outcome beside the name and the question beneath, never beside the pill", () => {
    const html = render(createElement(RecentProofCard, { job: job() }));
    const head = html.indexOf('class="history-head"');
    const pill = html.indexOf('data-testid="history-outcome"');
    const question = html.indexOf("Does Aave currently use protocol revenue");
    expect(head).toBeGreaterThan(-1);
    expect(pill).toBeGreaterThan(head);
    expect(question).toBeGreaterThan(pill);
    // The pill is the outcome vocabulary, not a verdict invented for the row.
    expect(html).toContain('data-verdict="INSUFFICIENT_EVIDENCE"');
    expect(html).toContain("Insufficient evidence");
    expect(html).toContain('data-testid="project-avatar"');
  });

  it("a library group card shows the latest outcome as the same pill and keeps the run links", () => {
    const groups = groupResearchRuns([job(), job({ id: "job-2", finishedAt: "2026-09-20T10:00:00.000Z" })]);
    const html = render(createElement(ResearchGroupCard, { group: groups[0] }));
    expect(html).toContain('data-testid="group-latest"');
    expect(html).toMatch(/class="tone tone-insufficient"[^>]*data-testid="group-latest"/);
    expect(html).toContain("2 runs");
    expect(html).toContain('data-testid="project-avatar"');
    expect(readFileSync("src/client/components/research-group-card.tsx", "utf8")).toContain("href={`/research/${");
  });

  it("a long pill wraps inside the card instead of leaving it", () => {
    const css = readFileSync(CSS, "utf8");
    const rule = css.slice(css.indexOf(".history-head .tone {"), css.indexOf(".history-head > span:last-child"));
    expect(rule).toContain("white-space: normal;");
    expect(rule).toContain("max-width: 100%;");
  });
});

describe("the answer blocks: headings come from the writing branch, the sentences are byte-identical", () => {
  it("every part's kind is one of the closed set, and the sentence list is exactly the parts' text", () => {
    for (const f of RESULT_FIXTURES) {
      const s = buildResultSurface(f.detail);
      expect(s.answer.parts.length, f.key).toBe(s.answer.sentences.length);
      expect(s.answer.parts.map((p) => p.text), f.key).toEqual(s.answer.sentences);
      for (const p of s.answer.parts) expect(KINDS, f.key).toContain(p.kind);
      // The kind is recorded where the sentence is written: a confirmed
      // sentence starts the way the confirmed branch writes it, and so on.
      for (const p of s.answer.parts) {
        if (p.kind === "CONFIRMED") expect(p.text, f.key).toMatch(/^The sources confirm /);
        if (p.kind === "PARTIAL") expect(p.text, f.key).toMatch(/^There is evidence /);
        if (p.kind === "OPEN") expect(p.text, f.key).toMatch(/^The available evidence does not show /);
        if (p.kind === "CONTRADICTED") expect(p.text, f.key).toMatch(/the evidence points the other way\.$/);
      }
      // No kind is ever inferred from text: the only kinds come from `say(...)`.
      const nonVerdict = s.outcomeKind !== "VERDICT";
      if (nonVerdict) expect(s.answer.parts.every((p) => p.kind === "NONE"), f.key).toBe(true);
    }
    const surface = codeOf(SURFACE);
    expect(surface).not.toMatch(/kind:\s*text\.(startsWith|includes|match)/);
    expect(surface).toContain('say("CONFIRMED"');
    expect(surface).toContain('say("PARTIAL"');
    expect(surface).toContain('say("OPEN"');
    expect(surface).toContain('say("CONTRADICTED"');
  });

  it("the headings exist in both languages for every kind that can carry one, and the state words are unchanged", () => {
    for (const k of KINDS.filter((x) => x !== "NONE")) {
      expect(en.result.answerHeadings[k], k).toBeTruthy();
      expect(ru.result.answerHeadings[k], k).toBeTruthy();
    }
    expect(RESULT_STATE_WORDS).toEqual({ CONFIRMED: "Verified", PARTIAL: "Partly verified", NOT_ESTABLISHED: "Unresolved", CONTRADICTED: "Contradicted" });
    // The screen maps a block to the glyph of the row state it was written
    // from — the same closed mapping, never a new vocabulary.
    const result = codeOf(RESULT);
    expect(result).toContain('OPEN: "NOT_ESTABLISHED"');
    expect(result).toContain("dict.result.answerHeadings[kind]");
    // The sentences rendered are the surface model's own list; the kind is
    // looked up from the part the model recorded for that exact sentence.
    expect(result).toContain("{surface.answer.sentences.map((s) => (");
    expect(result).toContain("surface.answer.parts.find((p) => p.text === sentence)?.kind");
    expect(result).not.toMatch(/stronger|strongly|proven|guaranteed/i);
  });

  it("in Russian the sentences are the Russian twin's and the headings are Russian", () => {
    setDisplayLanguage("RU");
    try {
      const s = buildResultSurface(RESULT_FIXTURES[0].detail);
      for (const p of s.answer.parts) expect(p.text).not.toMatch(/^The sources confirm|^There is evidence|^The available evidence/);
    } finally {
      setDisplayLanguage("EN");
    }
    expect(ru.result.answerHeadings.CONFIRMED).toBe("Что подтверждено");
  });

  it("no figure was added to the answer: the same four counts as before", () => {
    const result = codeOf(RESULT);
    expect(result).toMatch(/key: "checks"/);
    expect(result).toMatch(/key: "sources"/);
    expect(result).toMatch(/key: "items"/);
    expect(result).toMatch(/key: "verified"/);
    expect((result.match(/key: "[a-z]+", n:/g) ?? []).length).toBe(4);
  });
});
