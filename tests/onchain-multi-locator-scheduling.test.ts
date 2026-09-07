import { describe, expect, it } from "vitest";

import {
  MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  accountBaseReadDemand,
  anchorBaseReadDemand,
  componentStartsAccountChain,
  selectOnchainIntents,
  takeNextScheduledStep,
  type ScheduledStep,
} from "../src/server/engine/onchain-acquisition";
import {
  ONCHAIN_RESERVED_SOURCE_OPENS,
  computeOnchainSourceOpenReserve,
  deterministicCeilingForComponent,
  planDeterministicDemand,
} from "../src/server/engine/onchain-source-open-reserve";
import {
  MAX_PROMOTED_INTENTS_PER_ATTEMPT,
  MAX_PROMOTION_DEPTH,
  intentForPromotedSubject,
  promoteFromObservation,
  promotedReadsForComponent,
} from "../src/server/engine/onchain-subject-promotion";
import { brandOnchainArtifact } from "../src/server/engine/providers/onchain-types";
import type {
  OnchainArtifact,
  OnchainIntent,
  OnchainResult,
} from "../src/server/engine/providers/onchain-types";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";

// MULTI-LOCATOR CHAIN REACHABILITY — the scheduling half, with no database.
//
// THE DEFECT. A project that documents TWO addresses admits two locators, so
// EXECUTION_EVIDENCE starts its attempt with two base intents. The work list
// was strict FIFO, and `MAX_PROMOTED_INTENTS_PER_ATTEMPT` bounds promotions
// across the WHOLE attempt — so the three permitted promotions were spent
// starting both chains rather than finishing either, and TRANSACTION_DETAIL
// became unreachable however much budget remained. An execution that did not
// happen and an execution nothing was allowed to look at are different
// findings, and the schedule was silently turning the second into the first.
//
// WHAT IS PROVED HERE, AND WHAT IS NOT. These tests drive the REAL scheduling
// rule and the REAL promotion rules — `takeNextScheduledStep` and
// `promoteFromObservation`, both pure — through a small driver that mirrors
// the executor's loop. That makes the ORDER and the BOUNDS provable with no
// database at all. It is deliberately a model of the loop, not the loop, so
// the end-to-end proof that a real attempt issues TRANSACTION_DETAIL lives
// beside the other orchestration tests, against the real executor and the
// real ledger. A source-level check below pins the two together.
//
// NOTHING HERE NAMES A PROJECT. Every address is a fixture literal, and the
// component names come from the Pattern's own vocabulary.

const ANCHOR = "Mint1111111111111111111111111111111111111111";
const LOCATOR_A = "LocatorAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LOCATOR_B = "LocatorBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_ACCOUNT_A = "TokenAcctAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_ACCOUNT_B = "TokenAcctBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SIGNATURE_A = "SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIGNATURE_B = "SigBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const IDENTITY: ConfirmedProjectIdentity = {
  chain: "solana",
  tokenAddress: ANCHOR,
  ticker: "TST",
};
const ONCHAIN_CLASSES = ["ONCHAIN_VERIFIABLE"] as const;
const CHAIN_COMPONENT = "EXECUTION_EVIDENCE";

const TOKEN_ACCOUNT_BY_OWNER: Record<string, string> = {
  [LOCATOR_A]: TOKEN_ACCOUNT_A,
  [LOCATOR_B]: TOKEN_ACCOUNT_B,
};
const SIGNATURE_BY_TOKEN_ACCOUNT: Record<string, string> = {
  [TOKEN_ACCOUNT_A]: SIGNATURE_A,
  [TOKEN_ACCOUNT_B]: SIGNATURE_B,
};

function artifactFor(intent: OnchainIntent, result: OnchainResult): OnchainArtifact {
  return brandOnchainArtifact({
    intent,
    canonicalUri: `atlas-onchain://fixture/${intent.kind}/${intent.subject}`,
    result,
    normalizedText: JSON.stringify(result),
    provenance: {
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: intent.subjectKind,
      subject: intent.subject,
      slot: 500,
      blockTime: null,
      blockHash: null,
      finality: "finalized",
      retrievalMethod: "RPC",
      providerId: "fixture",
      providerMethod: "fixture",
      requestParams: {},
      retrievedAt: new Date(0),
      rawResponseHash: "sha256:raw",
      artifactHash: `sha256:${intent.kind}:${intent.subject}`,
      transactionSignature: intent.subjectKind === "tx" ? intent.subject : null,
    },
  });
}

