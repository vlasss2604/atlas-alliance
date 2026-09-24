import { describe, expect, it } from "vitest";

import { textSha256 } from "../src/server/engine/acquired-documents";
import { extractionUnitKey, normalizeForContainment, observationKey } from "../src/server/engine/extraction-unit-key";
import { normalizeHtmlToText } from "../src/server/engine/providers/content-fetcher";
import { isTraceable } from "../src/server/engine/s4-executor";

// D-076 IGNORES THE SPACE OUR HTML NORMALIZER PUTS NEXT TO PUNCTUATION.
// Inside the traceability comparison only: one space before , . ; : ! ? )
// and one space after ( are dropped on both sides. The fixtures are shaped
// like saved official pages (lido.fi/how-lido-works/rewards-and-penalties,
// docs.lido.fi/lido-dao/, aave.com/docs/aave-v3/concepts/incentives,
// pump.fun/docs/fees) and go through the real normalizer, so the spaces
// are the ones it actually inserts.

// The rule as it was before punctuation spacing was folded (quotes already
// folded) — the reference for "everything else is unchanged".
function quotesOnlyTraceable(documentText: string, supportFragment: string): boolean {
  if (supportFragment.trim().length === 0) return false;
  const q = (s: string) => normalizeForContainment(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  return q(documentText).includes(q(supportFragment));
}

const LIDO_REWARDS = normalizeHtmlToText(
  `<main><p>Validator rewards come in two forms:</p><ul><li><strong>Consensus Layer rewards</strong>: Determined by network rules, these include block proposal and attestation rewards.</li>
<li><strong>AccountingOracle</strong>: Handles updates to the protocol’s accounting balances, including rewards, penalties, withdrawal finalization, and historical data.</li></ul></main>`,
);

const LIDO_DAO = normalizeHtmlToText(
  `<main><p>The Lido DAO is a Decentralized Autonomous Organization. The decision-making process is handled by the voting power of governance token (<code>LDO</code>) holders.</p></main>`,
);

const AAVE_INCENTIVES = normalizeHtmlToText(
  `<main><p>AAVE holders can stake their tokens in the <a href="/safety-module">Safety Module</a>, a reserve designed to secure the protocol against unexpected shortfalls.</p>
<p>The reserve factor is <span>3</span>.5 percent of interest, set by <em>governance</em>!</p></main>`,
);

const PUMP_FEES = normalizeHtmlToText(
  `<main><p>Welcome to <b>Pump</b>.<b>fun</b>! The fee taken by the platform is referred to as the “Protocol fee”. A <b>“Creator fee”</b> also applies, and the “<b>LP fee</b>” too.</p></main>`,
);

describe("the spacing our normalizer inserts is not part of the excerpt", () => {
  it("the fixtures really carry the inserted spaces", () => {
    expect(LIDO_REWARDS).toContain("Consensus Layer rewards : Determined");
    expect(LIDO_DAO).toContain("governance token ( LDO ) holders");
    expect(AAVE_INCENTIVES).toContain("Safety Module , a reserve");
    expect(AAVE_INCENTIVES).toContain("3 .5 percent");
  });

  it("rewards : Determined matches rewards: Determined", () => {
    const fragment = "Consensus Layer rewards: Determined by network rules, these include block proposal and attestation rewards.";
    expect(quotesOnlyTraceable(LIDO_REWARDS, fragment)).toBe(false);
    expect(isTraceable(LIDO_REWARDS, fragment)).toBe(true);
  });

  it("( LDO ) matches (LDO)", () => {
    const fragment = "the voting power of governance token (LDO) holders";
    expect(quotesOnlyTraceable(LIDO_DAO, fragment)).toBe(false);
    expect(isTraceable(LIDO_DAO, fragment)).toBe(true);
  });

  it("3 .5 matches 3.5, and every approved character folds: , . ; : ! ? ) and (", () => {
    expect(isTraceable(AAVE_INCENTIVES, "The reserve factor is 3.5 percent of interest, set by governance!")).toBe(true);
    expect(isTraceable(AAVE_INCENTIVES, "stake their tokens in the Safety Module, a reserve designed")).toBe(true);
    expect(isTraceable("a ; b", "a; b")).toBe(true);
    expect(isTraceable("really ?", "really?")).toBe(true);
    expect(isTraceable("( x )", "(x)")).toBe(true);
  });

  it("the fold is symmetric: the fragment may carry the inserted space too", () => {
    expect(isTraceable(LIDO_REWARDS, "Consensus Layer rewards : Determined by network rules")).toBe(true);
    expect(isTraceable("rewards: Determined", "rewards : Determined")).toBe(true);
  });

  it("quote folding still holds, together with spacing", () => {
    expect(isTraceable(LIDO_REWARDS, "AccountingOracle: Handles updates to the protocol's accounting balances")).toBe(true);
    expect(isTraceable(PUMP_FEES, 'is referred to as the "Protocol fee".')).toBe(true);
    expect(isTraceable(PUMP_FEES, "is referred to as the 'Protocol fee'.")).toBe(false);
    expect(isTraceable(PUMP_FEES, 'A "Creator fee" also applies')).toBe(true);
  });

  it("a space inserted INSIDE quotes is not folded: quotes are not in the approved list", () => {
    expect(PUMP_FEES).toContain("the “ LP fee ” too");
    expect(isTraceable(PUMP_FEES, 'and the "LP fee" too')).toBe(false);
  });
});

describe("D-076 stays strict literal containment beyond these spacing equivalences", () => {
  it("changed wording still fails", () => {
    expect(isTraceable(LIDO_REWARDS, "Consensus Layer rewards: Decided by network rules")).toBe(false);
    expect(isTraceable(LIDO_DAO, "the voting power of governance token (LIDO) holders")).toBe(false);
    expect(isTraceable(AAVE_INCENTIVES, "The reserve factor is 3.6 percent of interest")).toBe(false);
  });

  it("removed or added words still fail", () => {
    expect(isTraceable(LIDO_REWARDS, "Consensus Layer rewards: Determined by rules")).toBe(false);
    expect(isTraceable(LIDO_REWARDS, "Consensus Layer rewards: Determined by the network rules")).toBe(false);
    expect(isTraceable(LIDO_DAO, "governance token holders")).toBe(false);
    expect(isTraceable(LIDO_DAO, "governance token (LDO)")).toBe(true);
    expect(isTraceable(LIDO_DAO, "governance token (LDO) token holders")).toBe(false);
  });

  it("a space after a period or comma is never dropped", () => {
    expect(isTraceable(PUMP_FEES, "Welcome to Pump. fun!")).toBe(true);
    expect(isTraceable(PUMP_FEES, "Welcome to Pump.fun!")).toBe(false);
    expect(isTraceable(AAVE_INCENTIVES, "Safety Module,a reserve")).toBe(false);
    expect(isTraceable("one. Two", "one.Two")).toBe(false);
  });

  it("no other whitespace folds: before ( , after ), around dashes, slashes and other symbols", () => {
    expect(isTraceable("token (LDO)", "token(LDO)")).toBe(false);
    expect(isTraceable("(LDO) holders", "(LDO)holders")).toBe(false);
    expect(isTraceable("a - b", "a-b")).toBe(false);
    expect(isTraceable("a – b", "a–b")).toBe(false);
    expect(isTraceable("a / b", "a/b")).toBe(false);
    expect(isTraceable("list ] end", "list] end")).toBe(false);
    expect(isTraceable("ab", "a b")).toBe(false);
    expect(isTraceable("a b", "ab")).toBe(false);
  });

  it("punctuation itself is never dropped or swapped", () => {
    expect(isTraceable(LIDO_REWARDS, "Consensus Layer rewards Determined by network rules")).toBe(false);
    expect(isTraceable(LIDO_REWARDS, "Consensus Layer rewards; Determined by network rules")).toBe(false);
    expect(isTraceable(LIDO_DAO, "governance token LDO holders")).toBe(false);
    expect(isTraceable(AAVE_INCENTIVES, "is 35 percent")).toBe(false);
  });

  it("markdown is not normalized, and an empty fragment is still refused", () => {
    expect(isTraceable("see [Lido V3](https://lido.fi/v3) for details", "see Lido V3 for details")).toBe(false);
    expect(isTraceable(LIDO_REWARDS, "   ")).toBe(false);
  });

  it("every pair with no space next to the approved punctuation gets exactly the previous answer", () => {
    const docs = [
      "MEV rewards are sent by builders to the Lido Execution Rewards Vault.",
      "Users' stake & \"shares\" — 32 ETH… «x» (clean)",
      "  Mixed   CASE text\nwith  newlines ",
      normalizeHtmlToText("<p>Rewards, penalties: and fees (all of them).</p>"),
    ];
    const fragments = [
      "MEV rewards are sent by builders",
      "the Lido Execution Rewards Vault.",
      "users' stake",
      '"shares"',
      "mixed case TEXT with newlines",
      "32 ETH…",
      "(clean)",
      "rewards, penalties: and fees (all of them).",
      "does not appear anywhere",
      "",
    ];
    const spaced = /\s[,.;:!?)]|\(\s/;
    for (const d of docs) {
      expect(spaced.test(d), d).toBe(false);
      for (const f of fragments) {
        if (spaced.test(f)) continue;
        expect(isTraceable(d, f), `${JSON.stringify(f)} in ${JSON.stringify(d.slice(0, 30))}`).toBe(quotesOnlyTraceable(d, f));
      }
    }
  });
});

describe("stored text, hashes and Memory keys are untouched", () => {
  it("normalized document text keeps the inserted spaces, so its hash is unchanged", () => {
    const html = "<p><strong>rewards</strong>: Determined (<code>LDO</code>)</p>";
    expect(normalizeHtmlToText(html)).toBe("rewards : Determined ( LDO )");
    expect(textSha256(normalizeHtmlToText(html))).toBe(textSha256("rewards : Determined ( LDO )"));
  });

  it("the containment normalizer used by the keys does not fold punctuation spacing", () => {
    expect(normalizeForContainment("Rewards : Determined ( LDO )")).toBe("rewards : determined ( ldo )");
  });

  it("extraction-unit and observation keys still distinguish the spaced and unspaced fragment", () => {
    const spaced = "rewards : Determined ( LDO )";
    const tight = "rewards: Determined (LDO)";
    expect(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", spaced)).not.toBe(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", tight));
    expect(observationKey("src", 1, "SOURCE_OF_VALUE", spaced)).not.toBe(observationKey("src", 1, "SOURCE_OF_VALUE", tight));
    expect(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", tight)).toBe(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", "Rewards:   Determined (LDO)"));
  });
});
