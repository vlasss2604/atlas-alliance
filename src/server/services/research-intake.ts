import { and, eq, gt, sql } from "drizzle-orm";

import type { ProductConfig } from "../config/product";
import type { Database, Transaction } from "../db/client";
import { projects, researchIntakes } from "../db/schema";
import { MAX_QUESTION_CHARS } from "../interpreter/interpret";
import { privateBetaOpen, privateBetaProjectAllowed } from "./private-beta";

// RESEARCH INTAKE SERVICE — platform-independent (D-125).
//
// An intake is a claim a user handed in, waiting for that user to turn it
// into a question on the Ask screen. This module knows nothing about
// Telegram: the entry adapter resolves the sender to a canonical user and
// hands over bounded text plus optional source context. It writes no
// interpretation, no job, no source, no evidence — only this one row.
//
// RETENTION. An intake lives 24 hours. That is long enough to open the Mini
// App later the same day and short enough that forwarded text from a
// private chat does not sit in the database indefinitely. After expiry the
// row answers 404 exactly like a row that never existed; the text is not
// read again. (A hard delete is a maintenance task, deliberately not a
// request-time side effect.)
export const INTAKE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_INTAKE_TEXT_CHARS = MAX_QUESTION_CHARS;
export const MAX_INTAKE_SOURCE_LABEL_CHARS = 120;
export const MAX_INTAKE_SOURCE_URL_CHARS = 200;

export type IntakeOrigin = "TELEGRAM_FORWARD";

export interface CreateIntakeInput {
  userId: string;
  origin: IntakeOrigin;
  rawText: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  detectedProjectSlug: string | null;
  // Delivery idempotency: the same (user, ref) returns the existing row.
  externalRef: string | null;
}

export type IntakeRow = typeof researchIntakes.$inferSelect;

const clip = (v: string | null, max: number): string | null => {
  if (v === null) return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
};

// Bounded on the way in, so the CHECK constraints are the backstop and
// never the first line: text is trimmed and clipped to the Interpreter's
// limit; empty text is refused here, before any row exists.
export async function createResearchIntake(
  db: Database,
  input: CreateIntakeInput,
): Promise<{ intake: IntakeRow; created: boolean }> {
  const rawText = input.rawText.trim().slice(0, MAX_INTAKE_TEXT_CHARS);
  if (!rawText) throw new Error("intake text is empty");
  const values = {
    userId: input.userId,
    origin: input.origin,
    rawText,
    sourceLabel: clip(input.sourceLabel, MAX_INTAKE_SOURCE_LABEL_CHARS),
    sourceUrl: clip(input.sourceUrl, MAX_INTAKE_SOURCE_URL_CHARS),
    detectedProjectSlug: input.detectedProjectSlug,
    externalRef: input.externalRef,
    expiresAt: new Date(Date.now() + INTAKE_TTL_MS),
  };
  const inserted = await db
    .insert(researchIntakes)
    .values(values)
    .onConflictDoNothing({
      target: [researchIntakes.userId, researchIntakes.externalRef],
      where: sql`external_ref IS NOT NULL`,
    })
    .returning();
  if (inserted.length > 0) return { intake: inserted[0], created: true };
  // The unique partial index refused: this delivery was already stored.
  const [existing] = await db
    .select()
    .from(researchIntakes)
    .where(and(eq(researchIntakes.userId, input.userId), eq(researchIntakes.externalRef, input.externalRef!)));
  if (!existing) throw new Error("intake insert refused without an existing row");
  return { intake: existing, created: false };
}

// THE OWNER'S READ. Ownership is a predicate on the query, exactly as on
// every job route: a row that is not this user's, does not exist, or has
// expired all come back as null and all become 404 — existence is never
// confirmed to anyone but the owner, and an expired row is as good as gone.
export async function loadResearchIntakeForUser(
  db: Database,
  input: { id: string; userId: string },
): Promise<IntakeRow | null> {
  const [row] = await db
    .select()
    .from(researchIntakes)
    .where(
      and(
        eq(researchIntakes.id, input.id),
        eq(researchIntakes.userId, input.userId),
        gt(researchIntakes.expiresAt, sql`now()`),
      ),
    );
  return row ?? null;
}

// CONSUMPTION — ONLY AFTER A RESEARCH JOB EXISTS. Called by the canonical
// start route once createResearchJob has returned a job for this user.
// Guarded on OPEN so a replayed start cannot re-stamp it, on the owner so a
// job can never consume someone else's intake, and on expiry so a stale id
// a client still holds cannot stamp a row the owner can no longer read —
// the same predicate as the owner's read, so an expired intake is gone for
// every purpose. Returns whether this call did the consuming. A start that
// failed before a job existed never reaches here, so the intake stays OPEN
// for a legitimate retry.
export async function consumeResearchIntake(
  db: Database | Transaction,
  input: { id: string; userId: string; researchJobId: string },
): Promise<boolean> {
  const rows = await db
    .update(researchIntakes)
    .set({ status: "CONSUMED", consumedAt: sql`now()`, researchJobId: input.researchJobId })
    .where(
      and(
        eq(researchIntakes.id, input.id),
        eq(researchIntakes.userId, input.userId),
        eq(researchIntakes.status, "OPEN"),
        gt(researchIntakes.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: researchIntakes.id });
  return rows.length > 0;
}

// WHAT THE CLIENT MAY SEE. Bounded, and nothing Telegram-shaped: the text,
// the detected project with its catalog name and whether private beta can
// take it (null when beta is not the gate in force), the source label and
// the public link if one exists. A CONSUMED intake returns no text — the
// Research it produced is the thing to look at now.
export interface ResearchIntakeView {
  intakeId: string;
  status: "OPEN" | "CONSUMED";
  rawText: string | null;
  detectedProject: { slug: string; name: string; availableInPrivateBeta: boolean | null } | null;
  sourceLabel: string | null;
  sourceUrl: string | null;
  researchJobId: string | null;
}

export async function toResearchIntakeView(
  db: Database,
  config: ProductConfig,
  row: IntakeRow,
): Promise<ResearchIntakeView> {
  let detectedProject: ResearchIntakeView["detectedProject"] = null;
  if (row.detectedProjectSlug) {
    const [p] = await db
      .select({ slug: projects.slug, name: projects.name })
      .from(projects)
      .where(eq(projects.slug, row.detectedProjectSlug));
    if (p) {
      detectedProject = {
        slug: p.slug,
        name: p.name,
        availableInPrivateBeta: privateBetaOpen(config) ? privateBetaProjectAllowed(config, p.slug) : null,
      };
    }
  }
  return {
    intakeId: row.id,
    status: row.status,
    rawText: row.status === "OPEN" ? row.rawText : null,
    detectedProject,
    sourceLabel: row.sourceLabel,
    sourceUrl: row.sourceUrl,
    researchJobId: row.researchJobId,
  };
}
