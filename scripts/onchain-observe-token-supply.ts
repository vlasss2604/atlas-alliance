// ONE bounded TOKEN_SUPPLY read that becomes EVIDENCE — for whichever
// evidence environment the project's confirmed identity lives in.
//
// Owner-authorized execution only. This is the generic persisting sibling
// of onchain-smoke.ts (read-and-report, Solana-literal, persists nothing)
// and of onchain-observe-account.ts (persisting, ACCOUNT_INFO, Solana-
// literal). It exists because the deterministic TOKEN_SUPPLY path — intent,
// exact-environment retriever, canonical artifact, binding, Evidence — lived
// only inside the Research executor, and there was no bounded operator way
// to exercise it end to end without launching a whole Research.
//
// THE OPERATOR NAMES A PROJECT, AND NOTHING ELSE ABOUT THE CHAIN. No chain,
// no network, no token address on the command line: all three come from the
// project's confirmed ACTIVE PROJECT_IDENTITY, read through the SAME
// resolver the Research executor uses, and from the code-owned environment
// table. A project with no confirmed identity, more than one ACTIVE
// identity, an identity without a token, or an identity on a chain with no
// implemented environment is refused before anything is constructed. No
// SOURCE_ROUTE, document, explorer page or ticker is consulted: a website is
// not needed to read a chain, and reading a chain proves nothing about a
// website.
//
// NO CHAIN BRANCHING. The identity's chain becomes an environment through
// onchainEnvironmentFor; the environment becomes a retriever through the
// transport's per-environment factory; the intent is addressed to that
// environment. The word "solana" and the word "ethereum" do not appear in
// the code below, and a test asserts it. A Solana identity is served by the
// Solana implementation, an Ethereum identity by the EVM one, and an
// identity whose environment has no endpoint configured here is refused —
// never served by the other.
//
// EXACTLY ONE OBSERVATION. One intent, TOKEN_SUPPLY, a module constant that
// no argument can change; one retriever.retrieve; no retry, no loop, no
// second intent, no promotion, no account read, no signature scan, no
// search, no document, no model. What one observation costs in RPC requests
// is the environment's own business (one for Solana; four for the EVM
// adapter, which verifies the chain id and pins two reads to one finalized
// block) — this script issues one intent and never reasons about requests.
//
// WHAT IT WRITES, and nothing else — the same rows the persisting sibling
// writes, through the same production functions:
//   research_jobs        ONE owner-attributed job describing exactly this
//                        observation (see JOB HONESTY), never enqueued
//   users                one row, the job's owner-side subject
//   sources              the canonical atlas-onchain:// URI's identity row,
//                        created by the production artifact path
//   onchain_artifacts    the retrieval itself, RESEARCH_JOB origin
//   evidence             the synthesized fact, onchainArtifactId set
//   research_component_results  the reconciliation of the one component
//
// JOB HONESTY. Evidence requires a job — evidence.research_job_id is NOT
// NULL — so an Evidence-writing entrypoint MUST create one, and the job IS
// the operation: one owner-authorized bounded on-chain observation, budget
// one sourceOpen, zero searches, zero model spend, skipEnqueue so no worker
// ever picks it up. Its originalQuestion and normalizedTask say exactly that
// and claim no broader research. Nothing here writes Research Memory
// (project_memory_items): promotion to memory remains the separate,
// VERIFIED-only owner path it always was.
//
// WHAT THE ANSWER IS NOT. A total-supply reading says what the token's
// on-chain supply was at one finalized position. It is not circulating
// supply, not a burn, not a change, not a mechanism. Everything Evidence may
// and may not establish is decided by production synthesis and
// reconciliation, never by this script.
//
// Run (owner-authorized only):
//   npx tsx scripts/onchain-observe-token-supply.ts --project=<slug> [--component=<C>]
//
// The endpoint is read from the environment by the same code-owned
// (chain, network) -> env-var allowlist production uses; it is never
// printed. --component defaults to CURRENT_STATE and must be a Pattern
// component establishable by ONCHAIN_VERIFIABLE; its step comes from the
// Pattern, not from the operator.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import { INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { createDatabase, type Database } from "../src/server/db/client";
import { projectMemoryItems, projects, topics, users } from "../src/server/db/schema";
import {
  resolveConfirmedIdentity,
  type ConfirmedProjectIdentity,
} from "../src/server/domain/project-identity";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding, type OnchainBindingOutcome } from "../src/server/engine/onchain-binding";
import { onchainEnvironmentFor } from "../src/server/engine/onchain-environment";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import type { OnchainRetriever } from "../src/server/engine/providers/onchain-retriever";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type {
  OnchainArtifact,
  OnchainEnvironment,
  OnchainIntent,
} from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { createBoss } from "../src/server/jobs/queue";

