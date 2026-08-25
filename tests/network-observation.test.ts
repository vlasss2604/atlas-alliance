import { describe, expect, it } from "vitest";

import {
  isCapturableContentType,
  isSameOrigin,
  mayCaptureBody,
  MAX_BODY_BYTES,
  MAX_OBSERVATIONS,
  MAX_TOTAL_BODY_BYTES,
  NetworkObservationCollector,
} from "../src/server/engine/providers/network-observation";

// PASSIVE NETWORK OBSERVATION.
//
// A rendered page shows values it fetched from somewhere. When the settled
// DOM carries no machine-readable identifier, what the page ITSELF asked
// for is the remaining question — and it is answerable without asking for
// anything new, because the browser already made those requests to render
// the page we were already allowed to render.
//
// The guarantee is structural: this module has no fetch, no page handle and
// no request object. It cannot issue, replay, modify or continue anything.
// It is handed metadata about responses that already arrived and decides
// what may be written down.

const HOST = "docs.example-project.test";

function collector() {
  return new NetworkObservationCollector(HOST);
}

function response(over: Partial<Parameters<NetworkObservationCollector["record"]>[0]> = {}) {
  return {
    url: `https://${HOST}/api/rows`,
    method: "GET",
    resourceType: "fetch",
    status: 200,
    contentType: "application/json",
    contentLength: 100,
    body: '{"rows":[]}',
    ...over,
  };
}

describe("1/2/3/12. the observer issues nothing", () => {
  it("1/12. the module has no fetch, request or navigation capability at all", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/network-observation.ts", import.meta.url),
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
      "fetch(",
      "page.",
      "goto",
      "click",
      "evaluate",
      "route.continue",
      "request.continue",
      "XMLHttpRequest",
      "axios",
      "http.get",
    ]) {
      expect(code, `observer references "${banned}"`).not.toContain(banned);
    }
  });

  it("2/3. the renderer still performs exactly ONE navigation and no page interaction", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/rendered-docs-playwright.ts", import.meta.url),
      "utf-8",
    );
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect((code.match(/page\.goto\(/g) ?? []).length).toBe(1);
    for (const banned of [".click(", ".evaluate(", ".fill(", "waitForSelector", "nextPage", "$$eval"]) {
      expect(code, `renderer contains "${banned}"`).not.toContain(banned);
    }
    // The observer reads a buffered body; it never continues or replays a
    // request. `res.text()` is a reader, and it is the only call made on a
    // response object beyond metadata accessors.
    expect(code).toContain("res?.text?.()");
    expect(code).not.toContain("res.request().continue");
  });

  it("observation is OFF by default — an ordinary render records nothing", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/rendered-docs-playwright.ts", import.meta.url),
      "utf-8",
    );
    expect(raw).toContain("deps.observeNetwork");
    expect(raw).toContain("const observer = deps.observeNetwork");
    // Null observer means the handler returns before touching anything.
    expect(raw).toContain("if (!observer) return;");
  });
});

describe("4/5/6. body policy", () => {
  it("4. a same-origin textual body is captured", () => {
    const c = collector();
    c.record(response());
    const [o] = c.result().observations;
    expect(o.sameOrigin).toBe(true);
    expect(o.body).toBe('{"rows":[]}');
  });

  it("5. a CROSS-ORIGIN body is never adopted, though the request is noted", () => {
    const c = collector();
    c.record(response({ url: "https://other.invalid/api/rows" }));
    const [o] = c.result().observations;
    expect(o.sameOrigin).toBe(false);
    expect(o.body).toBeNull();
    // The metadata survives — knowing the page reached out is the point.
    expect(o.url).toBe("https://other.invalid/api/rows");
    expect(o.status).toBe(200);
  });

  it("5. a subdomain is NOT the same origin", () => {
    expect(isSameOrigin(`https://${HOST}/x`, HOST)).toBe(true);
    expect(isSameOrigin(`https://www.${HOST}/x`, HOST)).toBe(true);
    expect(isSameOrigin(`https://api.${HOST}/x`, HOST)).toBe(false);
    expect(isSameOrigin("https://evil.test/x", HOST)).toBe(false);
    // The classic suffix trap.
    expect(isSameOrigin(`https://${HOST}.evil.test/x`, HOST)).toBe(false);
  });

  it("6. a binary body is ignored — the content-type allowlist decides", () => {
    for (const contentType of [
      "image/png",
      "font/woff2",
      "application/octet-stream",
      "video/mp4",
      "application/wasm",
      "text/html",
      null,
      "",
    ]) {
      expect(isCapturableContentType(contentType), String(contentType)).toBe(false);
      const c = collector();
      c.record(response({ contentType, body: "binary-ish" }));
      expect(c.result().observations[0].body, String(contentType)).toBeNull();
    }
  });

  it("6. textual types are captured, parameters and case tolerated", () => {
    for (const contentType of [
      "application/json",
      "APPLICATION/JSON; charset=utf-8",
      "text/plain;charset=UTF-8",
      "text/x-component",
      "application/x-ndjson",
    ]) {
      expect(isCapturableContentType(contentType), contentType).toBe(true);
    }
  });

  it("the policy is decidable without a browser", () => {
    expect(
      mayCaptureBody({ url: `https://${HOST}/a.json`, confirmedHost: HOST, contentType: "application/json" }),
    ).toBe(true);
    expect(
      mayCaptureBody({ url: "https://x.invalid/a.json", confirmedHost: HOST, contentType: "application/json" }),
    ).toBe(false);
  });
});

