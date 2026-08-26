import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  evidence,
  onchainArtifacts,
  onchainDerivedSubjects,
  onchainObservedSignatures,
  projects,
  researchTraceEvents,
  sources,
  topics,
  users,
} from "../src/server/db/schema";
import { admittedLocatorsForJob, persistFactLocators } from "../src/server/engine/documentary-locator-store";
import { runStructuredOnchainAcquisition } from "../src/server/engine/onchain-acquisition";
import { buildCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import { MAX_PROMOTED_INTENTS_PER_ATTEMPT } from "../src/server/engine/onchain-subject-promotion";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";
import { createResearchJob } from "../src/server/jobs/research-jobs";
import { coreEntitlement, setupTestDatabase, uniq, type TestContext } from "./phase1-setup";

// BOUNDED ON-CHAIN ORCHESTRATION V1 — the chain, driven from normal S4.
//
// Every earlier proof of this research path was a human typing the next
// subject into an owner script. These tests start where a real research
// attempt starts — an admitted documentary locator in the database — and
// assert that acquisition walks
//
//   documented account → token accounts it owns → one signature window
//                      → one transaction → deterministic burn fact
//
// with NO subject supplied by the test between stages, and that every way
// of running away from that path is closed.
//
// ZERO network: the retriever is a fixture that answers by intent kind and
// records exactly what it was asked for.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestDatabase();
});
afterAll(async () => {
  await ctx.close();
});

const MINT = "Mint1111111111111111111111111111111111111111";
const WALLET = "Wa11et11111111111111111111111111111111111111";
const TOKEN_ACCOUNT = "TokenAcct11111111111111111111111111111111111";
const SIG_NEW = "Sig1111111111111111111111111111111111111111111111111111111111111111";
const SIG_OLD = "Sig2222222222222222222222222222222222222222222222222222222222222222";
const identity: ConfirmedProjectIdentity = { chain: "solana", tokenAddress: MINT, ticker: "TST" };

async function makeJob(): Promise<string> {
  const [topic] = await ctx.db.select().from(topics).where(eq(topics.isActive, true));
  const [project] = await ctx.db
    .insert(projects)
    .values({ slug: uniq("orch"), name: "Orchestration Test Project", status: "ACTIVE_CORE" })
    .returning();
  const [user] = await ctx.db.insert(users).values({}).returning();
  const { job } = await createResearchJob(ctx.db, ctx.boss, {
    userId: user.id,
    topicId: topic.id,
    projectId: project.id,
    originalQuestion: "is the mechanism actually happening on-chain?",
    normalizedTask: { project_slug: project.slug, project_slugs: [project.slug], task: "t" },
    normalizedTaskHash: uniq("hash"),
    idempotencyKey: uniq("idem"),
    entitlement: coreEntitlement(),
    demoLifetimeProofLimit: 1000,
  });
  return job.id;
}

// An admitted documentary fact naming an account — the ONLY thing the test
// puts in front of acquisition. Everything after this must be discovered.
async function admitLocator(jobId: string, address: string): Promise<string> {
  const [source] = await ctx.db
    .insert(sources)
    .values({
      url: `https://docs.example.test/${uniq("p")}`,
      urlHash: uniq("uh"),
      sourceType: "OFFICIAL_DOCS",
      health: "OK",
    })
    .returning();
  const [row] = await ctx.db
    .insert(evidence)
    .values({
      sourceId: source.id,
      researchJobId: jobId,
      relationship: "SUPPORTS",
      fragment: `the mechanism sends tokens to ${address}`,
      summary: "documented account",
      retrievedUrl: source.url,
      contentHash: uniq("ch"),
      fetchedAt: new Date(),
      evidenceContractVersion: 2,
      // The v2 contract requires these; an admitted documentary fact in
      // production always has them.
      patternStep: 3,
      component: "MECHANISM_SPEC",
      directness: "DIRECT",
      sourceClass: "OFFICIAL_DOCS",
      officiality: "CONFIRMED",
    })
    .returning();
  await persistFactLocators(ctx.db, row.id, [{ value: address, shape: "ADDRESS_LIKE" }]);
  return row.id;
}

