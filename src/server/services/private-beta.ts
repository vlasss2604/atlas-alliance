import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { productConfig, proofs, researchJobs, subscriptions, users } from "../db/schema";
import type { ProductConfig } from "../config/product";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../engine/live-executor";
import { PROOF_BEARING_TERMINAL_STATES } from "../jobs/research-jobs";

// PRIVATE BETA ACCESS (Founder-approved, D-167).
//
// FOUR DIFFERENT THINGS, KEPT APART:
//   A. permission to run Research      — the beta grant below;
//   B. admin / owner privileges        — users.role, untouched: a beta user
//                                        stays role USER and nothing here
//                                        reads or writes a role;
//   C. access to another user's work   — never: every job route filters by
//                                        the session's own user id;
//   D. budget                          — server-owned (the owner-alpha
//                                        envelope + private_beta_research_limit),
//                                        never taken from the client.
//
// THE GRANT IS AN EXISTING ENTITLEMENT, NOT A NEW AUTH SYSTEM. A beta grant
// is one `subscriptions` row — the entitlement mechanism this product
// already computes (services/entitlement.ts) — at the existing ARI_CORE
// level, with an explicit expiry (valid_until), no auto-renewal, and a
// server-owned marker in billing_provider. No purchase flow writes that
// marker; only the owner tool does (grantPrivateBetaAccess).
export const PRIVATE_BETA_GRANT_PROVIDER = "PRIVATE_BETA_GRANT";

export type PrivateBetaRefusal =
  | "BETA_ACCESS_REQUIRED"
  | "GLOBAL_BETA_CAPACITY_REACHED"
  | "BETA_PROJECT_NOT_AVAILABLE"
  | "BETA_RESEARCH_LIMIT_REACHED";

// Private beta is in effect exactly while the beta switch is on — whatever
// research_enabled says. While it is on, a non-ADMIN user's Research is
// decided by private-beta admission and by nothing else, so a beta user can
// never fall through to the PRODUCT path (whose executor is non-live).
export function privateBetaOpen(config: ProductConfig): boolean {
  return config.private_beta_enabled;
}

// A valid grant NOW: entitling status, not expired, ARI_CORE, never
// auto-renewing, carrying the server-owned marker.
export async function hasValidPrivateBetaGrant(db: Database | Transaction, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ["ACTIVE", "CANCEL_AT_PERIOD_END"]),
        gt(subscriptions.validUntil, sql`now()`),
        eq(subscriptions.level, "ARI_CORE"),
        eq(subscriptions.autoRenew, false),
        eq(subscriptions.billingProvider, PRIVATE_BETA_GRANT_PROVIDER),
      ),
    );
  return rows.length > 0;
}

// A project is available to private beta only when BOTH lists hold it: the
// configured beta list (empty by default) and the code-owned live-spend
// allowlist. Neither list alone is enough, and a beta user can add to
// neither.
export function privateBetaProjectAllowed(config: Pick<ProductConfig, "private_beta_project_slugs">, slug: string): boolean {
  return config.private_beta_project_slugs.includes(slug) && INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(slug);
}

// WHAT COUNTS AGAINST THE BETA ALLOWANCE (D-169). A beta job occupies a
// slot while it is still active (QUEUED, RUNNING, AWAITING_CLARIFICATION —
// exactly the states the one-active-job index guards). Once finished, it
// keeps the slot permanently when:
//   - it ended in a proof-bearing terminal state WITH a proofs row (the
//     same rule and the same states as the DEMO ledger), or
//   - the user cancelled it after execution had started. Paid work may
//     already have run, so cancelling must never hand the slot back:
//     otherwise start → cancel → start again would consume unbounded beta
//     spend. "Started" is `started_at`, stamped on the first entry into
//     RUNNING and never cleared; the state machine allows CANCELLED without
//     RUNNING only straight from QUEUED, where `started_at` is still NULL.
// A FAILED job, a job cancelled while still QUEUED, and a terminal with no
// Proof hand the slot back: a system failure never punishes the user. No
// ledger row is added: the job, its start stamp and its Proof are the record.
export async function countPrivateBetaJobs(db: Database | Transaction, userId: string): Promise<number> {
  const proofBearing = sql.join([...PROOF_BEARING_TERMINAL_STATES].map((s) => sql`${s}`), sql`, `);
  const [{ n }] = (
    await db.execute(sql`
      SELECT count(*)::int AS n FROM ${researchJobs} j
      WHERE j.user_id = ${userId} AND j.origin = 'PRIVATE_BETA'
        AND (
          j.state IN ('QUEUED', 'RUNNING', 'AWAITING_CLARIFICATION')
          OR (
            j.state IN (${proofBearing})
            AND EXISTS (SELECT 1 FROM ${proofs} p WHERE p.research_job_id = j.id)
          )
          OR (j.state = 'CANCELLED' AND j.started_at IS NOT NULL)
        )
    `)
  ).rows as [{ n: number }];
  return n;
}

