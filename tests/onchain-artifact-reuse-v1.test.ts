import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { onchainArtifacts, projects, topics, users } from "../src/server/db/schema";
import {
  REUSABLE_INTENT_KINDS,
  findReusableSameJobArtifact,
  runStructuredOnchainAcquisition,
  type MechanismLocator,
} from "../src/server/engine/onchain-acquisition";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { runMemoryPlanningStage } from "../src/server/memory/plan-job";
import { confirmProjectIdentity } from "../src/server/memory/project-identity-confirmation";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// SAME-JOB DETERMINISTIC ARTIFACT REUSE.
//
// THE CASE. Different components ask the SAME deterministic question of the
// SAME subject in one job — "what kind of account is this", "which token
// accounts does it own for our mint" — and each repeat used to spend a
// protected source open on a real RPC read. A live run made 13 chain reads
// over 6 distinct canonical questions; every repeat returned a
// BYTE-IDENTICAL decoded result, with only the observation slot advanced.
//
// WHAT REUSE IS. Consuming the observation this job already holds: same
// artifact id, same slot, same provider provenance, same decoded content.
// It is NOT a second observation, and these tests assert that it is never
// recorded as one.
//
// WHAT REUSE IS NOT ALLOWED TO TOUCH, and the two exclusions carry the
// weight of this suite: TOKEN_SUPPLY, because the whole supply interval is
// slot arithmetic and a reused reading would collapse t0 -> event -> t1;
// and SIGNATURES_FOR_ADDRESS, because it is a window of the newest
// signatures at read time.
//
// Every identifier is a fixture literal. No project, mint or transaction is
// named anywhere in this file.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);
afterAll(async () => {
  await ctx.close();
});

const ONCHAIN_CLASSES = ["ONCHAIN_VERIFIABLE"] as const;
const EXECUTION = { step: 4, component: "EXECUTION_EVIDENCE" };
const DESTINATION = { step: 6, component: "DESTINATION" };
const FLOW_PATH = { step: 2, component: "FLOW_PATH" };
const CURRENT_STATE = { step: 5, component: "CURRENT_STATE" };

let seq = 0;
function nextBase58(len: number, tag: string): string {
  seq += 1;
  let digits = "";
  let n = seq;
  do {
    digits = "123456789"[n % 9] + digits;
    n = Math.floor(n / 9);
  } while (n > 0);
  return (`${tag}${digits}` + "z".repeat(len)).slice(0, len);
}

interface Fixture {
  projectId: string;
  jobId: string;
  mint: string;
  wallet: string;
  walletB: string;
  tokenAccount: string;
  identity: ConfirmedProjectIdentity;
}

async function makeFixture(): Promise<Fixture> {
  const slug = uniq("reuse");
  const mint = nextBase58(44, "Mint");
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug, name: "Reuse fixture", status: "ACTIVE_CORE" })
    .returning();
  const ok = await confirmProjectIdentity(ctx.db, { projectSlug: slug, chain: "solana", tokenAddress: mint });
  if (!ok.ok) throw new Error("fixture identity failed");
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "does the mechanism reduce supply?",
    normalizedTask: { project_slug: slug, project_slugs: [slug], task: "reuse" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  await runMemoryPlanningStage(ctx.db, job.id);
  return {
    projectId: project.id,
    jobId: job.id,
    mint,
    wallet: nextBase58(44, "Wa11et"),
    walletB: nextBase58(44, "Wa11etB"),
    tokenAccount: nextBase58(44, "TokenAcct"),
    identity: { chain: "solana", tokenAddress: mint, ticker: null },
  };
}

