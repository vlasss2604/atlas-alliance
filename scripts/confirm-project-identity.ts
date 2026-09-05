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

// D-158 PHASE 2 — REPEATABLE, unlike every other flag. A project has
// several revenue-bearing programs, and parseArgs below keeps one value per
// name, so collecting these separately is what stops a second --program
// from silently replacing the first.
//
// Shape: --program=<activity>:<programId>. The activity label may not
// contain ":", which is checked rather than assumed, because an activity
// like "swap:v2" would otherwise split into a wrong pair.
function parsePrograms(argv: string[]): { activity: string; programId: string; aliases?: string[] }[] {
  const out: { activity: string; programId: string; aliases?: string[] }[] = [];
  for (const arg of argv) {
    const m = /^--program=(.*)$/.exec(arg);
    if (!m) continue;
    const raw = m[1];
    const sep = raw.indexOf(":");
    if (sep <= 0 || sep === raw.length - 1) {
      console.error(
        `[confirm-identity] refusing: --program=${raw} is not <activity>:<programId>.`,
      );
      process.exit(1);
    }
    out.push({ activity: raw.slice(0, sep).trim(), programId: raw.slice(sep + 1).trim() });
  }
  return out;
}

// D-158 PHASE 2 — OTHER NAMES THE SAME ACTIVITY GOES BY IN DOCUMENTS.
//
// Also repeatable, and also a human statement. It exists because the
// activity binding is a LITERAL search of a document's own words, and a
// project's docs will not always spell an activity the way an operator
// does. Nothing derives an alias and no model may propose one; if a
// document says it differently, a human says so here.
//
// Shape: --program-alias=<activity>:<alias>, where <activity> must be
// one already given with --program.
function parseProgramAliases(argv: string[]): { activity: string; alias: string }[] {
  const out: { activity: string; alias: string }[] = [];
  for (const arg of argv) {
    const m = /^--program-alias=(.*)$/.exec(arg);
    if (!m) continue;
    const rawValue = m[1];
    const sep = rawValue.indexOf(":");
    if (sep <= 0 || sep === rawValue.length - 1) {
      console.error(
        `[confirm-identity] refusing: --program-alias=${rawValue} is not <activity>:<alias>.`,
      );
      process.exit(1);
    }
    out.push({ activity: rawValue.slice(0, sep).trim(), alias: rawValue.slice(sep + 1).trim() });
  }
  return out;
}

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
    "usage: npx tsx scripts/confirm-project-identity.ts --project=<slug> --chain=<chain> [--token=<address>] [--ticker=<TICKER>] [--program=<activity>:<programId> ...] [--program-alias=<activity>:<alias> ...] --actor=<name>",
  );
  console.error("");
  console.error("chains: " + SUPPORTED_CHAINS.join(", "));
  console.error("");
  console.error("States which entity a project IS. It discovers nothing and queries nothing.");
  console.error("A token address is optional: a project may be confirmed on a chain before");
  console.error("its token is. There is no --network option; the contract has no such field.");
  console.error("");
  console.error("--program states WHICH on-chain program is a named activity of this project,");
  console.error("and may be repeated. It is a human statement, exactly like --token: this tool");
  console.error("verifies the address SHAPE for the chain and nothing else. It does not query");
  console.error("the chain, does not read an IDL, and cannot tell you what a program does.");
  console.error("");
  console.error("--program-alias states another name the SAME activity goes by in this");
  console.error("project's own documents, and may be repeated. The activity binding is a");
  console.error("literal search of a document's words, so a name that never appears in them");
  console.error("binds nothing. Nothing here guesses a synonym.");
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

  const programs = parsePrograms(process.argv.slice(2));
  // Aliases are attached to the activity they name. An alias for an
  // activity that was not confirmed in this same invocation is refused
  // rather than dropped: silently ignoring it would leave the operator
  // believing a name was confirmed when it was not.
  for (const { activity, alias } of parseProgramAliases(process.argv.slice(2))) {
    const target = programs.find((e) => e.activity.toLowerCase() === activity.toLowerCase());
    if (target === undefined) {
      console.error(
        `[confirm-identity] refusing: --program-alias names activity "${activity}", which no --program declares.`,
      );
      process.exit(1);
    }
    target.aliases = [...(target.aliases ?? []), alias];
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
    console.log(
      "programs:         " +
        (programs.length === 0
          ? "(none)"
          : programs
              .map(
                (e) =>
                  `${e.activity} -> ${e.programId}${e.aliases === undefined ? "" : ` (aka ${e.aliases.join(", ")})`}`,
              )
              .join(", ")),
    );
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
      ...(programs.length === 0 ? {} : { programs }),
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
