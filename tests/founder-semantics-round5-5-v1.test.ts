import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidence,
  interpretations,
  proofs,
  researchAttempts,
  researchClaimSupport,
  researchComponentResults,
  researchJobs,
  researchTraceEvents,
  topics,
  users,
  projects,
} from "../src/server/db/schema";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import type { WorkExecutor } from "../src/server/engine/controller";
import { acquisitionBoundaryFromAttempt } from "../src/server/engine/component-reconciler";
import type { ModelCostProfile } from "../src/server/engine/model-cost-profile";
import { ContentFetchError } from "../src/server/engine/providers/content-fetcher";
import { EvidenceExtractorUnavailableError } from "../src/server/engine/providers/evidence-extractor";
import { QueryProposerUnavailableError } from "../src/server/engine/providers/query-proposer";
import {
  isPermanentProviderRejection,
  isPermanentProviderRejectionStatus,
  ModelInputOversizedError,
  PERMANENT_PROVIDER_REJECTIONS,
  TokenCountUnavailableError,
} from "../src/server/engine/providers/token-gate";
import type { ExtractedFact, FetchedDocument } from "../src/server/engine/providers/types";
import { createS4WorkExecutor } from "../src/server/engine/s4-executor";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { classifySourceRoute } from "../src/server/memory/source-route-classification";
import { confirmSourceRoute } from "../src/server/memory/source-route-confirmation";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { handleResearchJobTask } from "../src/server/jobs/worker";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// ROUND 5.5 — FOUNDER SEMANTIC HARDENING: CROSS-PROJECT BINDING AND
// PROVIDER FAILURE TRUTHFULNESS.
//
// Round 5 (adversarial-core-round5-blackbox-v1) pinned three boundaries
// pending a Founder decision. The decisions are approved and implemented;
// this suite pins them over the REAL S4 executor, the real lifecycle and
// the real Postgres store, with fixture providers only (no model, no
// network, no RPC, no spend):
//
//   A  SAME TICKER != SAME PROJECT. An UNROUTED documentary source binds to
//      the project only on a strong anchor — the confirmed project name,
//      the canonical slug, or the confirmed token contract / mint — never
//      on the bare ticker. Routed sources are unchanged. GOVERNANCE is NOT
//      route-only: a public governance page with a strong anchor is still
//      usable.
//   B  TECHNICAL FAILURE != PROJECT REALITY. A permanent provider
//      rejection of a generation call (401 / 403 / 404) is capability-
//      fatal, exactly as count_tokens' permanent failures always were; it
//      never becomes NO_EVIDENCE_FOUND. Transient failures keep their one
//      retry; genuinely document-local failures stay local.
//   C  NO EVIDENCE != NOT EXTRACTED. A component whose acquired documents
//      were never inspected reads EXTRACTION_NOT_COMPLETED, not
//      NO_EVIDENCE_FOUND. Diagnostic only: same status, same footing.
//
// Not an adversarial round; does not count toward the two clean rounds.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.close();
});

// ------------------------------------------------------------------ fixture

const ALL_COMPONENTS = [
  "SOURCE_OF_VALUE",
  "FLOW_PATH",
  "MECHANISM_SPEC",
  "GOVERNANCE_BASIS",
  "EXECUTION_EVIDENCE",
  "CURRENT_STATE",
  "DESTINATION",
  "RECIPIENT",
  "NET_EFFECT",
  "DURABILITY_BASIS",
] as const;
type Component = (typeof ALL_COMPONENTS)[number];

const DAY_MS = 24 * 3600 * 1000;
const NOW = () => new Date();
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const EVM = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
const EVM_OTHER = "0x9994E35Db50125E0DF82e4c2dde62496CE330999";
const SOL = "So11111111111111111111111111111111111111112";

const CANON: Record<Component, string> = {
  SOURCE_OF_VALUE: "swap fees charged on every trade are the only source of protocol revenue",
  FLOW_PATH: "collected swap fees are forwarded from the router to the protocol treasury contract",
  MECHANISM_SPEC: "each epoch the treasury allocates half of the collected fees to the buyback module",
  GOVERNANCE_BASIS: "the allocation schedule was ratified by the token holder vote",
  EXECUTION_EVIDENCE: "the buyback module has executed a purchase in every epoch since launch",
  CURRENT_STATE: "the buyback mechanism is active as of the latest epoch",
  DESTINATION: "tokens purchased by the buyback module are sent to the burn address",
  RECIPIENT: "the burn address is owned by nobody and its balance is removed from circulation",
  NET_EFFECT: "circulating supply declines by the amount burned each epoch",
  DURABILITY_BASIS: "the allocation can only be changed by a further token holder vote",
};
const STATE_OF: Partial<Record<Component, string>> = {
  MECHANISM_SPEC: "LIVE",
  EXECUTION_EVIDENCE: "LIVE",
  CURRENT_STATE: "LIVE",
};

const COST: ModelCostProfile = {
  modelId: "fixture-test-model",
  inputPriceMicroUsdPerToken: 1,
  outputPriceMicroUsdPerToken: 1,
  maxInputTokens: 8_000,
  maxOutputTokens: 512,
  priceVersion: "test-fixture-not-production",
};

async function activeTopicId(): Promise<string> {
  const [t] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  return t.id;
}

interface Project {
  id: string;
  slug: string;
  name: string;
  ticker: string | null;
  host: string;
  govHost: string;
}

