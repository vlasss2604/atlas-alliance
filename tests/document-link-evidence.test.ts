import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projectMemoryItems,
  projects,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import {
  extractDocumentLinks,
  renderLinkAppendix,
  LINK_APPENDIX_HEADER,
} from "../src/server/engine/providers/document-links";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RECOVERED DOCUMENT LINKS -> EVIDENCE.
//
// A rendered page shows what a reader SEES; the DOM behind it carries what
// the document STATES. When a page renders a visually truncated
// identifier, extraction reading only the visible text can never quote the
// exact value, and D-076's traceability rule then correctly refuses the
// fact. The appendix closes that gap by making the exact href part of the
// document text that is presented AND hashed.
//
// What must NOT follow from that: a link is not evidence, and a link does
// not carry authority. Authority is computed from the DOCUMENT's confirmed
// route, never from anything inside the document — including an href.
// Those are the properties this file exists to pin.

// A page-truncated anchor over a full identifier — the exact shape that
// defeats plain-text extraction. Deliberately NOT any real project's
// values: the code under test has no project-specific behaviour and these
// tests must not smuggle any in.
const FULL_ID_A = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm";
const FULL_ID_B = "7KpLmNqRsTuVwXyZaBcDeFgHjKmNpQrStUvWxYzAbCdE";
const HOST = "docs.example-project.test";
const PAGE_URL = `https://${HOST}/token/economics`;

const SAMPLE_HTML = `
<html><body>
  <h1>Token economics</h1>
  <p>Half of revenue buys the token and destroys it.</p>
  <h2>Destination addresses</h2>
  <a href="https://explorer.example.test/account/${FULL_ID_A}">4Hs9Tz&hellip;DkGm</a>
  <a href="https://explorer.example.test/account/${FULL_ID_B}">7KpLmN&hellip;bCdE</a>
  <h2>Legal</h2>
  <a href="/terms">Terms</a>
</body></html>`;

describe("recovered links — exact href preservation", () => {
  it("keeps the href verbatim even when the anchor text is truncated by the page", () => {
    const out = extractDocumentLinks(SAMPLE_HTML);
    const first = out.links.find((l) => l.href.includes(FULL_ID_A));
    expect(first).toBeTruthy();
    expect(first!.href).toBe(`https://explorer.example.test/account/${FULL_ID_A}`);
    // The anchor text is what a reader sees, and it is NOT the identifier.
    expect(first!.text).not.toContain(FULL_ID_A);
  });

  it("the appendix carries the exact identifier that the visible text lacks", () => {
    const appendix = renderLinkAppendix(extractDocumentLinks(SAMPLE_HTML));
    expect(appendix).toContain(FULL_ID_A);
    expect(appendix).toContain(FULL_ID_B);
    expect(appendix.startsWith(LINK_APPENDIX_HEADER)).toBe(true);
  });

  it("query strings and unusual characters survive unmodified", () => {
    const href = "https://explorer.example.test/tx?sig=abc%2Fdef&amp;n=2";
    const out = extractDocumentLinks(`<a href="${href}">x</a>`);
    expect(out.links[0].href).toBe("https://explorer.example.test/tx?sig=abc%2Fdef&n=2");
  });

  it("is deterministic — the same html always yields the same appendix", () => {
    const a = renderLinkAppendix(extractDocumentLinks(SAMPLE_HTML));
    const b = renderLinkAppendix(extractDocumentLinks(SAMPLE_HTML));
    expect(a).toBe(b);
  });

  it("a document with no link produces no appendix at all", () => {
    expect(renderLinkAppendix(extractDocumentLinks("<p>no links here</p>"))).toBe("");
  });
});

