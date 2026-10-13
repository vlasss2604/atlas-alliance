// ONE bounded Solana RPC read: which SPL token accounts a documented
// wallet holds FOR THE PROJECT'S CONFIRMED MINT.
//
// Owner-authorized execution only. Performs exactly one
// TOKEN_ACCOUNTS_BY_OWNER retrieval and then stops. There is no loop, no
// retry, no cursor, no second intent, no signature scan, no transaction
// fetch, no search, no model call and no Proof — this file has no code
// path capable of any of those, which is asserted by test.
//
// THREE ADDRESSES, KEPT APART. The project ANCHOR is the confirmed mint,
// read from PROJECT_IDENTITY. The SUBJECT is a wallet with admitted
// on-chain provenance, resolved from the database — either a
// DOCUMENTARY_LOCATOR stated by a confirmed document, or a
// DERIVED_ONCHAIN_SUBJECT returned by a previous confirmed structured
// read; the gate accepts either, and neither confers authority. The token
// accounts the query RETURNS are a third thing — answers, never inputs,
// and never promoted into either of the first two roles.
//
// THE MINT FILTER IS NOT A PARAMETER. The adapter builds the RPC filter
// from intent.projectAnchor, so this cannot ask about any mint other than
// the project's confirmed identity even if a caller wanted it to. There
// is nowhere to put a different mint.
//
// IT WRITES NOTHING. Read-and-report only; the persistence path is
// deliberately not invoked.
//
// WHAT THE ANSWER IS NOT. A token account and its balance are a POSITION
// AT A MOMENT. They do not establish how anything got there, who funded
// it, who controls the wallet beyond the owner field the RPC reports, that
// any token was burned or bought back, or that supply changed. An empty
// answer is not evidence that the wallet holds nothing.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-token-accounts.ts <WALLET> [projectSlug]
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
import { formatTokenAmount, synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type {
  OnchainIntent,
  TokenAccountsByOwnerResult,
} from "../src/server/engine/providers/onchain-types";

async function main(): Promise<void> {
  const wallet = process.argv[2];
  const slug = process.argv[3] ?? "pump_fun";
  if (!wallet) {
    console.error("usage: npx tsx scripts/onchain-token-accounts.ts <WALLET> [projectSlug]");
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
      console.error("[token-accounts] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[token-accounts] refusing — confirmed chain is ${identity.chain}, not solana.`);
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
      subject: wallet,
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
    });
    if (!eligibility.eligible) {
      console.error(
        "[token-accounts] refusing — this address has no admitted on-chain subject provenance: " +
          eligibility.reason,
      );
      process.exit(1);
    }
    provenance = eligibility.provenance;
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
  console.log("providerId:       " + artifact.provenance.providerId);
  console.log("providerMethod:   " + artifact.provenance.providerMethod);
  console.log("retrievedAt:      " + artifact.provenance.retrievedAt.toISOString());
  console.log("rawHash:          " + artifact.provenance.rawResponseHash);
  console.log("artifactHash:     " + artifact.provenance.artifactHash);

  const result = artifact.result as TokenAccountsByOwnerResult;
  console.log("tokenAccounts:    " + result.accounts.length);
  console.log("rejectedEntries:  " + result.rejectedCount);
  for (const [i, a] of result.accounts.entries()) {
    console.log("  --- " + (i + 1));
    console.log("    account:      " + a.account);
    console.log("    owner:        " + a.owner);
    console.log("    mint:         " + a.mint);
    console.log("    amountRaw:    " + a.amountRaw);
    console.log("    decimals:     " + a.decimals);
    console.log("    formatted:    " + formatTokenAmount(a.amountRaw, a.decimals));
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
  console.error("TOKEN ACCOUNT DISCOVERY FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