describe("7. nothing secret is capturable", () => {
  it("the observation shape has no field for headers, cookies or credentials", () => {
    const c = collector();
    c.record(response());
    const keys = Object.keys(c.result().observations[0]);
    for (const banned of [
      "headers",
      "requestHeaders",
      "cookies",
      "cookie",
      "authorization",
      "storage",
      "localStorage",
      "credentials",
      "postData",
    ]) {
      expect(keys, `observation exposes "${banned}"`).not.toContain(banned);
    }
    expect(keys.sort()).toEqual(
      [
        "url",
        "method",
        "resourceType",
        "status",
        "contentType",
        "contentLength",
        "sameOrigin",
        "body",
        "bodyTruncated",
      ].sort(),
    );
  });

  it("record() has no parameter through which a header could arrive", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/network-observation.ts", import.meta.url),
      "utf-8",
    );
    // EXECUTABLE code only: the module comment names cookies and
    // authorization to say it never captures them, and prose describing
    // the absence of a thing must not read as the thing.
    const code = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
      .toLowerCase();
    for (const banned of ["requestheaders", "cookie", "authorization", "setcookie"]) {
      expect(code, banned).not.toContain(banned);
    }
  });
});

describe("8/9. caps", () => {
  it("8. a per-response cap truncates, visibly", () => {
    const c = collector();
    c.record(response({ body: "x".repeat(MAX_BODY_BYTES + 5_000) }));
    const [o] = c.result().observations;
    expect(o.body!.length).toBe(MAX_BODY_BYTES);
    expect(o.bodyTruncated).toBe(true);
  });

  it("9. an aggregate cap stops further bodies while still recording metadata", () => {
    const c = collector();
    const chunk = "y".repeat(MAX_BODY_BYTES);
    const needed = Math.ceil(MAX_TOTAL_BODY_BYTES / MAX_BODY_BYTES) + 2;
    for (let i = 0; i < needed; i += 1) {
      c.record(response({ url: `https://${HOST}/r${i}`, body: chunk }));
    }
    const { observations, totalBodyBytes } = c.result();
    expect(totalBodyBytes).toBeLessThanOrEqual(MAX_TOTAL_BODY_BYTES);
    // Later responses still appear — only their bodies are withheld.
    const withoutBody = observations.filter((o) => o.body === null);
    expect(withoutBody.length).toBeGreaterThan(0);
    for (const o of withoutBody) expect(o.bodyTruncated).toBe(true);
  });

  it("the number of observations is itself bounded", () => {
    const c = collector();
    for (let i = 0; i < MAX_OBSERVATIONS + 25; i += 1) {
      c.record(response({ url: `https://${HOST}/n${i}`, body: null }));
    }
    const { observations, droppedCount } = c.result();
    expect(observations.length).toBe(MAX_OBSERVATIONS);
    expect(droppedCount).toBe(25);
  });
});

describe("10/11/13. authority and independence", () => {
  it("10. an observation carries no authority field of any kind", () => {
    const c = collector();
    c.record(response());
    const keys = Object.keys(c.result().observations[0]);
    for (const banned of [
      "sourceClass",
      "officiality",
      "routeClass",
      "trusted",
      "official",
      "authority",
      "evidence",
    ]) {
      expect(keys, `observation exposes "${banned}"`).not.toContain(banned);
    }
  });

  it("11. an identifier-shaped string in a body gains nothing by being observed", () => {
    // A body may contain anything; capturing it classifies nothing.
    const signature = "5".repeat(88);
    const c = collector();
    c.record(response({ body: JSON.stringify({ tx: signature }) }));
    const [o] = c.result().observations;
    expect(o.body).toContain(signature);
    // No shape field, no identifier field, nothing derived from content.
    expect(Object.keys(o)).not.toContain("identifiers");
    expect(Object.keys(o)).not.toContain("shape");
  });

  it("13. no project-specific runtime logic", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(
      new URL("../src/server/engine/providers/network-observation.ts", import.meta.url),
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
      expect(code, `observer mentions "${banned}"`).not.toContain(banned);
    }
  });
});
