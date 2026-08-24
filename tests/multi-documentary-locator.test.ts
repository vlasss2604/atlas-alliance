import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  evidenceDocumentaryLocators,
  projectMemoryItems,
  projects,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import {
  findAdmittedLocator,
  locatorsForEvidence,
  MAX_LOCATORS_PER_FACT,
  persistFactLocators,
  validateFactLocators,
} from "../src/server/engine/documentary-locator-store";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import type { ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { extractDocumentLinks, renderLinkAppendix } from "../src/server/engine/providers/document-links";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ONE FACT, MANY DOCUMENTARY LOCATORS.
//
// A page listing two burn addresses under one heading states ONE fact about
// TWO accounts. The scalar column forced a choice, and the choice was made
// silently — the second address was simply lost.
//
// The fix must not become a new way to smuggle an identifier in. Every
// locator is validated independently, which cuts both ways: a bad entry
// never contaminates a good one, and a good entry never launders a bad one.
// And no rejection may cost the FACT, which remains true documentary
// evidence whether or not it manages to locate anything.

// Synthetic throughout — not any real project's values.
const FULL_A = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm";
const FULL_B = "7KpLmNqRsTuVwXyZaBcDeFgHjKmNpQrStUvWxYzAbCdE";
// Valid base58 (no 0/O/I/l) and deliberately NOT in the document — so it
// is refused for being absent, not for being malformed.
const FULL_C = "8Qw3rTyU9pAsDfGhJkLzXcVbNmQw3rTyU9pAsDfGhJkm";
const TRUNCATED_A = "4Hs9Tz…CvDkGm";
const AMBIGUOUS_TWIN = `${FULL_A.slice(0, 20)}x${FULL_A.slice(21)}`;

const HOST = "docs.example-project.test";
const PAGE_URL = `https://${HOST}/token/economics`;

// Two anchors, each with its own truncated text and its own exact href —
// the shape the real page had.
const TWO_ADDRESS_HTML = `<html><body><h2>Destination addresses</h2>
  <a href="https://explorer.example.test/account/${FULL_A}">4Hs9Tz&#8230;CvDkGm</a>
  <a href="https://explorer.example.test/account/${FULL_B}">7KpLmN&#8230;AbCdE</a>
  </body></html>`;

function documentText(projectName: string): string {
  const pageText = `${projectName} destination addresses\n4Hs9Tz…CvDkGm\n7KpLmN…AbCdE`;
  return `${pageText}\n\n${renderLinkAppendix(extractDocumentLinks(TWO_ADDRESS_HTML))}`;
}

describe("validation is per locator, never per fact", () => {
  const text = documentText("Locator Test Project");

  it("1. one fact yields TWO valid full locators", () => {
    const out = validateFactLocators({ claimed: [FULL_A, FULL_B], documentText: text });
    expect(out.confirmed.map((c) => c.value)).toEqual([FULL_A, FULL_B]);
    expect(out.confirmed.every((c) => c.shape === "ADDRESS_LIKE")).toBe(true);
    expect(out.rejected).toEqual([]);
  });

  it("3. a truncated second locator is rejected and the first survives", () => {
    const out = validateFactLocators({ claimed: [FULL_A, TRUNCATED_A], documentText: text });
    expect(out.confirmed.map((c) => c.value)).toEqual([FULL_A]);
    expect(out.rejected.map((r) => r.reason)).toEqual(["TRUNCATED_DISPLAY_FORM"]);
  });

  it("4. an ambiguous second locator is rejected and the first survives", () => {
    // The twin shares the visible head and tail and differs only where the
    // page elided — so the DOM never resolved it, and it is not in the text.
    expect(text).not.toContain(AMBIGUOUS_TWIN);
    const out = validateFactLocators({ claimed: [FULL_A, AMBIGUOUS_TWIN], documentText: text });
    expect(out.confirmed.map((c) => c.value)).toEqual([FULL_A]);
    expect(out.rejected.map((r) => r.reason)).toEqual(["NOT_LITERAL_IN_DOCUMENT"]);
  });

  it("5. an unrelated external identifier is rejected and the first survives", () => {
    const out = validateFactLocators({ claimed: [FULL_A, FULL_C], documentText: text });
    expect(out.confirmed.map((c) => c.value)).toEqual([FULL_A]);
    expect(out.rejected.map((r) => r.reason)).toEqual(["NOT_LITERAL_IN_DOCUMENT"]);
  });

  it("order does not matter — a bad FIRST entry does not cost a good second", () => {
    const out = validateFactLocators({ claimed: [TRUNCATED_A, FULL_B], documentText: text });
    expect(out.confirmed.map((c) => c.value)).toEqual([FULL_B]);
  });

  it("a good neighbour never launders a bad one", () => {
    // Three proposals, one valid: validity is decided per value, so the
    // valid one cannot vouch for the others.
    const out = validateFactLocators({
      claimed: [FULL_A, TRUNCATED_A, FULL_C, "the burn wallet"],
      documentText: text,
    });
    expect(out.confirmed.map((c) => c.value)).toEqual([FULL_A]);
    expect(out.rejected.map((r) => r.reason)).toEqual([
      "TRUNCATED_DISPLAY_FORM",
      "NOT_LITERAL_IN_DOCUMENT",
      "NOT_A_COMPLETE_IDENTIFIER",
    ]);
  });

  it("the same address twice is one locator, not two", () => {
    const out = validateFactLocators({ claimed: [FULL_A, FULL_A], documentText: text });
    expect(out.confirmed.map((c) => c.value)).toEqual([FULL_A]);
    expect(out.rejected).toEqual([]);
  });

  it("claiming nothing is the ordinary case and produces no rejection", () => {
    const out = validateFactLocators({ claimed: [null, undefined, ""], documentText: text });
    expect(out.confirmed).toEqual([]);
    expect(out.rejected).toEqual([]);
  });

  it("the number of locators one fact may carry is bounded", () => {
    const many = Array.from({ length: 50 }, () => FULL_A);
    const out = validateFactLocators({ claimed: many, documentText: text });
    expect(out.confirmed.length).toBeLessThanOrEqual(MAX_LOCATORS_PER_FACT);
  });

  it("11. no project-specific logic in the store", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/documentary-locator-store.ts", import.meta.url),
      "utf-8",
    );
    const c = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const banned of ["pump", "solscan", "solana", "etherscan", "burn", "treasury", "buyback"]) {
      expect(c, `store code mentions "${banned}"`).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------
// Persistence, through the real executor and the real tables.
// ---------------------------------------------------------------------

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const NOW = new Date("2026-08-25T00:00:00Z");

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
  const slug = uniq("mdl");
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

function docFor(projectName: string): FetchedDocument {
  const text = documentText(projectName);
  return {
    finalUrl: PAGE_URL,
    requestedUrl: PAGE_URL,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: "sha256:fixture-multi",
    fetchedAt: NOW,
    byteLength: text.length,
  };
}

function fact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    step: 6,
    component: "DESTINATION",
    statement: "the page names destination accounts",
    supportFragment: "destination addresses",
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove anything reached those accounts",
    relationship: "SUPPORTS",
    ...over,
  };
}

async function runWith(over: Partial<ExtractedFact>) {
  const p = await makeJob();
  await activateSourceRoute(p.projectId, {
    domain: HOST,
    pathPrefix: "/token",
    routeClass: "OFFICIAL_DOCS",
  });
  const doc = docFor(p.projectName);
  const searchGateway: SearchGateway = {
    name: "fixture",
    async search() {
      return [{ url: PAGE_URL, title: "t", snippet: "not evidence" }];
    },
  };
  const contentFetcher: ContentFetcher = {
    name: "fixture",
    async fetch(url) {
      if (url !== PAGE_URL) throw new ContentFetchError("HTTP_ERROR", "not in fixture", url);
      return doc;
    },
  };
  const queryProposer: QueryProposer = { name: "fixture", async proposeQueries() { return ["q1"]; } };
  const evidenceExtractor: EvidenceExtractor = { name: "fixture", async extract() { return [fact(over)]; } };
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: p.projectId, name: p.projectName, slug: p.projectSlug, ticker: null },
    queryProposer,
    searchGateway,
    contentFetcher,
    evidenceExtractor,
    queryProposerCostProfile: FIXTURE_COST_PROFILE,
    evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
  });
  await executor.execute(ITEM, {
    jobId: p.jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 10, maxSourceOpens: 10, maxModelCostMicro: 1_000_000 },
  });
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, p.jobId));
  const locators = rows.length > 0 ? await locatorsForEvidence(ctx.db, rows[0].id) : [];
  const trace = await ctx.db
    .select()
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, p.jobId));
  return { rows, locators, trace, doc };
}

