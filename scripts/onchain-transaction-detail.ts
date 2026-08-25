// ONE bounded Solana RPC read: what does ONE transaction actually contain?
//
// Owner-authorized execution only. Exactly one TRANSACTION_DETAIL
// retrieval, then stop. No retry, no second transaction, no signature
// listing, no pagination, no search, no model call, no Proof.
//
// THE SIGNATURE MUST ALREADY BE OBSERVED. It is checked against
// onchain_observed_signatures through resolveObservedSignature, which
// re-validates the whole chain — originating artifact, its intent, the
// parent subject's own provenance — before the retriever is constructed. A
// signature from a prompt, a model, an explorer or a console log fails
// here unless it independently exists in that persisted provenance.
//
// DECODING IS NOT INTERPRETATION. This reports what the transaction
// CONTAINS: which programs ran, which SPL Token instructions were parsed,
// which token balances the RPC reported before and after. A Transfer to an
// address someone calls a burn address is reported as a Transfer.
// CloseAccount is reported as CloseAccount. A burn is reported only when
// an actual SPL Burn or BurnChecked instruction is present — never
// inferred from a zero post-balance, a transfer destination, a closed
// account, a memo, or a balance decrease.
//
// Run (owner-authorized only):
//   SOLANA_MAINNET_RPC_URL=... npx tsx scripts/onchain-transaction-detail.ts <SIGNATURE> [projectSlug]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { eq } from "drizzle-orm";

import { loadProductConfig } from "../src/server/config/product";
import { createDatabase } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { resolveConfirmedIdentity } from "../src/server/domain/project-identity";
import { persistOnchainArtifact } from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import { formatTokenAmount } from "../src/server/engine/onchain-facts";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { resolveObservedSignature } from "../src/server/engine/onchain-signature-provenance";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import type {
  OnchainIntent,
  TransactionDetailResult,
} from "../src/server/engine/providers/onchain-types";

