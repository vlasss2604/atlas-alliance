import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
import { identifierShapeOfAnyFamily } from "../src/server/domain/identifier-shape";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { locatorsForEvidence } from "../src/server/engine/documentary-locator-store";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import type { EvidenceExtractor } from "../src/server/engine/providers/evidence-extractor";
import { __setOnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import type { QueryProposer } from "../src/server/engine/providers/query-proposer";
import type { SearchGateway } from "../src/server/engine/providers/search-gateway";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// DOCUMENTARY LOCATOR — MULTI-CHAIN DB CONSTRAINT V1.
//
// THE PROVEN FAILURE. The first normal live Research of an Ethereum
// project crashed at its Evidence insert: the environment-aware validator
// admitted the project's own 0x contract address as a documentary
// locator (the document states it in full), and the database refused the
// row because the CHECK backstops written before the evidence-environment
// seam (migrations 0027 and 0028) still stated one identifier family,
// base58. Application and database disagreed about what an identifier is.
//
// THE INVARIANT THESE TESTS PIN. The database's shape backstop is the
// application's family rule restated, no wider and no narrower:
//   application admits a locator  -> the database can persist it
//   application refuses a locator -> the database refuses it too
// for every family domain/identifier-shape.ts admits, and for nothing
// else. Proven through the REAL S4 executor writing REAL rows, and through
// the constraint itself for values the executor would never send.
//
// Synthetic identifiers throughout — no real project's values.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});
afterEach(() => {
  __setOnchainRetriever(null);
});

// EVM: a checksummed (mixed-case) address, its lowercase spelling, and a
// transaction hash. Base58: an address and a signature.
const EVM_ADDRESS_CHECKSUMMED = "0x" + "Ab12".repeat(10);
const EVM_ADDRESS_LOWER = EVM_ADDRESS_CHECKSUMMED.toLowerCase();
const EVM_TX_HASH = "0x" + "9f".repeat(32);
const BASE58_ADDRESS = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm";
const BASE58_SIGNATURE = "5" + "Kq".repeat(43); // 87 chars of the base58 alphabet

const HOST = "docs.example-project.test";
const PAGE_URL = `https://${HOST}/token/economics`;
const NOW = new Date("2026-09-13T00:00:00Z");

const FIXTURE_COST_PROFILE: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

// The component the live run crashed on: a documentary component whose
// page happens to state the project's own contract. Any component would
// do; this one keeps the reproduction faithful.
const GOVERNANCE_BASIS: ComponentWorkItem = {
  step: 3,
  stepName: "Governance Basis",
  component: "GOVERNANCE_BASIS",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

interface Fixture {
  jobId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
}

async function makeFixture(identity: { chain: "ethereum" | "solana"; tokenAddress: string } | null): Promise<Fixture> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("dlf");
  const projectName = "Locator Family Test Project";
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: projectName, ticker: null, status: "ACTIVE_CORE" })
    .returning();
  if (identity !== null) {
    // The controlled confirmation workflow, so the identity is a real
    // ACTIVE PROJECT_IDENTITY row the acquisition plan resolves.
    const ok = await confirmProjectIdentity(ctx.db, { projectSlug: slug, ...identity });
    if (!ok.ok) throw new Error("fixture identity failed: " + ok.refusal);
  }
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: t.id,
    projectId: project.id,
    originalQuestion: "how is the token governed?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  // A confirmed OFFICIAL_DOCS route, so the row's authority is decided by
  // the same code-owned resolver a real run uses.
  const [route] = await ctx.db
    .insert(projectMemoryItems)
    .values({ projectId: project.id, kind: "SOURCE_ROUTE", content: { domain: HOST, pathPrefix: "/token", routeClass: "OFFICIAL_DOCS" }, lifecycleState: "OBSERVED" })
    .returning();
  await ctx.db.update(projectMemoryItems).set({ lifecycleState: "CANDIDATE" }).where(eq(projectMemoryItems.id, route.id));
  await ctx.db.update(projectMemoryItems).set({ lifecycleState: "ACTIVE" }).where(eq(projectMemoryItems.id, route.id));
  return { jobId: job.id, projectId: project.id, projectName, projectSlug: slug };
}

// The page states the identifier in full, in prose, bounded by ordinary
// punctuation — exactly how the live page printed the contract address.
function docFor(projectName: string, statedIdentifier: string): FetchedDocument {
  const text = `${projectName}: the token governs all protocol decisions. The token contract address - ${statedIdentifier} . Holders vote on every proposal.`;
  return {
    finalUrl: PAGE_URL,
    requestedUrl: PAGE_URL,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: "sha256:fixture-" + uniq("doc"),
    fetchedAt: NOW,
    byteLength: text.length,
  };
}

