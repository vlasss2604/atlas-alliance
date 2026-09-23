import { describe, expect, it } from "vitest";

import { textSha256 } from "../src/server/engine/acquired-documents";
import { extractionUnitKey, normalizeForContainment, observationKey } from "../src/server/engine/extraction-unit-key";
import { normalizeHtmlToText } from "../src/server/engine/providers/content-fetcher";
import { isTraceable } from "../src/server/engine/s4-executor";

// D-076 TREATS A TYPOGRAPHIC QUOTE AS THE SAME QUOTE, AND NOTHING ELSE.
// ’ ‘ ≡ ' and “ ” ≡ " inside the traceability comparison only. The
// fragments are shaped like saved official pages whose relevant sentences
// were never admitted: lido.fi/how-lido-works/protocol-fee and
// pump.fun/docs/fees.

// The rule as it was before quotes were folded — the reference for
// "everything else is unchanged".
function previousIsTraceable(documentText: string, supportFragment: string): boolean {
  if (supportFragment.trim().length === 0) return false;
  return normalizeForContainment(documentText).includes(normalizeForContainment(supportFragment));
}

const LIDO_PROTOCOL_FEE = normalizeHtmlToText(
  `<main><p>This fee sustains the protocol’s operations, supports infrastructure, and funds ecosystem development.</p>
<p>The fee rate is set by the Lido DAO through on-chain governance, subject to alignment with the protocol’s needs and user interests.</p>
<p><strong>Consensus Layer rewards</strong>: Determined by network rules.</p></main>`,
);

const PUMP_FEES = normalizeHtmlToText(
  `<main><p>This is referred to as the “Creator fee” and is applicable for all coins that were present on the bonding curve or PumpSwap from the date of May 13th 2025.</p>
<p>The fee taken by the pump.fun platform is referred to as the “Protocol fee”.</p>
<p>A portion of the fees also goes back to the pool in the form of liquidity – this is referred to as the “LP fee”.</p>
<p>Users can claim rewards via the protocol‘s controller… see the ‘Rewards’ tab.</p></main>`,
);

describe("typographic quotes are the same quote in D-076", () => {
  it("protocol’s operations matches protocol's operations", () => {
    const fragment = "This fee sustains the protocol's operations, supports infrastructure, and funds ecosystem development.";
    expect(previousIsTraceable(LIDO_PROTOCOL_FEE, fragment)).toBe(false);
    expect(isTraceable(LIDO_PROTOCOL_FEE, fragment)).toBe(true);
    expect(isTraceable(LIDO_PROTOCOL_FEE, "subject to alignment with the protocol's needs and user interests")).toBe(true);
  });

  it("“Protocol fee” matches \"Protocol fee\"", () => {
    const fragment = 'The fee taken by the pump.fun platform is referred to as the "Protocol fee".';
    expect(previousIsTraceable(PUMP_FEES, fragment)).toBe(false);
    expect(isTraceable(PUMP_FEES, fragment)).toBe(true);
    expect(isTraceable(PUMP_FEES, 'This is referred to as the "Creator fee" and is applicable for all coins')).toBe(true);
  });

  it("‘ folds too, and the equivalence is symmetric: a curly fragment matches an ASCII page", () => {
    expect(isTraceable(PUMP_FEES, "via the protocol's controller")).toBe(true);
    expect(isTraceable(PUMP_FEES, "see the 'Rewards' tab")).toBe(true);
    expect(isTraceable("users' stake is buffered", "users’ stake is buffered")).toBe(true);
  });
});

