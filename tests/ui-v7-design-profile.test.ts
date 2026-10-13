import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";

// V7 STEP 9 — PROFILE (HANDOFF §4.7), layout only.
//
// The board's layout lands; the access logic does not move. Free /
// Subscription wording and the subscription sheet are D14 / Phase 1b, so
// these tests pin that the existing access line, the existing language
// PATCH and the existing two-step delete are exactly what they were — and
// that no price, no Help row and no red delete appear.

const PAGE = "app/(app)/profile/page.tsx";
const CSS = "app/globals.css";

const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const css = readFileSync(CSS, "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("profile — the access logic is untouched", () => {
  it("the access line keeps its order and states (D-171)", () => {
    const page = readFileSync(PAGE, "utf8");
    const line = page.slice(page.indexOf("const accessLine"), page.indexOf("// Двойное подтверждение"));
    expect(line.indexOf("me.betaPaused")).toBeLessThan(line.indexOf('"ARI • CORE"'));
    expect(line.indexOf("me.privateBeta")).toBeLessThan(line.indexOf('"ARI • CORE"'));
    expect(line).toContain("if (me.demoAvailable)");
    expect(line).toContain("return dict.profile.noAccess;");
    expect(page).toContain('data-testid="profile-level"');
  });

  it("no price, no plan offer, no Help row", () => {
    const page = codeOf(PAGE);
    expect(page).not.toMatch(/priceNote|priceStars|\$\s?\d|Stars/);
    expect(page).not.toContain("dict.profile.help");
    expect(page).not.toMatch(/subscription/i);
  });
});

describe("profile — language switch", () => {
  it("stays the existing users.language PATCH, two pressed-state options", () => {
    const page = codeOf(PAGE);
    expect(page).toContain("api.setLanguage(language)");
    expect(page).toContain('(["EN", "RU"] as const).map((lang) => (');
    expect(page).toContain("aria-pressed={language === lang}");
    expect(page).toContain("data-value={language}");
  });

  it("the thumb slides by transform only, 0.2–0.3s, and not at all under reduced motion", () => {
    expect(rule(".profile-switch-thumb")).toContain("transition: transform 280ms");
    expect(rule(".profile-switch-thumb")).not.toMatch(/transition:[^;]*(left|width|box-shadow)/);
    expect(css).toContain('.profile-switch[data-value="RU"] .profile-switch-thumb {\n  transform: translateX(63px);');
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .profile-switch-thumb"));
    expect(reduced.slice(0, 200)).toContain("transition: none");
  });
});

describe("profile — delete stays two confirms, and grey", () => {
  it("the existing double confirm and the deleted notice", () => {
    const page = codeOf(PAGE);
    expect(page).toContain("if (!window.confirm(dict.profile.deleteConfirm1)) return;");
    expect(page).toContain("if (!window.confirm(dict.profile.deleteConfirm2)) return;");
    expect(page).toContain("await api.deleteAccount();");
    expect(page).toContain("{dict.profile.deleted}");
  });

  it("the delete row is grey, never red — it is not a verdict", () => {
    const page = codeOf(PAGE);
    expect(page).not.toMatch(/atlas-red|text-red|border-red/);
    for (const sel of [".profile-delete", ".profile-icon-grey", ".profile-delete .profile-row-title"]) {
      expect(rule(sel), sel).not.toMatch(/--atlas-red|#ec6f6f|236, 111, 111/i);
    }
  });
});

describe("profile — words come from the dictionaries", () => {
  it("every label the page shows exists in EN and RU", () => {
    for (const key of ["title", "language", "level", "privacy", "privacyNote", "deleteAccount", "deleted"] as const) {
      expect(en.profile[key], key).toBeTruthy();
      expect(ru.profile[key], key).toBeTruthy();
      expect(codeOf(PAGE), key).toContain(`dict.profile.${key}`);
    }
  });

  it("no hard-coded English text in the markup", () => {
    const offenders = [...codeOf(PAGE).matchAll(/(?<!=)>\s*([A-Za-z][A-Za-z ,.'’!?:-]{2,})\s*</g)].map((m) => m[1].trim());
    expect(offenders).toEqual([]);
  });
});
