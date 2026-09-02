import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  retrievedOn,
  retrievedResource,
  sourceClassCaveat,
} from "../src/client/research-model";

// SOURCE TRUST — A CARD MUST PROVE IT IS QUOTING SOMEONE ELSE.
//
// A reader opened a source and met `ray-buybacks.md` and a block of text.
// Nothing on that card distinguished an external document from a paragraph
// this product had written about itself, and "Open original" led to raw
// markdown with no explanation of why.
//
// What the data actually supports, measured before any of this was built:
//
//   sources.url      == evidence.retrieved_url  on EVERY row
//   sources.title    == null                    on EVERY row
//   sources.publisher== null                    on EVERY row
//   sources.source_type == "OTHER"              on EVERY row
//   evidence.fetched_at — populated, real, and previously unprojected
//
// So there is no second human-facing address to link to and no captured
// page title to show. These tests pin the honest presentation that follows
// from that, and pin that no prettier version of either was invented.

const LADDER = "src/client/components/result-ladder.tsx";
const MODEL = "src/client/research-model.ts";
const card = (() => {
  const src = readFileSync(LADDER, "utf-8");
  return src.slice(src.indexOf("function EvidenceItem"));
})();

// The same card with comments removed. Comments name the sections they
// introduce ("WHY THIS SOURCE …"), so an order assertion over the raw text
// would be measuring the documentation rather than the render.
const cardCode = card
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* 1-3. IDENTITY BEFORE CONTENT                                        */
/* ------------------------------------------------------------------ */

describe("a source card leads with who published it", () => {
  it("TEST 1: the filename is never the headline identity", () => {
    // `ray-buybacks.md` as the title told a reader only that they were
    // looking at a file. The headline is a real page title when one was
    // captured, and otherwise the publisher that served it.
    expect(card).toContain("item.sourceTitle?.trim() || domain");
    expect(card).toContain('data-testid="source-identity"');
    // The old filename-first identity is gone.
    expect(card).not.toContain("documentName(item.retrievedUrl");
  });

  it("TEST 2: class and publisher are both visible, without duplication", () => {
    expect(card).toContain("sourceClassLabel(item.sourceClass)");
    expect(card).toContain('data-testid="source-class-chip"');
    // The domain is shown beside the class only when the headline is a real
    // title — otherwise the headline already IS the domain, and repeating
    // it would be furniture.
    expect(card).toContain("{title !== domain && ");
  });

  it("TEST 3: the retrieved resource is stated separately and quietly", () => {
    expect(card).toContain('data-testid="retrieved-resource"');
    expect(card).toContain("resource.filename");
    // Smaller than the identity above it — technical detail, not headline.
    expect(card).toContain("text-[0.7rem]");
  });
});

/* ------------------------------------------------------------------ */
/* 4-6. HONEST ABOUT WHAT WAS FETCHED                                  */
/* ------------------------------------------------------------------ */