function artifactFor(intent: OnchainIntent, result: OnchainResult): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: MINT,
      subjectKind: intent.subjectKind,
      subject: intent.subject,
      slot: 500,
      blockTime: 1_700_000_000,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "fixture",
      requestParams: { subject: intent.subject },
      retrievedAt: new Date(),
      rawResponseHash: `sha256:${result.kind}:${intent.subject}`,
      artifactHash: `sha256:art:${result.kind}:${intent.subject}`,
      transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
    },
  });
}

const BURN = {
  programId: "TokenProg1111111111111111111111111111111111",
  instructionType: "BurnChecked" as const,
  mint: MINT,
  sourceAccount: TOKEN_ACCOUNT,
  authority: WALLET,
  amountRaw: "7723746661",
  decimals: 6,
};

interface FixtureOptions {
  tokenAccounts?: { account: string; owner: string; mint: string }[];
  signatures?: { signature: string; slot: number; err: boolean }[];
  burns?: (typeof BURN)[];
  accountExists?: boolean;
  failOn?: string;
}

// Answers by intent KIND only. It has no idea which subject "should" come
// next, so a chain that reaches a transaction reached it by promotion.
function fixtureRetriever(opts: FixtureOptions = {}) {
  const asked: OnchainIntent[] = [];
  return {
    asked,
    retriever: {
      name: "fixture",
      supports: () => true,
      retrieve: async (intent: OnchainIntent): Promise<OnchainArtifact> => {
        asked.push(intent);
        if (opts.failOn === intent.kind) throw new Error("provider exploded");
        switch (intent.kind) {
          case "ACCOUNT_INFO":
            return artifactFor(intent, {
              kind: "ACCOUNT_INFO",
              address: intent.subject,
              exists: opts.accountExists ?? true,
              ownerProgram: "SysProg11111111111111111111111111111111111",
              executable: false,
              lamports: "64850000000",
            });
          case "TOKEN_ACCOUNTS_BY_OWNER":
            return artifactFor(intent, {
              kind: "TOKEN_ACCOUNTS_BY_OWNER",
              owner: intent.subject,
              mint: MINT,
              rejectedCount: 0,
              accounts: (opts.tokenAccounts ?? [
                { account: TOKEN_ACCOUNT, owner: intent.subject, mint: MINT },
              ]).map((a) => ({ ...a, amountRaw: "0", decimals: 6 })),
            });
          case "SIGNATURES_FOR_ADDRESS":
            return artifactFor(intent, {
              kind: "SIGNATURES_FOR_ADDRESS",
              address: intent.subject,
              signatures: (opts.signatures ?? [
                { signature: SIG_OLD, slot: 10, err: false },
                { signature: SIG_NEW, slot: 20, err: false },
              ]).map((s) => ({ ...s, blockTime: 1_700_000_000, memo: null })),
            });
          case "TRANSACTION_DETAIL":
            return artifactFor(intent, {
              kind: "TRANSACTION_DETAIL",
              signature: intent.subject,
              slot: 500,
              blockTime: 1_700_000_000,
              succeeded: true,
              burns: opts.burns ?? [BURN],
              programs: [],
              accountKeys: [WALLET, MINT, TOKEN_ACCOUNT],
              tokenInstructions: [],
              lifecycleInstructions: [],
              preTokenBalances: [],
              postTokenBalances: [],
            });
          default:
            return artifactFor(intent, {
              kind: "TOKEN_SUPPLY",
              mint: MINT,
              amountRaw: "1000",
              decimals: 6,
            });
        }
      },
    },
  };
}

async function runExecution(
  jobId: string,
  opts: FixtureOptions = {},
  overrides: { maxSourceOpens?: number; component?: string } = {},
) {
  const locators = await admittedLocatorsForJob(ctx.db, jobId);
  const fixture = fixtureRetriever(opts);
  const traced: { operationType: string; reasonCode?: string; targetRef: string }[] = [];
  const outcome = await runStructuredOnchainAcquisition({
    db: ctx.db,
    jobId,
    attemptId: null,
    item: { step: 4, component: overrides.component ?? "EXECUTION_EVIDENCE" },
    plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: identity },
    locators: locators.map((l) => ({ address: l.value, origin: "ADMITTED_EVIDENCE_SOURCE" as const })),
    maxSourceOpens: overrides.maxSourceOpens ?? 24,
    retriever: fixture.retriever,
    reserve: async () => true,
    recordTrace: async (e) => {
      traced.push({ operationType: e.operationType, reasonCode: e.reasonCode, targetRef: e.targetRef });
    },
  });
  return { outcome, asked: fixture.asked, traced };
}

