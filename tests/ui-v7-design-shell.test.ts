import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";

// V7 DESIGN HANDOFF — STEP 1: TOKENS AND THE APP SHELL (docs/design/v7,
// HANDOFF §4.0). Pins what the owner asked for explicitly: the shield and
// wordmark on every screen (Verify included, on a handset too), the
// bilingual tagline, the floating three-cell dock with the raised shield,
// the static background — and that the shell stays presentation only.

const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const css = () => readFileSync("app/globals.css", "utf8");
const rule = (selector: string) => {
  const s = css();
  const i = s.indexOf(`\n${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return s.slice(i, s.indexOf("}", i));
};

const CHROME = "src/client/components/app-chrome.tsx";

describe("V7 shell — header lockup", () => {
  it("the tagline exists in both languages with the owner's wording", () => {
    expect(en.nav.tagline).toBe("Crypto Verification · Economics");
    expect(ru.nav.tagline).toBe("Криптопроверка · Экономика");
  });

  it("the lockup renders the bare shield, the wordmark and the tagline from the dictionary", () => {
    const header = codeOf(CHROME).slice(codeOf(CHROME).indexOf("export function AppHeader"), codeOf(CHROME).indexOf("export function AtlasDock"));
    expect(header).toContain('<AtlasShield className="brand-shield" />');
    expect(header).toContain("{dict.nav.tagline}");
    expect(header).toContain('ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>');
    // Never hidden on Verify: the lockup class carries no hiding utility.
    expect(header).not.toMatch(/brand-lockup[^"`]*\bhidden\b/);
    expect(rule(".brand-lockup-home")).toContain("display: flex;");
    expect(rule(".brand-shield")).toMatch(/width: 44px;[\s\S]*height: 47px;/);
    expect(rule(".wordmark")).toMatch(/font-size: 17px;[\s\S]*font-weight: 800;/);
    expect(rule(".brand-tagline")).toMatch(/font-size: 9px;[\s\S]*text-transform: uppercase;/);
  });

  it("profile is a 40px circle on a handset and lit with the cyan gradient on /profile", () => {
    expect(rule(".profile-link")).toMatch(/width: 40px;[\s\S]*height: 40px;/);
    expect(rule(".profile-link-active")).toContain("linear-gradient(180deg, var(--atlas-cyan-light) 0%, var(--atlas-cyan-press) 100%)");
    expect(rule(".profile-link-active")).toContain("color: var(--on-cyan);");
  });
});

describe("V7 shell — dock", () => {
  it("floats 10px from the edges, 70px tall, radius 22, three equal cells", () => {
    const dock = rule(".dock");
    expect(dock).toContain("left: 10px;");
    expect(dock).toContain("right: 10px;");
    expect(dock).toContain("bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);");
    expect(dock).toContain("height: 70px;");
    expect(dock).toContain("border-radius: var(--radius-panel);");
    expect(dock).toContain("grid-template-columns: repeat(3, 1fr);");
  });

  it("labels are 11px (Verify 13px); the lit item is white, bold, with the active glow", () => {
    expect(rule(".dock-item")).toContain("font-size: 11px;");
    expect(rule(".dock-home-label")).toContain("font-size: 13px;");
    expect(rule(".dock-item-active")).toMatch(/color: var\(--atlas-text-strong\);[\s\S]*font-weight: 700;[\s\S]*filter: var\(--glow-active\);/);
  });

  it("the lit rules are unchanged: Proofs covers every route under /research, Profile lights nothing in the dock", () => {
    const chrome = codeOf(CHROME);
    expect(chrome).toContain("return pathname === href || pathname.startsWith(`${href}/`);");
    const dock = chrome.slice(chrome.indexOf("export function AtlasDock"));
    expect(dock).not.toContain("PROFILE_HREF");
  });

  it("the unread dot on Proofs stays, 7px", () => {
    expect(codeOf(CHROME)).toContain('item("proofs", <ResearchIcon size={24} />, unread ? "unread-dot" : "")');
    expect(rule(".unread-dot::after")).toMatch(/width: 7px;[\s\S]*height: 7px;/);
  });
});

describe("V7 shell — background is static", () => {
  it("page gradient, two glows, the network and the dock fade — none of them animated", () => {
    const field = readFileSync("src/client/components/atlas-field.tsx", "utf8");
    expect(field).toContain("atlas-glow-cyan");
    expect(field).toContain("atlas-glow-violet");
    expect(rule(".atlas-field")).toContain("background: var(--page-gradient);");
    for (const sel of [".atlas-field", ".atlas-glow", ".atlas-glow-cyan", ".atlas-glow-violet", ".atlas-network", ".dock-fade"]) {
      expect(rule(sel), sel).not.toMatch(/animation|transition/);
    }
    expect(readFileSync("app/(app)/layout.tsx", "utf8")).toContain("<DockFade />");
  });

  it("the typography is Inter (Latin + Cyrillic) from files in the repo — no Google Fonts at build time", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    expect(layout).not.toContain("next/font/google");
    expect(layout).toContain('src: "./fonts/inter-latin.woff2"');
    expect(layout).toContain('src: "./fonts/inter-cyrillic.woff2"');
    expect(layout).toContain('src: "./fonts/geist-mono-latin.woff2"');
    expect(layout.match(/weight: "400 800"/g)?.length).toBe(2);
    for (const f of ["inter-latin", "inter-cyrillic", "geist-mono-latin"]) {
      expect(readFileSync(`app/fonts/${f}.woff2`).subarray(0, 4).toString("latin1"), f).toBe("wOF2");
    }
    expect(css()).toContain("font-family: var(--font-inter), var(--font-inter-cyrillic), system-ui, sans-serif;");
  });
});
