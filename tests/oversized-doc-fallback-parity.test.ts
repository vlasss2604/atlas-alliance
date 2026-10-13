import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_FALLBACK_ATTEMPTS_PER_URL,
  plannedFallbacks,
} from "../src/server/engine/acquisition-fallback-policy";
import {
  extractDocumentLinks,
  resolveTruncatedText,
} from "../src/server/engine/providers/document-links";
import {
  completeIdentifierShape,
  isTruncatedDisplayForm,
} from "../src/server/engine/documentary-locator";
import { routeEligibility } from "../src/server/engine/rendered-docs-policy";

// ONE POLICY, TWO EXECUTORS.
//
// A confirmed OFFICIAL_DOCS page whose html exceeds the transport cap was
// recoverable in the phased path and permanently unreachable in the
// single-process path, because `plannedFallbacks` lived in a module the
// executor could not import without a cycle. Measured live twice on the
// same url, with the identical attempt reason
// `CONTENT_FETCHER_FAILED:ContentFetchError:TOO_LARGE`, and the page in
// question is 2,080,298 html bytes against a 2,000,000 cap.
//
// Nothing here opens a socket, launches a browser or calls a provider.

const EXECUTOR = readFileSync("src/server/engine/s4-executor.ts", "utf-8");
const PHASES = readFileSync("src/server/engine/acquisition-phases.ts", "utf-8");
const POLICY = readFileSync("src/server/engine/acquisition-fallback-policy.ts", "utf-8");

describe("1/8. the same planner serves both executors", () => {
  it("the policy lives in one module and is imported, never restated", () => {
    expect(POLICY).toContain("export function plannedFallbacks(");
    for (const caller of [EXECUTOR, PHASES]) {
      expect(caller).toContain('from "./acquisition-fallback-policy"');
      // A second copy of the decision is exactly what must not exist.
      expect(caller).not.toContain("export function plannedFallbacks(");
    }
  });

  it("the single-process path asks it on a fetch failure", () => {
    expect(EXECUTOR).toContain("plannedFallbacks(");
    const failureBranch = EXECUTOR.indexOf("lastFetchFailureReason = fetchResult.reason;");
    expect(EXECUTOR.indexOf("plannedFallbacks(")).toBeGreaterThan(failureBranch);
  });

  it("8: the phased path still reaches the identical function", () => {
    // Re-exported, so every existing phased caller and contract test keeps
    // its import surface unchanged.
    expect(PHASES).toContain('export { plannedFallbacks } from "./acquisition-fallback-policy";');
  });
});

describe("2. TOO_LARGE recovery is bounded and earned", () => {
  it("a first TOO_LARGE buys negotiation only", () => {
    expect(plannedFallbacks("TOO_LARGE", null, "DIRECT_HTTP")).toEqual(["CONTENT_NEGOTIATION"]);
    expect(plannedFallbacks("TOO_LARGE", null)).toEqual(["CONTENT_NEGOTIATION"]);
  });

  it("only an ALSO-oversized negotiated representation buys the render", () => {
    expect(plannedFallbacks("TOO_LARGE", null, "CONTENT_NEGOTIATION")).toEqual(["ISOLATED_RENDER"]);
  });

  it("the chain cannot exceed two fallbacks, and the executor counts against that", () => {
    expect(MAX_FALLBACK_ATTEMPTS_PER_URL).toBe(2);
    expect(EXECUTOR).toContain("fbUsed < MAX_FALLBACK_ATTEMPTS_PER_URL");
    // Each strategy at most once.
    expect(EXECUTOR).toContain("fbTried.add(nextStrategy)");
    expect(EXECUTOR).toContain("!fbTried.has(strategy)");
  });

  it("security stops remain absolute", () => {
    expect(plannedFallbacks("BLOCKED_ADDRESS", null, "DIRECT_HTTP")).toEqual([]);
    expect(plannedFallbacks("REDIRECT_TARGET_BLOCKED", null, "DIRECT_HTTP")).toEqual([]);
    expect(plannedFallbacks(null, null, "DIRECT_HTTP")).toEqual([]);
  });
});