// Answers by intent KIND and SUBJECT only, and counts every call. Slots
// ADVANCE on each call, exactly as a live chain does — so a reused artifact
// is distinguishable from a fresh one by its slot alone.
function countingRetriever(f: Fixture) {
  const asked: OnchainIntent[] = [];
  let slot = 1000;
  return {
    asked,
    retriever: {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent): Promise<OnchainArtifact> => {
        asked.push(intent);
        slot += 1;
        const result: OnchainResult =
          intent.kind === "ACCOUNT_INFO"
            ? {
                kind: "ACCOUNT_INFO",
                address: intent.subject,
                exists: true,
                ownerProgram: "SysProg11111111111111111111111111111111111",
                executable: false,
                lamports: "1000",
                tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
                tokenAccount: null,
              }
            : intent.kind === "TOKEN_ACCOUNTS_BY_OWNER"
              ? {
                  kind: "TOKEN_ACCOUNTS_BY_OWNER",
                  owner: intent.subject,
                  mint: f.mint,
                  rejectedCount: 0,
                  accounts: [
                    { account: f.tokenAccount, owner: intent.subject, mint: f.mint, amountRaw: "0", decimals: 6 },
                  ],
                }
              : intent.kind === "SIGNATURES_FOR_ADDRESS"
                ? {
                    kind: "SIGNATURES_FOR_ADDRESS",
                    address: intent.subject,
                    signatures: [
                      { signature: nextBase58(88, "Sig"), slot, blockTime: 1_700_000_000, err: false, memo: null },
                    ],
                  }
                : intent.kind === "TRANSACTION_DETAIL"
                  ? {
                      kind: "TRANSACTION_DETAIL",
                      signature: intent.subject,
                      slot,
                      blockTime: 1_700_000_000,
                      succeeded: true,
                      burns: [],
                      programs: [],
                      accountKeys: [],
                      tokenInstructions: [],
                      lifecycleInstructions: [],
                      preTokenBalances: [],
                      postTokenBalances: [],
                    }
                  : { kind: "TOKEN_SUPPLY", mint: f.mint, amountRaw: "1000", decimals: 6 };
        return brandOnchainArtifact({
          intent,
          canonicalUri: buildCanonicalOnchainUri(intent),
          result,
          normalizedText: JSON.stringify(result),
          provenance: {
            chain: "solana",
            network: "mainnet",
            projectAnchor: f.mint,
            subjectKind: intent.subjectKind,
            subject: intent.subject,
            slot,
            blockTime: 1_700_000_000,
            blockHash: null,
            finality: "finalized",
            retrievalMethod: "RPC",
            providerId: "fixture-provider",
            providerMethod: "fixture-method",
            requestParams: { subject: intent.subject },
            retrievedAt: new Date(),
            rawResponseHash: `sha256:raw:${intent.kind}:${intent.subject}:${slot}`,
            artifactHash: `sha256:art:${intent.kind}:${intent.subject}`,
            transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
          },
        });
      },
    },
  };
}

const locator = (value: string): MechanismLocator => ({
  value,
  shape: "ADDRESS_LIKE",
  origin: "ADMITTED_EVIDENCE_SOURCE",
});

async function run(
  f: Fixture,
  item: { step: number; component: string },
  fixture: ReturnType<typeof countingRetriever>,
  locators: MechanismLocator[],
) {
  const traced: { operationType: string; reasonCode?: string }[] = [];
  const reserved: number[] = [];
  const outcome = await runStructuredOnchainAcquisition({
    db: ctx.db,
    jobId: f.jobId,
    attemptId: null,
    item,
    plan: { establishingClasses: ONCHAIN_CLASSES, confirmedIdentity: f.identity },
    locators,
    maxSourceOpens: 24,
    retriever: fixture.retriever,
    reserve: async (_a, amount) => {
      reserved.push(amount);
      return true;
    },
    recordTrace: async (e) => {
      traced.push({ operationType: e.operationType, reasonCode: e.reasonCode });
    },
  });
  return { outcome, traced, reserved };
}

const artifactsFor = (jobId: string, kind: string) =>
  ctx.db
    .select()
    .from(onchainArtifacts)
    .where(and(eq(onchainArtifacts.researchJobId, jobId), eq(onchainArtifacts.intentKind, kind as never)));

// ---------------------------------------------------------------------
describe("the allowlist is closed, and the two exclusions are in it by construction", () => {
  it("exactly three kinds are reusable", () => {
    expect([...REUSABLE_INTENT_KINDS].sort()).toEqual(
      ["ACCOUNT_INFO", "TOKEN_ACCOUNTS_BY_OWNER", "TRANSACTION_DETAIL"].sort(),
    );
  });

  it("7/8. TOKEN_SUPPLY and SIGNATURES_FOR_ADDRESS are excluded", () => {
    expect(REUSABLE_INTENT_KINDS.has("TOKEN_SUPPLY")).toBe(false);
    expect(REUSABLE_INTENT_KINDS.has("SIGNATURES_FOR_ADDRESS")).toBe(false);
  });
});

