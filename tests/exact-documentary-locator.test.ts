import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  projectMemoryItems,
  projects,
  researchTraceEvents,
  topics,
  users,
} from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import {
  completeIdentifierShape,
  isTruncatedDisplayForm,
  literallyPresent,
  validateDocumentaryLocator,
} from "../src/server/engine/documentary-locator";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import {
  extractDocumentLinks,
  renderLinkAppendix,
  resolveTruncatedText,
} from "../src/server/engine/providers/document-links";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// EXACT DOCUMENTARY LOCATOR INVARIANT.
//
// A live acquisition of a confirmed OFFICIAL_DOCS page produced three
// admissible documentary facts and no usable locator: the page rendered
// "99mRw3…pm4F3c" and extraction quoted what it saw. The elided
// characters are not recoverable from that string by any means this
// system is willing to use, so the invariant is enforced in CODE and the
// prompt is only an optimisation on top of it.
//
// The properties proved here:
//   * a truncated display form can never establish a locator;
//   * a complete identifier stated in ordinary prose can;
//   * a truncated visible text PLUS exactly one agreeing exact href can;
//   * two candidate identifiers fail closed, as does a disagreeing one;
//   * an identifier from an unrelated element is never substituted;
//   * a reconstructed identifier is structurally impossible to admit;
//   * the admitted locator is literally traceable to normalizedText;
//   * authority still comes only from the confirmed route, and the link
//     itself gains none;
//   * none of it knows anything about any particular project.

// Synthetic throughout — deliberately NOT any real project's values.
const FULL_A = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm"; // 43 chars
const FULL_B = "7KpLmNqRsTuVwXyZaBcDeFgHjKmNpQrStUvWxYzAbCdE"; // 44 chars
const TRUNCATED_A = "4Hs9Tz…CvDkGm";
// Same visible head and tail as FULL_A, different where the page elided —
// the only construction that makes a substitution genuinely ambiguous.
const AMBIGUOUS_TWIN = `${FULL_A.slice(0, 20)}x${FULL_A.slice(21)}`;
const FULL_SIGNATURE =
  "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";

const HOST = "docs.example-project.test";
const PAGE_URL = `https://${HOST}/token/economics`;

describe("locator shape and truncation — pure rules", () => {
  it("recognises every common abbreviation marker as truncated", () => {
    for (const abbreviated of [
      "4Hs9Tz…CvDkGm",
      "4Hs9Tz...CvDkGm",
      "4Hs9Tz..CvDkGm",
      "4Hs9Tz⋯CvDkGm",
      "4Hs9Tz···CvDkGm",
      "99mRw3…pm4F3c",
    ]) {
      expect(isTruncatedDisplayForm(abbreviated), abbreviated).toBe(true);
    }
  });

  it("a complete identifier is not truncated", () => {
    for (const complete of [FULL_A, FULL_B, FULL_SIGNATURE]) {
      expect(isTruncatedDisplayForm(complete)).toBe(false);
    }
  });

  it("classifies complete shapes and refuses everything else", () => {
    expect(completeIdentifierShape(FULL_A)).toBe("ADDRESS_LIKE");
    expect(completeIdentifierShape(FULL_SIGNATURE)).toBe("SIGNATURE_LIKE");
    for (const notAnIdentifier of ["", "short", "4Hs9Tz…CvDkGm", "0OIl".repeat(10), "x".repeat(200)]) {
      expect(completeIdentifierShape(notAnIdentifier), notAnIdentifier).toBeNull();
    }
  });

  it("literal presence is case-sensitive — base58 case distinguishes accounts", () => {
    const doc = `the destination is ${FULL_A}.`;
    expect(literallyPresent(doc, FULL_A)).toBe(true);
    expect(literallyPresent(doc, FULL_A.toLowerCase())).toBe(false);
  });

  it("literal presence is base58-bounded — an address inside a longer identifier is not present", () => {
    // The first 43 characters of a signature are not an account the
    // document names, however literally the substring occurs.
    const substring = FULL_SIGNATURE.slice(0, 43);
    expect(completeIdentifierShape(substring)).toBe("ADDRESS_LIKE");
    expect(FULL_SIGNATURE.includes(substring)).toBe(true);
    expect(literallyPresent(`signature ${FULL_SIGNATURE} settled`, substring)).toBe(false);
  });
});

