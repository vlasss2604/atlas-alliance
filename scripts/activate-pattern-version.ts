// PATTERN CONTENT ACTIVATION — internal/admin script (RC-1).
//
// WHY THIS EXISTS. The active research_patterns row is chosen by identity
// (topic + ACTIVE + version) and validated by shape. Until RC-1 nothing
// validated CONTENT, so a row seeded before an obligation was added stayed
// ACTIVE forever while the code contract moved on: seed.ts writes with
// onConflictDoNothing on (topic, version), so editing PATTERN_V1_CONTENT
// without bumping the version never reaches the database. componentRequirementsFor
// now refuses that drift (PatternSemanticDriftError). This script is the
// other half: the sanctioned way to bring a database up to the current
// code contract.
//
// WHAT IT DOES, AND WHAT IT REFUSES TO DO. It NEVER edits the content of an
// existing row. A drifted row is preserved byte-for-byte as history; only
// its `status` moves ACTIVE -> RETIRED, because the partial unique index
// uq_research_patterns_one_active permits exactly one ACTIVE row per topic
// and there is no way to activate a successor without standing the
// predecessor down. The new content is written as a NEW row at the next
// version number.
//
// NAMING. PATTERN_V1_CONTENT names the METHODOLOGY (Token Value Capture
// Pattern v1, eight steps) — not the row's `version` column, which is the
// content revision of that methodology. A database at content revision 2
// still runs methodology v1.
//
// DRY RUN BY DEFAULT. Without --apply it reads, diffs and reports, and
// writes nothing. Pass --apply to perform the transition inside one
// transaction, after which it re-reads and re-verifies through the same
// production accessor the engine uses.
//
//   npx tsx scripts/activate-pattern-version.ts
//   npx tsx scripts/activate-pattern-version.ts --apply

import { and, desc, eq } from "drizzle-orm";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createDatabase } from "../src/server/db/client";
import { researchPatterns, topics } from "../src/server/db/schema";
import {
  componentRequirementsFor,
  patternContentSchema,
  PATTERN_V1_CONTENT,
  type PatternContent,
} from "../src/server/domain/pattern";

// KEY ORDER IS NOT A DIFFERENCE. Postgres normalises jsonb object key
// order on write, so a byte comparison against the code constant reports
// every array-of-objects as changed even when it is identical — including
// content this script itself just inserted, which would make its own
// post-apply verification fail. Canonicalising first makes the comparison
// semantic: order-independent for keys, order-preserving for arrays (where
// order IS meaning, e.g. the eight ordered steps).
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonical(src[key]);
    return out;
  }
  return value;
}
const canonicalJson = (v: unknown): string => JSON.stringify(canonical(v));

// Every semantic difference between a stored content blob and the code
// contract, as concrete paths — so an operator sees exactly what
// activating would change before it happens, rather than trusting a summary.
function contentDifferences(stored: unknown, code: PatternContent): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    const ao = (a ?? {}) as Record<string, unknown>;
    const bo = (b ?? {}) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const p = `${path}.${key}`;
      const va = ao[key];
      const vb = bo[key];
      if (!(key in ao)) { out.push(`  ONLY-IN-CODE  ${p} = ${JSON.stringify(vb)}`); continue; }
      if (!(key in bo)) { out.push(`  ONLY-IN-DB    ${p} = ${JSON.stringify(va)}`); continue; }
      if (typeof va === "object" && va !== null && !Array.isArray(va) && typeof vb === "object" && vb !== null) {
        walk(va, vb, p);
      } else if (canonicalJson(va) !== canonicalJson(vb)) {
        out.push(`  DIFFERS       ${p}: db=${JSON.stringify(va)} code=${JSON.stringify(vb)}`);
      }
    }
  };
  walk(stored, code, "content");
  return out;
}

