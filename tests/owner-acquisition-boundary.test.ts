import { describe, expect, it } from "vitest";

// NARROW ACQUISITION ENTRYPOINT — structural guarantees.
//
// alpha-acquire-url.ts drives the REAL engine at a single owner-named URL.
// Its whole safety argument is about what it CANNOT reach, so the tests
// that matter read its source rather than its behaviour: a capability
// absent from the import graph cannot be invoked by a future edit without
// that edit failing here.
//
// The recorder around the renderer is covered too. It exists so a run can
// report WHERE a locator came from without fetching the page twice, and
// the property that makes it safe is that it is a pass-through: one
// forwarded render, no navigation of its own, nothing altered on the way
// back. That is worth pinning, because a wrapper around the isolated
// renderer is exactly the place a second retrieval could hide.

const ENTRYPOINT = new URL("../scripts/alpha-acquire-url.ts", import.meta.url);

async function source(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(ENTRYPOINT, "utf-8");
}

// Comments describe the guarantees; only executable lines can breach one.
async function code(): Promise<string> {
  const raw = await source();
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("narrow acquisition entrypoint — what it cannot reach", () => {
  it("constructs no search provider", async () => {
    const c = await code();
    for (const banned of ["brave", "Brave", "BRAVE", "search-gateway-brave", "resolveSearchGateway"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("makes no chain call — no retriever, transport or adapter imported", async () => {
    const c = await code();
    for (const banned of [
      "onchain-retriever",
      "onchain-transport",
      "onchain-solana",
      "onchain-acquisition",
      "RPC_URL",
    ]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("builds no Proof — S6/S7 are absent", async () => {
    const c = await code();
    for (const banned of ["mechanism-assembl", "claim-support", "claim-evaluator", "proof-", "proofs"]) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("promotes no memory and assigns no route class", async () => {
    const c = await code();
    for (const banned of ["promoteProjectMemoryItem", "projectMemoryItems", "memory/lifecycle", 'routeClass: "']) {
      expect(c, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("refuses a URL with no confirmed documentary route, before any provider runs", async () => {
    const raw = await source();
    const gate = raw.indexOf("route.officiality !== \"CONFIRMED\"");
    const execute = raw.indexOf("executor.execute(");
    expect(gate).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(execute);
  });

  it("executes exactly ONE component and has no retry or acquisition loop", async () => {
    const c = await code();
    expect((c.match(/executor\.execute\(/g) ?? []).length).toBe(1);
    for (const banned of ["retry", "attempt(", "for (let i", "while ("]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("bounds the run to one search unit and two source opens", async () => {
    const c = await code();
    expect(c).toContain("maxSearchQueries: 1");
    expect(c).toContain("maxSourceOpens: 2");
  });
});

describe("the render recorder is a pass-through, not a second retrieval", () => {
  it("forwards ONE render and performs no navigation of its own", async () => {
    const c = await code();
    // Exactly one call into the isolated fetcher, and the recorder is the
    // only thing wrapping it.
    expect((c.match(/isolated\.render\(/g) ?? []).length).toBe(1);
    expect((c.match(/createIsolatedRenderedDocsFetcher\(/g) ?? []).length).toBe(1);
    // No browser driving of any kind.
    for (const banned of ["playwright", "chromium", ".goto(", ".click(", ".evaluate(", "fetch("]) {
      expect(c, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("returns the renderer's own document unaltered", async () => {
    const c = await code();
    // The captured value and the returned value are the same object: the
    // recorder observes, it does not reshape. A recorder that returned a
    // copy could silently diverge from what the engine consumed, and the
    // provenance it reports would describe a different document.
    expect(c).toContain("const doc = await isolated.render(target, route);");
    expect(c).toContain("captured.doc = doc;");
    expect(c).toContain("return doc;");
  });

  it("reports provenance from the captured document rather than re-reading the page", async () => {
    const c = await code();
    // Everything printed about where a locator came from is derived from
    // the already-fetched document.
    expect(c).toContain("captured.doc");
    expect(c).toContain("literallyPresent(doc.normalizedText");
  });

  it("prints the locator column and every rejection, so a run is auditable", async () => {
    const c = await code();
    expect(c).toContain("row.documentaryLocator");
    expect(c).toContain('"LOCATOR_REJECTED"');
  });

  it("names no project, host or mechanism in its executable code", async () => {
    const c = (await code()).toLowerCase();
    for (const banned of ["solscan", "burn", "treasury", "buyback", "hyperliquid", "uniswap"]) {
      expect(c, `entrypoint code mentions "${banned}"`).not.toContain(banned);
    }
    // pump_fun appears once, as the default --project value for internal
    // alpha tooling, and is allowed only there.
    const pumpMentions = (c.match(/pump/g) ?? []).length;
    expect(pumpMentions).toBeLessThanOrEqual(1);
  });
});