// A real onboarded project: its own docs host (confirmed + classified
// OFFICIAL_DOCS at /docs) and its own governance host (GOVERNANCE at
// /proposals); optionally a confirmed identity on Ethereum or Solana.
async function makeProject(
  opts: { name?: string; ticker?: string; identity?: { chain: "ethereum" | "solana"; tokenAddress: string } } = {},
): Promise<Project> {
  const slug = uniq("r55");
  const name = opts.name ?? `Round Five Five ${slug.replace(/_/g, " ")}`;
  const host = `docs.${slug.replace(/_/g, "-")}.example`;
  const govHost = `vote.${slug.replace(/_/g, "-")}.example`;
  const [p] = await ctx.db.insert(projects).values({ slug, name, status: "ACTIVE_CORE", ticker: opts.ticker ?? null }).returning();
  const docs = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: host, pathPrefix: "/docs" });
  if (!docs.ok) throw new Error("docs confirm failed: " + docs.refusal);
  const docsClass = await classifySourceRoute(ctx.db, { routeId: docs.itemId, routeClass: "OFFICIAL_DOCS" });
  if (!docsClass.ok) throw new Error("docs classify failed: " + docsClass.refusal);
  const gov = await confirmSourceRoute(ctx.db, { projectSlug: slug, domain: govHost, pathPrefix: "/proposals" });
  if (!gov.ok) throw new Error("gov confirm failed: " + gov.refusal);
  const govClass = await classifySourceRoute(ctx.db, { routeId: gov.itemId, routeClass: "GOVERNANCE" });
  if (!govClass.ok) throw new Error("gov classify failed: " + govClass.refusal);
  if (opts.identity) {
    const r = await confirmProjectIdentity(ctx.db, {
      projectSlug: slug,
      chain: opts.identity.chain,
      tokenAddress: opts.identity.tokenAddress,
      ticker: opts.ticker ?? "R55",
    });
    if (!r.ok) throw new Error("identity failed: " + r.refusal);
  }
  return { id: p.id, slug, name, ticker: opts.ticker ?? null, host, govHost };
}

interface FactSpec {
  fragment: string;
  mechanismState?: string | null;
}
// What the fixture extractor does for a document, every call:
//   ok        the document's facts for the requested component
//   empty     the extractor ran and read nothing for it (genuine absence)
//   fatal     a plain, document-local error (the extractor exploded)
//   401/403/404  a permanent provider REJECTION, exactly as the production
//             extractor throws it (closed diagnostic + trusted status)
//   400       INVALID_REQUEST — non-transient, request-local
//   oversized the input gate refused the document
//   transient-once   429 on the first call for the document, ok after
//   transient-always NETWORK_NO_RESPONSE on every call
//   count401  count_tokens refused permanently (the existing fatal rule)
//   truncated MAX_TOKENS_TRUNCATED on every call (full and compact)
type Extract =
  | "ok"
  | "empty"
  | "fatal"
  | "401"
  | "403"
  | "404"
  | "400"
  | "oversized"
  | "transient-once"
  | "transient-always"
  | "count401"
  | "truncated";
interface Doc {
  url: string;
  text: string;
  facts: Partial<Record<Component, FactSpec[]>>;
  fetch?: "ok" | "timeout" | "http404";
  extract?: Extract;
}

function docsUrl(project: Project, path: string): string {
  return `https://${project.host}/docs/${path}`;
}
function canonDocs(project: Project, only?: readonly Component[]): Doc[] {
  const comps = only ?? ALL_COMPONENTS;
  return comps.map((c) => ({
    url:
      c === "GOVERNANCE_BASIS" || c === "DURABILITY_BASIS"
        ? `https://${project.govHost}/proposals/${c.toLowerCase()}`
        : docsUrl(project, c.toLowerCase().replace(/_/g, "-")),
    text: `${project.name} — ${c.toLowerCase().replace(/_/g, " ")}. ${CANON[c]}.`,
    facts: { [c]: [{ fragment: CANON[c], mechanismState: STATE_OF[c] ?? null }] },
  }));
}
// A public governance platform page (no route for anyone): the text is
// exactly what the case says, nothing else.
function publicGov(text: string, key = uniq("gov")): Doc {
  return {
    url: `https://snapshot.org/#/${key.replace(/_/g, "-")}.eth/proposal/0x${"ab".repeat(16)}`,
    text,
    facts: { GOVERNANCE_BASIS: [{ fragment: CANON.GOVERNANCE_BASIS, mechanismState: "APPROVED" }] },
  };
}

interface Scenario {
  docs: Doc[];
  search?: Partial<Record<Component, string[]>>;
  proposer?: "ok" | "401";
}

function fetched(url: string, text: string): FetchedDocument {
  return {
    finalUrl: url,
    requestedUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    normalizedText: text,
    contentHash: `sha256:${url}:${text.length}`,
    fetchedAt: NOW(),
    byteLength: text.length,
  };
}

