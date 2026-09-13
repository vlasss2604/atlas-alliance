import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { evidence, projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError, type ContentFetcher } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError } from "../src/server/engine/providers/evidence-extractor";
import { isExtractorFailureDiagnosticCode } from "../src/server/engine/providers/extractor-failure-diagnostics";
import { __setOnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { BudgetExhaustedError } from "../src/server/engine/budget-exhausted-error";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { isOnchainExplorerUrl } from "../src/server/engine/source-authority";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, TEST_DATABASE_URL, uniq, type TestContext } from "./phase1-setup";

// POST-RAYDIUM ACQUISITION CLEANUP V1 — three defects the fresh post-fix
// live run (job 8eb1e920-…) exposed, each proved offline.
//
// The run proved D1/D2/D3 work live and then showed what the remaining
// waste actually is. Of 17 paid documentary opens, 9 failed in transport,
// 5 bought an explorer SPA shell that was rejected as another project's,
// 1 produced no traceable fact, and 1 page class was genuinely useful.
//
//   A  a url the code-owned classifier recognizes as an ON-CHAIN EXPLORER
//      is not bought as an ordinary documentary HTTP source when the
//      DEDICATED deterministic on-chain adapter is the mechanism
//      responsible for that component's chain facts and could act here;
//   B  the extractor's own classified failure reason is persisted on the
//      EXTRACT_FAILED trace row, so it survives the D3 budget-exhausted
//      flow that discards the attempt's observation string;
//   C  alpha-run can create the Research under an EXISTING user, so a
//      fresh job opens in the ordinary owner-scoped product UI.
//
// Nothing here refunds a unit, moves a ceiling, changes admission, changes
// a verdict, or names a project, a chain or a token in a rule.

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

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const NOW = new Date("2026-09-11T00:00:00.000Z");
const EXPLORER_URL = `https://solscan.io/token/${MINT}`;
const DOCS_URL = "https://docs.cleanup-fixture.test/mechanism/fees";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

// CURRENT_STATE admits ONCHAIN_VERIFIABLE and the component -> intent map
// gives it a real anchor-level read (TOKEN_SUPPLY), so the deterministic
// adapter genuinely owns its chain facts.
const ONCHAIN_ITEM: ComponentWorkItem = {
  step: 5,
  stepName: "Current Status + Freshness",
  component: "CURRENT_STATE",
  state: "NO_MEMORY",
  blockers: [],
  memoryIds: [],
  conflictingMemoryIds: [],
};

// MECHANISM_SPEC admits OFFICIAL_DOCS/GOVERNANCE only — the chain is not
// what establishes it, so the rule must not apply to it at all.
const DOCUMENTARY_ITEM: ComponentWorkItem = {
  ...ONCHAIN_ITEM,
  step: 3,
  stepName: "Allocation Mechanism",
  component: "MECHANISM_SPEC",
};

// SOURCE_OF_VALUE admits ONCHAIN_VERIFIABLE too, but the deterministic
// adapter has NO intent for it — so it is not the adapter's responsibility
// and an explorer candidate for it must still be openable.
const ADMITS_CLASS_BUT_NO_INTENT_ITEM: ComponentWorkItem = {
  ...ONCHAIN_ITEM,
  step: 1,
  stepName: "Economic Source",
  component: "SOURCE_OF_VALUE",
};

