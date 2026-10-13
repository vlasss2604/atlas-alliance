import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// V7 STEP 10 — THE MOTION RULES, CHECKED OVER EVERYTHING (HANDOFF §4.9, §8).
//
// Calm, CSS only. Entrances once; one "working" indicator while a job is
// live; state changes once; no decorative loops, no overshoot, no animated
// layout or paint-heavy properties, numbers never animated, and nothing at
// all under prefers-reduced-motion. These tests read the whole stylesheet
// and every component, so a new screen inherits the same rules.

const CSS_PATH = "app/globals.css";
// Comments name the things they ban, so every scan reads the CSS without them.
const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const cssRaw = readFileSync(CSS_PATH, "utf8");

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}
const UI_FILES = [...filesUnder("app"), ...filesUnder("src/client")].filter((f) => !f.startsWith(join("app", "api")));

// Each rule as { selector, body }, at any nesting depth (media blocks too).
function rules(source: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of source.matchAll(re)) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

function keyframes(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /@keyframes\s+([a-z0-9-]+)\s*\{/g;
  for (const m of source.matchAll(re)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      if (source[i] === "}") depth--;
      i++;
    }
    map.set(m[1], source.slice(start, i - 1));
  }
  return map;
}

describe("motion — only the allowed kinds exist", () => {
  const frames = keyframes(css);

  it("the keyframes are exactly the allowed set", () => {
    expect([...frames.keys()].sort()).toEqual(
      ["ap-blink", "ap-draw", "ap-fade-in", "ap-grow", "ap-pop", "ap-rise", "ap-seg", "ap-spin", "atlas-expand", "atlas-fade-up", "atlas-sheet-up"].sort(),
    );
  });

  it("keyframes move only transform and opacity (the two ring draws aside)", () => {
    for (const [name, body] of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      const allowed = name === "ap-draw" || name === "ap-seg" ? ["stroke-dashoffset", "stroke-dasharray", "opacity"] : ["transform", "opacity"];
      for (const p of props) expect(allowed, `${name}: ${p}`).toContain(p);
    }
  });

  it("nothing loops except the live job's working indicator", () => {
    const looping = rules(css)
      .filter((r) => /infinite/.test(r.body) && !r.selector.startsWith("@"))
      .map((r) => r.selector.replace(/\s+/g, " "));
    expect(looping.sort()).toEqual([".pulse-dot", ".process-spin", ".scanner-spin, .scanner-spin-slow", ".status-dot-live"].sort());
    // And those use the two allowed working motions, at the given speeds.
    expect(css).toContain(".scanner-spin,\n.scanner-spin-slow {\n  transform-origin: 88px 88px;\n  animation: ap-spin 2.4s linear infinite;");
    expect(css).toContain(".scanner-spin-slow {\n  animation-duration: 4s;");
    for (const sel of [".status-dot-live {", ".pulse-dot {"]) {
      const body = css.slice(css.indexOf(`\n${sel}`), css.indexOf("}", css.indexOf(`\n${sel}`)));
      expect(body, sel).toContain("animation: ap-blink 2.4s ease-in-out infinite;");
    }
  });

  it("no shimmer, sheen, drifting background or flowing dash anywhere", () => {
    expect(css).not.toMatch(/shimmer|sheen/i);
    expect(css).not.toMatch(/animation:[^;]*(background|dash|drift|orbit|sonar|breath)/i);
    for (const f of UI_FILES) expect(readFileSync(f, "utf8"), f).not.toMatch(/<animate|animateTransform|strokeDasharray=.*animation/);
  });
});

describe("motion — what may change, and how", () => {
  it("no transition on layout or paint-heavy properties", () => {
    for (const r of rules(css)) {
      for (const m of r.body.matchAll(/transition:([^;]*);/g)) {
        for (const part of m[1].split(",")) {
          const prop = part.trim().split(/\s+/)[0];
          expect(["box-shadow", "filter", "background-position", "width", "height", "top", "left", "all"], `${r.selector}: ${prop}`).not.toContain(prop);
        }
      }
    }
    for (const f of UI_FILES) expect(readFileSync(f, "utf8"), f).not.toContain("transition-all");
  });

  it("no overshoot or bounce: every easing curve stays within 0..1", () => {
    for (const m of css.matchAll(/cubic-bezier\(([^)]*)\)/g)) {
      const [, y1, , y2] = m[1].split(",").map(Number);
      expect(y1, m[0]).toBeGreaterThanOrEqual(0);
      expect(y1, m[0]).toBeLessThanOrEqual(1);
      expect(y2, m[0]).toBeGreaterThanOrEqual(0);
      expect(y2, m[0]).toBeLessThanOrEqual(1);
    }
  });

  it("no JS animation loops in the interface (job polling is data, not motion)", () => {
    for (const f of UI_FILES) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toContain("requestAnimationFrame");
      if (!f.endsWith("use-job-events.ts")) expect(src, f).not.toContain("setInterval");
    }
  });

  it("numbers are never animated: the ring's n/total is there at once", () => {
    const center = css.slice(css.indexOf("\n.proof-ring-center {"), css.indexOf("}", css.indexOf("\n.proof-ring-center {")));
    expect(center).not.toContain("animation");
    const n = css.slice(css.indexOf("\n.proof-ring-n {"), css.indexOf("}", css.indexOf("\n.proof-ring-n {")));
    expect(n).not.toContain("animation");
    expect(css).not.toMatch(/\.lib-count \{[^}]*animation/);
  });

  it("the loading skeleton holds still", () => {
    const skeleton = css.slice(css.indexOf("\n.skeleton {"), css.indexOf("}", css.indexOf("\n.skeleton {")));
    expect(skeleton).not.toMatch(/animation|background-size/);
  });
});

describe("motion — reduced motion stops everything", () => {
  it("one rule turns off every animation and transition", () => {
    expect(cssRaw).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\/\*[\s\S]*?\*\/\s*\*,\s*\*::before,\s*\*::after \{\s*animation: none !important;\s*transition: none !important;\s*\}/,
    );
  });
});

describe("the RU ring label fits the disc", () => {
  it("10px, at most 72px wide, centred", () => {
    const label = css.slice(css.indexOf("\n.proof-ring-label {"), css.indexOf("}", css.indexOf("\n.proof-ring-label {")));
    expect(label).toContain("font-size: 10px;");
    expect(label).toContain("max-width: 72px;");
    expect(readFileSync("src/client/components/research-result.tsx", "utf8")).toContain('<span className="proof-ring-label">{dict.result.figures.verified}</span>');
  });
});