describe("persistence — one fact, many locators", () => {
  it("1/2. two valid locators are stored and independently queryable", async () => {
    const { rows, locators } = await runWith({ onchainLocators: [FULL_A, FULL_B] });
    expect(rows.length).toBe(1);
    expect(locators.map((l) => l.value)).toEqual([FULL_A, FULL_B]);
    // Each is findable on its own — the gate's actual question.
    for (const value of [FULL_A, FULL_B]) {
      const found = await findAdmittedLocator(ctx.db, value);
      expect(found.length, value).toBe(1);
      expect(found[0].evidenceId).toBe(rows[0].id);
      expect(found[0].value).toBe(value);
    }
    // And the scalar keeps showing ordinal 0.
    expect(rows[0].documentaryLocator).toBe(FULL_A);
  });

  it("3/6/7. a truncated second locator is dropped; the valid locator AND the fact survive", async () => {
    const { rows, locators, trace } = await runWith({
      onchainLocators: [FULL_A, TRUNCATED_A],
    });
    expect(rows.length).toBe(1); // 7 — the fact stands
    expect(locators.map((l) => l.value)).toEqual([FULL_A]); // 6 — the valid one stands
    expect(rows[0].sourceClass).toBe("OFFICIAL_DOCS");
    expect(
      trace.find((t) => t.operationType === "LOCATOR_REJECTED")?.reasonCode,
    ).toBe("LOCATOR_TRUNCATED");
  });

  it("4/6/7. an ambiguous second locator is dropped; the valid locator and the fact survive", async () => {
    const { rows, locators, trace } = await runWith({
      onchainLocators: [FULL_A, AMBIGUOUS_TWIN],
    });
    expect(rows.length).toBe(1);
    expect(locators.map((l) => l.value)).toEqual([FULL_A]);
    expect(
      trace.find((t) => t.operationType === "LOCATOR_REJECTED")?.reasonCode,
    ).toBe("LOCATOR_NOT_IN_DOCUMENT");
  });

  it("5/6/7. an unrelated external identifier is dropped; the valid locator and the fact survive", async () => {
    const { rows, locators } = await runWith({ onchainLocators: [FULL_A, FULL_C] });
    expect(rows.length).toBe(1);
    expect(locators.map((l) => l.value)).toEqual([FULL_A]);
    // The unrelated value is admitted nowhere.
    expect(await findAdmittedLocator(ctx.db, FULL_C)).toEqual([]);
  });

  it("a fact whose ONLY locator is invalid is still admitted, with none stored", async () => {
    const { rows, locators } = await runWith({ onchainLocator: TRUNCATED_A });
    expect(rows.length).toBe(1);
    expect(rows[0].documentaryLocator).toBeNull();
    expect(locators).toEqual([]);
  });

  it("the scalar and the array reach the same validator", async () => {
    const { locators } = await runWith({ onchainLocator: FULL_A, onchainLocators: [FULL_B] });
    expect(locators.map((l) => l.value)).toEqual([FULL_A, FULL_B]);
  });

  it("10. no model-only path bypasses validation", async () => {
    // Everything a model could say that is not a complete identifier
    // literally present in the document stores nothing at all.
    const { rows, locators } = await runWith({
      onchainLocators: [TRUNCATED_A, FULL_C, "the burn wallet", FULL_A.toLowerCase()],
    });
    expect(rows.length).toBe(1);
    expect(locators).toEqual([]);
    expect(rows[0].documentaryLocator).toBeNull();
  });

  it("persistFactLocators has no parameter through which an unvalidated string can arrive", async () => {
    // A structural argument, checked as a type-level fact: the only input
    // is ConfirmedLocator[], which the validator alone constructs.
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/documentary-locator-store.ts", import.meta.url),
      "utf-8",
    );
    expect(raw).toContain("locators: readonly ConfirmedLocator[]");
    expect(raw).toContain('validationResult: "CONFIRMED"');
  });

  it("the database refuses an unvalidated or malformed locator row outright", async () => {
    const { rows } = await runWith({ onchainLocators: [FULL_A] });
    const evidenceId = rows[0].id;
    // Truncated value — refused by the shape CHECK.
    await expect(
      ctx.db.insert(evidenceDocumentaryLocators).values({
        evidenceId,
        ordinal: 90,
        value: TRUNCATED_A,
        shape: "ADDRESS_LIKE",
        literallyPresent: true,
        validationResult: "CONFIRMED",
      }),
    ).rejects.toThrow();
    // Well-formed but never validated — refused by the validation CHECK.
    await expect(
      ctx.db.insert(evidenceDocumentaryLocators).values({
        evidenceId,
        ordinal: 91,
        value: FULL_C,
        shape: "ADDRESS_LIKE",
        literallyPresent: false,
        validationResult: "CONFIRMED",
      }),
    ).rejects.toThrow();
  });
});

