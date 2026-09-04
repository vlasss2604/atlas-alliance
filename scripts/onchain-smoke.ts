// ONE bounded Solana RPC read. Owner-authorized execution only.
//
// Performs exactly one TOKEN_SUPPLY retrieval against a confirmed mint and
// then stops. There is no loop, no retry, no second intent, no search, no
// model call, no Proof, and no transaction scanning — the script has no
// code path capable of any of those.
//
// It also writes NOTHING: this is a read-and-report smoke, so the
// persistence path is deliberately not invoked. Binding is still validated
// and printed, because whether the artifact WOULD be admissible is the
// main thing the smoke needs to answer.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-smoke.ts <MINT>
//
// The endpoint is read from the environment by the same code-owned
// allowlist production uses; it is never printed.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";

async function main() {
  const mint = process.argv[2];
  if (!mint) {
    console.error("usage: npx tsx scripts/onchain-smoke.ts <MINT_ADDRESS>");
    process.exit(1);
  }

  const retriever = createProductionOnchainRetriever("solana", "mainnet");
  if (!retriever) {
    console.error(
      "no Solana mainnet RPC endpoint is configured (SOLANA_MAINNET_RPC_URL). " +
        "Nothing was called.",
    );
    process.exit(1);
  }

  // Exactly one intent. Subject is the anchor itself: a direct token read,
  // no derived account, no signature scan.
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: "solana",
    network: "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };

  console.log("intent:      TOKEN_SUPPLY solana/mainnet");
  console.log("anchor:      " + mint);
  console.log("canonicalUri:" + buildCanonicalOnchainUri(intent));
  console.log("--- performing ONE rpc read ---");

  const artifact = await retriever.retrieve(intent);

  const binding = validateOnchainBinding(artifact, {
    chain: "solana",
    tokenAddress: mint,
    ticker: null,
  });

  console.log("result:      " + artifact.normalizedText);
  console.log("slot:        " + artifact.provenance.slot);
  console.log("finality:    " + artifact.provenance.finality);
  console.log("providerId:  " + artifact.provenance.providerId);
  console.log("rawHash:     " + artifact.provenance.rawResponseHash);
  console.log("artifactHash:" + artifact.provenance.artifactHash);
  console.log("binding:     " + JSON.stringify(binding));

  const facts = synthesizeOnchainFacts(artifact, { step: 5, component: "CURRENT_STATE" });
  console.log("facts:       " + facts.length);
  for (const f of facts) console.log("  statement: " + f.statement);

  console.log("--- done: one rpc read, nothing persisted ---");
}

main().catch((e) => {
  // Transport errors are already sanitized (reason code + provider label,
  // never the endpoint or response body).
  console.error("SMOKE FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
