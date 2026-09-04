import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { evidence, projects, sources, topics, users } from "../src/server/db/schema";
import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { runFetchPhase } from "../src/server/engine/acquisition-phases";
import { readJobBudgetReserved } from "../src/server/engine/budget-reservation";
import { persistFactLocators } from "../src/server/engine/documentary-locator-store";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import {
  runStructuredOnchainAcquisition,
  type MechanismLocator,
} from "../src/server/engine/onchain-acquisition";
import {
  ONCHAIN_RESERVED_SOURCE_OPENS,
  computeOnchainSourceOpenReserve,
  deterministicCeilingForComponent,
  planDeterministicDemand,
  resolveOnchainSourceOpenReserve,
} from "../src/server/engine/onchain-source-open-reserve";
import {
  MAX_PROMOTION_DEPTH,
  promotedReadsForComponent,
} from "../src/server/engine/onchain-subject-promotion";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import type { FetchedDocument } from "../src/server/engine/providers/types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ON-CHAIN SOURCE-OPEN RESERVATION V2 — THE PROTECTION MADE REAL.
//
// V1 held one flat number, `1 + MAX_PROMOTION_DEPTH`, back from documentary
// acquisition. It was never the invariant it claimed: the SAME ledger also
// pays for ordinary anchor-level reads, and the seeded Pattern schedules
// three of them. On a 24-open job that is 20 documentary opens plus 3 anchor
// opens = 23, leaving ONE unit for a promotion chain the architecture had
// promised four. Documentary work was fenced out of capacity that on-chain
// work then walked straight into.
//
// V2 computes the reservation from the contract's own remaining
// deterministic demand — every guaranteed anchor read, plus the deepest
// still-reachable chain — and enforces it against EVERY spender, not just
// documentary ones. What is proved here is the end-to-end guarantee: at the
// point any source open is spent, the capacity still required by legitimate
// remaining deterministic reads is still there, and the total never grows.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const MINT = "Mint1111111111111111111111111111111111111111";
const WALLET = "Wa11et11111111111111111111111111111111111111";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const IDENTITY: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: MINT, ticker: "TST" };
const DOMAIN = "docs.reservation-v2.test";
const PREFIX = "/mechanism";
const NOW = new Date("2026-09-03T00:00:00.000Z");

// The seeded Pattern's components, by the only property that matters here:
// whether their base read addresses the anchor (guaranteed, no locator
// needed) or an account (a chain, reachable only once a locator exists).
const ANCHOR_COMPONENTS = [
  { step: 1, component: "SOURCE_OF_VALUE" },
  { step: 5, component: "CURRENT_STATE" },
  { step: 7, component: "NET_EFFECT" },
];
const CHAIN_COMPONENT = { step: 4, component: "EXECUTION_EVIDENCE" };
const ONCHAIN_CLASSES = ["ONCHAIN_VERIFIABLE"] as const;

// The founder's worst case, DERIVED rather than typed: three guaranteed
// anchor reads plus one four-deep chain.
const PUMP_SHAPED_DEMAND =
  ANCHOR_COMPONENTS.length + 1 + promotedReadsForComponent(CHAIN_COMPONENT.component);

// ---------------------------------------------------------------------
// 5/6/8/10. The arithmetic, with no database at all.
// ---------------------------------------------------------------------

function demands(components: readonly { component: string }[]) {
  return planDeterministicDemand({
    identity: IDENTITY,
    components: components.map((c) => ({
      component: c.component,
      establishingClasses: ONCHAIN_CLASSES,
    })),
  });
}

