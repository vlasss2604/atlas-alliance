import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { interpretations, projectMemoryItems, projects, sources, topics, users } from "../src/server/db/schema";
import { loadAcquisitionPlan } from "../src/server/engine/acquisition-plan";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { runResearchController, type WorkExecutor } from "../src/server/engine/controller";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import {
  classifyComponentCoverage,
  deriveResearchCoverage,
  isAuthorityPending,
  loadResearchCoverage,
  type ComponentCoverageInput,
} from "../src/server/engine/research-coverage";
import { isCommunityHost, resolveSourceRoute } from "../src/server/engine/source-authority";
import { observeSourceRouteCandidate } from "../src/server/engine/source-route-candidates";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import {
  MAX_REVIEW_URLS,
  loadRouteCandidateReview,
  rejectRouteCandidate,
  suggestRouteClassHint,
} from "../src/server/memory/source-route-candidate-review";
import { classifySourceRoute, isBroadCommunityScope } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { decideOwnerRoute, previewOwnerRouteDecision } from "../src/server/memory/source-route-owner-decision";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// SOURCE AUTHORITY STRATEGY V1 — P0 OWNER WORKFLOW.
//
// DISCOVERY != AUTHORITY. The engine observes; the owner decides, once per
// host + prefix + class, and every future Research on the project reuses
// the decision. These tests pin that the workflow makes the owner faster
// without letting anything but the owner's explicit, typed decision grant
// ownership, class or authority — and that a community host can never be
// GOVERNANCE / OFFICIAL_DOCS for the whole host (founder decision P0-4).

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const apexHost = () => `proj-${uniq("h").replace(/_/g, "-")}.test`;
const jobRef = () => uniq("job-").replace(/_/g, "-");

async function makeProject(apex: string, opts: { docs?: boolean } = { docs: true }) {
  const slug = uniq("sas");
  const [project] = await ctx.db.insert(projects).values({ slug, name: "Authority Strategy Project", status: "ACTIVE_CORE" }).returning();
  if (opts.docs) {
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: apex, pathPrefix: "/docs" });
    if (!confirmed.ok) throw new Error("confirm failed: " + confirmed.refusal);
    const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" });
    if (!classified.ok) throw new Error("classify failed: " + classified.refusal);
  }
  return { id: project.id, slug };
}

// An observation through the REAL observer, on the real resolver output.
async function observe(projectId: string, url: string, component: string, evidenceCount: number, jobId = jobRef()) {
  const [source] = await ctx.db.insert(sources).values({ url, urlHash: uniq("hash"), sourceType: "OTHER" }).returning();
  const route = await resolveSourceRoute(ctx.db, projectId, url);
  return observeSourceRouteCandidate(ctx.db, { projectId, jobId, sourceId: source.id, finalUrl: url, component, evidenceCount, route });
}

async function routeRows(projectId: string) {
  return ctx.db
    .select()
    .from(projectMemoryItems)
    .where(and(eq(projectMemoryItems.projectId, projectId), eq(projectMemoryItems.kind, "SOURCE_ROUTE")));
}

const snapshot = async (projectId: string) =>
  JSON.stringify((await routeRows(projectId)).map((r) => [r.id, r.lifecycleState, r.content, r.supersededBy]).sort());

// ---------------------------------------------------------------------------
// 1. community hosts and the hard refusal (P0-4)
// ---------------------------------------------------------------------------

