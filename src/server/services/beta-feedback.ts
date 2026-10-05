import { eq } from "drizzle-orm";

import { HttpError } from "../auth/guards";
import type { Database, Transaction } from "../db/client";
import { FEEDBACK_TEXT_MAX, researchBetaFeedback } from "../db/schema";
import { countPrivateBetaProofs } from "./private-beta";

// PRIVATE-BETA FEEDBACK (D-170) — asked once, after real use, never required.
//
// DUE exactly when the user has at least FEEDBACK_AFTER_PROOFS private-beta
// Researches that ended with a durable Proof AND has no feedback row yet.
// So it never appears at signup or after the first Proof, and once the user
// answers or skips, the row exists and it never appears again — on any
// device, with no client storage. Nothing here touches a job, a quota or
// an allowance: feedback is optional and earns nothing.
export const FEEDBACK_AFTER_PROOFS = 2;

export async function feedbackDue(db: Database | Transaction, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: researchBetaFeedback.id })
    .from(researchBetaFeedback)
    .where(eq(researchBetaFeedback.userId, userId));
  if (row) return false;
  return (await countPrivateBetaProofs(db, userId)) >= FEEDBACK_AFTER_PROOFS;
}

const KEEP_USING = new Set(["YES", "NO", "UNSURE"]);

function boundedText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "BAD_REQUEST");
  const t = value.trim();
  if (!t) return null;
  if (t.length > FEEDBACK_TEXT_MAX) throw new HttpError(400, "FEEDBACK_TOO_LONG");
  return t;
}

// Records the one answer for the session's own user. The body names no
// user. A second write — another tab, a replay — is refused, never merged.
export async function recordBetaFeedback(
  db: Database,
  userId: string,
  body: unknown,
): Promise<"SUBMITTED" | "DISMISSED"> {
  const input = (body ?? {}) as Record<string, unknown>;
  let values: typeof researchBetaFeedback.$inferInsert;
  if (input.action === "DISMISS") {
    values = { userId, status: "DISMISSED" };
  } else if (input.action === "SUBMIT") {
    if (typeof input.keepUsing !== "string" || !KEEP_USING.has(input.keepUsing)) throw new HttpError(400, "BAD_REQUEST");
    values = {
      userId,
      status: "SUBMITTED",
      useful: boundedText(input.useful),
      missing: boundedText(input.missing),
      keepUsing: input.keepUsing as "YES" | "NO" | "UNSURE",
      changeNeeded: boundedText(input.changeNeeded),
    };
  } else {
    throw new HttpError(400, "BAD_REQUEST");
  }
  if (!(await feedbackDue(db, userId))) {
    const [existing] = await db
      .select({ id: researchBetaFeedback.id })
      .from(researchBetaFeedback)
      .where(eq(researchBetaFeedback.userId, userId));
    throw new HttpError(409, existing ? "FEEDBACK_ALREADY_RECORDED" : "FEEDBACK_NOT_DUE");
  }
  const inserted = await db
    .insert(researchBetaFeedback)
    .values(values)
    .onConflictDoNothing({ target: researchBetaFeedback.userId })
    .returning({ id: researchBetaFeedback.id });
  if (inserted.length === 0) throw new HttpError(409, "FEEDBACK_ALREADY_RECORDED");
  return values.status;
}
