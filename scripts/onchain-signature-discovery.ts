// ONE bounded Solana RPC read, listing recent signatures for ONE account.
//
// Owner-authorized execution only. Performs exactly one
// SIGNATURES_FOR_ADDRESS retrieval and then stops. There is no loop, no
// retry, no pagination cursor, no second intent, no transaction fetch, no
// search, no model call and no Proof — this file has no code path capable
// of any of those, which is asserted by test rather than promised here.
//
// PAGINATION IS THE RISK THIS SCRIPT IS SHAPED AROUND. A signature list
// is the one intent that invites "just one more page": the RPC accepts
// `before`/`until` cursors, and a caller that threads them turns a single
// cheap read into an unbounded scan of an account's whole history. This
// entrypoint never constructs a cursor. It asks for one window, prints
// what came back, and ends. The adapter caps the limit independently
// (MAX_SIGNATURES_PER_INTENT), so an over-large --limit is clamped rather
// than honoured.
//
// THE SUBJECT MUST HAVE ADMITTED ON-CHAIN PROVENANCE, resolved from the
// database — never from a model and never merely from the command line.
// Two classes qualify, and the gate accepts either: a DOCUMENTARY_LOCATOR,
// a value the deterministic validator confirmed against a confirmed
// document, or a DERIVED_ONCHAIN_SUBJECT, an address a previous confirmed
// structured read returned. Both make an address eligible to be READ;
// neither makes it authoritative, and the derived class carries no
// document authority whatsoever.
//
// The documentary lookup answers for a fact carrying SEVERAL locators as
// well as for a historical scalar row, so one address can be targeted
// specifically. The ANCHOR stays the project's confirmed identity: listing
// an account's transactions never makes that account the project's.
//
// IT WRITES NOTHING. Read-and-report only; the persistence path is
// deliberately not invoked.
//
// WHAT THE ANSWER IS NOT. A signature list is a list of transactions that
// TOUCHED an address in one window. It does not say what any of them did,
// that any of them relate to any mechanism, that any token moved or was
// destroyed, or that the window is the account's complete history. An
// empty list is not evidence that nothing happened.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-signature-discovery.ts <ADDRESS> <LIMIT> [projectSlug]
//
// The endpoint is read from the environment by the same code-owned
// allowlist production uses; it is never printed.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import {
  resolveOnchainSubject,
  type OnchainSubjectProvenance,
} from "../src/server/engine/onchain-subject-provenance";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
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
      "usage: npx tsx scripts/onchain-signature-discovery.ts <ADDRESS> <LIMIT> [projectSlug]",
    );
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  let anchor: string;
  let provenance: OnchainSubjectProvenance;
  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) throw new Error(`project not found: ${slug}`);

    const identity = await resolveConfirmedIdentity(db, project.id);
    if (!identity?.tokenAddress) {
      console.error("[signature-discovery] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[signature-discovery] refusing — confirmed chain is ${identity.chain}, not solana.`);
      process.exit(1);
    }
    anchor = identity.tokenAddress;

    // PROVENANCE GATE. Refused BEFORE the retriever is constructed, so
    // an ineligible subject never reaches transport.
    // Two provenance classes, kept distinct. A DOCUMENTARY_LOCATOR is
    // stated by a confirmed document; a DERIVED_ONCHAIN_SUBJECT was
    // returned by a previous confirmed structured read. Both make a
    // subject eligible to be READ; neither makes it authoritative, and
    // the derived class carries no document authority whatsoever.
    const eligibility = await resolveOnchainSubject(db, {
      subject: address,
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
    });
    if (!eligibility.eligible) {
      console.error(
        "[signature-discovery] refusing — this address has no admitted on-chain subject provenance: " +
          eligibility.reason,
      );
      process.exit(1);
    }
    provenance = eligibility.provenance;
    console.log("projectAnchor:    " + anchor);
    console.log("subject:          " + address);
    console.log("provenance:       " + provenance.class);
    if (provenance.class === "DOCUMENTARY_LOCATOR") {
      console.log("documentedBy:     " + provenance.documents.length + " evidence row(s)");
      for (const row of provenance.documents) {
        console.log("  " + row.retrievedUrl + " :: " + String(row.summary));
        console.log("    authority:  " + String(row.sourceClass) + " / " + String(row.officiality));
        console.log("    evidenceId: " + row.evidenceId);
      }
    } else {
      // Technical provenance only: this says WHERE the subject came
      // from, never what it is for. No source class and no officiality
      // exist on this branch to print.
      console.log("derivedFrom:      " + provenance.parentSubject);
      console.log("  method:         " + provenance.derivationMethod);
      console.log("  subjectKind:    " + provenance.subjectKind);
      console.log("  artifactId:     " + provenance.onchainArtifactId);
      console.log("  artifactUri:    " + provenance.canonicalUri);
      console.log("  observedSlot:   " + provenance.observedSlot);
      console.log("  NOTE:           technical provenance only — no documentary authority");
    }
  } finally {
    // Closed BEFORE the read: the RPC call runs with no open handle to
    // ATLAS data, and nothing after this point can write.
    await pool.end();
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

  console.log("slot:             " + artifact.provenance.slot);
  console.log("finality:         " + artifact.provenance.finality);
  console.log("providerId:       " + artifact.provenance.providerId);
  console.log("providerMethod:   " + artifact.provenance.providerMethod);
  console.log("retrievedAt:      " + artifact.provenance.retrievedAt.toISOString());
  console.log("rawHash:          " + artifact.provenance.rawResponseHash);
  console.log("artifactHash:     " + artifact.provenance.artifactHash);

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
    // Projected by the adapter and previously dropped here, which made a
    // labelled transaction indistinguishable from an unlabelled one in
    // this script's output — and made memo look absent rather than
    // unreported. SELECTION METADATA ONLY: arbitrary text the sender
    // chose, never evidence of what the transaction did.
    console.log("    memo:         " + String(s.memo) + "   (selection metadata only)");
  }

  const binding = validateOnchainBinding(artifact, {
    chain: "solana",
    tokenAddress: anchor,
    ticker: null,
  });
  console.log("binding:          " + JSON.stringify(binding));

  const facts = synthesizeOnchainFacts(artifact, { step: 6, component: "DESTINATION" });
  console.log("facts:            " + facts.length);
  for (const f of facts) {
    console.log("  statement:      " + f.statement);
    console.log("  doesNotProve:   " + String(f.doesNotProve));
  }

  console.log("--- done: one rpc read, nothing persisted ---");
}

main().catch((e) => {
  // Transport errors are already sanitized (reason code + provider label,
  // never the endpoint or response body).
  console.error("SIGNATURE DISCOVERY FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
