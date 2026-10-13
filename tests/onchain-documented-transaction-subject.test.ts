import { describe, expect, it } from "vitest";

import { INTERNAL_ALPHA_V1 } from "../src/server/config/product";
import {
  MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  eligibleSubjects,
  runStructuredOnchainAcquisition,
  selectOnchainIntents,
  subjectShapeMatchesIntent,
  type MechanismLocator,
} from "../src/server/engine/onchain-acquisition";
import { completeIdentifierShape } from "../src/server/engine/documentary-locator";
import {
  ONCHAIN_RESERVED_SOURCE_OPENS,
  computeOnchainSourceOpenReserve,
  planDeterministicDemand,
} from "../src/server/engine/onchain-source-open-reserve";
import {
  DOCUMENTARY_BASE_INTENTS,
  PROMOTION_ONLY_INTENTS,
} from "../src/server/engine/onchain-subject-promotion";
import { MAX_SIGNATURES_PER_INTENT } from "../src/server/engine/providers/onchain-solana";
import type { OnchainIntent } from "../src/server/engine/providers/onchain-types";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";

// A DOCUMENTED TRANSACTION SIGNATURE IS A READABLE SUBJECT — the pure half.
//
// THE DEFECT THIS CLOSES. An admitted documentary locator may be an
// ADDRESS_LIKE or a SIGNATURE_LIKE identifier; the validator has always said
// which, and both hand-offs to the executor threw the answer away and copied
// the value into a field called `address`. A documented transaction signature
// therefore became an ACCOUNT_INFO subject, won a protected source-open
// reservation, and was refused by the Solana adapter's own pre-call
// validation — which the loop could only record as PROVIDER_ERROR, though no
// provider was reached and none had failed.
//
// The database-backed proof that this reaches getTransaction through the real
// locator table lives in tests/onchain-orchestration-v1.test.ts. What is
// proved HERE is everything answerable without a database: the subject
// typing, the base-intent rule, the pre-provider shape guard, and the budget
// invariants that must NOT have moved.
//
// Every identifier is a fixture literal. No project, mint or transaction is
// named anywhere in this file.

const ANCHOR = "Mint1111111111111111111111111111111111111111";
const ADDRESS = "Wa11et11111111111111111111111111111111111111";
const SIGNATURE = "Sig1111111111111111111111111111111111111111111111111111111111111111";

const IDENTITY: ConfirmedProjectIdentity = {
  chain: "solana",
  tokenAddress: ANCHOR,
  ticker: "TST",
};
const ONCHAIN_CLASSES = ["ONCHAIN_VERIFIABLE"] as const;
const CHAIN_COMPONENT = "EXECUTION_EVIDENCE";

function locator(value: string, shape: "ADDRESS_LIKE" | "SIGNATURE_LIKE"): MechanismLocator {
  return { value, shape, origin: "ADMITTED_EVIDENCE_SOURCE" };
}

function baseIntents(locators: readonly MechanismLocator[], component = CHAIN_COMPONENT) {
  return selectOnchainIntents({
    component,
    establishingClasses: ONCHAIN_CLASSES,
    identity: IDENTITY,
    locators,
    maxIntents: MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
  });
}

// ---------------------------------------------------------------------
describe("the validator's shape decides the subject kind", () => {
  it("the two fixture identifiers really are the two shapes", () => {
    // The premise of everything below, asserted rather than assumed.
    expect(completeIdentifierShape(ADDRESS)).toBe("ADDRESS_LIKE");
    expect(completeIdentifierShape(SIGNATURE)).toBe("SIGNATURE_LIKE");
  });

  it("anchor -> token, ADDRESS_LIKE -> account, SIGNATURE_LIKE -> tx", () => {
    const subjects = eligibleSubjects(IDENTITY, [
      locator(ADDRESS, "ADDRESS_LIKE"),
      locator(SIGNATURE, "SIGNATURE_LIKE"),
    ]);
    expect(subjects).toEqual([
      { subject: ANCHOR, kind: "token" },
      { subject: ADDRESS, kind: "account" },
      { subject: SIGNATURE, kind: "tx" },
    ]);
  });

  it("the anchor is still returned alone when no locator exists", () => {
    expect(eligibleSubjects(IDENTITY, [])).toEqual([{ subject: ANCHOR, kind: "token" }]);
  });
});

