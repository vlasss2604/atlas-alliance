import { describe, expect, it } from "vitest";

import { extractEmbeddedPayloadText } from "../src/server/engine/providers/embedded-payload";
import {
  classifyIdentifier,
  recoverEmbeddedRecords,
} from "../src/server/engine/providers/embedded-records";

// RECORD-PRESERVING RECOVERY from a settled document's embedded payloads.
//
// Stage 0 flattens a payload to strings, which is right for handing prose
// to an extractor and wrong for the question now being asked: a row's date,
// its amount and its transaction id are only meaningfully related if they
// came from the SAME object. Flattened, a date and a base58 string are two
// strings that happen to share a document — precisely the association this
// system must never make.
//
// PARSE ONLY. The input is an HTML string the caller already holds. No
// eval, no Function, no script execution, no browser evaluate, no
// navigation, no fetch. A URL inside a payload is a string.

// Synthetic throughout — not any real project's values.
const SIG_A = "5".repeat(87) + "a";
const SIG_B = "4".repeat(87) + "b";
const ADDR_A = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm";

function flight(payload: unknown): string {
  // The exact shape Next ships: a push whose ARGUMENT is a JSON array
  // literal. Parsed as a literal, never executed.
  const inner = JSON.stringify(JSON.stringify(payload));
  return `<html><body><script>self.__next_f.push([1,${inner}])</script></body></html>`;
}

function jsonLd(payload: unknown): string {
  return `<html><body><script type="application/ld+json">${JSON.stringify(payload)}</script></body></html>`;
}

const BURN_ROWS = {
  page: "token",
  burns: [
    {
      date: "2026-08-23",
      pumpBurned: "160100000000000",
      solSpent: "8900",
      usd: "842600",
      price: "0.005261",
      revenuePct: "51.37",
      txSignature: SIG_A,
    },
    {
      date: "2026-08-22",
      pumpBurned: "188300000000000",
      solSpent: "9400",
      usd: "889900",
      price: "0.004726",
      revenuePct: "51.52",
      txSignature: SIG_B,
    },
  ],
};

describe("1/2/3. parse only", () => {
  it("3. the module executes nothing — no eval, Function or script running", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/providers/embedded-records.ts",
      "../src/server/engine/providers/embedded-payload.ts",
    ]) {
      const raw = await fs.readFile(new URL(file, import.meta.url), "utf-8");
      const code = raw
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
      for (const banned of [
        "eval(",
        "new Function",
        "vm.run",
        "require(",
        "import(",
        "fetch(",
        "page.",
        "evaluate",
        "goto",
        "XMLHttpRequest",
      ]) {
        expect(code, `${file} contains "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("1/2. the input is a STRING — there is no page, request or navigation parameter", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/embedded-records.ts", import.meta.url),
      "utf-8",
    );
    expect(raw).toContain("export function recoverEmbeddedRecords(");
    expect(raw).toContain("html: string,");
    // Recovery in the renderer runs on the html already captured, after the
    // single navigation, and adds no navigation of its own.
    const pw = await fs.readFile(
      new URL("../src/server/engine/providers/rendered-docs-playwright.ts", import.meta.url),
      "utf-8",
    );
    const code = pw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect((code.match(/page\.goto\(/g) ?? []).length).toBe(1);
    expect(code).toContain("recoverEmbeddedRecords(html, {");
  });

  it("a URL inside a payload is just a string — nothing follows it", () => {
    const html = flight({ rows: [{ id: 1, endpoint: "https://api.example.test/burns" }] });
    const out = recoverEmbeddedRecords(html, { needles: ["burns"] });
    expect(out.matches.length).toBe(1);
    expect(out.matches[0].json).toContain("https://api.example.test/burns");
    // The result shape has nowhere to put a fetched body.
    expect(Object.keys(out.matches[0])).not.toContain("response");
    expect(Object.keys(out.matches[0])).not.toContain("body");
  });
});

describe("4. static Stage 0 behaviour is unchanged", () => {
  it("flat text recovery still returns the same shape and content", () => {
    const html = jsonLd({ name: "Token page", note: "Half of revenue buys and burns" });
    const out = extractEmbeddedPayloadText(html);
    expect(out.kinds).toEqual(["JSON_LD"]);
    expect(out.text).toContain("Half of revenue buys and burns");
    expect(out.recoveredStrings).toBeGreaterThan(0);
    expect(out.truncated).toBe(false);
  });

  it("an oversized document still recovers nothing", () => {
    const huge = `<script type="application/ld+json">{"a":"b"}</script>`.padEnd(4_000_001, " ");
    expect(extractEmbeddedPayloadText(huge).text).toBe("");
    expect(recoverEmbeddedRecords(huge, { needles: ["b"] }).matches).toEqual([]);
  });
});

describe("5/6. what can be recovered", () => {
  it("5. an RSC/Flight record absent from rendered text is recovered", () => {
    const html = flight(BURN_ROWS);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.kinds).toEqual(["RSC_FLIGHT"]);
    expect(out.matches.length).toBe(1);
    expect(out.matches[0].fields).toContain("txSignature");
    expect(out.recordsScanned).toBeGreaterThan(0);
  });

  it("6. a JSON-LD record is recovered", () => {
    const html = jsonLd({ "@type": "Dataset", rows: [{ date: "2026-08-23", tx: SIG_A }] });
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.kinds).toEqual(["JSON_LD"]);
    expect(out.matches[0].identifiers.map((i) => i.value)).toEqual([SIG_A]);
  });

  it("a __NEXT_DATA__ record is recovered", () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      { props: { rows: [{ date: "2026-08-23", account: ADDR_A }] } },
    )}</script></body></html>`;
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.kinds).toEqual(["NEXT_DATA"]);
    expect(out.matches[0].identifiers[0]).toMatchObject({
      value: ADDR_A,
      shape: "ADDRESS_LIKE",
    });
  });

  it("provenance names the payload kind, the script index and the path", () => {
    const out = recoverEmbeddedRecords(flight(BURN_ROWS), { needles: ["2026-08-23"] });
    const m = out.matches[0];
    expect(m.kind).toBe("RSC_FLIGHT");
    expect(m.scriptIndex).toBeGreaterThanOrEqual(0);
    expect(m.path).toContain("burns");
  });
});