describe("the reservation is the contract's demand, not one flat number", () => {
  it("1. the worst case reserves every anchor read AND the whole chain", () => {
    const r = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([...ANCHOR_COMPONENTS, CHAIN_COMPONENT]),
    });
    expect(r.baseReserved).toBe(3);
    expect(r.promotionReserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(r.reserved).toBe(PUMP_SHAPED_DEMAND);
    expect(r.reserved).toBe(7);
    // Conceptually 17 — derived here, never written into the runtime.
    expect(r.documentaryCeiling).toBe(24 - PUMP_SHAPED_DEMAND);
    expect(r.documentaryCeiling).toBe(17);
    expect(r.maxSourceOpens).toBe(24);
  });

  it("5. fewer scheduled base reads means more documentary capacity", () => {
    const three = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([...ANCHOR_COMPONENTS, CHAIN_COMPONENT]),
    });
    const one = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([ANCHOR_COMPONENTS[0]!, CHAIN_COMPONENT]),
    });
    const none = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([CHAIN_COMPONENT]),
    });
    expect(three.documentaryCeiling).toBe(17);
    expect(one.documentaryCeiling).toBe(19);
    expect(none.documentaryCeiling).toBe(20);
  });

  it("6. no reachable chain means no promotion reserve is held", () => {
    const r = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands(ANCHOR_COMPONENTS),
    });
    expect(r.promotionReserved).toBe(0);
    expect(r.reserved).toBe(3);
    expect(r.documentaryCeiling).toBe(21);
  });

  it("ONE chain is protected, never one per component — four do not reserve four", () => {
    const many = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([
        CHAIN_COMPONENT,
        { component: "FLOW_PATH" },
        { component: "DESTINATION" },
        { component: "RECIPIENT" },
      ]),
    });
    expect(many.promotionReserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(many.reserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
  });

  it("the protected chain is the DEEPEST reachable one, by its own rules", () => {
    const shallow = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([{ component: "DESTINATION" }]),
    });
    // DESTINATION authorises one hop, so its chain costs two reads, not four.
    expect(shallow.promotionReserved).toBe(1 + promotedReadsForComponent("DESTINATION"));
    expect(shallow.promotionReserved).toBe(2);
    const deep = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([{ component: "DESTINATION" }, CHAIN_COMPONENT]),
    });
    expect(deep.promotionReserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
  });

  it("8. a context that cannot reach a chain holds nothing at all", () => {
    const r = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: demands([...ANCHOR_COMPONENTS, CHAIN_COMPONENT]),
      onchainAcquisitionUnavailable: true,
    });
    expect(r.reserved).toBe(0);
    expect(r.baseReserved).toBe(0);
    expect(r.promotionReserved).toBe(0);
    expect(r.documentaryCeiling).toBe(24);
    expect(r.released).toBe("ONCHAIN_ACQUISITION_UNAVAILABLE");
  });

  it("a documentary-only contract holds nothing, whatever the budget", () => {
    for (const max of [1, 8, 24, 60]) {
      const r = computeOnchainSourceOpenReserve({
        maxSourceOpens: max,
        demands: planDeterministicDemand({
          identity: IDENTITY,
          components: [
            { component: "MECHANISM_SPEC", establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"] },
          ],
        }),
      });
      expect(r.reserved).toBe(0);
      expect(r.documentaryCeiling).toBe(max);
      expect(r.released).toBe("NO_ACTIONABLE_ONCHAIN_WORK");
    }
  });

  it("10. reserved + documentary ceiling is ALWAYS exactly the unchanged total", () => {
    for (let max = 0; max <= 64; max++) {
      const r = computeOnchainSourceOpenReserve({
        maxSourceOpens: max,
        demands: demands([...ANCHOR_COMPONENTS, CHAIN_COMPONENT]),
      });
      expect(r.reserved + r.documentaryCeiling).toBe(max);
      // Protection, never priority: still capped at half the envelope.
      expect(r.reserved).toBeLessThanOrEqual(Math.floor(max / 2));
      // And no spender may ever be handed more than the job's own ceiling.
      for (const c of [...ANCHOR_COMPONENTS, CHAIN_COMPONENT]) {
        expect(deterministicCeilingForComponent(r, c.component)).toBeLessThanOrEqual(max);
      }
    }
  });

  it("the half-ceiling cap gives up chain depth before a guaranteed read", () => {
    // 8 opens: cap 4, demand 7. The three anchor reads are certain to be
    // issued; the chain may not even have a subject, so it is trimmed first.
    const r = computeOnchainSourceOpenReserve({
      maxSourceOpens: 8,
      demands: demands([...ANCHOR_COMPONENTS, CHAIN_COMPONENT]),
    });
    expect(r.baseReserved).toBe(3);
    expect(r.promotionReserved).toBe(1);
    expect(r.reserved).toBe(4);
  });
});

