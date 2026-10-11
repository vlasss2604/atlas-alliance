import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { interpretations, projectMemoryItems, projects, researchAttempts, researchJobs, sources, topics, users } from "../src/server/db/schema";
import { loadFetchTargets, runSearchPhase } from "../src/server/engine/acquisition-phases";
import { evaluateClaimSupport, MECHANISM_ANCHOR_COMPONENTS, type ClaimEvaluationInput } from "../src/server/engine/claim-evaluator";
import type { ComponentWorkItem } from "../src/server/engine/contract-view";
import { runResearchController, type WorkExecutor } from "../src/server/engine/controller";
import { loadJobContractView } from "../src/server/engine/job-contract-view";
import type { DurabilityAttachment, FlowAttributes, MechanismAssemblyResult, MechanismFlow, MechanismGap, NetEffectAttachment } from "../src/server/engine/mechanism-assembler";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import type { ComponentTarget } from "../src/server/engine/providers/types";
import {
  classifyComponentCoverage,
  deriveResearchCoverage,
  isAdequatelyResearched,
  loadResearchCoverage,
  type ComponentCoverageInput,
} from "../src/server/engine/research-coverage";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { firstPathSegment, observeSourceRouteCandidate } from "../src/server/engine/source-route-candidates";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// RESEARCH QUALITY V1 (D-176) — REALITY STOPS WHERE THE EVIDENCE STOPS.
//
// Four generic rules, each pinned against the failure that produced it on
// the second Jito benchmark (job d3b7cd2c) and against the semantics it may
// not touch:
//
//   P0 VERDICT RELEVANCE   an upstream economic fact (revenue exists, value
//                          reaches some destination) may be established
//                          without supporting the asserted mechanism; the
//                          compound verdict is anchored to the mechanism.
//   P0 COMPLETENESS        CHECKED_AND_NOT_ESTABLISHED, INCOMPLETE_COVERAGE,
//                          BLOCKED, NOT_REACHED and NOT_APPLICABLE are kept
//                          apart deterministically, per component and for
//                          the whole job; none of them is a truth verdict.
//   P1 SOURCE AUTHORITY    a confirmed domain's page outside the classified
//                          prefix, and a project-owned subdomain, are
//                          surfaced to the owner as auditable candidates —
//                          discovery still is not authority.
//   P1 CRITICAL FAIRNESS   every component's own best discovery gets a
//                          protected open before generic pages consume the
//                          budget; the tail is stable and authority-aware.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------
// S7 fixtures (the same minimal shapes phase6-s7-claim-evaluator.test.ts uses)
// ---------------------------------------------------------------------------

function attrs(overrides: Partial<FlowAttributes> = {}): FlowAttributes {
  return { valueSource: "UNKNOWN", direction: "UNKNOWN", recipientKind: "UNKNOWN", destinationKind: "UNKNOWN", tokenState: null, assetSymbol: null, ...overrides };
}
function flow(overrides: Partial<MechanismFlow> = {}): MechanismFlow {
  return {
    flowId: overrides.flowId ?? "f1",
    lineage: [],
    sharedPrefixId: null,
    branchPointStep: null,
    lifecycle: "NOT_ESTABLISHED",
    nodes: [],
    edges: [],
    shape: "PARTIAL_PATH",
    attributes: attrs(),
    netEffect: null,
    durability: null,
    gaps: [],
    ...overrides,
  };
}
function node(kind: MechanismFlow["nodes"][number]["kind"], component: string, status: "SUPPORTED" | "PARTIALLY_SUPPORTED", evidenceIds: string[]) {
  return { kind, component, componentStatus: status, qualifications: [], attributes: {} as Record<string, never>, provenance: { componentResults: [{ step: 1, component }], evidenceIds } };
}
function step(stepNo: number, component: string, evidenceIds: string[]) {
  return { step: stepNo, component, componentResultKey: `${stepNo}:${component}`, evidenceIds };
}
function gap(kind: MechanismGap["kind"], component: string | null, afterStep: number | null, evidenceIds: string[] = []): MechanismGap {
  return { kind, component, afterStep, provenance: { componentResults: component ? [{ step: afterStep ?? 0, component }] : [], evidenceIds } };
}
function netEffect(status: "SUPPORTED" | "PARTIALLY_SUPPORTED", evidenceIds: string[]): NetEffectAttachment {
  return { componentStatus: status, qualifications: [], provenance: { componentResults: [{ step: 7, component: "NET_EFFECT" }], evidenceIds } };
}
function durability(status: "SUPPORTED" | "PARTIALLY_SUPPORTED", evidenceIds: string[]): DurabilityAttachment {
  return { componentStatus: status, basisClasses: ["GOVERNANCE"], qualifications: [], provenance: { componentResults: [{ step: 8, component: "DURABILITY_BASIS" }], evidenceIds } };
}
function assemble(flows: MechanismFlow[], unassignedGaps: MechanismGap[] = []): MechanismAssemblyResult {
  return { researchJobId: "job-rq", patternVersion: 1, flows, unassignedGaps };
}
function evalInput(intent: string, flows: MechanismFlow[], overrides: Partial<ClaimEvaluationInput> = {}): ClaimEvaluationInput {
  return { researchJobId: "job-rq", patternVersion: 1, pattern: PATTERN_V1_CONTENT, intent, taskType: null, requirementSetVersion: 1, assembly: assemble(flows), ...overrides };
}