describe("7/8. same-record association is the whole point", () => {
  it("7. a target value and an identifier in the SAME record stay associated", () => {
    const out = recoverEmbeddedRecords(flight(BURN_ROWS), { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
    const m = out.matches[0];
    expect(m.matchedNeedles).toEqual(["2026-08-23"]);
    expect(m.json).toContain("160100000000000");
    expect(m.identifiers.map((i) => i.value)).toEqual([SIG_A]);
    expect(m.identifiers[0].field).toBe("txSignature");
  });

  it("8. an identifier in an UNRELATED record is NOT associated", () => {
    const out = recoverEmbeddedRecords(flight(BURN_ROWS), { needles: ["2026-08-23"] });
    const values = out.matches[0].identifiers.map((i) => i.value);
    // SIG_B belongs to the Aug 22 row and must not appear here.
    expect(values).not.toContain(SIG_B);
  });

  it("8. an identifier elsewhere in the document is NOT association-eligible", () => {
    const html = flight({
      unrelated: { note: "some other section", tx: SIG_B },
      burns: [{ date: "2026-08-23", pumpBurned: "160100000000000" }],
    });
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
    // The matched row genuinely has no identifier — reported as none rather
    // than borrowed from the neighbour.
    expect(out.matches[0].identifiers).toEqual([]);
    expect(out.matches[0].json).not.toContain(SIG_B);
  });

  it("the SMALLEST matching record is reported, not the page state around it", () => {
    const html = flight({ pageState: { everything: BURN_ROWS } });
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
    // The row, not its container: the Aug 22 row must not be inside it.
    expect(out.matches[0].json).not.toContain("2026-08-22");
    expect(out.matches[0].identifiers.map((i) => i.value)).toEqual([SIG_A]);
  });

  it("two needles in two different rows produce two distinct matches", () => {
    const out = recoverEmbeddedRecords(flight(BURN_ROWS), {
      needles: ["2026-08-23", "2026-08-22"],
    });
    expect(out.matches.length).toBe(2);
    const byNeedle = Object.fromEntries(out.matches.map((m) => [m.matchedNeedles[0], m]));
    expect(byNeedle["2026-08-23"].identifiers[0].value).toBe(SIG_A);
    expect(byNeedle["2026-08-22"].identifiers[0].value).toBe(SIG_B);
  });
});

describe("9/10/11. bounds and failure", () => {
  it("9/10. a per-record cap truncates visibly", () => {
    const big = { date: "2026-08-23", blob: "z".repeat(50_000) };
    const out = recoverEmbeddedRecords(flight({ rows: [big] }), {
      needles: ["2026-08-23"],
      maxRecordChars: 500,
    });
    const m = out.matches[0];
    expect(m.json.length).toBeLessThan(1_000);
    expect(m.jsonTruncated).toBe(true);
    expect(m.json.endsWith("…[truncated]")).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it("10. a match-count cap is enforced and reported", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ date: "2026-08-23", i }));
    const out = recoverEmbeddedRecords(flight({ rows }), {
      needles: ["2026-08-23"],
      maxMatches: 5,
    });
    expect(out.matches.length).toBe(5);
    expect(out.truncated).toBe(true);
  });

  it("10. an aggregate cap stops further matches", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      date: "2026-08-23",
      pad: "q".repeat(400),
      i,
    }));
    const out = recoverEmbeddedRecords(flight({ rows }), {
      needles: ["2026-08-23"],
      maxTotalChars: 1_000,
    });
    expect(out.matches.length).toBeLessThan(40);
    expect(out.truncated).toBe(true);
  });

  it("the needle list itself is bounded", () => {
    const needles = Array.from({ length: 100 }, (_, i) => `n${i}`);
    const out = recoverEmbeddedRecords(flight({ rows: [{ n0: 1 }] }), { needles, maxNeedles: 3 });
    // Only the first few needles are considered; nothing throws.
    expect(out.matches.length).toBeLessThanOrEqual(1);
  });

  it("11. a malformed payload fails closed — nothing partially salvaged", () => {
    const broken = `<html><body><script type="application/ld+json">{"a": </script></body></html>`;
    expect(recoverEmbeddedRecords(broken, { needles: ["a"] }).matches).toEqual([]);
    const brokenFlight = `<html><body><script>self.__next_f.push([1,"{oops)</script></body></html>`;
    expect(recoverEmbeddedRecords(brokenFlight, { needles: ["oops"] }).matches).toEqual([]);
  });

  it("no needles means no work and no matches", () => {
    expect(recoverEmbeddedRecords(flight(BURN_ROWS), { needles: [] }).matches).toEqual([]);
    expect(recoverEmbeddedRecords(flight(BURN_ROWS), { needles: ["   "] }).matches).toEqual([]);
  });

  it("an unrecognised script is ignored entirely, never scraped", () => {
    const html = `<html><body><script>var rows=[{date:"2026-08-23"}];</script></body></html>`;
    expect(recoverEmbeddedRecords(html, { needles: ["2026-08-23"] }).matches).toEqual([]);
  });
});