// THE REAL S4 EXECUTOR over the scenario's documents.
function executorFor(project: Project, s: Scenario): { executor: WorkExecutor; calls: Record<string, number>; extractCallsByUrl: Map<string, number> } {
  const byUrl = new Map(s.docs.map((d) => [d.url, d]));
  // The fixture's default publication date is DETERMINISTIC and monotone
  // in document order: yesterday, plus one second per document. It used
  // to be the clock at extraction time, which encoded the sequential
  // extraction order into the supersession order; under overlapped
  // extraction (speed+cost pass 2) that order is a scheduling race. The
  // production extractor reads publication dates from the document, never
  // from the clock.
  const defaultPublishedAtBase = daysAgo(1).getTime();
  const defaultPublishedAt = (finalUrl: string): Date => new Date(defaultPublishedAtBase + Math.max(0, [...byUrl.keys()].indexOf(finalUrl)) * 1000);
  const calls: Record<string, number> = { proposer: 0, search: 0, fetch: 0, extract: 0 };
  const extractCallsByUrl = new Map<string, number>();
  const served = new Set<string>();
  const executor = createS4WorkExecutor({
    db: ctx.db,
    project: { id: project.id, name: project.name, slug: project.slug, ticker: project.ticker },
    chainAcquisition: "DOCUMENTARY_ONLY",
    queryProposer: {
      name: "fixture-proposer",
      async proposeQueries(input) {
        calls.proposer += 1;
        if (s.proposer === "401") throw new QueryProposerUnavailableError("api 401 AuthenticationError", false, 401, null);
        const c = input.target.component;
        return [`${c} of ${project.name}`, `${project.name} ${c} documentation`, `${project.name} tokenomics ${c}`];
      },
    },
    searchGateway: {
      name: "fixture-search",
      async search(_query, target) {
        calls.search += 1;
        const component = target.component as Component;
        const key = `${target.step}:${component}`;
        if (served.has(key)) return [];
        served.add(key);
        const urls = s.search?.[component] ?? s.docs.filter((d) => d.facts[component]).map((d) => d.url);
        return urls.map((url) => ({ url, title: null, snippet: null }));
      },
    },
    contentFetcher: {
      name: "fixture-fetch",
      async fetch(url: string) {
        calls.fetch += 1;
        const d = byUrl.get(url);
        if (!d) throw new ContentFetchError("HTTP_ERROR", "fixture: unknown url", url, 404);
        if (d.fetch === "timeout") throw new ContentFetchError("TIMEOUT", "fixture: timed out", url);
        if (d.fetch === "http404") throw new ContentFetchError("HTTP_ERROR", "fixture: gone", url, 404);
        return fetched(url, d.text);
      },
    },
    evidenceExtractor: {
      name: "fixture-extract",
      async extract(input) {
        calls.extract += 1;
        const url = input.document.finalUrl;
        const n = (extractCallsByUrl.get(url) ?? 0) + 1;
        extractCallsByUrl.set(url, n);
        const d = byUrl.get(url);
        if (!d) return [];
        switch (d.extract ?? "ok") {
          case "empty":
            return [];
          case "fatal":
            throw new Error("fixture extractor: exploded on this document");
          case "401":
            throw new EvidenceExtractorUnavailableError("generation failed: AUTHENTICATION_FAILED:401", false, "AUTHENTICATION_FAILED", 401);
          case "403":
            throw new EvidenceExtractorUnavailableError("generation failed: PERMISSION_DENIED:403", false, "PERMISSION_DENIED", 403);
          case "404":
            throw new EvidenceExtractorUnavailableError("generation failed: NOT_FOUND:404", false, "NOT_FOUND", 404);
          case "400":
            throw new EvidenceExtractorUnavailableError("generation failed: INVALID_REQUEST:400", false, "INVALID_REQUEST", 400);
          case "oversized":
            throw new ModelInputOversizedError(99_999, 8_000);
          case "transient-once":
            if (n === 1) throw new EvidenceExtractorUnavailableError("generation failed: RATE_LIMITED:429", true, "RATE_LIMITED", 429);
            break;
          case "transient-always":
            throw new EvidenceExtractorUnavailableError("generation failed: NETWORK_NO_RESPONSE", true, "NETWORK_NO_RESPONSE", null);
          case "count401":
            throw new TokenCountUnavailableError("count_tokens failed: AUTHENTICATION_FAILED:401", false, "AUTHENTICATION_FAILED", 401);
          case "truncated":
            throw new EvidenceExtractorUnavailableError("model output truncated (max_tokens)", false, "MAX_TOKENS_TRUNCATED");
          case "ok":
            break;
        }
        const component = input.target.component as Component;
        return (d.facts[component] ?? []).map((f) => ({
          step: input.target.step,
          component,
          statement: `${component.toLowerCase().replace(/_/g, " ")}: ${f.fragment}`,
          supportFragment: f.fragment,
          mechanismState: f.mechanismState ?? null,
          directness: "DIRECT",
          publishedAt: defaultPublishedAt(url),
          doesNotProve: "does not prove the size of the effect",
          relationship: "SUPPORTS",
        })) as ExtractedFact[];
      },
    },
    queryProposerCostProfile: COST,
    evidenceExtractorCostProfile: COST,
  });
  return { executor, calls, extractCallsByUrl };
}

async function newJob(project: Project): Promise<string> {
  const [user] = await ctx.db.insert(users).values({}).returning();
  const entitlement: EntitlementSnapshot = coreEntitlement();
  const question = "does the mechanism deliver value to the token? (PROTOCOL_REVENUE_TO_TOKEN)";
  const { job } = await createResearchJob(
    ctx.db,
    ctx.boss,
    {
      userId: user.id,
      topicId: await activeTopicId(),
      projectId: project.id,
      originalQuestion: question,
      normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: question },
      normalizedTaskHash: uniq("hash"),
      idempotencyKey: uniq("idem"),
      entitlement,
      demoLifetimeProofLimit: 1000,
    },
    { skipEnqueue: true },
  );
  await ctx.db.insert(interpretations).values({
    userId: user.id,
    researchJobId: job.id,
    originalQuestion: question,
    status: "READY",
    result: {
      status: "READY",
      project_or_asset: project.slug,
      related_entities: [],
      topic: null,
      task_type: "VERIFY_MECHANISM",
      research_task: question,
      understood_summary: null,
      user_assumptions: [],
      ambiguities: [],
      clarification_question: null,
      route: "DEEP_RESEARCH",
      normalized_intent: "PROTOCOL_REVENUE_TO_TOKEN",
      intent_confidence: 0.9,
      route_reason: "in scope",
      needs_fresh_evidence: true,
      quick_answer: null,
    },
  });
  return job.id;
}

interface Outcome {
  jobId: string;
  state: string;
  terminationReason: string | null;
  verdict: string | null;
  confidence: number | null;
  claim: string | null;
  cited: { id: string; component: string; url: string }[];
  s5: Record<string, { status: string; reasonCodes: string[]; supporting: string[]; excluded: { evidenceId: string; reason: string }[] } | null>;
  calls: Record<string, number>;
  extractCallsByUrl: Map<string, number>;
}

async function research(project: Project, s: Scenario): Promise<Outcome> {
  const { executor, calls, extractCallsByUrl } = executorFor(project, s);
  const jobId = await newJob(project);
  const handled = await handleResearchJobTask(ctx.db, jobId, executor);
  if (!handled.claimed) throw new Error("job not claimed");
  const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, jobId));
  const [proof] = await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, jobId));
  const [claim] = await ctx.db.select().from(researchClaimSupport).where(eq(researchClaimSupport.researchJobId, jobId));
  const cited = proof
    ? (await ctx.db.select().from(evidence).where(eq(evidence.proofId, proof.id))).map((r) => ({ id: r.id, component: r.component ?? "", url: r.retrievedUrl }))
    : [];
  const s5rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, jobId));
  const s5: Outcome["s5"] = {};
  for (const c of ALL_COMPONENTS) {
    const r = s5rows.find((x) => x.component === c);
    s5[c] = r
      ? {
          status: r.status,
          reasonCodes: [...(r.reasonCodes as string[])].sort(),
          supporting: [...(r.supportingEvidenceIds as string[])].sort(),
          excluded: r.excludedEvidence as { evidenceId: string; reason: string }[],
        }
      : null;
  }
  return {
    jobId,
    state: job.state,
    terminationReason: job.terminationReason,
    verdict: proof?.verdict ?? null,
    confidence: proof?.confidence ?? null,
    claim: claim?.status ?? null,
    cited,
    s5,
    calls,
    extractCallsByUrl,
  };
}