function docFor(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}`,
    fetchedAt: NOW,
    byteLength: text.length,
  };
}

function factFor(item: { step: number; component: string }, fragment: string): ExtractedFact {
  return {
    step: item.step,
    component: item.component,
    statement: "protocol fee accrues to the treasury",
    supportFragment: fragment,
    mechanismState: null,
    directness: "DIRECT",
    publishedAt: null,
    doesNotProve: "does not prove ongoing distribution to holders",
    relationship: "SUPPORTS",
    onchainLocator: null,
    onchainLocators: null,
  };
}

function countingFetcher(byUrl: Record<string, FetchedDocument | "FAIL">) {
  const calls: string[] = [];
  const fetcher: ContentFetcher = {
    name: "live-transport",
    async fetch(url: string) {
      calls.push(url);
      const entry = byUrl[url];
      if (!entry || entry === "FAIL") throw new ContentFetchError("HTTP_ERROR", "fixture: 404", url, 404);
      return entry;
    },
  };
  return { fetcher, calls };
}

async function makeProject(opts: { identity: boolean }) {
  const slug = uniq("prc");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Cleanup Fixture", status: "ACTIVE_CORE" })
    .returning();
  if (opts.identity) {
    const ok = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: MINT });
    if (!ok.ok) throw new Error("fixture identity failed");
  }
  return { id: project.id, name: project.name, slug, ticker: null as string | null };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "does protocol revenue reach token holders?",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function trace(jobId: string) {
  const rows = await ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

// A retriever that is INSTALLED (so the deterministic path is genuinely
// available in this process) and whose reads do not establish the
// component — exactly the live shape: the chain was asked, and the
// component still had nothing.
function installUnproductiveRetriever() {
  __setOnchainRetriever({
    name: "fixture-retriever",
    supports: () => true,
    retrieve: async () => {
      throw new Error("fixture: chain read produced nothing");
    },
  }, { chain: "solana", network: "mainnet" });
}

interface RunOpts {
  item?: ComponentWorkItem;
  identity: boolean;
  retriever: boolean;
  chainAcquisition?: "ENABLED" | "DOCUMENTARY_ONLY";
  candidates?: string[];
  approveExplorerFor?: ComponentWorkItem;
}

async function runOneComponent(opts: RunOpts) {
  const item = opts.item ?? ONCHAIN_ITEM;
  const project = await makeProject({ identity: opts.identity });
  const jobId = await makeJob(project.id);
  if (opts.retriever) installUnproductiveRetriever();
  if (opts.approveExplorerFor) {
    // This job's own approval provenance, written exactly as D-150 writes
    // it — the same rows approvedResourcesForComponent reads back.
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SOURCE_RESOURCE_SELECTED",
      patternStep: opts.approveExplorerFor.step,
      component: opts.approveExplorerFor.component,
      targetRef: EXPLORER_URL,
      status: "OK",
    });
  }
  const candidates = opts.candidates ?? [EXPLORER_URL, DOCS_URL];
  const { fetcher, calls } = countingFetcher({
    [EXPLORER_URL]: docFor(EXPLORER_URL, `${project.name}: solscan token page shell`),
    [DOCS_URL]: docFor(DOCS_URL, `${project.name}: the protocol fee accrues directly to the treasury contract`),
  });
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project,
    queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-fees"]; } },
    searchGateway: {
      name: "fixture-search",
      async search() { return candidates.map((url) => ({ url, title: null, snippet: null })); },
    },
    contentFetcher: fetcher,
    evidenceExtractor: {
      name: "fixture-extractor",
      async extract(input) {
        return [factFor(input.target, "the protocol fee accrues directly to the treasury contract")];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
    chainAcquisition: opts.chainAcquisition ?? "ENABLED",
  });
  const result = await executor.execute(item, {
    jobId,
    attemptNumber: 1,
    isRecoveryAttempt: false,
    budget: { maxSearchQueries: 5, maxSourceOpens: 24, maxModelCostMicro: 5_000_000 },
  });
  return { jobId, project, calls, result };
}

/* ------------------------------------------------------------------ */
/* A — an explorer page is not the mechanism that establishes a chain  */
/*     fact                                                            */
/* ------------------------------------------------------------------ */

describe("A — explorer-host recognition is generic and reads the existing classification", () => {
  it("every code-owned explorer base domain and its subdomains are recognized, on every chain", () => {
    for (const url of [
      "https://solscan.io/token/X",
      "https://solana.fm/address/X",
      "https://etherscan.io/token/0xabc",
      "https://bscscan.com/address/0xabc",
      "https://arbiscan.io/tx/0xabc",
      "https://basescan.org/address/0xabc",
      "https://polygonscan.com/token/0xabc",
      "https://snowtrace.io/address/0xabc",
      "https://www.solscan.io/token/X",
      "https://docs.solana.fm/reference/get_transfers",
    ]) {
      expect(isOnchainExplorerUrl(url), url).toBe(true);
    }
  });

  it("it never claims explorer status for a host the classifier does not treat as on-chain", () => {
    for (const url of [
      // D-131 — a testnet explorer is not production on-chain authority,
      // and this must agree with the classifier rather than contradict it.
      "https://sepolia.etherscan.io/token/0xabc",
      "https://testnet.bscscan.com/address/0xabc",
      // Ordinary documentary/data-provider/social hosts.
      "https://docs.cleanup-fixture.test/mechanism/fees",
      "https://app.tokenomics.com/tokenomics/x",
      "https://x.com/someproject",
      "https://github.com/org/repo",
      // A look-alike that merely ENDS with an explorer's name.
      "https://solscan.io.evil.test/token/X",
      "not a url",
    ]) {
      expect(isOnchainExplorerUrl(url), url).toBe(false);
    }
  });

  it("the rule names no project, chain, token or explorer — it reads source-authority's own list", () => {
    const executorSource = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    const ruleStart = executorSource.indexOf("AN EXPLORER PAGE IS NOT THE MECHANISM");
    const ruleEnd = executorSource.indexOf("const explorerHttpOpenIsNotTheMechanism");
    expect(ruleStart).toBeGreaterThan(0);
    expect(ruleEnd).toBeGreaterThan(ruleStart);
    // THE CONDITION ITSELF — the executable rule, with the explanatory
    // prose above it excluded on purpose: what decides behaviour is code.
    const condition = executorSource.slice(ruleEnd, executorSource.indexOf("});", ruleEnd) + 3);
    // The SHARED gate plus one capability fact — no second opinion about
    // which components the chain establishes.
    expect(condition).toContain("componentAdmitsOnchainAcquisition({");
    expect(condition).toContain("onchainAcquisitionUnavailable");
    // No project, chain, token or explorer literal decides anything.
    expect(condition).not.toMatch(/solscan|solana|etherscan|bscscan|raydium|pump|0x/i);
    // And neither does the filter that applies it.
    const filter = executorSource.slice(
      executorSource.indexOf("explorerHttpOpenIsNotTheMechanism &&"),
      executorSource.indexOf("SKIPPED_EXPLORER_HTTP_ONCHAIN_PATH_OWNS_FACT"),
    );
    expect(filter).not.toMatch(/solscan|solana|etherscan|bscscan|raydium|pump|0x/i);
    expect(executorSource).toContain("isOnchainExplorerUrl(url)");
    // The explorer domain list lives in exactly one place, and it is not
    // this file and not the test.
    const authoritySource = readFileSync("src/server/engine/source-authority.ts", "utf-8");
    expect(authoritySource).toContain("const ONCHAIN_EXPLORER_DOMAINS = new Set([");
    // The acquisition path reads that list only through the exported
    // predicate — it never imports or re-states the domains themselves.
    expect(executorSource).not.toMatch(/import[^;]*ONCHAIN_EXPLORER_DOMAINS/);
    expect(executorSource).not.toContain("new Set([");
  });
});

describe("A — the skip happens only in the intended documentary-open situation", () => {
  it("SKIPPED: the component's chain facts belong to the deterministic adapter, and it could act here", async () => {
    const { jobId, calls, project } = await runOneComponent({ identity: true, retriever: true });
    // The explorer page was never bought. The ordinary documentation page
    // was, and it is what established the component.
    expect(calls).toEqual([DOCS_URL]);
    const rows = await trace(jobId);
    expect(rows.filter((r) => r.operationType === "FETCH_ATTEMPTED" && r.targetRef === EXPLORER_URL)).toHaveLength(0);
    // PROVENANCE IS NOT DESTROYED: the explorer url is still recorded as a
    // candidate this job's search returned.
    expect(
      rows.filter((r) => r.operationType === "CANDIDATE_RETURNED" && r.targetRef === EXPLORER_URL),
    ).toHaveLength(1);
    // The dedicated deterministic path is still reachable: it ran, and the
    // trace says so with its own atlas-onchain:// target refs.
    expect(rows.some((r) => (r.targetRef ?? "").startsWith("atlas-onchain://"))).toBe(true);
    // Ordinary documentary evidence is unaffected.
    const ev = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    expect(ev.length).toBeGreaterThan(0);
    expect(project.name).toBe("Cleanup Fixture");
  });

  it("NOT SKIPPED: no deterministic path in this process — the explorer is bought exactly as before", async () => {
    const { calls } = await runOneComponent({ identity: true, retriever: false, chainAcquisition: "DOCUMENTARY_ONLY" });
    expect(calls).toContain(EXPLORER_URL);
  });

  it("NOT SKIPPED: no human-confirmed chain identity — the adapter is not addressable, nothing changes", async () => {
    const { calls } = await runOneComponent({ identity: false, retriever: true });
    expect(calls).toContain(EXPLORER_URL);
  });

  it("NOT SKIPPED: the Pattern does not say the chain establishes this component", async () => {
    const { calls } = await runOneComponent({
      item: DOCUMENTARY_ITEM,
      identity: true,
      retriever: true,
    });
    expect(calls).toContain(EXPLORER_URL);
  });

  it("NOT SKIPPED: the component admits the class but the adapter has no intent for it", async () => {
    const { calls } = await runOneComponent({
      item: ADMITS_CLASS_BUT_NO_INTENT_ITEM,
      identity: true,
      retriever: true,
    });
    expect(calls).toContain(EXPLORER_URL);
  });

  it("NOT SKIPPED: a human approved this exact explorer url for this component", async () => {
    const { calls } = await runOneComponent({
      identity: true,
      retriever: true,
      approveExplorerFor: ONCHAIN_ITEM,
    });
    expect(calls).toContain(EXPLORER_URL);
  });

  it("ordinary official/docs urls are untouched when the explorer is the only thing skipped", async () => {
    const { calls } = await runOneComponent({
      identity: true,
      retriever: true,
      candidates: [DOCS_URL],
    });
    expect(calls).toEqual([DOCS_URL]);
  });
});

/* ------------------------------------------------------------------ */
/* B — the extractor's classified failure survives                      */
/* ------------------------------------------------------------------ */

describe("B — the persistable extractor diagnostic vocabulary", () => {
  it("admits exactly what safeFailureDetail can compose", () => {
    for (const code of [
      "MAX_TOKENS_TRUNCATED",
      "OUTPUT_NOT_JSON",
      "OUTPUT_SCHEMA_INVALID",
      "OUTPUT_SCHEMA_INVALID:FACTS_STATEMENT",
      "OUTPUT_SCHEMA_INVALID:UNKNOWN_SCHEMA_FIELD",
      "RATE_LIMITED",
      "RATE_LIMITED:429",
      "PROVIDER_SERVER_ERROR:503",
      "INVALID_REQUEST:400",
      "NETWORK_NO_RESPONSE",
    ]) {
      expect(isExtractorFailureDiagnosticCode(code), code).toBe(true);
    }
  });

  it("refuses anything that is not two closed memberships", () => {
    for (const code of [
      "",
      "PROVIDER_ERROR",
      "rate_limited",
      "RATE_LIMITED:",
      "RATE_LIMITED:99",
      "RATE_LIMITED:600",
      "RATE_LIMITED:007",
      "RATE_LIMITED: 429",
      "RATE_LIMITED:4e2",
      "OUTPUT_SCHEMA_INVALID:statement",
      // The schema-field refinement belongs to one class only.
      "MAX_TOKENS_TRUNCATED:FACTS_STATEMENT",
      "Authorization: Bearer sk-secret",
      "https://api.example.test/?api_key=SECRET",
      null,
      undefined,
      429,
    ]) {
      expect(isExtractorFailureDiagnosticCode(code), String(code)).toBe(false);
    }
  });
});

describe("B — EXTRACT_FAILED carries the diagnostic, and it survives the D3 budget-exhausted flow", () => {
  async function runWithFailingExtraction(diagnosticArgs: {
    diagnostic: "OUTPUT_SCHEMA_INVALID" | "PROVIDER_SERVER_ERROR";
    httpStatus: number | null;
    schemaField: "FACTS_STATEMENT" | null;
  }) {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    const first = "https://docs.cleanup-fixture.test/mechanism/a";
    const second = "https://docs.cleanup-fixture.test/mechanism/b";
    const { fetcher } = countingFetcher({
      [first]: docFor(first, `${project.name}: fees accrue to the treasury`),
      [second]: docFor(second, `${project.name}: fees accrue to the treasury`),
    });
    let extractCalls = 0;
    const executor = createS4WorkExecutor({
      db: ctx.db,
      project,
      queryProposer: { name: "fixture-proposer", async proposeQueries() { return ["q-fees"]; } },
      searchGateway: {
        name: "fixture-search",
        async search() {
          return [first, second].map((url) => ({ url, title: null, snippet: null }));
        },
      },
      contentFetcher: fetcher,
      evidenceExtractor: {
        name: "fixture-extractor",
        async extract() {
          extractCalls += 1;
          throw new EvidenceExtractorUnavailableError(
            "fixture: generation failed",
            false,
            diagnosticArgs.diagnostic,
            diagnosticArgs.httpStatus,
            diagnosticArgs.schemaField,
          );
        },
      },
      queryProposerCostProfile: COST,
      evidenceExtractorCostProfile: COST,
      chainAcquisition: "DOCUMENTARY_ONLY",
    });
    // maxSourceOpens = 1: the first candidate is opened, the SECOND
    // reservation is refused. That is precisely the D3 shape — the paid
    // document is read first and the same terminal error is thrown after.
    const thrown = await executor
      .execute(ONCHAIN_ITEM, {
        jobId,
        attemptNumber: 1,
        isRecoveryAttempt: false,
        budget: { maxSearchQueries: 5, maxSourceOpens: 1, maxModelCostMicro: 5_000_000 },
      })
      .then(() => null)
      .catch((e: unknown) => e);
    return { jobId, thrown, extractCalls };
  }

  it("the budget-exhausted path still throws, and the diagnostic is on the row", async () => {
    const { jobId, thrown, extractCalls } = await runWithFailingExtraction({
      diagnostic: "PROVIDER_SERVER_ERROR",
      httpStatus: 503,
      schemaField: null,
    });
    // The terminal outcome is unchanged: source opens were exhausted.
    expect(thrown).toBeInstanceOf(BudgetExhaustedError);
    expect((thrown as BudgetExhaustedError).axis).toBe("sourceOpens");
    // Exactly one extraction call for the one document — no retry.
    expect(extractCalls).toBe(1);
    const rows = await trace(jobId);
    const failed = rows.filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed).toHaveLength(1);
    // reasonCode is unchanged; the classified WHY is now durable beside it.
    expect(failed[0].reasonCode).toBe("PROVIDER_ERROR");
    expect(failed[0].diagnosticCode).toBe("PROVIDER_SERVER_ERROR:503");
    // No evidence was invented and nothing was extracted.
    expect(await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId))).toHaveLength(0);
    // The attempt threw, so its observation string was never persisted —
    // which is exactly why the row had to carry the diagnostic.
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.id).toBe(jobId);
  });

  it("the schema-field refinement is persisted too", async () => {
    const { jobId } = await runWithFailingExtraction({
      diagnostic: "OUTPUT_SCHEMA_INVALID",
      httpStatus: null,
      schemaField: "FACTS_STATEMENT",
    });
    const failed = (await trace(jobId)).filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].diagnosticCode).toBe("OUTPUT_SCHEMA_INVALID:FACTS_STATEMENT");
  });

  it("the trace writer re-checks membership: a forged value is stored as null", async () => {
    const project = await makeProject({ identity: false });
    const jobId = await makeJob(project.id);
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "EXTRACT_FAILED",
      providerKind: "EXTRACT",
      targetRef: "https://docs.cleanup-fixture.test/mechanism/forged",
      status: "FAILED",
      reasonCode: "PROVIDER_ERROR",
      // Deliberately violating the compile-time union, the way a runtime
      // value can.
      diagnosticCode: "Authorization: Bearer sk-secret" as never,
    });
    const failed = (await trace(jobId)).filter((r) => r.operationType === "EXTRACT_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].diagnosticCode).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* C — alpha-run --owner                                                */
/* ------------------------------------------------------------------ */

describe("C — --owner is validated before anything can be spent", () => {
  const SCRIPT = readFileSync("scripts/alpha-run.ts", "utf-8");

  it("the owner refusals come BEFORE the live prerequisites, the interpretation and the job", () => {
    const ownerCheck = SCRIPT.indexOf("if (args.owner !== undefined)");
    const shapeRefusal = SCRIPT.indexOf('[alpha-run] refusing --owner="');
    const notFoundRefusal = SCRIPT.indexOf("OWNER_NOT_FOUND");
    const prerequisites = SCRIPT.indexOf("[alpha-run] refusing --mode=live — prerequisites missing:");
    const installCapabilities = SCRIPT.indexOf("installRuntimeCapabilities({");
    const interpretation = SCRIPT.indexOf("createInterpretation(");
    const jobCreation = SCRIPT.indexOf("createResearchJob(");
    const liveExecutor = SCRIPT.indexOf("createLiveS4WorkExecutor({");
    const handler = SCRIPT.indexOf("handleResearchJobTask(");
    expect(ownerCheck).toBeGreaterThan(0);
    for (const later of [shapeRefusal, notFoundRefusal]) {
      expect(later).toBeGreaterThan(ownerCheck);
    }
    for (const after of [prerequisites, installCapabilities, interpretation, jobCreation, liveExecutor, handler]) {
      expect(after).toBeGreaterThan(notFoundRefusal);
    }
  });

  it("both refusals exit the process and close the pool — no Research, no provider call", () => {
    const block = SCRIPT.slice(
      SCRIPT.indexOf("if (args.owner !== undefined)"),
      SCRIPT.indexOf("// §11 — fail closed BEFORE creating a half-configured live job"),
    );
    // Shape first, then existence — a malformed id never reaches Postgres
    // as a uuid cast.
    expect(block.indexOf("UUID_RE.test")).toBeLessThan(block.indexOf("select({ id: users.id })"));
    expect(block.match(/process\.exit\(1\)/g)).toHaveLength(2);
    expect(block.match(/await pool\.end\(\)/g)).toHaveLength(2);
    // No entitlement, role or auth is read, asserted or relaxed here.
    expect(block).not.toMatch(/role|entitlement|isAdmin|bypass/i);
  });

  it("the disposable anonymous user is created ONLY when --owner is absent", () => {
    expect(SCRIPT).toContain("const user = ownerUserId === null");
    expect(SCRIPT).toContain('? (await db.insert(users).values({}).returning())[0]');
    expect(SCRIPT).toContain(": { id: ownerUserId };");
    // Exactly one insert into users in the whole script.
    expect(SCRIPT.match(/db\.insert\(users\)/g)).toHaveLength(1);
    // Ownership still flows through the ordinary service layer.
    expect(SCRIPT).toContain("userId: user.id");
  });

  it("the flag is optional: omitted, ownerUserId stays null and nothing else reads it", () => {
    expect(SCRIPT).toContain("let ownerUserId: string | null = null;");
    // ownerUserId is consulted in exactly two places: the assignment inside
    // the validated branch, the user selection, and the printed summary.
    const uses = SCRIPT.match(/ownerUserId/g) ?? [];
    expect(uses.length).toBe(5);
  });
});

describe("C — --owner, proved by running the script", () => {
  const run = promisify(execFile);

  // The real script, in a real process, against the test database. Fixture
  // mode resolves no live provider at all (trace-fixture-executor), so
  // "nothing was spent" is structural here, not a promise.
  async function alphaRun(args: string[]) {
    try {
      const { stdout, stderr } = await run("npx", ["tsx", "scripts/alpha-run.ts", ...args], {
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        cwd: process.cwd(),
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  async function jobCount(): Promise<number> {
    return (await ctx.db.select({ id: researchJobs.id }).from(researchJobs)).length;
  }
  async function userCount(): Promise<number> {
    return (await ctx.db.select({ id: users.id }).from(users)).length;
  }

  it("a malformed owner fails before any Research exists", async () => {
    const jobsBefore = await jobCount();
    const usersBefore = await userCount();
    const { code, stderr } = await alphaRun(["--mode=fixture", "--actor=regression", "--owner=not-a-uuid"]);
    expect(code).toBe(1);
    expect(stderr).toContain("not a uuid");
    expect(stderr).toContain("No Research was created and nothing was spent");
    expect(await jobCount()).toBe(jobsBefore);
    expect(await userCount()).toBe(usersBefore);
  }, 180_000);

  it("a well-formed owner that does not exist fails before any Research exists", async () => {
    const jobsBefore = await jobCount();
    const usersBefore = await userCount();
    const { code, stderr } = await alphaRun([
      "--mode=fixture",
      "--actor=regression",
      "--owner=11111111-1111-1111-1111-111111111111",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("OWNER_NOT_FOUND");
    // No disposable user was created either — the refusal is before both.
    expect(await jobCount()).toBe(jobsBefore);
    expect(await userCount()).toBe(usersBefore);
  }, 180_000);

  it("an existing owner owns the Research, and no disposable user is created", async () => {
    const [owner] = await ctx.db.insert(users).values({}).returning();
    const usersBefore = await userCount();
    const { code, stdout } = await alphaRun([
      "--mode=fixture",
      "--actor=regression",
      `--owner=${owner.id}`,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain(`owner:              ${owner.id} (existing user, --owner)`);
    const jobId = /jobId:\s+([0-9a-f-]{36})/.exec(stdout)?.[1];
    expect(jobId).toBeTruthy();
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId!));
    expect(job.userId).toBe(owner.id);
    expect(await userCount()).toBe(usersBefore);
  }, 180_000);

  it("omitting the flag preserves the anonymous-owner behaviour exactly", async () => {
    const usersBefore = await userCount();
    const { code, stdout } = await alphaRun(["--mode=fixture", "--actor=regression"]);
    expect(code).toBe(0);
    expect(stdout).toContain("(anonymous user created for this run)");
    const jobId = /jobId:\s+([0-9a-f-]{36})/.exec(stdout)?.[1];
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId!));
    // Exactly one fresh user, and it owns the job.
    expect(await userCount()).toBe(usersBefore + 1);
    const owners = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, job.userId as string));
    expect(owners).toHaveLength(1);
  }, 180_000);
});