async function main(): Promise<void> {
  const signature = process.argv[2];
  const slug = process.argv[3] ?? "pump_fun";
  if (!signature) {
    console.error("usage: npx tsx scripts/onchain-transaction-detail.ts <SIGNATURE> [projectSlug]");
    process.exit(1);
  }

  const { db, pool } = createDatabase();
  try {
    const config = await loadProductConfig(db);
    if (!config.internal_alpha_enabled) {
      console.error("[tx-detail] refusing — internal_alpha_enabled is false.");
      process.exit(1);
    }

    const [project] = await db.select().from(projects).where(eq(projects.slug, slug));
    if (!project) throw new Error(`project not found: ${slug}`);
    const identity = await resolveConfirmedIdentity(db, project.id);
    if (!identity?.tokenAddress) {
      console.error("[tx-detail] refusing — no ACTIVE PROJECT_IDENTITY for this project.");
      process.exit(1);
    }
    if (identity.chain !== "solana") {
      console.error(`[tx-detail] refusing — confirmed chain is ${identity.chain}, not solana.`);
      process.exit(1);
    }
    const anchor = identity.tokenAddress;

    // SIGNATURE PROVENANCE GATE, before transport exists.
    const eligibility = await resolveObservedSignature(db, {
      signature,
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
    });
    if (!eligibility.eligible) {
      console.error(
        "[tx-detail] refusing — this signature has no admitted observed provenance: " +
          eligibility.reason,
      );
      process.exit(1);
    }
    const prov = eligibility.provenance;
    console.log("projectAnchor:    " + anchor);
    console.log("signature:        " + prov.signature);
    console.log("provenance:       " + prov.class);
    console.log("  parentSubject:  " + prov.parentSubject + "  (" + prov.parentClass + ")");
    console.log("  fromArtifact:   " + prov.onchainArtifactId);
    console.log("  observedSlot:   " + prov.slot);
    console.log("  observedErr:    " + prov.err);
    console.log("  observedMemo:   " + String(prov.memo) + "   (selection metadata only)");

    const retriever = createProductionOnchainRetriever("solana", "mainnet");
    if (!retriever) {
      console.error(
        "no Solana mainnet RPC endpoint is configured (SOLANA_MAINNET_RPC_URL). Nothing was called.",
      );
      process.exit(1);
    }

    const intent: OnchainIntent = {
      kind: "TRANSACTION_DETAIL",
      chain: "solana",
      network: "mainnet",
      projectAnchor: anchor,
      subjectKind: "tx",
      subject: signature,
    };
    console.log("intent:           TRANSACTION_DETAIL solana/mainnet");
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

    const r = artifact.result as TransactionDetailResult;
    console.log("--- transaction ---");
    console.log("signature:        " + r.signature);
    console.log("succeeded:        " + r.succeeded);
    console.log("slot:             " + r.slot);
    console.log(
      "blockTime:        " +
        (r.blockTime === null ? "(none)" : `${r.blockTime} (${new Date(r.blockTime * 1000).toISOString()})`),
    );

    console.log("--- programs invoked (" + r.programs.length + ") ---");
    for (const id of r.programs) console.log("  " + id);

    console.log("--- account keys (" + r.accountKeys.length + ") ---");
    for (const [i, k] of r.accountKeys.entries()) {
      const marks: string[] = [];
      if (k === anchor) marks.push("PROJECT_MINT");
      if (k === prov.parentSubject) marks.push("PARENT_SUBJECT");
      console.log("  [" + i + "] " + k + (marks.length > 0 ? "   <= " + marks.join(", ") : ""));
    }

    console.log("--- parsed SPL token instructions (" + r.tokenInstructions.length + ") ---");
    for (const ix of r.tokenInstructions) {
      console.log("  " + (ix.inner ? "inner " : "outer ") + ix.type);
      console.log("    program:      " + ix.programId);
      console.log("    mint:         " + String(ix.mint));
      console.log("    account:      " + String(ix.account));
      console.log("    destination:  " + String(ix.destination));
      console.log("    authority:    " + String(ix.authority));
      console.log("    amountRaw:    " + String(ix.amountRaw));
      console.log("    decimals:     " + String(ix.decimals));
      if (ix.amountRaw !== null && ix.decimals !== null) {
        console.log("    formatted:    " + formatTokenAmount(ix.amountRaw, ix.decimals));
      }
    }

    console.log("--- SPL burns decoded (" + r.burns.length + ") ---");
    for (const b of r.burns) {
      console.log("  " + b.instructionType);
      console.log("    program:      " + b.programId);
      console.log("    mint:         " + b.mint);
      console.log("    source:       " + b.sourceAccount);
      console.log("    authority:    " + String(b.authority));
      console.log("    amountRaw:    " + b.amountRaw);
      console.log("    decimals:     " + String(b.decimals));
      if (b.decimals !== null) {
        console.log("    formatted:    " + formatTokenAmount(b.amountRaw, b.decimals));
      }
      console.log("    mintIsAnchor: " + (b.mint === anchor));
    }

    const show = (label: string, rows: TransactionDetailResult["preTokenBalances"]) => {
      console.log("--- " + label + " (" + rows.length + ") ---");
      for (const b of rows) {
        const mark = b.mint === anchor ? "   <= PROJECT_MINT" : "";
        console.log(
          "  [" + b.accountIndex + "] " + String(b.account) + " mint=" + b.mint +
            " owner=" + String(b.owner) + " raw=" + b.amountRaw + " (" +
            formatTokenAmount(b.amountRaw, b.decimals) + ")" + mark,
        );
      }
    };
    show("pre token balances", r.preTokenBalances);
    show("post token balances", r.postTokenBalances);

    const binding = validateOnchainBinding(artifact, identity);
    console.log("binding:          " + JSON.stringify(binding));

    // Standalone persistence — the same path every structured observation
    // uses. No job, no user, no source, no Evidence.
    const stored = await persistOnchainArtifact({
      db,
      origin: { kind: "STANDALONE_STRUCTURED_OBSERVATION" },
      artifact,
      identity,
    });
    console.log("--- persistence ---");
    console.log("artifactId:       " + String(stored.artifactId));
    console.log("rejectedReason:   " + String(stored.rejectedReason));
    console.log("--- done: one rpc read ---");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("TRANSACTION DETAIL FAILED: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