// The ONE intent this entrypoint can ever issue. A constant, not a
// parameter: an RPC method must not be selectable from the command line.
const INTENT_KIND = "TOKEN_SUPPLY" as const;
const DEFAULT_COMPONENT = "CURRENT_STATE";

export type TokenSupplyObservationRefusal =
  | "PROJECT_NOT_FOUND"
  | "NOT_IN_LIVE_ALLOWLIST"
  | "INTERNAL_ALPHA_DISABLED"
  | "UNKNOWN_COMPONENT"
  | "COMPONENT_NOT_ONCHAIN"
  | "NO_ACTIVE_IDENTITY"
  | "AMBIGUOUS_IDENTITY"
  | "IDENTITY_WITHOUT_TOKEN"
  | "ENVIRONMENT_NOT_IMPLEMENTED"
  | "RETRIEVER_NOT_CONFIGURED"
  | "INTENT_NOT_SUPPORTED"
  | "RETRIEVAL_FAILED"
  | "NOT_PERSISTED";

export type TokenSupplyObservationOutcome =
  | { ok: false; refusal: TokenSupplyObservationRefusal; detail: string; jobId: string | null }
  | {
      ok: true;
      jobId: string;
      environment: OnchainEnvironment;
      identity: ConfirmedProjectIdentity;
      component: string;
      step: number;
      artifact: OnchainArtifact;
      binding: OnchainBindingOutcome;
      artifactId: string;
      evidenceIds: string[];
      reconciliation: { status: string; reasonCodes: unknown };
    };

export interface TokenSupplyObservationDeps {
  db: Database;
  boss: PgBoss;
  projectSlug: string;
  component?: string;
  // Seams, so every refusal and the whole persistence path are testable
  // without a network. Production passes none of them: the retriever comes
  // from the transport's per-environment factory, the allowlist is the
  // owner's, and the internal-alpha gate is read from product_config.
  resolveRetriever?: (environment: OnchainEnvironment) => OnchainRetriever | null;
  liveAllowlist?: ReadonlySet<string>;
  log?: (line: string) => void;
}

// Which Pattern step a component belongs to. Read from the Pattern so the
// operator never states a step, and so the Evidence target is exactly what
// Research would use for the same component.
function patternStepOf(component: string): number | null {
  for (const [step, components] of Object.entries(PATTERN_V1_CONTENT.requiredComponents)) {
    if (components.includes(component)) return Number(step);
  }
  return null;
}

