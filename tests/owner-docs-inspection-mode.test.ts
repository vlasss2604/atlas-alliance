import { describe, expect, it } from "vitest";

import { evaluateDocsInspectionEligibility } from "../src/server/engine/docs-inspection-eligibility";
import { evaluateInspectionEligibility } from "../src/server/engine/inspection-eligibility";
import { evaluateRenderEligibility } from "../src/server/engine/rendered-docs-policy";
import type { ResolvedSourceRoute } from "../src/server/engine/source-authority";

// OWNER DOCS INSPECTION — a NON-EVIDENTIARY path that renders a page which
// ALREADY holds documentation authority, so a human can read what the
// plain-text research path discards.
//
// Two classes of guarantee are tested here:
//   1. the gate itself, which must be exactly as strict as the render
//      gate on every AUTHORITY condition;
//   2. structural guarantees about the entrypoint — what it CAN do, read
//      from its import graph. A capability absent from the graph cannot be
//      invoked by a future edit without that edit failing a test.

const HOST = "docs.example-project.test";
const PREFIX = "/token-page";
const URL_IN = `https://${HOST}${PREFIX}`;

function route(over: Partial<ResolvedSourceRoute> = {}): ResolvedSourceRoute {
  return {
    officiality: "CONFIRMED",
    routeClass: "OFFICIAL_DOCS",
    observation: null,
    matchedPathPrefix: PREFIX,
    ...over,
  };
}

describe("docs inspection eligibility", () => {
  it("a confirmed, path-scoped OFFICIAL_DOCS page is inspectable", () => {
    const e = evaluateDocsInspectionEligibility(URL_IN, route());
    expect(e.eligible).toBe(true);
    if (e.eligible) {
      expect(e.confirmedHost).toBe(HOST);
      expect(e.matchedPathPrefix).toBe(PREFIX);
    }
  });

  it("a deeper page inside the confirmed prefix is inspectable", () => {
    expect(
      evaluateDocsInspectionEligibility(`https://${HOST}${PREFIX}/detail`, route()).eligible,
    ).toBe(true);
  });

  it("http is refused", () => {
    expect(evaluateDocsInspectionEligibility(`http://${HOST}${PREFIX}`, route())).toMatchObject({
      eligible: false,
      reason: "NOT_HTTPS",
    });
  });

  it("a malformed url is refused", () => {
    expect(evaluateDocsInspectionEligibility("not a url", route())).toMatchObject({
      eligible: false,
      reason: "NOT_HTTPS",
    });
  });

  it("an unconfirmed domain is refused, however the class reads", () => {
    expect(
      evaluateDocsInspectionEligibility(URL_IN, route({ officiality: "CLAIMED" })),
    ).toMatchObject({ eligible: false, reason: "NOT_CONFIRMED" });
  });

  it("a confirmed page WITHOUT documentation authority is refused", () => {
    // That is the older gate's subject, not this one's.
    expect(evaluateDocsInspectionEligibility(URL_IN, route({ routeClass: null }))).toMatchObject({
      eligible: false,
      reason: "NOT_OFFICIAL_DOCS",
    });
  });

  it("governance or report authority is NOT documentation authority", () => {
    for (const routeClass of ["GOVERNANCE", "OFFICIAL_REPORT"] as const) {
      expect(evaluateDocsInspectionEligibility(URL_IN, route({ routeClass }))).toMatchObject({
        eligible: false,
        reason: "NOT_OFFICIAL_DOCS",
      });
    }
  });

  it("a bare-domain confirmation does not authorize reading arbitrary pages", () => {
    expect(
      evaluateDocsInspectionEligibility(URL_IN, route({ matchedPathPrefix: null })),
    ).toMatchObject({ eligible: false, reason: "NO_PATH_PREFIX" });
  });

  it("a url outside the confirmed prefix is refused", () => {
    expect(
      evaluateDocsInspectionEligibility(`https://${HOST}/somewhere-else`, route()),
    ).toMatchObject({ eligible: false, reason: "URL_OUTSIDE_PREFIX" });
  });

  it("prefix matching is segment-bounded — /doc must not admit /documentation", () => {
    expect(
      evaluateDocsInspectionEligibility(
        `https://${HOST}/documentation`,
        route({ matchedPathPrefix: "/doc" }),
      ),
    ).toMatchObject({ eligible: false, reason: "URL_OUTSIDE_PREFIX" });
  });

  it("a route confirmed for ANOTHER host cannot be replayed onto this url", () => {
    // The gate derives the confirmed host from the url it is given, so the
    // caller cannot smuggle in a host the renderer would then pin to.
    const e = evaluateDocsInspectionEligibility(`https://evil.test${PREFIX}`, route());
    expect(e.eligible).toBe(true);
    if (e.eligible) expect(e.confirmedHost).toBe("evil.test");
    // Officiality for evil.test would never resolve to CONFIRMED in the
    // first place — resolveSourceRoute matches the domain itself — so the
    // pairing above is unreachable in practice. What matters is that the
    // host handed to the renderer always comes from the requested url.
  });
});

