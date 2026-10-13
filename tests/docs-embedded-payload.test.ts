import { describe, expect, it } from "vitest";

import { docsPayloadRecoveryEligible } from "../src/server/engine/docs-payload-eligibility";
import {
  extractEmbeddedPayloadText,
  mergeDocumentText,
} from "../src/server/engine/providers/embedded-payload";
import type { ResolvedSourceRoute } from "../src/server/engine/source-authority";

// STAGE 0 — embedded structured-payload recovery for confirmed
// OFFICIAL_DOCS pages. Entirely offline: every fixture below is a string.
//
// The defect this closes, in one line: a confirmed docs page returned
// 1,477,632 bytes of HTML and 134 characters of text, because
// normalizeHtmlToText strips <script> contents and the page's actual prose
// lived inside them.
//
// Nothing here is project-specific. The fixtures use invented product
// names and invented addresses.

const ADDRESS = "Vau1tAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function shell(scripts: string): string {
  // The exact shape observed live: heavy HTML, nav chrome, no prose.
  return `<!doctype html><html><head><title>Docs</title></head><body>
    <nav>Home Explore Support Terminal</nav>
    ${scripts}
  </body></html>`;
}

describe("__NEXT_DATA__ recovery", () => {
  it("recovers useful prose from a __NEXT_DATA__ payload", () => {
    const html = shell(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          sections: [
            { heading: "Fee distribution", body: "Protocol fees accrue to the treasury vault." },
            { heading: "Vault", body: `The treasury vault address is ${ADDRESS}.` },
          ],
        },
      },
    })}</script>`);

    const out = extractEmbeddedPayloadText(html);
    expect(out.kinds).toContain("NEXT_DATA");
    expect(out.text).toContain("Protocol fees accrue to the treasury vault.");
    expect(out.text).toContain(ADDRESS);
    expect(out.recoveredStrings).toBeGreaterThan(0);
  });

  it("a short but meaningful value such as an address is not filtered away", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ vault: ADDRESS })}</script>`,
    );
    expect(extractEmbeddedPayloadText(html).text).toContain(ADDRESS);
  });
});

describe("JSON-LD recovery", () => {
  it("recovers text from a JSON-LD block", () => {
    const html = shell(`<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: "Buyback mechanics",
      articleBody: "Revenue is used to repurchase tokens which are then burned.",
    })}</script>`);
    const out = extractEmbeddedPayloadText(html);
    expect(out.kinds).toContain("JSON_LD");
    expect(out.text).toContain("Revenue is used to repurchase tokens which are then burned.");
  });

  it("an array of JSON-LD objects is handled", () => {
    const html = shell(`<script type="application/ld+json">${JSON.stringify([
      { "@type": "FAQPage", name: "Where do fees go?" },
      { "@type": "Answer", text: "Fees are routed to the protocol vault." },
    ])}</script>`);
    expect(extractEmbeddedPayloadText(html).text).toContain("Fees are routed to the protocol vault.");
  });
});

describe("RSC / flight payload recovery", () => {
  it("recovers text from self.__next_f.push chunks without executing them", () => {
    const inner = JSON.stringify({ heading: "Treasury", body: "Fees settle into the vault daily." });
    const html = shell(
      `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`,
    );
    const out = extractEmbeddedPayloadText(html);
    expect(out.kinds).toContain("RSC_FLIGHT");
    expect(out.text).toContain("Fees settle into the vault daily.");
  });

  it("a flight chunk carrying a plain string is still recovered", () => {
    const html = shell(
      `<script>self.__next_f.push([1,"The vault is controlled by the protocol multisig."])</script>`,
    );
    expect(extractEmbeddedPayloadText(html).text).toContain(
      "The vault is controlled by the protocol multisig.",
    );
  });

  it("multiple pushes in one script are all recovered", () => {
    const html = shell(
      `<script>self.__next_f.push([1,"First documented rule."]);self.__next_f.push([1,"Second documented rule."])</script>`,
    );
    const text = extractEmbeddedPayloadText(html).text;
    expect(text).toContain("First documented rule.");
    expect(text).toContain("Second documented rule.");
  });
});

