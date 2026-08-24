// ONE bounded Solana RPC read, characterizing ONE account.
//
// Owner-authorized execution only. Performs exactly one ACCOUNT_INFO
// retrieval against a subject account and then stops. There is no loop, no
// retry, no second intent, no signature scan, no transaction fetch, no
// search, no model call and no Proof — this file has no code path capable
// of any of those, which is asserted by test rather than promised here.
//
// WHY THIS EXISTS SEPARATELY FROM onchain-smoke.ts. That script reads a
// project's own token supply: subject IS the anchor, a direct read. This
// one reads a DERIVED subject — an account the project's documentation
// names — while the anchor stays the project's confirmed mint. Keeping
// them apart keeps each script's guarantee a single sentence, and keeps
// the anchor/subject distinction (D-134, AMENDMENT D) visible at the call
// site instead of hidden behind a mode flag.
//
// THE SUBJECT MUST BE A CONFIRMED DOCUMENTARY LOCATOR, matched against the
// admitted locators for this project — a value the deterministic validator
// confirmed — never from the command line and never from a model. The
// lookup answers for a fact carrying SEVERAL locators as well as for a
// historical scalar row, so one address can be targeted specifically.
// An address a human merely believes in is not a subject here: without a
// documentary record of where it came from, the read would have no
// provenance to attach it to.
//
// IT WRITES NOTHING. This is a read-and-report characterization, so the
// persistence path is deliberately not invoked. Binding is still validated
// and printed, because whether the artifact WOULD be admissible is the
// main thing this needs to answer.
//
// WHAT THE ANSWER IS NOT. Characterizing an account says what the account
// IS at a slot. It is not evidence that anything was sent there, that any
// token was destroyed, that an SPL Burn executed, or that supply changed.
// Those are different reads with different intents, and this script cannot
// perform any of them.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-account-check.ts <ADDRESS> [projectSlug]
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
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";

async function main(): Promise<void> {
  const address = process.argv[2];
  const slug = process.argv[3] ?? "pump_fun";
  if (!address) {
    console.error("usage: npx tsx scripts/onchain-account-check.ts <ADDRESS> [projectSlug]");
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  let anchor: string;
  let provenance: OnchainSubjectProvenance;
  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) throw new Error(`project not found: ${slug}`);

    // The anchor is the project's confirmed identity — never the subject,
    // and never supplied on the command line.
    const identity = await resolveConfirmedIdentity(db, project.id);
    if (!identity?.tokenAddress) {
      console.error("[account-check] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[account-check] refusing — confirmed chain is ${identity.chain}, not solana.`);
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
        "[account-check] refusing — this address has no admitted on-chain subject provenance: " +
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

  // Exactly one intent. A DERIVED subject: the anchor stays the project's
  // confirmed mint, the subject is the documented account.
  const intent: OnchainIntent = {
    kind: "ACCOUNT_INFO",
    chain: "solana",
    network: "mainnet",
    projectAnchor: anchor,
    subjectKind: "account",
    subject: address,
  };

  console.log("intent:           ACCOUNT_INFO solana/mainnet");
  console.log("canonicalUri:     " + buildCanonicalOnchainUri(intent));
  console.log("--- performing ONE rpc read ---");

  const artifact = await retriever.retrieve(intent);

  console.log("result:           " + artifact.normalizedText);
  console.log("resultJson:       " + JSON.stringify(artifact.result));
  console.log("slot:             " + artifact.provenance.slot);
  console.log("finality:         " + artifact.provenance.finality);
  console.log("providerId:       " + artifact.provenance.providerId);
  console.log("providerMethod:   " + artifact.provenance.providerMethod);
  console.log("retrievedAt:      " + artifact.provenance.retrievedAt.toISOString());
  console.log("rawHash:          " + artifact.provenance.rawResponseHash);
  console.log("artifactHash:     " + artifact.provenance.artifactHash);

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
  console.error("ACCOUNT CHECK FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
