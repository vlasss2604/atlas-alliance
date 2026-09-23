import { describe, expect, it } from "vitest";

import { textSha256 } from "../src/server/engine/acquired-documents";
import { extractionUnitKey, observationKey } from "../src/server/engine/extraction-unit-key";
import { normalizeHtmlToText } from "../src/server/engine/providers/content-fetcher";
import { isTraceable } from "../src/server/engine/s4-executor";

// THE EXTRACTOR AND THE D-076 TRACEABILITY CHECK OPERATE ON THE SAME
// HUMAN-READABLE NORMALIZED SOURCE TEXT. HTML character references are
// decoded when the text is built; D-076 itself stays strict literal
// containment. The fragments are shaped like the saved Lido documents that
// lost valid excerpts to undecoded entities (docs.lido.fi/contracts/lido/).

// The normalizer as it was before entities were decoded — the reference
// for "clean text is unchanged".
function previousNormalizer(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LIDO_CORE = `<main><h1>Lido</h1><p>Lido is a liquid staking pool and the core contract that is responsible for: accepting users&#x27; stake, buffering it and minting respective amounts of liquid token (stETH) for the users.</p>
<p>The rebasing mechanism is implemented via the &quot;shares&quot; concept.</p>
<p>General protocol stats &amp; metrics</p>
<p>If totalPooledEther &gt; 0 then shares &lt; balance.</p></main>`;

describe("HTML character references in normalizedText", () => {
  const text = normalizeHtmlToText(LIDO_CORE);

  it("decodes &#x27;, &quot;, &amp;, &gt; and &lt; to the characters a reader sees", () => {
    expect(text).toContain("accepting users' stake");
    expect(text).toContain('via the "shares" concept');
    expect(text).toContain("stats & metrics");
    expect(text).toContain("totalPooledEther > 0 then shares < balance");
    expect(text).not.toMatch(/&(#x27|quot|amp|gt|lt);/);
  });

  it("decodes numeric references in both forms, and &nbsp; still becomes a space", () => {
    expect(normalizeHtmlToText("<p>users&#39; stake&#x27;s&nbsp;share&#160;here</p>")).toBe("users' stake's share here");
  });

  it("decodes exactly once, after tags are removed: an escaped tag is text, and a double-escaped entity stays an entity", () => {
    expect(normalizeHtmlToText("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe("<script>alert(1)</script>");
    expect(normalizeHtmlToText("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
  });

  it("leaves typographic characters and unknown named references exactly as the page wrote them (not this task)", () => {
    expect(normalizeHtmlToText("<p>Ethereum’s proof-of-stake</p>")).toBe("Ethereum’s proof-of-stake");
    expect(normalizeHtmlToText("<p>&copy; Lido &rarr; docs</p>")).toBe("&copy; Lido &rarr; docs");
  });
});

describe("D-076 on the decoded text — strict literal containment, unchanged", () => {
  const text = normalizeHtmlToText(LIDO_CORE);

  it("accepts the valid literal excerpt a reader would quote", () => {
    expect(isTraceable(text, "the core contract that is responsible for: accepting users' stake, buffering it and minting respective amounts of liquid token")).toBe(true);
    expect(isTraceable(text, 'The rebasing mechanism is implemented via the "shares" concept.')).toBe(true);
  });

  it("the same excerpt was rejected against the previous, undecoded text", () => {
    const before = previousNormalizer(LIDO_CORE);
    expect(isTraceable(before, "accepting users' stake, buffering it")).toBe(false);
    expect(isTraceable(before, 'via the "shares" concept')).toBe(false);
  });

  it("still rejects text genuinely absent from the source, and a paraphrase", () => {
    expect(isTraceable(text, "Lido burns LDO with protocol fees")).toBe(false);
    expect(isTraceable(text, "accepting user stake and buffering it")).toBe(false);
    expect(isTraceable(text, "   ")).toBe(false);
  });
});

describe("clean text and identities are unchanged; only entity-affected documents get new ones", () => {
  const CLEAN = `<main><h1>Rewards</h1><p>For blocks proposed by Lido validators, MEV rewards are sent by builders to the Lido Execution Rewards Vault.</p><script>var x = "&amp;";</script></main>`;

  it("a document with no character references normalizes byte-for-byte as before", () => {
    expect(normalizeHtmlToText(CLEAN)).toBe(previousNormalizer(CLEAN));
    expect(textSha256(normalizeHtmlToText(CLEAN))).toBe(textSha256(previousNormalizer(CLEAN)));
  });

  it("an entity-affected document gets a new text hash", () => {
    expect(textSha256(normalizeHtmlToText(LIDO_CORE))).not.toBe(textSha256(previousNormalizer(LIDO_CORE)));
  });

  it("a clean passage keeps its extraction-unit and observation keys; a passage that only ever matched the raw form gets a different one, so the two are never merged", () => {
    const clean = "MEV rewards are sent by builders to the Lido Execution Rewards Vault.";
    expect(extractionUnitKey("job", "src", 6, "DESTINATION", clean)).toBe(extractionUnitKey("job", "src", 6, "DESTINATION", clean));
    const decoded = "accepting users' stake";
    const raw = "accepting users&#x27; stake";
    expect(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", decoded)).not.toBe(extractionUnitKey("job", "src", 1, "SOURCE_OF_VALUE", raw));
    expect(observationKey("src", 1, "SOURCE_OF_VALUE", decoded)).not.toBe(observationKey("src", 1, "SOURCE_OF_VALUE", raw));
  });
});
