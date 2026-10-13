// PATTERN CONTENT ACTIVATION — internal/admin script (RC-1, semantic drift).
//
// WHY THIS EXISTS. The active research_patterns row is chosen by identity
// (topic + ACTIVE + version) and validated by shape. seed.ts writes with
// onConflictDoNothing on (topic, version), so editing PATTERN_V1_CONTENT
// without bumping the version never reaches the database. This script is
// the sanctioned way to bring a database up to the current code contract.
//
// WHEN IT ACTIVATES. Whenever the ACTIVE row's SEMANTIC contract differs
// from the code's (src/server/domain/pattern-activation.ts): a structural
// obligation the production gate refuses, OR any other field a Research
// decision or a provider instruction reads — establishing classes,
// freshness and currency gates, token-state rules, evidence goals, claim
// requirements, the steps and the work queue. Only the human-facing step
// question is presentation and never forces activation. It used to
// activate only on the gate's refusal, which let a narrowed admissibility
// rule (D-159, DURABILITY_BASIS) stay un-activated while a live run
// reconciled under the old one.
//
// WHAT IT DOES, AND WHAT IT REFUSES TO DO. It NEVER edits the content of an
// existing row. A drifted row is preserved byte-for-byte as history; only
// its `status` moves ACTIVE -> RETIRED, because the partial unique index
// uq_research_patterns_one_active permits exactly one ACTIVE row per topic.
// The new content is written as a NEW row at the next version number.
//
// DRY RUN BY DEFAULT. Without --apply it reads, diffs and reports, and
// writes nothing. Pass --apply to perform the transition inside one
// transaction, after which it re-reads and re-verifies.
//
//   npx tsx scripts/activate-pattern-version.ts
//   npx tsx scripts/activate-pattern-version.ts --apply

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createDatabase } from "../src/server/db/client";
import { activatePatternVersions } from "../src/server/domain/pattern-activation";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { db, pool } = createDatabase();
  try {
    await activatePatternVersions(db, { apply, log: (line) => console.log(line) });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
