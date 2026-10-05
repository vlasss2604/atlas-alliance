// PRIVATE BETA — OWNER TOOL (D-167).
//
// The owner's writer of private-beta grants and of the private-beta config
// keys. No HTTP route reaches any of this (the creator invite route writes
// the same grant, for the signed-in user only — D-170).
//
// DRY RUN BY DEFAULT. Without --apply every command reads, reports what it
// WOULD do, and writes nothing.
//
//   npx tsx scripts/private-beta.ts status
//   npx tsx scripts/private-beta.ts config --enabled=true --projects=raydium,pump_fun,lido --limit=3 --global-limit=60 --creator-user-limit=20 [--apply]
//   npx tsx scripts/private-beta.ts invite --until=YYYY-MM-DD --max-redemptions=20 [--apply]   (new creator invite; replaces the old one)
//   npx tsx scripts/private-beta.ts invite --disable [--apply]
//   npx tsx scripts/private-beta.ts stop [--apply]                          (EMERGENCY STOP, see below)
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
  BETA_INVITE_PREFIX,
  PRIVATE_BETA_GRANT_PROVIDER,
  activeBetaInvite,
  countCreatorBetaUsers,
  countInviteRedemptions,
  countPrivateBetaAdmissions,
  countPrivateBetaJobs,
  newBetaInviteToken,
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
  console.log(`interpreter_enabled:            ${config.interpreter_enabled}`);
  console.log(`private_beta_research_limit:    ${config.private_beta_research_limit} per user (D-169 count)`);
  console.log(`private_beta_global_research_limit: ${config.private_beta_global_research_limit}; admitted so far: ${await countPrivateBetaAdmissions(db)} (every admitted PRIVATE_BETA job)`);
  console.log(`private_beta_creator_user_limit: ${config.private_beta_creator_user_limit}; creator-invite users so far: ${await countCreatorBetaUsers(db)} (all invites, revoked/expired included)`);
  const invite = activeBetaInvite(config);
  console.log(
    `creator invite:                 ${
      invite
        ? `ACTIVE, grants until ${invite.grantUntil.toISOString()}, redeemed by ${await countInviteRedemptions(db, invite.sha256)} of ${invite.maxRedemptions} users`
        : "none active"
    }`,
  );
  const stopped = !config.private_beta_enabled && !config.research_enabled;
  console.log(`emergency state (beta off AND public research off): ${stopped ? "YES — no new normal-user Research, no normal-user Interpreter call" : "no"}`);
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
  const globalArg = arg("global-limit");
  const creatorArg = arg("creator-user-limit");
  if (enabledArg === undefined && projectsArg === undefined && limitArg === undefined && globalArg === undefined && creatorArg === undefined) {
    fail("nothing to set: pass --enabled, --projects, --limit, --global-limit and/or --creator-user-limit");
  }
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
  const globalLimit = globalArg === undefined ? undefined : Number(globalArg);
  if (globalLimit !== undefined && (!Number.isInteger(globalLimit) || globalLimit < 0)) fail("--global-limit must be a non-negative integer");
  const creatorLimit = creatorArg === undefined ? undefined : Number(creatorArg);
  if (creatorLimit !== undefined && (!Number.isInteger(creatorLimit) || creatorLimit < 0)) fail("--creator-user-limit must be a non-negative integer");
  const patch = {
    enabled: enabledArg === undefined ? undefined : enabledArg === "true",
    projectSlugs: slugs,
    researchLimit: limit,
    globalResearchLimit: globalLimit,
    creatorUserLimit: creatorLimit,
  };
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

// THE CREATOR INVITE (D-170). A new invite replaces the previous one, which
// stops working at once (within the 60-second config cache). Only the
// SHA-256 is stored; the invite itself is printed once, here, and nowhere
// else. It carries no user and no PII.
async function invite(db: Database): Promise<void> {
  if (process.argv.includes("--disable")) {
    console.log("would disable the creator invite (users already granted keep their grant)");
    if (!apply) return console.log("DRY RUN — nothing written. Re-run with --apply.");
    await setPrivateBetaConfig(db, { invite: { enabled: false, sha256: "", grantUntil: "", maxRedemptions: 0 } });
    return console.log("APPLIED: creator invite disabled.");
  }
  const until = arg("until");
  if (until === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(until)) fail("--until=YYYY-MM-DD is required (the grant each redeemer receives expires then)");
  const grantUntil = new Date(`${until}T23:59:59.000Z`);
  if (Number.isNaN(grantUntil.getTime()) || grantUntil.getTime() <= Date.now()) fail("--until must be a real date in the future");
  const maxArg = arg("max-redemptions");
  const maxRedemptions = maxArg === undefined ? NaN : Number(maxArg);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) fail("--max-redemptions=<N> is required: how many distinct users this invite may grant (Wave 1: 20)");
  console.log(
    `would create a new creator invite granting private beta until ${grantUntil.toISOString()} to at most ${maxRedemptions} users (replaces any current invite; every invite also counts against the creator-wide user limit)`,
  );
  if (!apply) return console.log("DRY RUN — nothing written. Re-run with --apply.");
  const { token, sha256 } = newBetaInviteToken();
  await setPrivateBetaConfig(db, { invite: { enabled: true, sha256, grantUntil: grantUntil.toISOString(), maxRedemptions } });
  console.log("APPLIED. Start parameter (shown once — store it yourself):");
  console.log(`  ${BETA_INVITE_PREFIX}${token}`);
  console.log("Creator link: https://t.me/<bot_username>/<mini_app_short_name>?startapp=" + `${BETA_INVITE_PREFIX}${token}`);
}

// EMERGENCY STOP (D-170). Turns private beta off and confirms the public
// path is off too. In that state no normal user can start a Research or
// cause an Interpreter call (interpreterAccessRefusal → RESEARCH_DISABLED).
// Nothing is deleted: the Research Library and every Proof stay readable.
// Already-admitted beta Research is not killed: a phased one is refused at
// its next phase boundary (the execution-time gate re-reads the switch)
// and ends FAILED — the phase in progress completes; a non-phased one that
// is already executing finishes, and one still queued is refused when a
// worker picks it up. Every one of them stays counted against the global
// capacity; FAILED hands the user's personal slot back (D-169).
// To resume: config --enabled=true --apply.
async function stop(db: Database): Promise<void> {
  const config = await loadProductConfig(db);
  if (config.research_enabled) {
    fail("research_enabled (the public path) is ON: this tool does not touch it. Turn it off deliberately first, or the public path stays open.");
  }
  console.log("would set private_beta_enabled=false (public research already off) — no data is changed or deleted");
  if (!apply) return console.log("DRY RUN — nothing written. Re-run with --apply.");
  await setPrivateBetaConfig(db, { enabled: false });
  console.log("APPLIED: emergency stop in effect within the 60-second config cache.");
  await status(db);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { db, pool } = createDatabase();
  try {
    if (command === "status") await status(db);
    else if (command === "config") await configure(db);
    else if (command === "grant") await grant(db);
    else if (command === "revoke") await revoke(db);
    else if (command === "invite") await invite(db);
    else if (command === "stop") await stop(db);
    else fail("usage: private-beta.ts status | config | grant | revoke | invite | stop   (add --apply to write)");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
