import { describe, expect, it } from "vitest";

import {
  extractDocumentLinks,
  signatureLinks,
} from "../src/server/engine/providers/document-links";

// Machine-readable identifiers recoverable from a RENDERED document.
//
// The motivating case: a rendered burn table reads as
// "Aug 23, 2026 | 160.1M | $842.6K" in plain text, while the DOM behind it
// may carry a transaction link per row. Plain-text conversion throws that
// away, so a locator could be sitting in a page we already rendered.
//
// Fixtures are synthetic: invented hosts, invented base58 strings. Nothing
// here is project-specific.

const SIG = "5".repeat(87); // signature-shaped (64-88 base58 chars)
const ADDR = "Vau1t" + "A".repeat(38); // address-shaped (32-44)

function rows(inner: string): string {
  return `<html><body><table><tbody>${inner}</tbody></table></body></html>`;
}

describe("anchor and identifier extraction", () => {
  it("recovers a per-row transaction link from a burn-style table", () => {
    const html = rows(
      `<tr><td>Aug 23, 2026</td><td>160.1M</td>` +
        `<td><a href="https://explorer.invalid/tx/${SIG}">view</a></td></tr>`,
    );
    const out = extractDocumentLinks(html);
    expect(out.links).toHaveLength(1);
    expect(out.links[0].href).toContain(SIG);
    expect(out.links[0].text).toBe("view");
    expect(out.links[0].host).toBe("explorer.invalid");
    expect(out.identifiers.some((i) => i.value === SIG && i.shape === "SIGNATURE_LIKE")).toBe(true);
    expect(signatureLinks(out)).toHaveLength(1);
  });

  it("distinguishes signature-shaped from address-shaped values", () => {
    const html = `<a href="https://x.invalid/tx/${SIG}">t</a><a href="https://x.invalid/account/${ADDR}">a</a>`;
    const out = extractDocumentLinks(html);
    const shapes = Object.fromEntries(out.identifiers.map((i) => [i.value, i.shape]));
    expect(shapes[SIG]).toBe("SIGNATURE_LIKE");
    expect(shapes[ADDR]).toBe("ADDRESS_LIKE");
  });

  it("recovers identifiers from query parameters, not just path segments", () => {
    const out = extractDocumentLinks(`<a href="https://x.invalid/tx?sig=${SIG}">t</a>`);
    expect(out.identifiers.some((i) => i.value === SIG)).toBe(true);
  });

  it("recovers identifiers from data-* attributes", () => {
    const out = extractDocumentLinks(`<tr data-signature="${SIG}" data-mint="${ADDR}"><td>x</td></tr>`);
    const byAttr = Object.fromEntries(out.identifiers.map((i) => [i.attribute, i.value]));
    expect(byAttr["data-signature"]).toBe(SIG);
    expect(byAttr["data-mint"]).toBe(ADDR);
  });

  it("reports the attribute VALUE's shape, never trusting the attribute NAME", () => {
    // An attribute called data-signature holding a non-identifier is not
    // reported; the shape of the value is the only signal.
    const out = extractDocumentLinks(`<tr data-signature="not-an-identifier"></tr>`);
    expect(out.identifiers).toEqual([]);
  });

  it("collects the distinct hosts a page points at", () => {
    const out = extractDocumentLinks(
      `<a href="https://a.invalid/x">1</a><a href="https://b.invalid/y">2</a><a href="/rel">3</a>`,
    );
    expect(out.hosts).toEqual(["a.invalid", "b.invalid"]);
    expect(out.links.find((l) => l.href === "/rel")?.host).toBeNull();
  });

  it("deduplicates repeated links and identifiers", () => {
    const a = `<a href="https://x.invalid/tx/${SIG}">v</a>`;
    const out = extractDocumentLinks(a + a + a);
    expect(out.links).toHaveLength(1);
    expect(out.identifiers.filter((i) => i.value === SIG)).toHaveLength(1);
  });

  it("ignores javascript: hrefs", () => {
    const out = extractDocumentLinks(`<a href="javascript:alert(1)">x</a>`);
    expect(out.links).toEqual([]);
  });

  it("decodes HTML entities in hrefs so query identifiers survive", () => {
    const out = extractDocumentLinks(`<a href="https://x.invalid/t?a=1&amp;sig=${SIG}">v</a>`);
    expect(out.identifiers.some((i) => i.value === SIG)).toBe(true);
  });

  it("a page with no links yields nothing rather than guessing", () => {
    expect(extractDocumentLinks("<p>Aug 23, 2026 160.1M $842.6K</p>")).toMatchObject({
      links: [],
      identifiers: [],
    });
  });

  it("output is bounded and byte-stable", () => {
    const many = Array.from(
      { length: 900 },
      (_, i) => `<a href="https://x.invalid/p/${i}">l${i}</a>`,
    ).join("");
    const out = extractDocumentLinks(many);
    expect(out.links.length).toBeLessThanOrEqual(500);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(extractDocumentLinks(many))).toBe(JSON.stringify(out));
  });

  it("oversized html is skipped entirely", () => {
    expect(extractDocumentLinks("x".repeat(8_000_001))).toMatchObject({ links: [] });
  });
});

describe("safety — observations only, no page interaction", () => {
  it("parses a STRING and performs no page action of any kind", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/document-links.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const banned of [
      "page.", "click", "evaluate", "goto", "addScriptTag", "waitFor",
      "playwright", "fetch(", "eval(", "new Function",
    ]) {
      expect(code, `document-links contains "${banned}"`).not.toContain(banned);
    }
  });

  it("confers no trust: no class, officiality or binding field exists", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/document-links.ts", import.meta.url),
      "utf-8",
    );
    // The result type has no field capable of expressing approval.
    const out = extractDocumentLinks(`<a href="https://x.invalid/tx/${SIG}">v</a>`);
    for (const forbidden of ["sourceClass", "officiality", "entityBinding", "confirmed", "trusted"]) {
      expect(JSON.stringify(out)).not.toContain(forbidden);
    }
    expect(raw).not.toContain("ONCHAIN_VERIFIABLE");
  });

  it("a signature-shaped value is a SHAPE claim, not a chain or identity claim", () => {
    // Same shape, unrelated host — the module says nothing about whether
    // this belongs to any project or chain. D-134 remains the only
    // authority on that.
    const out = extractDocumentLinks(`<a href="https://unrelated.invalid/tx/${SIG}">v</a>`);
    expect(out.identifiers[0].shape).toBe("SIGNATURE_LIKE");
    expect(JSON.stringify(out)).not.toContain("solana");
  });

  it("no project-specific literal appears in the module", async () => {
    const fs = await import("node:fs/promises");
    const raw = (
      await fs.readFile(
        new URL("../src/server/engine/providers/document-links.ts", import.meta.url),
        "utf-8",
      )
    ).toLowerCase();
    for (const banned of ["pump", "buyback", "solscan", "etherscan"]) {
      expect(raw, `contains "${banned}"`).not.toContain(banned);
    }
  });
});
