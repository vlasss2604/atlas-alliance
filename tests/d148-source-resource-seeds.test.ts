import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import { projectMemoryItems, projects, researchJobs, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { loadFetchTargets, runSearchPhase } from "../src/server/engine/acquisition-phases";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { resolveSourceRoute } from "../src/server/engine/source-authority";
import type { ComponentTarget } from "../src/server/engine/providers/types";
import { supersedeProjectMemoryItem } from "../src/server/memory/lifecycle";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import {
  MAX_SOURCE_RESOURCE_SEEDS,
  loadEligibleSourceResources,
  registerSourceResource,
} from "../src/server/memory/source-resource";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-148 — A KNOWN, HUMAN-APPROVED SOURCE MUST NOT DEPEND ON SEARCH LUCK.
//
// The gap these tests close: acquisition targets came only from search
// discovery, so a project could hold an ACTIVE, human-classified route and
// a known-good document under it, and still never fetch that document
// because the search engine returned an unclassified sibling path instead.
// The facts extracted from that sibling were then correctly admitted as
// SOCIAL, and the whole Proof failed on evidence the project already had.
//
// The fix must not become a licence: a route PREFIX is still not a
// resource, an unclassified path still inherits nothing, and a resource
// grants no authority of its own.

let ctx: TestContext;
let componentVocabulary: Set<string>;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  componentVocabulary = await loadActivePatternComponents(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 5,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_536,
  priceVersion: "test-fixture-not-production",
};

// A project with a confirmed + classified docs route. The host is generic:
// nothing in these tests names a real project.
async function makeProject(opts: { host?: string; prefix?: string; classify?: boolean } = {}) {
  // Hostname labels admit only [a-z0-9-], so the unique suffix is
  // hyphenated rather than underscored.
  const host = opts.host ?? `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const prefix = opts.prefix ?? "/docs/spec.md";
  const slug = uniq("d148");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D148 Fixture", status: "ACTIVE_CORE" })
    .returning();
  const identity = await confirmProjectIdentity(ctx.db, {
    projectSlug: slug,
    chain: "solana",
    tokenAddress: MINT,
  });
  if (!identity.ok) throw new Error("identity fixture failed");

  let routeId: string | null = null;
  if (opts.classify !== false) {
    const confirmed = await confirmSourceRoute(ctx.db, {
      projectSlug: slug,
      domain: host,
      pathPrefix: prefix,
    });
    if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, {
      routeId: confirmed.itemId,
      routeClass: "OFFICIAL_DOCS",
    });
    if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
    routeId = classified.newItemId;
  }
  return { id: project.id, slug, name: project.name, host, prefix, routeId };
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

// One search pass persisting `urls` as this job's discovered candidates.
async function seedSearch(project: { id: string; name: string; slug: string }, jobId: string, urls: string[]) {
  const { view } = await loadJobContractView(ctx.db, jobId);
  await runSearchPhase({
    db: ctx.db,
    jobId,
    items: view.workQueue.slice(0, 1),
    target: (item: ComponentWorkItem): ComponentTarget => ({
      step: item.step,
      stepName: item.stepName,
      component: item.component,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
    }),
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        return Array.from({ length: input.maxQueries }, (_, i) => `q-${i + 1}`);
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

async function jobComponents(jobId: string): Promise<Set<string>> {
  const { view } = await loadJobContractView(ctx.db, jobId);
  return new Set(view.workQueue.map((i) => i.component));
}

// Registers a resource using whatever components this job actually needs,
// so the relevance gate is exercised rather than sidestepped.
async function registerFor(slug: string, url: string, components: string[]) {
  return registerSourceResource(ctx.db, { projectSlug: slug, url, componentKeys: components }, componentVocabulary);
}

describe("D-148 — known resources seed acquisition", () => {
  it("TEST 1: seeds a classified resource that search never returned", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const resourceUrl = `https://${project.host}${project.prefix}`;
    const needed = [...(await jobComponents(jobId))];
    expect(needed.length).toBeGreaterThan(0);

    const reg = await registerFor(project.slug, resourceUrl, needed.slice(0, 2));
    expect(reg.ok).toBe(true);

    // Search finds something else entirely.
    await seedSearch(project, jobId, ["https://elsewhere.test/article"]);

    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets).toContain(resourceUrl);
    // Priority: the human-approved resource precedes the social candidate.
    expect(targets[0]).toBe(resourceUrl);
  });

  it("TEST 2: relevance gate — only resources whose components this job needs", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const needed = [...(await jobComponents(jobId))];
    const notNeeded = [...componentVocabulary].filter((c) => !needed.includes(c));

    const r1 = `https://${project.host}${project.prefix}`;
    expect((await registerFor(project.slug, r1, [needed[0]])).ok).toBe(true);

    const eligible = await loadEligibleSourceResources(ctx.db, project.id, new Set(needed));
    expect(eligible).toContain(r1);

    if (notNeeded.length > 0) {
      // A resource serving nothing this job needs is not seeded.
      const none = await loadEligibleSourceResources(ctx.db, project.id, new Set([notNeeded[0]]));
      expect(none).not.toContain(r1);
    }
    // And an empty need-set seeds nothing at all.
    expect(await loadEligibleSourceResources(ctx.db, project.id, new Set())).toEqual([]);
  });

  it("TEST 3: search + resource dedup spends one target", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const resourceUrl = `https://${project.host}${project.prefix}`;
    const needed = [...(await jobComponents(jobId))];
    expect((await registerFor(project.slug, resourceUrl, needed.slice(0, 1))).ok).toBe(true);

    // Search returns the SAME canonical url.
    await seedSearch(project, jobId, [resourceUrl, "https://elsewhere.test/x"]);

    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets.filter((t) => t === resourceUrl)).toHaveLength(1);
  });

  it("TEST 4: a broad classified PREFIX never becomes a seed on its own", async () => {
    // A whole documentation tree is a legitimate authority scope, and it is
    // exactly what must never be fetched merely because it is classified.
    const project = await makeProject({ prefix: "/docs" });
    const jobId = await makeJob(project.id);
    await seedSearch(project, jobId, ["https://elsewhere.test/x"]);

    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    expect(targets).not.toContain(`https://${project.host}/docs`);
    expect(targets).not.toContain(`https://${project.host}/docs/`);
    // No SOURCE_RESOURCE row exists, so nothing was seeded.
    expect(await loadEligibleSourceResources(ctx.db, project.id, await jobComponents(jobId))).toEqual([]);
  });

  it("TEST 5: an unclassified sibling path inherits nothing", async () => {
    const project = await makeProject({ prefix: "/docs/foo.md" });
    const resourceUrl = `https://${project.host}/docs/foo.md`;
    const sibling = `https://${project.host}/docs/foo`;
    expect((await registerFor(project.slug, resourceUrl, [...componentVocabulary].slice(0, 1))).ok).toBe(true);

    // The classified resource resolves with authority...
    const onResource = await resolveSourceRoute(ctx.db, project.id, resourceUrl);
    expect(onResource.routeClass).toBe("OFFICIAL_DOCS");

    // ...and the extensionless sibling still resolves exactly as before:
    // the host is confirmed, the PATH is not classified. This is the
    // invariant the whole incident turned on.
    const onSibling = await resolveSourceRoute(ctx.db, project.id, sibling);
    expect(onSibling.routeClass).toBeNull();
    expect(onSibling.officiality).toBe("CONFIRMED");
  });

  it("TEST 6: a SUPERSEDED resource is not seeded", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const resourceUrl = `https://${project.host}${project.prefix}`;
    const reg = await registerFor(project.slug, resourceUrl, [...(await jobComponents(jobId))].slice(0, 1));
    if (!reg.ok) throw new Error("fixture registration failed");

    // Superseded IN FAVOUR of a real replacement, the way the lifecycle
    // is meant to be used — one named row aside for one named successor.
    const replacement = await registerFor(
      project.slug,
      `https://${project.host}${project.prefix}?v=2`,
      [...(await jobComponents(jobId))].slice(0, 1),
    );
    if (!replacement.ok) throw new Error("replacement fixture failed");
    await supersedeProjectMemoryItem(ctx.db, reg.itemId, replacement.itemId);

    const eligible = await loadEligibleSourceResources(ctx.db, project.id, await jobComponents(jobId));
    expect(eligible).not.toContain(resourceUrl);
  });

  it("TEST 7: an ACTIVE resource loses eligibility when its route stops granting authority", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const resourceUrl = `https://${project.host}${project.prefix}`;
    expect((await registerFor(project.slug, resourceUrl, [...(await jobComponents(jobId))].slice(0, 1))).ok).toBe(true);
    expect(await loadEligibleSourceResources(ctx.db, project.id, await jobComponents(jobId))).toContain(resourceUrl);

    // Supersede the ROUTE, not the resource. Approval cannot outlive the
    // authority that justified it, and must never borrow another path's.
    if (!project.routeId) throw new Error("fixture has no route");
    const successor = await confirmSourceRoute(ctx.db, {
      projectSlug: project.slug,
      domain: project.host,
      pathPrefix: "/elsewhere",
    });
    if (!successor.ok) throw new Error("successor route fixture failed");
    await supersedeProjectMemoryItem(ctx.db, project.routeId, successor.itemId);

    const after = await loadEligibleSourceResources(ctx.db, project.id, await jobComponents(jobId));
    expect(after).not.toContain(resourceUrl);
  });

  it("TEST 8: cross-project isolation", async () => {
    const a = await makeProject();
    const b = await makeProject();
    const jobB = await makeJob(b.id);
    const urlA = `https://${a.host}${a.prefix}`;
    expect((await registerFor(a.slug, urlA, [...componentVocabulary].slice(0, 1))).ok).toBe(true);

    const eligibleForB = await loadEligibleSourceResources(ctx.db, b.id, await jobComponents(jobB));
    expect(eligibleForB).not.toContain(urlA);

    const targetsB = await loadFetchTargets(ctx.db, jobB, b.id);
    expect(targetsB).not.toContain(urlA);
  });

  it("TEST 9: at most three seeds, deterministically ordered", async () => {
    const project = await makeProject({ prefix: "/docs" });
    const jobId = await makeJob(project.id);
    const needed = [...(await jobComponents(jobId))].slice(0, 1);

    // Five resources, all under the same classified /docs scope.
    const urls: string[] = [];
    for (let i = 0; i < 5; i++) {
      const url = `https://${project.host}/docs/page-${i}.md`;
      const reg = await registerFor(project.slug, url, needed);
      expect(reg.ok).toBe(true);
      urls.push(url);
    }

    const eligible = await loadEligibleSourceResources(ctx.db, project.id, new Set(needed));
    expect(eligible).toHaveLength(MAX_SOURCE_RESOURCE_SEEDS);
    expect(MAX_SOURCE_RESOURCE_SEEDS).toBe(3);
    // Stable: oldest approval first, and the same answer on a repeat call.
    expect(eligible).toEqual(urls.slice(0, 3));
    expect(await loadEligibleSourceResources(ctx.db, project.id, new Set(needed))).toEqual(eligible);
  });

  it("TEST 10: seeds do not raise any budget or ceiling", async () => {
    const project = await makeProject({ prefix: "/docs" });
    const jobId = await makeJob(project.id);
    const needed = [...(await jobComponents(jobId))].slice(0, 1);
    for (let i = 0; i < 5; i++) {
      expect((await registerFor(project.slug, `https://${project.host}/docs/b-${i}.md`, needed)).ok).toBe(true);
    }
    await seedSearch(project, jobId, ["https://elsewhere.test/x"]);

    const [before] = await ctx.db
      .select({ opens: researchJobs.sourceOpensReserved, budget: researchJobs.budgetAtStart })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));

    const targets = await loadFetchTargets(ctx.db, jobId, project.id);

    const [after] = await ctx.db
      .select({ opens: researchJobs.sourceOpensReserved, budget: researchJobs.budgetAtStart })
      .from(researchJobs)
      .where(eq(researchJobs.id, jobId));

    // Planning spends nothing, and the envelope is byte-identical.
    expect(after.opens).toBe(before.opens);
    expect(JSON.stringify(after.budget)).toBe(JSON.stringify(before.budget));
    // At most three of the five resources ever reached the plan.
    const seeded = targets.filter((t) => t.includes("/docs/b-"));
    expect(seeded.length).toBeLessThanOrEqual(MAX_SOURCE_RESOURCE_SEEDS);
  });

  it("TEST 11: registration fails closed", async () => {
    const classified = await makeProject({ prefix: "/docs/ok.md" });
    const unclassified = await makeProject({ prefix: "/docs/x.md", classify: false });
    const anyComponent = [...componentVocabulary].slice(0, 1);

    // Outside every classified route on a confirmed host.
    const outside = await registerFor(classified.slug, `https://${classified.host}/other/page.md`, anyComponent);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.refusal).toBe("ROUTE_NOT_CLASSIFIED");

    // A host with no confirmed route at all.
    const foreign = await registerFor(classified.slug, "https://not-this-project.test/a.md", anyComponent);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.refusal).toBe("NO_AUTHORITATIVE_ROUTE");

    // Confirmed but unclassified route: a confirmed host is not authority.
    const confirmedOnly = await confirmSourceRoute(ctx.db, {
      projectSlug: unclassified.slug,
      domain: unclassified.host,
      pathPrefix: "/docs/x.md",
    });
    expect(confirmedOnly.ok).toBe(true);
    const noClass = await registerFor(unclassified.slug, `https://${unclassified.host}/docs/x.md`, anyComponent);
    expect(noClass.ok).toBe(false);
    if (!noClass.ok) expect(noClass.refusal).toBe("ROUTE_NOT_CLASSIFIED");

    // Empty and invalid component coverage.
    const empty = await registerFor(classified.slug, `https://${classified.host}/docs/ok.md`, []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.refusal).toBe("EMPTY_COMPONENT_KEYS");

    const bogus = await registerFor(classified.slug, `https://${classified.host}/docs/ok.md`, ["NOT_A_COMPONENT"]);
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.refusal).toBe("UNKNOWN_COMPONENT_KEY");

    // Non-https and duplicates.
    const http = await registerFor(classified.slug, `http://${classified.host}/docs/ok.md`, anyComponent);
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.refusal).toBe("URL_NOT_HTTPS");

    const first = await registerFor(classified.slug, `https://${classified.host}/docs/ok.md`, anyComponent);
    expect(first.ok).toBe(true);
    const dup = await registerFor(classified.slug, `https://${classified.host}/docs/ok.md`, anyComponent);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.refusal).toBe("DUPLICATE_ACTIVE_RESOURCE");
  });

  it("TEST 12: a resource stores no authority and has no path to Evidence", async () => {
    const project = await makeProject();
    const url = `https://${project.host}${project.prefix}`;
    const reg = await registerFor(project.slug, url, [...componentVocabulary].slice(0, 1));
    if (!reg.ok) throw new Error("fixture registration failed");

    const [row] = await ctx.db
      .select()
      .from(projectMemoryItems)
      .where(eq(projectMemoryItems.id, reg.itemId));
    const content = row.content as Record<string, unknown>;

    // The stored row carries the url and the coverage — and no class.
    expect(Object.keys(content).sort()).toEqual(["canonicalUrl", "componentKeys"]);
    expect(content).not.toHaveProperty("routeClass");
    expect(content).not.toHaveProperty("officiality");
    expect(row.kind).toBe("SOURCE_RESOURCE");

    // Authority is the resolver's answer, not the resource's.
    const resolved = await resolveSourceRoute(ctx.db, project.id, url);
    expect(resolved.routeClass).toBe("OFFICIAL_DOCS");

    // Structural: the resource module cannot reach Evidence or extraction.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/server/memory/source-resource.ts", "utf-8"),
    );
    expect(src).not.toMatch(/from "\.\.\/engine\/evidence|evidence-extractor|sourceClass|source_class/);
  });
});