describe("D-076 stays strict literal containment beyond the four quote characters", () => {
  it("genuinely different wording still fails", () => {
    expect(isTraceable(LIDO_PROTOCOL_FEE, "This fee sustains the protocols operations")).toBe(false);
    expect(isTraceable(LIDO_PROTOCOL_FEE, "The fee sustains the protocol's operations")).toBe(false);
    expect(isTraceable(LIDO_PROTOCOL_FEE, "Lido burns LDO with the protocol's fees")).toBe(false);
    expect(isTraceable(PUMP_FEES, 'referred to as the "Platform fee"')).toBe(false);
    expect(isTraceable(PUMP_FEES, "referred to as the Protocol fee")).toBe(false);
    expect(isTraceable(PUMP_FEES, "   ")).toBe(false);
  });

  it("a quote is one character, never a wildcard: ' does not match \" and neither matches nothing", () => {
    expect(isTraceable(PUMP_FEES, "referred to as the 'Protocol fee'")).toBe(false);
    expect(isTraceable(LIDO_PROTOCOL_FEE, 'the protocol"s operations')).toBe(false);
    expect(isTraceable(LIDO_PROTOCOL_FEE, "the protocols operations")).toBe(false);
  });

  it("no other punctuation is folded: dashes, ellipsis, guillemets, primes and backticks stay literal", () => {
    expect(isTraceable(PUMP_FEES, "in the form of liquidity - this is referred to")).toBe(false);
    expect(isTraceable(PUMP_FEES, "controller... see the")).toBe(false);
    expect(isTraceable("the «Protocol fee» applies", 'the "Protocol fee" applies')).toBe(false);
    expect(isTraceable("a 5′ window", "a 5' window")).toBe(false);
    expect(isTraceable("the `fee` field", "the 'fee' field")).toBe(false);
  });

  it("punctuation spacing and markdown are not normalized in this task", () => {
    expect(isTraceable(LIDO_PROTOCOL_FEE, "Consensus Layer rewards : Determined by network rules.")).toBe(true);
    expect(isTraceable(LIDO_PROTOCOL_FEE, "Consensus Layer rewards: Determined by network rules.")).toBe(false);
    expect(isTraceable("see [Lido V3](https://lido.fi/v3) for details", "see Lido V3 for details")).toBe(false);
  });

  it("every pair without a typographic quote gets exactly the previous answer", () => {
    const docs = [LIDO_PROTOCOL_FEE, PUMP_FEES, "Users' stake & \"shares\" — 32 ETH… «x»", "  Mixed   CASE text\nwith  newlines "];
    const fragments = [
      "users' stake",
      '"shares"',
      "mixed case TEXT with newlines",
      "32 ETH…",
      "Determined by network rules.",
      "funds ecosystem development",
      "does not appear anywhere",
      "rewards : determined",
      "«x»",
      "",
    ];
    for (const d of docs) {
      for (const f of fragments) {
        const touchesQuote = /[‘’“”]/.test(d) && /['"]/.test(f);
        if (touchesQuote) continue;
        expect(isTraceable(d, f), `${JSON.stringify(f)} in ${JSON.stringify(d.slice(0, 30))}`).toBe(previousIsTraceable(d, f));
      }
    }
  });
});

describe("stored text, hashes and Memory keys are untouched", () => {
  it("normalized document text keeps the typographic quotes the page wrote, so its hash is unchanged", () => {
    expect(LIDO_PROTOCOL_FEE).toContain("protocol’s operations");
    expect(PUMP_FEES).toContain("“Protocol fee”");
    expect(textSha256(normalizeHtmlToText("<p>the protocol’s “fee”</p>"))).toBe(textSha256("the protocol’s “fee”"));
  });

  it("the containment normalizer used by the keys does not fold quotes", () => {
    expect(normalizeForContainment("Protocol’s “Fee”")).toBe("protocol’s “fee”");
  });

  it("extraction-unit and observation keys still distinguish a curly fragment from an ASCII one", () => {
    const curly = "the protocol’s operations";
    const ascii = "the protocol's operations";
    expect(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", curly)).not.toBe(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", ascii));
    expect(observationKey("src", 1, "SOURCE_OF_VALUE", curly)).not.toBe(observationKey("src", 1, "SOURCE_OF_VALUE", ascii));
    expect(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", ascii)).toBe(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", "The Protocol's   operations"));
  });
});