describe("3. an ordinary anchor read cannot spend the chain's protected capacity", () => {
  const r = computeOnchainSourceOpenReserve({
    maxSourceOpens: 24,
    demands: demands([...ANCHOR_COMPONENTS, CHAIN_COMPONENT]),
  });

  it("each anchor component may reach its OWN unit and nothing more", () => {
    for (const c of ANCHOR_COMPONENTS) {
      // 24 - (7 - 1): everything except this component's own protected read.
      expect(deterministicCeilingForComponent(r, c.component)).toBe(18);
    }
  });

  it("the chain component may reach its whole chain", () => {
    // 24 - (7 - 4): everything except the three anchor reads' own units.
    expect(deterministicCeilingForComponent(r, CHAIN_COMPONENT.component)).toBe(21);
  });

  it("a component with no protected allocation may spend only what is spare", () => {
    expect(deterministicCeilingForComponent(r, "FLOW_PATH")).toBe(17);
    expect(deterministicCeilingForComponent(r, "DURABILITY_BASIS")).toBe(17);
    // An unknown name is fail-closed, never privileged.
    expect(deterministicCeilingForComponent(r, "NOT_A_COMPONENT")).toBe(17);
  });
});

// ---------------------------------------------------------------------
// The database-backed guarantee, end to end, against the real ledger.
// ---------------------------------------------------------------------

async function makeProject(withIdentity = true) {
  const slug = uniq("resv2");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Reservation V2 Fixture", status: "ACTIVE_CORE" })
    .returning();
  if (withIdentity) {
    const ok = await confirmProjectIdentity(ctx.db, {
      projectSlug: slug,
      chain: "solana",
      tokenAddress: MINT,
    });
    if (!ok.ok) throw new Error("fixture identity failed");
  }
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: DOMAIN,
    pathPrefix: PREFIX,
  });
  if (!confirmed.ok) throw new Error("fixture route confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("fixture route classify failed: " + classified.refusal);
  return { id: project.id, slug };
}

async function makeJob(projectId: string, slug: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId,
    originalQuestion: "does the buyback actually reduce circulating supply?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "buyback burn" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function seedCandidates(jobId: string, n: number): Promise<void> {
  await recordTraceEvent(ctx.db, {
    researchJobId: jobId,
    operationType: "SEARCH_EXECUTED",
    providerKind: "SEARCH",
    targetRef: "q-documentary",
    status: "OK",
  });
  for (let i = 0; i < n; i++) {
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "CANDIDATE_RETURNED",
      providerKind: "SEARCH",
      targetRef: `https://${DOMAIN}${PREFIX}/doc-${i}`,
      status: "OK",
    });
  }
}

function fixtureFetcher(calls: { urls: string[] }) {
  return {
    name: "fixture-transport",
    async fetch(url: string): Promise<FetchedDocument> {
      calls.urls.push(url);
      return {
        finalUrl: url,
        requestedUrl: url,
        httpStatus: 200,
        contentType: "text/markdown",
        normalizedText:
          "Protocol fees are used to buy back the token, and bought-back tokens are burned.",
        contentHash: `sha256:${url}`,
        fetchedAt: NOW,
        byteLength: 96,
      };
    },
  };
}

async function admitLocatorFact(jobId: string, address: string): Promise<void> {
  const [source] = await ctx.db
    .insert(sources)
    .values({
      url: `https://docs.example.test/${uniq("p")}`,
      urlHash: uniq("uh"),
      sourceType: "OFFICIAL_DOCS",
      health: "OK",
    })
    .returning();
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      sourceId: source.id,
      researchJobId: jobId,
      relationship: "SUPPORTS",
      fragment: `bought-back tokens are sent to ${address} and burned there`,
      summary: "documented burn account",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: NOW,
      evidenceContractVersion: 2,
      patternStep: 6,
      component: "DESTINATION",
      directness: "DIRECT",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
    })
    .returning();
  await persistFactLocators(ctx.db, row.id, [{ value: address, shape: "ADDRESS_LIKE" }]);
}