describe("1. a community host never carries a strong class for the whole host or an all-content root", () => {
  it("recognises community hosts label by label, never by substring", () => {
    for (const h of ["forum.project.com", "forums.project.io", "community.project.org", "discuss.project.xyz", "gov.project.org", "governance.project.com", "www.forum.project.com"]) {
      expect(isCommunityHost(h), h).toBe(true);
    }
    for (const h of ["project.com", "docs.project.com", "forumla.project.com", "myforum.project.com", "jito.network", "blog.project.com", "app.project.com"]) {
      expect(isCommunityHost(h), h).toBe(false);
    }
  });

  it("broad scopes are the whole host, the root, and the single-segment all-content roots — case-insensitively; anything below them is not broad", () => {
    for (const p of [null, "/", "/t", "/t/", "/T", "/topic", "/topics", "/thread", "/c", "/p", "/posts", "/d", "/discussions", "/forum", "/latest", "/u", "/users", "/members"]) {
      expect(isBroadCommunityScope(p), String(p)).toBe(true);
    }
    for (const p of ["/proposals", "/t/jip-38-confirm-jito-as-a-token-centric-network", "/c/governance", "/docs", "/tokenomics", "/topical"]) {
      expect(isBroadCommunityScope(p), p).toBe(false);
    }
  });

  it("GOVERNANCE, OFFICIAL_DOCS and OFFICIAL_REPORT are REFUSED on a community host for the whole host and for every all-content root, and the refusal writes nothing", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const forum = `forum.${apex}`;
    for (const prefix of ["/", "/t", "/topics", "/c", "/u"]) {
      const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: forum, pathPrefix: prefix });
      expect(confirmed.ok, prefix).toBe(true);
      if (!confirmed.ok) return;
      const before = await snapshot(p.id);
      for (const cls of ["GOVERNANCE", "OFFICIAL_DOCS", "OFFICIAL_REPORT"]) {
        const r = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: cls });
        expect(r, `${prefix} ${cls}`).toMatchObject({ ok: false, refusal: "COMMUNITY_HOST_BROAD_SCOPE" });
      }
      expect(await snapshot(p.id)).toBe(before);
      // Ownership confirmation itself is not refused — it confers no class.
      // Step it aside (ACTIVE -> DEPRECATED) so the next prefix does not overlap.
      await ctx.db.update(projectMemoryItems).set({ lifecycleState: "DEPRECATED" }).where(eq(projectMemoryItems.id, confirmed.itemId));
    }
    expect((await resolveSourceRoute(ctx.db, p.id, `https://${forum}/t/anything/1`)).routeClass).toBeNull();
  });

  it("a legacy prefix-less community route is a broad scope too", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const [legacy] = await ctx.db.insert(projectMemoryItems).values({ projectId: p.id, kind: "SOURCE_ROUTE", lifecycleState: "OBSERVED", content: { domain: `community.${apex}` } }).returning();
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "CANDIDATE" }).where(eq(projectMemoryItems.id, legacy.id));
    await ctx.db.update(projectMemoryItems).set({ lifecycleState: "ACTIVE" }).where(eq(projectMemoryItems.id, legacy.id));
    expect(await classifySourceRoute(ctx.db, { routeId: legacy.id, routeClass: "OFFICIAL_REPORT" })).toMatchObject({ ok: false, refusal: "COMMUNITY_HOST_BROAD_SCOPE" });
  });

  it("a prefix BELOW an all-content root that the owner reviewed (one topic) may be classified; its siblings stay unclassified", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const forum = `forum.${apex}`;
    const topic = "/t/jip-38-confirm-jito-as-a-token-centric-network";
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: forum, pathPrefix: topic });
    if (!confirmed.ok) throw new Error("fixture");
    expect((await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "GOVERNANCE" })).ok).toBe(true);
    expect((await resolveSourceRoute(ctx.db, p.id, `https://${forum}${topic}/973`)).routeClass).toBe("GOVERNANCE");
    expect((await resolveSourceRoute(ctx.db, p.id, `https://${forum}/t/jto-utility-and-tokenomics/646`)).routeClass).toBeNull();
  });

  it("a NON-community host keeps every class at every scope, /t included (the rule is about community hosts, not a general prefix requirement)", async () => {
    const p = await makeProject(apexHost(), { docs: false });
    const docs = `docs.${apexHost()}`;
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: docs, pathPrefix: "/t" });
    if (!confirmed.ok) throw new Error("fixture");
    expect((await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_REPORT" })).ok).toBe(true);
  });

  it("a NARROWER prefix the owner reviewed may be GOVERNANCE; the rest of the host stays unclassified", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const forum = `forum.${apex}`;
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: forum, pathPrefix: "/proposals" });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const r = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "GOVERNANCE" });
    expect(r.ok).toBe(true);
    expect(await resolveSourceRoute(ctx.db, p.id, `https://${forum}/proposals/jip-1`)).toMatchObject({ officiality: "CONFIRMED", routeClass: "GOVERNANCE" });
    expect((await resolveSourceRoute(ctx.db, p.id, `https://${forum}/t/random-thread/9`)).routeClass).toBeNull();
  });

  it("a non-community host is unaffected: host-wide OFFICIAL_DOCS still classifies (the rule is not a general prefix requirement)", async () => {
    const p = await makeProject(apexHost(), { docs: false });
    const docs = `docs.${apexHost()}`;
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: p.slug, domain: docs, pathPrefix: "/" });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect((await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: "OFFICIAL_DOCS" })).ok).toBe(true);
  });

  it("the predicate refuses owner acts only: the authority resolver and the classifier never read it", () => {
    const src = readFileSync(new URL("../src/server/engine/source-authority.ts", import.meta.url), "utf-8");
    const body = (name: string) => {
      const start = src.indexOf(`export function ${name}(`) >= 0 ? src.indexOf(`export function ${name}(`) : src.indexOf(`export async function ${name}(`);
      const next = src.indexOf("\nexport ", start + 10);
      return src.slice(start, next < 0 ? undefined : next);
    };
    expect(body("resolveSourceClass")).not.toContain("isCommunityHost");
    expect(body("resolveSourceRoute")).not.toContain("isCommunityHost");
  });
});

