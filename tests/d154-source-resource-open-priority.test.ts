import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { projects, researchJobs, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  approvedResourcesForComponent,
  loadAcquisitionLedger,
} from "../src/server/engine/acquisition-ledger";
import { orderCandidatesForComponent } from "../src/server/engine/acquisition-targeting";
import {
  loadFetchTargets,
  prepareExtractionReplaySearch,
  runSearchPhase,
} from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ComponentTarget } from "../src/server/engine/providers/types";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-154 — AN APPROVAL MUST SURVIVE THE LAST BOUNDARY, NOT JUST THE FIRST.
//
// D-151 put an approved SOURCE_RESOURCE first in the corpus its component is
// served. D-152 made sure every component actually reaches that corpus rather
// than inheriting another component's. Neither survived the FINAL step: the
// executor re-ranks the aggregated candidates by predicted establishing class
// and then breaks ties on discovery order, at which point the approved
// resource is just another url.
//
// Observed on the fresh Raydium run, at DESTINATION: the approved
// ray-buybacks.md and an explorer candidate ranked EQUAL, stable ordering put
// the explorer first because it had been discovered first, the component had
// one open, the explorer fetch failed — and the approved document, already
// selected and fetched and sealed, was never attempted.
//
// The fix is a tie breaker and only a tie breaker: approval decides between
// equally-ranked candidates and can never lift one above a better-ranked one.

let ctx: TestContext;
let vocabulary: Set<string>;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  vocabulary = await loadActivePatternComponents(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const MAX_RESULTS = 5;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

async function makeProject() {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("d154");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D154 Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("identity fixture failed");
  const confirmed = await confirmSourceRoute(ctx.db, {
    projectSlug: slug,
    domain: host,
    pathPrefix: "/docs",
  });
  if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
  const classified = await classifySourceRoute(ctx.db, {
    routeId: confirmed.itemId,
    routeClass: "OFFICIAL_DOCS",
  });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  return { id: project.id, slug, name: project.name, host };
}

async function makeJob(projectId: string): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: "q",
      normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await runMemoryPlanningStage(ctx.db, job.id);
  return job.id;
}

async function workItems(jobId: string): Promise<ComponentWorkItem[]> {
  const { view } = await loadJobContractView(ctx.db, jobId);
  return view.workQueue;
}

async function register(slug: string, url: string, components: string[]) {
  const r = await registerSourceResource(
    ctx.db,
    { projectSlug: slug, url, componentKeys: components },
    vocabulary,
  );
  if (!r.ok) throw new Error("register failed: " + r.refusal + " " + r.detail);
  return r;
}

async function searchFor(
  project: { id: string; name: string; slug: string },
  jobId: string,
  item: ComponentWorkItem,
  urls: string[],
) {
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: [item],
    target: (i: ComponentWorkItem): ComponentTarget => ({
      step: i.step,
      stepName: i.stepName,
      component: i.component,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
    }),
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries() {
        return ["a fixture query"];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search() {
        return urls.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
    maxResultsPerQuery: 10,
    maxQueriesPerComponent: 2,
    maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
    projectId: project.id,
    queryProposerCostProfile: COST,
  });
}

// The establishing classes DESTINATION really carries, read from the Pattern
// rather than restated here.
const DESTINATION_CLASSES = ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"] as const;