describe("the validator — what may become a locator", () => {
  const doc = `Destination addresses\n4Hs9Tz…CvDkGm\n[LINK] href=https://e.test/a/${FULL_A} | text=4Hs9Tz…CvDkGm | resolves=${FULL_A}`;

  it("REFUSES a truncated display form", () => {
    expect(validateDocumentaryLocator({ claimedLocator: TRUNCATED_A, documentText: doc })).toEqual({
      locator: "NONE",
      reason: "TRUNCATED_DISPLAY_FORM",
    });
  });

  it("accepts the complete identifier the document states", () => {
    expect(validateDocumentaryLocator({ claimedLocator: FULL_A, documentText: doc })).toEqual({
      locator: "CONFIRMED",
      value: FULL_A,
      shape: "ADDRESS_LIKE",
    });
  });

  it("refuses a value the document does not contain", () => {
    expect(validateDocumentaryLocator({ claimedLocator: FULL_B, documentText: doc })).toMatchObject({
      locator: "NONE",
      reason: "NOT_LITERAL_IN_DOCUMENT",
    });
  });

  it("RECONSTRUCTION IS IMPOSSIBLE — a single altered character is refused", () => {
    // Same prefix, same suffix, same length, same alphabet: everything a
    // reconstruction from "4Hs9Tz…CvDkGm" would preserve. It still fails,
    // because the document does not contain it.
    const forged = FULL_A.slice(0, 20) + (FULL_A[20] === "x" ? "y" : "x") + FULL_A.slice(21);
    expect(forged).not.toBe(FULL_A);
    expect(forged.startsWith("4Hs9Tz")).toBe(true);
    expect(forged.endsWith("CvDkGm")).toBe(true);
    expect(validateDocumentaryLocator({ claimedLocator: forged, documentText: doc })).toMatchObject({
      locator: "NONE",
      reason: "NOT_LITERAL_IN_DOCUMENT",
    });
  });

  it("no claim is the ordinary case, not a defect", () => {
    for (const empty of [null, undefined, "", "   "]) {
      expect(validateDocumentaryLocator({ claimedLocator: empty, documentText: doc })).toEqual({
        locator: "NONE",
        reason: "NOT_CLAIMED",
      });
    }
  });

  it("refuses a well-formed-looking value that is not a recognised shape", () => {
    expect(
      validateDocumentaryLocator({ claimedLocator: "the burn wallet", documentText: doc }),
    ).toMatchObject({ locator: "NONE", reason: "NOT_A_COMPLETE_IDENTIFIER" });
  });

  it("a full identifier in ORDINARY PROSE needs no appendix", () => {
    const prose = `Tokens are sent to ${FULL_B}, where they are destroyed.`;
    expect(validateDocumentaryLocator({ claimedLocator: FULL_B, documentText: prose })).toMatchObject({
      locator: "CONFIRMED",
      value: FULL_B,
    });
  });
});