// THE JITO SHAPE: revenue established, value reaches a treasury-like
// destination whose role S6 could not classify — and NO mechanism anywhere.
function upstreamOnlyFlow(overrides: Partial<MechanismFlow> = {}): MechanismFlow {
  return flow({
    lineage: [step(1, "SOURCE_OF_VALUE", ["e1"]), step(6, "DESTINATION", ["e2"])],
    nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "PARTIALLY_SUPPORTED", ["e1"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])],
    gaps: [gap("DESTINATION_UNRESOLVED", "DESTINATION", 6, ["e2"])],
    attributes: attrs({ valueSource: "FEES" }),
    ...overrides,
  });
}
function withMechanism(f: MechanismFlow, status: "SUPPORTED" | "PARTIALLY_SUPPORTED" = "SUPPORTED"): MechanismFlow {
  return {
    ...f,
    lineage: [...f.lineage, step(3, "MECHANISM_SPEC", ["e5"])].sort((a, b) => a.step - b.step),
    nodes: [...f.nodes, node("MECHANISM", "MECHANISM_SPEC", status, ["e5"])],
  };
}

describe("P0 — verdict relevance: a claim is anchored to its mechanism", () => {
  it("the anchor set is the mechanism in its three forms — documented, approved, executed", () => {
    expect([...MECHANISM_ANCHOR_COMPONENTS].sort()).toEqual(["EXECUTION_EVIDENCE", "GOVERNANCE_BASIS", "MECHANISM_SPEC"]);
  });

  it("1. revenue established, destination reached, asserted mechanism absent (the Jito shape) -> INSUFFICIENT_EVIDENCE, atoms unchanged", () => {
    const r = evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [upstreamOnlyFlow()]));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toContain("ASSERTED_MECHANISM_NOT_ESTABLISHED");
    // The upstream atoms keep exactly their own verdicts and provenance:
    // nothing about the economics was re-adjudicated or hidden.
    const byId = Object.fromEntries(r.requirementResults.map((x) => [x.requirementId, x]));
    expect(byId["PRT-1"].status).toBe("PARTIAL");
    expect(byId["PRT-2"].status).toBe("PARTIAL");
    expect(byId["PRT-2"].provenance.evidenceIds).toEqual(["e1", "e2"]);
  });

  it("2. value flow established on a flow with no mechanism (REWARD_SOURCE) -> INSUFFICIENT_EVIDENCE", () => {
    const f = flow({
      lineage: [step(1, "SOURCE_OF_VALUE", ["e1"]), step(2, "FLOW_PATH", ["e3"]), step(6, "DESTINATION", ["e2"])],
      nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])],
      attributes: attrs({ valueSource: "FEES", destinationKind: "TREASURY" }),
    });
    const r = evaluateClaimSupport(evalInput("REWARD_SOURCE", [f]));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toContain("ASSERTED_MECHANISM_NOT_ESTABLISHED");
  });

  it("3. mechanism partially established on the same flow -> PARTIALLY_SUPPORTED stands (partial authority is a confidence matter)", () => {
    const r = evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [withMechanism(upstreamOnlyFlow(), "PARTIALLY_SUPPORTED")]));
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).not.toContain("ASSERTED_MECHANISM_NOT_ESTABLISHED");
  });

  it("4. mechanism documented but execution not established: a CURRENT-state claim stays unsatisfied, a revenue claim is partial — never strengthened", () => {
    const f = withMechanism(upstreamOnlyFlow());
    const current = evaluateClaimSupport(evalInput("MECHANISM_CURRENT_STATE", [f]));
    expect(current.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(current.requirementResults[0].reasonCodes).toContain("TEMPORAL_SCOPE_MISMATCH");
    const revenue = evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [f]));
    expect(revenue.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("5. the asserted mechanism contradicted on a required atom -> NOT_SUPPORTED, untouched by the anchor", () => {
    const f = flow({
      lineage: [step(1, "SOURCE_OF_VALUE", ["e1"])],
      nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])],
      gaps: [gap("CONTRADICTED_COMPONENT", "DESTINATION", 6, ["e9"])],
    });
    const r = evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [f]));
    expect(r.status).toBe("NOT_SUPPORTED");
    expect(r.reasonCodes).not.toContain("ASSERTED_MECHANISM_NOT_ESTABLISHED");
  });

  it("6. true partial support: source partial, mechanism and destination established on one flow -> PARTIALLY_SUPPORTED with REQUIRED_PATH_PARTIAL", () => {
    const f = withMechanism(
      flow({
        lineage: [step(1, "SOURCE_OF_VALUE", ["e1"]), step(6, "DESTINATION", ["e2"])],
        nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "PARTIALLY_SUPPORTED", ["e1"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])],
        attributes: attrs({ valueSource: "FEES", destinationKind: "BURN" }),
      }),
    );
    const r = evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [f]));
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reasonCodes).toEqual(["REQUIRED_PATH_PARTIAL"]);
  });

  it("7. true support: source, mechanism, destination established on one coherent flow -> SUPPORTED", () => {
    const f = withMechanism(
      flow({
        lineage: [step(1, "SOURCE_OF_VALUE", ["e1"]), step(6, "DESTINATION", ["e2"])],
        nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])],
        attributes: attrs({ valueSource: "FEES", destinationKind: "BURN" }),
        shape: "COMPLETE_PATH",
      }),
    );
    const r = evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [f]));
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasonCodes).toEqual([]);
  });

  it("8. an executed mechanism anchors as well as a documented one; the anchor must sit on a flow the winning atoms matched", () => {
    const executed = flow({
      lineage: [step(1, "SOURCE_OF_VALUE", ["e1"]), step(4, "EXECUTION_EVIDENCE", ["e7"]), step(6, "DESTINATION", ["e2"])],
      nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"]), node("DESTINATION", "DESTINATION", "SUPPORTED", ["e2"])],
      attributes: attrs({ valueSource: "FEES", destinationKind: "BURN" }),
    });
    expect(evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [executed])).status).toBe("SUPPORTED");
    // The mechanism established on an UNRELATED flow does not anchor the
    // atoms matched elsewhere (D-108: never combine across flows).
    const mechanismElsewhere = flow({ flowId: "f2", lineage: [step(3, "MECHANISM_SPEC", ["e5"])], nodes: [node("MECHANISM", "MECHANISM_SPEC", "SUPPORTED", ["e5"])] });
    const r = evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [upstreamOnlyFlow(), mechanismElsewhere]));
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasonCodes).toContain("ASSERTED_MECHANISM_NOT_ESTABLISHED");
  });

  it("9. a supply question with a measured effect but no mechanism anywhere -> not attributed to a mechanism (INSUFFICIENT_EVIDENCE); with the mechanism, the effect stands", () => {
    const bare = flow({ lineage: [step(1, "SOURCE_OF_VALUE", ["e1"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])], netEffect: netEffect("PARTIALLY_SUPPORTED", ["e8"]) });
    expect(evaluateClaimSupport(evalInput("BURN_OR_SUPPLY_EFFECT", [bare])).status).toBe("INSUFFICIENT_EVIDENCE");
    expect(evaluateClaimSupport(evalInput("BURN_OR_SUPPLY_EFFECT", [withMechanism(bare)])).status).toBe("PARTIALLY_SUPPORTED");
    // Durability likewise rests on the mechanism it is about.
    const durable = flow({ lineage: [step(1, "SOURCE_OF_VALUE", ["e1"])], nodes: [node("VALUE_SOURCE", "SOURCE_OF_VALUE", "SUPPORTED", ["e1"])], durability: durability("SUPPORTED", ["e9"]) });
    expect(evaluateClaimSupport(evalInput("PROTOCOL_REVENUE_TO_TOKEN", [durable])).status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

// ---------------------------------------------------------------------------
// P0 — RESEARCH COMPLETENESS MODEL (pure)
// ---------------------------------------------------------------------------

function cov(overrides: Partial<ComponentCoverageInput> = {}): ComponentCoverageInput {
  return {
    step: 3,
    component: "GOVERNANCE_BASIS",
    inWorkQueue: true,
    establishingClasses: ["GOVERNANCE"],
    critical: true,
    result: { status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["NO_EVIDENCE_FOUND"] },
    attempts: [{ attemptNumber: 1, status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT; source-route observations: X" }],
    inspectedClasses: ["GOVERNANCE"],
    remainingPaths: [],
    recoverySpent: false,
    ...overrides,
  };
}

describe("P0 — research completeness: coverage is a statement about the research, never about the project", () => {
  it("8. checked thoroughly and not established: an admissible class was read, no path remains, nothing failed -> CHECKED_AND_NOT_ESTABLISHED", () => {
    const c = classifyComponentCoverage(cov());
    expect(c.coverage).toBe("CHECKED_AND_NOT_ESTABLISHED");
    expect(isAdequatelyResearched(c.coverage)).toBe(true);
  });

  it("every page read was of a class that cannot establish the component (the DURABILITY_BASIS shape) -> INCOMPLETE_COVERAGE, never 'checked'", () => {
    const c = classifyComponentCoverage(cov({ component: "DURABILITY_BASIS", step: 8, inspectedClasses: ["SOCIAL", "OFFICIAL_DOCS"], result: { status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["ALL_EVIDENCE_EXCLUDED"] } }));
    expect(c.coverage).toBe("INCOMPLETE_COVERAGE");
    expect(c.reasons).toEqual(["ADMISSIBLE_CLASS_NEVER_INSPECTED"]);
    expect(isAdequatelyResearched(c.coverage)).toBe(false);
  });

  it("6. component never reached: in the queue, no attempt -> NOT_REACHED; outside the queue -> NOT_APPLICABLE", () => {
    expect(classifyComponentCoverage(cov({ attempts: [], result: null })).coverage).toBe("NOT_REACHED");
    expect(classifyComponentCoverage(cov({ attempts: [], result: null, inWorkQueue: false })).coverage).toBe("NOT_APPLICABLE");
  });

  it("7. component blocked operationally: a provider failure or no admissible route before anything admissible was read -> BLOCKED", () => {
    const fetchFailed = classifyComponentCoverage(cov({ attempts: [{ attemptNumber: 1, status: "FAILED", reason: "CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:404" }], inspectedClasses: [] }));
    expect(fetchFailed.coverage).toBe("BLOCKED");
    expect(fetchFailed.reasons).toEqual(["SOURCE_UNAVAILABLE"]);
    const noRoute = classifyComponentCoverage(cov({ attempts: [{ attemptNumber: 1, status: "SKIPPED", reason: "NO_ADMISSIBLE_ROUTE; source-route observations: CLASS_REQUIRES_CONFIRMED_ROUTE:GOVERNANCE" }], inspectedClasses: [] }));
    expect(noRoute.coverage).toBe("BLOCKED");
    expect(noRoute.reasons).toEqual(["NO_ADMISSIBLE_ROUTE"]);
    // A technical stop AFTER an admissible page was read is incomplete, not blocked.
    const partlyRead = classifyComponentCoverage(cov({ attempts: [{ attemptNumber: 1, status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE" }], inspectedClasses: ["GOVERNANCE"] }));
    expect(partlyRead.coverage).toBe("INCOMPLETE_COVERAGE");
    expect(partlyRead.reasons).toEqual(["EXTRACTION_NOT_COMPLETED"]);
  });

  it("known admissible paths left open, a spent search axis, or a non-terminal attempt -> INCOMPLETE_COVERAGE", () => {
    expect(classifyComponentCoverage(cov({ remainingPaths: [{ kind: "SEALED_UNEXTRACTED", count: 1 }], recoverySpent: true })).reasons).toEqual(["RECOVERY_BOUND_REACHED"]);
    expect(classifyComponentCoverage(cov({ remainingPaths: [{ kind: "UNOPENED_CANDIDATE", count: 2 }], recoverySpent: false })).reasons).toEqual(["KNOWN_PATHS_UNEXPLORED"]);
    expect(classifyComponentCoverage(cov({ result: { status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["SEARCH_BUDGET_EXHAUSTED"] } })).reasons).toEqual(["SEARCH_BUDGET_EXHAUSTED"]);
    expect(classifyComponentCoverage(cov({ attempts: [{ attemptNumber: 1, status: "STARTED", reason: null }] })).coverage).toBe("INCOMPLETE_COVERAGE");
  });

  it("a result is a result — SUPPORTED, PARTIALLY_SUPPORTED or CONTRADICTED — even with a path left open, which stays visible", () => {
    const c = classifyComponentCoverage(cov({ result: { status: "PARTIALLY_SUPPORTED", reasonCodes: ["INSUFFICIENT_AUTHORITY"] }, remainingPaths: [{ kind: "SEALED_UNEXTRACTED", count: 1 }], recoverySpent: true }));
    expect(c.coverage).toBe("COMPLETE_WITH_RESULT");
    expect(c.reasons).toEqual(["RECOVERY_BOUND_REACHED", "RESULT_PARTIALLY_SUPPORTED"]);
    expect(classifyComponentCoverage(cov({ result: { status: "CONTRADICTED", reasonCodes: [] } })).coverage).toBe("COMPLETE_WITH_RESULT");
  });

  it("9. incomplete Research with a persisted verdict: the job-level projection is COVERAGE_LIMITED and names why; the verdict is not touched", () => {
    const record = deriveResearchCoverage({
      intent: "MECHANISM_CURRENT_STATE",
      jobState: "SUCCEEDED",
      terminationReason: "WORK_QUEUE_EXHAUSTED",
      components: [
        cov({ step: 1, component: "SOURCE_OF_VALUE", critical: false, establishingClasses: ["OFFICIAL_DOCS"], inspectedClasses: ["OFFICIAL_DOCS"], result: { status: "PARTIALLY_SUPPORTED", reasonCodes: [] } }),
        cov({ step: 3, component: "MECHANISM_SPEC", establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"], inspectedClasses: ["OFFICIAL_DOCS"], remainingPaths: [{ kind: "SEALED_UNEXTRACTED", count: 1 }], recoverySpent: true }),
        cov({ step: 3, component: "GOVERNANCE_BASIS", attempts: [{ attemptNumber: 1, status: "FAILED", reason: "NO_SOURCE_COULD_BE_FETCHED; x" }], inspectedClasses: [] }),
        cov({ step: 4, component: "EXECUTION_EVIDENCE", establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"], inspectedClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"], result: { status: "INSUFFICIENT_EVIDENCE", reasonCodes: ["MISSING_EXECUTION_EVIDENCE"] } }),
        cov({ step: 8, component: "DURABILITY_BASIS", critical: false, attempts: [], result: null }),
      ],
    });
    expect(record.overall).toBe("COVERAGE_LIMITED");
    const codes = record.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["CRITICAL_COMPONENT_INCOMPLETE", "CRITICAL_COMPONENT_BLOCKED", "REQUIRED_CLASS_NEVER_CHECKED", "KNOWN_PATHS_UNREAD", "INFRASTRUCTURE_STOP", "GOVERNANCE_NOT_COVERED"]));
    expect(codes).not.toContain("EXECUTION_NOT_COVERED"); // execution WAS checked, in the right places, and not established
    expect(codes).not.toContain("JOB_TERMINATED_EARLY");
    expect(record.findings.find((f) => f.code === "GOVERNANCE_NOT_COVERED")!.components).toEqual(["GOVERNANCE_BASIS"]);
    // A non-critical component never reached is reported in its own class, not as a critical finding.
    expect(record.components.find((c) => c.component === "DURABILITY_BASIS")!.coverage).toBe("NOT_REACHED");
    expect(codes).not.toContain("CRITICAL_COMPONENT_NOT_REACHED");
  });

  it("10. complete Research with insufficient evidence: every critical component checked in an admissible class, nothing open -> COMPLETE (not established ≠ not researched)", () => {
    const record = deriveResearchCoverage({
      intent: "PROTOCOL_REVENUE_TO_TOKEN",
      jobState: "SUCCEEDED",
      terminationReason: "WORK_QUEUE_EXHAUSTED",
      components: [
        cov({ step: 1, component: "SOURCE_OF_VALUE", establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE", "ONCHAIN_VERIFIABLE"], inspectedClasses: ["OFFICIAL_DOCS"] }),
        cov({ step: 3, component: "MECHANISM_SPEC", establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"], inspectedClasses: ["OFFICIAL_DOCS"] }),
        cov({ step: 5, component: "CURRENT_STATE", establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"], inspectedClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"] }),
        cov({ step: 6, component: "DESTINATION", establishingClasses: ["ONCHAIN_VERIFIABLE", "OFFICIAL_DOCS"], inspectedClasses: ["OFFICIAL_DOCS"] }),
        cov({ step: 8, component: "DURABILITY_BASIS", critical: false, inspectedClasses: ["GOVERNANCE"] }),
      ],
    });
    expect(record.overall).toBe("COMPLETE");
    expect(record.components.every((c) => c.coverage === "CHECKED_AND_NOT_ESTABLISHED")).toBe(true);
    // The verdict side is a different statement entirely: this record says
    // nothing about SUPPORTED or INSUFFICIENT_EVIDENCE.
    expect(JSON.stringify(record)).not.toMatch(/"verdict"|"confidence"/);
  });

  it("a job that stopped for budget or failed is COVERAGE_LIMITED whatever the components say", () => {
    const record = deriveResearchCoverage({ intent: "PROTOCOL_REVENUE_TO_TOKEN", jobState: "BUDGET_LIMIT_REACHED", terminationReason: "BUDGET_EXHAUSTED", components: [cov({ step: 1, component: "SOURCE_OF_VALUE", establishingClasses: ["OFFICIAL_DOCS"], inspectedClasses: ["OFFICIAL_DOCS"] })] });
    expect(record.overall).toBe("COVERAGE_LIMITED");
    expect(record.findings.map((f) => f.code)).toEqual(["JOB_TERMINATED_EARLY"]);
  });
});

// ---------------------------------------------------------------------------
// DB-backed fixtures
// ---------------------------------------------------------------------------

const COST: ModelCostProfile = { modelId: "fixture-test-model", inputPriceMicroUsdPerToken: 1, outputPriceMicroUsdPerToken: 5, maxInputTokens: 8_000, maxOutputTokens: 1_536, priceVersion: "test-fixture-not-production" };

async function makeProject(opts: { host: string; prefix?: string; routeClass?: "OFFICIAL_DOCS" | "GOVERNANCE" } = { host: "docs.rq.test" }) {
  const slug = uniq("rq");
  const name = "Quality Project";
  const [project] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE" }).returning();
  if (opts.prefix) {
    const confirmed = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: opts.host, pathPrefix: opts.prefix });
    if (!confirmed.ok) throw new Error("route confirm failed: " + confirmed.refusal);
    if (opts.routeClass) {
      const classified = await classifySourceRoute(ctx.db, { routeId: confirmed.itemId, routeClass: opts.routeClass });
      if (!classified.ok) throw new Error("route classify failed: " + classified.refusal);
    }
  }
  return { id: project.id, name, slug };
}

async function makeJob(projectId: string, question = "does protocol revenue reach the token?") {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId,
      originalQuestion: question,
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

const targetFor = (project: { id: string; name: string; slug: string }) => (item: ComponentWorkItem): ComponentTarget => ({
  step: item.step,
  stepName: item.stepName,
  component: item.component,
  projectId: project.id,
  projectName: project.name,
  projectSlug: project.slug,
});

async function routeOf(projectId: string, url: string) {
  const { resolveSourceRoute } = await import("../src/server/engine/source-authority");
  return resolveSourceRoute(ctx.db, projectId, url);
}

async function observedRows(projectId: string) {
  const rows = await ctx.db
    .select({ content: projectMemoryItems.content })
    .from(projectMemoryItems)
    .where(eq(projectMemoryItems.projectId, projectId));
  return rows.map((r) => r.content as { domain?: string; proposedPrefix?: string; observed?: { parentConfirmedDomain?: string; components?: string[]; evidenceCount?: number } }).filter((c) => c.observed);
}

describe("P1 — source authority: project-owned surfaces reach the owner as auditable candidates; discovery still is not authority", () => {
  it("1. an official page outside the classified /docs prefix of a CONFIRMED domain is observed as a PATH candidate with its first segment; classification stays SOCIAL until a human acts", async () => {
    const host = `site-${uniq("h").replace(/_/g, "-")}.test`;
    const project = await makeProject({ host, prefix: "/docs", routeClass: "OFFICIAL_DOCS" });
    const [source] = await ctx.db.insert(sources).values({ url: `https://${host}/token/`, urlHash: uniq("hash"), sourceType: "OTHER" }).returning();
    const url = `https://${host}/token/`;
    const route = await routeOf(project.id, url);
    expect(route.officiality).toBe("CONFIRMED");
    expect(route.routeClass).toBeNull();
    const out = await observeSourceRouteCandidate(ctx.db, { projectId: project.id, jobId: uniq("job-").replace(/_/g, "-"), sourceId: source.id, finalUrl: url, component: "MECHANISM_SPEC", evidenceCount: 7, route });
    expect(out.outcome).toBe("OBSERVED");
    const rows = await observedRows(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe(host);
    expect(rows[0].proposedPrefix).toBe("/token");
    expect(rows[0].observed!.evidenceCount).toBe(7);
    // Nothing was promoted: the same url still resolves without a class.
    expect((await routeOf(project.id, url)).routeClass).toBeNull();
    // A classified page on the same domain is the owner's finished decision — not observed.
    const classified = await observeSourceRouteCandidate(ctx.db, { projectId: project.id, jobId: uniq("job-").replace(/_/g, "-"), sourceId: source.id, finalUrl: `https://${host}/docs/fees`, component: "MECHANISM_SPEC", evidenceCount: 3, route: await routeOf(project.id, `https://${host}/docs/fees`) });
    expect(classified).toMatchObject({ outcome: "SKIPPED", reason: "ROUTE_CONFIRMED" });
    // The root page proposes no prefix.
    const root = await observeSourceRouteCandidate(ctx.db, { projectId: project.id, jobId: uniq("job-").replace(/_/g, "-"), sourceId: source.id, finalUrl: `https://${host}/`, component: "MECHANISM_SPEC", evidenceCount: 3, route });
    expect(root).toMatchObject({ outcome: "SKIPPED", reason: "NO_PATH_PREFIX" });
    // A second observation of the same path merges; a different path is its own candidate.
    await observeSourceRouteCandidate(ctx.db, { projectId: project.id, jobId: uniq("job-").replace(/_/g, "-"), sourceId: source.id, finalUrl: `https://${host}/token/economics`, component: "DESTINATION", evidenceCount: 2, route });
    await observeSourceRouteCandidate(ctx.db, { projectId: project.id, jobId: uniq("job-").replace(/_/g, "-"), sourceId: source.id, finalUrl: `https://${host}/blog/launch`, component: "DESTINATION", evidenceCount: 1, route });
    const after = await observedRows(project.id);
    expect(after.map((r) => r.proposedPrefix).sort()).toEqual(["/blog", "/token"]);
    expect(after.find((r) => r.proposedPrefix === "/token")!.observed!.evidenceCount).toBe(9);
    expect(after.find((r) => r.proposedPrefix === "/token")!.observed!.components).toEqual(["DESTINATION", "MECHANISM_SPEC"]);
    expect(firstPathSegment("https://x.test/a/b")).toBe("/a");
    expect(firstPathSegment("https://x.test")).toBeNull();
  });

  it("2. a governance forum on a project-owned subdomain is observed with its confirmed parent named; authority still does not flow from the parent", async () => {
    const apex = `proj-${uniq("h").replace(/_/g, "-")}.test`;
    const project = await makeProject({ host: apex, prefix: "/docs", routeClass: "OFFICIAL_DOCS" });
    const forum = `forum.${apex}`;
    const url = `https://${forum}/t/jip-1-fee-switch/12`;
    const [source] = await ctx.db.insert(sources).values({ url, urlHash: uniq("hash"), sourceType: "OTHER" }).returning();
    const route = await routeOf(project.id, url);
    expect(route.officiality).toBe("CLAIMED"); // a subdomain is a different host (CORE_RULES)
    const out = await observeSourceRouteCandidate(ctx.db, { projectId: project.id, jobId: uniq("job-").replace(/_/g, "-"), sourceId: source.id, finalUrl: url, component: "GOVERNANCE_BASIS", evidenceCount: 4, route });
    expect(out.outcome).toBe("OBSERVED");
    const rows = await observedRows(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe(forum);
    expect(rows[0].proposedPrefix).toBeUndefined();
    expect(rows[0].observed!.parentConfirmedDomain).toBe(apex);
    expect((await routeOf(project.id, url)).officiality).toBe("CLAIMED");
  });
});

// ---------------------------------------------------------------------------
// P1 — CRITICAL SOURCE FAIRNESS AND A STABLE TAIL (the real search phase)
// ---------------------------------------------------------------------------

describe("P1 — critical-source fairness: each component's own best discovery gets a protected open; the tail is stable and authority-aware", () => {
  it("3+4. an official-looking governance page found only by GOVERNANCE_BASIS is opened ahead of a crowd of news pages found by earlier components; order is stable across runs", async () => {
    const apex = `proj-${uniq("h").replace(/_/g, "-")}.test`;
    const project = await makeProject({ host: apex, prefix: "/docs", routeClass: "OFFICIAL_DOCS" });
    const forumUrl = `https://forum.${apex}/t/jip-7-buyback-approved/41`;
    const docsUrl = `https://${apex}/docs/fees`;
    const news = Array.from({ length: 12 }, (_, i) => `https://coindesk.com/markets/${i}/token-news`);
    const social = Array.from({ length: 4 }, (_, i) => `https://x.com/someone/status/${1000 + i}`);

    const run = async () => {
      const jobId = await makeJob(project.id);
      const { view } = await loadJobContractView(ctx.db, jobId);
      await runSearchPhase({
        db: ctx.db,
        jobId,
        items: view.workQueue,
        target: targetFor(project),
        queryProposer: { name: "fixture", async proposeQueries(input) { return [`${input.target.component.toLowerCase()} q`]; } },
        searchGateway: {
          name: "fixture",
          async search(_q, target) {
            // Earlier components flood the pool with recognised media and
            // social pages; GOVERNANCE_BASIS alone finds the project's forum.
            const urls =
              target.component === "GOVERNANCE_BASIS"
                ? [news[0], forumUrl, social[0]]
                : target.component === "MECHANISM_SPEC"
                  ? [docsUrl, ...news.slice(1, 4)]
                  : [...news.slice(4), ...social.slice(1)];
            return urls.slice(0, 5).map((url) => ({ url, title: null, snippet: null }));
          },
        },
        maxSearchQueries: 12,
        maxResultsPerQuery: 5,
        maxQueriesPerComponent: 2,
        maxModelCostMicro: 10_000_000,
        projectId: project.id,
        queryProposerCostProfile: COST,
      });
      return { jobId, targets: await loadFetchTargets(ctx.db, jobId, project.id) };
    };

    const a = await run();
    expect(a.targets).toContain(forumUrl);
    const docsAt = a.targets.indexOf(docsUrl);
    const forumAt = a.targets.indexOf(forumUrl);
    const firstNews = Math.min(...news.filter((u) => a.targets.includes(u)).map((u) => a.targets.indexOf(u)));
    const firstSocial = Math.min(...social.filter((u) => a.targets.includes(u)).map((u) => a.targets.indexOf(u)));
    // Confirmed classified route first; the governance component's own
    // unrecognised-host discovery before any recognised news or social page.
    expect(docsAt).toBe(0);
    expect(forumAt).toBeLessThan(firstNews);
    expect(forumAt).toBeLessThan(firstSocial);
    // Recognised hosts of a class no component here admits form the tail,
    // after everything else — one contiguous block at the end.
    const tail = a.targets.filter((u) => news.includes(u) || social.includes(u));
    expect(tail.length).toBeGreaterThanOrEqual(5);
    expect(a.targets.slice(a.targets.length - tail.length)).toEqual(tail);
    expect(a.targets.slice(0, a.targets.length - tail.length)).toEqual([docsUrl, forumUrl]);

    // Same discoveries on a fresh job: identical order.
    const b = await run();
    expect(b.targets).toEqual(a.targets);

    // The protection is bounded: no url was invented, every target was discovered.
    const discovered = new Set([forumUrl, docsUrl, ...news, ...social]);
    expect(a.targets.every((u) => discovered.has(u))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The loader against persisted rows: a run that never reached a component,
// and the distinction NOT_ESTABLISHED vs NOT_ADEQUATELY_RESEARCHED end to end
// ---------------------------------------------------------------------------

describe("coverage loader — persisted rows in, record out", () => {
  it("5+6. a job whose executor established nothing, read an admissible page for some components, and never reached the rest, is classified per component from the persisted record", async () => {
    const apex = `proj-${uniq("h").replace(/_/g, "-")}.test`;
    const project = await makeProject({ host: apex, prefix: "/docs", routeClass: "OFFICIAL_DOCS" });
    const jobId = await makeJob(project.id);
    // The job's intent decides which components are critical; seed the
    // READY interpretation the product path would have written.
    const [owner] = await ctx.db.insert(users).values({}).returning();
    await ctx.db.insert(interpretations).values({
      userId: owner.id,
      researchJobId: jobId,
      originalQuestion: "does protocol revenue reach the token?",
      status: "READY",
      attempt: 1,
      result: { normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN", task_type: "PROJECT_MECHANISM", route: "DEEP_RESEARCH", status: "READY" },
    });
    const { view } = await loadJobContractView(ctx.db, jobId);
    const queue = view.workQueue;
    const { recordTraceEvent } = await import("../src/server/engine/trace-store");

    // An executor that "reads" one official page for the first two
    // components (trace only, no evidence), fails the third on transport,
    // and is interrupted before the rest.
    const executor: WorkExecutor = {
      async execute(item, c) {
        const i = queue.findIndex((q) => q.component === item.component);
        if (i <= 1) {
          await recordTraceEvent(ctx.db, { researchJobId: c.jobId, operationType: "EXTRACT_ATTEMPTED", providerKind: "EXTRACT", providerName: "fixture", patternStep: item.step, component: item.component, targetRef: `https://${apex}/docs/fees`, status: "OK" });
          return { status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT" };
        }
        return { status: "FAILED", reason: "CONTENT_FETCHER_FAILED:ContentFetchError:HTTP_ERROR:404" };
      },
    };
    const result = await runResearchController({ db: ctx.db, jobId, view, executor, now: new Date(), maxAttemptsThisRun: 3, reconcile: reconcileAndPersistComponent });
    expect(result.stopReason).toBe("INTERRUPTED");

    const coverage = await loadResearchCoverage(ctx.db, jobId);
    const byName = Object.fromEntries(coverage.components.map((c) => [c.component, c]));
    const [first, second, third, ...rest] = queue.map((q) => q.component);
    // The first two read an OFFICIAL_DOCS page, and the record says so. A
    // component that admits that class is then either checked-and-not-
    // established or, when the recovery audit still sees a known admissible
    // path (a confirmed route this fixture never searched), incomplete —
    // never "the admissible class was never inspected". A component that
    // does not admit OFFICIAL_DOCS gained nothing from the page: incomplete.
    for (const name of [first, second]) {
      const c = byName[name];
      expect(c.inspectedClasses).toEqual(["OFFICIAL_DOCS"]);
      expect(["CHECKED_AND_NOT_ESTABLISHED", "INCOMPLETE_COVERAGE"]).toContain(c.coverage);
      if (c.establishingClasses.includes("OFFICIAL_DOCS")) {
        expect(c.reasons).not.toContain("ADMISSIBLE_CLASS_NEVER_INSPECTED");
        if (c.coverage === "INCOMPLETE_COVERAGE") expect(c.reasons).toContain("KNOWN_PATHS_UNEXPLORED");
      } else {
        expect(c.coverage).toBe("INCOMPLETE_COVERAGE");
        expect(isAdequatelyResearched(c.coverage)).toBe(false);
      }
    }
    expect(byName[third].coverage).toBe("BLOCKED");
    expect(byName[third].reasons).toEqual(["SOURCE_UNAVAILABLE"]);
    for (const name of rest) expect(byName[name].coverage).toBe("NOT_REACHED");
    expect(coverage.overall).toBe("COVERAGE_LIMITED");
    expect(coverage.findings.map((f) => f.code)).toContain("CRITICAL_COMPONENT_NOT_REACHED");
    // Not a verdict: the attempt rows are unchanged by deriving coverage.
    const attempts = await ctx.db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
    expect(attempts).toHaveLength(3);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
    expect(job.state).toBe("QUEUED");
  });
});