describe("12/13. authority and independence", () => {
  it("12. a match carries no authority field of any kind", () => {
    const out = recoverEmbeddedRecords(flight(BURN_ROWS), { needles: ["2026-08-23"] });
    const keys = Object.keys(out.matches[0]);
    for (const banned of [
      "sourceClass",
      "officiality",
      "routeClass",
      "trusted",
      "verified",
      "entityBinding",
      "evidence",
      "confirmed",
    ]) {
      expect(keys, `match exposes "${banned}"`).not.toContain(banned);
    }
  });

  it("12. an identifier is a SHAPE claim only", () => {
    const out = recoverEmbeddedRecords(flight(BURN_ROWS), { needles: ["2026-08-23"] });
    const id = out.matches[0].identifiers[0];
    expect(Object.keys(id).sort()).toEqual(["field", "shape", "value"].sort());
    expect(id.shape).toBe("SIGNATURE_LIKE");
    // Shape says nothing about chain or project.
    expect(classifyIdentifier(ADDR_A)).toBe("ADDRESS_LIKE");
    expect(classifyIdentifier("not-base58!")).toBeNull();
    expect(classifyIdentifier("0OIl".repeat(20))).toBeNull();
  });

  it("13. no project-specific runtime logic", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/embedded-records.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const banned of ["pump", "solscan", "burn", "buyback", "solana", "hyperliquid", "uniswap"]) {
      expect(code, `recovery mentions "${banned}"`).not.toContain(banned);
    }
  });
});
