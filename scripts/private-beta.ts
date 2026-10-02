// PRIVATE BETA — OWNER TOOL (D-167).
//
// The only writer of a private-beta grant and of the three private-beta
// config keys. No HTTP route reaches any of this.
//
// DRY RUN BY DEFAULT. Without --apply every command reads, reports what it
// WOULD do, and writes nothing.
//
//   npx tsx scripts/private-beta.ts status
//   npx tsx scripts/private-beta.ts config --enabled=true --projects=raydium,pump_fun,lido --limit=5 [--apply]
//   npx tsx scripts/private-beta.ts grant  --telegram-id=<id> | --user-id=<uuid>  --until=YYYY-MM-DD [--apply]
//   npx tsx scripts/private-beta.ts revoke --telegram-id=<id> | --user-id=<uuid> [--apply]
//
// A grant never changes users.role: a beta user stays role USER. The user
// must already exist (they sign in to the Mini App once); this tool never
// creates a user row.

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { and, eq, sql } from "drizzle-orm";

import { loadProductConfig } from "../src/server/config/product";
import { createDatabase, type Database } from "../src/server/db/client";
import { projects, subscriptions, userIdentities, users } from "../src/server/db/schema";
import { INTERNAL_ALPHA_LIVE_PROJECT_SLUGS } from "../src/server/engine/live-executor";
import {
  PRIVATE_BETA_GRANT_PROVIDER,
  countPrivateBetaJobs,
  grantPrivateBetaAccess,
  hasValidPrivateBetaGrant,
  revokePrivateBetaAccess,
  setPrivateBetaConfig,
} from "../src/server/services/private-beta";

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const apply = process.argv.includes("--apply");
const fail = (message: string): never => {
  console.error(`[private-beta] refusing: ${message}`);
  process.exit(1);
};

async function resolveUserId(db: Database): Promise<string> {
  const userId = arg("user-id");
  const telegramId = arg("telegram-id");
  if ((userId === undefined) === (telegramId === undefined)) fail("pass exactly one of --user-id or --telegram-id");
  if (userId !== undefined) {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) fail("--user-id is not a uuid");
    const [row] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId));
    if (!row) fail("no user with that id");
    return row.id;
  }
  const [identity] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, "TELEGRAM"), eq(userIdentities.providerUserId, telegramId!)));
  if (!identity) fail("no user has signed in with that Telegram id yet — they must open the app once first");
  return identity.userId;
}

async function status(db: Database): Promise<void> {
  const config = await loadProductConfig(db);
  console.log(`research_enabled (public path): ${config.research_enabled}`);
  console.log(`private_beta_enabled:           ${config.private_beta_enabled}`);
  console.log(`private_beta_research_limit:    ${config.private_beta_research_limit}`);
  console.log(`private_beta_project_slugs:     ${JSON.stringify(config.private_beta_project_slugs)}`);
  for (const slug of config.private_beta_project_slugs) {
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.slug, slug));
    const notes = [
      p ? `catalog ${p.status}` : "NOT IN CATALOG",
      INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(slug) ? "live-spend allowlisted" : "NOT on the live-spend allowlist",
    ];
    console.log(`  - ${slug}: ${notes.join(", ")}`);
  }
  const grants = await db
    .select({ userId: subscriptions.userId, status: subscriptions.status, validUntil: subscriptions.validUntil })
    .from(subscriptions)
    .where(eq(subscriptions.billingProvider, PRIVATE_BETA_GRANT_PROVIDER))
    .orderBy(sql`${subscriptions.createdAt}`);
  console.log(`beta grants: ${grants.length}`);
  for (const g of grants) {
    const valid = await hasValidPrivateBetaGrant(db, g.userId);
    const used = await countPrivateBetaJobs(db, g.userId);
    console.log(`  - user ${g.userId}: ${g.status}, until ${g.validUntil.toISOString().slice(0, 10)}, ${valid ? "VALID" : "not valid"}, ${used} research used`);
  }
}

async function configure(db: Database): Promise<void> {
  const enabledArg = arg("enabled");
  const projectsArg = arg("projects");
  const limitArg = arg("limit");
  if (enabledArg === undefined && projectsArg === undefined && limitArg === undefined) fail("nothing to set: pass --enabled, --projects and/or --limit");
  if (enabledArg !== undefined && enabledArg !== "true" && enabledArg !== "false") fail("--enabled must be true or false");
  const slugs = projectsArg === undefined ? undefined : projectsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (slugs !== undefined) {
    for (const slug of slugs) {
      const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.slug, slug));
      if (!p) fail(`project ${slug} is not in the catalog`);
      if (p.status !== "ACTIVE_CORE") fail(`project ${slug} is ${p.status}, not ACTIVE_CORE`);
      if (!INTERNAL_ALPHA_LIVE_PROJECT_SLUGS.has(slug)) fail(`project ${slug} is not on the live-spend allowlist`);
    }
  }
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) fail("--limit must be a non-negative integer");
  const patch = { enabled: enabledArg === undefined ? undefined : enabledArg === "true", projectSlugs: slugs, researchLimit: limit };
  console.log(`would set: ${JSON.stringify(patch)}`);
  if (!apply) return console.log("DRY RUN — nothing written. Re-run with --apply.");
  await setPrivateBetaConfig(db, patch);
  console.log("APPLIED.");
  await status(db);
}

async function grant(db: Database): Promise<void> {
  const userId = await resolveUserId(db);
  const until = arg("until");
  if (until === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(until)) fail("--until=YYYY-MM-DD is required (a grant always has an explicit expiry)");
  const validUntil = new Date(`${until}T23:59:59.000Z`);
  if (Number.isNaN(validUntil.getTime()) || validUntil.getTime() <= Date.now()) fail("--until must be a real date in the future");
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  console.log(`would grant private-beta access to user ${userId} (role ${user?.role}, unchanged) until ${validUntil.toISOString()}`);
  if (!apply) return console.log("DRY RUN — nothing written. Re-run with --apply.");
  const out = await grantPrivateBetaAccess(db, { userId, validUntil });
  console.log(`APPLIED: grant ${out.subscriptionId} ${out.created ? "created" : "re-dated"}.`);
}

async function revoke(db: Database): Promise<void> {
  const userId = await resolveUserId(db);
  console.log(`would revoke private-beta access of user ${userId} (a Research already admitted is not touched)`);
  if (!apply) return console.log("DRY RUN — nothing written. Re-run with --apply.");
  const out = await revokePrivateBetaAccess(db, { userId });
  console.log(`APPLIED: ${out.revoked} grant(s) revoked.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { db, pool } = createDatabase();
  try {
    if (command === "status") await status(db);
    else if (command === "config") await configure(db);
    else if (command === "grant") await grant(db);
    else if (command === "revoke") await revoke(db);
    else fail("usage: private-beta.ts status | config | grant | revoke   (add --apply to write)");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
