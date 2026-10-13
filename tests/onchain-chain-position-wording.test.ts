import { describe, expect, it } from "vitest";

import { ONCHAIN_DOES_NOT_PROVE, synthesizeOnchainFacts } from "../src/server/engine/onchain-facts";
import { TOTAL_SUPPLY_DELTA_DOES_NOT_PROVE } from "../src/server/engine/onchain-supply-delta";
import type { OnchainArtifact } from "../src/server/engine/providers/onchain-types";

// The chain's own word for its position: Solana counts slots, an EVM chain
// counts blocks. The sentence is written where the artifact — and so its
// chain — is already in hand; the static ceilings shared by both chains say
// neither.

function supplyArtifact(chain: "solana" | "ethereum"): OnchainArtifact {
  const result = { kind: "TOKEN_SUPPLY", mint: "MINT", amountRaw: "16000000000000000000000000", decimals: 18 };
  return {
    canonicalUri: `atlas-onchain://${chain}/mainnet/project/MINT/token/MINT/supply`,
    intent: {},
    result,
    provenance: { chain, network: "mainnet", slot: 26014030 },
    normalizedText: JSON.stringify(result),
  } as unknown as OnchainArtifact;
}

describe("chain position wording", () => {
  it("a supply reading on an EVM chain is observed at a block, on Solana at a slot", () => {
    const [evm] = synthesizeOnchainFacts(supplyArtifact("ethereum"), { step: 5, component: "CURRENT_STATE" });
    expect(evm.statement).toContain("as observed at block 26014030.");
    expect(evm.statement).not.toMatch(/\bslot\b/);
    const [sol] = synthesizeOnchainFacts(supplyArtifact("solana"), { step: 5, component: "CURRENT_STATE" });
    expect(sol.statement).toContain("as observed at slot 26014030.");
  });

  it("the ceilings an EVM reading carries name no chain-specific position", () => {
    for (const text of [ONCHAIN_DOES_NOT_PROVE.TOKEN_SUPPLY, ONCHAIN_DOES_NOT_PROVE.TOTAL_SUPPLY_DELTA, TOTAL_SUPPLY_DELTA_DOES_NOT_PROVE]) {
      expect(text).not.toMatch(/\bslots?\b/);
      expect(text).not.toMatch(/\bblocks?\b/);
    }
  });
});