describe("recovered links — heading and surrounding context", () => {
  it("attributes each link to the nearest preceding heading", () => {
    const out = extractDocumentLinks(SAMPLE_HTML);
    const byHref = (id: string) => out.links.find((l) => l.href.includes(id))!;
    expect(byHref(FULL_ID_A).heading).toBe("Destination addresses");
    expect(byHref(FULL_ID_B).heading).toBe("Destination addresses");
    // A later heading must not leak backwards onto earlier links, and the
    // link under it gets its OWN heading.
    expect(out.links.find((l) => l.href === "/terms")!.heading).toBe("Legal");
  });

  it("a link with no heading above it reports null rather than guessing", () => {
    const out = extractDocumentLinks(`<a href="/x">x</a><h2>Later</h2>`);
    expect(out.links[0].heading).toBeNull();
  });

  it("recovers preceding visible text when the label is not marked up as a heading", () => {
    // A page may label a group with a div, a caption or a table header.
    const html = `<div>Destination addresses</div><a href="https://e.test/a/${FULL_ID_A}">4Hs9Tz&hellip;</a>`;
    const out = extractDocumentLinks(html);
    expect(out.links[0].heading).toBeNull();
    expect(out.links[0].context).toContain("Destination addresses");
  });

  it("heading and context are bounded, and never contain markup", () => {
    const long = "L".repeat(5_000);
    const out = extractDocumentLinks(`<h2>${long}</h2><p>${long}</p><a href="/x">x</a>`);
    expect(out.links[0].heading!.length).toBeLessThanOrEqual(160);
    expect(out.links[0].context!.length).toBeLessThanOrEqual(160);
    expect(out.links[0].context).not.toContain("<");
    expect(out.links[0].heading).not.toContain("<");
  });

  it("the appendix renders heading and context on one line per link", () => {
    const appendix = renderLinkAppendix(extractDocumentLinks(SAMPLE_HTML));
    const line = appendix.split("\n").find((l) => l.includes(FULL_ID_A))!;
    expect(line).toContain("heading=Destination addresses");
    // One link is one line, so a support fragment quoting it stays a
    // single legible excerpt.
    expect(line).not.toContain("\n");
  });
});

describe("recovered links — bounded count and size", () => {
  it("caps the number of links written into the appendix and says so", () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => `<a href="https://e.test/p/${i}">link ${i}</a>`,
    ).join("");
    const appendix = renderLinkAppendix(extractDocumentLinks(many));
    const linkLines = appendix.split("\n").filter((l) => l.includes("href="));
    expect(linkLines.length).toBeLessThanOrEqual(100);
    expect(appendix).toContain("not listed (bounded output)");
  });

  it("caps total appendix size regardless of how long individual hrefs are", () => {
    const long = Array.from(
      { length: 200 },
      (_, i) => `<a href="https://e.test/${"q".repeat(600)}/${i}">x${i}</a>`,
    ).join("");
    const appendix = renderLinkAppendix(extractDocumentLinks(long));
    expect(appendix.length).toBeLessThanOrEqual(20_000);
    expect(appendix).toContain("not listed (bounded output)");
  });

  it("an oversized document yields no links at all rather than a partial read", () => {
    const huge = `<a href="https://e.test/x">x</a>`.padEnd(8_000_001, " ");
    expect(extractDocumentLinks(huge).links).toEqual([]);
  });
});

describe("recovered links — unsafe schemes are ignored", () => {
  it("drops every non-http(s) scheme", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://e.test/abc",
      "mailto:someone@example.test",
      "tel:+15550000",
      "ftp://e.test/x",
    ]) {
      const out = extractDocumentLinks(`<a href="${href}">x</a>`);
      expect(out.links, `admitted "${href}"`).toEqual([]);
    }
  });

  it("a scheme obfuscated with embedded whitespace or control characters is still dropped", () => {
    for (const href of ["java\tscript:alert(1)", "java\nscript:alert(1)", " javascript:alert(1)"]) {
      expect(extractDocumentLinks(`<a href="${href}">x</a>`).links).toEqual([]);
    }
  });

  it("http, https and relative hrefs are kept", () => {
    for (const href of ["https://e.test/x", "http://e.test/x", "/relative", "../up", "#frag"]) {
      expect(extractDocumentLinks(`<a href="${href}">x</a>`).links.length, href).toBe(1);
    }
  });

  it("an unsafe href never reaches the appendix", () => {
    const appendix = renderLinkAppendix(
      extractDocumentLinks(`<a href="javascript:steal()">click</a><a href="/ok">ok</a>`),
    );
    expect(appendix).not.toContain("javascript");
    expect(appendix).toContain("href=/ok");
  });
});