// ---------------------------------------------------------------------------
// 2. the review queue: ranking, preview facts, non-binding hints
// ---------------------------------------------------------------------------

describe("2. the owner review ranks candidates by existing signals and shows what a human needs", () => {
  it("class hints are literal, single-valued and absent when unclear", () => {
    expect(suggestRouteClassHint("docs.project.com", null)).toEqual({ routeClass: "OFFICIAL_DOCS", basis: 'the word "docs" in the host' });
    expect(suggestRouteClassHint("project.com", "/governance")).toEqual({ routeClass: "GOVERNANCE", basis: 'the word "governance" in the path' });
    expect(suggestRouteClassHint("governance.project.com", null)?.routeClass).toBe("GOVERNANCE");
    expect(suggestRouteClassHint("docs.project.com", "/governance")).toBeNull(); // two suggestions: no hint
    expect(suggestRouteClassHint("forum.project.com", null)).toBeNull(); // a forum suggests nothing
    expect(suggestRouteClassHint("project.com", "/token")).toBeNull();
    expect(suggestRouteClassHint("docs.com", null)).toBeNull(); // the site's own name is not a section
  });

  it("path on a confirmed host first, then a subdomain of one (also for a candidate recorded before the signal existed), then the rest — whatever their volume", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const stranger = `other-${uniq("s").replace(/_/g, "-")}.test`;
    expect((await observe(p.id, `https://${stranger}/a`, "SOURCE_OF_VALUE", 40)).outcome).toBe("OBSERVED");
    expect((await observe(p.id, `https://forum.${apex}/t/fee-switch/1`, "GOVERNANCE_BASIS", 5)).outcome).toBe("OBSERVED");
    expect((await observe(p.id, `https://${apex}/token/`, "MECHANISM_SPEC", 2)).outcome).toBe("OBSERVED");
    // A legacy candidate: recorded before parentConfirmedDomain existed.
    await ctx.db.insert(projectMemoryItems).values({
      projectId: p.id,
      kind: "SOURCE_ROUTE",
      lifecycleState: "OBSERVED",
      content: { domain: `community.${apex}`, observed: { jobId: jobRef(), urls: [`https://community.${apex}/x`], evidenceCount: 1, components: ["RECIPIENT"] } },
    });

    const review = await loadRouteCandidateReview(ctx.db, p.id);
    expect(review.covered).toHaveLength(0);
    expect(review.pending.map((c) => `${c.domain}${c.proposedPrefix ?? ""}`)).toEqual([
      `${apex}/token`,
      `forum.${apex}`,
      `community.${apex}`,
      stranger,
    ]);
    const [path, forum, legacy, other] = review.pending;
    expect(path.signals).toEqual(["PATH_ON_CONFIRMED_HOST"]);
    expect(forum.signals).toEqual(["SUBDOMAIN_OF_CONFIRMED_HOST"]);
    expect(forum.parentConfirmedDomain).toBe(apex);
    expect(forum.communityHost).toBe(true);
    expect(legacy.signals).toEqual(["SUBDOMAIN_OF_CONFIRMED_HOST"]);
    expect(legacy.parentConfirmedDomain).toBe(apex);
    expect(other.signals).toEqual([]);
    expect(other.evidenceCount).toBe(40);
    expect(path.communityHost).toBe(false);
  });

  it("representative urls are bounded and come from the observation itself", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    for (const n of [1, 2, 3, 4, 5]) await observe(p.id, `https://${apex}/learn/page-${n}`, "MECHANISM_SPEC", 1);
    const [c] = (await loadRouteCandidateReview(ctx.db, p.id)).pending;
    expect(c.proposedPrefix).toBe("/learn");
    expect(c.evidenceCount).toBe(5);
    expect(c.representativeUrls).toHaveLength(MAX_REVIEW_URLS);
    expect(c.representativeUrls[0]).toBe(`https://${apex}/learn/page-1`);
  });

  it("among equal ownership signals, a candidate read by a CRITICAL component of its job ranks first", async () => {
    const p = await makeProject(apexHost(), { docs: false });
    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(
      ctx.db,
      ctx.boss,
      {
        userId: user.id,
        topicId: topic.id,
        projectId: p.id,
        originalQuestion: "does protocol revenue reach the token?",
        normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
        normalizedTaskHash: uniq("hash"),
        idempotencyKey: uniq("idem"),
        entitlement: coreEntitlement(),
        demoLifetimeProofLimit: 1000,
      },
      { skipEnqueue: true },
    );
    await runMemoryPlanningStage(ctx.db, job.id);
    await ctx.db.insert(interpretations).values({
      userId: user.id,
      researchJobId: job.id,
      originalQuestion: "does protocol revenue reach the token?",
      status: "READY",
      attempt: 1,
      result: { normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN", task_type: "PROJECT_MECHANISM", route: "DEEP_RESEARCH", status: "READY" },
    });
    const { view } = await loadJobContractView(ctx.db, job.id);
    const names = view.workQueue.map((q) => q.component);
    const critical = (await loadAcquisitionPlan(ctx.db, job.id, names[0], p.id)).criticalComponents;
    const crit = names.find((n) => critical.has(n));
    const nonCrit = names.find((n) => !critical.has(n));
    expect(crit, "fixture needs a critical component").toBeDefined();
    expect(nonCrit, "fixture needs a non-critical component").toBeDefined();

    const a = `a-${uniq("c").replace(/_/g, "-")}.test`;
    const b = `b-${uniq("c").replace(/_/g, "-")}.test`;
    await observe(p.id, `https://${a}/x`, nonCrit!, 9, job.id);
    await observe(p.id, `https://${b}/x`, crit!, 1, job.id);
    const review = await loadRouteCandidateReview(ctx.db, p.id);
    expect(review.pending.map((c) => c.domain)).toEqual([b, a]);
    expect(review.pending[0].criticalComponents).toEqual([crit]);
    expect(review.pending[1].criticalComponents).toEqual([]);
  });

  it("the review is READ-ONLY: nothing about any route row changes", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    await observe(p.id, `https://forum.${apex}/t/x/1`, "GOVERNANCE_BASIS", 3);
    const before = await snapshot(p.id);
    await loadRouteCandidateReview(ctx.db, p.id);
    expect(await snapshot(p.id)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 3. reject: OBSERVED -> DEPRECATED, exactly that host / host + prefix
// ---------------------------------------------------------------------------

describe("3. rejecting a candidate stops that exact proposal and grants nothing", () => {
  it("a rejected HOST is never re-proposed, and stays CLAIMED", async () => {
    const p = await makeProject(apexHost());
    const host = `x-${uniq("r").replace(/_/g, "-")}.test`;
    const first = await observe(p.id, `https://${host}/a`, "SOURCE_OF_VALUE", 2);
    expect(first.outcome).toBe("OBSERVED");
    if (first.outcome !== "OBSERVED") return;
    const r = await rejectRouteCandidate(ctx.db, { projectSlug: p.slug, candidateId: first.itemId });
    expect(r).toMatchObject({ ok: true, domain: host, proposedPrefix: null });
    const [row] = (await routeRows(p.id)).filter((x) => x.id === first.itemId);
    expect(row.lifecycleState).toBe("DEPRECATED");
    expect(await observe(p.id, `https://${host}/b`, "SOURCE_OF_VALUE", 2)).toMatchObject({ outcome: "SKIPPED", reason: "EXISTING_ROUTE_ROW" });
    expect((await resolveSourceRoute(ctx.db, p.id, `https://${host}/a`)).officiality).toBe("CLAIMED");
    expect((await loadRouteCandidateReview(ctx.db, p.id)).pending).toHaveLength(0);
  });

  it("a rejected PATH proposal suppresses only itself — other paths on the same confirmed host are still proposed", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const blog = await observe(p.id, `https://${apex}/blog/launch`, "MECHANISM_SPEC", 1);
    expect(blog.outcome).toBe("OBSERVED");
    if (blog.outcome !== "OBSERVED") return;
    expect((await rejectRouteCandidate(ctx.db, { projectSlug: p.slug, candidateId: blog.itemId })).ok).toBe(true);
    expect(await observe(p.id, `https://${apex}/blog/other`, "MECHANISM_SPEC", 1)).toMatchObject({ outcome: "SKIPPED", reason: "EXISTING_ROUTE_ROW" });
    expect((await observe(p.id, `https://${apex}/token/`, "MECHANISM_SPEC", 1)).outcome).toBe("OBSERVED");
    const pending = (await loadRouteCandidateReview(ctx.db, p.id)).pending;
    expect(pending.map((c) => c.proposedPrefix)).toEqual(["/token"]);
    // The human's /docs route is untouched.
    expect(await resolveSourceRoute(ctx.db, p.id, `https://${apex}/docs/x`)).toMatchObject({ officiality: "CONFIRMED", routeClass: "OFFICIAL_DOCS" });
  });

  it("refuses anything that is not this project's OBSERVED engine candidate", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const other = await makeProject(apexHost());
    const cand = await observe(p.id, `https://z-${uniq("q").replace(/_/g, "-")}.test/a`, "SOURCE_OF_VALUE", 1);
    if (cand.outcome !== "OBSERVED") throw new Error("fixture");
    const human = (await routeRows(p.id)).find((r) => r.lifecycleState === "ACTIVE")!;
    expect(await rejectRouteCandidate(ctx.db, { projectSlug: p.slug, candidateId: human.id })).toMatchObject({ ok: false, refusal: "NOT_OBSERVED" });
    expect(await rejectRouteCandidate(ctx.db, { projectSlug: other.slug, candidateId: cand.itemId })).toMatchObject({ ok: false, refusal: "WRONG_PROJECT" });
    expect(await rejectRouteCandidate(ctx.db, { projectSlug: p.slug, candidateId: "00000000-0000-0000-0000-000000000000" })).toMatchObject({ ok: false, refusal: "CANDIDATE_NOT_FOUND" });
    expect(await rejectRouteCandidate(ctx.db, { projectSlug: "no-such-project", candidateId: cand.itemId })).toMatchObject({ ok: false, refusal: "UNKNOWN_PROJECT" });
    expect((await rejectRouteCandidate(ctx.db, { projectSlug: p.slug, candidateId: cand.itemId })).ok).toBe(true);
    expect(await rejectRouteCandidate(ctx.db, { projectSlug: p.slug, candidateId: cand.itemId })).toMatchObject({ ok: false, refusal: "NOT_OBSERVED" });
  });
});

// ---------------------------------------------------------------------------
// 4. the combined owner decision: previewed, explicit, two decisions, atomic
// ---------------------------------------------------------------------------

describe("4. confirm + classify in one owner workflow keeps two explicit decisions", () => {
  it("the preview is read-only and shows the candidate's provenance and its NON-BINDING hint", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    await observe(p.id, `https://governance.${apex}/proposals/jip-1`, "GOVERNANCE_BASIS", 4);
    const before = await snapshot(p.id);
    const preview = await previewOwnerRouteDecision(ctx.db, { projectSlug: p.slug, domain: `governance.${apex}`, pathPrefix: "/proposals", routeClass: "GOVERNANCE" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.current.officiality).toBe("CLAIMED");
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0].representativeUrls).toEqual([`https://governance.${apex}/proposals/jip-1`]);
    expect(preview.candidates[0].signals).toEqual(["SUBDOMAIN_OF_CONFIRMED_HOST"]);
    expect(preview.candidates[0].classHint?.routeClass).toBe("GOVERNANCE");
    expect(await snapshot(p.id)).toBe(before);
  });

  it("applies BOTH decisions atomically: an ownership row superseded by its classified replacement, scoped to the prefix only", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const forum = `forum.${apex}`;
    await observe(p.id, `https://${forum}/proposals/jip-1`, "GOVERNANCE_BASIS", 4);
    const r = await decideOwnerRoute(ctx.db, { projectSlug: p.slug, domain: forum, pathPrefix: "/proposals", routeClass: "GOVERNANCE" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.before.officiality).toBe("CLAIMED");
    expect(r.after).toMatchObject({ officiality: "CONFIRMED", routeClass: "GOVERNANCE", matchedPathPrefix: "/proposals" });
    const rows = await routeRows(p.id);
    const ownership = rows.find((x) => x.id === r.confirmedItemId)!;
    const classified = rows.find((x) => x.id === r.classifiedItemId)!;
    expect(ownership.lifecycleState).toBe("SUPERSEDED");
    expect(ownership.supersededBy).toBe(classified.id);
    expect(ownership.content).toEqual({ domain: forum, pathPrefix: "/proposals" });
    expect(classified.lifecycleState).toBe("ACTIVE");
    expect(classified.content).toEqual({ domain: forum, pathPrefix: "/proposals", routeClass: "GOVERNANCE" });
    // Outside the prefix: owned, never classified.
    expect(await resolveSourceRoute(ctx.db, p.id, `https://${forum}/t/thread/2`)).toMatchObject({ officiality: "CONFIRMED", routeClass: null });
    // The engine's candidate is now covered, not pending — and was never itself promoted.
    const review = await loadRouteCandidateReview(ctx.db, p.id);
    expect(review.pending.map((c) => c.domain)).not.toContain(forum);
    expect(review.covered.map((c) => c.domain)).toContain(forum);
    expect(rows.filter((x) => (x.content as { observed?: unknown }).observed).every((x) => x.lifecycleState === "OBSERVED")).toBe(true);
  });

  it("a strong class on a community host's whole host or all-content root is refused at preview AND at apply, writing nothing", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const before = await snapshot(p.id);
    for (const pathPrefix of ["/", "/t", "/topics"]) {
      for (const routeClass of ["GOVERNANCE", "OFFICIAL_DOCS", "OFFICIAL_REPORT"]) {
        const input = { projectSlug: p.slug, domain: `forum.${apex}`, pathPrefix, routeClass };
        expect(await previewOwnerRouteDecision(ctx.db, input), `${pathPrefix} ${routeClass}`).toMatchObject({ ok: false, refusal: "COMMUNITY_HOST_BROAD_SCOPE" });
        expect(await decideOwnerRoute(ctx.db, input), `${pathPrefix} ${routeClass}`).toMatchObject({ ok: false, refusal: "COMMUNITY_HOST_BROAD_SCOPE" });
      }
    }
    expect(await snapshot(p.id)).toBe(before);
  });

  it("an invalid class, or a confirmation refusal, writes nothing — the two decisions never half-apply", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const before = await snapshot(p.id);
    expect(await decideOwnerRoute(ctx.db, { projectSlug: p.slug, domain: apex, pathPrefix: "/token", routeClass: "OFFICIAL" })).toMatchObject({ ok: false, refusal: "UNSUPPORTED_ROUTE_CLASS" });
    // /docs/fees overlaps the ACTIVE /docs route: the confirmation refuses.
    expect(await decideOwnerRoute(ctx.db, { projectSlug: p.slug, domain: apex, pathPrefix: "/docs/fees", routeClass: "OFFICIAL_DOCS" })).toMatchObject({ ok: false, refusal: "OVERLAPPING_ACTIVE_PREFIX" });
    expect(await snapshot(p.id)).toBe(before);
  });

  it("nothing but the owner's typed class reaches a mutation: no hint, label or parent is ever read to decide", () => {
    const mod = readFileSync(new URL("../src/server/memory/source-route-owner-decision.ts", import.meta.url), "utf-8");
    const code = mod.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toContain("classHint");
    expect(code).not.toContain("suggestRouteClassHint");
    expect(code).not.toContain("parentConfirmedDomain");
    expect(code).toContain("classifySourceRoute(tx, { routeId: confirmed.itemId, routeClass })");
    for (const f of ["../src/server/memory/source-route-confirmation.ts", "../src/server/memory/source-route-classification.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf-8");
      expect(src, f).not.toContain("source-route-candidate-review");
      expect(src, f).not.toContain("classHint");
    }
    const script = readFileSync(new URL("../scripts/decide-source-route.ts", import.meta.url), "utf-8");
    expect(script).toContain("routeClass: args.class");
    // The mutation is reached only after an explicit --confirm=yes.
    expect(script.indexOf('args.confirm !== "yes"')).toBeGreaterThan(0);
    expect(script.indexOf('args.confirm !== "yes"')).toBeLessThan(script.indexOf("decideOwnerRoute(db"));
    const reject = readFileSync(new URL("../scripts/reject-route-candidate.ts", import.meta.url), "utf-8");
    expect(reject.indexOf('args.confirm !== "yes"')).toBeLessThan(reject.indexOf("rejectRouteCandidate(db"));
  });
});