describe("3/6. the renderer is reachable only where policy and config permit", () => {
  const confirmedRoute = {
    officiality: "CONFIRMED" as const,
    routeClass: "OFFICIAL_DOCS" as const,
    matchedPathPrefix: "/pump-token",
  };

  it("disabled configuration refuses before anything else", () => {
    const gate = routeEligibility("https://example.org/pump-token", confirmedRoute as never, false);
    expect(gate.eligible).toBe(false);
    if (!gate.eligible) expect(gate.reason).toBe("RENDERER_DISABLED");
  });

  it("the route bar is not lowered — CONFIRMED + OFFICIAL_DOCS + prefix still required", () => {
    const claimed = routeEligibility(
      "https://example.org/pump-token",
      { ...confirmedRoute, officiality: "CLAIMED" } as never,
      true,
    );
    expect(claimed.eligible).toBe(false);
    if (!claimed.eligible) expect(claimed.reason).toBe("NOT_CONFIRMED");

    const notDocs = routeEligibility(
      "https://example.org/pump-token",
      { ...confirmedRoute, routeClass: "OFFICIAL_REPORT" } as never,
      true,
    );
    expect(notDocs.eligible).toBe(false);
    if (!notDocs.eligible) expect(notDocs.reason).toBe("NOT_OFFICIAL_DOCS");

    expect(
      routeEligibility("http://example.org/pump-token", confirmedRoute as never, true).eligible,
    ).toBe(false);
  });

  it("the executor asks the same two gates the phased path asks, chosen the same way", () => {
    expect(EXECUTOR).toContain("evaluateRefusalRenderEligibility({");
    expect(EXECUTOR).toContain("routeEligibility(");
    expect(EXECUTOR).toContain("renderedDocsEnabled() && renderedDocsAvailable()");
  });

  it("6: a render failure is caught, observed and never becomes evidence", () => {
    expect(EXECUTOR).toContain("DOCS_RENDER_AFTER_FETCH_FAILURE_FAILED");
    expect(EXECUTOR).toContain("renderFailureObservation(");
  });
});

describe("4/5. a full href survives a truncated display form, and earns nothing by it", () => {
  // Synthetic, generic, and deliberately not PUMP: the pattern is a page
  // that elides an identifier for display while stating it completely in
  // the href. Base58, 44 chars, no PUMP address anywhere.
  const FULL = "7YtWq3ZmKdRb9nGfHxPvL2sTcAeUj4XoM6iNrDy1BzQK";
  const html = `
    <h2>Burn addresses</h2>
    <a href="https://explorer.example/address/${FULL}">7YtWq3…1BzQK</a>
  `;

  it("4: link recovery keeps the complete identifier the text elides", () => {
    const result = extractDocumentLinks(html);
    const hrefs = JSON.stringify(result);
    expect(hrefs).toContain(FULL);
    // The visible text alone is not an identifier, and is refused as one.
    expect(isTruncatedDisplayForm("7YtWq3…1BzQK")).toBe(true);
    expect(completeIdentifierShape("7YtWq3…1BzQK")).toBeNull();
  });

  it("5: the recovered value passes the ordinary shape rule, with no bypass", () => {
    // It is admitted because it IS a complete identifier, not because of
    // where it came from. Nothing about link recovery confers authority.
    expect(completeIdentifierShape(FULL)).toBe("ADDRESS_LIKE");
    expect(isTruncatedDisplayForm(FULL)).toBe(false);
    // resolveTruncatedText is an observation helper; it cannot approve.
    expect(typeof resolveTruncatedText).toBe("function");
  });

  it("5: no PUMP-specific bypass exists in the changed surface", () => {
    // Scoped to what this change ADDED. Elsewhere in the executor a real
    // address appears inside an explanatory comment about truncated
    // display forms, which is documentation of the motivating case and
    // this repository's normal style — never a branch.
    const chain = EXECUTOR.slice(
      EXECUTOR.indexOf("THE SHARED FALLBACK CHAIN"),
      EXECUTOR.indexOf("RENDER ON REFUSAL"),
    );
    for (const src of [chain, POLICY]) {
      for (const marker of ["pump.fun", "pumpCmXq", "99mRw3", "9jHrTC"]) {
        expect(src).not.toContain(marker);
      }
    }
    // And no host, project or slug decides anything in either.
    for (const src of [chain, POLICY]) {
      expect(src).not.toContain("projectSlug");
      expect(src).not.toContain("hostname ===");
    }
  });
});

describe("7. no ceiling moves", () => {
  it("the executor reserves every fallback against the SAME documentary ceiling", () => {
    const chain = EXECUTOR.slice(
      EXECUTOR.indexOf("THE SHARED FALLBACK CHAIN"),
      EXECUTOR.indexOf("RENDER ON REFUSAL"),
    );
    // Two reservations — negotiation and render — both bounded by the
    // documentary ceiling the reservation already computed.
    expect(chain.split("documentaryMaxSourceOpens").length - 1).toBe(2);
    // No raw job ceiling, and no new axis.
    expect(chain).not.toContain("ctx.budget.maxSourceOpens");
    expect(chain).not.toContain("maxModelCostMicro");
  });

  it("the transport cap itself is untouched", () => {
    const fetcher = readFileSync("src/server/engine/providers/content-fetcher.ts", "utf-8");
    expect(fetcher).toContain("const DEFAULT_MAX_BYTES = 2_000_000;");
  });
});