// The production gate itself, over every component the content defines —
// not a re-implementation of it. If this passes, reconciliation will not
// refuse this row for drift.
function gateAccepts(content: PatternContent): { ok: true } | { ok: false; reason: string } {
  for (const component of Object.keys(content.componentRequirements ?? {})) {
    try {
      componentRequirementsFor(content, component);
    } catch (e) {
      return { ok: false, reason: `${(e as Error).name}: ${(e as Error).message}` };
    }
  }
  return { ok: true };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { db, pool } = createDatabase();
  try {
    const activeTopics = await db.select().from(topics).where(eq(topics.isActive, true));
    if (activeTopics.length === 0) throw new Error("no active topic — refusing to guess which topic to activate against");

    for (const topic of activeTopics) {
      const rows = await db
        .select()
        .from(researchPatterns)
        .where(eq(researchPatterns.topicId, topic.id))
        .orderBy(desc(researchPatterns.version));
      console.log(`\n=== topic ${topic.slug} (${topic.id}) ===`);
      if (rows.length === 0) { console.log("  no research_patterns rows — nothing to activate (run the seed first)"); continue; }
      for (const r of rows) console.log(`  v${r.version} ${r.status} created=${r.createdAt.toISOString()}`);

      const current = rows.find((r) => r.status === "ACTIVE");
      if (!current) { console.log("  no ACTIVE row — refusing to choose one; activate deliberately"); continue; }

      const parsed = patternContentSchema.safeParse(current.content);
      if (!parsed.success) { console.log(`  ACTIVE v${current.version} content does not parse: ${parsed.error.message.slice(0, 200)}`); continue; }

      const verdict = gateAccepts(parsed.data);
      const diffs = contentDifferences(current.content, PATTERN_V1_CONTENT);
      console.log(`  ACTIVE v${current.version} gate: ${verdict.ok ? "ACCEPTED" : "REFUSED"}`);
      if (!verdict.ok) console.log(`    ${verdict.reason}`);
      console.log(`  differences vs code contract: ${diffs.length}`);
      for (const d of diffs) console.log(d);

      if (verdict.ok) { console.log("  -> already compatible with the code contract; nothing to do."); continue; }

      const nextVersion = Math.max(...rows.map((r) => r.version)) + 1;
      if (!apply) {
        console.log(`  -> DRY RUN: would RETIRE v${current.version} (content untouched) and insert v${nextVersion} ACTIVE with the code contract.`);
        console.log("     Re-run with --apply to perform it.");
        continue;
      }

      await db.transaction(async (tx) => {
        // Status only. The drifted row's content is history and stays exactly as written.
        await tx.update(researchPatterns).set({ status: "RETIRED" }).where(eq(researchPatterns.id, current.id));
        await tx.insert(researchPatterns).values({
          topicId: topic.id,
          version: nextVersion,
          status: "ACTIVE",
          content: PATTERN_V1_CONTENT,
        });
      });

      // Re-read and re-verify through the same path the engine takes, so
      // the script's claim of success is an observation, not an assumption.
      const [after] = await db
        .select()
        .from(researchPatterns)
        .where(and(eq(researchPatterns.topicId, topic.id), eq(researchPatterns.status, "ACTIVE")));
      if (!after || after.version !== nextVersion) throw new Error(`activation did not take effect for topic ${topic.slug}`);
      const reparsed = patternContentSchema.parse(after.content);
      const afterVerdict = gateAccepts(reparsed);
      if (!afterVerdict.ok) throw new Error(`activated v${nextVersion} still refused by the gate: ${afterVerdict.reason}`);
      const remaining = contentDifferences(after.content, PATTERN_V1_CONTENT);
      if (remaining.length > 0) throw new Error(`activated v${nextVersion} still differs from the code contract: ${remaining.join("; ")}`);
      const preserved = await db.select().from(researchPatterns).where(eq(researchPatterns.id, current.id));
      console.log(`  -> APPLIED: v${nextVersion} ACTIVE, gate ACCEPTED, 0 differences vs code.`);
      console.log(`     v${current.version} preserved as ${preserved[0].status}, content unchanged.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
