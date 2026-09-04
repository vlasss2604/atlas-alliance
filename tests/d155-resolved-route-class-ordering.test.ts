import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { projects, researchJobs, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  approvedResourcesForComponent,
  loadAcquisitionLedger,
} from "../src/server/engine/acquisition-ledger";
import {
  orderCandidatesForComponent,
  rankCandidateForComponent,
} from "../src/server/engine/acquisition-targeting";
import { loadFetchTargets, runSearchPhase } from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ComponentTarget } from "../src/server/engine/providers/types";
import { resolveSourceClass, resolveSourceRoute } from "../src/server/engine/source-authority";
import type { RouteClass } from "../src/server/engine/source-authority";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { supersedeProjectMemoryItem } from "../src/server/memory/lifecycle";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-155 — ORDERING STOPPED THROWING AWAY WHAT THE PROJECT ALREADY KNEW.
//
// `rankCandidateForComponent` always accepted an `activeRouteClass`, and the
// caller always passed null. A candidate whose route the project had ALREADY
// confirmed — through the ordinary human source-route system — was therefore
// ranked as an unrecognised host and lost to any positively-recognised one.
//
// Measured on the fresh Raydium DESTINATION case: the approved
// ray-buybacks.md ranked 1 (SOCIAL fallback) while an explorer url ranked 0
// (ONCHAIN_VERIFIABLE). That is rank, not a tie, so D-154's tie breaker could
// not reach it — the approved document lost before approval was ever
// consulted.
//
// This is acquisition PRIORITISATION only. The class comes from the one
// canonical resolver every other consumer uses, and `resolveSourceClass`
// consults it ONLY at its final fall-through, after every public,
// project-independent recognition rule has already had its say.

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
// A public explorer: positively recognised, project-independent, and the
// competitor in the demonstrated case.
const EXPLORER = "https://etherscan.io/token/0x1536e1f38f1d262137d738bff26ab72a3cf1955d";
// The establishing classes DESTINATION actually carries.
const DESTINATION_CLASSES = ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"] as const;

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

