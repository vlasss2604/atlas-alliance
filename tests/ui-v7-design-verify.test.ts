import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { DictScope } from "../src/client/app-context";
import { ExploreProofs } from "../src/client/components/explore-proofs";
import { RecentProofCard } from "../src/client/components/recent-proof-card";
import { setDisplayLanguage } from "../src/client/display-language";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { orderShowcase, publishedProofPath, showcaseProofs, type ShowcaseProof } from "../src/client/showcase-proofs";

// V7 DESIGN HANDOFF — STEP 2: VERIFY, EXPLORE ATLAS PROOFS, FROM PULSE
// (docs/design/v7, HANDOFF §4.1, §4.1a). Pins the rules the screen must
// not bend: a verdict only where an approved published Proof exists, no
// sample verdict in a production build, an in-review card that is not a
// link, and the composer flow unchanged.

const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const HOME = "app/(app)/home/page.tsx";
const COMPOSER = "src/client/components/research-composer.tsx";

afterEach(() => setDisplayLanguage("EN"));

const entry = (over: Partial<ShowcaseProof>): ShowcaseProof => ({
  slug: "x",
  name: "X",
  ticker: null,
  topic: { EN: "t", RU: "т" },
  question: { EN: "Q?", RU: "В?" },
  published: null,
  ...over,
});

describe("Explore ATLAS Proofs — data", () => {
  it("the copy exists in both languages, key for key", () => {
    expect(Object.keys(ru.explore).sort()).toEqual(Object.keys(en.explore).sort());
    expect(en.explore.title).toBe("Explore ATLAS Proofs");
    expect(ru.explore.inReview).toBe("На проверке качества · скоро");
  });

  it("a production build serves no showcase at all — the sample verdict never reaches a real user", () => {
    expect(showcaseProofs("production")).toEqual([]);
  });

  it("the development fixture: five projects, only Raydium published, published first", () => {
    const list = showcaseProofs("development");
    expect(list.map((p) => p.slug)).toEqual(["raydium", "pump_fun", "lido", "jupiter", "jito"]);
    expect(list.filter((p) => p.published).map((p) => p.slug)).toEqual(["raydium"]);
  });

  it("orders published before in-review and keeps the given order within each", () => {
    const pub = { verdict: "SUPPORTED" as const, checkedAt: "2026-10-01" };
    const out = orderShowcase([entry({ slug: "a" }), entry({ slug: "b", published: pub }), entry({ slug: "c" }), entry({ slug: "d", published: pub })]);
    expect(out.map((p) => p.slug)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("Explore ATLAS Proofs — rendering", () => {
  const render = (items: ShowcaseProof[], dict = en) => renderToStaticMarkup(createElement(DictScope, { dict }, createElement(ExploreProofs, { items })));

  it("a published card links to the read-only route and shows the verdict and the checked date", () => {
    const html = render([entry({ slug: "raydium", name: "Raydium", published: { verdict: "PARTIALLY_SUPPORTED", checkedAt: "2026-10-01" } })]);
    expect(html).toContain(`href="${publishedProofPath("raydium")}"`);
    expect(html).toContain('data-verdict="PARTIALLY_SUPPORTED"');
    expect(html).toContain("Partially supported");
    expect(html).toContain("Checked 1 Oct 2026");
    expect(html).toContain(en.explore.read);
  });

  it("an in-review card has no verdict, no link and no button — only the in-review line", () => {
    const html = render([entry({ slug: "jito", name: "Jito" })]);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("data-verdict");
    expect(html).not.toContain(en.explore.read);
    expect(html).toContain(en.explore.inReview);
  });

  it("an empty list renders nothing", () => {
    expect(render([])).toBe("");
  });

  it("in Russian the copy and the project text are Russian", () => {
    setDisplayLanguage("RU");
    const html = render([entry({ question: { EN: "Q?", RU: "Вопрос?" }, published: { verdict: "SUPPORTED", checkedAt: "2026-10-01" } })], ru);
    expect(html).toContain("Вопрос?");
    expect(html).toContain(ru.explore.title);
    expect(html).toContain(ru.verdict.SUPPORTED);
  });
});

describe("Verify — the screen", () => {
  it("Explore sits between the composer and Previously researched; Home reads the list, never a verdict of its own", () => {
    const home = codeOf(HOME);
    expect(home).toContain("<ExploreProofs items={showcaseProofs()} />");
    expect(home.indexOf("home-composer")).toBeLessThan(home.indexOf("<ExploreProofs"));
    expect(home.indexOf("<ExploreProofs")).toBeLessThan(home.indexOf('data-testid="recent-research"'));
    expect(home).not.toMatch(/SUPPORTED|PARTIALLY_SUPPORTED/);
  });

  it("the From Pulse pill sits above the title, inside the composer section", () => {
    const home = codeOf(HOME);
    expect(home).toContain("notice={pulseNotice}");
    expect(home).toContain('data-testid="pulse-notice"');
    const composer = codeOf(COMPOSER);
    expect(composer.indexOf("{notice}")).toBeLessThan(composer.indexOf('className="verify-title'));
  });

  it("the composer flow is unchanged: a chip prefills, Enter submits, only Start Proof starts a job", () => {
    const composer = codeOf(COMPOSER);
    expect(composer).toContain("onClick={() => setQuestion(ex)}");
    expect(composer).toContain("setResult(await api.interpret(question));");
    expect(composer.match(/api\.startResearch\(/g)?.length).toBe(1);
    expect(composer).toContain('data-testid="start-proof"');
  });

  it("the decorative ring is static and uses no result colour", () => {
    const home = readFileSync(HOME, "utf8");
    const ring = home.slice(home.indexOf("function VerifyRing"));
    expect(ring).not.toMatch(/animate|animation|53, 209, 162|230, 181, 77|236, 111, 111/);
  });

  it("the carousel card keeps the real link and test ids, and a run without a verdict gets no verdict mark", () => {
    const base = {
      id: "j1",
      state: "FAILED",
      progressStage: 3,
      memoryStatus: "NOT_USED",
      acquisitionPhase: null,
      createdAt: "2026-10-01T10:00:00.000Z",
      finishedAt: "2026-10-01T10:20:00.000Z",
      unread: false,
      originalQuestion: "Q?",
      projectName: "Jito",
      projectTicker: "JTO",
      projectSlug: "jito",
      verdict: null,
    } as unknown as Parameters<typeof RecentProofCard>[0]["job"];
    const failed = renderToStaticMarkup(createElement(RecentProofCard, { job: base, variant: "card" }));
    expect(failed).toContain('href="/research/j1"');
    expect(failed).toContain('data-testid="proof-card-j1"');
    expect(failed).not.toContain("verdict-glyph");
    const supported = renderToStaticMarkup(
      createElement(RecentProofCard, { job: { ...base, state: "SUCCEEDED", verdict: "SUPPORTED" } as typeof base, variant: "card" }),
    );
    expect(supported).toContain('class="verdict-glyph" data-tone="supported"');
  });

  it("decoration never widens the page; entrances stop under reduced motion", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/\.app-column \{[^}]*overflow-x: clip;/);
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.rise \{\s*animation: none;|\.rise,?[\s\S]*?animation: none;/);
  });
});
