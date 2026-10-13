import { describe, expect, it } from "vitest";

import { buildTargetedQueries } from "../src/server/engine/acquisition-targeting";
import { isTestNetworkHost, resolveSourceClass } from "../src/server/engine/source-authority";
import {
  addressShapeMatchesChain,
  explorerHostsForChain,
  explorerLocatorsForIdentity,
  parseProjectIdentity,
} from "../src/server/domain/project-identity";

// D-133 — confirmed project identity / locators.
//
// A live run steered `site:etherscan.io pump.fun ...`, found an unrelated
// Ethereum ERC-20 that merely MATCHED THE NAME, and used it to
// PARTIALLY_SUPPORT claims about $PUMP, a Solana asset. Wrong chain,
// wrong contract, wrong asset, presented as on-chain proof.
//
// The cure is to address shared platforms by a globally unique,
// human-confirmed IDENTIFIER instead of by name. Every test below uses
// placeholder addresses; no real project's confirmed values are encoded
// anywhere in the codebase, and none is invented here.
const EXAMPLE_SOLANA_MINT = "So11111111111111111111111111111111111111112";
const EXAMPLE_EVM_CONTRACT = "0x1111111111111111111111111111111111111111";

describe("project identity — confirmed locators (D-133)", () => {
  it("1. a confirmed token mint targets the correct project-specific explorer page", () => {
    const identity = parseProjectIdentity({ chain: "solana", tokenAddress: EXAMPLE_SOLANA_MINT });
    expect(identity).not.toBeNull();
    const locators = explorerLocatorsForIdentity(identity!);
    expect(locators.length).toBeGreaterThan(0);
    // The query text is the ADDRESS, never the project name — that is
    // what makes the result set unambiguous.
    for (const l of locators) {
      expect(l).toContain(EXAMPLE_SOLANA_MINT);
      const host = /^site:(\S+)\s/.exec(l)?.[1] ?? "";
      expect(resolveSourceClass(`https://${host}/token/x`, "OTHER", null)).toBe("ONCHAIN_VERIFIABLE");
    }
    // And acquisition actually emits them for a component admitting the class.
    const { targetedQueries } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      onchainLocators: locators,
      baseQueries: ["where do bought-back tokens go"],
    });
    expect(targetedQueries).toEqual(locators.slice(0, targetedQueries.length));
  });

  it("2. a shared explorer host cannot be targeted by project name alone", () => {
    const { targetedQueries, unreachableClasses } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      // No confirmed identity — this is the exact pre-fix situation.
      baseQueries: ["pump.fun buyback supply effect"],
    });
    expect(targetedQueries).toEqual([]);
    expect(unreachableClasses).toContain("ONCHAIN_VERIFIABLE");
    // A confirmed DOMAIN must not substitute for a confirmed ADDRESS on a
    // shared multi-tenant explorer.
    const viaDomain = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE"],
      confirmedRouteDomainsByClass: { ONCHAIN_VERIFIABLE: ["solscan.io"] },
      baseQueries: ["pump.fun buyback supply effect"],
    });
    expect(viaDomain.targetedQueries).toEqual([]);
    expect(viaDomain.unreachableClasses).toContain("ONCHAIN_VERIFIABLE");
  });

  it("3. a cross-chain / wrong-token page cannot satisfy identity via name text", () => {
    // An EVM contract filed under solana is self-inconsistent -> no identity.
    expect(parseProjectIdentity({ chain: "solana", tokenAddress: EXAMPLE_EVM_CONTRACT })).toBeNull();
    expect(parseProjectIdentity({ chain: "ethereum", tokenAddress: EXAMPLE_SOLANA_MINT })).toBeNull();
    expect(addressShapeMatchesChain("solana", EXAMPLE_EVM_CONTRACT)).toBe(false);

    // A Solana-confirmed project is NEVER addressed at an Ethereum explorer,
    // which is precisely how the live false positive was acquired.
    const solana = parseProjectIdentity({ chain: "solana", tokenAddress: EXAMPLE_SOLANA_MINT })!;
    const locators = explorerLocatorsForIdentity(solana);
    expect(locators.some((l) => l.includes("etherscan.io"))).toBe(false);
    expect(locators.every((l) => explorerHostsForChain("solana").some((h) => l.includes(h)))).toBe(true);
  });

  it("4. testnet identity cannot satisfy production identity", () => {
    // No chain maps to a test network explorer...
    for (const chain of ["solana", "ethereum", "polygon", "bsc"] as const) {
      for (const host of explorerHostsForChain(chain)) {
        expect(isTestNetworkHost(`https://${host}/`), host).toBe(false);
      }
    }
    // ...and a testnet host is not production on-chain authority even if
    // one were reached by some other route (D-131).
    expect(resolveSourceClass("https://sepolia.etherscan.io/token/0x1", "ONCHAIN", null)).toBe("SOCIAL");
    // A chain value that is not a known mainnet chain confers no identity.
    expect(parseProjectIdentity({ chain: "sepolia", tokenAddress: EXAMPLE_EVM_CONTRACT })).toBeNull();
    expect(parseProjectIdentity({ chain: "solana-devnet", tokenAddress: EXAMPLE_SOLANA_MINT })).toBeNull();
  });

  it("5. official docs require a confirmed project-specific route", () => {
    const none = buildTargetedQueries({
      establishingClasses: ["OFFICIAL_DOCS"],
      baseQueries: ["mechanism"],
    });
    expect(none.targetedQueries).toEqual([]);
    expect(none.unreachableClasses).toContain("OFFICIAL_DOCS");

    const confirmed = buildTargetedQueries({
      establishingClasses: ["OFFICIAL_DOCS"],
      confirmedRouteDomainsByClass: { OFFICIAL_DOCS: ["docs.example-project.org"] },
      baseQueries: ["mechanism"],
    });
    expect(confirmed.targetedQueries).toEqual(["site:docs.example-project.org mechanism"]);
  });

  it("6. governance requires a confirmed project-specific route", () => {
    const none = buildTargetedQueries({
      establishingClasses: ["GOVERNANCE"],
      baseQueries: ["proposal"],
    });
    expect(none.targetedQueries).toEqual([]);
    expect(none.unreachableClasses).toContain("GOVERNANCE");

    const confirmed = buildTargetedQueries({
      establishingClasses: ["GOVERNANCE"],
      confirmedRouteDomainsByClass: { GOVERNANCE: ["snapshot.org"] },
      baseQueries: ["proposal"],
    });
    expect(confirmed.targetedQueries).toEqual(["site:snapshot.org proposal"]);
  });

  it("7. multiple labels/identities resolving to one entity do not duplicate source strength", () => {
    const identity = parseProjectIdentity({
      chain: "solana",
      tokenAddress: EXAMPLE_SOLANA_MINT,
      ticker: "EXMPL",
    })!;
    const locators = explorerLocatorsForIdentity(identity);
    // Same address twice (e.g. two ACTIVE records agreeing) must not
    // produce the same locator twice.
    const deduped = [...new Set([...locators, ...locators])];
    expect(deduped).toEqual(locators);

    const { targetedQueries } = buildTargetedQueries({
      establishingClasses: ["ONCHAIN_VERIFIABLE", "ONCHAIN_VERIFIABLE"],
      onchainLocators: locators,
      baseQueries: ["supply"],
    });
    expect(new Set(targetedQueries).size).toBe(targetedQueries.length);
  });

  it("8. locator identity does not change evidence admissibility rules", () => {
    // Classification of a host is identical with and without any identity
    // in play — identity steers acquisition, it never reclassifies a source.
    const before = resolveSourceClass("https://tokenomics.com/x", "OTHER", null);
    const identity = parseProjectIdentity({ chain: "solana", tokenAddress: EXAMPLE_SOLANA_MINT })!;
    explorerLocatorsForIdentity(identity);
    expect(resolveSourceClass("https://tokenomics.com/x", "OTHER", null)).toBe(before);
    expect(before).toBe("SOCIAL");
    // A confirmed identity does not make a SOCIAL host admissible, and
    // does not make an unrelated mainnet explorer page belong to it.
    expect(resolveSourceClass("https://etherscan.io/token/0xdead", "OTHER", null)).toBe(
      "ONCHAIN_VERIFIABLE",
    );
  });

  it("9. no project-specific research conclusion is encoded in the identity module", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/server/domain/project-identity.ts", import.meta.url),
      "utf-8",
    );
    // The module may DESCRIBE the historical incident in comments, but it
    // must contain no project's actual address, ticker or domain as data.
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/0x[0-9a-fA-F]{40}/); // no contract address
    expect(code.toLowerCase()).not.toContain("pump");
    // And no research VERDICT vocabulary. (SUPPORTED_CHAINS is a chain
    // list, not a verdict, so the check targets the actual verdict tokens
    // rather than the bare substring.)
    for (const token of [
      "PARTIALLY_SUPPORTED",
      "NOT_SUPPORTED",
      "INSUFFICIENT_EVIDENCE",
      "buyback",
      "burn",
    ]) {
      expect(code, token).not.toContain(token);
    }
  });

  it("an identity without a token address yields no explorer locator", () => {
    const identity = parseProjectIdentity({ chain: "solana" });
    expect(identity).not.toBeNull();
    expect(identity!.tokenAddress).toBeNull();
    // Chain alone does not make a shared explorer safe to search by name.
    expect(explorerLocatorsForIdentity(identity!)).toEqual([]);
  });

  it("rejects malformed identity content rather than conferring partial identity", () => {
    expect(parseProjectIdentity(null)).toBeNull();
    expect(parseProjectIdentity({})).toBeNull();
    expect(parseProjectIdentity({ chain: "solana", tokenAddress: "" })).toBeNull();
    expect(parseProjectIdentity({ chain: "solana", extra: "x" })).toBeNull();
  });
});
