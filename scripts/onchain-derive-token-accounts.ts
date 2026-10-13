// ONE bounded Solana RPC read that ESTABLISHES DURABLE PROVENANCE for the
// token accounts it returns.
//
// Owner-authorized execution only. The sibling script
// onchain-token-accounts.ts performs the same read and persists NOTHING —
// it is a diagnostic. This one exists because a subject discovered by RPC
// needs a durable record of WHY it is eligible for a later read, and that
// record cannot be created by a script that writes nothing. Two entrypoints
// rather than a --persist flag, so each keeps a one-sentence guarantee and
// the read-only one stays provably read-only.
//
// WHAT IT WRITES, and nothing else:
//   onchain_artifacts          the retrieval itself, in
//                              STANDALONE_STRUCTURED_OBSERVATION mode
//   onchain_derived_subjects   one row per bound token account
//
// NO synthetic user, research job or source row. An earlier cut created
// all three purely to satisfy NOT NULL foreign keys, which meant storing
// rows asserting that a research job had occurred and a document had been
// fetched — neither true. Provenance that has to lie to be stored is not
// provenance, so the artifact table now carries an explicit origin mode
// and this entrypoint uses the standalone one.
//
// It writes NO Evidence, NO documentary locator, NO research memory, NO
// Proof and NO route change — none of those modules is in its import graph,
// asserted by test rather than promised here.
//
// THE SUBJECT IS NEVER SUPPLIED. Derived subjects come from
// artifact.result.accounts after the adapter's owner/mint/token-program
// binding checks have already passed, and persistDerivedOnchainSubjects has
// no parameter through which an address could be handed in. A value from a
// prompt, a model, an explorer or an earlier console log cannot enter here.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-derive-token-accounts.ts <WALLET> [projectSlug]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { onchainArtifacts, onchainDerivedSubjects, projects } from "../src/server/db/schema";
import { resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import { persistOnchainArtifact } from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { formatTokenAmount } from "../src/server/engine/onchain-facts";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import {
  persistDerivedOnchainSubjects,
  resolveOnchainSubject,
  type OnchainSubjectProvenance,
} from "../src/server/engine/onchain-subject-provenance";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type {
  OnchainIntent,
  TokenAccountsByOwnerResult,
} from "../src/server/engine/providers/onchain-types";

async function main(): Promise<void> {
  const wallet = process.argv[2];
  const slug = process.argv[3] ?? "pump_fun";
  if (!wallet) {
    console.error("usage: npx tsx scripts/onchain-derive-token-accounts.ts <WALLET> [projectSlug]");
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  try {
    const config = await loadProductConfig(db);
    if (!config.internal_alpha_enabled) {
      console.error("[derive] refusing — internal_alpha_enabled is false.");
      process.exit(1);
    }

    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) throw new Error(`project not found: ${slug}`);

    const identity = await resolveConfirmedIdentity(db, project.id);
    if (!identity?.tokenAddress) {
      console.error("[derive] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[derive] refusing — confirmed chain is ${identity.chain}, not solana.`);
      process.exit(1);
    }
    const anchor = identity.tokenAddress;

    // PROVENANCE GATE. Refused BEFORE the retriever is constructed, so an
    // ineligible subject never reaches transport.
    const eligibility = await resolveOnchainSubject(db, {
      subject: wallet,
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
    });
    if (!eligibility.eligible) {
      console.error(
        "[derive] refusing — this address has no admitted on-chain subject provenance: " +
          eligibility.reason,
      );
      process.exit(1);
    }
    const provenance: OnchainSubjectProvenance = eligibility.provenance;
    console.log("projectAnchor:    " + anchor);
    console.log("ownerSubject:     " + wallet);
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
      console.log("  artifactId:     " + provenance.onchainArtifactId);
      console.log("  NOTE:           technical provenance only — no documentary authority");
    }

    const retriever = createProductionOnchainRetriever("solana", "mainnet");
    if (!retriever) {
      console.error(
        "no Solana mainnet RPC endpoint is configured (SOLANA_MAINNET_RPC_URL). Nothing was called.",
      );
      process.exit(1);
    }

    const intent: OnchainIntent = {
      kind: "TOKEN_ACCOUNTS_BY_OWNER",
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "account",
      subject: wallet,
    };
    console.log("intent:           TOKEN_ACCOUNTS_BY_OWNER solana/mainnet");
    console.log("mintFilter:       " + anchor + "  (= projectAnchor, not a parameter)");
    console.log("canonicalUri:     " + buildCanonicalOnchainUri(intent));


    console.log("--- performing ONE rpc read ---");
    const artifact = await retriever.retrieve(intent);

    console.log("slot:             " + artifact.provenance.slot);
    console.log("finality:         " + artifact.provenance.finality);
    console.log("providerMethod:   " + artifact.provenance.providerMethod);
    console.log("retrievedAt:      " + artifact.provenance.retrievedAt.toISOString());
    console.log("rawHash:          " + artifact.provenance.rawResponseHash);
    console.log("artifactHash:     " + artifact.provenance.artifactHash);

    const result = artifact.result as TokenAccountsByOwnerResult;
    console.log("tokenAccounts:    " + result.accounts.length);
    console.log("rejectedEntries:  " + result.rejectedCount);
    for (const a of result.accounts) {
      console.log("  account:        " + a.account);
      console.log("    owner:        " + a.owner);
      console.log("    mint:         " + a.mint);
      console.log("    amountRaw:    " + a.amountRaw + "  (" + formatTokenAmount(a.amountRaw, a.decimals) + ")");
    }

    const binding = validateOnchainBinding(artifact, {
      chain: "solana",
      tokenAddress: anchor,
      ticker: null,
    });
    console.log("binding:          " + JSON.stringify(binding));

    // --- persistence -------------------------------------------------
    // The artifact first: a derived subject with no observation behind it
    // is exactly what this design refuses to represent.
    // STANDALONE mode: no research job, no user, no source row. The
    // observation stands on its own provenance.
    const stored = await persistOnchainArtifact({
      db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity,
    });
    console.log("--- persistence ---");
    console.log("artifactId:       " + String(stored.artifactId));
    console.log("rejectedReason:   " + String(stored.rejectedReason));
    if (!stored.artifactId) {
      console.error("[derive] artifact not persisted — no derived subject can be written.");
      process.exit(1);
    }
    const written = await persistDerivedOnchainSubjects({
      db,
      artifactId: stored.artifactId,
      artifact,
      binding,
    });
    console.log("derivedSubjects:  " + written);

    // --- post-run verification ---------------------------------------
    console.log("--- persisted rows ---");
    const artifactRows = await db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, stored.artifactId));
    for (const row of artifactRows) {
      console.log("  artifact:       " + row.id);
      console.log("    originKind:   " + row.originKind);
      console.log("    researchJob:  " + String(row.researchJobId));
      console.log("    sourceId:     " + String(row.sourceId));
      console.log("    method:       " + row.providerMethod);
      console.log("    anchor:       " + row.projectAnchor);
      console.log("    parent:       " + row.subject);
      console.log("    slot:         " + row.slot);
      console.log("    rawHash:      " + row.rawResponseHash);
      console.log("    artifactHash: " + row.artifactHash);
    }
    const derivedRows = await db
      .select()
      .from(onchainDerivedSubjects)
      .where(eq(onchainDerivedSubjects.onchainArtifactId, stored.artifactId));
    for (const row of derivedRows) {
      console.log("  derived:        " + row.subject);
      console.log("    subjectKind:  " + row.subjectKind);
      console.log("    parent:       " + row.parentSubject);
      console.log("    method:       " + row.derivationMethod);
      console.log("    anchor:       " + row.projectAnchor);
      console.log("    chain/net:    " + row.chain + "/" + row.network);
      console.log("    binding:      " + row.bindingStatus);
      console.log("    slot:         " + row.observedSlot);
      // The gate is re-asked for every newly persisted subject. Reporting
      // what it says beats asserting that persistence must have worked.
      const check = await resolveOnchainSubject(db, {
        subject: row.subject,
        chain: "solana",
        network: "mainnet",
        projectAnchor: anchor,
      });
      console.log(
        "    resolves:     " + (check.eligible ? check.provenance.class : "REFUSED:" + check.reason),
      );
    }
    console.log("--- done: one rpc read ---");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("DERIVE FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
