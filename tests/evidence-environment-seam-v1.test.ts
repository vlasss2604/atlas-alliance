import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  identifierFamilyOfChain,
  identifierFamilyOfValue,
  identifierShapeForChain,
  identifierShapeOfAnyFamily,
} from "../src/server/domain/identifier-shape";
import {
  addressShapeMatchesChain,
  chainAddressesEqual,
  parseProjectIdentity,
  type ConfirmedProjectIdentity,
} from "../src/server/domain/project-identity";
import {
  completeIdentifierShape,
  literallyPresent,
  validateDocumentaryLocator,
} from "../src/server/engine/documentary-locator";
import { validateFactLocators } from "../src/server/engine/documentary-locator-store";
import {
  componentAdmitsOnchainAcquisition,
  runStructuredOnchainAcquisition,
  selectOnchainIntents,
  subjectShapeMatchesIntent,
} from "../src/server/engine/onchain-acquisition";
import { validateOnchainBinding } from "../src/server/engine/onchain-binding";
import {
  endpointEnvVarFor as endpointEnvVarFromTable,
  onchainEnvironmentFor,
  onchainEnvironmentImplemented,
} from "../src/server/engine/onchain-environment";
import { planHasActionableOnchainWork } from "../src/server/engine/onchain-source-open-reserve";
import { deriveTotalSupplyDelta } from "../src/server/engine/onchain-supply-delta";
import { buildCanonicalOnchainUri, parseCanonicalOnchainUri } from "../src/server/engine/onchain-uri";
import {
  __setOnchainRetriever,
  endpointEnvVarFor,
  onchainRetrievalAvailable,
  OnchainRetrieverUnavailableError,
  resolveOnchainRetriever,
  type OnchainRetriever,
} from "../src/server/engine/providers/onchain-retriever";
import { createProductionOnchainRetriever } from "../src/server/engine/providers/onchain-transport";
import {
  brandOnchainArtifact,
  chainPositionOf,
  compareChainPositions,
  type OnchainArtifact,
  type OnchainIntent,
  type OnchainProvenance,
} from "../src/server/engine/providers/onchain-types";
import { extractDocumentLinks } from "../src/server/engine/providers/document-links";
import { classifyIdentifier } from "../src/server/engine/providers/embedded-records";
import {
  installOnchainResearchCapability,
  ONCHAIN_RESEARCH_ENV,
  uninstallOnchainResearchCapability,
} from "../src/server/jobs/onchain-capability";
import type { PhaseCapability } from "../src/server/jobs/worker-capabilities";

// EVIDENCE ENVIRONMENT SEAM V1 — ONE RESEARCH CORE, MULTIPLE EVIDENCE
// ENVIRONMENTS.
//
// The deterministic on-chain layer was conceptually reusable and literally
// Solana: the retriever seam was one global slot, the acquisition gate and
// intent creation said `"solana"`, and every identifier check knew one
// alphabet. This round makes the seam explicit — a registry keyed by
// (chain, network), an environment derived from the confirmed identity, a
// chain-aware identifier shape, a chain position that refuses cross-
// environment comparison — WITHOUT adding a second implementation.
//
// Every test here is offline and needs no database. The Solana half pins
// that nothing observable changed; the EVM half pins that the generic
// layer now recognises EVM structure and still fails closed everywhere a
// retriever would be needed.

const SOLANA_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOLANA_SIGNATURE = "5".repeat(88);
const EVM_ADDRESS = "0x" + "ab12".repeat(10);
const EVM_ADDRESS_CHECKSUMMED = "0x" + "AB12".repeat(10);
const EVM_TX_HASH = "0x" + "cd34".repeat(16);

const SOLANA_IDENTITY: ConfirmedProjectIdentity = {
  chain: "solana",
  tokenAddress: SOLANA_MINT,
  ticker: "SOL",
};
const ETHEREUM_IDENTITY: ConfirmedProjectIdentity = {
  chain: "ethereum",
  tokenAddress: EVM_ADDRESS,
  ticker: "ETH",
};