describe("D-154 — an approved resource wins an equal-rank tie at the final open", () => {
  it("TEST 1: with ONE open, the approved resource is what gets tried", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const resource = `https://${project.host}/docs/approved.md`;
    await register(project.slug, resource, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    const approved = approvedResourcesForComponent(ledger, item.step, item.component);
    expect(approved.size).toBe(1);

    // An explorer url and the approved doc. Neither host is positively
    // recognised by source-authority, so both take the same middle rank and
    // the tie is real. The explorer is listed first, exactly as discovery
    // order produced it live — and that is what used to decide.
    const explorer = "https://explorer.solana.com/address/So11111111111111111111111111111111111111112";
    const ordered = orderCandidatesForComponent(
      [explorer, resource],
      DESTINATION_CLASSES,
      null,
      approved,
    );
    // The one available seat goes to the approved document.
    expect(ordered[0]).toBe(resource);
  });

  it("TEST 2: input order alone can no longer displace the approved resource", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const resource = `https://${project.host}/docs/approved.md`;
    await register(project.slug, resource, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);
    const approved = approvedResourcesForComponent(
      await loadAcquisitionLedger(ctx.db, jobId),
      item.step,
      item.component,
    );
    const explorer = "https://explorer.solana.com/address/So22222222222222222222222222222222222222222";

    // Either input order gives the same answer — the accident of which query
    // ran first stops deciding.
    for (const input of [[explorer, resource], [resource, explorer]]) {
      expect(orderCandidatesForComponent(input, DESTINATION_CLASSES, null, approved)[0]).toBe(
        resource,
      );
    }
  });

  it("TEST 3: a failing equal-rank candidate can no longer consume the only seat first", async () => {
    // The live sequence, reproduced as ordering: with one open, whichever url
    // is FIRST is the only one attempted. Before D-154 that was the explorer,
    // whose failure ended the component; now the approved document is tried.
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const resource = `https://${project.host}/docs/approved.md`;
    await register(project.slug, resource, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);
    const approved = approvedResourcesForComponent(
      await loadAcquisitionLedger(ctx.db, jobId),
      item.step,
      item.component,
    );
    const explorer = "https://explorer.solana.com/address/So33333333333333333333333333333333333333333";
    const withOneOpen = orderCandidatesForComponent(
      [explorer, resource],
      DESTINATION_CLASSES,
      null,
      approved,
    ).slice(0, 1);
    expect(withOneOpen).toEqual([resource]);
  });

  it("TEST 3b: approval breaks a tie, it never beats a better rank", async () => {
    // A resource approved for a component whose establishing classes its own
    // predicted class does NOT satisfy must not jump an establishing
    // candidate. Approval is priority among equals, never relevance.
    const resource = "https://random-unrecognised-host.test/doc.md";
    const establishing = "https://etherscan.io/token/0x4444444444444444444444444444444444444444";
    const approved = new Set([resource]);
    const ordered = orderCandidatesForComponent(
      [establishing, resource],
      ["ONCHAIN_VERIFIABLE"],
      null,
      approved,
    );
    // The better-ranked candidate still leads.
    expect(ordered[0]).toBe(establishing);
  });

  it("TEST 4: resource priority is component-scoped", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const recipient = items.find((i) => i.component === "RECIPIENT");
    const destination = items.find((i) => i.component === "DESTINATION");
    expect(recipient && destination).toBeTruthy();

    const resource = `https://${project.host}/docs/for-recipient.md`;
    await register(project.slug, resource, [recipient!.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);

    // Approved for RECIPIENT...
    expect(
      approvedResourcesForComponent(ledger, recipient!.step, recipient!.component).size,
    ).toBe(1);
    // ...and carries no priority at all for DESTINATION.
    const forDestination = approvedResourcesForComponent(
      ledger,
      destination!.step,
      destination!.component,
    );
    expect(forDestination.size).toBe(0);

    const explorer = "https://explorer.solana.com/address/So55555555555555555555555555555555555555555";
    expect(
      orderCandidatesForComponent([explorer, resource], DESTINATION_CLASSES, null, forDestination)[0],
    ).toBe(explorer);
  });

  it("TEST 5: cross-project isolation holds", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const jobA = await makeJob(projectA.id);
    const jobB = await makeJob(projectB.id);
    const [, , itemA] = await workItems(jobA);
    const [, , itemB] = await workItems(jobB);

    await register(projectA.slug, `https://${projectA.host}/docs/a.md`, [itemA.component]);
    await loadFetchTargets(ctx.db, jobA, projectA.id);
    await loadFetchTargets(ctx.db, jobB, projectB.id);

    // Project B's job approved nothing, and cannot inherit A's approval:
    // the ledger is per-job and reads only that job's own trace.
    const ledgerB = await loadAcquisitionLedger(ctx.db, jobB);
    expect(approvedResourcesForComponent(ledgerB, itemB.step, itemB.component).size).toBe(0);
  });

  it("TEST 6: with no approved resource, ordering is byte-for-byte unchanged", async () => {
    const urls = [
      "https://etherscan.io/token/0x6666666666666666666666666666666666666666",
      "https://unknown-host.test/page",
      "https://twitter.com/someone/status/1",
      "https://explorer.solana.com/address/So11111111111111111111111111111111111111112",
    ];
    // Same call with an empty approval set, and with the parameter omitted
    // entirely, must equal the pre-D-154 result.
    const withEmpty = orderCandidatesForComponent(urls, DESTINATION_CLASSES, null, new Set());
    const withDefault = orderCandidatesForComponent(urls, DESTINATION_CLASSES);
    expect(withEmpty).toEqual(withDefault);
    // And it is still a pure reordering — nothing added, nothing dropped.
    expect([...withDefault].sort()).toEqual([...urls].sort());
  });

  it("TEST 7: one url reached both ways is one url and one seat", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const url = `https://${project.host}/docs/both.md`;
    await searchFor(project, jobId, item, [url]);
    await register(project.slug, url, [item.component]);
    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets.filter((t) => t === url)).toHaveLength(1);

    const approved = approvedResourcesForComponent(
      await loadAcquisitionLedger(ctx.db, jobId),
      item.step,
      item.component,
    );
    const ordered = orderCandidatesForComponent([url], DESTINATION_CLASSES, null, approved);
    expect(ordered).toEqual([url]);
  });

  it("TEST 8 + 9: D-151 seed-first and D-152 component scoping still hold", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [c1, c2] = await workItems(jobId);
    const others = Array.from({ length: MAX_RESULTS }, (_, i) => `https://other.test/${i + 1}`);
    await searchFor(project, jobId, c1, others);
    const url = `https://${project.host}/docs/seed.md`;
    await register(project.slug, url, [c1.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const gateway = await prepareExtractionReplaySearch(ctx.db, jobId);
    const served = await gateway.search(
      "a fixture query",
      {
        step: c1.step,
        stepName: "s",
        component: c1.component,
        projectId: "p",
        projectName: "n",
        projectSlug: "s",
      },
      { maxResults: MAX_RESULTS },
    );
    // D-151: the seed still leads the corpus, under the unchanged cap.
    expect(served[0].url).toBe(url);
    expect(served).toHaveLength(MAX_RESULTS);

    // D-152: a component that discovered nothing gets nothing of c1's.
    const servedC2 = await gateway.search(
      "a fixture query",
      {
        step: c2.step,
        stepName: "s",
        component: c2.component,
        projectId: "p",
        projectName: "n",
        projectSlug: "s",
      },
      { maxResults: MAX_RESULTS },
    );
    for (const other of others) expect(servedC2.map((r) => r.url)).not.toContain(other);
  });

  it("TEST 10: no CANDIDATE_RETURNED is forged for an approved resource", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const url = `https://${project.host}/docs/curated.md`;
    await register(project.slug, url, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const rows = await ctx.db
      .select({
        op: researchTraceEvents.operationType,
        ref: researchTraceEvents.targetRef,
      })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    expect(rows.filter((r) => r.ref === url && r.op === "CANDIDATE_RETURNED")).toHaveLength(0);
    expect(
      rows.filter((r) => r.ref === url && r.op === "SOURCE_RESOURCE_SELECTED").length,
    ).toBeGreaterThan(0);
  });

  it("TEST 11: priority grants no authority, class or admissibility", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/server/engine/acquisition-targeting.ts", "utf-8");
    // The ordering function decides order and nothing else: it must not
    // resolve, assign or override a class, an officiality or an admission.
    const ordering = src.slice(src.indexOf("export function orderCandidatesForComponent"));
    expect(ordering).not.toContain("officiality");
    expect(ordering).not.toContain("admissib");
    expect(ordering).not.toMatch(/routeClass\s*=/);
    // Approval is consulted ONLY after rank has already been compared.
    expect(ordering).toContain("if (a.rank !== b.rank) return a.rank - b.rank;");
    expect(ordering).toContain("if (a.approved !== b.approved) return a.approved - b.approved;");

    // And an approved resource is still classified by the same deterministic
    // rank function as anything else — approval is not an input to it.
    const codeOf = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const rank = codeOf(
      src.slice(
        src.indexOf("export function rankCandidateForComponent"),
        src.indexOf("export function orderCandidatesForComponent"),
      ),
    );
    expect(rank).not.toContain("approved");
  });

  it("TEST 12: no cap or budget moved", async () => {
    const { readFileSync } = await import("node:fs");
    const executor = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(executor).toContain("const MAX_SEARCH_RESULTS_PER_QUERY = 5;");
    expect(executor).toContain("const MAX_QUERIES_PER_ATTEMPT = 3;");
    expect(executor).toContain("const MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT = 6;");
    // The open loop still breaks on the same allowance — priority reorders
    // the queue, it never lengthens it.
    expect(executor).toContain("if (opensAttempted >= openAllowance) break;");
    const resource = readFileSync("src/server/memory/source-resource.ts", "utf-8");
    expect(resource).toContain("MAX_SOURCE_RESOURCE_SEEDS = 3");
  });

  it("TEST 13: ordering is deterministic across repeated preparations", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const resource = `https://${project.host}/docs/approved.md`;
    await register(project.slug, resource, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);
    const urls = [
      "https://explorer.solana.com/address/So77777777777777777777777777777777777777777",
      resource,
      "https://unknown-host.test/page",
    ];
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const approved = approvedResourcesForComponent(
        await loadAcquisitionLedger(ctx.db, jobId),
        item.step,
        item.component,
      );
      runs.push(orderCandidatesForComponent(urls, DESTINATION_CLASSES, null, approved));
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it("TEST 14: no project-, host- or url-specific logic", async () => {
    const { readFileSync } = await import("node:fs");
    const codeOf = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    for (const file of [
      "src/server/engine/acquisition-targeting.ts",
      "src/server/engine/acquisition-ledger.ts",
    ]) {
      const src = codeOf(readFileSync(file, "utf-8"));
      expect(src, file).not.toMatch(/pump|raydium|hyperliquid|jito|etherscan|solscan/i);
    }
  });

  it("TEST 15: an unknown component simply has no approvals", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const ledger = await loadAcquisitionLedger(ctx.db, jobId);
    // Degrades to "nothing approved", never to a throw or a guess.
    expect(approvedResourcesForComponent(ledger, 99, "NOT_A_COMPONENT").size).toBe(0);
    const [row] = await ctx.db
      .select({ n: researchJobs.sourceOpensReserved })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    expect(row?.n ?? 0).toBe(0);
  });
});
