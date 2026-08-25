import { describe, expect, it } from "vitest";

import { extractEmbeddedPayloadText } from "../src/server/engine/providers/embedded-payload";
import {
  embeddedSearchVerdict,
  recoverEmbeddedRecords,
} from "../src/server/engine/providers/embedded-records";
import { parseFlightFrames } from "../src/server/engine/providers/flight-frames";

// RSC FLIGHT FRAME RECOVERY, and the coverage semantics that stop a parser
// limitation from being reported as a finding.
//
// A live inspection reported zero matches after scanning four objects on a
// two-megabyte page, and that was read as "no identifier exists". It was
// not: the flight stream is newline-delimited FRAMES (`<id>:<payload>`),
// the old whole-string check skipped every one of them, and the records
// were never reached. A negative conclusion drawn from an unsearched
// payload is worse than no conclusion, so coverage is now part of the
// result and a negative verdict requires COMPLETE.

const SIG = `${"5".repeat(87)}a`;
const OTHER_SIG = `${"4".repeat(87)}b`;
const ADDR = "4Hs9TzKqWnErYuPbVdMxLcJgFhRtSaZeQwNyBuCvDkGm";

// Builds the REAL shape: push([1, <json string>]) whose CONTENT is a
// newline-delimited frame stream.
function flightHtml(frameLines: string[]): string {
  const stream = `${frameLines.join("\n")}\n`;
  return `<html><body><script>self.__next_f.push([1,${JSON.stringify(stream)}])</script></body></html>`;
}

const AUG23_ROW = { date: "2026-08-23", pumpBurned: "160100000000000", txSignature: SIG };
const AUG22_ROW = { date: "2026-08-22", pumpBurned: "188300000000000", txSignature: OTHER_SIG };

describe("frame parsing", () => {
  it("parses a tagged frame (2:I[...])", () => {
    const out = parseFlightFrames('2:I[4707,[],""]\n');
    expect(out.stats).toMatchObject({ seen: 1, parsed: 1, unsupported: 0, parseErrors: 0 });
    expect(out.values[0]).toEqual([4707, [], ""]);
  });

  it("parses an untagged JSON ARRAY frame", () => {
    const out = parseFlightFrames('3:["$","div",null,{"rows":[]}]\n');
    expect(out.stats.parsed).toBe(1);
    expect(Array.isArray(out.values[0])).toBe(true);
  });

  it("parses a JSON OBJECT frame", () => {
    const out = parseFlightFrames('7:{"burns":[{"date":"2026-08-23"}]}\n');
    expect(out.stats.parsed).toBe(1);
    expect(out.values[0]).toMatchObject({ burns: [{ date: "2026-08-23" }] });
  });

  it("parses MULTIPLE frames in one stream", () => {
    const out = parseFlightFrames(
      ['2:I[4707,[],""]', '3:["$","div",null,{}]', '7:{"a":1}'].join("\n"),
    );
    expect(out.stats.seen).toBe(3);
    expect(out.stats.parsed).toBe(3);
  });

  it("an UNSUPPORTED frame type is reported, never executed or guessed", () => {
    // A text frame is `<id>:T<len>,<text>` — a length-prefixed blob, not a
    // JSON literal. It has a frame id like any other, so it is SEEN and
    // then reported unsupported rather than silently skipped.
    const out = parseFlightFrames("2:T2a,hello world\n");
    expect(out.stats).toMatchObject({ seen: 1, parsed: 0, unsupported: 1 });
    expect(out.values).toEqual([]);
  });

  it("an unrecognised TAG fails closed", () => {
    const out = parseFlightFrames('9:ZZZ[{"a":1}]\n');
    expect(out.stats.unsupported).toBe(1);
    expect(out.values).toEqual([]);
  });

  it("a MALFORMED frame is a bounded parse failure, not a crash", () => {
    const out = parseFlightFrames('4:{"a": \n');
    expect(out.stats).toMatchObject({ seen: 1, parsed: 0, parseErrors: 1 });
    expect(out.values).toEqual([]);
  });

  it("a line that is not a frame at all is ignored", () => {
    const out = parseFlightFrames("just some text\n");
    expect(out.stats.seen).toBe(0);
  });

  it("frame count and size are bounded", () => {
    const many = Array.from({ length: 500 }, (_, i) => `${i.toString(16)}:{"i":${i}}`).join("\n");
    const out = parseFlightFrames(many, { maxFrames: 10 });
    expect(out.stats.seen).toBe(10);
    const huge = `1:${JSON.stringify({ blob: "z".repeat(5_000) })}`;
    expect(parseFlightFrames(huge, { maxFrameChars: 100 }).stats.unsupported).toBe(1);
  });
});