const SOLANA_MAINNET = { chain: "solana", network: "mainnet" } as const;
const ETHEREUM_MAINNET = { chain: "ethereum", network: "mainnet" } as const;
const ESTABLISHING = ["ONCHAIN_VERIFIABLE"] as const;

function fixtureRetriever(name: string): OnchainRetriever {
  return {
    name,
    supports: () => true,
    retrieve: async () => {
      throw new Error(`${name}: fixture must never retrieve`);
    },
  };
}

function supplyArtifact(opts: {
  chain?: OnchainIntent["chain"];
  network?: OnchainIntent["network"];
  slot: number;
  amountRaw?: string;
  mint?: string;
}): OnchainArtifact {
  const mint = opts.mint ?? SOLANA_MINT;
  const intent: OnchainIntent = {
    kind: "TOKEN_SUPPLY",
    chain: opts.chain ?? "solana",
    network: opts.network ?? "mainnet",
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
  };
  const result = { kind: "TOKEN_SUPPLY" as const, mint, amountRaw: opts.amountRaw ?? "1000", decimals: 6 };
  const provenance: OnchainProvenance = {
    chain: intent.chain,
    network: intent.network,
    projectAnchor: mint,
    subjectKind: "token",
    subject: mint,
    slot: opts.slot,
    blockTime: null,
    blockHash: null,
    finality: "finalized",
    retrievalMethod: "RPC",
    providerId: "fixture-provider",
    providerMethod: "getTokenSupply",
    requestParams: { subject: mint },
    transactionSignature: null,
    retrievedAt: new Date("2026-09-01T00:00:00Z"),
    rawResponseHash: "raw",
    artifactHash: "art",
  };
  return brandOnchainArtifact({
    intent,
    canonicalUri: buildCanonicalOnchainUri(intent),
    result,
    normalizedText: JSON.stringify(result),
    provenance,
  });
}

afterEach(() => {
  __setOnchainRetriever(null);
  delete process.env.SOLANA_MAINNET_RPC_URL;
});

// ---------------------------------------------------------------------
// The environment table: what the codebase implements, statically.
// ---------------------------------------------------------------------

