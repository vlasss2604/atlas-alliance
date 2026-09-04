import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ContentFetchError,
  createContentFetcher,
  isBlockedIp,
} from "../src/server/engine/providers/content-fetcher";
import { evaluateRefusalRenderEligibility } from "../src/server/engine/rendered-docs-policy";

// MARKDOWN AS A DOCUMENT REPRESENTATION — entirely offline.
//
// A first-party document served as Markdown was unreadable by the static
// path, even though the representation is strictly simpler than the HTML
// already accepted. This admits exactly one MIME essence, `text/markdown`,
// and pins the boundary in both directions: what is now accepted, and the
// far larger set that stays refused.
//
// MIME ESSENCE IS NOT AUTHORITY. Nothing here grants officiality, source
// class, project identity or truth — those gates are untouched and are
// asserted as untouched below.
//
// HTTP mechanics run against a local loopback server with the same
// test-only address override the existing ContentFetcher suite uses; the
// SSRF assertions run against the REAL predicate with no override.

let server: http.Server;
let baseUrl: string;

const MD_BODY = "# Buybacks\n\nProtocol fees are routed to the vault.\n";

// Every route is (path, content-type) — the table IS the contract under
// test, so a future edit to the allowlist shows up here as a diff.
const ROUTES: Record<string, string | null> = {
  "/md": "text/markdown",
  "/md-charset": "text/markdown; charset=utf-8",
  "/md-mixed-case": "TEXT/Markdown; CharSet=UTF-8",
  "/md-spaced": "  text/markdown  ; charset=utf-8",
  "/html": "text/html; charset=utf-8",
  "/plain": "text/plain",
  "/json": "application/json",
  "/xml": "application/xml",
  "/octet": "application/octet-stream",
  "/pdf": "application/pdf",
  "/png": "image/png",
  "/mp4": "video/mp4",
  "/mp3": "audio/mpeg",
  "/text-wildcard-probe": "text/x-made-up-subtype",
  "/malformed": ";;;",
  "/empty-ct": "",
  "/missing-ct": null,
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/too-large-md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("x".repeat(5_000));
      return;
    }
    if (path === "/md-500") {
      res.writeHead(500, { "content-type": "text/markdown" });
      res.end(MD_BODY);
      return;
    }
    if (path === "/md-404") {
      res.writeHead(404, { "content-type": "text/markdown" });
      res.end(MD_BODY);
      return;
    }
    if (path === "/redirect-to-md") {
      res.writeHead(302, { location: "/md" });
      res.end();
      return;
    }
    if (path in ROUTES) {
      const ct = ROUTES[path];
      res.writeHead(200, ct === null ? {} : { "content-type": ct });
      res.end(MD_BODY);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const fetcher = createContentFetcher({ isAddressBlocked: () => false });

async function reasonOf(path: string): Promise<string> {
  try {
    await fetcher.fetch(`${baseUrl}${path}`);
    return "OK";
  } catch (e) {
    if (e instanceof ContentFetchError) return e.reason;
    throw e;
  }
}

describe("1-3. text/markdown is admitted, through the existing MIME normalizer", () => {
  it("1. bare text/markdown is accepted and its text is preserved", async () => {
    const doc = await fetcher.fetch(`${baseUrl}/md`);
    expect(doc.contentType).toBe("text/markdown");
    expect(doc.normalizedText).toContain("Protocol fees are routed to the vault.");
    // Markdown takes the text/plain path: kept as text, never HTML-parsed.
    expect(doc.normalizedText).toContain("# Buybacks");
  });

  it("2. a charset parameter is stripped by the existing normalizer", async () => {
    const doc = await fetcher.fetch(`${baseUrl}/md-charset`);
    expect(doc.contentType).toBe("text/markdown");
  });

  it("3. mixed case and surrounding whitespace follow the existing parser contract", async () => {
    for (const p of ["/md-mixed-case", "/md-spaced"]) {
      const doc = await fetcher.fetch(`${baseUrl}${p}`);
      expect(doc.contentType, p).toBe("text/markdown");
    }
  });

  it("the document is bytes and text only — no HTML normalization is applied to it", async () => {
    const doc = await fetcher.fetch(`${baseUrl}/md`);
    // normalizeHtmlToText would have stripped the '#'; the raw text survives.
    expect(doc.normalizedText.startsWith("# Buybacks")).toBe(true);
    expect(doc.byteLength).toBe(Buffer.byteLength(MD_BODY));
    expect(doc.contentHash.startsWith("sha256:")).toBe(true);
    // Stage 0 embedded-payload recovery is text/html-only and did not run.
    expect(doc.embeddedPayload).toBeNull();
  });
});

describe("4-7. every previously accepted type is still accepted", () => {
  it("text/html, text/plain, application/json, application/xml unchanged", async () => {
    for (const [path, expected] of [
      ["/html", "text/html"],
      ["/plain", "text/plain"],
      ["/json", "application/json"],
      ["/xml", "application/xml"],
    ] as const) {
      const doc = await fetcher.fetch(`${baseUrl}${path}`);
      expect(doc.contentType, path).toBe(expected);
    }
  });
});

describe("8-13. everything else stays refused — the allowlist did not become a family", () => {
  it("8/9/10/11. binary, pdf, image, audio and video are all refused", async () => {
    for (const p of ["/octet", "/pdf", "/png", "/mp4", "/mp3"]) {
      expect(await reasonOf(p), p).toBe("UNSUPPORTED_CONTENT_TYPE");
    }
  });

  it("MUTATION CHECK: an unknown text/* subtype is still refused", async () => {
    // The load-bearing assertion. If the allowlist were ever widened to a
    // `text/*` wildcard — or to a prefix match — this passes silently and
    // every future text subtype enters sight-unseen. It must fail there.
    expect(await reasonOf("/text-wildcard-probe")).toBe("UNSUPPORTED_CONTENT_TYPE");
  });

  it("12. a missing Content-Type is refused, unchanged", async () => {
    expect(await reasonOf("/missing-ct")).toBe("UNSUPPORTED_CONTENT_TYPE");
  });

  it("13. an empty or malformed Content-Type is refused, unchanged", async () => {
    expect(await reasonOf("/empty-ct")).toBe("UNSUPPORTED_CONTENT_TYPE");
    expect(await reasonOf("/malformed")).toBe("UNSUPPORTED_CONTENT_TYPE");
  });
});

describe("14-17. the surrounding transport contract is untouched", () => {
  it("14. the byte cap still applies to Markdown, and still wins", async () => {
    let reason = "OK";
    try {
      await fetcher.fetch(`${baseUrl}/too-large-md`, { maxBytes: 100 });
    } catch (e) {
      reason = (e as ContentFetchError).reason;
    }
    // Enforced during streaming, so it fires before the content-type gate
    // is ever consulted — admitting a MIME type cannot raise a size limit.
    expect(reason).toBe("TOO_LARGE");
  });

  it("15. HTTP error handling is unchanged, and outranks the content type", async () => {
    for (const p of ["/md-500", "/md-404"]) {
      expect(await reasonOf(p), p).toBe("HTTP_ERROR");
    }
  });

  it("16. redirects still resolve and stay bounded; a redirect to Markdown lands correctly", async () => {
    const doc = await fetcher.fetch(`${baseUrl}/redirect-to-md`);
    expect(doc.contentType).toBe("text/markdown");
    expect(doc.finalUrl).toBe(`${baseUrl}/md`);
  });

  it("17. SSRF policy is untouched — the REAL predicate, no override", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
  });
});

