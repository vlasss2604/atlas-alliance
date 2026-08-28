// ONE bounded Solana RPC read that becomes EVIDENCE: which SPL token
// accounts for the project's confirmed mint does ONE documented address own?
//
// Owner-authorized execution only. Two siblings already exist for this
// question and neither writes Evidence: onchain-token-accounts.ts is a
// diagnostic that persists nothing, and onchain-derive-token-accounts.ts
// persists a STANDALONE artifact plus derived subjects. This one closes the
// same gap onchain-observe-account.ts closed for ACCOUNT_INFO — a separate
// entrypoint per intent rather than an --intent argument, so each keeps a
// one-sentence guarantee that a test can check.
//
// WHAT IT WRITES, and nothing else:
//   research_jobs        ONE owner-attributed job describing exactly this
//                        observation (see JOB HONESTY in
//                        onchain-observe-account.ts — identical reasoning)
//   users                one row, the job's owner-side subject
//   sources              the canonical atlas-onchain:// URI's identity row,
//                        created by the production artifact path
//   onchain_artifacts    the retrieval itself, RESEARCH_JOB mode
//   onchain_derived_subjects  one row per returned token account
//   evidence             the synthesized fact(s), onchainArtifactId set
//   research_component_results  the reconciliation of the requested component
//
// THE SUBJECT MUST HAVE ADMITTED ON-CHAIN PROVENANCE, resolved from the
// database — never from the command line alone and never from a model. Two
// classes qualify and the gate accepts either: a DOCUMENTARY_LOCATOR, stated
// by a confirmed document, or a DERIVED_ONCHAIN_SUBJECT, an address a
// previous confirmed structured read returned. Both make a subject eligible
// to be READ; neither makes it authoritative, and the derived class carries
// no document authority whatsoever.
//
// AND THE QUESTION MUST ALREADY BE WELL-FORMED. TOKEN_ACCOUNTS_BY_OWNER is a
// promotion-only intent in production (onchain-subject-promotion.ts): asking
// which token accounts an address owns is meaningful only once a prior
// observation established that the address is NOT itself a token account. A
// token account cannot answer it. This entrypoint enforces the same
// precondition from persisted state — a stored ACCOUNT_INFO artifact for this
// exact subject and anchor whose normalized result says
// NOT_TOKEN_PROGRAM_OWNED — so the owner path cannot ask earlier than the
// research path would. No such artifact means: run the ACCOUNT_INFO sibling
// first.
//
// EXACTLY ONE RPC. One owner subject, one mint from confirmed identity, one
// TOKEN_ACCOUNTS_BY_OWNER intent, one getTokenAccountsByOwner. There is no
// loop, no retry, no pagination, no ACCOUNT_INFO, no signature scan, no
// transaction fetch, no promotion, no enumeration of the project's other
// admitted locators, no search, no documentary fetch and no model call — this
// file has no code path capable of any of those, which is asserted by test.
// Returned token accounts are persisted as derived subjects so a LATER
// authorized window can read one without a repeat RPC; nothing here reads
// them, and this window ends after the single request.
//
// WHAT THE ANSWER IS NOT. A balance is a position at one slot: never a
// history, never a purpose, never proof that a buyback or a burn occurred or
// that revenue funded anything. The token-account OWNER FIELD is the RPC's
// own metadata and names no institution. And a zero result is NOT a finding
// that the address holds no RAY: production treats absence as no fact at all
// (onchain-facts.ts), so an empty answer writes NO Evidence rather than an
// invented negative.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-observe-token-accounts.ts <OWNER_ADDRESS> <projectSlug> <COMPONENT> <STEP>
//
// The endpoint is read from the environment by the same code-owned allowlist
// production uses; it is never printed.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { and, eq } from "drizzle-orm";