describe("implemented environments — code-owned, one production network per chain", () => {
  it("Solana resolves to exactly the environment it always addressed", () => {
    expect(onchainEnvironmentFor("solana")).toEqual(SOLANA_MAINNET);
    expect(onchainEnvironmentImplemented("solana", "mainnet")).toBe(true);
    expect(endpointEnvVarFromTable("solana", "mainnet")).toBe("SOLANA_MAINNET_RPC_URL");
    // The same answer through the retriever module's re-export.
    expect(endpointEnvVarFor("solana", "mainnet")).toBe("SOLANA_MAINNET_RPC_URL");
  });

  it("an EVM chain has NO environment yet — null, never another chain's", () => {
    for (const chain of ["ethereum", "bsc", "polygon", "arbitrum", "base", "optimism", "avalanche"] as const) {
      expect(onchainEnvironmentFor(chain), chain).toBeNull();
      expect(onchainEnvironmentImplemented(chain, "mainnet"), chain).toBe(false);
      expect(endpointEnvVarFor(chain, "mainnet"), chain).toBeNull();
    }
    // D-131: no test network is addressable for any chain.
    expect(onchainEnvironmentImplemented("solana", "devnet")).toBe(false);
    expect(onchainEnvironmentImplemented("ethereum", "sepolia")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// A + D + E: the registry, keyed by (chain, network), with no fallback.
// ---------------------------------------------------------------------

describe("retriever registry — keyed by (chain, network), fail closed", () => {
  it("A. a Solana installation resolves for solana/mainnet exactly as before", () => {
    const solana = fixtureRetriever("solana-fixture");
    __setOnchainRetriever(solana, SOLANA_MAINNET);
    expect(resolveOnchainRetriever("solana", "mainnet")).toBe(solana);
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(true);
    // The unqualified process-level question still answers.
    expect(onchainRetrievalAvailable()).toBe(true);
  });

  it("D. resolution is by the exact key: another network of the same chain is unreachable", () => {
    __setOnchainRetriever(fixtureRetriever("solana-fixture"), SOLANA_MAINNET);
    expect(onchainRetrievalAvailable("solana", "devnet" as never)).toBe(false);
    expect(() => resolveOnchainRetriever("solana", "devnet" as never)).toThrow(
      OnchainRetrieverUnavailableError,
    );
  });

  it("E. an Ethereum identity NEVER falls back to the Solana retriever", () => {
    __setOnchainRetriever(fixtureRetriever("solana-fixture"), SOLANA_MAINNET);
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(false);
    expect(() => resolveOnchainRetriever("ethereum", "mainnet")).toThrow(
      OnchainRetrieverUnavailableError,
    );
    try {
      resolveOnchainRetriever("ethereum", "mainnet");
    } catch (e) {
      // The refusal names the environment that was asked for.
      expect((e as Error).message).toContain("ethereum/mainnet");
    }
  });

  it("an unconfigured environment fails closed, and nothing is resolvable without an installation", () => {
    expect(onchainRetrievalAvailable()).toBe(false);
    expect(() => resolveOnchainRetriever("solana", "mainnet")).toThrow(OnchainRetrieverUnavailableError);
  });

  it("no provider guessing: an install must name its environment, and only an implemented one", () => {
    // No default environment.
    expect(() => __setOnchainRetriever(fixtureRetriever("anonymous"))).toThrow(/explicit \(chain, network\)/);
    // No capability the codebase has no adapter for.
    expect(() => __setOnchainRetriever(fixtureRetriever("evm"), ETHEREUM_MAINNET)).toThrow(
      /not an implemented on-chain environment/,
    );
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("uninstalling one environment leaves the registry honest; null alone clears everything", () => {
    __setOnchainRetriever(fixtureRetriever("solana-fixture"), SOLANA_MAINNET);
    __setOnchainRetriever(null, SOLANA_MAINNET);
    expect(onchainRetrievalAvailable("solana", "mainnet")).toBe(false);
    __setOnchainRetriever(fixtureRetriever("solana-fixture"), SOLANA_MAINNET);
    __setOnchainRetriever(null);
    expect(onchainRetrievalAvailable()).toBe(false);
  });

  it("the production factory is a per-environment map: Solana only, no cross-chain adapter", () => {
    process.env.SOLANA_MAINNET_RPC_URL = "https://rpc.example.test";
    const solana = createProductionOnchainRetriever("solana", "mainnet");
    expect(solana).not.toBeNull();
    expect(solana!.supports("solana", "mainnet", "TOKEN_SUPPLY")).toBe(true);
    expect(solana!.supports("ethereum", "mainnet", "TOKEN_SUPPLY")).toBe(false);
    // Even with a Solana endpoint configured, Ethereum yields nothing.
    expect(createProductionOnchainRetriever("ethereum", "mainnet")).toBeNull();
    expect(createProductionOnchainRetriever("solana", "devnet")).toBeNull();
  });

  it("the worker capability installs under its declared environment, and that is what the engine resolves", () => {
    const created = fixtureRetriever("declared");
    const r = installOnchainResearchCapability({
      capabilities: new Set<PhaseCapability>(["SEARCH_EXTRACT"]),
      env: { [ONCHAIN_RESEARCH_ENV]: "1" },
      create: () => created,
    });
    expect(r.outcome).toBe("INSTALLED");
    expect(resolveOnchainRetriever("solana", "mainnet")).toBe(created);
    expect(onchainRetrievalAvailable("ethereum", "mainnet")).toBe(false);
    uninstallOnchainResearchCapability();
    expect(onchainRetrievalAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------
// B + C: the acquisition gates consult the environment, not a chain name.
// ---------------------------------------------------------------------

describe("acquisition gates — environment-aware, Solana unchanged, EVM fails closed", () => {
  it("B. a Solana identity admits acquisition and produces the same intents as before", () => {
    expect(
      componentAdmitsOnchainAcquisition({
        component: "CURRENT_STATE",
        establishingClasses: ESTABLISHING,
        identity: SOLANA_IDENTITY,
      }),
    ).toBe(true);
    const intents = selectOnchainIntents({
      component: "NET_EFFECT",
      establishingClasses: ESTABLISHING,
      identity: SOLANA_IDENTITY,
      maxIntents: 2,
    });
    // Pinned representative Solana output: one TOKEN_SUPPLY intent, on the
    // anchor, addressed to solana/mainnet.
    expect(intents).toEqual([
      {
        kind: "TOKEN_SUPPLY",
        chain: "solana",
        network: "mainnet",
        projectAnchor: SOLANA_MINT,
        subjectKind: "token",
        subject: SOLANA_MINT,
      },
    ]);
    expect(buildCanonicalOnchainUri(intents[0])).toBe(
      `atlas-onchain://solana/mainnet/project/${SOLANA_MINT}/token/${SOLANA_MINT}/supply`,
    );
    expect(
      planHasActionableOnchainWork({
        identity: SOLANA_IDENTITY,
        components: [{ component: "NET_EFFECT", establishingClasses: [...ESTABLISHING] }],
      }),
    ).toBe(true);
  });

  it("C. an Ethereum identity with no retriever admits nothing, creates nothing, routes nowhere", async () => {
    // Even with a Solana retriever installed — the exact situation a real
    // deployment is in today.
    __setOnchainRetriever(fixtureRetriever("solana-fixture"), SOLANA_MAINNET);
    expect(
      componentAdmitsOnchainAcquisition({
        component: "CURRENT_STATE",
        establishingClasses: ESTABLISHING,
        identity: ETHEREUM_IDENTITY,
      }),
    ).toBe(false);
    expect(
      selectOnchainIntents({
        component: "NET_EFFECT",
        establishingClasses: ESTABLISHING,
        identity: ETHEREUM_IDENTITY,
        maxIntents: 2,
      }),
    ).toEqual([]);
    expect(
      planHasActionableOnchainWork({
        identity: ETHEREUM_IDENTITY,
        components: [{ component: "NET_EFFECT", establishingClasses: [...ESTABLISHING] }],
      }),
    ).toBe(false);
    // The acquisition leaf returns before it can touch a database, a
    // retriever or a budget: no evidence, nothing spent, no fake
    // observation. The bounded not-configured path is what an implemented
    // environment without a retriever takes; an unimplemented one never
    // gets as far as asking.
    const outcome = await runStructuredOnchainAcquisition({
      db: null as never,
      jobId: "job",
      attemptId: null,
      item: { step: 5, component: "CURRENT_STATE" },
      plan: { establishingClasses: [...ESTABLISHING], confirmedIdentity: ETHEREUM_IDENTITY },
      maxSourceOpens: 24,
    });
    expect(outcome).toEqual({ evidenceIds: [], sourceOpensSpent: 0, observations: [] });
  });

  it("the gate names no chain: the literal Solana check is gone from the generic layer", () => {
    const acquisition = readFileSync("src/server/engine/onchain-acquisition.ts", "utf-8");
    expect(acquisition).not.toContain('identity.chain !== "solana"');
    expect(acquisition).not.toContain('chain: "solana"');
    expect(acquisition).toContain("onchainEnvironmentFor(");
    for (const file of [
      "src/server/engine/onchain-post-event-supply.ts",
      "src/server/engine/onchain-supply-delta-materialization.ts",
      "src/server/engine/structural-obligation.ts",
    ]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toContain('!== "solana"');
      expect(src, file).not.toContain('chain: "solana"');
      expect(src, file).not.toContain('proofApprovalForMethod("solana"');
    }
    const transport = readFileSync("src/server/engine/providers/onchain-transport.ts", "utf-8");
    expect(transport).not.toContain('if (chain === "solana")');
    expect(transport).toContain("IMPLEMENTATION_BY_ENVIRONMENT");
  });
});

// ---------------------------------------------------------------------
// F + G + H: identifier shape, per chain family.
// ---------------------------------------------------------------------

describe("identifier shape — Solana recognition unchanged, EVM structure recognised, never confused", () => {
  it("F. Solana base58 recognition is exactly what it was", () => {
    expect(identifierShapeForChain("solana", SOLANA_MINT)).toBe("ADDRESS_LIKE");
    expect(identifierShapeForChain("solana", SOLANA_ACCOUNT)).toBe("ADDRESS_LIKE");
    expect(identifierShapeForChain("solana", SOLANA_SIGNATURE)).toBe("SIGNATURE_LIKE");
    expect(identifierShapeForChain("solana", "1".repeat(31))).toBeNull(); // too short
    expect(identifierShapeForChain("solana", "0OIl" + "1".repeat(40))).toBeNull(); // excluded letters
    // The chain-less entry points every existing caller used.
    expect(completeIdentifierShape(SOLANA_MINT)).toBe("ADDRESS_LIKE");
    expect(completeIdentifierShape(SOLANA_SIGNATURE)).toBe("SIGNATURE_LIKE");
    expect(identifierShapeOfAnyFamily(SOLANA_MINT)).toBe("ADDRESS_LIKE");
    expect(classifyIdentifier(SOLANA_SIGNATURE)).toBe("SIGNATURE_LIKE");
    expect(addressShapeMatchesChain("solana", SOLANA_MINT)).toBe(true);
    expect(identifierFamilyOfChain("solana")).toBe("BASE58");
  });

  it("G. an EVM 0x address and 0x transaction hash are structurally complete for an EVM identity", () => {
    expect(identifierShapeForChain("ethereum", EVM_ADDRESS)).toBe("ADDRESS_LIKE");
    expect(identifierShapeForChain("ethereum", EVM_ADDRESS_CHECKSUMMED)).toBe("ADDRESS_LIKE");
    expect(identifierShapeForChain("ethereum", EVM_TX_HASH)).toBe("SIGNATURE_LIKE");
    expect(identifierShapeForChain("base", EVM_ADDRESS)).toBe("ADDRESS_LIKE");
    // Structural only: wrong length, missing prefix, non-hex.
    expect(identifierShapeForChain("ethereum", "0x" + "ab".repeat(19))).toBeNull();
    expect(identifierShapeForChain("ethereum", "ab12".repeat(10))).toBeNull();
    expect(identifierShapeForChain("ethereum", "0x" + "zz12".repeat(10))).toBeNull();
    expect(identifierShapeForChain("ethereum", "0x" + "ab".repeat(33))).toBeNull();
    expect(addressShapeMatchesChain("ethereum", EVM_ADDRESS)).toBe(true);
    expect(addressShapeMatchesChain("ethereum", EVM_TX_HASH)).toBe(false);
    expect(chainAddressesEqual("ethereum", EVM_ADDRESS, EVM_ADDRESS_CHECKSUMMED)).toBe(true);
    expect(chainAddressesEqual("solana", SOLANA_MINT, SOLANA_MINT.toLowerCase())).toBe(false);
    expect(parseProjectIdentity({ chain: "ethereum", tokenAddress: EVM_ADDRESS })).toMatchObject({
      chain: "ethereum",
      tokenAddress: EVM_ADDRESS,
    });
  });

  it("H. an EVM-shaped identifier is never interpreted as Solana, and vice versa", () => {
    expect(identifierShapeForChain("solana", EVM_ADDRESS)).toBeNull();
    expect(identifierShapeForChain("solana", EVM_TX_HASH)).toBeNull();
    expect(identifierShapeForChain("ethereum", SOLANA_MINT)).toBeNull();
    expect(identifierShapeForChain("ethereum", SOLANA_SIGNATURE)).toBeNull();
    expect(identifierFamilyOfValue(EVM_ADDRESS)).toBe("EVM_HEX");
    expect(identifierFamilyOfValue(SOLANA_MINT)).toBe("BASE58");
    expect(identifierFamilyOfValue("not an identifier")).toBeNull();
    expect(addressShapeMatchesChain("solana", EVM_ADDRESS)).toBe(false);
    expect(parseProjectIdentity({ chain: "solana", tokenAddress: EVM_ADDRESS })).toBeNull();
    // A proposed EVM locator under a Solana project is "not an identifier".
    expect(
      validateDocumentaryLocator({
        claimedLocator: EVM_ADDRESS,
        documentText: `burns go to ${EVM_ADDRESS}`,
        chain: "solana",
      }),
    ).toEqual({ locator: "NONE", reason: "NOT_A_COMPLETE_IDENTIFIER" });
    // And a base58 one under an EVM project likewise.
    expect(
      validateDocumentaryLocator({
        claimedLocator: SOLANA_ACCOUNT,
        documentText: `burns go to ${SOLANA_ACCOUNT}`,
        chain: "ethereum",
      }),
    ).toEqual({ locator: "NONE", reason: "NOT_A_COMPLETE_IDENTIFIER" });
  });

  it("the documentary locator accepts an EVM identifier for an EVM identity, literal presence included", () => {
    expect(
      validateDocumentaryLocator({
        claimedLocator: EVM_ADDRESS,
        documentText: `The treasury is ${EVM_ADDRESS}.`,
        chain: "ethereum",
      }),
    ).toEqual({ locator: "CONFIRMED", value: EVM_ADDRESS, shape: "ADDRESS_LIKE" });
    // Literal presence has a hex boundary: the address inside a longer hex
    // run is not this address.
    expect(literallyPresent(`x${EVM_ADDRESS}0`, EVM_ADDRESS)).toBe(false);
    expect(literallyPresent(`see ${EVM_ADDRESS}, then`, EVM_ADDRESS)).toBe(true);
    // Solana's boundary rule is untouched.
    expect(literallyPresent(`${SOLANA_MINT}1`, SOLANA_MINT)).toBe(false);
    expect(literallyPresent(`(${SOLANA_MINT})`, SOLANA_MINT)).toBe(true);
    // Not literally in the document: refused for EVM exactly as for base58.
    expect(
      validateDocumentaryLocator({
        claimedLocator: EVM_TX_HASH,
        documentText: "the page names no hash",
        chain: "ethereum",
      }),
    ).toEqual({ locator: "NONE", reason: "NOT_LITERAL_IN_DOCUMENT" });
    // The per-fact validator threads the chain through unchanged.
    const outcome = validateFactLocators({
      claimed: [EVM_ADDRESS, SOLANA_ACCOUNT],
      documentText: `${EVM_ADDRESS} and ${SOLANA_ACCOUNT}`,
      chain: "ethereum",
    });
    expect(outcome.confirmed).toEqual([{ value: EVM_ADDRESS, shape: "ADDRESS_LIKE" }]);
    expect(outcome.rejected).toEqual([{ claimed: SOLANA_ACCOUNT, reason: "NOT_A_COMPLETE_IDENTIFIER" }]);
  });

  it("with no confirmed chain, any complete family is a shape and none is a chain", () => {
    expect(completeIdentifierShape(EVM_ADDRESS)).toBe("ADDRESS_LIKE");
    expect(completeIdentifierShape(EVM_TX_HASH)).toBe("SIGNATURE_LIKE");
    expect(completeIdentifierShape(SOLANA_MINT)).toBe("ADDRESS_LIKE");
    expect(
      validateDocumentaryLocator({ claimedLocator: EVM_ADDRESS, documentText: EVM_ADDRESS }),
    ).toEqual({ locator: "CONFIRMED", value: EVM_ADDRESS, shape: "ADDRESS_LIKE" });
  });

  it("link discovery recognises an EVM identifier in an href without dropping base58 ones", () => {
    const html =
      `<a href="https://etherscan.io/address/${EVM_ADDRESS}">contract</a>` +
      `<a href="https://solscan.io/tx/${SOLANA_SIGNATURE}">burn</a>`;
    const found = extractDocumentLinks(html).identifiers.map((i) => [i.value, i.shape]);
    expect(found).toContainEqual([EVM_ADDRESS, "ADDRESS_LIKE"]);
    expect(found).toContainEqual([SOLANA_SIGNATURE, "SIGNATURE_LIKE"]);
  });

  it("the acquisition subject gate is asked for the intent's own chain", () => {
    const base = { kind: "ACCOUNT_INFO" as const, network: "mainnet" as const, subjectKind: "account" as const };
    // Solana intent, Solana subject: as before.
    expect(
      subjectShapeMatchesIntent({ ...base, chain: "solana", projectAnchor: SOLANA_MINT, subject: SOLANA_ACCOUNT }),
    ).toBe(true);
    // Solana intent, EVM subject: refused before any endpoint could see it.
    expect(
      subjectShapeMatchesIntent({ ...base, chain: "solana", projectAnchor: SOLANA_MINT, subject: EVM_ADDRESS }),
    ).toBe(false);
    // An EVM intent recognises EVM structure — structure only; no retriever
    // exists to act on it.
    expect(
      subjectShapeMatchesIntent({ ...base, chain: "ethereum", projectAnchor: EVM_ADDRESS, subject: EVM_ADDRESS }),
    ).toBe(true);
    expect(
      subjectShapeMatchesIntent({
        ...base,
        kind: "TRANSACTION_DETAIL",
        subjectKind: "tx",
        chain: "ethereum",
        projectAnchor: EVM_ADDRESS,
        subject: EVM_TX_HASH,
      }),
    ).toBe(true);
    expect(
      subjectShapeMatchesIntent({ ...base, chain: "ethereum", projectAnchor: EVM_ADDRESS, subject: SOLANA_ACCOUNT }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// I: chain position — ordered only inside one environment.
// ---------------------------------------------------------------------

describe("chain position — a monotonic ordinal inside ONE (chain, network)", () => {
  it("reads the Solana slot as the ordinal without renaming anything persisted", () => {
    const p = supplyArtifact({ slot: 4321 }).provenance;
    expect(chainPositionOf(p)).toEqual({ ordinal: 4321, blockTime: null, blockHash: null, finality: "finalized" });
    expect(p.slot).toBe(4321);
  });

  it("orders two Solana positions by slot", () => {
    const a = supplyArtifact({ slot: 100 }).provenance;
    const b = supplyArtifact({ slot: 200 }).provenance;
    expect(compareChainPositions(a, b)).toEqual({ comparable: true, order: "BEFORE" });
    expect(compareChainPositions(b, a)).toEqual({ comparable: true, order: "AFTER" });
    expect(compareChainPositions(a, a)).toEqual({ comparable: true, order: "SAME" });
  });

  it("I. a cross-chain comparison fails closed — slot 100 on Solana is not before block 200 on Ethereum", () => {
    const solana = supplyArtifact({ slot: 100 }).provenance;
    const ethereum = supplyArtifact({ slot: 200, chain: "ethereum", mint: EVM_ADDRESS }).provenance;
    expect(compareChainPositions(solana, ethereum)).toEqual({ comparable: false, reason: "CHAIN_MISMATCH" });
    expect(compareChainPositions(ethereum, solana)).toEqual({ comparable: false, reason: "CHAIN_MISMATCH" });
    // Same chain, different network: equally incomparable.
    expect(
      compareChainPositions(solana, { chain: "solana", network: "devnet" as never, slot: 200 }),
    ).toEqual({ comparable: false, reason: "NETWORK_MISMATCH" });
    // An unusable ordinal is a refusal, not a zero.
    expect(compareChainPositions(solana, { ...solana, slot: -1 })).toEqual({
      comparable: false,
      reason: "INVALID_POSITION",
    });
  });

  it("the supply delta still orders by the chain's position and refuses across environments", () => {
    const t0 = supplyArtifact({ slot: 100, amountRaw: "1000" });
    const t1 = supplyArtifact({ slot: 200, amountRaw: "900" });
    const delta = deriveTotalSupplyDelta(t0, t1);
    expect(delta.comparable).toBe(true);
    if (delta.comparable) {
      expect(delta.delta.deltaRaw).toBe("-100");
      expect(delta.delta.slotSpan).toBe(100);
      expect(delta.delta.direction).toBe("DECREASED");
    }
    expect(deriveTotalSupplyDelta(t1, t0)).toEqual({ comparable: false, reason: "NON_INCREASING_SLOT" });
    expect(deriveTotalSupplyDelta(t0, supplyArtifact({ slot: 100 }))).toEqual({
      comparable: false,
      reason: "NON_INCREASING_SLOT",
    });
    expect(
      deriveTotalSupplyDelta(t0, supplyArtifact({ slot: 200, chain: "ethereum", mint: EVM_ADDRESS })),
    ).toEqual({ comparable: false, reason: "CHAIN_MISMATCH" });
  });
});

// ---------------------------------------------------------------------
// L: the canonical URI stays chain/network-qualified; binding stays exact.
// ---------------------------------------------------------------------

describe("canonical URI and binding — chain/network-qualified, unchanged for Solana", () => {
  it("L. the URI carries chain and network for any environment and round-trips", () => {
    const solana = supplyArtifact({ slot: 1 }).intent;
    expect(buildCanonicalOnchainUri(solana)).toBe(
      `atlas-onchain://solana/mainnet/project/${SOLANA_MINT}/token/${SOLANA_MINT}/supply`,
    );
    const evmIntent: OnchainIntent = {
      kind: "TOKEN_SUPPLY",
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: EVM_ADDRESS,
      subjectKind: "token",
      subject: EVM_ADDRESS,
    };
    const uri = buildCanonicalOnchainUri(evmIntent);
    expect(uri).toBe(`atlas-onchain://ethereum/mainnet/project/${EVM_ADDRESS}/token/${EVM_ADDRESS}/supply`);
    expect(parseCanonicalOnchainUri(uri)).toEqual({
      chain: "ethereum",
      network: "mainnet",
      projectAnchor: EVM_ADDRESS,
      subjectKind: "token",
      subject: EVM_ADDRESS,
      intentPath: "supply",
    });
  });

  it("binding a Solana artifact to a Solana identity is CONFIRMED, and to an Ethereum identity is CHAIN_MISMATCH", () => {
    const artifact = supplyArtifact({ slot: 10 });
    expect(validateOnchainBinding(artifact, SOLANA_IDENTITY)).toEqual({ binding: "CONFIRMED" });
    expect(validateOnchainBinding(artifact, ETHEREUM_IDENTITY)).toEqual({
      binding: "UNVERIFIED",
      reason: "CHAIN_MISMATCH",
    });
    // Anchor equality is the chain family's rule: a case-changed Solana
    // anchor is a different address.
    expect(
      validateOnchainBinding(artifact, { ...SOLANA_IDENTITY, tokenAddress: SOLANA_MINT.toLowerCase() }),
    ).toEqual({ binding: "UNVERIFIED", reason: "ANCHOR_NOT_PROJECT_IDENTITY" });
  });
});
