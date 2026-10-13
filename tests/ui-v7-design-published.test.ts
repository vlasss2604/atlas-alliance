import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DictScope } from "../src/client/app-context";
import { ResearchResult } from "../src/client/components/research-result";
import { en } from "../src/client/i18n/en";
import { ru } from "../src/client/i18n/ru";
import { retrievedOn } from "../src/client/research-model";
import { resultFixture } from "../src/client/result-surface-fixtures";
import { showcaseBySlug, showcaseProofs, showcaseSlugFromSearch, verifyPathForShowcase } from "../src/client/showcase-proofs";

// V7 DESIGN HANDOFF — STEP 5: THE PUBLISHED, READ-ONLY PROOF (HANDOFF §4.8).
// The same ResearchResult in `published` mode: a banner, the published
// label, the checked-on date note and "Run your own verification", which
// only prefills the composer. Nothing personal, no audit, no owner-only
// snapshot. The real route fails closed until Phase 3 publishes Proofs.

const codeOf = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const textOf = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const ROUTE = "app/(app)/proofs/published/[slug]/page.tsx";

const renderPublished = (key: string, dict = en) => {
  const { detail } = resultFixture(key);
  const checkedAt = detail.job.finishedAt!;
  return renderToStaticMarkup(
    createElement(DictScope, { dict }, createElement(ResearchResult, { detail, jobId: null, published: { slug: "raydium", checkedAt } })),
  );
};

describe("published mode", () => {
  it("banner, published label, checked-on date note and the own-verification action", () => {
    const { detail } = resultFixture("2");
    const html = renderPublished("2");
    expect(html).toContain('data-mode="published"');
    expect(textOf(html)).toContain(en.published.bannerTitle);
    expect(textOf(html)).toContain(en.published.bannerText);
    expect(html).toContain(`data-testid="result-label">${en.published.label}<`);
    expect(textOf(html)).toContain(en.published.dateNote(retrievedOn(detail.job.finishedAt)!));
    expect(html).toContain(`href="${verifyPathForShowcase("raydium")}"`);
    expect(textOf(html)).toContain(en.published.ownNote);
  });

  it("no audit, no owner-only snapshot route, nothing personal", () => {
    for (const key of ["1", "2", "4", "8"]) {
      const html = renderPublished(key);
      expect(html, key).not.toContain('data-testid="audit-entry"');
      expect(html, key).not.toContain('data-testid="evidence-snapshot"');
      expect(html, key).not.toMatch(/\/research\/[^"]*\/(audit|source)/);
    }
  });

  it("the reader's own result is unchanged: no banner, the audit door stays", () => {
    const { detail } = resultFixture("2");
    const own = renderToStaticMarkup(createElement(ResearchResult, { detail, jobId: detail.job.id }));
    expect(own).toContain('data-mode="own"');
    expect(own).not.toContain("published-banner");
    expect(own).toContain('data-testid="audit-entry"');
    expect(own).toContain(`data-testid="result-label">${en.result.label}<`);
  });

  it("Russian renders the Russian published copy", () => {
    const t = textOf(renderPublished("2", ru));
    expect(t).toContain(ru.published.bannerTitle);
    expect(t).toContain(ru.published.ownCta);
    expect(Object.keys(ru.published).sort()).toEqual(Object.keys(en.published).sort());
  });
});

describe("the published route fails closed until Phase 3", () => {
  it("shows 'not published yet' and no verdict, no figures, no evidence, no Research call", () => {
    const route = codeOf(ROUTE);
    expect(route).toContain("dict.published.unavailableTitle");
    expect(route).toContain('data-state="unavailable"');
    expect(route).not.toMatch(/ResearchResult|api\.|getResearchJob|startResearch|verdict|fetch\(/);
  });

  it("the preview of the published look is a dev route, gated out of production, passing no jobId", () => {
    const page = readFileSync("app/(app)/dev/published-proof/page.tsx", "utf8");
    expect(page).toContain('if (process.env.NODE_ENV === "production") notFound();');
    const view = codeOf("app/(app)/dev/published-proof/view.tsx");
    expect(view).toContain("jobId={null} published={{");
  });
});

describe("Run your own verification", () => {
  it("only a showcase id travels in the URL; free text and odd ids prefill nothing", () => {
    expect(verifyPathForShowcase("raydium")).toBe("/home?proof=raydium");
    expect(showcaseSlugFromSearch("?proof=raydium")).toBe("raydium");
    for (const bad of ["?proof=Does%20Raydium%20buy%20back", "?proof=../x", "?proof=", "?other=raydium"]) {
      expect(showcaseSlugFromSearch(bad), bad).toBeNull();
    }
    expect(showcaseBySlug("raydium", showcaseProofs("development"))?.name).toBe("Raydium");
    expect(showcaseBySlug("unknown", showcaseProofs("development"))).toBeNull();
  });

  it("Verify prefills the composer with that Proof's question and starts nothing", () => {
    const home = codeOf("app/(app)/home/page.tsx");
    expect(home).toContain("showcaseSlugFromSearch(window.location.search)");
    expect(home).toContain("initialQuestion={proofQuestion}");
    expect(home).not.toContain("startResearch");
  });
});
