import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projects, researchTraceEvents, topics, users } from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import {
  loadFetchTargets,
  prepareExtractionReplaySearch,
} from "../src/server/engine/acquisition-phases";
import { componentsAdmittingClass } from "../src/server/engine/acquisition-plan";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { loadActivePatternComponents } from "../src/server/memory/pattern-components";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { registerSourceResource } from "../src/server/memory/source-resource";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// D-156 — A SEALED SOURCE REACHES EVERY ACTIVE COMPONENT THAT COULD USE IT.
//
// The defect: a human-approved resource was routed ONLY to the
// componentKeys typed at registration. Those keys are a curation hint, not
// an authority statement, and nothing checked them against the Pattern.
//
// The PUMP acceptance run is the whole argument. /pump-token resolved as
// CONFIRMED / OFFICIAL_DOCS and was registered for EXECUTION_EVIDENCE and
// DESTINATION. EXECUTION_EVIDENCE's establishingClasses are
// ONCHAIN_VERIFIABLE and OFFICIAL_REPORT — it cannot be established by
// OFFICIAL_DOCS at all — so all seven rows extracted for it were correctly
// discarded as CLASS_NOT_ADMISSIBLE, while MECHANISM_SPEC, FLOW_PATH and
// SOURCE_OF_VALUE, which DO admit OFFICIAL_DOCS and whose evidenceGoal the
// same document answers, were never shown it.
//
// ROUTING IS NOT ESTABLISHMENT, and these tests are written to keep those
// two apart. Widening who may READ a document says nothing about what may
// be ESTABLISHED from it: S5's establishingClasses check is untouched and
// is asked again, per Evidence row, downstream. A component that could not
// be established by this class before still cannot be.

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

// The component the whole defect is named after: it admits ONLY
// ONCHAIN_VERIFIABLE and OFFICIAL_REPORT, so an OFFICIAL_DOCS page must
// never be routed into it by admissibility.
const NON_ADMITTING = "EXECUTION_EVIDENCE";

async function makeProject(routeClass: "OFFICIAL_DOCS" | "GOVERNANCE" = "OFFICIAL_DOCS") {
  const host = `docs.${uniq("p").replace(/_/g, "-")}.test`;
  const slug = uniq("d153");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "D153 Fixture", status: "ACTIVE_CORE" })
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
    routeClass,
  });
  if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  return { id: project.id, slug, host };
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

async function corpusFor(jobId: string, item: ComponentWorkItem): Promise<string[]> {
  const gateway = await prepareExtractionReplaySearch(ctx.db, jobId);
  const results = await gateway.search(
    "anything",
    {
      step: item.step,
      stepName: "s",
      component: item.component,
      projectId: "p",
      projectName: "n",
      projectSlug: "s",
    },
    { maxResults: 50 },
  );
  return results.map((r: { url: string }) => r.url);
}

async function routedComponents(jobId: string, url: string): Promise<string[]> {
  const rows = await ctx.db
    .select({
      op: researchTraceEvents.operationType,
      component: researchTraceEvents.component,
      ref: researchTraceEvents.targetRef,
    })
    .from(researchTraceEvents)
    .where(eq(researchTraceEvents.researchJobId, jobId));
  return rows
    .filter((r) => r.op === "SOURCE_RESOURCE_SELECTED" && r.ref === url)
    .map((r) => r.component as string);
}