// THE GLOBAL CREATOR-BETA CAPACITY (D-170) — A DIFFERENT MEANING FROM THE
// PERSONAL ALLOWANCE ABOVE, ON PURPOSE. The personal count is fair to one
// user (a system failure hands the slot back). This count bounds what the
// beta can spend: every PRIVATE_BETA job that was ever admitted counts,
// permanently, whatever became of it — succeeded, failed, cancelled,
// stopped at budget, waiting for clarification. A job row exists only
// after admission succeeded, so the row IS the admission record.
export async function countPrivateBetaAdmissions(db: Database | Transaction): Promise<number> {
  const [{ n }] = (
    await db.execute(sql`SELECT count(*)::int AS n FROM ${researchJobs} WHERE origin = 'PRIVATE_BETA'`)
  ).rows as [{ n: number }];
  return n;
}

export async function privateBetaCapacityReached(db: Database | Transaction, config: ProductConfig): Promise<boolean> {
  return (await countPrivateBetaAdmissions(db)) >= config.private_beta_global_research_limit;
}

// One fixed advisory-lock key for private-beta admission. Held for the
// rest of the job-creating transaction (pg_advisory_xact_lock), so
// "count the admitted jobs → admit → insert the job" is serial across
// every concurrent start: two starts can never both see 59 and both write
// the 60th and 61st job. Released by commit or rollback; nothing else
// takes this key.
export const PRIVATE_BETA_ADMISSION_LOCK_KEY = 170_001;