import { INTERNAL_ALPHA_V1, loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { evidence, onchainArtifacts, onchainDerivedSubjects, projects, topics, users } from "../src/server/db/schema";
import { resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import { componentRequirementsFor, PATTERN_V1_CONTENT } from "../src/server/domain/pattern";
import type { EntitlementSnapshot } from "../src/server/domain/types";
import { reconcileAndPersistComponent } from "../src/server/engine/component-reconciliation-store";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import { persistOnchainArtifactAndFacts } from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { formatTokenAmount } from "../src/server/engine/onchain-facts";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import {
  persistDerivedOnchainSubjects,
  resolveOnchainSubject,
  type OnchainSubjectProvenance,
} from "../src/server/engine/onchain-subject-provenance";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type { OnchainIntent, TokenAccountsByOwnerResult } from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { createBoss } from "../src/server/jobs/queue";

// The ONE intent this entrypoint can ever issue, and the ONE prior
// observation that makes it well-formed. Constants, not parameters: an RPC
// method must not be selectable from the command line.
const INTENT_KIND = "TOKEN_ACCOUNTS_BY_OWNER" as const;
const PREREQUISITE_KIND = "ACCOUNT_INFO" as const;

async function main(): Promise<void> {
  const [address, slug, component, stepRaw, ...rest] = process.argv.slice(2);
  if (!address || !slug || !component || !stepRaw || rest.length > 0) {
    console.error(
      "usage: npx tsx scripts/onchain-observe-token-accounts.ts <OWNER_ADDRESS> <projectSlug> <COMPONENT> <STEP>",
    );
    process.exit(1);
  }
  const step = Number(stepRaw);
  if (!Number.isInteger(step) || step < 1 || step > 8) {
    console.error(`[observe-token-accounts] refusing — step must be an integer 1..8, got "${stepRaw}".`);
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
      console.error(`[observe-token-accounts] refusing — project not found: ${slug}`);
      process.exit(1);
    }
    if (!INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(slug)) {
      console.error(
        `[observe-token-accounts] refusing — project "${slug}" is not in the internal-alpha live allowlist.`,
      );
      process.exit(1);
    }
    const config = await loadProductConfig(db);
    if (!config.internal_alpha_enabled) {
      console.error("[observe-token-accounts] refusing — internal_alpha_enabled is false (product_config).");
      process.exit(1);
    }

    let requirements;
    try {
      requirements = componentRequirementsFor(PATTERN_V1_CONTENT, component);
    } catch {
      console.error(`[observe-token-accounts] refusing — unknown component: ${component}`);
      process.exit(1);
    }
    if (!requirements.establishingClasses.includes("ONCHAIN_VERIFIABLE")) {
      console.error(
        `[observe-token-accounts] refusing — component ${component} is not establishable by ONCHAIN_VERIFIABLE.`,
      );
      process.exit(1);
    }

    // The anchor — and therefore the MINT this read asks about — is the
    // project's confirmed identity. It is never supplied on the command line,
    // so a caller cannot point this at an arbitrary token.
    identity = await resolveConfirmedIdentity(db, project.id);
    if (!identity?.tokenAddress) {
      console.error("[observe-token-accounts] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[observe-token-accounts] refusing — confirmed chain is ${identity.chain}, not solana.`);
      process.exit(1);
    }
    anchor = identity.tokenAddress;

    // PROVENANCE GATE, before the retriever exists.
    const eligibility = await resolveOnchainSubject(db, {
      subject: address,
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
    });
    if (!eligibility.eligible) {
      console.error(
        "[observe-token-accounts] refusing — this address has no admitted on-chain subject provenance: " +
          eligibility.reason,
      );
      process.exit(1);
    }
    provenance = eligibility.provenance;

    // PROMOTED-INTENT GATE. The same precondition production's promotion
    // rule enforces, read from persisted state: a prior ACCOUNT_INFO
    // observation of this exact subject under this exact anchor that
    // established the address is NOT itself a token account.
    const priorRows = await db
      .select({ normalizedResult: onchainArtifacts.normalizedResult })
      .from(onchainArtifacts)
      .where(
        and(
          eq(onchainArtifacts.subject, address),
          eq(onchainArtifacts.projectAnchor, anchor),
          eq(onchainArtifacts.intentKind, PREREQUISITE_KIND),
        ),
      );
    const qualifies = priorRows.some((row) => {
      const r = row.normalizedResult as { kind?: string; tokenAccountRelation?: string } | null;
      return r?.kind === PREREQUISITE_KIND && r.tokenAccountRelation === "NOT_TOKEN_PROGRAM_OWNED";
    });
    if (!qualifies) {
      console.error(
        "[observe-token-accounts] refusing — no persisted " +
          PREREQUISITE_KIND +
          " observation establishes that this subject is NOT itself a token account.",
      );
      console.error("  Asking which token accounts an address owns is well-formed only after that.");
      console.error("  Run scripts/onchain-observe-account.ts for this subject first.");
      process.exit(1);
    }

    console.log("projectAnchor:    " + anchor + "   (mint asked about, from confirmed identity)");
    console.log("ownerSubject:     " + address);
    console.log("component:        " + component + " (step " + step + ")");
    console.log("provenance:       " + provenance.class);
    if (provenance.class === "DOCUMENTARY_LOCATOR") {
      console.log("documentedBy:     " + provenance.documents.length + " evidence row(s)");
      for (const row of provenance.documents) {
        console.log("  " + row.retrievedUrl + " :: " + String(row.summary));
        console.log("    authority:  " + String(row.sourceClass) + " / " + String(row.officiality));
      }
    } else {
      console.log("derivedFrom:      " + provenance.parentSubject);
      console.log("  NOTE:           technical provenance only — no documentary authority");
    }
    console.log("prerequisite:     " + PREREQUISITE_KIND + " established NOT_TOKEN_PROGRAM_OWNED");

    const [topic] = await db.select().from(topics).where(eq(topics.isActive, true));
    if (!topic) throw new Error("no active topic found — is the database seeded?");
    const [user] = await db.insert(users).values({}).returning();
    const createdAt = new Date();
    const entitlement: EntitlementSnapshot = {
      level: "ARI_CORE",
      capability: "FRESH_RESEARCH",
      budget: { ...INTERNAL_ALPHA_V1, maxSearchQueries: 0, maxSourceOpens: 1, maxModelCostMicro: 0 },
    };
    const { job } = await createResearchJob(
      db,
      boss,
      {
        userId: user.id,
        topicId: topic.id,
        projectId: project.id,
        originalQuestion: `observe token accounts owned by ${address} for component ${component}`,
        normalizedTask: {
          project_slug: project.slug,
          project_slugs: [project.slug],
          task: `perform one bounded ${INTENT_KIND} read of one admitted on-chain subject`,
        },
        normalizedTaskHash: `onchain-observe-token-accounts-${createdAt.getTime()}`,
        idempotencyKey: `onchain-observe-token-accounts-${user.id}-${createdAt.getTime()}`,
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
    const result = artifact.result as TokenAccountsByOwnerResult;

    console.log("slot:             " + artifact.provenance.slot);
    console.log("finality:         " + artifact.provenance.finality);
    console.log("providerMethod:   " + artifact.provenance.providerMethod);
    console.log("rawHash:          " + artifact.provenance.rawResponseHash);
    console.log("artifactHash:     " + artifact.provenance.artifactHash);
    console.log("accounts:         " + result.accounts.length);
    for (const a of result.accounts) {
      console.log("  account:        " + a.account);
      console.log("    owner:        " + a.owner);
      console.log("    mint:         " + a.mint);
      console.log("    amountRaw:    " + a.amountRaw + "  (" + formatTokenAmount(a.amountRaw, a.decimals) + ")");
    }
    if (result.accounts.length === 0) {
      // ABSENCE IS NOT A FACT. Production synthesizes nothing from an empty
      // answer, so no Evidence will be written below — and none should be.
      // This says only what was observed: at this slot, this query returned
      // no matching account. It is not a finding that the address holds no
      // such token, and it contradicts no document.
      console.log("  (no matching token account was returned at this slot)");
      console.log("  NOTE: absence is not a fact — no Evidence will be synthesized from an empty answer.");
    }

    const binding = validateOnchainBinding(artifact, {
      chain: "solana",
      tokenAddress: anchor,
      ticker: null,
    });
    console.log("binding:          " + JSON.stringify(binding));

    // --- persistence -------------------------------------------------
    // The ONE production path. Every Evidence property is decided there —
    // sourceClass ONCHAIN_VERIFIABLE, officiality CLAIMED (D-074, so a chain
    // read can never independently exceed the authority ceiling),
    // entityBinding, directness DIRECT — and none can be influenced from the
    // command line. A containment refusal writes nothing.
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
      console.error(
        "[observe-token-accounts] artifact not persisted — no Evidence written, no derived subject, no reconciliation run.",
      );
      process.exit(1);
    }

    // Derived subjects: the existing bounded path, reused unchanged. It
    // makes a returned token account readable by a LATER authorized window
    // without a repeat RPC. Nothing is read here, and no intent is promoted.
    const derived = await persistDerivedOnchainSubjects({
      db,
      artifactId: stored.artifactId,
      artifact,
      binding,
    });
    console.log("derivedSubjects:  " + derived + "   (recorded only — never read in this window)");

    for (const id of stored.evidenceIds) {
      const [row] = await db.select().from(evidence).where(eq(evidence.id, id));
      if (!row) continue;
      console.log("  evidence:       " + row.id);
      console.log("    class:        " + row.sourceClass + " / " + row.officiality);
      console.log("    binding:      " + String(row.entityBinding));
      console.log("    relation:     " + row.relationship + " " + row.directness);
      console.log("    artifactId:   " + String(row.onchainArtifactId));
      console.log("    summary:      " + row.summary);
      console.log("    doesNotProve: " + String(row.doesNotProve));
    }
    for (const row of await db
      .select()
      .from(onchainDerivedSubjects)
      .where(eq(onchainDerivedSubjects.onchainArtifactId, stored.artifactId))) {
      console.log("  derivedSubject: " + row.subject);
      console.log("    kind:         " + row.subjectKind);
      console.log("    parent:       " + row.parentSubject);
      console.log("    observedSlot: " + row.observedSlot);
    }

    // --- reconciliation ------------------------------------------------
    // Runs ONLY after the artifact actually persisted, and only for the
    // requested component. Scoped to THIS job by the production function, so
    // it judges this observation on its own and cannot alter any earlier
    // job's result. With zero Evidence it reports the ordinary fail-closed
    // outcome for this job — which is the honest record of an observation
    // that established nothing.
    console.log("--- reconciliation (" + component + ", this job only) ---");
    const reconciled = await reconcileAndPersistComponent(db, jobId, { step, component }, new Date());
    console.log("status:           " + reconciled.status);
    console.log("reasonCodes:      " + JSON.stringify(reconciled.reasonCodes));
    console.log("--- done: one rpc read ---");
  } finally {
    await pool.end().catch(() => {});
    await boss.stop().catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith("onchain-observe-token-accounts.ts")) {
  main().catch((e) => {
    console.error("OBSERVE TOKEN ACCOUNTS FAILED: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