async function evidenceOf(jobId: string, component?: Component) {
  return ctx.db
    .select()
    .from(evidence)
    .where(component ? and(eq(evidence.researchJobId, jobId), eq(evidence.component, component)) : eq(evidence.researchJobId, jobId))
    .orderBy(evidence.createdAt);
}
async function traceOf(jobId: string) {
  return ctx.db.select().from(researchTraceEvents).where(eq(researchTraceEvents.researchJobId, jobId));
}
async function attemptsOf(jobId: string, component: Component) {
  return ctx.db
    .select()
    .from(researchAttempts)
    .where(and(eq(researchAttempts.researchJobId, jobId), eq(researchAttempts.component, component)))
    .orderBy(researchAttempts.attemptNumber);
}
function shapeOf(o: Outcome) {
  const s5 = Object.fromEntries(Object.entries(o.s5).map(([k, v]) => [k, v ? { status: v.status, reasonCodes: v.reasonCodes, n: v.supporting.length } : null]));
  return { verdict: o.verdict, confidence: o.confidence, claim: o.claim, citedComponents: o.cited.map((c) => c.component).sort(), s5 };
}
// Established on documentary Evidence: SUPPORTED or PARTIALLY_SUPPORTED
// (the canon docs alone leave several components at the partial rung —
// the same shape the Round 5 fixture has), never unestablished.
function established(status: string, label = ""): void {
  expect(["SUPPORTED", "PARTIALLY_SUPPORTED"], label).toContain(status);
}
function nonNegative(o: Outcome): void {
  expect(o.verdict).not.toBe("NOT_SUPPORTED");
  expect(o.verdict).not.toBe("CONTRADICTED");
  for (const v of Object.values(o.s5)) if (v) expect(v.status).not.toBe("CONTRADICTED");
}
// Nothing excluded by S5 is ever cited by the Proof.
function citesOnlySupport(o: Outcome): void {
  const excluded = new Set(Object.values(o.s5).flatMap((v) => (v ? v.excluded.map((e) => e.evidenceId) : [])));
  const supporting = new Set(Object.values(o.s5).flatMap((v) => (v ? v.supporting : [])));
  for (const c of o.cited) {
    expect(excluded.has(c.id), `cited excluded row ${c.id}`).toBe(false);
    expect(supporting.has(c.id), `cited row ${c.id} that no S5 row supports`).toBe(true);
  }
}
// A technically failed Research is not a finding about the project: no
// Proof, no claim, no verdict, and no component written as "sources say
// nothing".
function technicalFailureOnly(o: Outcome): void {
  expect(o.state).toBe("FAILED");
  expect(o.terminationReason).toBe("SYSTEM_OR_PROVIDER_FAILURE");
  expect(o.verdict).toBeNull();
  expect(o.claim).toBeNull();
  expect(o.cited).toEqual([]);
  for (const v of Object.values(o.s5)) {
    if (!v) continue;
    expect(v.status).not.toBe("CONTRADICTED");
    expect(v.status).not.toBe("NOT_SUPPORTED");
    expect(v.reasonCodes).not.toContain("NO_EVIDENCE_FOUND");
  }
}

// The Round 5 B1 shape: the target project X, its docs for everything but
// GOVERNANCE_BASIS, and ONE public governance page found for that
// component whose text the case chooses.
async function govAttack(x: Project, govText: string, extraSearch?: string[]) {
  const stray = publicGov(govText);
  const docsX = canonDocs(x, ALL_COMPONENTS.filter((c) => c !== "GOVERNANCE_BASIS"));
  const o = await research(x, { docs: [...docsX, stray], search: { GOVERNANCE_BASIS: [stray.url, ...(extraSearch ?? [])] } });
  const rows = await evidenceOf(o.jobId, "GOVERNANCE_BASIS");
  const strayRow = rows.find((r) => r.retrievedUrl === stray.url) ?? null;
  const trace = await traceOf(o.jobId);
  const rejected = trace.some((t) => t.operationType === "REJECTED_WRONG_PROJECT" && t.targetRef === stray.url);
  const [attempt] = await attemptsOf(o.jobId, "GOVERNANCE_BASIS");
  return { o, stray, strayRow, rejected, attemptReason: attempt?.reason ?? null };
}
async function govControl(x: Project) {
  return research(x, { docs: canonDocs(x, ALL_COMPONENTS.filter((c) => c !== "GOVERNANCE_BASIS")) });
}

// ================================================================== A

