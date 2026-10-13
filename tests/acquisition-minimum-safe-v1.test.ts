import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  componentRequirementsFor,
  PATTERN_V1_CONTENT,
} from "../src/server/domain/pattern";
import {
  isKnownDeadUrl,
  loadAcquisitionLedger,
  planQueries,
} from "../src/server/engine/acquisition-ledger";
import {
  modelQueriesCanBeUsed,
  orderCandidatesForComponent,
  rankCandidateForComponent,
} from "../src/server/engine/acquisition-targeting";
import { componentSearchAllowance } from "../src/server/engine/budget-fairness";
import { buildQueryProposerUserContent } from "../src/server/engine/providers/query-proposer-anthropic";
import { buildEvidenceExtractorUserContent } from "../src/server/engine/providers/evidence-extractor-anthropic";
import { recordTraceEvent } from "../src/server/engine/trace-store";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { projects, topics, users } from "../src/server/db/schema";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ACQUISITION MINIMUM SAFE V1 — regression coverage.
//
// Everything here is synthetic: invented projects, invented hosts, and
// generic Pattern components. Nothing depends on any particular chain,
// explorer, token or project, because the failure being fixed was
// general — the same identical-query / dead-URL / discovery-order
// behaviour would strand a fee-distribution, staking-reward, burn,
// treasury or emissions question exactly as it stranded the observed one.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

async function makeJob(): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("acq"), name: "Acquisition Test Project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "does the mechanism reduce supply?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

const SEARCH = "synthetic evidence query alpha";
const DEAD_URL = "https://explorer.invalid-host.test/token/ABC";
const LIVE_URL = "https://docs.invalid-host.test/fees";

describe("A — evidence goals reach the provider prompts", () => {
  it("every Pattern v1 component carries a human-authored evidenceGoal", () => {
    const components = Object.keys(PATTERN_V1_CONTENT.componentRequirements ?? {});
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      const goal = componentRequirementsFor(PATTERN_V1_CONTENT, component).evidenceGoal;
      expect(goal, `${component} has no evidenceGoal`).toBeTruthy();
      // A goal must describe a proposition, not restate the label.
      expect(goal!.length).toBeGreaterThan(40);
      expect(goal!.toLowerCase()).not.toBe(component.toLowerCase());
    }
  });

  it("4. QueryProposer input contains the normalized task, the intent, and the component evidenceGoal", () => {
    const goal = componentRequirementsFor(PATTERN_V1_CONTENT, "NET_EFFECT").evidenceGoal!;
    const content = buildQueryProposerUserContent({
      target: {
        step: 7,
        stepName: "Net Token Effect",
        component: "NET_EFFECT",
        projectId: "p1",
        projectName: "Example Project",
        projectSlug: "example_project",
        researchTask: "determine whether the buyback reduces supply",
        intent: "BURN_OR_SUPPLY_EFFECT",
        evidenceGoal: goal,
      },
      hint: "state=NO_MEMORY; blockers=none",
      maxQueries: 3,
    });
    expect(content).toContain("determine whether the buyback reduces supply");
    expect(content).toContain("BURN_OR_SUPPLY_EFFECT");
    expect(content).toContain(goal);
  });

  it("5. EvidenceExtractor input contains the normalized task and the evidenceGoal", () => {
    const goal = componentRequirementsFor(PATTERN_V1_CONTENT, "DESTINATION").evidenceGoal!;
    const content = buildEvidenceExtractorUserContent({
      target: {
        step: 6,
        stepName: "Token Destination + Recipient",
        component: "DESTINATION",
        projectId: "p1",
        projectName: "Example Project",
        projectSlug: "example_project",
        researchTask: "where do the acquired assets end up",
        evidenceGoal: goal,
      },
      document: {
        finalUrl: LIVE_URL,
        requestedUrl: LIVE_URL,
        httpStatus: 200,
        contentType: "text/html",
        normalizedText: "the assets are sent to a burn address",
        contentHash: "sha256:x",
        fetchedAt: new Date(),
        byteLength: 40,
      },
    });
    expect(content).toContain("where do the acquired assets end up");
    expect(content).toContain(goal);
    // Context must precede the untrusted document block so document text
    // can never be read as the task.
    expect(content.indexOf(goal)).toBeLessThan(content.indexOf("DOCUMENT"));
  });

  it("context is omitted rather than faked when unavailable", () => {
    const content = buildQueryProposerUserContent({
      target: {
        step: 1,
        stepName: "Economic Source",
        component: "SOURCE_OF_VALUE",
        projectId: null,
        projectName: "P",
        projectSlug: "p",
      },
      hint: "h",
      maxQueries: 1,
    });
    expect(content).not.toContain("Research task:");
    expect(content).not.toContain("Evidence goal");
    expect(content).not.toContain("null");
  });
});