describe("2/4/11. a later component consumes what the job already observed", () => {
  it("ACCOUNT_INFO and TOKEN_ACCOUNTS_BY_OWNER are reused, at zero cost", async () => {
    const f = await makeFixture();
    const first = countingRetriever(f);
    const a = await run(f, EXECUTION, first, [locator(f.wallet)]);
    const firstKinds = first.asked.map((i) => i.kind);
    expect(firstKinds).toContain("ACCOUNT_INFO");
    expect(firstKinds).toContain("TOKEN_ACCOUNTS_BY_OWNER");
    const spentFirst = a.outcome.sourceOpensSpent;
    expect(spentFirst).toBeGreaterThan(0);

    // A later component asking the same questions of the same subject.
    const second = countingRetriever(f);
    const b = await run(f, DESTINATION, second, [locator(f.wallet)]);

    // 2/4. No provider call, and no reservation, for either kind.
    expect(second.asked.filter((i) => i.kind === "ACCOUNT_INFO")).toHaveLength(0);
    expect(second.asked.filter((i) => i.kind === "TOKEN_ACCOUNTS_BY_OWNER")).toHaveLength(0);
    expect(b.outcome.sourceOpensSpent).toBe(0);
    expect(b.reserved).toHaveLength(0);
    // ...and it still produced this component's evidence.
    expect(b.outcome.evidenceIds.length).toBeGreaterThan(0);
  }, 120_000);

  it("11. no second observation is persisted — the original artifact is the provenance", async () => {
    const f = await makeFixture();
    await run(f, EXECUTION, countingRetriever(f), [locator(f.wallet)]);
    const before = await artifactsFor(f.jobId, "ACCOUNT_INFO");
    expect(before).toHaveLength(1);
    const original = before[0]!;

    await run(f, DESTINATION, countingRetriever(f), [locator(f.wallet)]);
    const after = await artifactsFor(f.jobId, "ACCOUNT_INFO");
    // Still exactly one row, and it is the SAME row: same id, same slot,
    // same provider, same content hash. Nothing was rewritten to look fresh.
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(original.id);
    expect(after[0]!.slot).toBe(original.slot);
    expect(after[0]!.providerId).toBe(original.providerId);
    expect(after[0]!.artifactHash).toBe(original.artifactHash);
    expect(after[0]!.retrievedAt.getTime()).toBe(original.retrievedAt.getTime());
  }, 120_000);

  it("1. TRANSACTION_DETAIL is never read twice in one job", async () => {
    const f = await makeFixture();
    const first = countingRetriever(f);
    await run(f, EXECUTION, first, [locator(f.wallet)]);
    const tx = first.asked.find((i) => i.kind === "TRANSACTION_DETAIL");
    expect(tx).toBeDefined();
    const rows = await artifactsFor(f.jobId, "TRANSACTION_DETAIL");
    expect(rows).toHaveLength(1);

    // The reuse lookup answers the identical transaction question directly,
    // at the original slot, with no provider in sight.
    const reused = await findReusableSameJobArtifact(ctx.db, f.jobId, tx!);
    expect(reused).not.toBeNull();
    expect(reused!.provenance.slot).toBe(rows[0]!.slot);
    expect(reused!.provenance.providerId).toBe("fixture-provider");
    expect(reused!.provenance.artifactHash).toBe(rows[0]!.artifactHash);
  }, 120_000);
});

describe("3/5/6/7. what may NOT be reused", () => {
  it("6. SIGNATURES_FOR_ADDRESS is refused by the lookup — a later window is a fresh read", async () => {
    const f = await makeFixture();
    const first = countingRetriever(f);
    await run(f, EXECUTION, first, [locator(f.wallet)]);
    const window = first.asked.find((i) => i.kind === "SIGNATURES_FOR_ADDRESS");
    expect(window).toBeDefined();
    // The observation exists in this job...
    expect(await artifactsFor(f.jobId, "SIGNATURES_FOR_ADDRESS")).not.toHaveLength(0);
    // ...and is still not reusable, because the window is time-varying.
    expect(await findReusableSameJobArtifact(ctx.db, f.jobId, window!)).toBeNull();
  }, 120_000);

  it("7. TOKEN_SUPPLY is refused, so a fresh post-event t1 stays reachable", async () => {
    const f = await makeFixture();
    // A supply reading this job already made — the exact shape that would
    // suppress a later t1 if it were reusable.
    const supply = countingRetriever(f);
    await run(f, CURRENT_STATE, supply, []);
    const rows = await artifactsFor(f.jobId, "TOKEN_SUPPLY");
    expect(rows).toHaveLength(1);

    const intent: OnchainIntent = {
      kind: "TOKEN_SUPPLY",
      chain: "solana",
      network: "mainnet",
      projectAnchor: f.mint,
      subjectKind: "token",
      subject: f.mint,
    };
    // THE CRITICAL ASSERTION OF THIS SUITE. If this ever returns an
    // artifact, t0 -> event -> t1 can collapse into one observation and the
    // supply interval becomes unobtainable exactly when a burn is found late.
    expect(await findReusableSameJobArtifact(ctx.db, f.jobId, intent)).toBeNull();
  }, 120_000);

  it("3/5. the fresh-observation path does not route through reuse at all", async () => {
    // The one place in the architecture that genuinely requires a NEWER
    // observation is post-event supply completion, and it calls the
    // retriever directly rather than through the acquisition loop — so no
    // reuse rule, present or future, can intercept it.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-post-event-supply.ts", "utf-8");
    expect(src).toContain("retriever.retrieve(intent)");
    expect(src).not.toContain("findReusableSameJobArtifact");
    expect(src).not.toContain("runStructuredOnchainAcquisition");
  });
});