describe("records recovered from a realistic frame stream", () => {
  it("the realistic fixture is parsed and its rows are reachable", () => {
    const html = flightHtml([
      '2:I[4707,[],""]',
      `3:["$","div",null,{"burns":[${JSON.stringify(AUG23_ROW)},${JSON.stringify(AUG22_ROW)}]}]`,
    ]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.coverage.framesSeen).toBe(2);
    expect(out.coverage.framesParsed).toBe(2);
    expect(out.recordsScanned).toBeGreaterThan(0);
    expect(out.matches.length).toBe(1);
  });

  it("nested JSON inside a frame is still re-parsed once", () => {
    const html = flightHtml([`5:{"payload":${JSON.stringify(JSON.stringify(AUG23_ROW))}}`]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
    expect(out.matches[0].identifiers.map((i) => i.value)).toEqual([SIG]);
  });

  it("sibling-record identifier isolation still holds", () => {
    const html = flightHtml([
      `3:{"burns":[${JSON.stringify(AUG23_ROW)},${JSON.stringify(AUG22_ROW)}]}`,
    ]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
    const values = out.matches[0].identifiers.map((i) => i.value);
    expect(values).toEqual([SIG]);
    expect(values).not.toContain(OTHER_SIG);
  });

  it("smallest-record correlation still holds across frames", () => {
    const html = flightHtml([
      `3:{"pageState":{"everything":{"burns":[${JSON.stringify(AUG23_ROW)},${JSON.stringify(AUG22_ROW)}]}}}`,
    ]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
    expect(out.matches[0].json).not.toContain("2026-08-22");
  });

  it("an identifier in a DIFFERENT frame is never borrowed", () => {
    const html = flightHtml([
      `2:{"globals":{"mint":"${ADDR}","note":"page state"}}`,
      `3:{"burns":[{"date":"2026-08-23","pumpBurned":"160100000000000"}]}`,
    ]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
    // The row genuinely has no identifier — reported as none, not borrowed
    // from global page state in another frame.
    expect(out.matches[0].identifiers).toEqual([]);
    expect(out.matches[0].json).not.toContain(ADDR);
  });

  it("a record reachable through BOTH paths is reported once", () => {
    // A chunk that is itself whole JSON: the direct walk and the frame
    // walk could each find it, and two entries would suggest two
    // independent occurrences.
    const whole = JSON.stringify(JSON.stringify({ burns: [AUG23_ROW] }));
    const html = `<html><body><script>self.__next_f.push([1,${whole}])</script></body></html>`;
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(1);
  });
});

describe("coverage semantics — a negative requires COMPLETE", () => {
  it("zero matches after COMPLETE traversal IS a real negative", () => {
    const html = flightHtml([`3:{"burns":[${JSON.stringify(AUG22_ROW)}]}`]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(0);
    expect(out.coverage.coverage).toBe("COMPLETE");
    expect(embeddedSearchVerdict(out)).toBe("SEARCHED_SUPPORTED_PAYLOAD_NO_MATCH");
  });

  it("zero matches after PARTIAL traversal is NOT a negative", () => {
    const html = flightHtml([
      "5:T2a,an unsupported text frame",
      `3:{"burns":[${JSON.stringify(AUG22_ROW)}]}`,
    ]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.matches.length).toBe(0);
    expect(out.coverage.framesUnsupported).toBe(1);
    expect(out.coverage.coverage).toBe("PARTIAL");
    expect(embeddedSearchVerdict(out)).toBe("PAYLOAD_PRESENT_BUT_NOT_FULLY_INSPECTED");
  });

  it("a parse error also forces PARTIAL", () => {
    const html = flightHtml(['4:{"a": ', `3:{"burns":[${JSON.stringify(AUG22_ROW)}]}`]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.coverage.parseErrors).toBe(1);
    expect(out.coverage.coverage).toBe("PARTIAL");
    expect(embeddedSearchVerdict(out)).toBe("PAYLOAD_PRESENT_BUT_NOT_FULLY_INSPECTED");
  });

  it("hitting a cap forces PARTIAL, so truncation can never read as absence", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ date: "2026-08-23", i }));
    const html = flightHtml([`3:${JSON.stringify({ rows })}`]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"], maxMatches: 2 });
    expect(out.truncated).toBe(true);
    expect(out.coverage.coverage).toBe("PARTIAL");
  });

  it("a match reports FOUND regardless of coverage", () => {
    const html = flightHtml([
      "5:T2a,unsupported",
      `3:{"burns":[${JSON.stringify(AUG23_ROW)}]}`,
    ]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(out.coverage.coverage).toBe("PARTIAL");
    expect(embeddedSearchVerdict(out)).toBe("EVENT_IDENTIFIER_PATH_FOUND");
  });

  it("no sources at all is NONE, never a negative", () => {
    const out = recoverEmbeddedRecords("<html><body>nothing</body></html>", {
      needles: ["2026-08-23"],
    });
    expect(out.coverage).toMatchObject({ sourcesFound: 0, sourcesTraversed: 0, coverage: "NONE" });
    expect(embeddedSearchVerdict(out)).toBe("PAYLOAD_PRESENT_BUT_NOT_FULLY_INSPECTED");
  });

  it("coverage counters are all reported", () => {
    const html = flightHtml(['2:I[1,[],""]', "5:T2a,unsupported", `3:{"burns":[${JSON.stringify(AUG23_ROW)}]}`]);
    const out = recoverEmbeddedRecords(html, { needles: ["2026-08-23"] });
    expect(Object.keys(out.coverage).sort()).toEqual(
      [
        "sourcesFound",
        "sourcesTraversed",
        "framesSeen",
        "framesParsed",
        "framesUnsupported",
        "parseErrors",
        "recordsScanned",
        "coverage",
      ].sort(),
    );
    expect(out.coverage.framesSeen).toBe(3);
    expect(out.coverage.framesParsed).toBe(2);
    expect(out.coverage.framesUnsupported).toBe(1);
  });
});

describe("nothing new was granted", () => {
  it("Stage 0 flat-text behaviour is unchanged", () => {
    const html = `<html><body><script type="application/ld+json">${JSON.stringify({
      note: "Half of revenue buys and burns",
    })}</script></body></html>`;
    const out = extractEmbeddedPayloadText(html);
    expect(out.kinds).toEqual(["JSON_LD"]);
    expect(out.text).toContain("Half of revenue buys and burns");
  });

  it("no network, browser or execution capability was introduced", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/providers/flight-frames.ts",
      "../src/server/engine/providers/embedded-records.ts",
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
        "vm.",
        "fetch(",
        "page.",
        "evaluate",
        "goto",
        "require(",
        "import(",
      ]) {
        expect(code, `${file} contains "${banned}"`).not.toContain(banned);
      }
      // Every payload goes to JSON.parse and nowhere else.
      expect(raw).toContain("JSON.parse");
    }
  });

  it("no project-specific logic", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/flight-frames.ts", import.meta.url),
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
    for (const banned of ["pump", "burn", "buyback", "solana", "solscan", "hyperliquid"]) {
      expect(code, `frames mention "${banned}"`).not.toContain(banned);
    }
  });
});