// What extraction proposed: the fact's locator is what the operator's
// document literally states. Everything after this is the executor's.
async function runNormalPath(f: Fixture, statedIdentifier: string, claimedLocator: string) {
  const doc = docFor(f.projectName, statedIdentifier);
  const fact: ExtractedFact = {
    step: 3,
    component: "GOVERNANCE_BASIS",
    statement: "the token governs all protocol decisions",
    supportFragment: "the token governs all protocol decisions",
    mechanismState: "LIVE",
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "specific constraints on how value reaches token holders",
    relationship: "CONTEXT",
    onchainLocator: claimedLocator,
  };
  const queryProposer: QueryProposer = { name: "fixture", async proposeQueries() { return ["q1"]; } };
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
  const evidenceExtractor: EvidenceExtractor = { name: "fixture", async extract() { return [fact]; } };
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: f.projectId, name: f.projectName, slug: f.projectSlug, ticker: null },
    queryProposer,
    searchGateway,
    contentFetcher,
    evidenceExtractor,
    queryProposerCostProfile: FIXTURE_COST_PROFILE,
    evidenceExtractorCostProfile: FIXTURE_COST_PROFILE,
  });
  const outcome = await executor.execute(GOVERNANCE_BASIS, {
    jobId: f.jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 5, maxSourceOpens: 5, maxModelCostMicro: 1_000_000 },
  });
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, f.jobId));
  const locators = rows.length > 0 ? await locatorsForEvidence(ctx.db, rows[0].id) : [];
  const trace = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, f.jobId));
  return { outcome, rows, locators, trace };
}

// A direct write to the tables, for values the validator would never let
// the executor send. This is how a hypothetical future writer that skips
// the validator would meet the backstop.
async function rawEvidenceInsert(f: Fixture, documentaryLocator: string) {
  const [source] = await ctx.db
    .insert(sources)
    .values({ url: `https://${HOST}/${uniq("raw")}`, urlHash: uniq("uh"), sourceType: "OFFICIAL_DOCS", health: "OK" })
    .returning();
  return ctx.db
    .insert(evidence)
    .values({
      sourceId: source.id,
      researchJobId: f.jobId,
      relationship: "CONTEXT",
      fragment: "raw",
      summary: "raw",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: NOW,
      evidenceContractVersion: 2,
      patternStep: 3,
      component: "GOVERNANCE_BASIS",
      directness: "DIRECT",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      documentaryLocator,
    })
    .returning({ id: evidence.id });
}

async function rawLocatorInsert(evidenceId: string, value: string) {
  return ctx.db
    .insert(evidenceDocumentaryLocators)
    .values({ evidenceId, ordinal: 0, value, shape: "ADDRESS_LIKE", literallyPresent: true, validationResult: "CONFIRMED" })
    .returning({ id: evidenceDocumentaryLocators.id });
}

// Drizzle wraps the Postgres error; the violated constraint's name is on
// the cause. A rejection for any OTHER reason is a different finding.
async function expectConstraintViolation(run: Promise<unknown>, constraint: string, label: string): Promise<void> {
  let thrown: unknown = null;
  try {
    await run;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, label + ": expected a rejection").not.toBeNull();
  const cause = (thrown as { cause?: { constraint?: string; code?: string } }).cause;
  expect(cause?.code, label).toBe("23514");
  expect(cause?.constraint, label).toBe(constraint);
}

async function constraintDef(name: string): Promise<string> {
  const r = await ctx.db.execute(sql`select pg_get_constraintdef(oid) def from pg_constraint where conname = ${name}`);
  const def = (r.rows[0] as { def?: string } | undefined)?.def;
  if (!def) throw new Error(`constraint ${name} not found`);
  return def;
}

const EXPECTED_UNION = "^([1-9A-HJ-NP-Za-km-z]{32,44}|[1-9A-HJ-NP-Za-km-z]{64,88}|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$";

