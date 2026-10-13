import { describe, expect, it } from "vitest";

import { evaluateInspectionEligibility } from "../src/server/engine/inspection-eligibility";
import { evaluateRenderEligibility } from "../src/server/engine/rendered-docs-policy";
import type { ResolvedSourceRoute } from "../src/server/engine/source-authority";

// OWNER INSPECTION MODE — a NON-EVIDENTIARY path that renders a confirmed
// official page to stdout so a human can decide whether it deserves
// documentation authority.
//
// The guarantees that matter here are structural (what the entrypoint CAN
// do), not behavioural (what it happens to do), so most of these tests
// read its import graph. A capability that is absent from the graph cannot
// be invoked by a future edit without that edit failing a test.

const HOST = "docs.example-project.test";
const URL_IN = `https://${HOST}/token-page`;

function route(over: Partial<ResolvedSourceRoute> = {}): ResolvedSourceRoute {
  return {
    officiality: "CONFIRMED",
    routeClass: null, // officiality WITHOUT documentation authority
    observation: null,
    matchedPathPrefix: "/token-page",
    ...over,
  };
}

describe("inspection eligibility — the inverse of the documentation gate", () => {
  it("a confirmed, path-scoped page with NO routeClass is inspectable", () => {
    const e = evaluateInspectionEligibility(URL_IN, route());
    expect(e.eligible).toBe(true);
    if (e.eligible) {
      expect(e.confirmedHost).toBe(HOST);
      expect(e.matchedPathPrefix).toBe("/token-page");
    }
  });

  it("a page that ALREADY has documentation authority is NOT an inspection subject", () => {
    // It goes through the ordinary evidentiary path instead. Inspection
    // exists only for the undecided case.
    expect(
      evaluateInspectionEligibility(URL_IN, route({ routeClass: "OFFICIAL_DOCS" })),
    ).toMatchObject({ eligible: false, reason: "ALREADY_CLASSIFIED" });
  });

  it("an unconfirmed page is not inspectable", () => {
    expect(
      evaluateInspectionEligibility(URL_IN, route({ officiality: "CLAIMED", matchedPathPrefix: null })),
    ).toMatchObject({ eligible: false, reason: "NOT_CONFIRMED" });
  });

  it("a bare-domain confirmation does not authorize inspecting arbitrary pages", () => {
    expect(
      evaluateInspectionEligibility(URL_IN, route({ matchedPathPrefix: null })),
    ).toMatchObject({ eligible: false, reason: "NO_PATH_PREFIX" });
  });

  it("http is refused", () => {
    expect(evaluateInspectionEligibility(`http://${HOST}/token-page`, route())).toMatchObject({
      eligible: false,
    });
  });

  it("the inspection and documentation gates are MUTUALLY EXCLUSIVE", () => {
    // The property that stops inspection becoming a looser second route
    // into the evidentiary renderer: no route can satisfy both.
    const shortfall = { staticHtmlBytes: 1_500_000, staticTextLength: 134 };
    for (const r of [route(), route({ routeClass: "OFFICIAL_DOCS" })]) {
      const inspect = evaluateInspectionEligibility(URL_IN, r).eligible;
      const render = evaluateRenderEligibility({
        url: URL_IN,
        route: r,
        ...shortfall,
        rendererEnabled: true,
      }).eligible;
      expect(inspect && render, `both gates passed for routeClass=${r.routeClass}`).toBe(false);
    }
  });
});

describe("inspection entrypoint — capabilities absent from the import graph", () => {
  async function entrypoint(): Promise<string> {
    const fs = await import("node:fs/promises");
    return fs.readFile(
      new URL("../scripts/inspect-official-page.ts", import.meta.url),
      "utf-8",
    );
  }
  async function entrypointCode(): Promise<string> {
    const raw = await entrypoint();
    return raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  }

  it("performs NO database write of any kind", async () => {
    const code = await entrypointCode();
    for (const write of [".insert(", ".update(", ".delete(", "onConflict", "transaction("]) {
      expect(code, `entrypoint contains "${write}"`).not.toContain(write);
    }
  });

  it("cannot write Evidence or Facts — those modules are not imported", async () => {
    const code = await entrypointCode();
    for (const banned of [
      "evidence",
      "onchainArtifacts",
      "onchain-acquisition",
      "onchain-facts",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("cannot enter S5/S6/S7 — no reconciliation, assembly or claim module", async () => {
    const code = await entrypointCode();
    for (const banned of [
      "component-reconcil",
      "mechanism-assembl",
      "claim-support",
      "claim-evaluator",
      "run-job",
      "s4-executor",
      "controller",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("makes NO model call — no extractor, proposer or Anthropic client", async () => {
    const code = await entrypointCode();
    for (const banned of [
      "evidence-extractor",
      "query-proposer",
      "anthropic",
      "Anthropic",
      "ANTHROPIC",
      "search-gateway",
      "brave",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("cannot promote memory or assign a routeClass", async () => {
    const code = await entrypointCode();
    for (const banned of [
      "promoteProjectMemoryItem",
      "projectMemoryItems",
      "memory/lifecycle",
      // Assigning a class literal — reading route.routeClass to DISPLAY it
      // is required by the gate and deliberately not banned here.
      'routeClass: "',
      "OFFICIAL_DOCS",
      "GOVERNANCE",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
    // It may read the current class (the gate requires it to be null), but
    // never write one.
    expect(code).toContain("route.routeClass");
  });

  it("makes no RPC call — no on-chain retriever in the graph", async () => {
    const code = await entrypointCode();
    for (const banned of ["onchain-retriever", "onchain-transport", "onchain-solana"]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("reuses the isolated renderer boundary rather than a bespoke one", async () => {
    const code = await entrypointCode();
    // The security boundary must be the SHARED one, so it cannot drift
    // from the audited implementation.
    expect(code).toContain("createIsolatedRenderedDocsFetcher");
    // And must not launch a browser itself.
    expect(code).not.toContain("playwright");
    expect(code).not.toContain("chromium.launch");
  });

  it("closes the database before rendering, so no ATLAS handle is open during it", async () => {
    const raw = await entrypoint();
    const poolEnd = raw.indexOf("pool.end()");
    const render = raw.indexOf(".render(");
    expect(poolEnd).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(-1);
    expect(poolEnd).toBeLessThan(render);
  });

  it("enforces the gate before rendering, not after", async () => {
    const raw = await entrypoint();
    expect(raw.indexOf("evaluateInspectionEligibility")).toBeLessThan(raw.indexOf(".render("));
  });

  it("is a standalone script, not reachable from the research engine", async () => {
    const fs = await import("node:fs/promises");
    // Nothing under src/ may import the inspection entrypoint.
    async function walk(dir: URL): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
        if (e.isDirectory()) out.push(...(await walk(child)));
        else if (e.name.endsWith(".ts")) out.push(await fs.readFile(child, "utf-8"));
      }
      return out;
    }
    const sources = await walk(new URL("../src/", import.meta.url));
    for (const src of sources) {
      expect(src).not.toContain("inspect-official-page");
    }
  });
});