describe("machine-readable retrieval is explained, not disguised", () => {
  it("TEST 4: a machine-readable resource is identified as one", () => {
    for (const url of [
      "https://docs.example.test/ray/ray-buybacks.md",
      "https://example.test/data.json",
      "https://example.test/llms.txt",
      "https://example.test/feed.xml",
      "https://example.test/rows.csv",
      "https://example.test/conf.yaml",
    ]) {
      expect(retrievedResource(url).machineReadable, url).toBe(true);
    }
    // An ordinary page is not labelled as one.
    for (const url of [
      "https://docs.example.test/ray/ray-buybacks",
      "https://example.test/blog/what-is-it",
      "https://example.test/",
    ]) {
      expect(retrievedResource(url).machineReadable, url).toBe(false);
    }
    expect(card).toContain("Machine-readable document");
  });

  it("TEST 5: the filename comes from the url, and a bad url yields nothing", () => {
    expect(retrievedResource("https://docs.example.test/ray/ray-buybacks.md").filename).toBe(
      "ray-buybacks.md",
    );
    expect(retrievedResource("not a url").filename).toBeNull();
    expect(retrievedResource("https://example.test/").filename).toBeNull();
  });

  it("TEST 6: NO human-facing url is derived, guessed or stripped", () => {
    // The tempting fix — drop the extension and hope a twin page exists —
    // is a fabricated provenance claim. `sources.url` equals
    // `retrieved_url` on every row, so the link goes exactly where the
    // excerpt came from.
    expect(card).toContain("href={item.retrievedUrl}");
    const model = readFileSync(MODEL, "utf-8");
    const helper = model.slice(
      model.indexOf("export function retrievedResource"),
      model.indexOf("export function retrievedOn"),
    );
    // Nothing rewrites, trims or reassembles a url.
    expect(helper).not.toContain(".replace(");
    expect(helper).not.toContain("slice(0, -3)");
    for (const token of ["Raydium", "raydium", "docs.", ".io", "buyback"]) {
      expect(helper, token).not.toContain(token);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 7-8. RETRIEVAL DATE IS A REAL, PERSISTED FACT                       */
/* ------------------------------------------------------------------ */

describe("when it was read is shown, because it is known", () => {
  it("TEST 7: a retrieval date renders from canonical fetchedAt", () => {
    // Month abbreviation is ICU-dependent ("Sep" / "Sept"), so the shape is
    // asserted rather than one runtime's spelling of it.
    expect(retrievedOn("2026-09-01T18:03:23.065Z")).toMatch(/^1 Sep\w* 2026$/);
    // Absent or unparseable yields nothing rather than a placeholder.
    expect(retrievedOn(null)).toBeNull();
    expect(retrievedOn(undefined)).toBeNull();
    expect(retrievedOn("not-a-date")).toBeNull();
    expect(card).toContain("retrievedOn(item.fetchedAt)");
  });

  it("TEST 8: fetchedAt is projected from the persisted column, not synthesised", () => {
    const route = readFileSync("app/api/research-jobs/[id]/route.ts", "utf-8");
    expect(route).toContain("fetchedAt: evidence.fetchedAt");
    const proofView = readFileSync("src/server/services/proof-view.ts", "utf-8");
    expect(proofView).toContain("fetchedAt: evidence.fetchedAt");
    expect(proofView).toContain("fetchedAt: c.fetchedAt.toISOString()");
    // No client-side clock anywhere near it.
    expect(card).not.toContain("Date.now()");
    expect(card).not.toContain("new Date()");
  });
});

/* ------------------------------------------------------------------ */
/* 9-11. THE CARD READS AS EXTERNAL MATERIAL                           */
/* ------------------------------------------------------------------ */

describe("the excerpt is external material, and says so", () => {
  it("TEST 9: the passage is labelled an excerpt and quoted, not presented as the page", () => {
    expect(card).toContain("Relevant excerpt");
    expect(card).toContain("<blockquote");
    expect(card).toContain("{item.fragment}");
    // And nothing fakes the original page. The scan runs over the RENDER,
    // not the comments: the Source Snapshot round added a comment saying
    // the snapshot icon is "not a preview of the live site", and a
    // vocabulary ban that a denial trips is measuring documentation
    // rather than what reaches a reader. The invariant itself is
    // untouched — no embedded page, no captured image of one.
    for (const fake of ["<iframe", "screenshot", "preview", "thumbnail", "favicon", "<img"]) {
      expect(cardCode.toLowerCase(), fake).not.toContain(fake);
    }
    // Stronger than the word ban it replaces: no route to a rendered page
    // exists anywhere on this surface, by any spelling.
    const rendered = readFileSync(LADDER, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(rendered).not.toMatch(/<iframe|<embed|<object|background-image|srcSet|<img\b/i);
  });

  it("TEST 10: the card explains the source's role and its limit, in that order", () => {
    // Comments name the sections they introduce, so strip them before
    // asserting on render order.
    const card = cardCode;
    expect(card.indexOf('data-testid="source-identity"')).toBeLessThan(
      card.indexOf("Relevant excerpt"),
    );
    expect(card.indexOf("Relevant excerpt")).toBeLessThan(card.indexOf("Why this source"));
    expect(card.indexOf("Why this source")).toBeLessThan(card.indexOf("Source limit"));
    // The card still ends in its ACTIONS, after everything that explains
    // the source. What changed is that there are now two of them, so the
    // assertion names the block rather than the one label it used to end
    // on — and pins the order inside it. "What did you read?" (the
    // capture, which is the only version that can account for this
    // excerpt) comes before "is it still true?" (the live page, which may
    // have moved on).
    expect(card.indexOf("Source limit")).toBeLessThan(card.indexOf("View source snapshot"));
    expect(card.indexOf("View source snapshot")).toBeLessThan(card.indexOf("Open original"));
    // Suitability comes from the class, the limit prefers the per-passage
    // record where the extractor left one.
    expect(card).toContain("caveat.can");
    expect(card).toContain("item.doesNotProve ?? caveat?.cannot");
  });

  it("TEST 11: the conclusion itself is not restated by our own prose", () => {
    // The excerpt may naturally contain the fact — it is the source's own
    // words. What must not reappear is the model's paraphrase of it, which
    // is the sentence the collapsed finding already showed.
    expect(card).not.toContain("{item.summary}");
    expect(card).not.toContain("Supports:");
  });
});

/* ------------------------------------------------------------------ */
/* 12-14. NOTHING BENEATH THE SURFACE MOVED                            */
/* ------------------------------------------------------------------ */

describe("presentation only", () => {
  it("TEST 12: source class still describes suitability, never rank", () => {
    for (const cls of ["OFFICIAL_DOCS", "GOVERNANCE", "ONCHAIN_VERIFIABLE", "DATA_PROVIDER"]) {
      const caveat = sourceClassCaveat(cls);
      expect(caveat, cls).toBeTruthy();
      expect(caveat!.can, cls).toMatch(/\.$/);
      expect(caveat!.cannot, cls).toMatch(/\.$/);
    }
    const chip = readFileSync(LADDER, "utf-8");
    const style = chip.slice(chip.indexOf("function sourceClassChipStyle"));
    for (const scoreish of ["score", "rating", "trust", "rank"]) {
      expect(style.toLowerCase(), scoreish).not.toContain(scoreish);
    }
  });

  it("TEST 13: one action vocabulary survives the change", () => {
    const code = readFileSync(LADDER, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain('{open ? "Hide sources" : "Sources"}');
    // The destination label is now "Open original". It was "Open source",
    // which collided with the "Sources" disclosure directly above it —
    // one word doing two jobs in one journey. The two destinations are
    // named for what they answer, and neither reuses the disclosure's
    // word.
    expect(code).toContain("Open original");
    expect(code).toContain("View source snapshot");
    expect(code).not.toContain("Open source");
    for (const stray of ["Show proof", "View evidence", "Verify", "Present proof"]) {
      expect(code, stray).not.toContain(stray);
    }
  });

  it("TEST 14: no model call, no engine change, no schema change", () => {
    for (const file of [LADDER, MODEL, "app/(app)/research/[id]/page.tsx"]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain("anthropic");
      expect(src, file).not.toContain("generateQuestionProjection");
    }
    const projection = readFileSync("src/server/engine/question-projection.ts", "utf-8");
    expect(projection).toContain("export const PROJECTION_VERSION = 1");
    const journal = JSON.parse(
      readFileSync("src/server/db/migrations/meta/_journal.json", "utf-8"),
    ) as { entries: { tag: string }[] };
    expect(journal.entries[journal.entries.length - 1].tag).toBe("0040_question_projection");
    // The projection added one already-persisted column to a read. It did
    // not touch admission, authority or the evidence link.
    const page = readFileSync("app/(app)/research/[id]/page.tsx", "utf-8");
    expect(page).toContain('if (link.role === "EXCLUDED") continue');
  });
});