describe("D-156 A — a sealed OFFICIAL_DOCS source reaches other components that admit it", () => {
  it("a resource registered for one component is also routed to another ACTIVE component that admits its class", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const registered = items.find((i) => i.component === "DESTINATION");
    const other = items.find((i) => i.component === "MECHANISM_SPEC");
    if (!registered || !other) throw new Error("fixture pattern missing the probed components");

    const url = `https://${project.host}/docs/token.md`;
    await register(project.slug, url, [registered.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // The human's own choice is never withdrawn...
    expect(await corpusFor(jobId, registered)).toContain(url);
    // ...and the component that could actually be established by this
    // class now gets to read the same document with its own evidenceGoal.
    expect(await corpusFor(jobId, other)).toContain(url);
  });

  it("routing is driven by the resolved class, not by the registered list", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/by-class.md`;
    // Registered ONLY for the component that cannot admit the class.
    await register(project.slug, url, [NON_ADMITTING]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const routed = await routedComponents(jobId, url);
    const admitting = await componentsAdmittingClass(
      ctx.db,
      jobId,
      "OFFICIAL_DOCS",
      items.map((i) => i.component),
    );
    expect(admitting.length).toBeGreaterThan(0);
    for (const component of admitting) expect(routed).toContain(component);
    // Named explicitly because these three are the components the PUMP run
    // proved were starved: each admits OFFICIAL_DOCS and each was never
    // shown the document the human had already approved.
    for (const starved of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC"]) {
      expect(admitting).toContain(starved);
      expect(routed).toContain(starved);
    }
  });
});

describe("D-156 B — routing is not establishment", () => {
  it("a component that does not admit the class is never routed into by admissibility", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const admittingItem = items.find((i) => i.component === "MECHANISM_SPEC");
    if (!admittingItem) throw new Error("fixture pattern missing MECHANISM_SPEC");

    const url = `https://${project.host}/docs/not-execution.md`;
    // Registered for a component that DOES admit the class, so the only
    // way EXECUTION_EVIDENCE could appear is admissibility expansion.
    await register(project.slug, url, [admittingItem.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    expect(await routedComponents(jobId, url)).not.toContain(NON_ADMITTING);
  });

  it("OFFICIAL_DOCS is still not admissible for EXECUTION_EVIDENCE", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);

    const admitting = await componentsAdmittingClass(
      ctx.db,
      jobId,
      "OFFICIAL_DOCS",
      items.map((i) => i.component),
    );
    expect(admitting).not.toContain(NON_ADMITTING);
    // And the classes that DO establish it are unchanged.
    const onchain = await componentsAdmittingClass(ctx.db, jobId, "ONCHAIN_VERIFIABLE", [
      NON_ADMITTING,
    ]);
    const report = await componentsAdmittingClass(ctx.db, jobId, "OFFICIAL_REPORT", [
      NON_ADMITTING,
    ]);
    expect(onchain).toEqual([NON_ADMITTING]);
    expect(report).toEqual([NON_ADMITTING]);
  });

  it("a seeded resource still reaches the component a human named, even when that component cannot admit its class", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const url = `https://${project.host}/docs/kept.md`;
    await register(project.slug, url, [NON_ADMITTING]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // Nothing a human approved is withdrawn by this change — the
    // registered destination survives. What it does NOT do is establish
    // anything, which is S5's decision and is asserted by the reduction
    // suites, not here.
    expect(await routedComponents(jobId, url)).toContain(NON_ADMITTING);
  });

  it("an explicitly registered non-admitting component is never the ONLY routing destination", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const url = `https://${project.host}/docs/mismatch.md`;
    await register(project.slug, url, [NON_ADMITTING]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const routed = await routedComponents(jobId, url);
    // The registration mismatch invariant: a human typing a component that
    // structurally cannot use this class can no longer silently make the
    // document unreadable by everything that can.
    expect(routed.length).toBeGreaterThan(1);
    expect(routed.filter((c) => c !== NON_ADMITTING).length).toBeGreaterThan(0);
  });
});

describe("D-156 C — expansion is bounded by the job", () => {
  it("a component outside this job's work queue is never expanded into", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const inQueue = new Set(items.map((i) => i.component));
    const outside = [...vocabulary].filter((c) => !inQueue.has(c));

    const url = `https://${project.host}/docs/bounded.md`;
    await register(project.slug, url, [items[0].component, ...outside.slice(0, 1)]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const routed = await routedComponents(jobId, url);
    for (const c of outside) expect(routed).not.toContain(c);
    for (const c of routed) expect(inQueue.has(c)).toBe(true);
  });

  it("componentsAdmittingClass only ever answers from the candidates it was given", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const admitting = await componentsAdmittingClass(ctx.db, jobId, "OFFICIAL_DOCS", [
      "MECHANISM_SPEC",
    ]);
    expect(admitting).toEqual(["MECHANISM_SPEC"]);
    expect(await componentsAdmittingClass(ctx.db, jobId, "OFFICIAL_DOCS", [])).toEqual([]);
    // An unknown component is not invented into existence.
    expect(
      await componentsAdmittingClass(ctx.db, jobId, "OFFICIAL_DOCS", ["NOT_A_COMPONENT"]),
    ).toEqual([]);
  });

  it("a class no component admits expands into nothing", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    // SOCIAL appears in no componentRequirements row (D-074): no component
    // is establishable by it, however many rows accumulate.
    expect(
      await componentsAdmittingClass(ctx.db, jobId, "SOCIAL", items.map((i) => i.component)),
    ).toEqual([]);
  });
});