describe("the three gates over the renderer stay distinct", () => {
  it("the OLDER inspection gate is unchanged: an already-classified page is still refused", () => {
    expect(evaluateInspectionEligibility(URL_IN, route())).toMatchObject({
      eligible: false,
      reason: "ALREADY_CLASSIFIED",
    });
  });

  it("docs inspection and undecided inspection are MUTUALLY EXCLUSIVE", () => {
    // One requires routeClass === OFFICIAL_DOCS, the other requires null,
    // so no route can open both doors.
    for (const r of [route(), route({ routeClass: null }), route({ routeClass: "GOVERNANCE" })]) {
      const docs = evaluateDocsInspectionEligibility(URL_IN, r).eligible;
      const undecided = evaluateInspectionEligibility(URL_IN, r).eligible;
      expect(docs && undecided, `both gates passed for routeClass=${r.routeClass}`).toBe(false);
    }
  });

  it("docs inspection is never LOOSER than the render gate on authority", () => {
    // The property that stops this becoming a back door: anything this
    // gate admits, the evidentiary render gate would also admit on
    // authority grounds. It may still deny for OPERATIONAL reasons (the
    // renderer switch, the static-shortfall precondition) — those are
    // about spending a research render, not about who may read the page.
    const OPERATIONAL = new Set(["RENDERER_DISABLED", "NO_STATIC_SHORTFALL"]);
    const urls = [
      URL_IN,
      `https://${HOST}${PREFIX}/detail`,
      `https://${HOST}/somewhere-else`,
      `http://${HOST}${PREFIX}`,
    ];
    const routes = [
      route(),
      route({ routeClass: null }),
      route({ routeClass: "GOVERNANCE" }),
      route({ officiality: "CLAIMED" }),
      route({ matchedPathPrefix: null }),
      route({ matchedPathPrefix: "/doc" }),
    ];
    for (const url of urls) {
      for (const r of routes) {
        if (!evaluateDocsInspectionEligibility(url, r).eligible) continue;
        // Renderer on, and a static shortfall present, so any remaining
        // denial can only be an authority one.
        const render = evaluateRenderEligibility({
          url,
          route: r,
          staticHtmlBytes: 1_500_000,
          staticTextLength: 134,
          rendererEnabled: true,
        });
        expect(
          render.eligible || OPERATIONAL.has(render.reason),
          `docs inspection admitted ${url} (routeClass=${r.routeClass}) but the render gate denied it as ${
            render.eligible ? "" : render.reason
          }`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------
// Structural guarantees — read from the entrypoint's own source.
// ---------------------------------------------------------------------

const ENTRYPOINT = new URL("../scripts/inspect-official-docs.ts", import.meta.url);

async function entrypointSource(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(ENTRYPOINT, "utf-8");
}

// Comments describe the guarantees; only executable lines can breach one.
async function entrypointCode(): Promise<string> {
  const raw = await entrypointSource();
  return raw
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("docs inspection entrypoint — capabilities absent from the import graph", () => {
  it("performs NO database write of any kind", async () => {
    const code = await entrypointCode();
    for (const write of [".insert(", ".update(", ".delete(", "onConflict", "transaction("]) {
      expect(code, `entrypoint contains "${write}"`).not.toContain(write);
    }
  });

  it("cannot write Evidence or Facts — those modules are not imported", async () => {
    const code = await entrypointCode();
    for (const banned of ["evidence", "onchainArtifacts", "onchain-acquisition", "onchain-facts"]) {
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

  it("makes NO model call — no extractor, proposer or vendor client", async () => {
    const code = await entrypointCode();
    for (const banned of [
      "evidence-extractor",
      "query-proposer",
      "anthropic",
      "Anthropic",
      "ANTHROPIC",
      "search-gateway",
      "brave",
      "Brave",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("makes no RPC call — no on-chain retriever in the graph", async () => {
    const code = await entrypointCode();
    for (const banned of ["onchain-retriever", "onchain-transport", "onchain-solana", "RPC_URL"]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
  });

  it("cannot promote memory or assign a class", async () => {
    const code = await entrypointCode();
    for (const banned of [
      "promoteProjectMemoryItem",
      "projectMemoryItems",
      "memory/lifecycle",
      'routeClass: "',
      "OFFICIAL_DOCS",
      "GOVERNANCE",
      "OFFICIAL_REPORT",
    ]) {
      expect(code, `entrypoint references "${banned}"`).not.toContain(banned);
    }
    // It may READ the current class to display it, and the requirement
    // that the class be documentation authority lives in the gate module.
    expect(code).toContain("route.routeClass");
    expect(code).toContain("evaluateDocsInspectionEligibility");
  });

  it("reuses the isolated renderer boundary rather than a bespoke one", async () => {
    const code = await entrypointCode();
    expect(code).toContain("createIsolatedRenderedDocsFetcher");
    // And must not drive a browser itself.
    expect(code).not.toContain("playwright");
    expect(code).not.toContain("chromium.launch");
  });

  it("performs exactly ONE render and no page interaction", async () => {
    const code = await entrypointCode();
    expect((code.match(/\.render\(/g) ?? []).length).toBe(1);
    for (const banned of [".click(", ".goto(", ".evaluate(", "waitForSelector", "nextPage", "scroll"]) {
      expect(code, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("has no retry or loop around the render", async () => {
    const code = await entrypointCode();
    for (const banned of ["retry", "attempt", "for (let i", "while ("]) {
      expect(code, `entrypoint contains "${banned}"`).not.toContain(banned);
    }
  });

  it("closes the database before rendering, so no ATLAS handle is open during it", async () => {
    const raw = await entrypointSource();
    const poolEnd = raw.indexOf("pool.end()");
    const render = raw.indexOf(".render(");
    expect(poolEnd).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(-1);
    expect(poolEnd).toBeLessThan(render);
  });

  it("enforces the gate before rendering, not after", async () => {
    const raw = await entrypointSource();
    expect(raw.indexOf("evaluateDocsInspectionEligibility")).toBeLessThan(raw.indexOf(".render("));
  });
});

// ---------------------------------------------------------------------
// The regression the owner asked for: the research engine must not be able
// to invoke this owner path.
// ---------------------------------------------------------------------

describe("the research engine cannot invoke owner docs inspection", () => {
  // Walked as URLs, never as joined path strings — a joined absolute path
  // on Windows produces "C:\C:\..." and makes the guard silently unrunnable.
  async function walk(dir: URL): Promise<{ path: string; source: string }[]> {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: { path: string; source: string }[] = [];
    for (const e of entries) {
      const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
      if (e.isDirectory()) out.push(...(await walk(child)));
      else if (/\.(ts|tsx)$/.test(e.name)) {
        out.push({ path: child.pathname, source: await fs.readFile(child, "utf-8") });
      }
    }
    return out;
  }

  // The gate module is allowed to name its own export; nothing else is.
  const GATE_MODULE = "/src/server/engine/docs-inspection-eligibility.ts";

  async function runtimeFiles(): Promise<{ path: string; source: string }[]> {
    const src = await walk(new URL("../src/", import.meta.url));
    const app = await walk(new URL("../app/", import.meta.url));
    const all = [...src, ...app];
    // The walk must actually have found the runtime, or this guard proves
    // nothing — the failure mode of a path-based version of this test.
    expect(all.length).toBeGreaterThan(50);
    return all;
  }

  it("no runtime file imports the owner docs inspection entrypoint", async () => {
    for (const f of await runtimeFiles()) {
      expect(f.source, `${f.path} references the owner entrypoint`).not.toContain(
        "inspect-official-docs",
      );
    }
  });

  it("no runtime file other than the gate itself references the docs inspection gate", async () => {
    for (const f of await runtimeFiles()) {
      if (f.path.endsWith(GATE_MODULE)) continue;
      for (const banned of ["docs-inspection-eligibility", "evaluateDocsInspectionEligibility"]) {
        expect(f.source, `${f.path} references "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("the gate module is a leaf: it imports no fetcher, no db and no model", async () => {
    const fs = await import("node:fs/promises");
    const gate = await fs.readFile(
      new URL("../src/server/engine/docs-inspection-eligibility.ts", import.meta.url),
      "utf-8",
    );
    const code = gate
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const banned of ["db/client", "Fetcher", "fetch(", "anthropic", "Anthropic", "process.env"]) {
      expect(code, `gate references "${banned}"`).not.toContain(banned);
    }
  });

  it("s4-executor — the only evidentiary render call site — does not reach the owner path", async () => {
    const fs = await import("node:fs/promises");
    const executor = await fs.readFile(
      new URL("../src/server/engine/s4-executor.ts", import.meta.url),
      "utf-8",
    );
    for (const banned of [
      "docs-inspection-eligibility",
      "evaluateDocsInspectionEligibility",
      "inspect-official-docs",
      "inspection-eligibility",
    ]) {
      expect(executor, `s4-executor references "${banned}"`).not.toContain(banned);
    }
    // It still holds the evidentiary gate, so this test is checking a
    // discrimination, not the absence of rendering altogether.
    expect(executor).toContain("evaluateRenderEligibility");
  });
});
