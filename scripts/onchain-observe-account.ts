// ONE bounded Solana RPC read that becomes EVIDENCE.
//
// Owner-authorized execution only. The sibling script
// onchain-account-check.ts performs the same single ACCOUNT_INFO read and
// persists NOTHING — it is a diagnostic. This one exists because a
// characterization that lives only in terminal output cannot be reconciled,
// cited, or reasoned over later. Two entrypoints rather than a --persist
// flag, so each keeps a one-sentence guarantee and the read-only one stays
// provably read-only. Same discipline as
// onchain-token-accounts.ts / onchain-derive-token-accounts.ts.
//
// WHAT IT WRITES, and nothing else:
//   research_jobs        ONE owner-attributed job, describing exactly this
//                        observation and nothing more (see JOB HONESTY)
//   users                one row, the job's owner-side subject
//   sources              the canonical atlas-onchain:// URI's identity row,
//                        sourceType ONCHAIN — created by the production
//                        artifact path, not by this script
//   onchain_artifacts    the retrieval itself, RESEARCH_JOB mode
//   evidence             the synthesized fact(s), onchainArtifactId set
//   research_component_results  the reconciliation of the requested component
//
// JOB HONESTY. Evidence requires a job — evidence.research_job_id is NOT
// NULL — so an Evidence-writing entrypoint MUST create one. That is why
// onchain-derive-token-accounts.ts refuses to: it writes no Evidence, so a
// job there would exist purely to satisfy a foreign key and would assert a
// research operation that did not happen. Here the job IS the operation:
// one owner-authorized bounded on-chain observation, and the job's
// originalQuestion and normalizedTask say exactly that — no document fetch,
// no search, no broader task is claimed. The same pattern
// extract-from-document.ts already uses for owner-run research, including
// skipEnqueue: no worker ever picks this job up, because this script does
// the work inline and then stops.
//
// THE SUBJECT MUST HAVE ADMITTED ON-CHAIN PROVENANCE, resolved from the
// database — never from the command line alone and never from a model. The
// address argument only SELECTS among already-admitted subjects; it cannot
// introduce one. resolveOnchainSubject is the gate and it runs BEFORE the
// retriever is constructed, so an ineligible subject never reaches
// transport. Two classes qualify and the gate accepts either: a
// DOCUMENTARY_LOCATOR, stated by a confirmed document, or a
// DERIVED_ONCHAIN_SUBJECT, an address a previous confirmed structured read
// returned. Both make a subject eligible to be READ; neither makes it
// authoritative, and the derived class carries no document authority
// whatsoever.
//
// EXACTLY ONE RPC. One subject, one ACCOUNT_INFO intent, one
// getAccountInfo. There is no loop, no retry, no pagination, no second
// intent, no promotion, no signature scan, no transaction fetch, no
// enumeration of the project's other admitted locators, no search, no
// documentary fetch and no model call — this file has no code path capable
// of any of those, which is asserted by test rather than promised here. In
// particular it never invokes the S4 acquisition loop, which would select
// several intents and promote more.
//
// WHAT THE ANSWER IS NOT. Characterizing an account says what the account
// IS at one slot. It is not evidence that anything was sent there, that any
// token was acquired or destroyed, or that supply changed. In particular
// NOT_TOKEN_PROGRAM_OWNED means the account is not itself an SPL token
// account — it does NOT mean the address owns no token accounts, and it
// contradicts no document. That question is TOKEN_ACCOUNTS_BY_OWNER, a
// separate bounded intent this script cannot issue.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-observe-account.ts <ADDRESS> <projectSlug> <COMPONENT> <STEP>
//
// The endpoint is read from the environment by the same code-owned
// allowlist production uses; it is never printed.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { evidence, onchainArtifacts, projects, topics, users } from "../src/server/db/schema";
import { resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import {
  resolveOnchainSubject,
  type OnchainSubjectProvenance,
} from "../src/server/engine/onchain-subject-provenance";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { createBoss } from "../src/server/jobs/queue";

// The ONE intent this entrypoint can ever issue. A constant, not a
// parameter: an RPC method must not be selectable from the command line.
const INTENT_KIND = "ACCOUNT_INFO" as const;

async function main(): Promise<void> {
  const [address, slug, component, stepRaw, ...rest] = process.argv.slice(2);
  if (!address || !slug || !component || !stepRaw || rest.length > 0) {
    console.error(
      "usage: npx tsx scripts/onchain-observe-account.ts <ADDRESS> <projectSlug> <COMPONENT> <STEP>",
    );
    process.exit(1);
  }
  const step = Number(stepRaw);
  if (!Number.isInteger(step) || step < 1 || step > 8) {
    console.error(`[observe-account] refusing — step must be an integer 1..8, got "${stepRaw}".`);
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  const boss = createBoss();
  let anchor: string;
  let provenance: OnchainSubjectProvenance;
  let jobId: string;
  let identity: Awaited<ReturnType<typeof resolveConfirmedIdentity>>;

  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) {
      console.error(`[observe-account] refusing — project not found: ${slug}`);
      process.exit(1);
    }

    // The same live allowlist every other spending owner entrypoint honours.
    // Which projects may make live calls is an owner decision (D-126), never
    // a consequence of an address being admitted.
    if (!INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(slug)) {
      console.error(`[observe-account] refusing — project "${slug}" is not in the internal-alpha live allowlist.`);
      process.exit(1);
    }
    const config = await loadProductConfig(db);
    if (!config.internal_alpha_enabled) {
      console.error("[observe-account] refusing — internal_alpha_enabled is false (product_config).");
      process.exit(1);
    }

    // The component must actually be establishable by a chain read, per the
    // ACTIVE Pattern — not per this script's opinion. A component that does
    // not admit ONCHAIN_VERIFIABLE would produce Evidence that establishes
    // nothing, and writing it would be dishonest bookkeeping.
    let requirements;
    try {
      requirements = componentRequirementsFor(PATTERN_V1_CONTENT, component);
    } catch {
      console.error(`[observe-account] refusing — unknown component: ${component}`);
      process.exit(1);
    }
    if (!requirements.establishingClasses.includes("ONCHAIN_VERIFIABLE")) {
      console.error(
        `[observe-account] refusing — component ${component} is not establishable by ONCHAIN_VERIFIABLE.`,
      );
      process.exit(1);
    }

    // The anchor is the project's confirmed identity — never the subject,
    // and never supplied on the command line.
    identity = await resolveConfirmedIdentity(db, project.id);
    if (!identity?.tokenAddress) {
      console.error("[observe-account] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[observe-account] refusing — confirmed chain is ${identity.chain}, not solana.`);
      process.exit(1);
    }
    anchor = identity.tokenAddress;

    // PROVENANCE GATE. Refused BEFORE the retriever is constructed, so an
    // ineligible subject never reaches transport. The address argument
    // selects among admitted subjects; it cannot introduce one.
    const eligibility = await resolveOnchainSubject(db, {
      subject: address,
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
    });
    if (!eligibility.eligible) {
      console.error(
        "[observe-account] refusing — this address has no admitted on-chain subject provenance: " +
          eligibility.reason,
      );
      process.exit(1);
    }
    provenance = eligibility.provenance;

    console.log("projectAnchor:    " + anchor);
    console.log("subject:          " + address);
    console.log("component:        " + component + " (step " + step + ")");
    console.log("provenance:       " + provenance.class);
    if (provenance.class === "DOCUMENTARY_LOCATOR") {
      console.log("documentedBy:     " + provenance.documents.length + " evidence row(s)");
      for (const row of provenance.documents) {
        console.log("  " + row.retrievedUrl + " :: " + String(row.summary));
        console.log("    authority:  " + String(row.sourceClass) + " / " + String(row.officiality));
        console.log("    evidenceId: " + row.evidenceId);
      }
    } else {
      console.log("derivedFrom:      " + provenance.parentSubject);
      console.log("  method:         " + provenance.derivationMethod);
      console.log("  NOTE:           technical provenance only — no documentary authority");
    }

    // THE JOB. Created here because Evidence requires one, and described
    // truthfully: one owner-authorized bounded on-chain observation. No
    // document is fetched, no query is searched and no model is called by
    // this entrypoint, so none of those is claimed. skipEnqueue keeps the
    // worker out of it — this script does the work inline.
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
        originalQuestion: `observe on-chain account ${address} for component ${component}`,
        normalizedTask: {
          project_slug: project.slug,
          project_slugs: [project.slug],
          task: `perform one bounded ${INTENT_KIND} read of one admitted on-chain subject`,
        },
        normalizedTaskHash: `onchain-observe-account-${createdAt.getTime()}`,
        idempotencyKey: `onchain-observe-account-${user.id}-${createdAt.getTime()}`,
        entitlement,
        demoLifetimeProofLimit: config.demo_lifetime_proof_limit,
      },
      { skipEnqueue: true },
    );
    jobId = job.id;
    console.log("jobId:            " + jobId + "   (owner-attributed, not enqueued)");
  } catch (e) {
    await pool.end().catch(() => {});
    await boss.stop().catch(() => {});
    throw e;
  }

  // --- the one read ---------------------------------------------------
  const retriever = createProductionOnchainRetriever("solana", "mainnet");
  if (!retriever) {
    console.error(
      "no Solana mainnet RPC endpoint is configured (SOLANA_MAINNET_RPC_URL). Nothing was called.",
    );
    await pool.end().catch(() => {});
    await boss.stop().catch(() => {});
    process.exit(1);
  }

  const intent: OnchainIntent = {
    kind: INTENT_KIND,
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "account",
    subject: address,
  };

  console.log("intent:           " + INTENT_KIND + " solana/mainnet");
  console.log("canonicalUri:     " + buildCanonicalOnchainUri(intent));
  console.log("--- performing ONE rpc read ---");

  try {
    const artifact = await retriever.retrieve(intent);

    console.log("result:           " + artifact.normalizedText);
    console.log("slot:             " + artifact.provenance.slot);
    console.log("finality:         " + artifact.provenance.finality);
    console.log("providerMethod:   " + artifact.provenance.providerMethod);
    console.log("rawHash:          " + artifact.provenance.rawResponseHash);
    console.log("artifactHash:     " + artifact.provenance.artifactHash);

    const binding = validateOnchainBinding(artifact, {
      chain: "solana",
      tokenAddress: anchor,
      ticker: null,
    });
    console.log("binding:          " + JSON.stringify(binding));

    // --- persistence -------------------------------------------------
    // The ONE production path: artifact + synthesized facts + Evidence, in
    // RESEARCH_JOB mode. Every Evidence property below is decided by
    // production code — sourceClass ONCHAIN_VERIFIABLE, officiality CLAIMED
    // (D-074, so a chain read can never independently exceed the authority
    // ceiling), entityBinding, directness DIRECT — and none of them can be
    // influenced from the command line. Containment refusal is honest: a
    // rejectedReason means nothing is written.
    const stored = await persistOnchainArtifactAndFacts({
      db,
      jobId,
      artifact,
      identity,
      target: { step, component },
    });

    console.log("--- persistence ---");
    console.log("artifactId:       " + String(stored.artifactId));
    console.log("rejectedReason:   " + String(stored.rejectedReason));
    console.log("evidenceRows:     " + stored.evidenceIds.length);

    if (stored.rejectedReason !== null || !stored.artifactId) {
      console.error("[observe-account] artifact not persisted — no Evidence written, no reconciliation run.");
      process.exit(1);
    }

    for (const row of await db.select().from(onchainArtifacts).where(eq(onchainArtifacts.id, stored.artifactId))) {
      console.log("  artifact:       " + row.id);
      console.log("    originKind:   " + row.originKind);
      console.log("    researchJob:  " + String(row.researchJobId));
      console.log("    sourceId:     " + String(row.sourceId));
      console.log("    slot:         " + row.slot);
    }
    for (const id of stored.evidenceIds) {
      const [row] = await db.select().from(evidence).where(eq(evidence.id, id));
      if (!row) continue;
      console.log("  evidence:       " + row.id);
      console.log("    class:        " + row.sourceClass + " / " + row.officiality);
      console.log("    binding:      " + String(row.entityBinding));
      console.log("    relationship: " + row.relationship + " " + row.directness);
      console.log("    artifactId:   " + String(row.onchainArtifactId));
      console.log("    summary:      " + row.summary);
      console.log("    doesNotProve: " + String(row.doesNotProve));
    }

    // --- reconciliation ------------------------------------------------
    // Runs ONLY after Evidence was actually persisted, and only for the
    // requested component. Scoped to THIS job by the production function,
    // so it judges this observation on its own and cannot alter any earlier
    // job's result — the documentary Evidence of other jobs is untouched.
    console.log("--- reconciliation (" + component + ", this job only) ---");
    const result = await reconcileAndPersistComponent(db, jobId, { step, component }, new Date());
    console.log("status:           " + result.status);
    console.log("reasonCodes:      " + JSON.stringify(result.reasonCodes));
    console.log("--- done: one rpc read ---");
  } finally {
    await pool.end().catch(() => {});
    await boss.stop().catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith("onchain-observe-account.ts")) {
  main().catch((e) => {
    // Transport errors are already sanitized (reason code + provider label,
    // never the endpoint or response body).
    console.error("OBSERVE ACCOUNT FAILED: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