describe("18. renderer-refusal fallback semantics are unchanged", () => {
  const route = {
    officiality: "CONFIRMED" as const,
    routeClass: "OFFICIAL_DOCS" as const,
    observation: null,
    matchedPathPrefix: "/docs",
  };
  const url = "https://docs.example-project.test/docs/fees";

  it("a content-type failure carries no status and is still NOT a renderable refusal", () => {
    expect(
      evaluateRefusalRenderEligibility({ url, route, rendererEnabled: true, httpStatus: null }),
    ).toMatchObject({ eligible: false, reason: "NOT_A_RENDERABLE_REFUSAL" });
    // 200 is not a refusal either — the set is exactly {401,403,429}.
    expect(
      evaluateRefusalRenderEligibility({ url, route, rendererEnabled: true, httpStatus: 200 }),
    ).toMatchObject({ eligible: false, reason: "NOT_A_RENDERABLE_REFUSAL" });
  });

  it("the refusal statuses themselves are unchanged", () => {
    for (const status of [401, 403, 429]) {
      expect(
        evaluateRefusalRenderEligibility({ url, route, rendererEnabled: true, httpStatus: status }),
        String(status),
      ).toMatchObject({ eligible: true });
    }
    for (const status of [404, 410, 500, 503]) {
      expect(
        evaluateRefusalRenderEligibility({ url, route, rendererEnabled: true, httpStatus: status }),
        String(status),
      ).toMatchObject({ eligible: false, reason: "NOT_A_RENDERABLE_REFUSAL" });
    }
  });
});

describe("19. no project-specific knowledge entered the transport", () => {
  it("the fetcher and its type contract name no project, host or file extension", async () => {
    const fs = await import("node:fs/promises");
    for (const file of [
      "../src/server/engine/providers/content-fetcher.ts",
      "../src/server/engine/providers/types.ts",
    ]) {
      const code = (await fs.readFile(new URL(file, import.meta.url), "utf-8"))
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n")
        .toLowerCase();
      for (const banned of ["raydium", "pump", "solscan", "docs.raydium", ".md"]) {
        expect(code, `${file} mentions "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("authority is never inferred from the representation", async () => {
    // A Markdown document from an unconfirmed host fetches fine — and that
    // is the point: fetching establishes representation, never officiality.
    // Source class and route authority are resolved elsewhere, from the
    // project's confirmed routes, and this change touched none of it.
    const doc = await fetcher.fetch(`${baseUrl}/md`);
    expect(doc.contentType).toBe("text/markdown");
    expect(doc).not.toHaveProperty("sourceClass");
    expect(doc).not.toHaveProperty("officiality");
  });
});