describe("recovered links — no project-specific logic", () => {
  it("the module's executable code names no project, chain, host or mechanism", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/document-links.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const banned of [
      "pump",
      "solscan",
      "solana",
      "etherscan",
      "burn",
      "treasury",
      "buyback",
      "uniswap",
      "hyperliquid",
    ]) {
      expect(code, `document-links.ts code mentions "${banned}"`).not.toContain(banned);
    }
  });

  it("treats an arbitrary host exactly like any other — no host is privileged", () => {
    const a = extractDocumentLinks(`<h2>H</h2><a href="https://explorer.example.test/account/${FULL_ID_A}">t</a>`);
    const b = extractDocumentLinks(`<h2>H</h2><a href="https://unrelated.invalid/account/${FULL_ID_A}">t</a>`);
    expect(a.links[0].heading).toBe(b.links[0].heading);
    expect(a.identifiers.map((i) => i.shape)).toEqual(b.identifiers.map((i) => i.shape));
    // Shape classification says nothing about which chain or project a
    // value belongs to — the same string on an unrelated host classifies
    // identically, which is precisely why it confers nothing.
    expect(b.identifiers[0].shape).toBe("ADDRESS_LIKE");
  });
});

// ---------------------------------------------------------------------
// End to end: what a recovered link can and cannot do to Evidence.
// ---------------------------------------------------------------------

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-08-24T00:00:00Z");

const ITEM: ComponentWorkItem = {
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

const FIXTURE_COST_PROFILE: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

async function makeJob() {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("dle");
  const name = "Link Evidence Test Project";
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name, ticker: null, status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: t.id,
    projectId: project.id,
    originalQuestion: "where does the page say value goes?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return { jobId: job.id, projectId: project.id, projectName: name, projectSlug: slug };
}

// The lifecycle guard forbids INSERT-as-ACTIVE; walk the legal path.
async function activateSourceRoute(projectId: string, content: Record<string, unknown>) {
  const [row] = await ctx.db
    .insert(projectMemoryItems)
    .values({ projectId, kind: "SOURCE_ROUTE", content, lifecycleState: "OBSERVED" })
    .returning();
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "CANDIDATE" })
    .where(eq(projectMemoryItems.id, row.id));
  await ctx.db
    .update(projectMemoryItems)
    .set({ lifecycleState: "ACTIVE" })
    .where(eq(projectMemoryItems.id, row.id));
}

function fixedQueryProposer(queries: string[]): QueryProposer {
  return { name: "fixture", async proposeQueries() { return queries; } };
}
function fixedSearchGateway(urls: string[]): SearchGateway {
  return {
    name: "fixture",
    async search(query) {
      return urls.map((url) => ({ url, title: `result for ${query}`, snippet: "a snippet, never evidence" }));
    },
  };
}
function fixedContentFetcher(byUrl: Record<string, FetchedDocument>): ContentFetcher {
  return {
    name: "fixture",
    async fetch(url) {
      const d = byUrl[url];
      if (!d) throw new ContentFetchError("HTTP_ERROR", "not in fixture", url);
      return d;
    },
  };
}
function fixedExtractor(facts: ExtractedFact[]): EvidenceExtractor {
  return { name: "fixture", async extract() { return facts; } };
}

function depsFor(
  jobId: string,
  p: { projectId: string; projectName: string; projectSlug: string },
  o: {
    searchGateway?: SearchGateway;
    contentFetcher?: ContentFetcher;
    evidenceExtractor?: EvidenceExtractor;
  } = {},
) {
  return {
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
    queryProposer: fixedQueryProposer(["q1"]),
    searchGateway: o.searchGateway ?? fixedSearchGateway([]),
    contentFetcher: o.contentFetcher ?? fixedContentFetcher({}),
    evidenceExtractor: o.evidenceExtractor ?? fixedExtractor([]),
    queryProposerCostProfile: FIXTURE_COST_PROFILE,
    evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
  };
}