describe("the live failure, reproduced and closed — an Ethereum project's own contract address as a documentary locator", () => {
  it("1-5. Ethereum identity confirmed; extraction yields the stated 0x locator; the Evidence insert succeeds; both the scalar and the sibling table store it", async () => {
    const f = await makeFixture({ chain: "ethereum", tokenAddress: EVM_ADDRESS_CHECKSUMMED });
    // The live page printed the LOWERCASE spelling; the identity holds the
    // checksummed one. A shape check recognises both, canonicalises neither.
    const { outcome, rows, locators, trace } = await runNormalPath(f, EVM_ADDRESS_LOWER, EVM_ADDRESS_LOWER);
    expect(outcome.status).toBe("SUCCEEDED");
    expect(rows.length).toBe(1);
    expect(rows[0].documentaryLocator).toBe(EVM_ADDRESS_LOWER);
    expect(locators.map((l) => [l.value, l.shape])).toEqual([[EVM_ADDRESS_LOWER, "ADDRESS_LIKE"]]);
    expect(trace.some((t) => t.operationType === "LOCATOR_REJECTED")).toBe(false);
    // Authority came from the confirmed route through the unchanged
    // resolver — nothing about the locator's family touched it.
    expect(rows[0]).toMatchObject({ sourceClass: "OFFICIAL_DOCS", officiality: "CONFIRMED", component: "GOVERNANCE_BASIS", patternStep: 3 });
  });

  it("the checksummed spelling and an EVM transaction hash persist too, each with its own shape", async () => {
    const a = await makeFixture({ chain: "ethereum", tokenAddress: EVM_ADDRESS_CHECKSUMMED });
    const ra = await runNormalPath(a, EVM_ADDRESS_CHECKSUMMED, EVM_ADDRESS_CHECKSUMMED);
    expect(ra.rows[0]?.documentaryLocator).toBe(EVM_ADDRESS_CHECKSUMMED);
    expect(ra.locators.map((l) => l.shape)).toEqual(["ADDRESS_LIKE"]);

    const b = await makeFixture({ chain: "ethereum", tokenAddress: EVM_ADDRESS_CHECKSUMMED });
    const rb = await runNormalPath(b, EVM_TX_HASH, EVM_TX_HASH);
    expect(rb.rows[0]?.documentaryLocator).toBe(EVM_TX_HASH);
    expect(rb.locators.map((l) => l.shape)).toEqual(["SIGNATURE_LIKE"]);
  });

  it("6. a Solana project's base58 locator still persists exactly as before, address and signature alike", async () => {
    const a = await makeFixture({ chain: "solana", tokenAddress: BASE58_ADDRESS });
    const ra = await runNormalPath(a, BASE58_ADDRESS, BASE58_ADDRESS);
    expect(ra.outcome.status).toBe("SUCCEEDED");
    expect(ra.rows[0]?.documentaryLocator).toBe(BASE58_ADDRESS);
    expect(ra.locators.map((l) => [l.value, l.shape])).toEqual([[BASE58_ADDRESS, "ADDRESS_LIKE"]]);

    const b = await makeFixture({ chain: "solana", tokenAddress: BASE58_ADDRESS });
    const rb = await runNormalPath(b, BASE58_SIGNATURE, BASE58_SIGNATURE);
    expect(rb.rows[0]?.documentaryLocator).toBe(BASE58_SIGNATURE);
    expect(rb.locators.map((l) => l.shape)).toEqual(["SIGNATURE_LIKE"]);
  });

  it("7. a malformed EVM locator is refused by the validator (the fact survives, locator NULL) and refused by the database if a writer bypasses the validator", async () => {
    const f = await makeFixture({ chain: "ethereum", tokenAddress: EVM_ADDRESS_CHECKSUMMED });
    // 39 hex digits: one short of an address. The document states it, so
    // literal presence is not the reason — shape is.
    const short = "0x" + "ab12".repeat(9) + "abc";
    const r = await runNormalPath(f, short, short);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].documentaryLocator).toBeNull();
    expect(r.locators).toEqual([]);
    expect(r.trace.some((t) => t.operationType === "LOCATOR_REJECTED" && t.reasonCode === "LOCATOR_INCOMPLETE")).toBe(true);

    const [row] = await rawEvidenceInsert(f, EVM_ADDRESS_LOWER); // a valid one, to hang locator rows off
    // NB "ab12".repeat(10) without the prefix is NOT malformed — 40 base58
    // characters are a structurally valid base58 address, and both layers
    // rightly admit it. Hex with a '0' and no prefix is in no family.
    for (const malformed of [short, "0x" + "ab12".repeat(10) + "0", "0x" + "ab1g".repeat(10), "0xabc", "0x", "0X" + "ab12".repeat(10), "0a12".repeat(10)]) {
      await expectConstraintViolation(rawEvidenceInsert(f, malformed), "ck_evidence_documentary_locator_complete", malformed);
      await expectConstraintViolation(rawLocatorInsert(row.id, malformed), "ck_evidence_locators_complete", malformed);
    }
  });

  it("8. a malformed base58 locator is refused the same way — including the 45-63 span the old rule tolerated and the validator never admitted", async () => {
    const f = await makeFixture({ chain: "solana", tokenAddress: BASE58_ADDRESS });
    const withZero = BASE58_ADDRESS.slice(0, 10) + "0" + BASE58_ADDRESS.slice(11);
    const r = await runNormalPath(f, withZero, withZero);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].documentaryLocator).toBeNull();
    expect(r.trace.some((t) => t.operationType === "LOCATOR_REJECTED" && t.reasonCode === "LOCATOR_INCOMPLETE")).toBe(true);

    const [row] = await rawEvidenceInsert(f, BASE58_ADDRESS);
    const tooShort = BASE58_ADDRESS.slice(0, 31);
    const between = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGmAbCdEf"; // 50 chars: not an address, not a signature
    const tooLong = "Kq".repeat(45); // 90
    for (const malformed of [withZero, tooShort, between, tooLong]) {
      await expectConstraintViolation(rawEvidenceInsert(f, malformed), "ck_evidence_documentary_locator_complete", malformed);
      await expectConstraintViolation(rawLocatorInsert(row.id, malformed), "ck_evidence_locators_complete", malformed);
    }
  });
});