function artifactFor(intent: OnchainIntent, result: OnchainResult): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: intent.subjectKind,
      subject: intent.subject,
      slot: 500,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "fixture",
      requestParams: { subject: intent.subject },
      retrievedAt: NOW,
      rawResponseHash: `sha256:${result.kind}:${intent.subject}`,
      artifactHash: `sha256:art:${result.kind}:${intent.subject}`,
      transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
    },
  });
}

// Answers by intent KIND only, so a chain that reaches a transaction
// reached it by promotion and not because the fixture handed it over.
function fixtureRetriever(opts: { fail?: boolean } = {}) {
  const asked: OnchainIntent[] = [];
  return {
    asked,
    retriever: {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent): Promise<OnchainArtifact> => {
        asked.push(intent);
        if (opts.fail) throw new Error("provider exploded");
        switch (intent.kind) {
          case "ACCOUNT_INFO":
            return artifactFor(intent, {
              kind: "ACCOUNT_INFO",
              address: intent.subject,
              exists: true,
              ownerProgram: "SysProg11111111111111111111111111111111111",
              executable: false,
              lamports: "64850000000",
              tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
              tokenAccount: null,
            });
          case "TOKEN_ACCOUNTS_BY_OWNER":
            return artifactFor(intent, {
              kind: "TOKEN_ACCOUNTS_BY_OWNER",
              owner: intent.subject,
              mint: MINT,
              rejectedCount: 0,
              accounts: [
                {
                  account: TOKEN_ACCOUNT,
                  owner: intent.subject,
                  mint: MINT,
                  amountRaw: "0",
                  decimals: 6,
                },
              ],
            });
          case "SIGNATURES_FOR_ADDRESS":
            return artifactFor(intent, {
              kind: "SIGNATURES_FOR_ADDRESS",
              address: intent.subject,
              signatures: [
                { signature: SIGNATURE, slot: 20, err: false, blockTime: 1_700_000_000, memo: null },
              ],
            });
          case "TRANSACTION_DETAIL":
            return artifactFor(intent, {
              kind: "TRANSACTION_DETAIL",
              signature: intent.subject,
              slot: 500,
              blockTime: 1_700_000_000,
              succeeded: true,
              burns: [
                {
                  programId: "TokenProg1111111111111111111111111111111111",
                  instructionType: "BurnChecked",
                  mint: MINT,
                  sourceAccount: TOKEN_ACCOUNT,
                  authority: WALLET,
                  amountRaw: "7723746661",
                  decimals: 6,
                },
              ],
              programs: [],
              accountKeys: [WALLET, MINT, TOKEN_ACCOUNT],
              tokenInstructions: [],
              lifecycleInstructions: [],
              preTokenBalances: [],
              postTokenBalances: [],
            });
          default:
            return artifactFor(intent, {
              kind: "TOKEN_SUPPLY",
              mint: MINT,
              amountRaw: "1000",
              decimals: 6,
            });
        }
      },
    },
  };
}

async function reservedSourceOpens(jobId: string): Promise<number> {
  const row = await readJobBudgetReserved(ctx.db, jobId);
  return row!.sourceOpens;
}