describe("safety — parse only, never execute", () => {
  it("this module contains no JavaScript execution primitive", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/embedded-payload.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const banned of ["eval(", "new Function", "vm.", "require(", "import(", "child_process"]) {
      expect(code, `embedded-payload.ts contains "${banned}"`).not.toContain(banned);
    }
    // JSON.parse is the ONLY parsing primitive used.
    expect(code).toContain("JSON.parse");
  });

  it("script content that is executable JavaScript is ignored, not interpreted", () => {
    // A plain script with no recognized structured-data container. Its
    // strings must NOT be scraped, and it must certainly not run.
    const html = shell(
      `<script>window.SECRET_MARKER = "should-never-be-recovered"; fetch("https://evil.test");</script>`,
    );
    const out = extractEmbeddedPayloadText(html);
    expect(out.text).toBe("");
    expect(out.kinds).toEqual([]);
    expect((globalThis as Record<string, unknown>).SECRET_MARKER).toBeUndefined();
  });

  it("an UNRECOGNISED script is ignored even when its body is valid JSON", () => {
    // Sharper than the test above: a JS script body is rejected anyway
    // because it is not valid JSON, so that case cannot prove the
    // container check exists. This one can — the body parses perfectly,
    // and must still be ignored because <script> with no recognised
    // type/id is not a structured-data container. Without the container
    // check, arbitrary inline script state would be scraped as "evidence".
    const html = shell(
      `<script>${JSON.stringify({ leaked: "must-not-be-recovered" })}</script>`,
    );
    const out = extractEmbeddedPayloadText(html);
    expect(out.text).toBe("");
    expect(out.kinds).toEqual([]);
  });

  it("a malformed JSON payload is ignored safely, not partially salvaged", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">{"broken": [1,2,</script>`,
    );
    const out = extractEmbeddedPayloadText(html);
    expect(out.text).toBe("");
    expect(out.kinds).toEqual([]);
  });

  it("one malformed payload does not prevent a valid sibling from being recovered", () => {
    const html = shell(
      `<script type="application/ld+json">{oops</script>` +
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ a: "Valid recovered sentence." })}</script>`,
    );
    const out = extractEmbeddedPayloadText(html);
    expect(out.text).toContain("Valid recovered sentence.");
    expect(out.kinds).toEqual(["NEXT_DATA"]);
  });

  it("a payload containing JavaScript source is treated as inert text", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        snippet: "eval('1+1'); new Function('return 2')();",
      })}</script>`,
    );
    // Recovered as a STRING. Nothing runs.
    expect(extractEmbeddedPayloadText(html).text).toContain("eval('1+1')");
  });
});