describe("unique context resolution — truncated text plus one exact href", () => {
  it("resolves when exactly one identifier in the SAME element agrees", () => {
    expect(resolveTruncatedText(TRUNCATED_A, [FULL_A])).toBe(FULL_A);
  });

  it("FAILS CLOSED when two candidate identifiers both agree", () => {
    // Genuine ambiguity: two DISTINCT identifiers sharing the visible head
    // and tail and differing only where the page elided. Exactly the case
    // where a substitution would be a coin flip.
    expect(AMBIGUOUS_TWIN).not.toBe(FULL_A);
    expect(AMBIGUOUS_TWIN.startsWith("4Hs9Tz")).toBe(true);
    expect(AMBIGUOUS_TWIN.endsWith("CvDkGm")).toBe(true);
    expect(resolveTruncatedText(TRUNCATED_A, [FULL_A, AMBIGUOUS_TWIN])).toBeNull();
  });

  it("a candidate that agrees on only ONE end is not a second candidate", () => {
    // Sharing the head but not the tail is disagreement, not ambiguity —
    // so the single agreeing candidate still resolves.
    const differentTail = FULL_A.slice(0, -1) + "n";
    expect(resolveTruncatedText(TRUNCATED_A, [FULL_A, differentTail])).toBe(FULL_A);
  });

  it("FAILS CLOSED when the candidate disagrees with the visible prefix or suffix", () => {
    expect(resolveTruncatedText(TRUNCATED_A, [FULL_B])).toBeNull();
    expect(resolveTruncatedText("4Hs9Tz…ZZZZZZ", [FULL_A])).toBeNull();
    expect(resolveTruncatedText("ZZZZZZ…CvDkGm", [FULL_A])).toBeNull();
  });

  it("SHAPE SIMILARITY ALONE IS NOT AGREEMENT", () => {
    // Same shape class, nothing else in common.
    expect(completeIdentifierShape(FULL_B)).toBe(completeIdentifierShape(FULL_A));
    expect(resolveTruncatedText(TRUNCATED_A, [FULL_B])).toBeNull();
  });

  it("returns null when the visible text is not an abbreviation at all", () => {
    expect(resolveTruncatedText("Burn addresses", [FULL_A])).toBeNull();
    expect(resolveTruncatedText(FULL_A, [FULL_A])).toBeNull();
  });

  it("resolves from the element's own data-* value as well as its href", () => {
    const html = `<a href="/x" data-account="${FULL_A}">4Hs9Tz&#8230;CvDkGm</a>`;
    expect(extractDocumentLinks(html).links[0].resolvedIdentifier).toBe(FULL_A);
  });

  it("AN UNRELATED LINK IS NEVER SUBSTITUTED — resolution is scoped to one element", () => {
    // The truncated text is in one anchor; the full identifier is in a
    // DIFFERENT anchor pointing at an unrelated external host.
    const html =
      `<a href="/nothing-here">4Hs9Tz&#8230;CvDkGm</a>` +
      `<a href="https://unrelated.invalid/a/${FULL_A}">unrelated</a>`;
    const out = extractDocumentLinks(html);
    const truncatedLink = out.links.find((l) => l.href === "/nothing-here")!;
    expect(truncatedLink.resolvedIdentifier).toBeNull();
    // And the full value is still recoverable as the other link's href —
    // it is simply not attributed to the truncated text.
    expect(out.links.some((l) => l.href.includes(FULL_A))).toBe(true);
  });

  it("a resolved identifier reaches the appendix beside the text it explains", () => {
    const html = `<a href="https://e.test/a/${FULL_A}">4Hs9Tz&#8230;CvDkGm</a>`;
    const appendix = renderLinkAppendix(extractDocumentLinks(html));
    const line = appendix.split("\n").find((l) => l.includes(FULL_A))!;
    expect(line).toContain("text=4Hs9Tz…CvDkGm");
    expect(line).toContain(`resolves=${FULL_A}`);
  });

  it("an ambiguous anchor emits NO resolves= field at all", () => {
    const html = `<a href="https://e.test/a/${FULL_A}/b/${AMBIGUOUS_TWIN}">4Hs9Tz&#8230;CvDkGm</a>`;
    const out = extractDocumentLinks(html);
    expect(out.links[0].resolvedIdentifier).toBeNull();
    // Not on the link line, and not as a legend either — a document where
    // nothing resolved contains the string nowhere at all.
    expect(renderLinkAppendix(out)).not.toContain("resolves=");
  });

  it("no project-specific logic — an unrelated host resolves identically", () => {
    const a = extractDocumentLinks(`<a href="https://explorer.example.test/account/${FULL_A}">4Hs9Tz&#8230;CvDkGm</a>`);
    const b = extractDocumentLinks(`<a href="https://something.invalid/x/${FULL_A}">4Hs9Tz&#8230;CvDkGm</a>`);
    expect(a.links[0].resolvedIdentifier).toBe(FULL_A);
    expect(b.links[0].resolvedIdentifier).toBe(FULL_A);
  });

  it("the locator modules name no project, chain, host or mechanism", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/documentary-locator.ts",
      "../src/server/engine/providers/document-links.ts",
    ]) {
      const raw = await fs.readFile(new URL(file, import.meta.url), "utf-8");
      const code = raw
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["pump", "solscan", "solana", "etherscan", "burn", "treasury", "buyback"]) {
        expect(code, `${file} code mentions "${banned}"`).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------
// End to end, through the real executor and the real Evidence table.
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
  step: 6,
  stepName: "Token Destination + Recipient",
  component: "DESTINATION",
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
  const slug = uniq("edl");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Locator Test Project", ticker: null, status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: t.id,
    projectId: project.id,
    originalQuestion: "where do the tokens end up?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return { jobId: job.id, projectId: project.id, projectName: "Locator Test Project", projectSlug: slug };
}

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

function deps(
  p: { projectId: string; projectName: string; projectSlug: string },
  doc: FetchedDocument,
  facts: ExtractedFact[],
) {
  const searchGateway: SearchGateway = {
    name: "fixture",
    async search() {
      return [{ url: doc.finalUrl, title: "t", snippet: "not evidence" }];
    },
  };
  const contentFetcher: ContentFetcher = {
    name: "fixture",
    async fetch(url) {
      if (url !== doc.finalUrl) throw new ContentFetchError("HTTP_ERROR", "not in fixture", url);
      return doc;
    },
  };
  const queryProposer: QueryProposer = { name: "fixture", async proposeQueries() { return ["q1"]; } };
  const evidenceExtractor: EvidenceExtractor = { name: "fixture", async extract() { return facts; } };
  return {
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
    queryProposer,
    searchGateway,
    contentFetcher,
    evidenceExtractor,
    queryProposerCostProfile: FIXTURE_COST_PROFILE,
    evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
  };
}

function execCtx(jobId: string) {
  return {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro: 1_000_000 },
  };
}