describe("B — job-scoped acquisition ledger", () => {
  it("1. a query already searched in this job is not searched again, and its candidates are reused", async () => {
    const jobId = await makeJob();
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      targetRef: SEARCH,
      status: "OK",
    });
    for (const url of [DEAD_URL, LIVE_URL]) {
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: "CANDIDATE_RETURNED",
        patternStep: 1,
        component: "SOURCE_OF_VALUE",
        targetRef: url,
        status: "OK",
      });
    }

    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    // A DIFFERENT component proposing the same query must not re-buy it.
    const plan = planQueries([SEARCH, "a genuinely new query"], ledger);
    const reused = plan.find((p) => p.query === SEARCH)!;
    expect(reused.needsSearch).toBe(false);
    expect([...reused.knownCandidates].sort()).toEqual([DEAD_URL, LIVE_URL].sort());
    // A new query is still searched normally — dedup is not a freeze.
    expect(plan.find((p) => p.query === "a genuinely new query")!.needsSearch).toBe(true);
  });

  it("a query REFUSED by budget was never executed, so it is not treated as spent", async () => {
    const jobId = await makeJob();
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      targetRef: SEARCH,
      status: "SKIPPED",
      reasonCode: "SEARCH_QUERY_BUDGET_EXHAUSTED",
    });
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(planQueries([SEARCH], ledger)[0].needsSearch).toBe(true);
  });

  it("2. a URL that failed to fetch in one component is known-dead for the next", async () => {
    const jobId = await makeJob();
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "FETCH_ATTEMPTED",
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      targetRef: DEAD_URL,
      status: "OK",
    });
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "FETCH_FAILED",
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      targetRef: DEAD_URL,
      status: "FAILED",
      reasonCode: "PROVIDER_ERROR",
    });

    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(isKnownDeadUrl(DEAD_URL, ledger)).toBe(true);
    // Never fetched, never failed -> not dead, still openable.
    expect(isKnownDeadUrl(LIVE_URL, ledger)).toBe(false);
  });

  it("a URL that failed once but later succeeded is NOT treated as dead", async () => {
    const jobId = await makeJob();
    for (const [op, status] of [
      ["FETCH_ATTEMPTED", "OK"],
      ["FETCH_FAILED", "FAILED"],
      ["FETCH_ATTEMPTED", "OK"],
      ["FETCH_OK", "OK"],
    ] as const) {
      await recordTraceEvent(ctx.db, {
        researchJobId: jobId,
        operationType: op,
        patternStep: 1,
        component: "SOURCE_OF_VALUE",
        targetRef: LIVE_URL,
        status,
      });
    }
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    expect(isKnownDeadUrl(LIVE_URL, ledger)).toBe(false);
  });

  it("8. a recovery attempt cannot repeat the identical known-dead acquisition path", async () => {
    // Recovery re-runs the same component with the same deterministic
    // targeting, so before this ledger it re-ran the same query and
    // re-opened the same dead URL. The ledger is derived from persisted
    // trace, so it spans attempts without any attempt-number logic.
    const jobId = await makeJob();
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      patternStep: 7,
      component: "NET_EFFECT",
      targetRef: SEARCH,
      status: "OK",
    });
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "CANDIDATE_RETURNED",
      patternStep: 7,
      component: "NET_EFFECT",
      targetRef: DEAD_URL,
      status: "OK",
    });
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "FETCH_ATTEMPTED",
      patternStep: 7,
      component: "NET_EFFECT",
      targetRef: DEAD_URL,
      status: "OK",
    });
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "FETCH_FAILED",
      patternStep: 7,
      component: "NET_EFFECT",
      targetRef: DEAD_URL,
      status: "FAILED",
      reasonCode: "PROVIDER_ERROR",
    });

    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    const replanned = planQueries([SEARCH], ledger);
    expect(replanned[0].needsSearch).toBe(false);
    const survivingCandidates = replanned[0].knownCandidates.filter(
      (u) => !isKnownDeadUrl(u, ledger),
    );
    // Nothing left to spend on: no search unit, no source open.
    expect(survivingCandidates).toEqual([]);
  });

  it("duplicate queries inside ONE attempt collapse to a single search", async () => {
    const jobId = await makeJob();
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    const plan = planQueries([SEARCH, SEARCH, "other"], ledger);
    expect(plan.map((p) => p.query)).toEqual([SEARCH, "other"]);
  });

  it("a credential-bearing candidate is NEVER offered back as a reusable URL", async () => {
    // trace stores target_ref redacted, so reusing it as a fetch target
    // would request `?api_key=[REDACTED]` — a different resource, and a
    // silent corruption of the one URL the fetcher must receive intact.
    // Caught by the existing redaction test when candidate reuse was
    // first added; pinned here at the ledger boundary where it belongs.
    const jobId = await makeJob();
    const secretUrl = "https://example.com/candidate?api_key=SECRET_DO_NOT_LEAK&other=1";
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "SEARCH_EXECUTED",
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      targetRef: SEARCH,
      status: "OK",
    });
    await recordTraceEvent(ctx.db, {
      researchJobId: jobId,
      operationType: "CANDIDATE_RETURNED",
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      targetRef: secretUrl,
      status: "OK",
    });

    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    const reused = planQueries([SEARCH], ledger)[0];
    // The query is still deduped — that saving is safe and independent.
    expect(reused.needsSearch).toBe(false);
    // But nothing lossy is handed back as a fetchable URL.
    expect(reused.knownCandidates).toEqual([]);
    for (const c of reused.knownCandidates) {
      expect(c).not.toContain("[REDACTED]");
    }
  });

  it("an unrelated job's history never leaks into this job's ledger", async () => {
    const jobA = await makeJob();
    const jobB = await makeJob();
    await recordTraceEvent(ctx.db, {
      researchJobId: jobA,
      operationType: "SEARCH_EXECUTED",
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      targetRef: SEARCH,
      status: "OK",
    });
    const ledgerB = await loadAcquisitionLedger(ctx.db, jobB);
    expect(planQueries([SEARCH], ledgerB)[0].needsSearch).toBe(true);
  });
});