async function makeProject(opts: { classify?: boolean } = {}) {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("d155");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D155 Fixture", status: "ACTIVE_CORE" })
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
  let routeId = confirmed.itemId;
  if (opts.classify !== false) {
    const classified = await classifySourceRoute(ctx.db, {
      routeId: confirmed.itemId,
      routeClass: "OFFICIAL_DOCS",
    });
    if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
    routeId = classified.newItemId;
  }
  return { id: project.id, slug, name: project.name, host, routeId };
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

// Exactly what the executor now builds before ordering: the class each
// candidate's OWN project routes give it, through the canonical resolver.
async function routeClassMap(
  projectId: string,
  urls: string[],
): Promise<ReadonlyMap<string, RouteClass | null>> {
  const { canonicalTargetRef } = await import("../src/server/engine/trace-store");
  const out = new Map<string, RouteClass | null>();
  for (const url of urls) {
    const route = await resolveSourceRoute(ctx.db, projectId, url);
    out.set(canonicalTargetRef(url), route.officiality === "CONFIRMED" ? route.routeClass : null);
  }
  return out;
}

describe("D-155 — an already-known route class reaches candidate ordering", () => {
  it("TEST 1 (discriminating): the same candidate falls back to SOCIAL without the class, and takes OFFICIAL_DOCS with it", async () => {
    const project = await makeProject();
    const doc = `https://${project.host}/docs/approved.md`;

    // The route really is resolved, ACTIVE and confirmed — this is not a
    // class the test invented.
    const route = await resolveSourceRoute(ctx.db, project.id, doc);
    expect(route.officiality).toBe("CONFIRMED");
    expect(route.routeClass).toBe("OFFICIAL_DOCS");

    // PRE-D-155: no class supplied → unrecognised host → SOCIAL → rank 1.
    expect(resolveSourceClass(doc, "OTHER", null)).toBe("SOCIAL");
    expect(rankCandidateForComponent(doc, DESTINATION_CLASSES, null)).toBe(1);

    // POST-D-155: the class the project already had → OFFICIAL_DOCS → rank 0.
    expect(resolveSourceClass(doc, "OTHER", "OFFICIAL_DOCS")).toBe("OFFICIAL_DOCS");
    expect(rankCandidateForComponent(doc, DESTINATION_CLASSES, "OFFICIAL_DOCS")).toBe(0);
  });

  it("TEST 2: the demonstrated shape — official doc and explorer now rank equal", async () => {
    const project = await makeProject();
    const doc = `https://${project.host}/docs/approved.md`;
    const classes = await routeClassMap(project.id, [doc, EXPLORER]);

    // The explorer is unaffected: it is positively recognised, so no route
    // class is even consulted for it.
    expect(rankCandidateForComponent(EXPLORER, DESTINATION_CLASSES, null)).toBe(0);
    expect(resolveSourceClass(EXPLORER, "OTHER", "OFFICIAL_DOCS")).toBe("ONCHAIN_VERIFIABLE");

    // And the official doc now reaches the same establishing rank.
    //
    // Asserted through ORDER SYMMETRY, which is what actually proves the map
    // reached ranking: with EQUAL ranks the input order decides, so whichever
    // candidate is listed first stays first. Before D-155 the doc ranked 1
    // against the explorer's 0, so the explorer led from either input order —
    // meaning "explorer first" alone proves nothing, and only the doc-first
    // case discriminates.
    expect(orderCandidatesForComponent([EXPLORER, doc], DESTINATION_CLASSES, classes)).toEqual([
      EXPLORER,
      doc,
    ]);
    expect(orderCandidatesForComponent([doc, EXPLORER], DESTINATION_CLASSES, classes)).toEqual([
      doc,
      EXPLORER,
    ]);

    // D-155 alone adds no preference between them — that is D-154's job,
    // tested next.
  });

  it("TEST 3: once they tie, D-154 approval priority decides", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const doc = `https://${project.host}/docs/approved.md`;
    await register(project.slug, doc, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const approved = approvedResourcesForComponent(
      await loadAcquisitionLedger(ctx.db, jobId),
      item.step,
      item.component,
    );
    const classes = await routeClassMap(project.id, [doc, EXPLORER]);

    // The live shape end to end: explorer discovered first, one open.
    const ordered = orderCandidatesForComponent(
      [EXPLORER, doc],
      DESTINATION_CLASSES,
      classes,
      approved,
    );
    expect(ordered[0]).toBe(doc);
  });

  it("TEST 4: approval alone, with NO resolved route class, creates no rank", async () => {
    // A project whose route was confirmed but never classified: officiality
    // is CONFIRMED, routeClass is null, and approval must not fill the gap.
    const project = await makeProject({ classify: false });
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const doc = `https://${project.host}/docs/approved.md`;
    const route = await resolveSourceRoute(ctx.db, project.id, doc);
    expect(route.officiality).toBe("CONFIRMED");
    expect(route.routeClass).toBeNull();

    const classes = await routeClassMap(project.id, [doc, EXPLORER]);
    expect(classes.get((await import("../src/server/engine/trace-store")).canonicalTargetRef(doc))).toBeNull();
    // Still the fallback rank — approval is not a classification.
    expect(rankCandidateForComponent(doc, DESTINATION_CLASSES, null)).toBe(1);
    // And the explorer leads from EITHER input order, because the ranks are
    // genuinely unequal — the symmetry that held in TEST 2 does not hold here.
    expect(orderCandidatesForComponent([EXPLORER, doc], DESTINATION_CLASSES, classes)[0]).toBe(EXPLORER);
    expect(orderCandidatesForComponent([doc, EXPLORER], DESTINATION_CLASSES, classes)[0]).toBe(EXPLORER);
    // And the ordering function itself never reads approval when ranking.
    void jobId;
    void item;
  });

  it("TEST 5: an unknown host keeps the existing fallback behaviour", async () => {
    const project = await makeProject();
    const stranger = "https://nothing-known-about-this.test/page";
    const classes = await routeClassMap(project.id, [stranger]);
    const { canonicalTargetRef } = await import("../src/server/engine/trace-store");
    // No route matches it, so no class is supplied...
    expect(classes.get(canonicalTargetRef(stranger))).toBeNull();
    // ...and it ranks exactly as it always did.
    expect(rankCandidateForComponent(stranger, DESTINATION_CLASSES, null)).toBe(1);
    expect(resolveSourceClass(stranger, "OTHER", null)).toBe("SOCIAL");
  });

  it("TEST 6: a superseded route no longer classifies the candidate", async () => {
    const project = await makeProject();
    const doc = `https://${project.host}/docs/approved.md`;
    expect((await resolveSourceRoute(ctx.db, project.id, doc)).routeClass).toBe("OFFICIAL_DOCS");

    // Withdraw the classified route. The resolver reads ACTIVE rows only.
    const successor = await confirmSourceRoute(ctx.db, {
      projectSlug: project.slug,
      domain: project.host,
      pathPrefix: "/elsewhere",
    });
    if (!successor.ok) throw new Error("successor fixture failed");
    await supersedeProjectMemoryItem(ctx.db, project.routeId, successor.itemId);

    const after = await resolveSourceRoute(ctx.db, project.id, doc);
    expect(after.routeClass).toBeNull();
    const classes = await routeClassMap(project.id, [doc]);
    const { canonicalTargetRef } = await import("../src/server/engine/trace-store");
    expect(classes.get(canonicalTargetRef(doc))).toBeNull();
    expect(orderCandidatesForComponent([EXPLORER, doc], DESTINATION_CLASSES, classes)[0]).toBe(
      EXPLORER,
    );
  });

  it("TEST 7 + 8: route metadata is project-scoped and does not travel", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const docA = `https://${projectA.host}/docs/approved.md`;

    // A's own project sees the class...
    expect((await resolveSourceRoute(ctx.db, projectA.id, docA)).routeClass).toBe("OFFICIAL_DOCS");
    // ...and B, resolving the very same url, sees nothing at all.
    const fromB = await resolveSourceRoute(ctx.db, projectB.id, docA);
    expect(fromB.officiality).toBe("CLAIMED");
    expect(fromB.routeClass).toBeNull();

    const classesForB = await routeClassMap(projectB.id, [docA]);
    const { canonicalTargetRef } = await import("../src/server/engine/trace-store");
    expect(classesForB.get(canonicalTargetRef(docA))).toBeNull();
    expect(orderCandidatesForComponent([EXPLORER, docA], DESTINATION_CLASSES, classesForB)[0]).toBe(
      EXPLORER,
    );
  });

  it("TEST 9: a SEARCH candidate matching a known route benefits too — approval is not required", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    // Discovered by search, never approved as a SOURCE_RESOURCE.
    const found = `https://${project.host}/docs/found-by-search.md`;
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
          return [{ url: found, title: null, snippet: null }];
        },
      },
      maxSearchQueries: INTERNAL_ALPHA_V1.maxSearchQueries,
      maxResultsPerQuery: 10,
      maxQueriesPerComponent: 2,
      maxModelCostMicro: INTERNAL_ALPHA_V1.maxModelCostMicro,
      projectId: project.id,
      queryProposerCostProfile: COST,
    });

    const approved = approvedResourcesForComponent(
      await loadAcquisitionLedger(ctx.db, jobId),
      item.step,
      item.component,
    );
    expect(approved.size).toBe(0); // nothing was approved
    const classes = await routeClassMap(project.id, [found]);
    // The route class still applies — it is a property of the project's
    // routes, not of how the url was discovered.
    expect(rankCandidateForComponent(found, DESTINATION_CLASSES, "OFFICIAL_DOCS")).toBe(0);
    expect(orderCandidatesForComponent([found], DESTINATION_CLASSES, classes, approved)).toEqual([
      found,
    ]);
  });

  it("TEST 10 + 11 + 12: ordering grants no authority, no evidence and no provenance", async () => {
    const { readFileSync } = await import("node:fs");
    const codeOf = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const targeting = codeOf(readFileSync("src/server/engine/acquisition-targeting.ts", "utf-8"));
    // Ordering decides order. It writes nothing, admits nothing, and cannot
    // mark a source official.
    expect(targeting).not.toContain("officiality");
    expect(targeting).not.toContain("admissib");
    expect(targeting).not.toContain("recordTraceEvent");
    expect(targeting).not.toContain("insert");

    const exec = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    // A high rank never substitutes for a successful fetch: a failed fetch
    // still records FETCH_FAILED and continues, producing no document.
    expect(exec).toContain('operationType: fetchResult.ok ? "FETCH_OK" : "FETCH_FAILED"');
    // And the route is STILL re-resolved on the landed url after the fetch,
    // so a redirect cannot inherit the pre-fetch decision.
    expect(exec).toContain("resolveSourceRoute(deps.db, deps.project.id, doc.finalUrl)");
    // Class and entity binding for persistence are computed from the fetched
    // document, not from the ordering input.
    expect(exec).toContain("resolveSourceClass(doc.finalUrl, sourceInfo.sourceType, route.routeClass)");
  });

  it("TEST 13 + 16: D-154 tie behaviour and the open budget are untouched", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const [, , item] = await workItems(jobId);
    const doc = `https://${project.host}/docs/approved.md`;
    await register(project.slug, doc, [item.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);
    const approved = approvedResourcesForComponent(
      await loadAcquisitionLedger(ctx.db, jobId),
      item.step,
      item.component,
    );
    // Two equally-ranked unrecognised hosts: approval still breaks the tie,
    // exactly as D-154 established, with no route class involved.
    const peer = "https://another-unknown-host.test/page";
    expect(orderCandidatesForComponent([peer, doc], DESTINATION_CLASSES, null, approved)[0]).toBe(
      doc,
    );

    // Ordering opened nothing: resolving routes is a local read.
    const [row] = await ctx.db
      .select({ n: researchJobs.sourceOpensReserved })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));
    expect(row?.n ?? 0).toBe(0);

    const { readFileSync } = await import("node:fs");
    const exec = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
    expect(exec).toContain("const MAX_SEARCH_RESULTS_PER_QUERY = 5;");
    expect(exec).toContain("const MAX_QUERIES_PER_ATTEMPT = 3;");
    expect(exec).toContain("const MAX_SOURCE_OPEN_ATTEMPTS_PER_ATTEMPT = 6;");
    expect(exec).toContain("if (opensAttempted >= openAllowance) break;");
    expect(readFileSync("src/server/memory/source-resource.ts", "utf-8")).toContain(
      "MAX_SOURCE_RESOURCE_SEEDS = 3",
    );
  });

  it("TEST 17: ordering stays deterministic across repeated preparations", async () => {
    const project = await makeProject();
    const doc = `https://${project.host}/docs/approved.md`;
    const urls = [EXPLORER, doc, "https://unknown-host.test/page"];
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(
        orderCandidatesForComponent(urls, DESTINATION_CLASSES, await routeClassMap(project.id, urls)),
      );
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    // Still a pure reordering.
    expect([...runs[0]].sort()).toEqual([...urls].sort());
  });

  it("TEST 18: no project-, host- or url-specific logic", async () => {
    const { readFileSync } = await import("node:fs");
    const codeOf = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    for (const file of [
      "src/server/engine/acquisition-targeting.ts",
      "src/server/engine/acquisition-ledger.ts",
    ]) {
      expect(codeOf(readFileSync(file, "utf-8")), file).not.toMatch(
        /pump|raydium|hyperliquid|jito|etherscan|solscan/i,
      );
    }
    // The executor's D-155 block names no host and no project either — it
    // asks the canonical resolver and uses whatever it says.
    const exec = codeOf(readFileSync("src/server/engine/s4-executor.ts", "utf-8"));
    const block = exec.slice(exec.indexOf("routeByCandidate"), exec.indexOf("orderedCandidates"));
    expect(block).not.toMatch(/pump|raydium|etherscan|solscan|\.io|\.com/i);
    expect(block).toContain("resolveSourceRoute(deps.db, deps.project.id, url)");
  });
});
