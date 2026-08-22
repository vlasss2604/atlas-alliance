import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { ComponentReconciliationResult } from "../src/server/engine/component-reconciler";
import {
  assembleMechanism,
  MechanismAssemblyInvariantError,
  type AssemblyEvidenceProjection,
} from "../src/server/engine/mechanism-assembler";
import { assembleAndPersistMechanism } from "../src/server/engine/mechanism-assembly-store";
import { evidence, projects, researchComponentResults, sources, topics, users } from "../src/server/db/schema";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// Phase 6, S6 — regression tests for the deep-audit fix package
// (docs/implementation/phase-6-s6-audit.md). Every case here is the
// executable form of an audit probe that FAILED against 7d72b53; these
// are the teeth that keep the fixes fixed.

function ev(id: string, sourceId: string, fragment: string, o: Partial<AssemblyEvidenceProjection> = {}): AssemblyEvidenceProjection {
  return {
    id,
    sourceId,
    extractionUnitKey: `unit-${id}`,
    sourceClass: "ONCHAIN_VERIFIABLE",
    officiality: "CONFIRMED",
    mechanismState: "LIVE",
    publishedAt: new Date("2025-01-01T00:00:00.000Z"),
    fetchedAt: new Date("2025-01-01T00:00:00.000Z"),
    fragment,
    summary: null,
    retrievedUrl: "https://example.com",
    contentHash: `hash-${id}`,
    ...o,
  };
}

function cr(
  step: number,
  component: string,
  status: ComponentReconciliationResult["status"],
  ids: string[],
  o: Partial<ComponentReconciliationResult> = {},
): ComponentReconciliationResult {
  return {
    step,
    component,
    status,
    reasonCodes: [],
    supportingEvidenceIds: ids,
    contradictingEvidenceIds: [],
    excludedEvidence: [],
    currentState: null,
    temporalBasis: null,
    tokenStateMentions: [],
    requiresFreshEvidence: false,
    ...o,
  };
}

function assemble(results: ComponentReconciliationResult[], evidenceRows: AssemblyEvidenceProjection[]) {
  return assembleMechanism({
    researchJobId: "job-1",
    patternVersion: 1,
    pattern: PATTERN_V1_CONTENT,
    contractView: { patternVersion: 1 },
    componentResults: results,
    admittedEvidence: evidenceRows,
  });
}