describe("A. SAME TICKER != SAME PROJECT — unrouted binding needs a strong anchor", () => {
  it("A1. two projects share the ticker ABC; a public governance page that names only ABC and belongs to Project B is NOT bound to Project A: refused WRONG_PROJECT before it becomes Evidence, GOVERNANCE_BASIS unestablished exactly as the control, no confidence lift, nothing cited", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC" });
    await makeProject({ name: "Alpha Bridge Network", ticker: "ABC" });
    const control = await govControl(a);
    const r = await govAttack(a, `ABC governance. Proposal 7: ${CANON.GOVERNANCE_BASIS}. Voting closed with 92% in favour of ABC holders.`);
    expect(r.strayRow).toBeNull();
    expect(r.rejected).toBe(true);
    // The audit says WHY: it was the ticker alone.
    expect(r.attemptReason).toContain("WRONG_PROJECT_TICKER_ONLY");
    expect(r.o.s5.GOVERNANCE_BASIS!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.o.s5.GOVERNANCE_BASIS!.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    expect(r.o.s5.GOVERNANCE_BASIS!.supporting).toEqual([]);
    // foreign ticker match != target project Evidence; wrong project
    // Evidence cannot raise confidence.
    expect(r.o.verdict).toBe(control.verdict);
    expect(r.o.confidence).toBe(control.confidence);
    expect(control.confidence).toBe(20);
    expect(shapeOf(r.o)).toEqual(shapeOf(control));
    expect(r.o.cited.map((c) => c.url)).not.toContain(r.stray.url);
    nonNegative(r.o);
    citesOnlySupport(r.o);
  });

  it("A2. the same page carrying Project A's confirmed full name binds under the existing semantics: persisted CLAIMED, class GOVERNANCE, admitted for GOVERNANCE_BASIS under the INSUFFICIENT_AUTHORITY cap", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC" });
    await makeProject({ name: "Alpha Bridge Network", ticker: "ABC" });
    const r = await govAttack(a, `Alpha Yield Protocol (ABC) governance. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(r.rejected).toBe(false);
    expect(r.strayRow).not.toBeNull();
    expect(r.strayRow!.officiality).toBe("CLAIMED");
    expect(r.strayRow!.sourceClass).toBe("GOVERNANCE");
    expect(r.o.s5.GOVERNANCE_BASIS!.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.o.s5.GOVERNANCE_BASIS!.reasonCodes).toContain("INSUFFICIENT_AUTHORITY");
    expect(r.o.s5.GOVERNANCE_BASIS!.supporting).toEqual([r.strayRow!.id]);
    expect(r.o.verdict).not.toBe("SUPPORTED");
    nonNegative(r.o);
    citesOnlySupport(r.o);
  });

  it("A3. the same page carrying Project A's confirmed token contract (checksummed or lowercase, EVM) binds under the existing semantics; a Solana mint binds only in its exact case", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC", identity: { chain: "ethereum", tokenAddress: EVM } });
    await makeProject({ name: "Alpha Bridge Network", ticker: "ABC" });
    const checksummed = await govAttack(a, `ABC governance. Token: ${EVM}. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(checksummed.rejected).toBe(false);
    expect(checksummed.strayRow).not.toBeNull();
    expect(checksummed.o.s5.GOVERNANCE_BASIS!.status).toBe("PARTIALLY_SUPPORTED");
    const lower = await govAttack(a, `ABC governance. Token: ${EVM.toLowerCase()}. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(lower.rejected).toBe(false);
    expect(lower.strayRow).not.toBeNull();

    const s = await makeProject({ name: "Sol Yield Protocol", ticker: "SYP", identity: { chain: "solana", tokenAddress: SOL } });
    const exact = await govAttack(s, `SYP governance. Mint: ${SOL}. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(exact.rejected).toBe(false);
    expect(exact.strayRow).not.toBeNull();
    // base58 is case-significant: a re-cased string is another value.
    const recased = await govAttack(s, `SYP governance. Mint: ${SOL.toLowerCase()}. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(recased.rejected).toBe(true);
    expect(recased.strayRow).toBeNull();
  });

  it("A4. same ticker + a DIFFERENT contract: refused, unconfirmed — a contract is an anchor only when it is the confirmed one", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC", identity: { chain: "ethereum", tokenAddress: EVM } });
    const control = await govControl(a);
    const r = await govAttack(a, `ABC governance. Token: ${EVM_OTHER}. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(r.rejected).toBe(true);
    expect(r.strayRow).toBeNull();
    expect(r.o.s5.GOVERNANCE_BASIS!.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    expect(shapeOf(r.o)).toEqual(shapeOf(control));
    // A page that names a contract the project does not own is not
    // "contradicting" anything either: nothing negative follows.
    nonNegative(r.o);
  });

  it("A5. same ticker + Project B's full name: must not bind Project A", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC" });
    const b = await makeProject({ name: "Alpha Bridge Network", ticker: "ABC" });
    const control = await govControl(a);
    const r = await govAttack(a, `${b.name} (ABC) governance. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(r.rejected).toBe(true);
    expect(r.strayRow).toBeNull();
    expect(r.attemptReason).toContain("WRONG_PROJECT_TICKER_ONLY");
    expect(shapeOf(r.o)).toEqual(shapeOf(control));
    expect(r.o.confidence).toBe(20);
  });

  it("A6. an official ROUTED source for Project A that mentions only the ticker: unchanged — the confirmed route is the anchor, the row is CONFIRMED, the component is SUPPORTED", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC" });
    const docs = canonDocs(a);
    // Every official page says "ABC" and never the project name.
    for (const d of docs) d.text = d.text.replace(a.name, "ABC");
    expect(docs.every((d) => !d.text.includes(a.name))).toBe(true);
    const o = await research(a, { docs });
    expect(o.state).toBe("SUCCEEDED");
    const rows = await evidenceOf(o.jobId);
    expect(rows.length).toBe(ALL_COMPONENTS.length);
    expect(rows.every((r) => r.officiality === "CONFIRMED")).toBe(true);
    for (const c of ["SOURCE_OF_VALUE", "FLOW_PATH", "MECHANISM_SPEC", "GOVERNANCE_BASIS", "DESTINATION"] as const) {
      established(o.s5[c]!.status, c);
      expect(o.s5[c]!.reasonCodes).not.toContain("INSUFFICIENT_AUTHORITY");
    }
    const trace = await traceOf(o.jobId);
    expect(trace.some((t) => t.operationType === "REJECTED_WRONG_PROJECT")).toBe(false);
    citesOnlySupport(o);
  });

  it("A7. GOVERNANCE is NOT route-only: a public governance page with a strong Project A anchor (name) is class GOVERNANCE without any route and still establishes GOVERNANCE_BASIS to its CLAIMED ceiling; the same page on the ticker alone does not", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC" });
    const anchored = await govAttack(a, `Alpha Yield Protocol governance forum — ABC holders. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(anchored.strayRow).not.toBeNull();
    expect(anchored.strayRow!.sourceClass).toBe("GOVERNANCE");
    expect(anchored.strayRow!.officiality).toBe("CLAIMED");
    expect(anchored.o.s5.GOVERNANCE_BASIS!.status).toBe("PARTIALLY_SUPPORTED");
    expect(anchored.o.s5.GOVERNANCE_BASIS!.supporting).toEqual([anchored.strayRow!.id]);
    const bare = await govAttack(a, `ABC governance forum. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(bare.strayRow).toBeNull();
    expect(bare.o.s5.GOVERNANCE_BASIS!.status).toBe("INSUFFICIENT_EVIDENCE");
    // The anchored run is at most the CLAIMED ceiling — never SUPPORTED —
    // and the bare run is never stronger than it.
    expect(anchored.o.verdict).not.toBe("SUPPORTED");
    expect(bare.o.confidence!).toBeLessThanOrEqual(anchored.o.confidence!);
  });

  it("A8. the Round 5 B1 attack end to end (Nova Protocol vs Nova Finance, NOVA): the attacked Research equals the safe control semantically — no confidence uplift from the foreign governance row", async () => {
    const x = await makeProject({ name: "Nova Protocol", ticker: "NOVA" });
    const control = await govControl(x);
    const r = await govAttack(x, `Nova Finance (NOVA) governance. NIP-7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(r.strayRow).toBeNull();
    expect(r.rejected).toBe(true);
    expect(shapeOf(r.o)).toEqual(shapeOf(control));
    expect(control.confidence).toBe(20);
    expect(r.o.confidence).toBe(20);
    expect(r.o.verdict).toBe(control.verdict);
    expect(r.o.s5.GOVERNANCE_BASIS!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.o.cited.map((c) => c.url)).not.toContain(r.stray.url);
  });

  it("A9. the anchor must be in the document, not in the search result or the extractor's claim: a page whose text names nothing about Project A is refused even when the search found it for Project A and the extractor returns a traceable fact", async () => {
    const a = await makeProject({ name: "Alpha Yield Protocol", ticker: "ABC" });
    const r = await govAttack(a, `Governance forum. Proposal 7: ${CANON.GOVERNANCE_BASIS}.`);
    expect(r.rejected).toBe(true);
    expect(r.strayRow).toBeNull();
    expect(r.attemptReason).not.toContain("WRONG_PROJECT_TICKER_ONLY");
  });
});

// ================================================================== B

describe("B. TECHNICAL FAILURE != PROJECT REALITY — permanent generation rejection is capability-fatal", () => {
  for (const status of ["401", "403", "404"] as const) {
    it(`B1-3. the generation call is rejected ${status} before any extraction: capability-level technical failure — the job is FAILED / SYSTEM_OR_PROVIDER_FAILURE, no Proof, no NO_EVIDENCE_FOUND, exactly one refused call, no EXTRACT_FAILED row`, async () => {
      const p = await makeProject();
      const docs = canonDocs(p);
      for (const d of docs) d.extract = status;
      const o = await research(p, { docs });
      technicalFailureOnly(o);
      expect(o.calls.extract).toBe(1);
      const trace = await traceOf(o.jobId);
      const refused = trace.filter((t) => t.operationType === "MODEL_CALL_ATTEMPTED" && t.status === "FAILED");
      expect(refused).toHaveLength(1);
      expect(refused[0].diagnosticCode).toBe(
        status === "401" ? "AUTHENTICATION_FAILED:401" : status === "403" ? "PERMISSION_DENIED:403" : "NOT_FOUND:404",
      );
      expect(trace.filter((t) => t.operationType === "EXTRACT_FAILED")).toHaveLength(0);
      expect(await evidenceOf(o.jobId)).toEqual([]);
      // provider credential rejection != absence of project Evidence
      const s5rows = await ctx.db.select().from(researchComponentResults).where(eq(researchComponentResults.researchJobId, o.jobId));
      for (const r of s5rows) expect(r.reasonCodes).not.toContain("NO_EVIDENCE_FOUND");
    });
  }

  it("B4. the rejection lands after one component already extracted valid Evidence: that Evidence stays auditable, the terminal state is the technical failure, and the remaining components are NOT represented as 'sources say nothing'", async () => {
    const p = await makeProject();
    const docs = canonDocs(p);
    for (const d of docs) if (!d.facts.SOURCE_OF_VALUE) d.extract = "401";
    const o = await research(p, { docs });
    technicalFailureOnly(o);
    const sov = await evidenceOf(o.jobId, "SOURCE_OF_VALUE");
    expect(sov.length).toBe(1);
    expect(sov[0].officiality).toBe("CONFIRMED");
    expect(await evidenceOf(o.jobId)).toHaveLength(1);
    // The component that was read is reconciled on what it has; nothing
    // after it is written as absence.
    if (o.s5.SOURCE_OF_VALUE) established(o.s5.SOURCE_OF_VALUE.status);
    for (const c of ALL_COMPONENTS) {
      if (c === "SOURCE_OF_VALUE") continue;
      expect(o.s5[c]?.reasonCodes ?? []).not.toContain("NO_EVIDENCE_FOUND");
      expect(o.s5[c]?.status ?? "INSUFFICIENT_EVIDENCE").toBe("INSUFFICIENT_EVIDENCE");
    }
    expect(o.calls.extract).toBe(2);
    // Not verifiable: there is no Proof row to verify (H10 territory).
    expect((await ctx.db.select().from(proofs).where(eq(proofs.researchJobId, o.jobId))).length).toBe(0);
  });

  it("B5. a transient 429 on the first call keeps its ONE retry and succeeds; a document failing transiently on both attempts is document-local, the job completes, nothing is fatal", async () => {
    const p = await makeProject();
    const once = canonDocs(p);
    once.find((d) => d.facts.DESTINATION)!.extract = "transient-once";
    const o = await research(p, { docs: once });
    expect(o.state).toBe("SUCCEEDED");
    expect(o.extractCallsByUrl.get(once.find((d) => d.facts.DESTINATION)!.url)).toBe(2);
    established(o.s5.DESTINATION!.status);

    const always = canonDocs(p);
    const dead = always.find((d) => d.facts.DESTINATION)!;
    dead.extract = "transient-always";
    const o2 = await research(p, { docs: always });
    expect(o2.state).toBe("SUCCEEDED");
    expect(o2.extractCallsByUrl.get(dead.url)).toBe(2);
    expect(o2.s5.DESTINATION!.status).toBe("INSUFFICIENT_EVIDENCE");
    // Read, not inspected (decision C) — never "nothing found".
    expect(o2.s5.DESTINATION!.reasonCodes).toEqual(["EXTRACTION_NOT_COMPLETED"]);
    established(o2.s5.SOURCE_OF_VALUE!.status);
    nonNegative(o2);
  });

  it("B6. one malformed document with a healthy provider: the failure stays document-local — the job completes, the component is unestablished with the truthful reason, every other component establishes", async () => {
    const p = await makeProject();
    const docs = canonDocs(p);
    docs.find((d) => d.facts.MECHANISM_SPEC)!.extract = "fatal";
    const o = await research(p, { docs });
    expect(o.state).toBe("SUCCEEDED");
    expect(o.verdict).not.toBeNull();
    expect(o.s5.MECHANISM_SPEC!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.s5.MECHANISM_SPEC!.reasonCodes).toEqual(["EXTRACTION_NOT_COMPLETED"]);
    // EXECUTION_EVIDENCE and NET_EFFECT are not documentary components;
    // every documentary one except the failed document's establishes.
    for (const c of ALL_COMPONENTS) if (c !== "MECHANISM_SPEC" && c !== "NET_EFFECT" && c !== "EXECUTION_EVIDENCE") established(o.s5[c]!.status, c);
    // extraction failure != project contradiction; != proof the claim is
    // unsupported
    nonNegative(o);
    expect(o.verdict).not.toBe("SUPPORTED");
    citesOnlySupport(o);
    const trace = await traceOf(o.jobId);
    expect(trace.some((t) => t.operationType === "EXTRACT_FAILED" && t.component === "MECHANISM_SPEC")).toBe(true);
  });

  it("B6b. a non-transient, request-local 400 (INVALID_REQUEST) is NOT a permanent rejection of the caller: document-local, the job completes", async () => {
    const p = await makeProject();
    const docs = canonDocs(p);
    docs.find((d) => d.facts.MECHANISM_SPEC)!.extract = "400";
    const o = await research(p, { docs });
    expect(o.state).toBe("SUCCEEDED");
    expect(o.s5.MECHANISM_SPEC!.reasonCodes).toEqual(["EXTRACTION_NOT_COMPLETED"]);
    established(o.s5.SOURCE_OF_VALUE!.status);
    nonNegative(o);
  });

  it("B7. count_tokens 401, generation 401 and a proposer 401 now follow the same capability-level classification: each ends the job as the same technical failure with no Proof", async () => {
    const p = await makeProject();
    const gen = canonDocs(p);
    gen.find((d) => d.facts.DESTINATION)!.extract = "401";
    const byGeneration = await research(p, { docs: gen });
    const cnt = canonDocs(p);
    cnt.find((d) => d.facts.DESTINATION)!.extract = "count401";
    const byCount = await research(p, { docs: cnt });
    const byProposer = await research(p, { docs: canonDocs(p), proposer: "401" });
    for (const o of [byGeneration, byCount, byProposer]) technicalFailureOnly(o);
    expect(byProposer.calls.proposer).toBe(1);
    expect(byProposer.calls.extract).toBe(0);
  });

  it("B8. the shared classification is closed: exactly 401 / 403 / 404, membership-gated, and INVALID_REQUEST / RATE_LIMITED / output classes / null / forged values are never permanent rejections", () => {
    expect([...PERMANENT_PROVIDER_REJECTIONS]).toEqual(["AUTHENTICATION_FAILED", "PERMISSION_DENIED", "NOT_FOUND"]);
    for (const d of PERMANENT_PROVIDER_REJECTIONS) expect(isPermanentProviderRejection(d)).toBe(true);
    for (const d of ["INVALID_REQUEST", "RATE_LIMITED", "PROVIDER_SERVER_ERROR", "NETWORK_NO_RESPONSE", "UNCLASSIFIED_PROVIDER_ERROR", "MAX_TOKENS_TRUNCATED", "OUTPUT_NOT_JSON", "OUTPUT_SCHEMA_INVALID", null, undefined, "", "authentication_failed", "AUTHENTICATION_FAILED ", 401]) {
      expect(isPermanentProviderRejection(d), String(d)).toBe(false);
    }
    for (const s of [401, 403, 404]) expect(isPermanentProviderRejectionStatus(s)).toBe(true);
    for (const s of [400, 422, 429, 500, 503, null, undefined, "401", 401.5]) expect(isPermanentProviderRejectionStatus(s), String(s)).toBe(false);
  });
});

// ================================================================== C

describe("C. NO EVIDENCE != NOT EXTRACTED — the truthful diagnostic", () => {
  it("C1. document acquired, extraction attempted, document-local failure: EXTRACTION_NOT_COMPLETED, not NO_EVIDENCE_FOUND — and the same for the oversized-only shape and a truncated output whose compact retry also fails", async () => {
    const p = await makeProject();
    for (const how of ["fatal", "oversized", "truncated"] as const) {
      const docs = canonDocs(p);
      const target = docs.find((d) => d.facts.DESTINATION)!;
      target.extract = how;
      const o = await research(p, { docs });
      expect(o.state, how).toBe("SUCCEEDED");
      expect(o.s5.DESTINATION!.status, how).toBe("INSUFFICIENT_EVIDENCE");
      expect(o.s5.DESTINATION!.reasonCodes, how).toEqual(["EXTRACTION_NOT_COMPLETED"]);
      const [attempt] = await attemptsOf(o.jobId, "DESTINATION");
      expect(attempt.status, how).toBe(how === "oversized" ? "SKIPPED" : "FAILED");
      expect(attempt.reason!.split(";")[0].trim(), how).toBe(how === "oversized" ? "EXTRACTION_NOT_COMPLETED" : "EVIDENCE_EXTRACTOR_UNAVAILABLE");
      if (how === "truncated") expect(o.extractCallsByUrl.get(target.url)).toBe(2);
      nonNegative(o);
    }
  });

  it("C2. document extracted and genuinely empty for the component: NO_EVIDENCE_FOUND remains valid", async () => {
    const p = await makeProject();
    const docs = canonDocs(p);
    docs.find((d) => d.facts.DESTINATION)!.extract = "empty";
    const o = await research(p, { docs });
    expect(o.state).toBe("SUCCEEDED");
    expect(o.s5.DESTINATION!.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    const [attempt] = await attemptsOf(o.jobId, "DESTINATION");
    expect(attempt.status).toBe("SKIPPED");
    expect(attempt.reason).not.toContain("EXTRACTION_NOT_COMPLETED");
  });

  it("C3. document never opened (fetch timeout, HTTP 404, or nothing found to open): NO_EVIDENCE_FOUND, never EXTRACTION_NOT_COMPLETED — the stage was not reached", async () => {
    const p = await makeProject();
    for (const how of ["timeout", "http404", "unfound"] as const) {
      const docs = canonDocs(p);
      const target = docs.find((d) => d.facts.DESTINATION)!;
      if (how === "unfound") docs.splice(docs.indexOf(target), 1);
      else target.fetch = how;
      const o = await research(p, { docs, ...(how === "unfound" ? { search: { DESTINATION: [] } } : {}) });
      expect(o.state, how).toBe("SUCCEEDED");
      expect(o.s5.DESTINATION!.status, how).toBe("INSUFFICIENT_EVIDENCE");
      expect(o.s5.DESTINATION!.reasonCodes, how).toEqual(["NO_EVIDENCE_FOUND"]);
      expect(o.calls.extract, how).toBe(ALL_COMPONENTS.length - 1);
    }
  });

  it("C3b. mixed: one document fails extraction and another for the same component is read and establishes — no boundary code, the component is SUPPORTED on the read row alone", async () => {
    const p = await makeProject();
    const docs = canonDocs(p);
    const good = docs.find((d) => d.facts.DESTINATION)!;
    const bad: Doc = { url: docsUrl(p, "destination-appendix"), text: `${p.name} appendix. ${CANON.DESTINATION}.`, facts: { DESTINATION: [{ fragment: CANON.DESTINATION }] }, extract: "fatal" };
    const o = await research(p, { docs: [...docs, bad], search: { DESTINATION: [bad.url, good.url] } });
    expect(o.state).toBe("SUCCEEDED");
    established(o.s5.DESTINATION!.status);
    expect(o.s5.DESTINATION!.reasonCodes).not.toContain("EXTRACTION_NOT_COMPLETED");
    expect(o.s5.DESTINATION!.reasonCodes).not.toContain("NO_EVIDENCE_FOUND");
    expect(o.s5.DESTINATION!.supporting).toHaveLength(1);
    citesOnlySupport(o);
  });

  it("C4. the diagnostic never moves the verdict or the confidence: a document that failed extraction and a document that was read and said nothing yield the same Proof except for the reason code", async () => {
    const p = await makeProject();
    const silent = canonDocs(p);
    silent.find((d) => d.facts.DESTINATION)!.extract = "empty";
    const unread = canonDocs(p);
    unread.find((d) => d.facts.DESTINATION)!.extract = "fatal";
    const a = await research(p, { docs: silent });
    const b = await research(p, { docs: unread });
    expect(a.s5.DESTINATION!.reasonCodes).toEqual(["NO_EVIDENCE_FOUND"]);
    expect(b.s5.DESTINATION!.reasonCodes).toEqual(["EXTRACTION_NOT_COMPLETED"]);
    expect(b.verdict).toBe(a.verdict);
    expect(b.confidence).toBe(a.confidence);
    expect(b.claim).toBe(a.claim);
    const strip = (o: Outcome) => ({ ...shapeOf(o), s5: Object.fromEntries(Object.entries(shapeOf(o).s5).map(([k, v]) => [k, v && k !== "DESTINATION" ? v : null])) });
    expect(strip(b)).toEqual(strip(a));
    // diagnostic reason codes do not invent semantic strength
    nonNegative(a);
    nonNegative(b);
  });

  it("C5. the ONE reduction from a persisted attempt to a boundary: only the executor's own terminal reasons under their own status map, everything else is null", () => {
    expect(acquisitionBoundaryFromAttempt({ status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE" })).toBe("EXTRACTION_NOT_COMPLETED");
    expect(acquisitionBoundaryFromAttempt({ status: "FAILED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE; source-route observations: EXTRACT_FAILED:OUTPUT_NOT_JSON" })).toBe("EXTRACTION_NOT_COMPLETED");
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "EXTRACTION_NOT_COMPLETED; source-route observations: X" })).toBe("EXTRACTION_NOT_COMPLETED");
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "SEARCH_BUDGET_EXHAUSTED" })).toBe("SEARCH_BUDGET_EXHAUSTED");
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "NO_ADMISSIBLE_ROUTE" })).toBe("NO_ADMISSIBLE_ROUTE");
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE" })).toBeNull();
    expect(acquisitionBoundaryFromAttempt({ status: "FAILED", reason: "EXTRACTION_NOT_COMPLETED" })).toBeNull();
    expect(acquisitionBoundaryFromAttempt({ status: "SUCCEEDED", reason: "EVIDENCE_EXTRACTOR_UNAVAILABLE" })).toBeNull();
    expect(acquisitionBoundaryFromAttempt({ status: "FAILED", reason: "QUERY_PROPOSER_FAILED:QueryProposerUnavailableError" })).toBeNull();
    expect(acquisitionBoundaryFromAttempt({ status: "SKIPPED", reason: "NO_TRACEABLE_FACTS_FOR_COMPONENT; source-route observations: EXTRACTION_NOT_COMPLETED" })).toBeNull();
    expect(acquisitionBoundaryFromAttempt({ status: "STARTED", reason: null })).toBeNull();
    expect(acquisitionBoundaryFromAttempt(null)).toBeNull();
  });
});
