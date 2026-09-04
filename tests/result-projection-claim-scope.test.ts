import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as jobDetailGET } from "../app/api/research-jobs/[id]/route";
import { createSession } from "../src/server/auth/session";
import {
  evidence,
  projects,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { __resetRuntime } from "../src/server/runtime";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// CLAIM-SCOPED RESULT PROJECTION.
//
// A real owner run produced NET_EFFECT = INSUFFICIENT_EVIDENCE with zero
// supporting and zero excluded evidence, and the UI still displayed two
// GOVERNANCE_BASIS rows — excluded as CLASS_NOT_ADMISSIBLE, from a
// different component — as that finding's proof. Every engine layer was
// correct; the result endpoint returned `SELECT * WHERE researchJobId`
// and the view rendered it under the finding.
//
// These tests are deliberately generic: no project, token, chain or
// component is special-cased, and the defect shape is reproduced with
// synthetic components so the guarantee holds for any future question.

const ORIGIN = "https://app.atlas.test";
let ctx: TestContext;

beforeAll(async () => {
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.ALLOWED_ORIGINS = ORIGIN;
  ctx = await setupTestDatabase();
  await __resetRuntime();
});

afterAll(async () => {
  await __resetRuntime();
  await ctx.close();
});

interface Fixture {
  jobId: string;
  cookie: string;
}

async function makeJob(): Promise<Fixture> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const slug = uniq("proj");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Projection Test Project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "where do the bought-back tokens actually go?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  const { rawToken } = await createSession(ctx.db, user.id);
  return { jobId: job.id, cookie: `atlas_session=${rawToken}` };
}

async function makeEvidence(
  jobId: string,
  patternStep: number,
  component: string,
  summary: string,
): Promise<string> {
  const url = `https://example.com/${uniq("doc")}`;
  const [src] = await ctx.db
    .insert(sources)
    .values({ url, urlHash: `sha256:${url}`, sourceType: "OFFICIAL_DOCS" })
    .returning({ id: sources.id });
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      researchJobId: jobId,
      proofId: null,
      sourceId: src.id,
      patternStep,
      component,
      relationship: "SUPPORTS",
      directness: "DIRECT",
      fragment: `fragment for ${summary}`,
      summary,
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
      fetchedAt: new Date(),
      publishedAt: new Date(),
      doesNotProve: "does not prove everything",
      retrievedUrl: url,
      contentHash: uniq("hash"),
      extractionUnitKey: uniq("unit"),
    })
    .returning({ id: evidence.id });
  return row.id;
}

async function makeComponentResult(
  jobId: string,
  patternStep: number,
  component: string,
  opts: {
    status?: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "INSUFFICIENT_EVIDENCE" | "CONTRADICTED";
    supporting?: string[];
    contradicting?: string[];
    excluded?: { evidenceId: string; reason: string }[];
  } = {},
): Promise<void> {
  await ctx.db.insert(researchComponentResults).values({
    researchJobId: jobId,
    patternStep,
    component,
    status: opts.status ?? "INSUFFICIENT_EVIDENCE",
    reasonCodes: [],
    supportingEvidenceIds: opts.supporting ?? [],
    contradictingEvidenceIds: opts.contradicting ?? [],
    excludedEvidence: opts.excluded ?? [],
    tokenStateMentions: [],
    requiresFreshEvidence: false,
  });
}

async function makeClaim(
  jobId: string,
  opts: {
    status?: string;
    componentResultKeys?: { step: number; component: string }[];
    evidenceIds?: string[];
    blockingGaps?: { afterStep: number; component: string }[];
  },
): Promise<void> {
  await ctx.db.insert(researchClaimSupport).values({
    researchJobId: jobId,
    patternVersion: 1,
    requirementSetVersion: 1,
    intent: "BURN_OR_SUPPLY_EFFECT",
    status: opts.status ?? "INSUFFICIENT_EVIDENCE",
    reasonCodes: [],
    requirementResults: [
      {
        requirementId: "R-1",
        status: "UNSATISFIED",
        optionality: "REQUIRED",
        reasonCodes: [],
        provenance: {
          flowIds: [],
          evidenceIds: opts.evidenceIds ?? [],
          componentResultKeys: opts.componentResultKeys ?? [],
        },
        blockingGaps: (opts.blockingGaps ?? []).map((g) => ({
          kind: "NET_EFFECT_UNRESOLVED",
          flowId: "f1",
          afterStep: g.afterStep,
          component: g.component,
        })),
        matchedFlowIds: [],
      },
    ] as never,
    contextGaps: [],
  });
}