function ctxFor(jobId: string) {
  return {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro: 1_000_000 },
  };
}

// A document exactly as the renderer would present it: page text, then the
// bounded appendix built from the same html.
function renderedLikeDoc(projectName: string, url = PAGE_URL): FetchedDocument {
  const pageText = [
    `${projectName} token economics`,
    "Half of revenue buys the token and destroys it.",
    "Destination addresses",
    "4Hs9Tz…DkGm",
    "7KpLmN…bCdE",
  ].join("\n");
  const appendix = renderLinkAppendix(extractDocumentLinks(SAMPLE_HTML));
  const normalizedText = `${pageText}\n\n${appendix}`;
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText,
    contentHash: "sha256:fixture-rendered",
    fetchedAt: NOW,
    byteLength: SAMPLE_HTML.length,
  };
}

function appendixLineFor(id: string): string {
  const appendix = renderLinkAppendix(extractDocumentLinks(SAMPLE_HTML));
  return appendix.split("\n").find((l) => l.includes(id))!;
}

describe("a recovered link and Evidence", () => {
  it("the exact identifier is quotable, so a fact about it survives the traceability check", async () => {
    const p = await makeJob();
    await activateSourceRoute(p.projectId, {
      domain: HOST,
      pathPrefix: "/token",
      routeClass: "OFFICIAL_DOCS",
    });
    const executor = createS4WorkExecutor(
      depsFor(p.jobId, p, {
        searchGateway: fixedSearchGateway([PAGE_URL]),
        contentFetcher: fixedContentFetcher({ [PAGE_URL]: renderedLikeDoc(p.projectName) }),
        evidenceExtractor: fixedExtractor([
          {
            step: 1,
            component: "SOURCE_OF_VALUE",
            statement: `the page lists ${FULL_ID_A} under the heading "Destination addresses"`,
            supportFragment: appendixLineFor(FULL_ID_A),
            mechanismState: null,
            directness: "DIRECT",
            publishedAt: null,
            doesNotProve:
              "does not prove any token reached this address, nor that any supply changed",
            relationship: "SUPPORTS",
          },
        ]),
      }),
    );
    await executor.execute(ITEM, ctxFor(p.jobId));
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    expect(rows.length).toBe(1);
    // The whole point: the persisted excerpt carries the EXACT value, not
    // the page's visually truncated rendering of it.
    expect(rows[0].fragment).toContain(FULL_ID_A);
    expect(rows[0].doesNotProve).toBeTruthy();
  });

  it("a link creates NO Evidence on its own — with no extracted fact, nothing is persisted", async () => {
    const p = await makeJob();
    await activateSourceRoute(p.projectId, {
      domain: HOST,
      pathPrefix: "/token",
      routeClass: "OFFICIAL_DOCS",
    });
    const executor = createS4WorkExecutor(
      depsFor(p.jobId, p, {
        searchGateway: fixedSearchGateway([PAGE_URL]),
        contentFetcher: fixedContentFetcher({ [PAGE_URL]: renderedLikeDoc(p.projectName) }),
        // The document is full of recovered hrefs; the extractor reports
        // nothing. An empty facts array is a valid outcome.
        evidenceExtractor: fixedExtractor([]),
      }),
    );
    await executor.execute(ITEM, ctxFor(p.jobId));
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    expect(rows.length).toBe(0);
  });

  it("an identifier that appears in NO link is still refused as untraceable", async () => {
    const p = await makeJob();
    await activateSourceRoute(p.projectId, {
      domain: HOST,
      pathPrefix: "/token",
      routeClass: "OFFICIAL_DOCS",
    });
    const executor = createS4WorkExecutor(
      depsFor(p.jobId, p, {
        searchGateway: fixedSearchGateway([PAGE_URL]),
        contentFetcher: fixedContentFetcher({ [PAGE_URL]: renderedLikeDoc(p.projectName) }),
        evidenceExtractor: fixedExtractor([
          {
            step: 1,
            component: "SOURCE_OF_VALUE",
            statement: "the page lists another address",
            supportFragment: "href=https://explorer.example.test/account/NeverAppearedAnywhere",
            mechanismState: null,
            directness: "DIRECT",
            publishedAt: null,
            doesNotProve: "n/a",
            relationship: "SUPPORTS",
          },
        ]),
      }),
    );
    await executor.execute(ITEM, ctxFor(p.jobId));
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    expect(rows.length).toBe(0);
  });
});