describe("C — class-aware candidate ordering", () => {
  const ONCHAIN = ["ONCHAIN_VERIFIABLE"] as const;

  it("3. an establishing candidate discovered later is fetched before inadmissible earlier ones", () => {
    // Discovery order puts two non-establishing candidates first; the
    // establishing one is last and would never be reached under an
    // allowance of 1.
    const candidates = [
      "https://twitter.com/someone/status/1",
      "https://medium.com/@someone/post",
      "https://etherscan.io/token/0xabc",
    ];
    const ordered = orderCandidatesForComponent(candidates, ONCHAIN);
    expect(ordered[0]).toBe("https://etherscan.io/token/0xabc");
    expect(ordered.slice(0, 1)).toEqual(["https://etherscan.io/token/0xabc"]);
  });

  it("an unknown host ranks above a recognised non-establishing one, never below", () => {
    // Conservative on the unknown: it could be the project's own site.
    const unknownRank = rankCandidateForComponent("https://unknown-host.invalid/x", ONCHAIN);
    const socialRank = rankCandidateForComponent("https://twitter.com/x/status/1", ONCHAIN);
    const establishingRank = rankCandidateForComponent("https://etherscan.io/token/0x1", ONCHAIN);
    expect(establishingRank).toBeLessThan(unknownRank);
    expect(unknownRank).toBeLessThan(socialRank);
  });

  it("ordering is stable, so equal-rank candidates keep query priority", () => {
    const equal = [
      "https://etherscan.io/token/0x1",
      "https://solscan.io/token/A",
      "https://etherscan.io/token/0x2",
    ];
    expect(orderCandidatesForComponent(equal, ONCHAIN)).toEqual(equal);
  });

  it("ordering never drops a candidate — it only reorders", () => {
    const candidates = [
      "https://twitter.com/a/status/1",
      "https://etherscan.io/token/0x1",
      "https://unknown-host.invalid/x",
    ];
    expect(orderCandidatesForComponent(candidates, ONCHAIN).sort()).toEqual(
      [...candidates].sort(),
    );
  });
});

describe("D — QueryProposer is not called when its output cannot be used", () => {
  it("6. one slot, no generic-reachable class, locators already fill it -> unusable", () => {
    expect(
      modelQueriesCanBeUsed({
        establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"],
        onchainLocators: ["site:a.test ADDR", "site:b.test ADDR"],
        maxTotal: 1,
      }),
    ).toBe(false);
  });

  it("a generic-reachable class reserves a slot, so the model IS called", () => {
    expect(
      modelQueriesCanBeUsed({
        // DATA_PROVIDER is reachable by ordinary web search.
        establishingClasses: ["ONCHAIN_VERIFIABLE", "DATA_PROVIDER"],
        onchainLocators: ["site:a.test ADDR", "site:b.test ADDR"],
        maxTotal: 3,
      }),
    ).toBe(true);
  });

  it("no locators means the model's queries are the only ones possible", () => {
    expect(
      modelQueriesCanBeUsed({
        establishingClasses: ["ONCHAIN_VERIFIABLE"],
        onchainLocators: [],
        maxTotal: 1,
      }),
    ).toBe(true);
  });

  it("more slots than locators leaves room for the model", () => {
    expect(
      modelQueriesCanBeUsed({
        establishingClasses: ["ONCHAIN_VERIFIABLE"],
        onchainLocators: ["site:a.test ADDR"],
        maxTotal: 3,
      }),
    ).toBe(true);
  });
});