describe("orchestration — locator plumbing is what unlocks everything", () => {
  it("admittedLocatorsForJob returns only this job's CONFIRMED locators", async () => {
    const mine = await makeJob();
    const theirs = await makeJob();
    await admitLocator(mine, WALLET);
    await admitLocator(theirs, "Zother2222222222222222222222222222222222222");
    const found = await admittedLocatorsForJob(ctx.db, mine);
    expect(found.map((f) => f.value)).toEqual([WALLET]);
  });

  it("WITHOUT an admitted locator the chain never starts (mutation check 1)", async () => {
    // This is the production bug the audit found, pinned: no locator means
    // no account subject, so no account-kind intent is ever issued.
    const jobId = await makeJob();
    const { asked } = await runExecution(jobId);
    expect(asked.filter((i) => i.subject === WALLET)).toHaveLength(0);
    expect(asked.every((i) => i.subject === MINT)).toBe(true);
  });

  it("an address that was never admitted cannot become a subject (mutation check 2)", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId);
    const subjects = new Set(asked.map((i) => i.subject));
    expect(subjects.has("NeverAdmitted11111111111111111111111111111")).toBe(false);
    // Only the anchor, the admitted locator, and things discovered FROM it.
    for (const s of subjects) {
      expect([MINT, WALLET, TOKEN_ACCOUNT, SIG_NEW, SIG_OLD]).toContain(s);
    }
  });
});

describe("orchestration — the full chain from one admitted locator", () => {
  it("walks account → token accounts → signatures → transaction with no manual subject", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked, outcome } = await runExecution(jobId);
    const kinds = asked.map((i) => i.kind);

    expect(kinds).toContain("TOKEN_ACCOUNTS_BY_OWNER");
    expect(kinds).toContain("SIGNATURES_FOR_ADDRESS");
    expect(kinds).toContain("TRANSACTION_DETAIL");

    // Each step addressed the subject the PREVIOUS step produced.
    const discovery = asked.find((i) => i.kind === "TOKEN_ACCOUNTS_BY_OWNER");
    const window = asked.find((i) => i.kind === "SIGNATURES_FOR_ADDRESS");
    const tx = asked.find((i) => i.kind === "TRANSACTION_DETAIL");
    expect(discovery?.subject).toBe(WALLET);
    expect(window?.subject).toBe(TOKEN_ACCOUNT);
    expect(tx?.subject).toBe(SIG_NEW);
    expect(tx?.subjectKind).toBe("tx");
    // The anchor never changes as the chain deepens.
    for (const i of asked) expect(i.projectAnchor).toBe(MINT);
    expect(outcome.evidenceIds.length).toBeGreaterThan(0);
  });

  it("the burn fact reaches Evidence from the normal path", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    await runExecution(jobId);
    const rows = await ctx.db.select().from(evidence).where(eq(evidence.researchJobId, jobId));
    const burnFact = rows.find((r) => (r.summary ?? "").toLowerCase().includes("burn"));
    expect(burnFact, "no burn evidence reached the normal pipeline").toBeTruthy();
    expect(burnFact?.component).toBe("EXECUTION_EVIDENCE");
    expect(burnFact?.sourceClass).toBe("ONCHAIN_VERIFIABLE");
    // D-134 — an on-chain row must be bound to this project to be usable
    // by S5. Untouched by orchestration.
    expect(burnFact?.entityBinding).toBe("CONFIRMED");
    expect(burnFact?.doesNotProve ?? "").not.toEqual("");
  });

  it("writes the same durable provenance the owner scripts write", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    await runExecution(jobId);

    const derived = await ctx.db
      .select()
      .from(onchainDerivedSubjects)
      .where(eq(onchainDerivedSubjects.subject, TOKEN_ACCOUNT));
    expect(derived.length).toBeGreaterThan(0);
    expect(derived[0].parentSubject).toBe(WALLET);
    expect(derived[0].derivationMethod).toBe("TOKEN_ACCOUNTS_BY_OWNER");
    expect(derived[0].bindingStatus).toBe("CONFIRMED");

    const jobArtifacts = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.researchJobId, jobId));
    const jobArtifactIds = new Set(jobArtifacts.map((a) => a.id));
    const observed = (
      await ctx.db
        .select()
        .from(onchainObservedSignatures)
        .where(eq(onchainObservedSignatures.parentSubject, TOKEN_ACCOUNT))
    ).filter((o) => jobArtifactIds.has(o.onchainArtifactId));
    expect(observed.map((o) => o.signature).sort()).toEqual([SIG_NEW, SIG_OLD].sort());

    const artifacts = await ctx.db
      .select()
      .from(onchainArtifacts)
      .where(eq(onchainArtifacts.researchJobId, jobId));
    expect(artifacts.some((a) => a.intentKind === "TRANSACTION_DETAIL")).toBe(true);
  });

  it("records why each promotion happened", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { traced } = await runExecution(jobId);
    const promoted = traced.filter((t) => t.operationType === "SUBJECT_PROMOTED");
    expect(promoted.length).toBeGreaterThanOrEqual(2);
    // Terminal is recorded too — the chain ending is a decision.
    expect(traced.some((t) => t.operationType === "SUBJECT_PROMOTION_TERMINAL")).toBe(true);
    // Only canonical URIs and public identifiers reach a trace row.
    for (const t of traced) {
      expect(t.targetRef.startsWith("atlas-onchain://")).toBe(true);
      expect(t.targetRef).not.toContain("http");
      expect(t.targetRef).not.toContain("api-key");
    }
  });
});