describe("a documented signature becomes a direct transaction read", () => {
  it("1. an admitted SIGNATURE_LIKE locator produces TRANSACTION_DETAIL as a BASE intent", () => {
    const intents = baseIntents([locator(SIGNATURE, "SIGNATURE_LIKE")]);
    expect(intents.map((i) => i.kind)).toEqual(["TRANSACTION_DETAIL"]);
    expect(intents[0]!.subject).toBe(SIGNATURE);
    expect(intents[0]!.subjectKind).toBe("tx");
    // The anchor is never the subject of a transaction read.
    expect(intents[0]!.projectAnchor).toBe(ANCHOR);
  });

  it("2. it produces NO account-kind intent — the wasted ACCOUNT_INFO is gone", () => {
    const intents = baseIntents([locator(SIGNATURE, "SIGNATURE_LIKE")]);
    expect(intents.some((i) => i.kind === "ACCOUNT_INFO")).toBe(false);
    expect(intents.some((i) => i.subjectKind === "account")).toBe(false);
  });

  it("3. an ADDRESS_LIKE locator still yields exactly ACCOUNT_INFO and nothing else", () => {
    const intents = baseIntents([locator(ADDRESS, "ADDRESS_LIKE")]);
    expect(intents.map((i) => i.kind)).toEqual(["ACCOUNT_INFO"]);
    expect(intents[0]!.subjectKind).toBe("account");
    // TRANSACTION_DETAIL is listed for this component but matches no subject,
    // so a job that documents only addresses is untouched by this change.
    expect(intents.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
  });

  it("5. a transaction subject cannot be conjured without a signature locator", () => {
    for (const locators of [[], [locator(ADDRESS, "ADDRESS_LIKE")]]) {
      const intents = baseIntents(locators);
      expect(intents.some((i) => i.subjectKind === "tx")).toBe(false);
      expect(intents.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
    }
  });

  it("the exception is exactly one kind, and the other two stay promotion-only", () => {
    expect([...DOCUMENTARY_BASE_INTENTS]).toEqual(["TRANSACTION_DETAIL"]);
    // The two that genuinely CANNOT have a documentary subject are unchanged:
    // no document states a token-account listing or a signature window.
    for (const kind of ["TOKEN_ACCOUNTS_BY_OWNER", "SIGNATURES_FOR_ADDRESS"] as const) {
      expect(PROMOTION_ONLY_INTENTS.has(kind)).toBe(true);
      expect(DOCUMENTARY_BASE_INTENTS.has(kind)).toBe(false);
    }
  });

  it("a signature locator gives owner-discovery and history no way in either", () => {
    const kinds = baseIntents([locator(SIGNATURE, "SIGNATURE_LIKE")]).map((i) => i.kind);
    expect(kinds).not.toContain("TOKEN_ACCOUNTS_BY_OWNER");
    expect(kinds).not.toContain("SIGNATURES_FOR_ADDRESS");
  });

  it("components that do not ask the execution question get no transaction read", () => {
    // The new route is scoped to the component whose question it answers.
    for (const component of ["DESTINATION", "RECIPIENT", "FLOW_PATH"]) {
      const intents = baseIntents([locator(SIGNATURE, "SIGNATURE_LIKE")], component);
      expect(intents.some((i) => i.kind === "TRANSACTION_DETAIL")).toBe(false);
    }
  });

  it("the per-attempt intent cap still binds with both kinds present", () => {
    const intents = baseIntents([
      locator(SIGNATURE, "SIGNATURE_LIKE"),
      locator(ADDRESS, "ADDRESS_LIKE"),
    ]);
    expect(intents.length).toBeLessThanOrEqual(MAX_ONCHAIN_INTENTS_PER_ATTEMPT);
    // The documented transaction is served first: terminal, one read, and
    // reachable no other way.
    expect(intents.map((i) => i.kind)).toEqual(["TRANSACTION_DETAIL", "ACCOUNT_INFO"]);
  });
});

// ---------------------------------------------------------------------
describe("a shape/intent mismatch is refused BEFORE the provider, and costs nothing", () => {
  // A locator whose recorded shape CONTRADICTS its value. Base selection can
  // no longer produce one, which is exactly why this drives the guard
  // directly: it is the future regression the guard exists to catch.
  const LYING = locator(SIGNATURE, "ADDRESS_LIKE");

  async function runWithLyingLocator() {
    const calls: OnchainIntent[] = [];
    const reserved: number[] = [];
    const traced: { operationType: string; reasonCode?: string }[] = [];
    const outcome = await runStructuredOnchainAcquisition({
      db: null as never,
      jobId: "job",
      attemptId: null,
      item: { step: 4, component: CHAIN_COMPONENT },
      plan: { establishingClasses: ONCHAIN_CLASSES, confirmedIdentity: IDENTITY },
      locators: [LYING],
      maxSourceOpens: 24,
      retriever: {
        name: "fixture",
        supports: () => true,
        retrieve: async (intent: OnchainIntent) => {
          calls.push(intent);
          throw new Error("the provider must never be reached");
        },
      } as never,
      reserve: async (_axis, amount) => {
        reserved.push(amount);
        return true;
      },
      recordTrace: async (e) => {
        traced.push({ operationType: e.operationType, reasonCode: e.reasonCode });
      },
    });
    return { outcome, calls, reserved, traced };
  }

  it("the provider is never invoked", async () => {
    const { calls } = await runWithLyingLocator();
    expect(calls).toHaveLength(0);
  });

  it("no budget is reserved and none is spent", async () => {
    const { reserved, outcome } = await runWithLyingLocator();
    expect(reserved).toHaveLength(0);
    expect(outcome.sourceOpensSpent).toBe(0);
  });

  it("it is NOT reported as PROVIDER_ERROR — it names the engine's own mistake", async () => {
    const { traced } = await runWithLyingLocator();
    expect(traced.some((t) => t.reasonCode === "PROVIDER_ERROR")).toBe(false);
    expect(traced.some((t) => t.reasonCode === "SUBJECT_SHAPE_MISMATCH")).toBe(true);
  });

  it("the refusal is attributed to the locator that produced the subject", async () => {
    const { traced } = await runWithLyingLocator();
    const refusal = traced.find((t) => t.reasonCode === "SUBJECT_SHAPE_MISMATCH");
    expect(refusal?.operationType).toBe("LOCATOR_REJECTED");
  });

  it("and the attempt yields no evidence at all", async () => {
    const { outcome } = await runWithLyingLocator();
    expect(outcome.evidenceIds).toHaveLength(0);
    expect(outcome.observations).toContain("ONCHAIN_SUBJECT_SHAPE_MISMATCH");
  });

  it("the matcher itself: each intent kind accepts only its own shape", () => {
    const tx = (subject: string): OnchainIntent => ({
      kind: "TRANSACTION_DETAIL",
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "tx",
      subject,
    });
    const account = (subject: string): OnchainIntent => ({
      kind: "ACCOUNT_INFO",
      chain: "solana",
      network: "mainnet",
      projectAnchor: ANCHOR,
      subjectKind: "account",
      subject,
    });
    expect(subjectShapeMatchesIntent(tx(SIGNATURE))).toBe(true);
    expect(subjectShapeMatchesIntent(tx(ADDRESS))).toBe(false);
    expect(subjectShapeMatchesIntent(account(ADDRESS))).toBe(true);
    expect(subjectShapeMatchesIntent(account(SIGNATURE))).toBe(false);
    // Fail closed: an identifier of no recognised shape matches nothing
    // rather than being sent to an endpoint to find out.
    expect(subjectShapeMatchesIntent(account("not-base58-!!!"))).toBe(false);
    expect(subjectShapeMatchesIntent(tx(""))).toBe(false);
  });
});

// ---------------------------------------------------------------------
describe("10. no budget constant moved, and the reservation did not grow", () => {
  const canonicalDemands = () =>
    planDeterministicDemand({
      identity: IDENTITY,
      components: [
        { component: "CURRENT_STATE", establishingClasses: ONCHAIN_CLASSES },
        { component: "NET_EFFECT", establishingClasses: ONCHAIN_CLASSES },
        { component: CHAIN_COMPONENT, establishingClasses: ONCHAIN_CLASSES },
      ],
    });

  it("the global envelope is still 24", () => {
    expect(INTERNAL_ALPHA_V1.maxSourceOpens).toBe(24);
  });

  it("the canonical shape still reserves 7 and still leaves 17", () => {
    const reserve = computeOnchainSourceOpenReserve({
      maxSourceOpens: 24,
      demands: canonicalDemands(),
    });
    expect(reserve.reserved).toBe(7);
    expect(reserve.documentaryCeiling).toBe(17);
    // The invariant that makes it protection rather than an allowance.
    expect(reserve.reserved + reserve.documentaryCeiling).toBe(24);
    expect(reserve.maxSourceOpens).toBe(24);
  });

  it("the derived ceiling is unchanged, and a transaction read fits INSIDE it", () => {
    expect(ONCHAIN_RESERVED_SOURCE_OPENS).toBe(5);
    // A documented transaction is one of the base reads the reservation
    // ALREADY protects: base intents are capped at
    // MAX_ONCHAIN_INTENTS_PER_ATTEMPT, and the base half of the reservation
    // is that same bound. Nothing had to grow to make room.
    expect(baseIntents([locator(SIGNATURE, "SIGNATURE_LIKE")]).length).toBeLessThanOrEqual(
      MAX_ONCHAIN_INTENTS_PER_ATTEMPT,
    );
  });

  it("the signature window bound is untouched — no paging was introduced", () => {
    expect(MAX_SIGNATURES_PER_INTENT).toBe(25);
  });
});