describe("bounds and determinism", () => {
  it("oversized HTML is skipped entirely", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ a: "hello there" })}</script>`,
    );
    expect(extractEmbeddedPayloadText(html, { maxHtmlBytes: 10 })).toMatchObject({ text: "" });
  });

  it("an oversized single payload is skipped", () => {
    const big = JSON.stringify({ a: "x".repeat(5000) });
    const html = shell(`<script id="__NEXT_DATA__" type="application/json">${big}</script>`);
    expect(extractEmbeddedPayloadText(html, { maxPayloadBytes: 100 }).text).toBe("");
  });

  it("recovered text is capped and reports truncation", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        a: "alpha ".repeat(200),
        b: "beta ".repeat(200),
      })}</script>`,
    );
    const out = extractEmbeddedPayloadText(html, { maxTextLength: 50 });
    expect(out.text.length).toBe(50);
    expect(out.truncated).toBe(true);
  });

  it("duplicate strings are deduplicated", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        a: "Repeated sentence.",
        b: "Repeated sentence.",
        c: { d: "Repeated sentence." },
      })}</script>`,
    );
    const out = extractEmbeddedPayloadText(html);
    expect(out.text.split("Repeated sentence.").length - 1).toBe(1);
    expect(out.recoveredStrings).toBe(1);
  });

  it("output is byte-stable for identical input", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        z: "last", a: "first", m: { n: "nested" },
      })}</script>`,
    );
    expect(extractEmbeddedPayloadText(html).text).toBe(extractEmbeddedPayloadText(html).text);
  });

  it("asset noise is dropped without touching prose", () => {
    const html = shell(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        js: "/_next/static/chunks/main-abc.js",
        css: "https://cdn.test/app.css",
        img: "data:image/png;base64,AAAA",
        prose: "Real documentation sentence.",
      })}</script>`,
    );
    const text = extractEmbeddedPayloadText(html).text;
    expect(text).toContain("Real documentation sentence.");
    expect(text).not.toContain("/_next/static");
    expect(text).not.toContain("app.css");
    expect(text).not.toContain("data:image");
  });

  it("a page with no embedded payloads recovers nothing", () => {
    expect(extractEmbeddedPayloadText(shell("<p>Ordinary visible text.</p>"))).toMatchObject({
      text: "",
      kinds: [],
    });
  });
});

describe("merge with static text", () => {
  it("static text stays first and recovered text is appended", () => {
    const merged = mergeDocumentText("Visible heading", {
      text: "Recovered body",
      kinds: ["NEXT_DATA"],
      recoveredStrings: 1,
      truncated: false,
    });
    expect(merged.indexOf("Visible heading")).toBeLessThan(merged.indexOf("Recovered body"));
  });

  it("recovered text already visible statically is not duplicated", () => {
    const merged = mergeDocumentText("Fees accrue to the vault.", {
      text: "Fees accrue to the vault.\nNew detail only in payload.",
      kinds: ["NEXT_DATA"],
      recoveredStrings: 2,
      truncated: false,
    });
    expect(merged.split("Fees accrue to the vault.").length - 1).toBe(1);
    expect(merged).toContain("New detail only in payload.");
  });

  it("an empty recovery leaves the static text exactly unchanged", () => {
    const original = "Ordinary page text.";
    expect(
      mergeDocumentText(original, { text: "", kinds: [], recoveredStrings: 0, truncated: false }),
    ).toBe(original);
  });
});

describe("eligibility — confirmed OFFICIAL_DOCS with a matched pathPrefix only", () => {
  const route = (over: Partial<ResolvedSourceRoute> = {}): ResolvedSourceRoute => ({
    officiality: "CONFIRMED",
    routeClass: "OFFICIAL_DOCS",
    observation: null,
    matchedPathPrefix: "/docs",
    ...over,
  });

  it("a confirmed, path-scoped OFFICIAL_DOCS route is eligible", () => {
    expect(docsPayloadRecoveryEligible(route())).toBe(true);
  });

  it("an ordinary search result (CLAIMED, no class) is NOT eligible", () => {
    expect(
      docsPayloadRecoveryEligible({
        officiality: "CLAIMED",
        routeClass: null,
        observation: null,
        matchedPathPrefix: null,
      }),
    ).toBe(false);
  });

  it("a confirmed domain with NO pathPrefix is NOT eligible", () => {
    // D-135's whole point: owning the domain is not the same claim as
    // "this specific path is documentation".
    expect(docsPayloadRecoveryEligible(route({ matchedPathPrefix: null }))).toBe(false);
  });

  it("a confirmed docs route does not extend to a path outside the prefix", () => {
    // resolveSourceRoute yields no routeClass off-prefix, which is what
    // makes the page ineligible.
    expect(docsPayloadRecoveryEligible(route({ routeClass: null, matchedPathPrefix: null }))).toBe(
      false,
    );
  });

  it("a confirmed GOVERNANCE route is NOT eligible in Stage 0", () => {
    expect(docsPayloadRecoveryEligible(route({ routeClass: "GOVERNANCE" }))).toBe(false);
  });

  it("a route-class conflict is NOT eligible", () => {
    expect(
      docsPayloadRecoveryEligible(
        route({ routeClass: null, observation: "SOURCE_ROUTE_CONFLICT", matchedPathPrefix: null }),
      ),
    ).toBe(false);
  });
});

describe("generalization", () => {
  it("no project-specific literal appears in the Stage 0 modules", async () => {
    const fs = await import("node:fs/promises");
    for (const path of [
      "../src/server/engine/providers/embedded-payload.ts",
      "../src/server/engine/docs-payload-eligibility.ts",
    ]) {
      const raw = await fs.readFile(new URL(path, import.meta.url), "utf-8");
      const lower = raw.toLowerCase();
      for (const banned of ["pump", "solana", "buyback", "solscan", "etherscan"]) {
        expect(lower, `${path} contains "${banned}"`).not.toContain(banned);
      }
    }
  });
});