// The document exactly as the renderer would present it: page text whose
// identifier is truncated, then the bounded appendix carrying the exact
// value beside the text it explains.
const SAMPLE_HTML = `<html><body><h2>Destination addresses</h2>
  <a href="https://explorer.example.test/account/${FULL_A}">4Hs9Tz&#8230;CvDkGm</a>
  </body></html>`;

function renderedDoc(projectName: string): FetchedDocument {
  const pageText = `${projectName} destination addresses\n4Hs9Tz…CvDkGm`;
  const appendix = renderLinkAppendix(extractDocumentLinks(SAMPLE_HTML));
  return {
    finalUrl: PAGE_URL,
    requestedUrl: PAGE_URL,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: `${pageText}\n\n${appendix}`,
    contentHash: "sha256:fixture",
    fetchedAt: NOW,
    byteLength: SAMPLE_HTML.length,
  };
}

function fact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 6,
    component: "DESTINATION",
    statement: "the page names a destination account",
    supportFragment: "destination addresses",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove anything reached that account",
    relationship: "SUPPORTS",
    ...over,
  };
}

async function runWith(
  over: Partial<ExtractedFact>,
  makeDoc: (projectName: string) => FetchedDocument = renderedDoc,
) {
  const p = await makeJob();
  await activateSourceRoute(p.projectId, {
    domain: HOST,
    pathPrefix: "/token",
    routeClass: "OFFICIAL_DOCS",
  });
  const doc = makeDoc(p.projectName);
  const executor = createS4WorkExecutor(deps(p, doc, [fact(over)]));
  await executor.execute(ITEM, execCtx(p.jobId));
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
  const trace = await ctx.db
    .select()
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, p.jobId));
  return { rows, trace, doc };
}

