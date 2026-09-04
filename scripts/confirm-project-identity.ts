// OWNER PROJECT-IDENTITY CONFIRMATION — the controlled human entrypoint for
// stating which entity a project actually is.
//
// D-021/D-055: a transition to ACTIVE happens only by a human, through a
// controlled auditable script — not an admin UI, not a model, not
// hand-written SQL. `confirm-source-route.ts` is that script for WHERE to
// look; this is its sibling for WHICH entity.
//
// It had no home. Nothing in the repository ever inserted a
// PROJECT_IDENTITY row, while five owner scripts and the S4 acquisition
// plan read one and correctly refuse without it — so the capability D-133
// depends on could not be exercised at all.
//
// IT DISCOVERS NOTHING. No chain query, no web query, no document, no
// model is in its import graph, and a test asserts it. A well-formed
// address is not a confirmed one: confirmation IS the human decision, and
// this tool only records that it was made.
//
// THERE IS NO --network OPTION, because the contract has no such field.
// The identity content schema is `{ chain, tokenAddress?, ticker? }` and
// it is `.strict()`. Mainnet is implied by construction — every explorer
// in the code-owned chain map is a mainnet host, and test networks are
// rejected again at classification time.
//
// Run:
//   npx tsx scripts/confirm-project-identity.ts \
//     --project=<slug> --chain=<chain> [--token=<mint|contract>] \
//     [--ticker=<TICKER>] --actor=<name>
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createDatabase } from "../src/server/db/client";
import { SUPPORTED_CHAINS } from "../src/server/domain/project-identity";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z0-9_-]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function usage(): never {
  console.error(
    "usage: npx tsx scripts/confirm-project-identity.ts --project=<slug> --chain=<chain> [--token=<address>] [--ticker=<TICKER>] --actor=<name>",
  );
  console.error("");
  console.error("chains: " + SUPPORTED_CHAINS.join(", "));
  console.error("");
  console.error("States which entity a project IS. It discovers nothing and queries nothing.");
  console.error("A token address is optional: a project may be confirmed on a chain before");
  console.error("its token is. There is no --network option; the contract has no such field.");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Refused LOUDLY rather than ignored. Someone reaching for --network is
  // working from an assumption about the contract, and silently dropping
  // it would let them believe they had pinned something.
  if (args.network !== undefined) {
    console.error("[confirm-identity] refusing: --network is not part of the identity contract.");
    console.error("  The stored shape is { chain, tokenAddress?, ticker? } and it is strict.");
    console.error("  Mainnet is implied: every explorer in the chain map is a mainnet host.");
    process.exit(1);
  }

  const projectSlug = args.project;
  const chain = args.chain;
  const actor = args.actor;
  if (!projectSlug || !chain || !actor) usage();

  const { db, pool } = createDatabase();
  try {
    console.log("--- project identity confirmation ---");
    console.log("project:          " + projectSlug);
    console.log("chain:            " + chain);
    console.log("token:            " + (args.token ?? "(none — chain-only identity)"));
    console.log("ticker:           " + (args.ticker ?? "(none)"));
    // Printed for the operator's own record. It is NOT persisted:
    // project_memory_items has no actor column, deliberately — unlike
    // research_memory, which carries promoted_by. The durable audit trail
    // is the row's lifecycle state and created_at. Inventing a field to
    // hold this would be inventing provenance.
    console.log("actor:            " + actor + "   (printed, not persisted — no such column)");

    const result = await confirmProjectIdentity(db, {
      projectSlug,
      chain,
      ...(args.token === undefined ? {} : { tokenAddress: args.token }),
      ...(args.ticker === undefined ? {} : { ticker: args.ticker }),
    });

    if (!result.ok) {
      console.error("\n[confirm-identity] REFUSED: " + result.refusal);
      console.error("  " + result.detail);
      if (result.existing) {
        console.error(
          "  existing identity resolves to: chain=" +
            result.existing.chain +
            " token=" +
            String(result.existing.tokenAddress) +
            " ticker=" +
            String(result.existing.ticker),
        );
      }
      process.exit(1);
    }

    console.log("\n--- created ---");
    console.log("memoryItemId:     " + result.itemId);
    console.log("kind:             PROJECT_IDENTITY");
    console.log("lifecycleState:   ACTIVE   (OBSERVED -> CANDIDATE -> ACTIVE)");
    console.log("content:          " + JSON.stringify(result.content));

    console.log("\n--- resolved by the real production resolver ---");
    if (result.resolved === null) {
      console.error("[confirm-identity] INVARIANT VIOLATED: the row is ACTIVE but resolves to nothing.");
      console.error("  Do not treat this project as having a confirmed identity; review by hand.");
      process.exit(1);
    }
    console.log("chain:            " + result.resolved.chain);
    console.log("tokenAddress:     " + String(result.resolved.tokenAddress));
    console.log("ticker:           " + String(result.resolved.ticker));

    console.log("\nConfirmed. On-chain acquisition can now be attempted for this project.");
    console.log("This states WHICH entity the project is. It confirms no source and no");
    console.log("document — routes are a separate decision (confirm-source-route.ts).");
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error("[confirm-identity] failed: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