describe("orchestration — terminal variants", () => {
  it("B: a documented account owning NO project token account stops", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId, { tokenAccounts: [] });
    expect(asked.some((i) => i.kind === "TOKEN_ACCOUNTS_BY_OWNER")).toBe(true);
    expect(asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
  });

  it("C: a token account with NO signatures stops", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked, traced } = await runExecution(jobId, { signatures: [] });
    expect(asked.some((i) => i.kind === "SIGNATURES_FOR_ADDRESS")).toBe(true);
    expect(asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
    expect(
      traced.some((t) => t.reasonCode === "PROMOTION_NO_ELIGIBLE_SUBJECT"),
    ).toBe(true);
  });

  it("D: budget exhausted means the promoted call is never made", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const locators = await admittedLocatorsForJob(ctx.db, jobId);
    const fixture = fixtureRetriever();
    const traced: string[] = [];
    let allowed = 1;
    const outcome = await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId,
      attemptId: null,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: identity },
      locators: locators.map((l) => ({ address: l.value, origin: "ADMITTED_EVIDENCE_SOURCE" as const })),
      maxSourceOpens: 24,
      retriever: fixture.retriever,
      // One reservation, then the ceiling.
      reserve: async () => (allowed-- > 0 ? true : false),
      recordTrace: async (e) => {
        traced.push(`${e.operationType}:${e.reasonCode ?? ""}`);
      },
    });
    expect(fixture.asked).toHaveLength(1);
    expect(fixture.asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
    expect(outcome.observations).toContain("ONCHAIN_SOURCE_OPEN_BUDGET_EXHAUSTED");
    expect(traced.some((t) => t.includes("SOURCE_OPEN_BUDGET_EXHAUSTED"))).toBe(true);
  });

  it("E: a transaction with NO burn is a valid end — no second transaction (mutation check 7)", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked, traced } = await runExecution(jobId, { burns: [] });
    expect(asked.filter((i) => i.kind === "TRANSACTION_DETAIL")).toHaveLength(1);
    expect(asked.filter((i) => i.kind === "SIGNATURES_FOR_ADDRESS")).toHaveLength(1);
    expect(traced.some((t) => t.operationType === "SUBJECT_PROMOTION_TERMINAL")).toBe(true);
  });

  it("H: a DENSE signature window is still one window and one transaction", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const dense = Array.from({ length: 25 }, (_, i) => ({
      signature: `Sig${String(i).padStart(2, "0")}${"D".repeat(63)}`,
      slot: 9000 + i,
      err: false,
    }));
    const { asked } = await runExecution(jobId, { signatures: dense });
    expect(asked.filter((i) => i.kind === "SIGNATURES_FOR_ADDRESS")).toHaveLength(1);
    expect(asked.filter((i) => i.kind === "TRANSACTION_DETAIL")).toHaveLength(1);
  });

  it("I: a provider failure fails closed with zero retry", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked, outcome } = await runExecution(jobId, { failOn: "TOKEN_ACCOUNTS_BY_OWNER" });
    expect(asked.filter((i) => i.kind === "TOKEN_ACCOUNTS_BY_OWNER")).toHaveLength(1);
    expect(outcome.observations).toContain("ONCHAIN_RETRIEVAL_FAILED");
    // The failure produced no subject and therefore no deeper call.
    expect(asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
  });

  it("a non-existent documented account stops at characterization", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId, { accountExists: false }, { component: "DESTINATION" });
    expect(asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
  });
});