describe("the invariant, end to end through Evidence", () => {
  it("A TRUNCATED ADDRESS CANNOT ESTABLISH A LOCATOR — but the fact still stands", async () => {
    const { rows, trace } = await runWith({ onchainLocator: TRUNCATED_A });
    expect(rows.length).toBe(1);
    expect(rows[0].documentaryLocator).toBeNull();
    // The documentary observation is preserved: it is true and useful,
    // it simply locates nothing.
    expect(rows[0].sourceClass).toBe("OFFICIAL_DOCS");
    const rejection = trace.find((t) => t.operationType === "LOCATOR_REJECTED");
    expect(rejection?.reasonCode).toBe("LOCATOR_TRUNCATED");
  });

  it("a truncated visible text PLUS one exact href establishes the exact locator", async () => {
    const { rows } = await runWith({
      onchainLocator: FULL_A,
      supportFragment: `resolves=${FULL_A}`,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].documentaryLocator).toBe(FULL_A);
  });

  it("a full address in ordinary prose establishes it with no appendix involved", async () => {
    const proseDoc = (projectName: string): FetchedDocument => {
      const prose = `${projectName} sends tokens to ${FULL_B} and destroys them.`;
      return {
        finalUrl: PAGE_URL,
        requestedUrl: PAGE_URL,
        httpStatus: 200,
        contentType: "text/html",
        normalizedText: prose,
        contentHash: "sha256:prose",
        fetchedAt: NOW,
        byteLength: prose.length,
      };
    };
    const { rows, doc } = await runWith(
      { onchainLocator: FULL_B, supportFragment: `sends tokens to ${FULL_B}` },
      proseDoc,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].documentaryLocator).toBe(FULL_B);
    // No link, no appendix — plain prose is sufficient on its own.
    expect(doc.normalizedText).not.toContain("resolves=");
  });

  it("a reconstructed identifier is refused and traced", async () => {
    const forged = FULL_A.slice(0, 20) + "x" + FULL_A.slice(21);
    const { rows, trace } = await runWith({ onchainLocator: forged });
    expect(rows[0].documentaryLocator).toBeNull();
    expect(trace.find((t) => t.operationType === "LOCATOR_REJECTED")?.reasonCode).toBe(
      "LOCATOR_NOT_IN_DOCUMENT",
    );
  });

  it("an identifier from an UNRELATED EXTERNAL LINK cannot be substituted", async () => {
    // FULL_B is a perfectly valid identifier on some other page. It is
    // not in THIS document, so it cannot become this fact's locator.
    const { rows, trace } = await runWith({ onchainLocator: FULL_B });
    expect(rows[0].documentaryLocator).toBeNull();
    expect(trace.find((t) => t.operationType === "LOCATOR_REJECTED")?.reasonCode).toBe(
      "LOCATOR_NOT_IN_DOCUMENT",
    );
  });

  it("an admitted locator is literally traceable to the document text", async () => {
    const { rows, doc } = await runWith({
      onchainLocator: FULL_A,
      supportFragment: `resolves=${FULL_A}`,
    });
    expect(rows[0].documentaryLocator).toBeTruthy();
    expect(literallyPresent(doc.normalizedText, rows[0].documentaryLocator!)).toBe(true);
  });

  it("authority still comes ONLY from the confirmed route; the link gains none", async () => {
    const { rows } = await runWith({
      onchainLocator: FULL_A,
      supportFragment: `resolves=${FULL_A}`,
    });
    expect(rows[0].sourceClass).toBe("OFFICIAL_DOCS");
    expect(rows[0].officiality).toBe("CONFIRMED");
    // Attributed to the page, never to explorer.example.test.
    expect(rows[0].retrievedUrl).toBe(PAGE_URL);
    // A locator is not an entity binding: knowing the document states an
    // identifier says nothing about whose identifier it is.
    expect(rows[0].entityBinding).toBeNull();
  });

  it("a fact claiming no locator produces no rejection trace and a NULL column", async () => {
    const { rows, trace } = await runWith({ onchainLocator: null });
    expect(rows[0].documentaryLocator).toBeNull();
    expect(trace.some((t) => t.operationType === "LOCATOR_REJECTED")).toBe(false);
  });

  it("the model's proposed value never reaches the column unvalidated", async () => {
    // Everything the model could say that is not a complete identifier
    // literally present in the document leaves the column NULL.
    for (const claimed of [TRUNCATED_A, FULL_B, "the burn wallet", FULL_A.toLowerCase()]) {
      const { rows } = await runWith({ onchainLocator: claimed });
      expect(rows[0].documentaryLocator, `admitted "${claimed}"`).toBeNull();
    }
  });
});