// Answers by intent KIND and SUBJECT only. It has no idea which subject
// "should" come next, so a chain that reaches a transaction reached it by
// promotion rather than by fixture design. Each locator owns its OWN token
// account, which is what makes two chains genuinely distinct.
function observationFor(intent: OnchainIntent): OnchainArtifact {
  switch (intent.kind) {
    case "ACCOUNT_INFO":
      return artifactFor(intent, {
        kind: "ACCOUNT_INFO",
        address: intent.subject,
        exists: true,
        ownerProgram: "SysProg11111111111111111111111111111111111",
        executable: false,
        lamports: "1",
        tokenAccountRelation: "NOT_TOKEN_PROGRAM_OWNED",
        tokenAccount: null,
      });
    case "TOKEN_ACCOUNTS_BY_OWNER":
      return artifactFor(intent, {
        kind: "TOKEN_ACCOUNTS_BY_OWNER",
        owner: intent.subject,
        mint: ANCHOR,
        rejectedCount: 0,
        accounts: [
          {
            account: TOKEN_ACCOUNT_BY_OWNER[intent.subject] ?? TOKEN_ACCOUNT_A,
            owner: intent.subject,
            mint: ANCHOR,
            amountRaw: "0",
            decimals: 6,
          },
        ],
      });
    case "SIGNATURES_FOR_ADDRESS":
      return artifactFor(intent, {
        kind: "SIGNATURES_FOR_ADDRESS",
        address: intent.subject,
        signatures: [
          {
            signature: SIGNATURE_BY_TOKEN_ACCOUNT[intent.subject] ?? SIGNATURE_A,
            slot: 20,
            err: false,
            blockTime: null,
            memo: null,
          },
        ],
      });
    default:
      return artifactFor(intent, {
        kind: "TRANSACTION_DETAIL",
        signature: intent.subject,
        slot: 500,
        blockTime: null,
        succeeded: true,
        burns: [],
        programs: [],
        accountKeys: [],
        tokenInstructions: [],
        lifecycleInstructions: [],
        preTokenBalances: [],
        postTokenBalances: [],
      });
  }
}

interface DriveResult {
  asked: OnchainIntent[];
  promotedIssued: number;
  capRefusals: string[];
  maxQueueLength: number;
}