async function fetchDetail(f: Fixture) {
  const res = await jobDetailGET(
    new Request(`http://localhost/api/research-jobs/${f.jobId}`, {
      method: "GET",
      headers: { cookie: f.cookie, origin: ORIGIN },
    }),
    { params: Promise.resolve({ id: f.jobId }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    finding: {
      componentKeys: { step: number; component: string }[];
      supporting: { id: string; summary: string | null }[];
      contradicting: { id: string }[];
      excluded: { id: string; exclusionReason: string }[];
    };
    components: {
      patternStep: number;
      component: string;
      supportingEvidenceIds: string[];
      excludedEvidence: { evidenceId: string; reason: string }[];
    }[];
    evidence: {
      id: string;
      component: string | null;
      links: { component: string; role: string; exclusionReason: string | null }[];
    }[];
    execution: { attemptedSteps: number; attemptedComponents: number };
    mechanism: { flows: unknown[] } | null;
  };
}

describe("result projection — evidence is scoped to the displayed claim", () => {
  it("A. the exact live defect: a claim with no evidence does not borrow another component's", async () => {
    // NET_EFFECT is the finding and established nothing. A DIFFERENT
    // component (GOVERNANCE_BASIS) holds the job's only evidence, itself
    // excluded. Previously both rows rendered under the finding.
    const f = await makeJob();
    const govEvidenceA = await makeEvidence(f.jobId, 3, "GOVERNANCE_BASIS", "governance functionality");
    const govEvidenceB = await makeEvidence(f.jobId, 3, "GOVERNANCE_BASIS", "gamified voting rights");
    await makeComponentResult(f.jobId, 3, "GOVERNANCE_BASIS", {
      excluded: [
        { evidenceId: govEvidenceA, reason: "CLASS_NOT_ADMISSIBLE" },
        { evidenceId: govEvidenceB, reason: "CLASS_NOT_ADMISSIBLE" },
      ],
    });
    await makeComponentResult(f.jobId, 7, "NET_EFFECT", {});
    await makeClaim(f.jobId, { blockingGaps: [{ afterStep: 7, component: "NET_EFFECT" }] });

    const detail = await fetchDetail(f);

    expect(detail.finding.supporting).toEqual([]);
    expect(detail.finding.excluded).toEqual([]);
    expect(detail.finding.contradicting).toEqual([]);
    // Scoped to NET_EFFECT only — governance is not part of this finding.
    expect(detail.finding.componentKeys).toEqual([{ step: 7, component: "NET_EFFECT" }]);
    // The governance rows still EXIST on the job (provenance preserved),
    // they are simply not this finding's proof.
    const allIds = detail.evidence.map((e) => e.id);
    expect(allIds).toContain(govEvidenceA);
    expect(allIds).toContain(govEvidenceB);
  });

  it("B. only the claim's own evidence renders, not unrelated evidence from the same job", async () => {
    const f = await makeJob();
    const relevant = await makeEvidence(f.jobId, 7, "NET_EFFECT", "supply decreased");
    const unrelated = await makeEvidence(f.jobId, 1, "SOURCE_OF_VALUE", "fees exist");
    await makeComponentResult(f.jobId, 7, "NET_EFFECT", {
      status: "SUPPORTED",
      supporting: [relevant],
    });
    await makeComponentResult(f.jobId, 1, "SOURCE_OF_VALUE", {
      status: "SUPPORTED",
      supporting: [unrelated],
    });
    await makeClaim(f.jobId, {
      status: "SUPPORTED",
      componentResultKeys: [{ step: 7, component: "NET_EFFECT" }],
    });

    const detail = await fetchDetail(f);

    expect(detail.finding.supporting.map((e) => e.id)).toEqual([relevant]);
    expect(detail.finding.supporting.map((e) => e.id)).not.toContain(unrelated);
  });

  it("C. excluded evidence can never render as supporting proof, even for the claim's own component", async () => {
    const f = await makeJob();
    const admitted = await makeEvidence(f.jobId, 7, "NET_EFFECT", "admitted row");
    const refused = await makeEvidence(f.jobId, 7, "NET_EFFECT", "refused row");
    // Deliberately hostile input: the same id appears in BOTH sets, which
    // S5 never produces. The projection must still refuse to promote it.
    await makeComponentResult(f.jobId, 7, "NET_EFFECT", {
      supporting: [admitted, refused],
      excluded: [{ evidenceId: refused, reason: "ENTITY_NOT_CONFIRMED" }],
    });
    await makeClaim(f.jobId, { componentResultKeys: [{ step: 7, component: "NET_EFFECT" }] });

    const detail = await fetchDetail(f);

    expect(detail.finding.supporting.map((e) => e.id)).toEqual([admitted]);
    expect(detail.finding.supporting.map((e) => e.id)).not.toContain(refused);
    // Surfaced only in its own labelled bucket, carrying its reason.
    expect(detail.finding.excluded.map((e) => e.id)).toEqual([refused]);
    expect(detail.finding.excluded[0].exclusionReason).toBe("ENTITY_NOT_CONFIRMED");
  });

  it("D. a claim with no establishing evidence says so honestly instead of borrowing any", async () => {
    const f = await makeJob();
    // The job is FULL of admitted, non-excluded evidence — just none of it
    // belonging to the component the finding rests on.
    const other1 = await makeEvidence(f.jobId, 1, "SOURCE_OF_VALUE", "unrelated 1");
    const other2 = await makeEvidence(f.jobId, 2, "FLOW_PATH", "unrelated 2");
    await makeComponentResult(f.jobId, 1, "SOURCE_OF_VALUE", {
      status: "SUPPORTED",
      supporting: [other1],
    });
    await makeComponentResult(f.jobId, 2, "FLOW_PATH", { status: "SUPPORTED", supporting: [other2] });
    await makeComponentResult(f.jobId, 7, "NET_EFFECT", {});
    await makeClaim(f.jobId, { blockingGaps: [{ afterStep: 7, component: "NET_EFFECT" }] });

    const detail = await fetchDetail(f);

    expect(detail.finding.supporting).toEqual([]);
    expect(detail.evidence.length).toBe(2); // the job really does hold evidence
  });

  it("E. step count reflects attempted Pattern steps, not mechanism branch count", async () => {
    const f = await makeJob();
    for (const [step, component] of [
      [1, "SOURCE_OF_VALUE"],
      [2, "FLOW_PATH"],
      [3, "MECHANISM_SPEC"],
      [3, "GOVERNANCE_BASIS"],
      [4, "EXECUTION_EVIDENCE"],
      [5, "CURRENT_STATE"],
      [6, "DESTINATION"],
      [6, "RECIPIENT"],
      [7, "NET_EFFECT"],
      [8, "DURABILITY_BASIS"],
    ] as [number, string][]) {
      await ctx.db.insert(researchAttempts).values({
        researchJobId: f.jobId,
        patternStep: step,
        component,
        attemptNumber: 1,
        status: "FAILED",
      });
    }
    await makeClaim(f.jobId, {});

    const detail = await fetchDetail(f);

    // 8 distinct steps / 10 component attempts — the live job reported
    // "1 step traced" here because it read mechanism.flows.length.
    expect(detail.execution.attemptedSteps).toBe(8);
    expect(detail.execution.attemptedComponents).toBe(10);
    const flowCount = detail.mechanism?.flows.length ?? 0;
    expect(detail.execution.attemptedSteps).not.toBe(flowCount);
  });

  it("F. component ownership survives DB → API: role and exclusion reason are explicit, not inferred", async () => {
    const f = await makeJob();
    const sup = await makeEvidence(f.jobId, 7, "NET_EFFECT", "supporting row");
    const con = await makeEvidence(f.jobId, 7, "NET_EFFECT", "contradicting row");
    const exc = await makeEvidence(f.jobId, 3, "GOVERNANCE_BASIS", "excluded row");
    await makeComponentResult(f.jobId, 7, "NET_EFFECT", {
      supporting: [sup],
      contradicting: [con],
    });
    await makeComponentResult(f.jobId, 3, "GOVERNANCE_BASIS", {
      excluded: [{ evidenceId: exc, reason: "CLASS_NOT_ADMISSIBLE" }],
    });
    await makeClaim(f.jobId, { componentResultKeys: [{ step: 7, component: "NET_EFFECT" }] });

    const detail = await fetchDetail(f);
    const linkFor = (id: string) => detail.evidence.find((e) => e.id === id)!.links[0];

    expect(linkFor(sup)).toMatchObject({ component: "NET_EFFECT", role: "SUPPORTING" });
    expect(linkFor(con)).toMatchObject({ component: "NET_EFFECT", role: "CONTRADICTING" });
    expect(linkFor(exc)).toMatchObject({
      component: "GOVERNANCE_BASIS",
      role: "EXCLUDED",
      exclusionReason: "CLASS_NOT_ADMISSIBLE",
    });
    // The per-component breakdown is preserved too, so the client never
    // has to reconstruct ownership from text or step numbers.
    const net = detail.components.find((c) => c.component === "NET_EFFECT")!;
    expect(net.supportingEvidenceIds).toEqual([sup]);
    const gov = detail.components.find((c) => c.component === "GOVERNANCE_BASIS")!;
    expect(gov.excludedEvidence).toEqual([{ evidenceId: exc, reason: "CLASS_NOT_ADMISSIBLE" }]);
  });

  it("G. ownership rule is unchanged: another user cannot read this result", async () => {
    const f = await makeJob();
    const [stranger] = await ctx.db.insert(users).values({}).returning();
    const { rawToken } = await createSession(ctx.db, stranger.id);
    const res = await jobDetailGET(
      new Request(`http://localhost/api/research-jobs/${f.jobId}`, {
        method: "GET",
        headers: { cookie: `atlas_session=${rawToken}`, origin: ORIGIN },
      }),
      { params: Promise.resolve({ id: f.jobId }) },
    );
    expect(res.status).toBe(404);
  });
});

// Guard the client contract too: the view must read its proof from
// `finding`, never from the job-wide `evidence` array. A future edit that
// reintroduces `detail.evidence.map` in the proof section reintroduces the
// exact bug, and a DB-level test cannot see that.
describe("result view — proof section reads only claim-scoped evidence", () => {
  // UI V1 moved the result view from app/(app)/research/page.tsx (now the
  // index) to app/(app)/research/[id]/page.tsx (the Research screen). The
  // invariant is unchanged and is asserted against the new file: the FINDING
  // is built from claim-scoped sources only, and the job-wide `evidence`
  // array may never become it.
  it("the research screen builds the finding from claim-scoped sources, never from the job-wide evidence array", async () => {
    const fs = await import("node:fs/promises");
    // The screen now COMPOSES the lists and the evidence section RENDERS
    // them, so the invariant spans both files. Scanning only the page would
    // let the headings and the empty state disappear unnoticed; scanning
    // only the section would miss where the lists come from.
    const raw = (
      await Promise.all(
        [
          "../app/(app)/research/[id]/page.tsx",
          "../src/client/components/evidence-section.tsx",
        ].map((p) => fs.readFile(new URL(p, import.meta.url), "utf-8")),
      )
    ).join("\n");
    // Comments in those files legitimately NAME the old expressions to
    // explain why they are wrong, so strip every comment form (JSX
    // {/* */}, block /* */, and line //) before scanning — otherwise the
    // documentation would trip its own guard.
    const code = raw
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // The finding's own lists come from S8's citation binding and S5's
    // claim-scoped component sets.
    expect(code).toContain("detail.finding.supporting");
    // The result page no longer derives the finding's EXCLUDED list: that
    // accounting moved to the audit's source register, where refused
    // material is a ledger with reasons rather than a document list under
    // the answer. The invariant this test protects is unchanged and is
    // asserted below — the finding is built from claim-scoped sources and
    // never from the job-wide evidence array.
    expect(code).not.toContain("detail.finding.excluded");
    expect(code).toContain("proof?.citations");
    // `admitted` IS the finding grid. It is composed only of those sources —
    // the job-wide array is not among them.
    expect(code).toMatch(
      /const admitted = \[\.\.\.used, \.\.\.supporting, \.\.\.contradicting\];/,
    );
    expect(code).not.toMatch(/const admitted[^;]*detail\.evidence/);

    // The job-wide array may be read ONLY for the separate, differently
    // headed section, and only for rows the finding did not already claim.
    const usesJobWideEvidence = /detail\.evidence\s*\n?\s*\.filter/.test(code);
    if (usesJobWideEvidence) {
      expect(code).toContain("shownIds");
      expect(code).toContain("Other material read");
      // Nothing in that section may be presented as supporting the verdict:
      // an excluded link outranks every other role for the same row.
      expect(code).toContain('e.links.find((l) => l.role === "EXCLUDED")');
    }

    // The honest empty state must exist rather than falling back to
    // whatever else the job happens to hold.
    expect(code).toContain("No evidence was bound in support of this finding.");
    // And no step count may come from mechanism branch structure.
    expect(code).not.toContain("mechanism.flows.length");
  });
});

// The real historical job shape, reconstructed as a table-driven case so
// the regression is pinned to observable data, not to one hand-written
// scenario.
describe("result projection — createResearchJob wiring stays intact", () => {
  it("a job with no claim support at all yields an empty finding, not the job's evidence", async () => {
    const f = await makeJob();
    await makeEvidence(f.jobId, 3, "GOVERNANCE_BASIS", "orphan evidence");
    const detail = await fetchDetail(f);
    expect(detail.finding.supporting).toEqual([]);
    expect(detail.finding.componentKeys).toEqual([]);
    expect(detail.evidence.length).toBe(1);
  });

});
