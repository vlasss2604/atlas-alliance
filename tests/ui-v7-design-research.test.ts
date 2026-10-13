import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DictScope } from "../src/client/app-context";
import { ResearchProgress } from "../src/client/components/research-progress";
import { ResearchStatus, statusKind, WhatHappensNext, type StatusJob } from "../src/client/components/research-status";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { PROGRESS_FIXTURES } from "../src/client/progress-fixtures";

// V7 DESIGN HANDOFF — STEP 3: THE RESEARCH SCREEN IN EVERY STATE
// (docs/design/v7, HANDOFF §4.2, §4.9). Pins: every word comes from the
// job's state and deriveProgress; failed / cancelled / budget are GREY and
// never a verdict; no ETA, no percentage, no count-up; no action line is
// invented (D4); a finished run shows no rail (D5); only the scanner arc
// and the active-stage spinner rotate, and only while live.

const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const PAGE = "app/(app)/research/[id]/page.tsx";
const css = () => readFileSync("app/globals.css", "utf8");
const rule = (selector: string) => {
  const s = css();
  const i = s.indexOf(`\n${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return s.slice(i, s.indexOf("}", i));
};

const jobIn = (state: string, over: Partial<StatusJob> = {}): StatusJob => ({
  ...PROGRESS_FIXTURES[0].job,
  state,
  progressStage: 3,
  acquisitionPhase: state === "RUNNING" ? "SEARCHING" : null,
  ...over,
});
const status = (job: StatusJob, dict = en, onCancel?: () => void) =>
  renderToStaticMarkup(createElement(DictScope, { dict }, createElement(ResearchStatus, { job, onCancel })));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("research screen — states", () => {
  it("maps every job state to one presentation kind", () => {
    expect(["QUEUED", "RUNNING", "AWAITING_CLARIFICATION", "SUCCEEDED", "BUDGET_LIMIT_REACHED", "FAILED", "CANCELLED"].map(statusKind)).toEqual([
      "queued",
      "running",
      "clarify",
      "succeeded",
      "budget",
      "failed",
      "cancelled",
    ]);
  });

  it("the fixtures cover the eight mockup states with a neutral placeholder project", () => {
    expect(PROGRESS_FIXTURES.map((f) => f.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    for (const f of PROGRESS_FIXTURES) expect(f.job.projectName).toBe("Example Protocol");
  });

  it("the running title is the active stage from deriveProgress; queued, clarify and the end states read their own words", () => {
    expect(status(jobIn("RUNNING"))).toContain(`data-testid="status-title">${en.progress.stages.SEARCH}<`);
    expect(status(jobIn("QUEUED"))).toContain(`>${en.research.states.QUEUED}<`);
    expect(status(jobIn("AWAITING_CLARIFICATION"))).toContain(`>${en.ask.clarifyTitle}<`);
    expect(status(jobIn("SUCCEEDED"))).toContain(`>${en.research.states.SUCCEEDED}<`);
    expect(status(jobIn("BUDGET_LIMIT_REACHED"))).toContain(`>${en.outcome.STOPPED_AT_LIMIT}<`);
    expect(status(jobIn("FAILED")).replace(/&#x27;/g, "'")).toContain(`>${en.progress.failedTitle}<`);
    expect(status(jobIn("CANCELLED"))).toContain(`>${en.research.states.CANCELLED}<`);
  });

  it("failed, cancelled and budget are grey kinds: no verdict, no verdict pill, no in-progress pill", () => {
    for (const s of ["FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"]) {
      const html = status(jobIn(s));
      expect(html, s).toMatch(/class="scanner-panel[^"]*" [^>]*data-kind="(failed|cancelled|budget)"/);
      expect(html, s).toContain("status-kicker-grey");
      expect(html, s).not.toMatch(/tone-|data-verdict|status-pill/);
    }
    for (const kind of ["budget", "failed", "cancelled"]) {
      expect(css()).toContain(`.scanner-panel[data-kind="${kind}"]`);
    }
    const grey = css().slice(css().indexOf('.scanner-panel[data-kind="budget"],'), css().indexOf(".scanner-line {"));
    expect(grey).toContain("--scan: var(--system-grey);");
    expect(grey).not.toMatch(/atlas-red|atlas-amber|atlas-green/);
  });

  it("failed says the attempt was not spent and offers a new question; cancelled offers a new question; budget offers neither", () => {
    const failed = status(jobIn("FAILED")).replace(/&#x27;/g, "'");
    expect(failed).toContain(en.progress.failedChip);
    expect(failed).toContain('href="/home"');
    const cancelled = status(jobIn("CANCELLED"));
    expect(cancelled).not.toContain('data-testid="attempt-chip"');
    expect(cancelled).toContain(en.ask.newQuestion);
    const budget = status(jobIn("BUDGET_LIMIT_REACHED"));
    expect(budget).not.toContain('data-testid="ask-another"');
    expect(budget).not.toContain('data-testid="attempt-chip"');
  });

  it("Stop exists only for a live job and only when the page hands it the cancel flow", () => {
    expect(status(jobIn("RUNNING"), en, () => {})).toContain('data-testid="stop-research"');
    expect(status(jobIn("RUNNING"))).not.toContain('data-testid="stop-research"');
    for (const s of ["AWAITING_CLARIFICATION", "SUCCEEDED", "FAILED", "CANCELLED", "BUDGET_LIMIT_REACHED"]) {
      expect(status(jobIn(s), en, () => {}), s).not.toContain('data-testid="stop-research"');
    }
  });

  it("a clarification never offers an input it cannot send: the job has no answer route", () => {
    const html = status(jobIn("AWAITING_CLARIFICATION"));
    expect(html).not.toMatch(/<input|<textarea|<button/);
  });

  it("no state shows a percentage, an ETA or a count", () => {
    for (const f of PROGRESS_FIXTURES) {
      for (const dict of [en, ru]) {
        const t = textOf(status(f.job, dict));
        expect(t, f.title).not.toMatch(/\d+\s*%|ETA|\bmin(ute)?s? (left|remaining)|осталось \d/i);
      }
    }
  });

  it("Russian renders Russian words", () => {
    const t = textOf(status(jobIn("FAILED"), ru));
    expect(t).toContain(ru.progress.failedTitle);
    expect(t).toContain(ru.progress.failedChip);
    expect(t).not.toMatch(/Couldn|attempt/);
  });
});

describe("research screen — the process rail", () => {
  const rail = (job: StatusJob, dict = en) =>
    renderToStaticMarkup(createElement(DictScope, { dict }, createElement(ResearchProgress, { job })));

  it("a running stage is tagged 'now'; an awaiting one 'waiting for you'; a finished job has no tag and no note", () => {
    expect(rail(jobIn("RUNNING"))).toContain(`data-testid="stage-tag">${en.progress.tags.now}<`);
    expect(rail(jobIn("AWAITING_CLARIFICATION", { progressStage: 1 }))).toContain(`>${en.progress.tags.waiting}<`);
    const done = rail(jobIn("SUCCEEDED"));
    expect(done).not.toContain("stage-tag");
    expect(done).not.toContain("found-note");
  });

  it("stages only — no invented action lines or source chips (D4)", () => {
    const html = rail(jobIn("RUNNING"));
    expect(html).not.toMatch(/found, not verified|Looking for|Reading the/);
    expect(html).toContain(`data-testid="found-note"`);
  });

  it("'what happens next' carries the four approved rows, grey for budget and failure", () => {
    const html = renderToStaticMarkup(createElement(DictScope, { dict: en }, createElement(WhatHappensNext)));
    for (const k of ["ready", "clarify", "budget", "failure"] as const) expect(html).toContain(en.progress.next[k].title);
    expect(html).toMatch(/next-icon-grey[^]*Budget limit/);
  });

  it("the new copy exists in both languages, key for key", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((s) => `${k}.${s}`) : [k]));
    expect(keys(ru.progress).sort()).toEqual(keys(en.progress).sort());
  });
});

describe("research screen — the page", () => {
  it("the rail runs only for an unfinished job; a finished one never shows stages as done (D5)", () => {
    const page = codeOf(PAGE);
    expect(page).toMatch(/\{!finished && \([\s\S]*data-testid="progress-slot-live"/);
  });

  it("a stopped-early run keeps the status on top and shows a result only when a Proof exists", () => {
    const page = codeOf(PAGE);
    expect(page).toContain('const stoppedEarly = kind === "failed" || kind === "cancelled" || kind === "budget";');
    expect(page).toContain("const showResult = finished && !settling && (!stoppedEarly || detail.proof !== null);");
    expect(page).toContain("{showResult && <ResearchResult detail={detail} jobId={jobId} />}");
  });

  it("Stop is the existing cancel flow behind one confirmation", () => {
    const page = codeOf(PAGE);
    expect(page).toContain("window.confirm(dict.progress.cancelConfirm)");
    expect(page).toContain(".cancelJob(jobId)");
  });

  it("the auto-switch to the result stays; the ring is only held long enough to close once", () => {
    const page = codeOf(PAGE);
    expect(page).toContain('if (e.state === "SUCCEEDED") setSettling(true);');
    expect(page).toContain("window.setTimeout(() => setSettling(false), 700)");
    expect(page).not.toMatch(/Open Proof|openProof/);
  });
});

describe("research screen — motion (HANDOFF §4.9)", () => {
  it("only the scanner arc and the active-stage spinner rotate; the ring draw and badges run once", () => {
    expect(rule(".scanner-spin,\n.scanner-spin-slow")).toContain("animation: ap-spin 2.4s linear infinite;");
    expect(css()).toMatch(/\n\.scanner-spin-slow \{\s*animation-duration: 4s;\s*\}/);
    expect(rule(".process-spin")).toContain("animation: ap-spin 1.4s linear infinite;");
    expect(rule(".status-dot-live")).toContain("animation: ap-blink 2.4s ease-in-out infinite;");
    for (const once of [".scanner-ring-draw", ".scanner-badge", ".process-mark-done", ".status-fade"]) {
      expect(rule(once), once).not.toContain("infinite");
    }
  });

  it("every V7 research animation stops under reduced motion", () => {
    const reduced = css().slice(css().lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    for (const sel of [".status-fade", ".status-dot-live", ".scanner-spin", ".scanner-spin-slow", ".scanner-ring-draw", ".scanner-badge", ".process-spin"]) {
      expect(reduced, sel).toContain(sel);
    }
  });
});