// The on-chain path exactly as the executor and the reactivation pass now
// invoke it: through the component's own derived ceiling, never the raw
// job ceiling.
async function runDeterministic(
  jobId: string,
  projectId: string,
  item: { step: number; component: string },
  opts: { max?: number; locators?: MechanismLocator[]; fail?: boolean } = {},
) {
  const max = opts.max ?? 24;
  const reserve = await resolveOnchainSourceOpenReserve(ctx.db, {
    jobId,
    projectId,
    maxSourceOpens: max,
  });
  const fixture = fixtureRetriever({ fail: opts.fail });
  const traced: { operationType: string; reasonCode?: string }[] = [];
  const outcome = await runStructuredOnchainAcquisition({
    db: ctx.db,
    jobId,
    attemptId: null,
    item,
    plan: { establishingClasses: ONCHAIN_CLASSES, confirmedIdentity: IDENTITY },
    locators: opts.locators ?? [],
    maxSourceOpens: deterministicCeilingForComponent(reserve, item.component),
    retriever: fixture.retriever,
    recordTrace: async (e) => {
      traced.push({ operationType: e.operationType, reasonCode: e.reasonCode });
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: e.operationType,
        providerKind: "FETCH",
        patternStep: item.step,
        component: item.component,
        targetRef: e.targetRef,
        status: e.status,
        reasonCode: e.reasonCode ?? "NONE",
        budgetAxis: "sourceOpens",
        budgetAmount: 1,
      });
    },
  });
  return { outcome, asked: fixture.asked, traced, ceiling: deterministicCeilingForComponent(reserve, item.component) };
}

describe("1/2/4. the PUMP-shaped worst case, saturated, against the real ledger", () => {
  it("documentary saturation still leaves all seven deterministic opens possible", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id, project.slug);
    await seedCandidates(jobId, 40);
    const calls = { urls: [] as string[] };
    const MAX = 24;

    // --- documentary work, as hungry as the live run was ------------------
    const fetched = await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher(calls),
      maxSourceOpens: MAX,
    });
    expect(fetched.onchainReservedSourceOpens).toBe(PUMP_SHAPED_DEMAND);
    expect(fetched.documentarySourceOpenCeiling).toBe(MAX - PUMP_SHAPED_DEMAND);
    expect(fetched.documentarySourceOpenCeiling).toBe(17);
    expect(calls.urls.length).toBe(17);
    expect(await reservedSourceOpens(jobId)).toBe(17);

    // --- 2. every scheduled anchor-level read still executes --------------
    let expected = 17;
    for (const item of ANCHOR_COMPONENTS) {
      const run = await runDeterministic(jobId, project.id, item);
      expect(run.outcome.sourceOpensSpent).toBe(1);
      expect(run.outcome.observations).not.toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
      expected += 1;
      expect(await reservedSourceOpens(jobId)).toBe(expected);
    }
    expect(expected).toBe(20);

    // --- 3. and the promotion capacity is STILL there ---------------------
    // A component with no protected allocation cannot touch it, even though
    // it is on-chain work with a real subject.
    await admitLocatorFact(jobId, WALLET);
    const opportunist = await runDeterministic(jobId, project.id, { step: 2, component: "FLOW_PATH" }, {
      locators: [{ address: WALLET, origin: "ADMITTED_EVIDENCE_SOURCE" }],
    });
    expect(opportunist.ceiling).toBe(20);
    expect(opportunist.outcome.sourceOpensSpent).toBe(0);
    expect(opportunist.outcome.observations).toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
    expect(await reservedSourceOpens(jobId)).toBe(20);

    // --- 2. the full four-step chain runs, end to end ---------------------
    const chain = await runDeterministic(jobId, project.id, CHAIN_COMPONENT, {
      locators: [{ address: WALLET, origin: "ADMITTED_EVIDENCE_SOURCE" }],
    });
    expect(chain.ceiling).toBe(24);
    expect(chain.asked.map((i) => i.kind)).toEqual([
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
    ]);
    expect(chain.outcome.sourceOpensSpent).toBe(1 + MAX_PROMOTION_DEPTH);
    expect(chain.outcome.observations).not.toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");

    // --- 4. and the total never grew -------------------------------------
    expect(await reservedSourceOpens(jobId)).toBe(MAX);
    expect(await reservedSourceOpens(jobId)).toBeLessThanOrEqual(INTERNAL_ALPHA_V1.maxSourceOpens);
  }, 180_000);

  it("10. the ledger is one global hard ceiling — nothing beyond it is granted", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id, project.slug);
    await seedCandidates(jobId, 40);
    const MAX = 24;
    await runFetchPhase({
      db: ctx.db,
      jobId,
      projectId: project.id,
      contentFetcher: fixtureFetcher({ urls: [] }),
      maxSourceOpens: MAX,
    });
    await admitLocatorFact(jobId, WALLET);
    for (const item of [...ANCHOR_COMPONENTS, CHAIN_COMPONENT]) {
      await runDeterministic(jobId, project.id, item, {
        locators: [{ address: WALLET, origin: "ADMITTED_EVIDENCE_SOURCE" }],
      });
      expect(await reservedSourceOpens(jobId)).toBeLessThanOrEqual(MAX);
    }
    expect(await reservedSourceOpens(jobId)).toBe(MAX);

    // Beyond it there is nothing, and the refusal is a bounded research
    // limitation rather than a claim about the project.
    const beyond = await runDeterministic(jobId, project.id, { step: 6, component: "DESTINATION" }, {
      locators: [{ address: WALLET, origin: "ADMITTED_EVIDENCE_SOURCE" }],
    });
    expect(beyond.outcome.sourceOpensSpent).toBe(0);
    expect(beyond.outcome.evidenceIds).toEqual([]);
    expect(beyond.traced[0]!.reasonCode).toBe("SOURCE_OPEN_BUDGET_EXHAUSTED");
    expect(await reservedSourceOpens(jobId)).toBe(MAX);
  }, 180_000);
});

