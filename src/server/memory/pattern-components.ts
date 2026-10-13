import { and, eq } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { researchPatterns } from "../db/schema";
import { patternContentSchema } from "../domain/pattern";

// D-148 — THE CANONICAL COMPONENT VOCABULARY, read from CORE rather than
// restated.
//
// A SOURCE_RESOURCE declares which components it is expected to serve, and
// those names must be the SAME names the boundary contract and the
// reconciler use — otherwise a resource could be registered against a
// component that does not exist and would silently never be eligible.
// Restating the list here would be a second copy to drift; it is derived
// from the ACTIVE pattern row instead, which is where the human-authored
// vocabulary already lives (D-022: CORE changes by a human, with
// regression).
//
// Returns an empty set rather than throwing when no ACTIVE pattern is
// readable — the caller decides whether that is fatal. For registration it
// is (nothing can be validated); for planning it never arises, because
// eligibility is driven by the job's own contract, not by this list.
export async function loadActivePatternComponents(
  db: Database | Transaction,
  topicId?: string,
): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(researchPatterns)
    .where(
      // The same ACTIVE predicate loadActivePatternVersion uses — status,
      // not a second notion of "active".
      topicId
        ? and(eq(researchPatterns.status, "ACTIVE"), eq(researchPatterns.topicId, topicId))
        : eq(researchPatterns.status, "ACTIVE"),
    );

  const out = new Set<string>();
  for (const row of rows) {
    const parsed = patternContentSchema.safeParse(row.content);
    if (!parsed.success) continue;
    for (const components of Object.values(parsed.data.requiredComponents)) {
      for (const component of components) out.add(component);
    }
  }
  return out;
}