describe("HIGH-1 — cartesian cross-branch attribution is dead", () => {
  it("2 allocation slots x 2 destination slots from ONE source -> 2 flows with BRANCH_ATTRIBUTION_UNRESOLVED, never 4 fabricated combinations", () => {
    const evidenceRows = [
      ev("p1", "s0", "protocol fees paid by users"),
      ev("pA", "s0", "fifty percent used for buyback"),
      ev("pB", "s0", "thirty percent to treasury operations"),
      ev("dA", "s0", "bought back tokens sent to burn address"),
      ev("dB", "s0", "treasury share held in treasury wallet"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["p1"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["pA", "pB"]),
      cr(6, "DESTINATION", "SUPPORTED", ["dA", "dB"]),
    ];
    const r = assemble(results, evidenceRows);
    expect(r.flows.length).toBe(2);
    for (const f of r.flows) {
      expect(f.lineage.find((s) => s.component === "DESTINATION")).toBeUndefined();
      expect(f.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED" && g.component === "DESTINATION")).toBe(true);
      expect(f.nodes.find((n) => n.kind === "DESTINATION")).toBeUndefined();
    }
  });

  it("sub-fork below a fork stays legal when its provenance is unique to one branch", () => {
    // Branches sA/sB; both destination units come from sA only -> they are
    // attributable to the sA branch exclusively, which may then itself
    // fork; the sB branch honestly reports unresolved attribution.
    const evidenceRows = [
      ev("q1", "sPrefix", "protocol fees paid by users"),
      ev("qA", "sA", "buyback allocation"),
      ev("qB", "sB", "treasury allocation"),
      ev("dA1", "sA", "half sent to burn address"),
      ev("dA2", "sA", "half held in reserve wallet"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["q1"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["qA", "qB"]),
      cr(6, "DESTINATION", "SUPPORTED", ["dA1", "dA2"]),
    ];
    const r = assemble(results, evidenceRows);
    // sA branch forks into 2 destination flows; sB branch stays 1 with a gap.
    expect(r.flows.length).toBe(3);
    const withDest = r.flows.filter((f) => f.lineage.some((s) => s.component === "DESTINATION"));
    expect(withDest.length).toBe(2);
    const without = r.flows.filter((f) => !f.lineage.some((s) => s.component === "DESTINATION"));
    expect(without.length).toBe(1);
    expect(without[0].gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED" && g.component === "DESTINATION")).toBe(true);
  });
});

describe("MEDIUM-1 — shared-prefix provenance is not branch attribution", () => {
  it("destination evidence sharing only the PREFIX source -> BRANCH_ATTRIBUTION_UNRESOLVED on every branch, no attachment", () => {
    const evidenceRows = [
      ev("q1", "sPrefix", "protocol fees paid by users"),
      ev("qA", "sA", "buyback allocation"),
      ev("qB", "sB", "treasury allocation"),
      ev("qD", "sPrefix", "tokens sent to treasury"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["q1"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["qA", "qB"]),
      cr(6, "DESTINATION", "SUPPORTED", ["qD"]),
    ];
    const r = assemble(results, evidenceRows);
    expect(r.flows.length).toBe(2);
    for (const f of r.flows) {
      expect(f.lineage.find((s) => s.component === "DESTINATION")).toBeUndefined();
      expect(f.gaps.some((g) => g.kind === "BRANCH_ATTRIBUTION_UNRESOLVED" && g.component === "DESTINATION")).toBe(true);
    }
  });
});

describe("HIGH-2 — enumeration cap never silently mutilates a flow", () => {
  function cappedInput() {
    const manyIds = Array.from({ length: 65 }, (_, i) => `src${i}`);
    const evidenceRows = [
      ...manyIds.map((id, i) => ev(id, `s-${i}`, "protocol fees paid by users")),
      ev("e2", "sx2", "fees flow to allocation mechanism"),
      ev("e3", "sx3", "allocation mechanism specifies buyback"),
      ev("e4", "sx3g", "governed by DAO vote"),
      ev("e5", "sx4", "buyback executed on-chain"),
      ev("e6", "sx5", "mechanism is LIVE"),
      ev("e7", "sx6d", "tokens sent to treasury"),
      ev("e8", "sx6r", "token holders benefit"),
      ev("e9", "sx7", "net supply reduced"),
      ev("e10", "sx8", "locked by governance contract"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", manyIds),
      cr(2, "FLOW_PATH", "SUPPORTED", ["e2"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["e3"]),
      cr(3, "GOVERNANCE_BASIS", "SUPPORTED", ["e4"]),
      cr(4, "EXECUTION_EVIDENCE", "SUPPORTED", ["e5"]),
      cr(5, "CURRENT_STATE", "SUPPORTED", ["e6"], {
        currentState: "LIVE",
        temporalBasis: { basisField: "published_at", at: "2025-01-01T00:00:00.000Z" },
      }),
      cr(6, "DESTINATION", "SUPPORTED", ["e7"]),
      cr(6, "RECIPIENT", "SUPPORTED", ["e8"]),
      cr(7, "NET_EFFECT", "SUPPORTED", ["e9"]),
      cr(8, "DURABILITY_BASIS", "SUPPORTED", ["e10"]),
    ];
    return { evidenceRows, results };
  }

  it("capped flow carries a positioned FLOW_ENUMERATION_INCOMPLETE and can never be COMPLETE_PATH", () => {
    const { evidenceRows, results } = cappedInput();
    const r = assemble(results, evidenceRows);
    const f = r.flows[0];
    const flowGap = f.gaps.find((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE");
    expect(flowGap).toBeDefined();
    expect(flowGap!.component).toBe("SOURCE_OF_VALUE");
    expect(flowGap!.afterStep).toBe(1);
    expect(flowGap!.provenance.componentResults.length).toBeGreaterThan(0);
    expect(f.shape).toBe("PARTIAL_PATH");
  });

  it("result-level FLOW_ENUMERATION_INCOMPLETE names the cap position and carries non-empty componentResults (§18 п.1)", () => {
    const { evidenceRows, results } = cappedInput();
    const r = assemble(results, evidenceRows);
    const g = r.unassignedGaps.find((x) => x.kind === "FLOW_ENUMERATION_INCOMPLETE");
    expect(g).toBeDefined();
    expect(g!.component).toBe("SOURCE_OF_VALUE");
    expect(g!.afterStep).toBe(1);
    expect(g!.provenance.componentResults).toEqual([{ step: 1, component: "SOURCE_OF_VALUE" }]);
  });

  it("AF. four established branches, under the cap -> all four represented, no truncation", () => {
    const ids = ["b1", "b2", "b3", "b4"];
    const evidenceRows = [
      ev("m1", "s1", "protocol fees"),
      ...ids.map((id) => ev(id, `s-${id}`, "allocation branch")),
    ];
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["m1"]), cr(3, "MECHANISM_SPEC", "SUPPORTED", ids)];
    const r = assemble(results, evidenceRows);
    expect(r.flows.length).toBe(4);
    expect(r.unassignedGaps.find((g) => g.kind === "FLOW_ENUMERATION_INCOMPLETE")).toBeUndefined();
  });
});

describe("MEDIUM-3 — executed reflects EXECUTION_EVIDENCE, not edge existence", () => {
  it("FLOW_PATH edge is executed=false without established EXECUTION_EVIDENCE", () => {
    const evidenceRows = [ev("x1", "s1", "protocol fees"), ev("x2", "s2", "fees flow"), ev("x3", "s3", "buyback spec")];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["x1"]),
      cr(2, "FLOW_PATH", "SUPPORTED", ["x2"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["x3"]),
      cr(4, "EXECUTION_EVIDENCE", "INSUFFICIENT_EVIDENCE", []),
    ];
    const r = assemble(results, evidenceRows);
    expect(r.flows[0].edges.find((e) => e.basisComponent === "FLOW_PATH")!.executed).toBe(false);
  });

  it("FLOW_PATH edge is executed=true when EXECUTION_EVIDENCE is established on the lineage", () => {
    const evidenceRows = [
      ev("x1", "s1", "protocol fees"),
      ev("x2", "s2", "fees flow"),
      ev("x3", "s3", "buyback spec"),
      ev("x5", "s4", "executed on-chain"),
    ];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["x1"]),
      cr(2, "FLOW_PATH", "SUPPORTED", ["x2"]),
      cr(3, "MECHANISM_SPEC", "SUPPORTED", ["x3"]),
      cr(4, "EXECUTION_EVIDENCE", "SUPPORTED", ["x5"]),
    ];
    const r = assemble(results, evidenceRows);
    expect(r.flows[0].edges.find((e) => e.basisComponent === "FLOW_PATH")!.executed).toBe(true);
  });
});

describe("MEDIUM-2 — token-state comparison is per-component and identity-aware", () => {
  it("qualifier+identity pair from ONE component ('locked veCRV' -> ['locked','vecrv']) is not a mismatch; tokenState = identity", () => {
    const evidenceRows = [ev("r1", "s6r", "locked veCRV holders receive fees")];
    const results = [cr(6, "RECIPIENT", "SUPPORTED", ["r1"], { tokenStateMentions: ["locked", "vecrv"] })];
    const r = assemble(results, evidenceRows);
    expect(r.flows[0].gaps.filter((g) => g.kind === "TOKEN_STATE_MISMATCH").length).toBe(0);
    expect(r.flows[0].attributes.tokenState).toBe("vecrv");
  });

  it("matching identity on both components ('staked stkAAVE' both sides) is not a mismatch — 'staked' never false-matches as identity", () => {
    const evidenceRows = [ev("r1", "s6r", "staked stkAAVE holders"), ev("d1", "s6d", "stkAAVE rewards pool")];
    const results = [
      cr(6, "RECIPIENT", "SUPPORTED", ["r1"], { tokenStateMentions: ["staked", "stkaave"] }),
      cr(6, "DESTINATION", "SUPPORTED", ["d1"], { tokenStateMentions: ["stkaave"] }),
    ];
    const r = assemble(results, evidenceRows);
    expect(r.flows[0].gaps.filter((g) => g.kind === "TOKEN_STATE_MISMATCH").length).toBe(0);
    expect(r.flows[0].attributes.tokenState).toBe("stkaave");
  });

  it("genuinely different states on adjacent components still mismatch (scenario O preserved)", () => {
    const evidenceRows = [ev("r1", "s6r", "veCRV holders"), ev("d1", "s6d", "stkAAVE pool")];
    const results = [
      cr(6, "RECIPIENT", "SUPPORTED", ["r1"], { tokenStateMentions: ["vecrv"] }),
      cr(6, "DESTINATION", "SUPPORTED", ["d1"], { tokenStateMentions: ["stkaave"] }),
    ];
    const r = assemble(results, evidenceRows);
    expect(r.flows[0].gaps.some((g) => g.kind === "TOKEN_STATE_MISMATCH")).toBe(true);
    expect(r.flows[0].attributes.tokenState).toBeNull();
  });
});

describe("MEDIUM-4 — TEMPORAL_STATE_MISMATCH is a real, emitted gap", () => {
  it("CURRENT_STATE LIVE with a strictly newer DEPRECATED elsewhere -> gap + degraded lifecycle", () => {
    const evidenceRows = [ev("z1", "s1", "protocol fees"), ev("z5", "s4", "executed"), ev("z6", "s5", "live")];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["z1"]),
      cr(4, "EXECUTION_EVIDENCE", "SUPPORTED", ["z5"], {
        currentState: "DEPRECATED",
        temporalBasis: { basisField: "published_at", at: "2026-06-01T00:00:00.000Z" },
      }),
      cr(5, "CURRENT_STATE", "SUPPORTED", ["z6"], {
        currentState: "LIVE",
        temporalBasis: { basisField: "published_at", at: "2025-01-01T00:00:00.000Z" },
      }),
    ];
    const r = assemble(results, evidenceRows);
    const gap = r.flows[0].gaps.find((g) => g.kind === "TEMPORAL_STATE_MISMATCH");
    expect(gap).toBeDefined();
    expect(gap!.provenance.componentResults).toContainEqual({ step: 4, component: "EXECUTION_EVIDENCE" });
    expect(r.flows[0].lifecycle).not.toBe("CURRENT");
  });

  it("CURRENT_STATE itself DEPRECATED (plain historical transition) -> no temporal mismatch gap", () => {
    const evidenceRows = [ev("z1", "s1", "protocol fees"), ev("z5", "s4", "executed"), ev("z6", "s5", "deprecated")];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["z1"]),
      cr(4, "EXECUTION_EVIDENCE", "SUPPORTED", ["z5"]),
      cr(5, "CURRENT_STATE", "SUPPORTED", ["z6"], {
        currentState: "DEPRECATED",
        temporalBasis: { basisField: "published_at", at: "2026-01-01T00:00:00.000Z" },
      }),
    ];
    const r = assemble(results, evidenceRows);
    expect(r.flows[0].gaps.find((g) => g.kind === "TEMPORAL_STATE_MISMATCH")).toBeUndefined();
    expect(r.flows[0].lifecycle).toBe("HISTORICAL");
  });
});

