import { eq } from "drizzle-orm";
import { expect } from "vitest";

import type { Database } from "../src/server/db/client";
import { researchAttempts } from "../src/server/db/schema";
import { auditRemainingKnownPaths } from "../src/server/engine/targeted-recovery";

// THE CANONICAL INVARIANT, AS A TEST ASSERTION: a Research never finalizes an
// unresolved critical component while a known admissible path remains unused,
// unless the hard envelope stopped its recovery.
// Recovery attempts are consecutive rounds — never a gap, never a duplicate.
export async function expectRecoveryRanToCompletion(db: Database, jobId: string, projectId: string): Promise<void> {
  const attempts = await db.select().from(researchAttempts).where(eq(researchAttempts.researchJobId, jobId));
  const byComponent = new Map<string, (typeof attempts)[number][]>();
  for (const a of attempts) byComponent.set(a.component, [...(byComponent.get(a.component) ?? []), a]);
  for (const [component, rows] of byComponent) {
    const numbers = rows.map((r) => r.attemptNumber).sort((a, b) => a - b);
    expect(numbers, component).toEqual(numbers.map((_, i) => i + 1));
    expect(rows.some((r) => r.status === "STARTED"), `${component} left STARTED`).toBe(false);
  }
  for (const open of await auditRemainingKnownPaths(db, jobId, projectId)) {
    const latest = [...(byComponent.get(open.component) ?? [])].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    expect(open.recoverySpent, `${open.component}: known paths open and no recovery ran`).toBe(true);
    // A budget stop in either form the runtime writes: a round the envelope
    // cut mid-attempt, or a recovery attempt the executor closed because the
    // axis it needed was spent.
    expect(latest?.attemptNumber ?? 0, `${open.component}: known paths open after the first pass only`).toBeGreaterThan(1);
    expect(latest?.reason ?? "", `${open.component}: finalized with known paths open without a budget stop`).toMatch(/^(RECOVERY_BUDGET_EXHAUSTED:|SEARCH_BUDGET_EXHAUSTED)/);
  }
}