describe("7/9. one-shot semantics are untouched", () => {
  it("7. a consumed opportunity releases the capacity it was holding", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id, project.slug);

    const before = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      maxSourceOpens: 24,
    });
    expect(before.reserved).toBe(PUMP_SHAPED_DEMAND);
    expect(before.promotionReserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);

    // The chain component takes its one opportunity, exactly as acquisition
    // marks it: the trace row written immediately before the real call.
    await runDeterministic(jobId, project.id, CHAIN_COMPONENT, {
      locators: [{ address: WALLET, origin: "ADMITTED_EVIDENCE_SOURCE" }],
    });

    const after = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      maxSourceOpens: 24,
    });
    // Its four units are no longer held for it; the next-deepest reachable
    // chain is protected instead, and documentary capacity grew.
    expect(after.promotionReserved).toBeLessThan(ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(after.documentaryCeiling).toBeGreaterThan(before.documentaryCeiling);
  }, 180_000);

  it("9. a failed RPC consumes the opportunity and regenerates no reserve", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id, project.slug);
    await admitLocatorFact(jobId, WALLET);

    const failed = await runDeterministic(jobId, project.id, CHAIN_COMPONENT, {
      locators: [{ address: WALLET, origin: "ADMITTED_EVIDENCE_SOURCE" }],
      fail: true,
    });
    // The unit was reserved BEFORE the call, so the failure still paid.
    expect(failed.outcome.sourceOpensSpent).toBe(1);
    expect(failed.outcome.evidenceIds).toEqual([]);
    expect(await reservedSourceOpens(jobId)).toBe(1);

    // No free retry: the component's protection is gone, not reissued.
    const after = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      maxSourceOpens: 24,
    });
    expect(after.demandByComponent[CHAIN_COMPONENT.component]).toBeUndefined();
    expect(after.promotionReserved).toBeLessThan(ONCHAIN_RESERVED_SOURCE_OPENS);
  }, 180_000);
});

// ---------------------------------------------------------------------
// 13/14/15. The boundaries this fix must not cross.
// ---------------------------------------------------------------------