export async function lockPrivateBetaAdmission(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIVATE_BETA_ADMISSION_LOCK_KEY}::bigint)`);
}

// Beta Researches of this user that ended with a durable Proof — the same
// proof-bearing rule the personal allowance uses. Drives the feedback
// prompt (D-170); spends and grants nothing.
export async function countPrivateBetaProofs(db: Database | Transaction, userId: string): Promise<number> {
  const proofBearing = sql.join([...PROOF_BEARING_TERMINAL_STATES].map((s) => sql`${s}`), sql`, `);
  const [{ n }] = (
    await db.execute(sql`
      SELECT count(*)::int AS n FROM ${researchJobs} j
      WHERE j.user_id = ${userId} AND j.origin = 'PRIVATE_BETA'
        AND j.state IN (${proofBearing})
        AND EXISTS (SELECT 1 FROM ${proofs} p WHERE p.research_job_id = j.id)
    `)
  ).rows as [{ n: number }];
  return n;
}

// What the user is shown about their own allowance (D-170): only while
// private beta is what admits them (switch on, not the owner, a valid
// grant). Same counting rule as admission — never a second one.
export interface PrivateBetaAllowance {
  used: number;
  limit: number;
  remaining: number;
}

export async function privateBetaAllowanceFor(
  db: Database | Transaction,
  config: ProductConfig,
  user: { userId: string; role: string },
): Promise<PrivateBetaAllowance | null> {
  if (!privateBetaOpen(config) || user.role === "ADMIN") return null;
  if (!(await hasValidPrivateBetaGrant(db, user.userId))) return null;
  const used = await countPrivateBetaJobs(db, user.userId);
  const limit = config.private_beta_research_limit;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

// THE ONE ADMISSION RULE, shared by enforcement (start-private-beta-
// research.ts) and by the Ask-screen preview (gates.ts), so the preview can
// never promise what POST /api/research-jobs will refuse. Order: who you
// are, what you asked about, how much you have used. Scope (ACTIVE_CORE) and
// "one active job" are checked by the callers exactly as on every path.
export async function evaluatePrivateBetaAdmission(
  db: Database | Transaction,
  config: ProductConfig,
  subject: { userId: string; projectSlugs: readonly string[] },
): Promise<PrivateBetaRefusal | null> {
  if (!(await hasValidPrivateBetaGrant(db, subject.userId))) return "BETA_ACCESS_REQUIRED";
  // Capacity before anything personal: when the beta is full the answer is
  // the same for everyone and says nothing about this user's allowance.
  if (await privateBetaCapacityReached(db, config)) return "GLOBAL_BETA_CAPACITY_REACHED";
  if (subject.projectSlugs.length === 0 || !subject.projectSlugs.every((s) => privateBetaProjectAllowed(config, s))) {
    return "BETA_PROJECT_NOT_AVAILABLE";
  }
  if ((await countPrivateBetaJobs(db, subject.userId)) >= config.private_beta_research_limit) {
    return "BETA_RESEARCH_LIMIT_REACHED";
  }
  return null;
}

// WHO MAY CAUSE A MODEL-BACKED INTERPRETER CALL (D-167, tightened D-170).
// An interpretation is provider spend; for an ordinary user it is only
// worth paying for when a Research could follow it. Asked before the rate
// limit and before the model, so a refusal costs nothing.
//
//   ADMIN (the owner, incl. owner alpha)          → always allowed, as before
//   private beta ON:  no valid grant              → BETA_ACCESS_REQUIRED
//                     global capacity reached     → GLOBAL_BETA_CAPACITY_REACHED
//                     personal allowance used up
//                     (the D-169 count, as admission) → BETA_RESEARCH_LIMIT_REACHED
//                     otherwise                   → allowed
//   private beta OFF: public research ON          → allowed (the product path)
//                     public research OFF         → RESEARCH_DISABLED
//
// The last row is the emergency state: switching the beta off no longer
// reopens the Interpreter to every signed-in user, because with both
// switches off no Research can follow an interpretation. Stopping ALL
// Interpreter spend, the owner included, stays interpreter_enabled's job.
export type InterpreterAccessRefusal =
  | "BETA_ACCESS_REQUIRED"
  | "GLOBAL_BETA_CAPACITY_REACHED"
  | "BETA_RESEARCH_LIMIT_REACHED"
  | "RESEARCH_DISABLED";

export async function interpreterAccessRefusal(
  db: Database | Transaction,
  config: ProductConfig,
  userId: string,
): Promise<InterpreterAccessRefusal | null> {
  const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (actor?.role === "ADMIN") return null;
  if (privateBetaOpen(config)) {
    if (!(await hasValidPrivateBetaGrant(db, userId))) return "BETA_ACCESS_REQUIRED";
    if (await privateBetaCapacityReached(db, config)) return "GLOBAL_BETA_CAPACITY_REACHED";
    if ((await countPrivateBetaJobs(db, userId)) >= config.private_beta_research_limit) return "BETA_RESEARCH_LIMIT_REACHED";
    return null;
  }
  return config.research_enabled ? null : "RESEARCH_DISABLED";
}

/* ------------------------------------------------------------------ *
 * OWNER TOOLING — the only writers of a grant and of the beta config.
 * Never reachable from an HTTP route.
 * ------------------------------------------------------------------ */

export class PrivateBetaGrantError extends Error {
  constructor(public readonly reason: "USER_NOT_FOUND" | "EXPIRY_NOT_IN_FUTURE" | "OTHER_ENTITLEMENT_EXISTS") {
    super(`private-beta grant refused: ${reason}`);
    this.name = "PrivateBetaGrantError";
  }
}

// Grants (or re-dates) one user's beta access. Never touches users.role.
// A user who already holds a NON-beta entitling subscription is refused
// rather than silently converted.
export async function grantPrivateBetaAccess(
  db: Database | Transaction,
  input: { userId: string; validUntil: Date; planVersion?: string },
): Promise<{ subscriptionId: string; created: boolean }> {
  if (input.validUntil.getTime() <= Date.now()) throw new PrivateBetaGrantError("EXPIRY_NOT_IN_FUTURE");
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
    if (!user) throw new PrivateBetaGrantError("USER_NOT_FOUND");
    const entitling = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, input.userId), inArray(subscriptions.status, ["ACTIVE", "CANCEL_AT_PERIOD_END"])));
    const existing = entitling[0];
    if (existing) {
      if (existing.billingProvider !== PRIVATE_BETA_GRANT_PROVIDER) throw new PrivateBetaGrantError("OTHER_ENTITLEMENT_EXISTS");
      await tx
        .update(subscriptions)
        .set({ status: "ACTIVE", validUntil: input.validUntil, autoRenew: false, level: "ARI_CORE" })
        .where(eq(subscriptions.id, existing.id));
      return { subscriptionId: existing.id, created: false };
    }
    const [row] = await tx
      .insert(subscriptions)
      .values({
        userId: input.userId,
        level: "ARI_CORE",
        status: "ACTIVE",
        validFrom: new Date(),
        validUntil: input.validUntil,
        autoRenew: false,
        billingProvider: PRIVATE_BETA_GRANT_PROVIDER,
        planVersion: input.planVersion ?? "private-beta-wave-1",
      })
      .returning({ id: subscriptions.id });
    return { subscriptionId: row.id, created: true };
  });
}

// Revokes a user's beta grant. Future admissions are refused; a Research
// already admitted is not touched (it never re-reads the grant).
export async function revokePrivateBetaAccess(db: Database, input: { userId: string }): Promise<{ revoked: number }> {
  const rows = await db
    .update(subscriptions)
    .set({ status: "CANCELLED", cancelledReason: "private beta grant revoked" })
    .where(
      and(
        eq(subscriptions.userId, input.userId),
        inArray(subscriptions.status, ["ACTIVE", "CANCEL_AT_PERIOD_END"]),
        eq(subscriptions.billingProvider, PRIVATE_BETA_GRANT_PROVIDER),
      ),
    )
    .returning({ id: subscriptions.id });
  return { revoked: rows.length };
}

// Writes the private-beta config keys that were passed, and only those. Server-owned: there is no client path to any of them.
export async function setPrivateBetaConfig(
  db: Database,
  patch: {
    enabled?: boolean;
    projectSlugs?: string[];
    researchLimit?: number;
    globalResearchLimit?: number;
    creatorUserLimit?: number;
    invite?: ProductConfig["private_beta_invite"];
  },
): Promise<void> {
  const entries: [string, unknown][] = [];
  if (patch.enabled !== undefined) entries.push(["private_beta_enabled", patch.enabled]);
  if (patch.projectSlugs !== undefined) entries.push(["private_beta_project_slugs", patch.projectSlugs]);
  if (patch.researchLimit !== undefined) entries.push(["private_beta_research_limit", patch.researchLimit]);
  if (patch.globalResearchLimit !== undefined) entries.push(["private_beta_global_research_limit", patch.globalResearchLimit]);
  if (patch.creatorUserLimit !== undefined) entries.push(["private_beta_creator_user_limit", patch.creatorUserLimit]);
  if (patch.invite !== undefined) entries.push(["private_beta_invite", patch.invite]);
  for (const [key, value] of entries) {
    await db
      .insert(productConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: productConfig.key, set: { value, updatedAt: new Date() } });
  }
}

/* ------------------------------------------------------------------ *
 * CREATOR BETA INVITE (D-170)
 * ------------------------------------------------------------------ */

// The launch form of an invite: the Telegram start parameter
// `beta_<token>`. A D-168 intake id is a bare uuid and can never start
// with "beta_" (t is not a hex digit), so the two never collide.
export const BETA_INVITE_PREFIX = "beta_";
const INVITE_TOKEN = /^[A-Za-z0-9_-]{32,48}$/;

// A fresh opaque invite: 24 random bytes, base64url. No user, no PII, no
// campaign data inside — only the owner tool calls this.
export function newBetaInviteToken(): { token: string; sha256: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, sha256: sha256Hex(token) };
}

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// The configured invite, or null when it does not admit anyone: disabled,
// malformed, or past its grant date. Fails closed on every doubt.
export function activeBetaInvite(
  config: ProductConfig,
): { sha256: string; grantUntil: Date; maxRedemptions: number } | null {
  const inv = config.private_beta_invite;
  if (!inv.enabled || !/^[0-9a-f]{64}$/.test(inv.sha256)) return null;
  const grantUntil = new Date(inv.grantUntil);
  if (Number.isNaN(grantUntil.getTime()) || grantUntil.getTime() <= Date.now()) return null;
  return { sha256: inv.sha256, grantUntil, maxRedemptions: inv.maxRedemptions };
}

// WHICH GRANTS AN INVITE WROTE. Every grant written through an invite
// carries this tag in subscriptions.plan_version (a free-text column only
// the beta grant writes), derived from the invite's hash — never the
// invite itself, never a user. Two counts read it, in any status (a
// revoked or expired grant still used its slot):
//   - this invite's tag           → that invite's own redemption count;
//   - the shared CREATOR_GRANT_PREFIX → distinct users ever granted by ANY
//     creator invite: the Wave-wide ceiling. A manual owner grant carries
//     "private-beta-wave-1" and is never counted here.
export const CREATOR_GRANT_PREFIX = "creator-invite:";

export function inviteGrantTag(sha256: string): string {
  return `${CREATOR_GRANT_PREFIX}${sha256.slice(0, 16)}`;
}

export async function countCreatorBetaUsers(db: Database | Transaction): Promise<number> {
  const [{ n }] = (
    await db.execute(sql`
      SELECT count(DISTINCT user_id)::int AS n FROM ${subscriptions}
      WHERE billing_provider = ${PRIVATE_BETA_GRANT_PROVIDER}
        AND starts_with(plan_version, ${CREATOR_GRANT_PREFIX})
    `)
  ).rows as [{ n: number }];
  return n;
}

export async function countInviteRedemptions(db: Database | Transaction, sha256: string): Promise<number> {
  const [{ n }] = (
    await db.execute(sql`
      SELECT count(*)::int AS n FROM ${subscriptions}
      WHERE billing_provider = ${PRIVATE_BETA_GRANT_PROVIDER} AND plan_version = ${inviteGrantTag(sha256)}
    `)
  ).rows as [{ n: number }];
  return n;
}

// Serializes EVERY redemption, whatever the token: "count → grant" is one
// step across all concurrent requests, so neither the per-invite bound nor
// the creator-wide ceiling can be raced past.
export const BETA_INVITE_REDEMPTION_LOCK_KEY = 170_002;

export type InviteRedemption = "GRANTED" | "ALREADY_GRANTED";
export class BetaInviteRefusal extends Error {
  constructor(public readonly reason: "INVITE_INVALID" | "INVITE_NOT_APPLICABLE" | "BETA_ACCESS_FULL") {
    super(`creator beta invite refused: ${reason}`);
    this.name = "BetaInviteRefusal";
  }
}

// THE ONLY NON-OWNER WRITER OF A BETA GRANT, and it writes the SAME grant
// the owner tool writes (grantPrivateBetaAccess) — no second entitlement.
// The target is always the caller's own canonical user id, taken from the
// session by the route; nothing in the request names a user.
//
//   invite wrong / disabled / expired      → INVITE_INVALID (one answer)
//   already holding a valid beta grant     → ALREADY_GRANTED, untouched
//                                            (never re-dated, never shortened)
//   held a beta grant that is now revoked
//   or expired                             → INVITE_NOT_APPLICABLE: a public
//                                            link never undoes the owner's
//                                            revocation; re-granting is the
//                                            owner's call
//   holding a non-beta entitlement         → INVITE_NOT_APPLICABLE
//   creator invites have granted
//   private_beta_creator_user_limit
//   distinct users in total, any token     → BETA_ACCESS_FULL (generic)
//   this invite has granted maxRedemptions → BETA_ACCESS_FULL (generic)
//   otherwise                              → GRANTED until the invite's date
// Everything after the hash check runs in ONE transaction under one
// advisory lock, so the bound holds under concurrent redemptions and a
// user who is already granted never consumes a second slot.
export async function redeemBetaInvite(
  db: Database,
  config: ProductConfig,
  input: { userId: string; invite: string },
): Promise<InviteRedemption> {
  const active = activeBetaInvite(config);
  const token = input.invite.startsWith(BETA_INVITE_PREFIX) ? input.invite.slice(BETA_INVITE_PREFIX.length) : input.invite;
  if (!active || !INVITE_TOKEN.test(token)) throw new BetaInviteRefusal("INVITE_INVALID");
  const a = Buffer.from(sha256Hex(token));
  const b = Buffer.from(active.sha256);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BetaInviteRefusal("INVITE_INVALID");

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BETA_INVITE_REDEMPTION_LOCK_KEY}::bigint)`);
    if (await hasValidPrivateBetaGrant(tx, input.userId)) return "ALREADY_GRANTED";
    const prior = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, input.userId), eq(subscriptions.billingProvider, PRIVATE_BETA_GRANT_PROVIDER)));
    if (prior.length > 0) throw new BetaInviteRefusal("INVITE_NOT_APPLICABLE");
    // Reaching here means this user has never held a beta grant of any
    // kind, so granting them adds exactly one distinct creator-beta user.
    if ((await countCreatorBetaUsers(tx)) >= config.private_beta_creator_user_limit) {
      throw new BetaInviteRefusal("BETA_ACCESS_FULL");
    }
    if ((await countInviteRedemptions(tx, active.sha256)) >= active.maxRedemptions) {
      throw new BetaInviteRefusal("BETA_ACCESS_FULL");
    }
    try {
      await grantPrivateBetaAccess(tx, {
        userId: input.userId,
        validUntil: active.grantUntil,
        planVersion: inviteGrantTag(active.sha256),
      });
    } catch (e) {
      if (e instanceof PrivateBetaGrantError) throw new BetaInviteRefusal("INVITE_NOT_APPLICABLE");
      throw e;
    }
    return "GRANTED" as const;
  });
}