// ---------------------------------------------------------------------------
// 5. AUTHORITY_PENDING_OWNER_REVIEW: coverage, never a fact about the project
// ---------------------------------------------------------------------------

function cov(overrides: Partial<ComponentCoverageInput> = {}): ComponentCoverageInput {
  return {
    step: 3,
    component: "GOVERNANCE_BASIS",
    inWorkQueue: true,
    establishingClasses: ["GOVERNANCE"],
    critical: true,
    result: { status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] },
    attempts: [{ attemptNumber: 1, status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT" }],
    inspectedClasses: ["GOVERNANCE"],
    remainingPaths: [],
    recoverySpent: false,
    ...overrides,
  };
}

describe("5. a page whose authority awaits the owner keeps the research incomplete — it is never 'checked and not established'", () => {
  it("absent the flag, nothing changes (the D-176 classes stand)", () => {
    expect(classifyComponentCoverage(cov()).coverage).toBe("CHECKED_AND_NOT_ESTABLISHED");
  });

  it("an admissible page read AND a pending one -> INCOMPLETE_COVERAGE with the reason, not CHECKED_AND_NOT_ESTABLISHED", () => {
    const c = classifyComponentCoverage(cov({ authorityPendingInspected: true }));
    expect(c.coverage).toBe("INCOMPLETE_COVERAGE");
    expect(c.reasons).toEqual(["AUTHORITY_PENDING_OWNER_REVIEW"]);
  });

  it("only pending pages were read -> INCOMPLETE_COVERAGE (not 'never inspected', which would hide the open decision)", () => {
    const c = classifyComponentCoverage(cov({ inspectedClasses: ["SOCIAL"], authorityPendingInspected: true }));
    expect(c.coverage).toBe("INCOMPLETE_COVERAGE");
    expect(c.reasons).toEqual(["AUTHORITY_PENDING_OWNER_REVIEW"]);
  });

  it("an operational block keeps BLOCKED and names the pending decision beside it", () => {
    const c = classifyComponentCoverage(cov({ inspectedClasses: ["SOCIAL"], attempts: [{ attemptNumber: 1, status: "SKIPPED", reason: "NO_ADMISSIBLE_ROUTE; x" }], authorityPendingInspected: true }));
    expect(c.coverage).toBe("BLOCKED");
    expect(c.reasons).toEqual(["AUTHORITY_PENDING_OWNER_REVIEW", "NO_ADMISSIBLE_ROUTE"]);
  });

  it("a PARTIAL result stays a result with the gap named; SUPPORTED and CONTRADICTED are settled and carry no such reason", () => {
    const partial = classifyComponentCoverage(cov({ result: { status: "PARTIALLY_SUPPORTED", reasonCodes: [] }, authorityPendingInspected: true }));
    expect(partial.coverage).toBe("COMPLETE_WITH_RESULT");
    expect(partial.reasons).toEqual(["AUTHORITY_PENDING_OWNER_REVIEW", "RESULT_PARTIALLY_SUPPORTED"]);
    for (const status of ["SUPPORTED", "CONTRADICTED"]) {
      expect(classifyComponentCoverage(cov({ result: { status, reasonCodes: [] }, authorityPendingInspected: true })).reasons).not.toContain("AUTHORITY_PENDING_OWNER_REVIEW");
    }
  });

  it("the job projection becomes COVERAGE_LIMITED and names the components — the record carries no verdict", () => {
    const record = deriveResearchCoverage({
      intent: "PROTOCOL_REVENUE_TO_TOKEN",
      jobState: "SUCCEEDED",
      terminationReason: "WORK_QUEUE_EXHAUSTED",
      components: [cov({ authorityPendingInspected: true }), cov({ step: 3, component: "MECHANISM_SPEC", establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"], inspectedClasses: ["OFFICIAL_DOCS"] })],
    });
    expect(record.overall).toBe("COVERAGE_LIMITED");
    expect(record.findings.find((f) => f.code === "AUTHORITY_PENDING_OWNER_REVIEW")!.components).toEqual(["GOVERNANCE_BASIS"]);
    expect(JSON.stringify(record)).not.toMatch(/"verdict"|"confidence"/);
  });

  it("isAuthorityPending: only an open owner decision on a host a route class could ever apply to", () => {
    const none = { officiality: "CLAIMED", routeClass: null, matchedPathPrefix: null };
    const hostCand = [{ domain: "forum.p.test", prefix: null }];
    const pathCand = [{ domain: "p.test", prefix: "/token" }];
    expect(isAuthorityPending("https://forum.p.test/t/1", none, hostCand)).toBe(true);
    expect(isAuthorityPending("https://other.test/t/1", none, hostCand)).toBe(false);
    const confirmedNoPrefix = { officiality: "CONFIRMED", routeClass: null, matchedPathPrefix: null };
    expect(isAuthorityPending("https://p.test/token/x", confirmedNoPrefix, pathCand)).toBe(true);
    expect(isAuthorityPending("https://p.test/blog/x", confirmedNoPrefix, pathCand)).toBe(false);
    // A host candidate whose host a human has since confirmed is not that decision any more.
    expect(isAuthorityPending("https://forum.p.test/t/1", confirmedNoPrefix, hostCand)).toBe(false);
    // Confirmed at a prefix, class not yet decided.
    expect(isAuthorityPending("https://p.test/learn/x", { officiality: "CONFIRMED", routeClass: null, matchedPathPrefix: "/learn" }, [])).toBe(true);
    // Classified: decided.
    expect(isAuthorityPending("https://p.test/docs/x", { officiality: "CONFIRMED", routeClass: "OFFICIAL_DOCS", matchedPathPrefix: "/docs" }, pathCand)).toBe(false);
    // A publicly recognised platform can never take a route class.
    expect(isAuthorityPending("https://x.com/p/status/1", none, [{ domain: "x.com", prefix: null }])).toBe(false);
  });

  it("loader: a component that read a page on an OBSERVED candidate is pending; after the owner rejects it, it no longer is", async () => {
    const apex = apexHost();
    const p = await makeProject(apex);
    const forum = `forum.${apex}`;
    const cand = await observe(p.id, `https://${forum}/t/fee-switch/1`, "GOVERNANCE_BASIS", 3);
    if (cand.outcome !== "OBSERVED") throw new Error("fixture");

    const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(
      ctx.db,
      ctx.boss,
      {
        userId: user.id,
        topicId: topic.id,
        projectId: p.id,
        originalQuestion: "does protocol revenue reach the token?",
        normalizedTask: { project_slug: "x", project_slugs: ["x"], task: "x" },
        normalizedTaskHash: uniq("hash"),
        idempotencyKey: uniq("idem"),
        entitlement: coreEntitlement(),
        demoLifetimeProofLimit: 1000,
      },
      { skipEnqueue: true },
    );
    await runMemoryPlanningStage(ctx.db, job.id);
    await ctx.db.insert(interpretations).values({
      userId: user.id,
      researchJobId: job.id,
      originalQuestion: "does protocol revenue reach the token?",
      status: "READY",
      attempt: 1,
      result: { normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN", task_type: "PROJECT_MECHANISM", route: "DEEP_RESEARCH", status: "READY" },
    });
    const { view } = await loadJobContractView(ctx.db, job.id);
    const queue = view.workQueue;
    const { recordTraceEvent } = await import("../src/server/engine/trace-store");
    // The first component reads the forum thread; the second reads the
    // classified /docs page. Neither establishes anything.
    const executor: WorkExecutor = {
      async execute(item, c) {
        const i = queue.findIndex((q) => q.component === item.component);
        const targetRef = i === 0 ? `https://${forum}/t/fee-switch/1` : `https://${apex}/docs/fees`;
        await recordTraceEvent(ctx.db, { researchJobId: c.jobId, operationType: "EXTRACT_ATTEMPTED", providerKind: "EXTRACT", providerName: "fixture", patternStep: item.step, component: item.component, targetRef, status: "OK" });
        return { status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT" };
      },
    };
    await runResearchController({ db: ctx.db, jobId: job.id, view, executor, now: new Date(), maxAttemptsThisRun: 2, reconcile: reconcileAndPersistComponent });

    const [first, second] = queue.map((q) => q.component);
    const firstAdmitsRouteClass = (await loadAcquisitionPlan(ctx.db, job.id, first, p.id)).establishingClasses.some((c) =>
      ["OFFICIAL_DOCS", "GOVERNANCE", "OFFICIAL_REPORT"].includes(c),
    );
    // The fixture is only meaningful if the first component could take a
    // route class at all — pinned, so the test cannot pass vacuously.
    expect(firstAdmitsRouteClass).toBe(true);
    const coverage = await loadResearchCoverage(ctx.db, job.id);
    const byName = Object.fromEntries(coverage.components.map((c) => [c.component, c]));
    expect(byName[first].reasons).toContain("AUTHORITY_PENDING_OWNER_REVIEW");
    expect(byName[first].coverage).not.toBe("CHECKED_AND_NOT_ESTABLISHED");
    expect(byName[second].reasons).not.toContain("AUTHORITY_PENDING_OWNER_REVIEW");
    expect(coverage.overall).toBe("COVERAGE_LIMITED");
    expect(coverage.findings.find((f) => f.code === "AUTHORITY_PENDING_OWNER_REVIEW")!.components).toEqual([first]);

    // The owner rejects the candidate: the decision is no longer open.
    expect((await rejectRouteCandidate(ctx.db, { projectSlug: p.slug, candidateId: cand.itemId })).ok).toBe(true);
    const after = await loadResearchCoverage(ctx.db, job.id);
    expect(after.components.find((c) => c.component === first)!.reasons).not.toContain("AUTHORITY_PENDING_OWNER_REVIEW");
  });
});

// ---------------------------------------------------------------------------
// 6. structural: the workflow acquires nothing and writes no authority itself
// ---------------------------------------------------------------------------

describe("6. the owner workflow acquires nothing and grants nothing on its own", () => {
  const files = [
    "../src/server/memory/source-route-candidate-review.ts",
    "../src/server/memory/source-route-owner-decision.ts",
    "../scripts/review-route-candidates.ts",
    "../scripts/reject-route-candidate.ts",
    "../scripts/decide-source-route.ts",
  ];
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf-8");

  it("no fetch, renderer, search, RPC or model in any of them", () => {
    for (const f of files) {
      const src = read(f);
      for (const banned of ["content-fetcher", "rendered-docs", "search-gateway", "query-proposer", "evidence-extractor", "anthropic", "fetch(", "node:http", "undici", "onchain-"]) {
        expect(src, `${f} references ${banned}`).not.toContain(banned);
      }
    }
  });

  it("the review module writes no class, no prefix and no ACTIVE row; its only write is OBSERVED -> DEPRECATED", () => {
    const src = read("../src/server/memory/source-route-candidate-review.ts");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toContain('lifecycleState: "ACTIVE"');
    expect(code).not.toContain(".insert(");
    expect(code.match(/\.update\(/g)).toHaveLength(1);
    expect(code).toContain('.set({ lifecycleState: "DEPRECATED" })');
    expect(code).not.toContain("promoteProjectMemoryItem");
  });

  it("the review script is read-only", () => {
    const code = read("../scripts/review-route-candidates.ts");
    for (const banned of ["rejectRouteCandidate", "decideOwnerRoute", "confirmSourceRoute", "classifySourceRoute", ".insert(", ".update("]) {
      expect(code).not.toContain(banned);
    }
  });
});