describe("D-156 D — component-specific extraction semantics are preserved", () => {
  it("expansion hands over the document, never another component's Evidence", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const registered = items.find((i) => i.component === "DESTINATION");
    const other = items.find((i) => i.component === "FLOW_PATH");
    if (!registered || !other) throw new Error("fixture pattern missing the probed components");

    const url = `https://${project.host}/docs/shared.md`;
    await register(project.slug, url, [registered.component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    // Both corpora hold the URL — the document — and nothing else crosses.
    expect(await corpusFor(jobId, registered)).toContain(url);
    expect(await corpusFor(jobId, other)).toContain(url);

    // Provenance is per (step, component): one row each, carrying a url
    // and a component and nothing that could be mistaken for a class, an
    // officiality, an outcome or an Evidence row.
    const rows = await ctx.db
      .select({
        op: researchTraceEvents.operationType,
        providerName: researchTraceEvents.providerName,
        component: researchTraceEvents.component,
        step: researchTraceEvents.patternStep,
        ref: researchTraceEvents.targetRef,
        evidenceId: researchTraceEvents.evidenceId,
      })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    const prov = rows.filter((r) => r.op === "SOURCE_RESOURCE_SELECTED" && r.ref === url);
    expect(prov.length).toBeGreaterThan(1);
    for (const row of prov) {
      expect(row.providerName).toBe("source-resource");
      expect(row.evidenceId).toBeNull();
      expect(JSON.stringify(row)).not.toContain("OFFICIAL_DOCS");
      expect(JSON.stringify(row)).not.toContain("CONFIRMED");
    }
    // One row per (step, component) pair — never duplicated, so no
    // component receives another's association twice.
    const pairs = prov.map((r) => `${r.step}:${r.component}`);
    expect(new Set(pairs).size).toBe(pairs.length);

    // No search provenance is forged for a curated url, in either
    // direction: expansion must not disguise a resource as a search hit.
    expect(rows.filter((r) => r.op === "CANDIDATE_RETURNED" && r.ref === url)).toHaveLength(0);
  });

  it("expansion creates no Evidence and spends no source open by itself", async () => {
    const project = await makeProject();
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/no-evidence.md`;
    await register(project.slug, url, [items[0].component]);

    const targets = await loadFetchTargets(ctx.db, jobId, project.id);
    // However many components are routed, the url is ONE acquisition
    // target: expansion widens readership, never spending.
    expect(targets.filter((t) => t === url)).toHaveLength(1);

    const rows = await ctx.db
      .select({ op: researchTraceEvents.operationType })
      .from(researchTraceEvents)
      .where(eq(researchTraceEvents.researchJobId, jobId));
    expect(rows.filter((r) => r.op === "EXTRACT_OK")).toHaveLength(0);
  });

  it("a resource whose route resolves to a different class expands by that class", async () => {
    // Generic, not OFFICIAL_DOCS-specific: the same rule steers a
    // GOVERNANCE route at whatever GOVERNANCE establishes.
    const project = await makeProject("GOVERNANCE");
    const jobId = await makeJob(project.id);
    const items = await workItems(jobId);
    const url = `https://${project.host}/docs/gov.md`;
    await register(project.slug, url, [items[0].component]);
    await loadFetchTargets(ctx.db, jobId, project.id);

    const routed = await routedComponents(jobId, url);
    const admitting = await componentsAdmittingClass(
      ctx.db,
      jobId,
      "GOVERNANCE",
      items.map((i) => i.component),
    );
    for (const component of admitting) expect(routed).toContain(component);
    // GOVERNANCE_BASIS admits GOVERNANCE and is reachable this way; it is
    // NOT reachable from an OFFICIAL_DOCS route.
    expect(admitting).toContain("GOVERNANCE_BASIS");
    const viaDocs = await componentsAdmittingClass(ctx.db, jobId, "OFFICIAL_DOCS", [
      "GOVERNANCE_BASIS",
    ]);
    expect(viaDocs).toEqual([]);
  });
});