describe("8. cross-job refusal", () => {
  it("an artifact from job A never satisfies job B", async () => {
    const a = await makeFixture();
    const first = countingRetriever(a);
    await run(a, EXECUTION, first, [locator(a.wallet)]);
    const asked = first.asked.find((i) => i.kind === "ACCOUNT_INFO");
    expect(asked).toBeDefined();
    expect(await findReusableSameJobArtifact(ctx.db, a.jobId, asked!)).not.toBeNull();

    // A different job, asking the identical question of the identical
    // subject under the identical anchor.
    const b = await makeFixture();
    expect(await findReusableSameJobArtifact(ctx.db, b.jobId, asked!)).toBeNull();
  }, 120_000);
});

describe("9/10. trace and budget", () => {
  it("9. reuse says exactly what happened, and never blames a provider", async () => {
    const f = await makeFixture();
    await run(f, EXECUTION, countingRetriever(f), [locator(f.wallet)]);
    const { traced } = await run(f, DESTINATION, countingRetriever(f), [locator(f.wallet)]);

    const reuse = traced.filter((t) => t.reasonCode === "ARTIFACT_ALREADY_OBSERVED_IN_JOB");
    expect(reuse.length).toBeGreaterThan(0);
    expect(reuse.every((t) => t.operationType === "CANDIDATE_DEDUPED")).toBe(true);
    expect(traced.some((t) => t.reasonCode === "PROVIDER_ERROR")).toBe(false);
    expect(traced.some((t) => t.reasonCode === "DUPLICATE_URL")).toBe(false);
    // Nothing was fetched, so no attempt row claims otherwise.
    expect(traced.some((t) => t.operationType === "FETCH_ATTEMPTED")).toBe(false);
  }, 120_000);

  it("10. the reuse path reserves nothing and spends nothing", async () => {
    const f = await makeFixture();
    await run(f, EXECUTION, countingRetriever(f), [locator(f.wallet)]);
    const second = countingRetriever(f);
    const b = await run(f, DESTINATION, second, [locator(f.wallet)]);
    expect(b.reserved).toHaveLength(0);
    expect(b.outcome.sourceOpensSpent).toBe(0);
    expect(second.asked).toHaveLength(0);
  }, 120_000);
});

// ---------------------------------------------------------------------
describe("the live duplication shape, as a fixture", () => {
  it("the repeated cross-component reads become zero reads", async () => {
    const f = await makeFixture();
    const two = [locator(f.wallet), locator(f.walletB)];

    // The live order: the chain component first, then the anchor read, then
    // the two components that repeated its questions.
    const chain = countingRetriever(f);
    await run(f, EXECUTION, chain, two);
    const supply = countingRetriever(f);
    await run(f, CURRENT_STATE, supply, two);

    const dest = countingRetriever(f);
    await run(f, DESTINATION, dest, two);
    const flow = countingRetriever(f);
    await run(f, FLOW_PATH, flow, two);

    // THE INVARIANT, stated exactly: across the whole job, no REUSABLE
    // canonical question is ever asked of a provider twice. A read that
    // remains is either a kind reuse excludes, or a question this job had
    // genuinely never asked — the second pass legitimately promotes to a
    // token-account listing the first pass never reached, because the
    // promotion cap stopped it there.
    const everyAsked = [...chain.asked, ...supply.asked, ...dest.asked, ...flow.asked];
    const seenReusable = new Map<string, number>();
    for (const intent of everyAsked) {
      if (!REUSABLE_INTENT_KINDS.has(intent.kind)) continue;
      const uri = buildCanonicalOnchainUri(intent);
      seenReusable.set(uri, (seenReusable.get(uri) ?? 0) + 1);
    }
    for (const [uri, times] of seenReusable) {
      expect(times, `${uri} was read ${times} times`).toBe(1);
    }

    // And the two repeating components did far less work than the chain that
    // established the observations they consume.
    const repeated = dest.asked.length + flow.asked.length;
    expect(chain.asked.length).toBeGreaterThan(0);
    expect(repeated).toBeLessThan(chain.asked.length);
    // Everything they DID read is a question the chain never asked.
    const chainUris = new Set(chain.asked.map((i) => buildCanonicalOnchainUri(i)));
    for (const intent of [...dest.asked, ...flow.asked]) {
      if (!REUSABLE_INTENT_KINDS.has(intent.kind)) continue;
      expect(chainUris.has(buildCanonicalOnchainUri(intent))).toBe(false);
    }
  }, 180_000);
});
