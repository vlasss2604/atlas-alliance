import { describe, expect, it } from "vitest";

import { parseModelPublishedAt } from "../src/server/engine/providers/evidence-extractor-anthropic";

// D-128 — a real live owner-alpha run (question 4, "does the $PUMP buyback
// mechanism actually work right now") died with
// RangeError: Invalid time value / SYSTEM_OR_PROVIDER_FAILURE.
//
// EvidenceExtractor's contract types publishedAt as z.string().nullable(),
// which proves only that the model returned A string — never that the
// string is a parseable date. `new Date(<unparseable>)` returns an Invalid
// Date OBJECT rather than throwing, so it flowed silently through
// extraction, S4 and S5 and only blew up deep inside the pg driver when
// drizzle called .toISOString() to bind evidence.published_at. The whole
// job was lost AFTER its entire search/fetch/model budget had been spent.
describe("evidence extractor — publishedAt parsing is crash-proof (D-128)", () => {
  it("returns null for an unparseable model date instead of an Invalid Date", () => {
    for (const bad of ["unknown", "n/a", "not available", "Q3 2025", "recently", "—", "  "]) {
      const out = parseModelPublishedAt(bad);
      expect(out, `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("never returns a Date whose getTime() is NaN (the exact value that killed the job)", () => {
    for (const bad of ["unknown", "sometime in 2024", "invalid"]) {
      const out = parseModelPublishedAt(bad);
      // The precise pre-fix failure: a non-null Date that throws on
      // toISOString(), which is what the driver calls.
      if (out !== null) {
        expect(Number.isNaN(out.getTime())).toBe(false);
        expect(() => out.toISOString()).not.toThrow();
      }
    }
  });

  it("still parses genuine ISO timestamps unchanged", () => {
    const iso = "2025-02-22T10:30:00.000Z";
    const out = parseModelPublishedAt(iso);
    expect(out).toBeInstanceOf(Date);
    expect(out!.toISOString()).toBe(iso);
  });

  it("still parses a plain ISO date", () => {
    const out = parseModelPublishedAt("2024-07-15");
    expect(out).toBeInstanceOf(Date);
    expect(out!.toISOString().startsWith("2024-07-15")).toBe(true);
  });

  it("maps null and empty string to null (no fabricated provenance)", () => {
    expect(parseModelPublishedAt(null)).toBeNull();
    expect(parseModelPublishedAt("")).toBeNull();
  });

  it("every returned Date survives the exact driver call that crashed (toISOString)", () => {
    const inputs = ["2025-01-01", "2025-02-22T10:30:00.000Z", "unknown", null, "", "garbage"];
    for (const input of inputs) {
      const out = parseModelPublishedAt(input);
      expect(() => (out === null ? "null" : out.toISOString())).not.toThrow();
    }
  });
});
