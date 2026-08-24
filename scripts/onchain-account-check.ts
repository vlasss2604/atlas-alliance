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
// THE SUBJECT MUST BE A CONFIRMED DOCUMENTARY LOCATOR. It is read from
// evidence.documentary_locator — a value the deterministic validator
// already admitted — never from the command line and never from a model.
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

import { and, eq } from "drizzle-orm";

import { createDatabase } from "../src/server/db/client";
import { evidence, projects } from "../src/server/db/schema";
import { resolveConfirmedIdentity } from "../src/server/domain/project-identity";
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

    // PROVENANCE GATE. The subject must already exist as an admitted
    // documentary locator for this project, so the read is attached to a
    // record of where the address came from.
    const supporting = await db
      .select({ id: evidence.id, url: evidence.retrievedUrl, summary: evidence.summary })
      .from(evidence)
      .where(and(eq(evidence.documentaryLocator, address)));
    if (supporting.length === 0) {
      console.error(
        "[account-check] refusing — this address is not a confirmed documentary locator in Evidence.",
      );
      process.exit(1);
    }
    console.log("projectAnchor:    " + anchor);
    console.log("subject:          " + address);
    console.log("documentedBy:     " + supporting.length + " evidence row(s)");
    for (const row of supporting) console.log("  " + row.url + " :: " + String(row.summary));
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