describe("orchestration — the bounds cannot be walked around", () => {
  it("a transaction is never requested without an observed signature (mutation check 5)", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId, { signatures: [] });
    expect(asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
  });

  it("promoted operations are capped regardless of how much the chain offers", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId);
    const promotedKinds = asked.filter((i) => i.kind !== "TOKEN_ACCOUNTS_BY_OWNER" || i.subject !== WALLET);
    expect(promotedKinds.length).toBeLessThanOrEqual(MAX_PROMOTED_INTENTS_PER_ATTEMPT + 2);
  });

  it("no subject is ever addressed twice in one attempt", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId);
    const keys = asked.map((i) => `${i.kind}::${i.subject}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("no counterparty from the transaction becomes a subject", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId);
    // The transaction names accountKeys; none of them is followed.
    const after = asked.slice(asked.findIndex((i) => i.kind === "TRANSACTION_DETAIL") + 1);
    expect(after).toHaveLength(0);
  });

  it("DESTINATION discovers token accounts but never reaches a transaction", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const { asked } = await runExecution(jobId, {}, { component: "DESTINATION" });
    expect(asked.some((i) => i.kind === "TOKEN_ACCOUNTS_BY_OWNER")).toBe(true);
    expect(asked.some((i) => i.kind === "SIGNATURES_FOR_ADDRESS")).toBe(false);
    expect(asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
  });

  it("a component with no on-chain establishing class issues nothing at all", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const locators = await admittedLocatorsForJob(ctx.db, jobId);
    const fixture = fixtureRetriever();
    await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId,
      attemptId: null,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      plan: { establishingClasses: ["OFFICIAL_DOCS"], confirmedIdentity: identity },
      locators: locators.map((l) => ({ address: l.value, origin: "ADMITTED_EVIDENCE_SOURCE" as const })),
      maxSourceOpens: 24,
      retriever: fixture.retriever,
      reserve: async () => true,
    });
    expect(fixture.asked).toHaveLength(0);
  });
});

describe("orchestration — trace rows are real and safe", () => {
  it("promotion events persist through the normal trace path", async () => {
    const jobId = await makeJob();
    await admitLocator(jobId, WALLET);
    const locators = await admittedLocatorsForJob(ctx.db, jobId);
    const fixture = fixtureRetriever();
    let traceSeq = 0;
    await runStructuredOnchainAcquisition({
      db: ctx.db,
      jobId,
      attemptId: null,
      item: { step: 4, component: "EXECUTION_EVIDENCE" },
      plan: { establishingClasses: ["ONCHAIN_VERIFIABLE"], confirmedIdentity: identity },
      locators: locators.map((l) => ({ address: l.value, origin: "ADMITTED_EVIDENCE_SOURCE" as const })),
      maxSourceOpens: 24,
      retriever: fixture.retriever,
      reserve: async () => true,
      recordTrace: async (e) => {
        traceSeq += 1;
        await ctx.db.insert(researchTraceEvents).values({
          researchJobId: jobId,
          sequence: traceSeq,
          operationType: e.operationType,
          providerKind: "FETCH",
          patternStep: 4,
          component: "EXECUTION_EVIDENCE",
          targetRef: e.targetRef,
          status: e.status,
          reasonCode: e.reasonCode ?? "NONE",
        });
      },
    });
    const rows = await ctx.db
      .select()
      .from(researchTraceEvents)
      .where(
        and(
          eq(researchTraceEvents.researchJobId, jobId),
          eq(researchTraceEvents.operationType, "SUBJECT_PROMOTED"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
  });
});