describe("13/14/15. boundaries", () => {
  it("13. no project, asset, chain or ticker appears in the reservation module", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = (
      await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8")
    ).toLowerCase();
    for (const banned of [
      "pump",
      "raydium",
      "bonk",
      "jupiter",
      "solana",
      "ethereum",
      "mainnet",
      "ticker",
      "symbol",
      "projectslug",
      "tokenaddress",
      "token_supply",
      "account_info",
      "execution_evidence",
      "net_effect",
    ]) {
      expect(src, `reservation module must not name "${banned}"`).not.toContain(banned);
    }
  });

  it("the component -> demand knowledge stays with the authorities that own it", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8");
    // Which components read the anchor, and how deep a chain each may run,
    // are answered by acquisition and promotion — never restated here.
    expect(src).toContain("anchorBaseReadDemand");
    expect(src).toContain("componentStartsAccountChain");
    expect(src).toContain("promotedReadsForComponent");
  });

  it("14. no B2 post-event supply wiring is introduced", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const f of [
      "src/server/engine/onchain-source-open-reserve.ts",
      "src/server/engine/onchain-reactivation.ts",
      "src/server/engine/onchain-acquisition.ts",
      "src/server/engine/s4-executor.ts",
    ]) {
      const src = await readFile(f, "utf-8");
      expect(src).not.toContain("onchain-post-event-supply-plan");
      expect(src).not.toContain("onchain-event-anchored-supply-interval");
      expect(src).not.toContain("onchain-supply-delta");
    }
  });

  it("15. NET_EFFECT applicability and Evidence semantics are unchanged", async () => {
    const { readFile } = await import("node:fs/promises");
    const facts = await readFile("src/server/engine/onchain-facts.ts", "utf-8");
    expect(facts).toContain('BURN: ["NET_EFFECT"]');
    // B2d2 changed exactly one thing about this guard: the kind now EXISTS.
    // What must still be true — and is the thing that mattered — is that it
    // grants nothing: no applicability entry, so nothing may read it across
    // components.
    expect(facts).not.toContain("TOTAL_SUPPLY_DELTA: [");
  });

  it("no second budget ledger appears — reserveJobBudget stays the only mutator", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-source-open-reserve.ts", "utf-8");
    expect(src).not.toContain('from "./budget-reservation"');
    expect(src).not.toContain("reserveJobBudget(");
    expect(src).not.toContain(".insert(");
    expect(src).not.toContain(".update(");
    expect(INTERNAL_ALPHA_V1.maxSourceOpens).toBe(24);
  });

  it("12. the reactivation pass asks for a ceiling per component, not one snapshot", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("src/server/engine/onchain-reactivation.ts", "utf-8");
    expect(raw).toContain("deterministicCeilingForComponent(reserve, item.component)");
    expect(raw).toContain("OPPORTUNITY_ALREADY_CONSUMED");
    // Still one pass, one loop, one opportunity — nothing was broadened.
    // Scanned over CODE only: the module comment names the collaborators it
    // deliberately does not import.
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toContain("while (");
    expect(code).not.toContain("QueryProposer");
    expect(code).not.toContain("EvidenceExtractor");
    expect(code).not.toContain("ContentFetcher");
  });
});

describe("the work queue is what the reservation reads", () => {
  it("a real job's demand is derived from its own contract", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id, project.slug);
    const { view } = await loadJobContractView(ctx.db, jobId);
    const onchainAdmitting = view.workQueue.filter((i) =>
      [
        "SOURCE_OF_VALUE",
        "FLOW_PATH",
        "EXECUTION_EVIDENCE",
        "CURRENT_STATE",
        "DESTINATION",
        "RECIPIENT",
        "NET_EFFECT",
      ].includes(i.component),
    );
    expect(onchainAdmitting.length).toBe(7);
    const resolved = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      maxSourceOpens: 24,
    });
    expect(resolved.baseReserved).toBe(3);
    expect(resolved.promotionReserved).toBe(ONCHAIN_RESERVED_SOURCE_OPENS);
    expect(resolved.documentaryCeiling).toBe(17);
  }, 180_000);

  it("a job with no confirmed identity holds nothing", async () => {
    const project = await makeProject(false);
    const jobId = await makeJob(project.id, project.slug);
    const resolved = await resolveOnchainSourceOpenReserve(ctx.db, {
      jobId,
      projectId: project.id,
      maxSourceOpens: 24,
    });
    expect(resolved.reserved).toBe(0);
    expect(resolved.documentaryCeiling).toBe(24);
  }, 180_000);
});