export async function observeTokenSupply(
  deps: TokenSupplyObservationDeps,
): Promise<TokenSupplyObservationOutcome> {
  const { db, boss, projectSlug } = deps;
  const component = deps.component ?? DEFAULT_COMPONENT;
  const log = deps.log ?? (() => {});
  const refuse = (
    refusal: TokenSupplyObservationRefusal,
    detail: string,
    jobId: string | null = null,
  ): TokenSupplyObservationOutcome => ({ ok: false, refusal, detail, jobId });

  const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug));
  if (!project) return refuse("PROJECT_NOT_FOUND", `project not found: ${projectSlug}`);

  // The same live allowlist every other spending owner entrypoint honours.
  // Which projects may make live calls is an owner decision (D-126), never
  // a consequence of an identity being confirmed.
  const allowlist = deps.liveAllowlist ?? INTERNAL_ALPHA_LIVE_PROJECT_SLUGS;
  if (!allowlist.has(projectSlug)) {
    return refuse("NOT_IN_LIVE_ALLOWLIST", `project "${projectSlug}" is not in the internal-alpha live allowlist`);
  }
  const config = await loadProductConfig(db);
  if (!config.internal_alpha_enabled) {
    return refuse("INTERNAL_ALPHA_DISABLED", "internal_alpha_enabled is false (product_config)");
  }

  // The component must be establishable by a chain read per the ACTIVE
  // Pattern — not per this script's opinion — and it must have a step.
  let establishing: readonly string[];
  try {
    establishing = componentRequirementsFor(PATTERN_V1_CONTENT, component).establishingClasses;
  } catch {
    return refuse("UNKNOWN_COMPONENT", `unknown component: ${component}`);
  }
  const step = patternStepOf(component);
  if (!establishing.includes("ONCHAIN_VERIFIABLE") || step === null) {
    return refuse("COMPONENT_NOT_ONCHAIN", `component ${component} is not establishable by ONCHAIN_VERIFIABLE`);
  }

  // IDENTITY, through the canonical resolver and nowhere else. The
  // resolver's own rule is "first structurally valid ACTIVE row wins"; an
  // operator tool holds itself to the stricter reading and refuses when
  // more than one ACTIVE identity exists at all, rather than silently
  // observing one of them.
  const activeRows = await db
    .select({ id: projectMemoryItems.id })
    .from(projectMemoryItems)
    .where(
      and(
        eq(projectMemoryItems.projectId, project.id),
        eq(projectMemoryItems.kind, "PROJECT_IDENTITY"),
        eq(projectMemoryItems.lifecycleState, "ACTIVE"),
      ),
    );
  if (activeRows.length > 1) {
    return refuse("AMBIGUOUS_IDENTITY", `${activeRows.length} ACTIVE PROJECT_IDENTITY rows; confirm exactly one`);
  }
  const identity = await resolveConfirmedIdentity(db, project.id);
  if (!identity) return refuse("NO_ACTIVE_IDENTITY", "no ACTIVE PROJECT_IDENTITY for this project");
  if (!identity.tokenAddress) {
    return refuse("IDENTITY_WITHOUT_TOKEN", `identity on ${identity.chain} carries no token address`);
  }
  const anchor = identity.tokenAddress;

  // ENVIRONMENT, from the code-owned table. A chain with no implemented
  // environment is refused here; nothing else is tried.
  const environment = onchainEnvironmentFor(identity.chain);
  if (environment === null) {
    return refuse("ENVIRONMENT_NOT_IMPLEMENTED", `no implemented on-chain environment for chain ${identity.chain}`);
  }

  // RETRIEVER, for exactly that environment. Constructing one opens no
  // connection; an unconfigured environment yields null and is refused
  // before any job exists.
  const resolveRetriever =
    deps.resolveRetriever ?? ((env: OnchainEnvironment) => createProductionOnchainRetriever(env.chain, env.network));
  const retriever = resolveRetriever(environment);
  if (!retriever) {
    return refuse(
      "RETRIEVER_NOT_CONFIGURED",
      `no retriever is configured for ${environment.chain}/${environment.network}; nothing was called`,
    );
  }
  if (!retriever.supports(environment.chain, environment.network, INTENT_KIND)) {
    return refuse(
      "INTENT_NOT_SUPPORTED",
      `the ${environment.chain}/${environment.network} retriever does not serve ${INTENT_KIND}`,
    );
  }

  const intent: OnchainIntent = {
    kind: INTENT_KIND,
    chain: environment.chain,
    network: environment.network,
    projectAnchor: anchor,
    subjectKind: "token",
    subject: anchor,
  };

  log("project:          " + project.slug);
  log("identity:         " + identity.chain + " " + anchor);
  log("environment:      " + environment.chain + "/" + environment.network);
  log("component:        " + component + " (step " + step + ")");
  log("intent:           " + INTENT_KIND);
  log("canonicalUri:     " + buildCanonicalOnchainUri(intent));

  // THE JOB. Created only once everything above has passed and a read is
  // about to be issued, and described truthfully: one owner-authorized
  // bounded on-chain observation. skipEnqueue keeps the worker out of it.
  const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
  if (!topic) throw new Error("no active topic found — is the database seeded?");
  const [user] = await db.insert(users).values({}).returning();
  const createdAt = new Date();
  const entitlement: EntitlementSnapshot = {
    level: "ARI_CORE",
    capability: "FRESH_RESEARCH",
    // One bounded read; the axes this entrypoint cannot spend are zero.
    budget: { ...INTERNAL_ALPHA_V1, maxSearchQueries: 0, maxSourceOpens: 1, maxModelCostMicro: 0 },
  };
  const { job } = await createResearchJob(
    db,
    boss,
    {
      userId: user.id,
      topicId: topic.id,
      projectId: project.id,
      originalQuestion: `observe on-chain ${INTENT_KIND} of the confirmed token for component ${component}`,
      normalizedTask: {
        project_slug: project.slug,
        project_slugs: [project.slug],
        task: `perform one bounded ${INTENT_KIND} read of the project's confirmed token identity`,
      },
      normalizedTaskHash: `onchain-observe-token-supply-${createdAt.getTime()}`,
      idempotencyKey: `onchain-observe-token-supply-${user.id}-${createdAt.getTime()}`,
      entitlement,
      demoLifetimeProofLimit: config.demo_lifetime_proof_limit,
    },
    { skipEnqueue: true },
  );
  const jobId = job.id;
  log("jobId:            " + jobId + "   (owner-attributed, not enqueued)");
  log("--- performing ONE " + INTENT_KIND + " observation ---");

  // --- the one observation ---------------------------------------------
  let artifact: OnchainArtifact;
  try {
    artifact = await retriever.retrieve(intent);
  } catch (e) {
    // Adapter and transport errors are already sanitized (reason code and
    // provider label, never the endpoint or a response body).
    return refuse("RETRIEVAL_FAILED", e instanceof Error ? e.message : String(e), jobId);
  }

  log("result:           " + artifact.normalizedText);
  log("ordinal (slot):   " + artifact.provenance.slot);
  log("blockHash:        " + String(artifact.provenance.blockHash));
  log("blockTime:        " + String(artifact.provenance.blockTime));
  log("finality:         " + artifact.provenance.finality);
  log("providerId:       " + artifact.provenance.providerId);
  log("providerMethod:   " + artifact.provenance.providerMethod);
  log("rawHash:          " + artifact.provenance.rawResponseHash);
  log("artifactHash:     " + artifact.provenance.artifactHash);

  // Binding against the confirmed identity itself — the same object the
  // persistence path is handed, never a reconstruction of it.
  const binding = validateOnchainBinding(artifact, identity);
  log("binding:          " + JSON.stringify(binding));

  // --- persistence -----------------------------------------------------
  // The ONE production path: artifact + synthesized fact + Evidence, in
  // RESEARCH_JOB origin. Every Evidence property is decided by production
  // code — sourceClass ONCHAIN_VERIFIABLE, officiality CLAIMED (D-074),
  // entityBinding, directness — and none can be influenced from here.
  // Containment refusal is honest: a rejectedReason means nothing is
  // written.
  const stored = await persistOnchainArtifactAndFacts({
    db,
    jobId,
    artifact,
    identity,
    target: { step, component },
  });
  log("--- persistence ---");
  log("artifactId:       " + String(stored.artifactId));
  log("rejectedReason:   " + String(stored.rejectedReason));
  log("evidenceRows:     " + stored.evidenceIds.length);
  if (stored.rejectedReason !== null || !stored.artifactId) {
    return refuse("NOT_PERSISTED", `artifact not admitted: ${String(stored.rejectedReason)}`, jobId);
  }

  // --- reconciliation ----------------------------------------------------
  // Only after Evidence was actually persisted, only for the one
  // component, scoped to THIS job by the production function.
  const result = await reconcileAndPersistComponent(db, jobId, { step, component }, new Date());
  log("--- reconciliation (" + component + ", this job only) ---");
  log("status:           " + result.status);
  log("reasonCodes:      " + JSON.stringify(result.reasonCodes));
  log("--- done: one " + INTENT_KIND + " observation ---");

  return {
    ok: true,
    jobId,
    environment,
    identity,
    component,
    step,
    artifact,
    binding,
    artifactId: stored.artifactId,
    evidenceIds: stored.evidenceIds,
    reconciliation: { status: result.status, reasonCodes: result.reasonCodes },
  };
}