describe("MEDIUM-5 — gaps are never duplicated", () => {
  it("missing DESTINATION -> exactly one DESTINATION_UNRESOLVED; missing DURABILITY -> exactly one MISSING_COMPONENT", () => {
    const evidenceRows = [ev("y1", "s1", "protocol fees")];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["y1"]),
      cr(6, "DESTINATION", "INSUFFICIENT_EVIDENCE", []),
      cr(8, "DURABILITY_BASIS", "INSUFFICIENT_EVIDENCE", []),
    ];
    const r = assemble(results, evidenceRows);
    const gaps = r.flows[0].gaps;
    expect(gaps.filter((g) => g.kind === "DESTINATION_UNRESOLVED").length).toBe(1);
    expect(gaps.filter((g) => g.kind === "MISSING_COMPONENT" && g.component === "DURABILITY_BASIS").length).toBe(1);
    expect(gaps.filter((g) => g.kind === "RECIPIENT_UNRESOLVED").length).toBe(1);
    // No (kind, component, afterStep) duplicate anywhere:
    const keys = gaps.map((g) => `${g.kind}|${g.component}|${g.afterStep}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("CONTRADICTED component yields only CONTRADICTED_COMPONENT for it (§12), not an extra *_UNRESOLVED copy", () => {
    const evidenceRows = [ev("y3", "s1", "protocol fees"), ev("c1", "sc1", "burned"), ev("c2", "sc2", "kept in treasury")];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["y3"]),
      cr(6, "DESTINATION", "CONTRADICTED", [], { contradictingEvidenceIds: ["c1", "c2"] }),
    ];
    const r = assemble(results, evidenceRows);
    const destGaps = r.flows[0].gaps.filter((g) => g.component === "DESTINATION");
    expect(destGaps.length).toBe(1);
    expect(destGaps[0].kind).toBe("CONTRADICTED_COMPONENT");
  });
});

describe("NOTE-2 — dangling contradicting ids are the same §21 п.5 failure", () => {
  it("CONTRADICTED with a contradicting id absent from admitted evidence -> invariant error", () => {
    const evidenceRows = [ev("y4", "s1", "protocol fees")];
    const results = [
      cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["y4"]),
      cr(6, "DESTINATION", "CONTRADICTED", [], { contradictingEvidenceIds: ["ghost"] }),
    ];
    expect(() => assemble(results, evidenceRows)).toThrow(MechanismAssemblyInvariantError);
  });
});

describe("LOW-1 teeth — classification cannot reach flowId even through slot ORDER", () => {
  it("changing one slot's classification in a MULTI-slot fork leaves the flowId set unchanged (catches classifier-dependent slot ordering)", () => {
    const results = [cr(1, "SOURCE_OF_VALUE", "SUPPORTED", ["s1a", "s1b"])];
    const before = assemble(results, [
      ev("s1a", "sA", "market purchase buyback"),
      ev("s1b", "sB", "collateral returned to provider"),
    ]);
    const after = assemble(results, [
      ev("s1a", "sA", "market purchase buyback"),
      ev("s1b", "sB", "completely unrecognisable wording"),
    ]);
    expect(before.flows.map((f) => f.flowId).sort()).toEqual(after.flows.map((f) => f.flowId).sort());
    // Order of the flows array itself is also classification-independent:
    expect(before.flows.map((f) => f.flowId)).toEqual(after.flows.map((f) => f.flowId));
  });
});

describe("store fixes (LOW-2) — real PostgreSQL", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestDatabase();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const NOW = new Date("2026-08-22T00:00:00Z");

  it("a job with S5 results but no research_plans row is refused, not assembled under whatever is ACTIVE", async () => {
    const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
    const [project] = await ctx.db.insert(projects).values({ slug: uniq("s6f"), name: "S6 fix", status: "ACTIVE_CORE" }).returning();
    const [user] = await ctx.db.insert(users).values({}).returning();
    const { job } = await createResearchJob(ctx.db, ctx.boss, {
      userId: user.id,
      topicId: t.id,
      projectId: project.id,
      originalQuestion: "q?",
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "x" },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement: coreEntitlement(),
      demoLifetimeProofLimit: 1000,
    });
    const urlHash = `sha256:https://example.com/${uniq("d")}`;
    const [src] = await ctx.db
      .insert(sources)
      .values({ url: "https://example.com/x", urlHash, sourceType: "OFFICIAL_DOCS" })
      .returning({ id: sources.id });
    const [row] = await ctx.db
      .insert(evidence)
      .values({
        researchJobId: job.id,
        proofId: null,
        sourceId: src.id,
        patternStep: 1,
        component: "SOURCE_OF_VALUE",
        relationship: "SUPPORTS",
        directness: "DIRECT",
        fragment: "protocol fees paid by users",
        summary: null,
        mechanismState: null,
        sourceClass: "OFFICIAL_DOCS",
        officiality: "CONFIRMED",
        fetchedAt: NOW,
        publishedAt: NOW,
        doesNotProve: "n/a",
        retrievedUrl: "https://example.com/x",
        contentHash: `hash-${Math.random()}`,
        extractionUnitKey: `unit-${Math.random()}`,
      })
      .returning({ id: evidence.id });
    await ctx.db.insert(researchComponentResults).values({
      researchJobId: job.id,
      patternStep: 1,
      component: "SOURCE_OF_VALUE",
      status: "SUPPORTED",
      reasonCodes: [],
      supportingEvidenceIds: [row.id],
      contradictingEvidenceIds: [],
      excludedEvidence: [],
      currentState: null,
      tokenStateMentions: [],
      requiresFreshEvidence: false,
    });
    // No runMemoryPlanningStage -> no research_plans row.
    await expect(assembleAndPersistMechanism(ctx.db, job.id, NOW)).rejects.toThrow(/no research_plans row/);
  });
});