describe("a recovered link and source authority", () => {
  it("authority comes from the DOCUMENT's confirmed route, not from the link inside it", async () => {
    const p = await makeJob();
    await activateSourceRoute(p.projectId, {
      domain: HOST,
      pathPrefix: "/token",
      routeClass: "OFFICIAL_DOCS",
    });
    const executor = createS4WorkExecutor(
      depsFor(p.jobId, p, {
        searchGateway: fixedSearchGateway([PAGE_URL]),
        contentFetcher: fixedContentFetcher({ [PAGE_URL]: renderedLikeDoc(p.projectName) }),
        evidenceExtractor: fixedExtractor([
          {
            step: 1,
            component: "SOURCE_OF_VALUE",
            statement: `the page lists ${FULL_ID_A} under "Destination addresses"`,
            supportFragment: appendixLineFor(FULL_ID_A),
            mechanismState: null,
            directness: "DIRECT",
            publishedAt: null,
            doesNotProve: "does not prove anything reached that address",
            relationship: "SUPPORTS",
          },
        ]),
      }),
    );
    await executor.execute(ITEM, ctxFor(p.jobId));
    const [row] = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    expect(row.officiality).toBe("CONFIRMED");
    expect(row.sourceClass).toBe("OFFICIAL_DOCS");
    // The Evidence is attributed to the PAGE, never to the host it links
    // to — the recovered href is quoted content, not a second source.
    expect(row.retrievedUrl).toBe(PAGE_URL);
    const srcRows = await ctx.db.select().from(sources);
    const hosts = srcRows.map((s) => new URL(s.url).hostname);
    expect(hosts).toContain(HOST);
    expect(hosts).not.toContain("explorer.example.test");
  });

  it("an external link on an official page does NOT make the linked host official", async () => {
    // Same recovered link, but reached as its own source: the explorer
    // host has no confirmed route of its own, so it classifies from its
    // own domain and stays CLAIMED. Being linked from an OFFICIAL_DOCS
    // page conferred nothing.
    const p = await makeJob();
    await activateSourceRoute(p.projectId, {
      domain: HOST,
      pathPrefix: "/token",
      routeClass: "OFFICIAL_DOCS",
    });
    const externalUrl = `https://explorer.example.test/account/${FULL_ID_A}`;
    const externalDoc: FetchedDocument = {
      finalUrl: externalUrl,
      requestedUrl: externalUrl,
      httpStatus: 200,
      contentType: "text/html",
      normalizedText: `${p.projectName}: account ${FULL_ID_A} holds a balance`,
      contentHash: "sha256:fixture-external",
      fetchedAt: NOW,
      byteLength: 100,
    };
    const executor = createS4WorkExecutor(
      depsFor(p.jobId, p, {
        searchGateway: fixedSearchGateway([externalUrl]),
        contentFetcher: fixedContentFetcher({ [externalUrl]: externalDoc }),
        evidenceExtractor: fixedExtractor([
          {
            step: 1,
            component: "SOURCE_OF_VALUE",
            statement: "the account holds a balance",
            supportFragment: `account ${FULL_ID_A} holds a balance`,
            mechanismState: null,
            directness: "DIRECT",
            publishedAt: null,
            doesNotProve: "does not prove where the balance came from",
            relationship: "SUPPORTS",
          },
        ]),
      }),
    );
    await executor.execute(ITEM, ctxFor(p.jobId));
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
    for (const row of rows) {
      expect(row.officiality).toBe("CLAIMED");
      expect(row.sourceClass).not.toBe("OFFICIAL_DOCS");
    }
  });
});