describe("database and application agree, family by family", () => {
  it("both constraints carry the positive union of exactly the families identifier-shape.ts admits", async () => {
    const scalar = await constraintDef("ck_evidence_documentary_locator_complete");
    const sibling = await constraintDef("ck_evidence_locators_complete");
    expect(scalar).toContain(EXPECTED_UNION);
    expect(scalar).toContain("IS NULL");
    expect(sibling).toContain(EXPECTED_UNION);
    // Not the stale single-family rule.
    expect(scalar).not.toContain("{32,88}");
    expect(sibling).not.toContain("{32,88}");
  });

  it("for a spread of values, `application admits` is exactly `database admits`", async () => {
    const values = [
      EVM_ADDRESS_CHECKSUMMED,
      EVM_ADDRESS_LOWER,
      EVM_TX_HASH,
      BASE58_ADDRESS,
      BASE58_SIGNATURE,
      "1".repeat(32),
      "z".repeat(44),
      "z".repeat(64),
      "z".repeat(88),
      // refused by both
      "0x" + "ab12".repeat(9) + "abc",
      "0x" + "ab12".repeat(10) + "0",
      "0x" + "ab1g".repeat(10),
      "0X" + "ab12".repeat(10),
      "0x" + "9f".repeat(31),
      "0x" + "9f".repeat(33),
      "ab12".repeat(10), // admitted by both: 40 base58 characters
      "0a12".repeat(10), // refused by both: a '0' is in no base58 string, and no 0x prefix
      BASE58_ADDRESS.slice(0, 31),
      "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGmAbCdEf",
      "Kq".repeat(45),
      "O".repeat(40),
      "4Hs9Tz…CvDkGm",
      "",
    ];
    const def = await constraintDef("ck_evidence_locators_complete");
    const regex = /~ '([^']+)'/.exec(def)?.[1];
    expect(regex).toBeDefined();
    for (const v of values) {
      const application = identifierShapeOfAnyFamily(v) !== null;
      const r = await ctx.db.execute(sql`select (${v} ~ ${regex!}) as ok`);
      const database = (r.rows[0] as { ok: boolean }).ok;
      expect(database, JSON.stringify(v)).toBe(application);
    }
  });
});

describe("9 + 10. generic — no project, no chain branching, no semantic change", () => {
  const MIGRATION = readFileSync("src/server/db/migrations/0049_documentary_locator_identifier_families.sql", "utf-8");
  const SCHEMA = readFileSync("src/server/db/schema/proof.ts", "utf-8");

  it("the migration names no project and states one rule per FAMILY, not per chain", () => {
    const code = MIGRATION.replace(/^\s*--.*$/gm, "");
    for (const banned of ["lido", "pump", "solana", "ethereum", "'solana'", "'ethereum'"]) {
      expect(code.toLowerCase(), banned).not.toContain(banned);
    }
    // Exactly two constraints touched, both rebuilt with the same union.
    expect(code.match(/ADD CONSTRAINT/g)?.length).toBe(2);
    expect(code.match(/DROP CONSTRAINT IF EXISTS/g)?.length).toBe(2);
    expect(code.split(EXPECTED_UNION).length - 1).toBe(2);
    // Additive: no row rewritten, no column touched.
    for (const banned of ["UPDATE ", "DELETE ", "ALTER COLUMN", "DROP COLUMN", "ADD COLUMN", "SET DEFAULT", "NOT NULL"]) {
      expect(code, banned).not.toContain(banned);
    }
  });

  it("the drizzle schema states the same union for the sibling table, so schema and migration cannot drift", () => {
    expect(SCHEMA).toContain(EXPECTED_UNION);
    expect(SCHEMA).not.toContain("{32,88}");
  });

  it("no chain branch was added to the writers or to reconciliation", () => {
    for (const file of [
      "src/server/engine/s4-executor.ts",
      "src/server/engine/documentary-locator-store.ts",
      "src/server/engine/documentary-locator.ts",
      "src/server/engine/component-reconciler.ts",
    ]) {
      const code = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");
      expect(code, file).not.toMatch(/["']ethereum["']/);
      expect(code, file).not.toMatch(/["']solana["']/);
    }
  });
});