describe("E — an intent-required component keeps its terminal search opportunity", () => {
  const BASE = {
    maxSearchQueries: 12,
    workQueueSize: 9,
    hardCapPerAttempt: 3,
  };

  it("7. a non-required component cannot take the last unit a required one still needs", () => {
    // One unit left; two components pending, one of them intent-required.
    const allowance = componentSearchAllowance({
      ...BASE,
      alreadyReserved: 11,
      remainingComponents: 2,
      isIntentRequired: false,
      intentRequiredPending: 1,
    });
    // Floored at 1 so the component is never deleted from the Pattern —
    // but it cannot claim more than the single unit, and the reservation
    // layer remains the authority on actual exhaustion.
    expect(allowance).toBe(1);

    // Without the pending-required component it may take its normal share.
    const unconstrained = componentSearchAllowance({
      ...BASE,
      alreadyReserved: 6,
      remainingComponents: 2,
      isIntentRequired: false,
      intentRequiredPending: 0,
    });
    expect(unconstrained).toBeGreaterThanOrEqual(1);
  });

  it("a non-required component is held back when required ones are still pending", () => {
    const withPending = componentSearchAllowance({
      ...BASE,
      alreadyReserved: 4,
      remainingComponents: 4,
      isIntentRequired: false,
      intentRequiredPending: 3,
    });
    const withoutPending = componentSearchAllowance({
      ...BASE,
      alreadyReserved: 4,
      remainingComponents: 4,
      isIntentRequired: false,
      intentRequiredPending: 0,
    });
    expect(withPending).toBeLessThanOrEqual(withoutPending);
  });

  it("an intent-required component itself is never held back by the priority rule", () => {
    const required = componentSearchAllowance({
      ...BASE,
      alreadyReserved: 4,
      remainingComponents: 4,
      isIntentRequired: true,
      intentRequiredPending: 3,
    });
    expect(required).toBe(BASE.hardCapPerAttempt);
  });

  it("no component is ever starved to zero while budget remains", () => {
    const allowance = componentSearchAllowance({
      ...BASE,
      alreadyReserved: 11,
      remainingComponents: 5,
      isIntentRequired: false,
      intentRequiredPending: 4,
    });
    expect(allowance).toBeGreaterThanOrEqual(1);
  });

  it("the D-120 exhaustion-discovery contract is unchanged by the priority rule", () => {
    // Two separate pre-existing behaviours the priority rule must not
    // disturb, because BudgetExhaustedError depends on them:
    //  (a) the LAST pending component gets the full cap, so fair-share
    //      division never hides the axis running out;
    expect(
      componentSearchAllowance({
        ...BASE,
        alreadyReserved: 6,
        remainingComponents: 1,
        isIntentRequired: false,
        intentRequiredPending: 0,
      }),
    ).toBe(BASE.hardCapPerAttempt);
    //  (b) a fully-reserved axis yields 0 here; s4-executor floors that to
    //      1 so reserveJobBudget can REFUSE it and throw, rather than the
    //      component silently skipping and the controller folding it into
    //      WORK_QUEUE_EXHAUSTED -> SUCCEEDED.
    expect(
      componentSearchAllowance({
        ...BASE,
        alreadyReserved: 12,
        remainingComponents: 1,
        isIntentRequired: false,
        intentRequiredPending: 0,
      }),
    ).toBe(0);
  });
});

describe("9. generalization — the new acquisition logic is project-independent", () => {
  it("no project-, chain- or venue-specific literal appears in the new acquisition modules", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/engine/acquisition-ledger.ts",
      "../src/server/engine/acquisition-targeting.ts",
      "../src/server/engine/budget-fairness.ts",
    ]) {
      const raw = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      const code = raw
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["pump", "solana", "solscan", "buyback", "ethereum"]) {
        expect(code, `${path} contains "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("evidence goals describe propositions generically, naming no project or chain", () => {
    const goals = Object.values(PATTERN_V1_CONTENT.componentRequirements ?? {})
      .map((r) => r.evidenceGoal ?? "")
      .join(" ")
      .toLowerCase();
    for (const banned of ["pump", "solana", "solscan", "etherscan", "ethereum"]) {
      expect(goals).not.toContain(banned);
    }
  });
});
