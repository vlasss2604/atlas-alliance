import { and, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database, Transaction } from "../db/client";
import { productConfig, researchJobs, subscriptions, users } from "../db/schema";
import type { ProductConfig } from "../config/product";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../engine/live-executor";

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

// Every Research this user was ever admitted for under private beta —
// whatever became of it. The cap bounds spend, and a failed or cancelled
// run was still admitted and still spent.
export async function countPrivateBetaJobs(db: Database | Transaction, userId: string): Promise<number> {
  const [{ n }] = (
    await db.execute(sql`
      SELECT count(*)::int AS n FROM ${researchJobs}
      WHERE user_id = ${userId} AND origin = 'PRIVATE_BETA'
    `)
  ).rows as [{ n: number }];
  return n;
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
  if (subject.projectSlugs.length === 0 || !subject.projectSlugs.every((s) => privateBetaProjectAllowed(config, s))) {
    return "BETA_PROJECT_NOT_AVAILABLE";
  }
  if ((await countPrivateBetaJobs(db, subject.userId)) >= config.private_beta_research_limit) {
    return "BETA_RESEARCH_LIMIT_REACHED";
  }
  return null;
}

// WHO MAY SPEND INTERPRETER / PROVIDER BUDGET DURING PRIVATE BETA: the owner
// (ADMIN, the existing owner-alpha path) and a user holding a valid grant.
// Nobody else — sign-in stays open, a model call does not.
//
// "During private beta" is exactly privateBetaOpen: the beta switch on,
// whatever research_enabled says. With the switch off the product is in its
// pre-beta state and the Interpreter is governed as it always was
// (interpreter_enabled, owner decision №3) — its honest answer to an
// ordinary user there is "research is disabled", not "beta access
// required" for a beta that is not running. Stopping all Interpreter spend
// is interpreter_enabled's job, not this function's.
export async function interpreterAccessRefusal(
  db: Database | Transaction,
  config: ProductConfig,
  userId: string,
): Promise<"BETA_ACCESS_REQUIRED" | null> {
  if (!privateBetaOpen(config)) return null;
  const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (actor?.role === "ADMIN") return null;
  if (await hasValidPrivateBetaGrant(db, userId)) return null;
  return "BETA_ACCESS_REQUIRED";
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
  db: Database,
  input: { userId: string; validUntil: Date },
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
        planVersion: "private-beta-wave-1",
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

// Writes the three private-beta config keys that were passed, and only
// those. Server-owned: there is no client path to any of them.
export async function setPrivateBetaConfig(
  db: Database,
  patch: { enabled?: boolean; projectSlugs?: string[]; researchLimit?: number },
): Promise<void> {
  const entries: [string, unknown][] = [];
  if (patch.enabled !== undefined) entries.push(["private_beta_enabled", patch.enabled]);
  if (patch.projectSlugs !== undefined) entries.push(["private_beta_project_slugs", patch.projectSlugs]);
  if (patch.researchLimit !== undefined) entries.push(["private_beta_research_limit", patch.researchLimit]);
  for (const [key, value] of entries) {
    await db
      .insert(productConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: productConfig.key, set: { value, updatedAt: new Date() } });
  }
}