function parseArgs(argv: readonly string[]): { project: string; component?: string } | null {
  let project: string | undefined;
  let component: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--project=")) project = arg.slice("--project=".length);
    else if (arg.startsWith("--component=")) component = arg.slice("--component=".length);
    else return null; // no other flag exists — in particular no chain, network or address
  }
  if (!project) return null;
  return component === undefined ? { project } : { project, component };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "usage: npx tsx scripts/onchain-observe-token-supply.ts --project=<slug> [--component=<COMPONENT>]",
    );
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  const boss = createBoss();
  try {
    const outcome = await observeTokenSupply({
      db,
      boss,
      projectSlug: args.project,
      ...(args.component === undefined ? {} : { component: args.component }),
      log: (line) => console.log(line),
    });
    if (!outcome.ok) {
      console.error(`[observe-token-supply] refusing — ${outcome.refusal}: ${outcome.detail}`);
      if (outcome.jobId) console.error(`[observe-token-supply] jobId ${outcome.jobId} holds no Evidence.`);
      process.exitCode = 1;
      return;
    }
    console.log("artifact:         " + outcome.artifactId);
    for (const id of outcome.evidenceIds) console.log("evidence:         " + id);
  } finally {
    await pool.end().catch(() => {});
    await boss.stop().catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith("onchain-observe-token-supply.ts")) {
  main().catch((e) => {
    console.error("OBSERVE TOKEN SUPPLY FAILED: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
