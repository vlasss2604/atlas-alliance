// ONE bounded Solana RPC read that ESTABLISHES DURABLE PROVENANCE for the
// transaction signatures it returns.
//
// Owner-authorized execution only. onchain-signature-discovery.ts performs
// the same read and persists NOTHING — it is a diagnostic. This one exists
// so a signature can later be read in full without a repeat RPC and without
// anyone hand-typing it: a getTransaction step needs a deterministic answer
// to "why is this exact signature eligible?", and that answer has to be
// written down at the moment it is observed.
//
// WHAT IT WRITES, and nothing else:
//   onchain_artifacts             the retrieval, in
//                                 STANDALONE_STRUCTURED_OBSERVATION mode
//   onchain_observed_signatures   one row per returned signature
//
// NO user, NO research job, NO source row, NO Evidence, NO memory, NO
// Proof, NO route change — none of those modules is in its import graph,
// asserted by test rather than promised here.
//
// PAGINATION IS STILL REFUSED. One window, no cursor, no retry. Persisting
// the result changes nothing about how much of the chain this may read.
//
// THE SIGNATURE IS NEVER SUPPLIED. Rows come from the artifact's own
// validated result, and persistObservedSignatures has no parameter through
// which a signature could be handed in.
//
// WHAT AN OBSERVED SIGNATURE MEANS: the RPC listed it for this address at
// this slot. Not that an SPL burn occurred, not that a buyback happened,
// not which tokens moved or in which direction, not what the transaction
// contains. `err` is the RPC's own metadata; `memo` is selection metadata
// and never execution proof.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-observe-signatures.ts <ADDRESS> <LIMIT> [projectSlug]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { onchainArtifacts, projects } from "../src/server/db/schema";
import { resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import { persistOnchainArtifact } from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import {
  persistObservedSignatures,
  resolveObservedSignature,
  signaturesForArtifact,
} from "../src/server/engine/onchain-signature-provenance";
import {
  resolveOnchainSubject,
  type OnchainSubjectProvenance,
} from "../src/server/engine/onchain-subject-provenance";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type {
  OnchainIntent,
  SignaturesForAddressResult,
} from "../src/server/engine/providers/onchain-types";

async function main(): Promise<void> {
  const address = process.argv[2];
  const limit = Number(process.argv[3]);
  const slug = process.argv[4] ?? "pump_fun";
  if (!address || !Number.isInteger(limit) || limit < 1) {
    console.error(
      "usage: npx tsx scripts/onchain-observe-signatures.ts <ADDRESS> <LIMIT> [projectSlug]",
    );
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  try {
    const config = await loadProductConfig(db);
    if (!config.internal_alpha_enabled) {
      console.error("[observe-sig] refusing — internal_alpha_enabled is false.");
      process.exit(1);
    }

    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) throw new Error(`project not found: ${slug}`);

    const identity = await resolveConfirmedIdentity(db, project.id);
    if (!identity?.tokenAddress) {
      console.error("[observe-sig] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[observe-sig] refusing — confirmed chain is ${identity.chain}, not solana.`);
      process.exit(1);
    }
    const anchor = identity.tokenAddress;

    // PARENT SUBJECT GATE. Refused BEFORE the retriever is constructed, so
    // an ineligible address never reaches transport. Either provenance
    // class is accepted here — a documentary locator and a derived on-chain
    // subject are both legitimate things to list signatures for — and
    // neither confers anything on the signatures that come back.
    const eligibility = await resolveOnchainSubject(db, {
      subject: address,
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
    });
    if (!eligibility.eligible) {
      console.error(
        "[observe-sig] refusing — this address has no admitted on-chain subject provenance: " +
          eligibility.reason,
      );
      process.exit(1);
    }
    const provenance: OnchainSubjectProvenance = eligibility.provenance;
    console.log("projectAnchor:    " + anchor);
    console.log("parentSubject:    " + address);
    console.log("provenance:       " + provenance.class);
    if (provenance.class === "DOCUMENTARY_LOCATOR") {
      console.log("documentedBy:     " + provenance.documents.length + " evidence row(s)");
      for (const row of provenance.documents) {
        console.log("  " + row.retrievedUrl + " :: " + String(row.summary));
        console.log("    authority:  " + String(row.sourceClass) + " / " + String(row.officiality));
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

    // Exactly one intent, one window, no cursor.
    const intent: OnchainIntent = {
      kind: "SIGNATURES_FOR_ADDRESS",
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "account",
      subject: address,
      limit,
    };
    console.log("intent:           SIGNATURES_FOR_ADDRESS solana/mainnet");
    console.log("requestedLimit:   " + limit);
    console.log("canonicalUri:     " + buildCanonicalOnchainUri(intent));
    console.log("--- performing ONE rpc read ---");

    const artifact = await retriever.retrieve(intent);
    const p = artifact.provenance;
    console.log("slot:             " + p.slot);
    console.log("finality:         " + p.finality);
    console.log("providerMethod:   " + p.providerMethod);
    console.log("retrievedAt:      " + p.retrievedAt.toISOString());
    console.log("rawHash:          " + p.rawResponseHash);
    console.log("artifactHash:     " + p.artifactHash);

    const result = artifact.result as SignaturesForAddressResult;
    console.log("signatures:       " + result.signatures.length);
    for (const [i, s] of result.signatures.entries()) {
      console.log("  --- " + (i + 1));
      console.log("    signature:    " + s.signature);
      console.log("    slot:         " + s.slot);
      console.log(
        "    blockTime:    " +
          (s.blockTime === null ? "(none)" : `${s.blockTime} (${new Date(s.blockTime * 1000).toISOString()})`),
      );
      console.log("    err:          " + s.err);
      console.log("    memo:         " + String(s.memo) + "   (selection metadata only)");
    }

    const binding = validateOnchainBinding(artifact, {
      chain: "solana",
      tokenAddress: anchor,
      ticker: null,
    });
    console.log("binding:          " + JSON.stringify(binding));

    // --- persistence -------------------------------------------------
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
      console.error("[observe-sig] artifact not persisted — no signature can be recorded.");
      process.exit(1);
    }
    const written = await persistObservedSignatures({
      db,
      artifactId: stored.artifactId,
      artifact,
      binding,
    });
    console.log("observedSignatures: " + written);

    // --- post-run verification ---------------------------------------
    const [row] = await db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.id, stored.artifactId));
    console.log("--- persisted artifact ---");
    console.log("  id:             " + row.id);
    console.log("  originKind:     " + row.originKind);
    console.log("  researchJob:    " + String(row.researchJobId));
    console.log("  sourceId:       " + String(row.sourceId));
    console.log("  intentKind:     " + row.intentKind);
    console.log("  parentSubject:  " + row.subject);

    console.log("--- persisted signatures ---");
    for (const s of await signaturesForArtifact(db, stored.artifactId)) {
      console.log("  " + s.signature);
      console.log("    slot:         " + s.slot);
      console.log("    err:          " + s.err);
      console.log("    memo:         " + String(s.memo));
      // The gate is re-asked for each one. Reporting its answer beats
      // assuming persistence implies eligibility.
      const check = await resolveObservedSignature(db, {
        signature: s.signature,
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
  console.error("OBSERVE SIGNATURES FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