// The executor's loop, reduced to the parts under test: the same scheduling
// rule, the same promotion rules, the same two counters, the same visited
// set. `take` is a parameter for exactly one reason — so the FIFO order this
// change replaced can be run against the same fixture and shown to fail.
function drive(
  component: string,
  baseIntents: readonly OnchainIntent[],
  take: (queue: ScheduledStep[]) => ScheduledStep = takeNextScheduledStep,
): DriveResult {
  const queue: ScheduledStep[] = baseIntents.map((intent, seq) => ({
    intent,
    depth: 0,
    parent: null,
    seq,
  }));
  let nextSeq = queue.length;
  const visited = new Set<string>();
  const asked: OnchainIntent[] = [];
  const capRefusals: string[] = [];
  let promotedIssued = 0;
  let maxQueueLength = queue.length;

  while (queue.length > 0) {
    maxQueueLength = Math.max(maxQueueLength, queue.length);
    const step = take(queue);
    const visitKey = `${step.intent.kind}::${step.intent.subject}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    asked.push(step.intent);

    const outcome = promoteFromObservation({
      artifact: observationFor(step.intent),
      bindingConfirmed: true,
      depth: step.depth,
      component,
      visited,
    });
    for (const promoted of outcome.promoted) {
      if (promotedIssued >= MAX_PROMOTED_INTENTS_PER_ATTEMPT) {
        capRefusals.push(`${step.intent.kind}::${step.intent.subject}`);
        break;
      }
      promotedIssued += 1;
      queue.push({
        intent: intentForPromotedSubject(promoted),
        depth: promoted.depth,
        parent: promoted.parentSubject,
        seq: nextSeq,
      });
      nextSeq += 1;
    }
  }
  return { asked, promotedIssued, capRefusals, maxQueueLength };
}

const fifo = (queue: ScheduledStep[]): ScheduledStep => queue.shift()!;

function baseIntentsFor(component: string, locators: readonly string[]): OnchainIntent[] {
  return selectOnchainIntents({
    component,
    establishingClasses: ONCHAIN_CLASSES,
    identity: IDENTITY,
    locators: locators.map((address) => ({
      address,
      origin: "ADMITTED_EVIDENCE_SOURCE" as const,
    })),
    maxIntents: MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  });
}

// ---------------------------------------------------------------------
// The scheduling rule itself.
// ---------------------------------------------------------------------

describe("chain-first scheduling is a total order", () => {
  const step = (depth: number, seq: number): ScheduledStep => ({
    intent: {
      kind: "ACCOUNT_INFO",
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "account",
      subject: `${depth}-${seq}`,
    },
    depth,
    parent: null,
    seq,
  });

  it("serves the DEEPEST waiting step first", () => {
    const queue = [step(0, 0), step(2, 5), step(1, 3)];
    expect(takeNextScheduledStep(queue).depth).toBe(2);
    expect(takeNextScheduledStep(queue).depth).toBe(1);
    expect(takeNextScheduledStep(queue).depth).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it("breaks ties on insertion order, never on array position", () => {
    const queue = [step(1, 9), step(1, 2), step(1, 4)];
    expect(takeNextScheduledStep(queue).seq).toBe(2);
    expect(takeNextScheduledStep(queue).seq).toBe(4);
    expect(takeNextScheduledStep(queue).seq).toBe(9);
  });

  it("removes exactly the step it returns, and nothing else", () => {
    const queue = [step(0, 0), step(3, 1), step(0, 2)];
    const taken = takeNextScheduledStep(queue);
    expect(taken.seq).toBe(1);
    expect(queue.map((q) => q.seq)).toEqual([0, 2]);
  });
});

// ---------------------------------------------------------------------
// The invariant this task exists for.
// ---------------------------------------------------------------------

describe("two admitted locators no longer make TRANSACTION_DETAIL unreachable", () => {
  it("the contract really does start with two base intents", () => {
    const base = baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B]);
    expect(base.map((i) => i.subject)).toEqual([LOCATOR_A, LOCATOR_B]);
    expect(base.every((i) => i.kind === "ACCOUNT_INFO")).toBe(true);
  });

  it("one chain runs end to end: ACCOUNT_INFO -> TOKEN_ACCOUNTS -> SIGNATURES -> TRANSACTION", () => {
    const run = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B]));
    expect(run.asked.map((i) => i.kind)).toEqual([
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
      "ACCOUNT_INFO",
    ]);
    // The chain that completed is ONE locator's, followed all the way down.
    expect(run.asked.slice(0, 4).map((i) => i.subject)).toEqual([
      LOCATOR_A,
      LOCATOR_A,
      TOKEN_ACCOUNT_A,
      SIGNATURE_A,
    ]);
    // The second locator is still CHARACTERIZED — its base read is not a
    // promotion and was never at risk. Only its chain is refused, which is
    // the honest outcome of a bound that protects one chain.
    expect(run.asked[4]!.subject).toBe(LOCATOR_B);
  });

  it("the FIFO order this replaced could not reach a transaction at all", () => {
    // The defect, pinned. Same fixture, same rules, same bounds — only the
    // order differs, and the order alone decided whether the question could
    // be asked.
    const before = drive(
      CHAIN_COMPONENT,
      baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B]),
      fifo,
    );
    expect(before.asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
    expect(before.capRefusals.length).toBeGreaterThan(0);

    const after = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B]));
    expect(after.asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(true);
  });

  it("the signature window that continues to a transaction is never cap-refused", () => {
    const run = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B]));
    // Whatever else the cap refuses, it is never the step that would have
    // produced the transaction read.
    expect(run.capRefusals).not.toContain(`SIGNATURES_FOR_ADDRESS::${TOKEN_ACCOUNT_A}`);
    expect(run.capRefusals).not.toContain(`SIGNATURES_FOR_ADDRESS::${TOKEN_ACCOUNT_B}`);
  });

  it("is stable across repeated runs — same order, every time", () => {
    const runs = Array.from({ length: 8 }, () =>
      drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B])).asked.map(
        (i) => `${i.kind}::${i.subject}`,
      ),
    );
    for (const run of runs) expect(run).toEqual(runs[0]);
  });

  it("locator ORDER decides which chain completes, and nothing else does", () => {
    // Determinism, stated the other way round: swapping the admitted
    // locators swaps which chain is followed, and no property of the
    // observations — a balance, a burn, a memo — can influence it.
    const swapped = drive(
      CHAIN_COMPONENT,
      baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_B, LOCATOR_A]),
    );
    expect(swapped.asked.slice(0, 4).map((i) => i.subject)).toEqual([
      LOCATOR_B,
      LOCATOR_B,
      TOKEN_ACCOUNT_B,
      SIGNATURE_B,
    ]);
  });
});

describe("the existing hard bounds are untouched", () => {
  it("never issues more promotions than the per-attempt cap", () => {
    for (const locators of [[LOCATOR_A], [LOCATOR_A, LOCATOR_B]]) {
      const run = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, locators));
      expect(run.promotedIssued).toBeLessThanOrEqual(MAX_PROMOTED_INTENTS_PER_ATTEMPT);
    }
  });

  it("the work list stays bounded by the two counters that own it", () => {
    const run = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B]));
    // Base intents plus promotions is the only way a step enters the list.
    expect(run.maxQueueLength).toBeLessThanOrEqual(
      MAX_ONCHAIN_INTENTS_PER_ATTEMPT + MAX_PROMOTED_INTENTS_PER_ATTEMPT,
    );
    expect(run.asked.length).toBeLessThanOrEqual(
      MAX_ONCHAIN_INTENTS_PER_ATTEMPT + MAX_PROMOTED_INTENTS_PER_ATTEMPT,
    );
  });

  it("a transaction is still terminal — no chain runs deeper than the ceiling", () => {
    const run = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B]));
    expect(run.asked.filter((i) => i.kind === "TRANSACTION_DETAIL")).toHaveLength(1);
    expect(MAX_PROMOTION_DEPTH).toBe(3);
  });

  it("a component the rules stop early is still stopped early", () => {
    // DESTINATION may discover token accounts and nothing further. Reaching
    // a signature window or a transaction is EXECUTION_EVIDENCE's licence,
    // and scheduling does not hand it out.
    const run = drive("DESTINATION", baseIntentsFor("DESTINATION", [LOCATOR_A, LOCATOR_B]));
    expect(run.asked.map((i) => i.kind)).toEqual([
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNTS_BY_OWNER",
    ]);
    expect(run.asked.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
  });

  it("single-locator behaviour is exactly what it was", () => {
    const chainFirst = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A]));
    const asFifo = drive(CHAIN_COMPONENT, baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A]), fifo);
    expect(chainFirst.asked.map((i) => `${i.kind}::${i.subject}`)).toEqual(
      asFifo.asked.map((i) => `${i.kind}::${i.subject}`),
    );
    expect(chainFirst.asked.map((i) => i.kind)).toEqual([
      "ACCOUNT_INFO",
      "TOKEN_ACCOUNTS_BY_OWNER",
      "SIGNATURES_FOR_ADDRESS",
      "TRANSACTION_DETAIL",
    ]);
  });
});

// ---------------------------------------------------------------------
// The reservation half: what a chain that may START twice actually costs.
// ---------------------------------------------------------------------

describe("deterministic demand counts the base reads a chain may actually start with", () => {
  const query = (component: string) => ({
    component,
    establishingClasses: ONCHAIN_CLASSES,
    identity: IDENTITY,
  });

  it("an account-kind component demands the bound the executor enforces", () => {
    expect(accountBaseReadDemand(query(CHAIN_COMPONENT))).toBe(MAX_ONCHAIN_INTENTS_PER_ATTEMPT);
    expect(accountBaseReadDemand(query("DESTINATION"))).toBe(MAX_ONCHAIN_INTENTS_PER_ATTEMPT);
    // And it is exactly the number of base intents two locators produce.
    expect(baseIntentsFor(CHAIN_COMPONENT, [LOCATOR_A, LOCATOR_B])).toHaveLength(
      accountBaseReadDemand(query(CHAIN_COMPONENT)),
    );
  });

  it("an anchor-only component demands none, and neither does a documentary one", () => {
    expect(componentStartsAccountChain(query("NET_EFFECT"))).toBe(false);
    expect(accountBaseReadDemand(query("NET_EFFECT"))).toBe(0);
    expect(anchorBaseReadDemand(query("NET_EFFECT"))).toBe(1);
    expect(
      accountBaseReadDemand({
        component: "MECHANISM_SPEC",
        establishingClasses: ["OFFICIAL_DOCS", "GOVERNANCE"],
        identity: IDENTITY,
      }),
    ).toBe(0);
  });

  it("a chain costs its base reads plus its own authorised hops, never a constant", () => {
    const demands = planDeterministicDemand({
      identity: IDENTITY,
      components: [
        { component: CHAIN_COMPONENT, establishingClasses: ONCHAIN_CLASSES },
        { component: "DESTINATION", establishingClasses: ONCHAIN_CLASSES },
      ],
    });
    const byComponent = Object.fromEntries(demands.map((d) => [d.component, d]));
    expect(byComponent[CHAIN_COMPONENT]!.chain).toBe(
      MAX_ONCHAIN_INTENTS_PER_ATTEMPT + promotedReadsForComponent(CHAIN_COMPONENT),
    );
    // The shallower component stays shallower — this is not a flat raise.
    expect(byComponent.DESTINATION!.chain).toBeLessThan(byComponent[CHAIN_COMPONENT]!.chain);
  });

  it("the ceiling is derived from both bounds, and is 5 on the current rules", () => {
    expect(ONCHAIN_RESERVED_SOURCE_OPENS).toBe(
      MAX_ONCHAIN_INTENTS_PER_ATTEMPT + MAX_PROMOTION_DEPTH,
    );
    expect(ONCHAIN_RESERVED_SOURCE_OPENS).toBe(5);
  });

  it("the canonical contract shape reserves seven, and the total never grows", () => {
    const reserve = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: planDeterministicDemand({
        identity: IDENTITY,
        components: [
          { component: "CURRENT_STATE", establishingClasses: ONCHAIN_CLASSES },
          { component: "NET_EFFECT", establishingClasses: ONCHAIN_CLASSES },
          { component: CHAIN_COMPONENT, establishingClasses: ONCHAIN_CLASSES },
        ],
      }),
    });
    expect(reserve.baseReserved).toBe(2);
    expect(reserve.promotionReserved).toBe(5);
    expect(reserve.reserved).toBe(7);
    // The invariant that makes this protection rather than an allowance.
    expect(reserve.reserved + reserve.documentaryCeiling).toBe(24);
    expect(reserve.maxSourceOpens).toBe(24);
    // And the chain component may afford every read it may issue.
    expect(deterministicCeilingForComponent(reserve, CHAIN_COMPONENT)).toBeGreaterThanOrEqual(
      MAX_ONCHAIN_INTENTS_PER_ATTEMPT + MAX_PROMOTED_INTENTS_PER_ATTEMPT,
    );
  });
});

// ---------------------------------------------------------------------
// The model above must stay tied to the loop it models.
// ---------------------------------------------------------------------

describe("boundaries", () => {
  it("the executor schedules through the rule these tests drive", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-acquisition.ts", "utf-8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).toContain("takeNextScheduledStep(queue)");
    // The FIFO the defect lived in is gone, not merely bypassed.
    expect(code).not.toContain("queue.shift()");
    // Still one bounded pass: no recursion, no second work list, no retry.
    expect((code.match(/while \(queue\.length > 0\)/g) ?? []).length).toBe(1);
  });

  it("scheduling reads position only — never a result, a memo or an amount", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/server/engine/onchain-acquisition.ts", "utf-8");
    const rule = src.slice(
      src.indexOf("export function takeNextScheduledStep"),
      src.indexOf("export interface StructuredOnchainOutcome"),
    );
    expect(rule.length).toBeGreaterThan(0);
    for (const banned of ["memo", "burn", "amount", "result", "before", "until", "cursor"]) {
      expect(rule.toLowerCase(), `scheduling references "${banned}"`).not.toContain(banned);
    }
  });

  it("names no project, asset or mechanism in CODE", async () => {
    // Scanned over code only. A comment may legitimately recount which live
    // run exposed a defect — that is history, and the repository keeps it
    // deliberately. What must never exist is a project reaching a decision:
    // `if (project === X)` is always the wrong answer here.
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "src/server/engine/onchain-acquisition.ts",
      "src/server/engine/onchain-source-open-reserve.ts",
    ]) {
      const code = (await readFile(file, "utf-8"))
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n")
        .toLowerCase();
      for (const banned of ["pump", "raydium", "bonk", "jupiter", "solscan", "buyback"]) {
        expect(code, `${file} references "${banned}"`).not.toContain(banned);
      }
    }
  });
});
