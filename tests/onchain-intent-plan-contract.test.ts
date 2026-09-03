import { describe, expect, it } from "vitest";

import {
  componentAdmitsOnchainAcquisition,
  selectOnchainIntents,
} from "../src/server/engine/onchain-acquisition";
import type { ConfirmedProjectIdentity } from "../src/server/domain/project-identity";

// WHICH COMPONENT MAY ASK THE CHAIN WHAT — PINNED.
//
// `INTENTS_BY_COMPONENT` decides, for every component, which bounded chain
// reads its acquisition may issue. Nothing asserted its contents: the six
// suites that import `selectOnchainIntents` all test behaviour AROUND the
// map — budget delegation, locator scoping, module boundaries — so an entry
// could be added or removed without a single test noticing.
//
// It went unnoticed. SOURCE_OF_VALUE mapped to TOKEN_SUPPLY, and a live
// acceptance run surfaced it: TOKEN_SUPPLY is the only intent addressed to
// the ANCHOR rather than to a discovered locator, so on a job whose
// documentary acquisition produced no locator it was the only chain read
// that could happen — and it arrived filed under a component a supply level
// cannot speak to.
//
// This file exists so the next entry is a decision. It asserts the map
// through the two functions that read it, so it pins the OBSERVABLE
// contract rather than a private constant, and it names every component
// including the ones that map nothing.

const MINT = "So11111111111111111111111111111111111111112";
const IDENTITY: ConfirmedProjectIdentity = {
  chain: "solana",
  tokenAddress: MINT,
  ticker: "TST",
};

// A locator-derived account subject, so account-kind intents are reachable.
const ACCOUNT_LOCATOR = [
  {
    address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    origin: "ADMITTED_EVIDENCE_SOURCE" as const,
  },
];

// EVERY component the Pattern can ask about, and the base intents each may
// issue. A component absent from the map issues none.
const EXPECTED_BASE_INTENTS: Record<string, string[]> = {
  // A token-level read, addressed to the anchor: the quantity this
  // component is about. The reconciler — not this map — is what stops one
  // level from becoming a change.
  NET_EFFECT: ["TOKEN_SUPPLY"],
  // A successful supply read proves the mint is live at a slot.
  CURRENT_STATE: ["TOKEN_SUPPLY"],
  // Account-kind, so each starts by classifying a documented account and
  // lets promotion decide what is meaningful next.
  DESTINATION: ["ACCOUNT_INFO"],
  RECIPIENT: ["ACCOUNT_INFO"],
  EXECUTION_EVIDENCE: ["ACCOUNT_INFO"],
  FLOW_PATH: ["ACCOUNT_INFO"],
  // NOTHING. A supply level does not answer where value comes from, and no
  // other chain read has been shown to either.
  SOURCE_OF_VALUE: [],
  // Documentary by nature: neither has ever mapped a chain read.
  MECHANISM_SPEC: [],
  GOVERNANCE_BASIS: [],
  DURABILITY_BASIS: [],
};

// Asked with ONCHAIN_VERIFIABLE admitted, so the Pattern gate is never what
// produces an empty answer — the map is.
const CLASSES = ["ONCHAIN_VERIFIABLE"] as const;

describe("on-chain intent plan — the component -> intent contract", () => {
  it("every component issues exactly the base intents it is meant to", () => {
    for (const [component, expected] of Object.entries(EXPECTED_BASE_INTENTS)) {
      const kinds = selectOnchainIntents({
        component,
        establishingClasses: CLASSES,
        identity: IDENTITY,
        locators: ACCOUNT_LOCATOR,
        maxIntents: 8,
      }).map((i) => i.kind);
      expect(kinds, component).toEqual(expected);
    }
  });

  it("SOURCE_OF_VALUE asks the chain nothing, with or without a locator", () => {
    // The regression itself. A supply level is anchor-addressed, so before
    // the fix this component issued a read on every job with a confirmed
    // identity — no locator, no discovery, no precondition of any kind.
    for (const locators of [[], ACCOUNT_LOCATOR]) {
      expect(
        selectOnchainIntents({
          component: "SOURCE_OF_VALUE",
          establishingClasses: CLASSES,
          identity: IDENTITY,
          locators,
          maxIntents: 8,
        }),
      ).toEqual([]);
    }
    // And it claims no on-chain capacity, so no protected budget is held
    // back for a read that cannot bear on the question.
    expect(
      componentAdmitsOnchainAcquisition({
        component: "SOURCE_OF_VALUE",
        establishingClasses: CLASSES,
        identity: IDENTITY,
      }),
    ).toBe(false);
  });

  it("capacity agrees with action, component by component", () => {
    // The two functions read the same map and must never disagree about
    // which components can reach a chain at all.
    for (const [component, expected] of Object.entries(EXPECTED_BASE_INTENTS)) {
      expect(
        componentAdmitsOnchainAcquisition({
          component,
          establishingClasses: CLASSES,
          identity: IDENTITY,
        }),
        component,
      ).toBe(expected.length > 0);
    }
  });

  it("the Pattern still decides admissibility, and identity still gates", () => {
    // Unchanged by this fix, asserted so the guard above cannot pass for
    // the wrong reason: a component the Pattern does not admit for
    // ONCHAIN_VERIFIABLE reaches no chain however it is mapped.
    expect(
      selectOnchainIntents({
        component: "NET_EFFECT",
        establishingClasses: ["OFFICIAL_DOCS"],
        identity: IDENTITY,
        locators: [],
        maxIntents: 8,
      }),
    ).toEqual([]);
    expect(
      selectOnchainIntents({
        component: "NET_EFFECT",
        establishingClasses: CLASSES,
        identity: null,
        locators: [],
        maxIntents: 8,
      }),
    ).toEqual([]);
  });
});