describe("backwards compatibility and the on-chain gate", () => {
  it("8. historical scalar-locator evidence stays readable and findable", async () => {
    // A row shaped like one written BEFORE the child table existed: the
    // scalar set, no locator rows at all.
    const p = await makeJob();
    const [src] = await ctx.db
      .insert(sources)
      .values({ url: PAGE_URL, urlHash: uniq("hash"), sourceType: "OFFICIAL_DOCS" })
      .returning();
    const [legacy] = await ctx.db
      .insert(evidence)
      .values({
        researchJobId: p.jobId,
        sourceId: src.id,
        patternStep: 6,
        component: "DESTINATION",
        relationship: "SUPPORTS",
        directness: "DIRECT",
        fragment: "legacy fragment",
        summary: "legacy row",
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        documentaryLocator: FULL_B,
        fetchedAt: NOW,
        retrievedUrl: PAGE_URL,
        contentHash: "sha256:legacy",
      })
      .returning();
    expect(await locatorsForEvidence(ctx.db, legacy.id)).toEqual([]);
    // The gate answers for it anyway — one code path, not two.
    const found = await findAdmittedLocator(ctx.db, FULL_B);
    const hit = found.find((f) => f.evidenceId === legacy.id);
    expect(hit).toBeTruthy();
    expect(hit!.value).toBe(FULL_B);
    expect(hit!.retrievedUrl).toBe(PAGE_URL);
  });

  it("9. the gate targets ONE specific admitted locator, not the fact's whole set", async () => {
    const { rows } = await runWith({ onchainLocators: [FULL_A, FULL_B] });
    const a = await findAdmittedLocator(ctx.db, FULL_A);
    expect(a.length).toBeGreaterThan(0);
    for (const hit of a) expect(hit.value).toBe(FULL_A); // never the sibling
    expect(a.some((h) => h.evidenceId === rows[0].id)).toBe(true);
    // An address that shares the fact with FULL_A is still a separate answer.
    const b = await findAdmittedLocator(ctx.db, FULL_B);
    for (const hit of b) expect(hit.value).toBe(FULL_B);
  });

  it("the gate carries the DOCUMENT's authority, never the locator's", async () => {
    const { rows } = await runWith({ onchainLocators: [FULL_A] });
    const [hit] = (await findAdmittedLocator(ctx.db, FULL_A)).filter(
      (f) => f.evidenceId === rows[0].id,
    );
    // Authority comes from the parent Evidence row's confirmed route.
    expect(hit.sourceClass).toBe("OFFICIAL_DOCS");
    expect(hit.officiality).toBe("CONFIRMED");
    expect(hit.retrievedUrl).toBe(PAGE_URL);
    // The external host the identifier was recovered from appears nowhere.
    expect(JSON.stringify(hit)).not.toContain("explorer.example.test");
  });

  it("the gate never matches a partial or differently-cased value", async () => {
    await runWith({ onchainLocators: [FULL_A] });
    for (const near of [FULL_A.slice(0, 20), FULL_A.toLowerCase(), `${FULL_A}x`, ""]) {
      expect(await findAdmittedLocator(ctx.db, near), near).toEqual([]);
    }
  });

  it("persistFactLocators is idempotent for a replayed fact", async () => {
    const { rows } = await runWith({ onchainLocators: [FULL_A, FULL_B] });
    const before = await locatorsForEvidence(ctx.db, rows[0].id);
    await persistFactLocators(ctx.db, rows[0].id, before);
    expect(await locatorsForEvidence(ctx.db, rows[0].id)).toEqual(before);
  });
});
