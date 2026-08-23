import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createContentFetcher,
  createPinnedLookup,
} from "../src/server/engine/providers/content-fetcher";

// D-126 — first real owner-alpha research run burned its ENTIRE sourceOpens
// budget (24/24) on fetches that all failed with NETWORK_ERROR
// "Invalid IP address: undefined", accepted zero evidence, and terminated
// BUDGET_LIMIT_REACHED without ever reaching EvidenceExtractor/S5/S6/S7.
//
// Cause: the `lookup` handed to http/https.request pins the connection to
// an already-SSRF-validated IP, but ignored Node's `options.all` contract.
// Node >= 20 enables autoSelectFamily (Happy Eyeballs) by DEFAULT, and in
// that mode net.connect calls lookup with `{ all: true }` and requires an
// ARRAY of { address, family }. The old code always answered with the bare
// (address, family) form, so Node read `.address` off a string -> undefined.
//
// Why the existing 35-test suite missed it entirely: Node skips `lookup`
// altogether when the host is a literal IP, and every existing test fetches
// http://127.0.0.1:<port>. Real research URLs are always hostnames, so
// production hit the broken branch 100% of the time while tests stayed green.
describe("content fetcher — pinned lookup honors Node's `all` contract (D-126)", () => {
  it("returns an ARRAY of {address, family} when options.all is true (autoSelectFamily path)", () => {
    const lookup = createPinnedLookup("127.0.0.1");
    let err: unknown = "unset";
    let addresses: unknown = "unset";
    lookup("example.invalid", { all: true }, (e, a) => {
      err = e;
      addresses = a;
    });
    expect(err).toBeNull();
    expect(Array.isArray(addresses)).toBe(true);
    expect(addresses).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });

  it("returns the bare (address, family) form when options.all is falsy", () => {
    const lookup = createPinnedLookup("127.0.0.1");
    let address: unknown = "unset";
    let family: unknown = "unset";
    lookup("example.invalid", {}, (_e, a, f) => {
      address = a;
      family = f;
    });
    expect(address).toBe("127.0.0.1");
    expect(family).toBe(4);
  });

  it("reports family 6 for an IPv6 pin, in both call shapes", () => {
    const lookup = createPinnedLookup("::1");
    let all: unknown = "unset";
    lookup("example.invalid", { all: true }, (_e, a) => {
      all = a;
    });
    expect(all).toEqual([{ address: "::1", family: 6 }]);

    let bare: unknown = "unset";
    let bareFamily: unknown = "unset";
    lookup("example.invalid", undefined, (_e, a, f) => {
      bare = a;
      bareFamily = f;
    });
    expect(bare).toBe("::1");
    expect(bareFamily).toBe(6);
  });

  // End-to-end proof through the REAL http stack: a hostname host (not a
  // literal IP) forces Node to call our lookup under its default
  // autoSelectFamily behaviour — exactly the production path that failed.
  // No DNS and no external network: our own lookup answers for the
  // hostname, and the request lands on a local server.
  describe("real request through the http stack with a hostname host", () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>pinned lookup works</body></html>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("connects and returns content when the URL host is a hostname", async () => {
      // isAddressBlocked is overridden exactly as the existing suite does,
      // so this exercises HTTP/lookup mechanics rather than address policy.
      // The hostname resolves through the system resolver in
      // resolveAndValidate, so we use a name that really does resolve to
      // IPv4 loopback on every platform: the literal-IP form is avoided by
      // going through http.request directly with our pinned lookup.
      const req = http.request({
        hostname: "atlas-pinned-lookup.invalid",
        port,
        path: "/",
        method: "GET",
        lookup: createPinnedLookup("127.0.0.1") as never,
      });
      const body = await new Promise<string>((resolve, reject) => {
        req.on("response", (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        });
        req.on("error", reject);
        req.end();
      });
      expect(body).toContain("pinned lookup works");
    });

    it("literal-IP host still works through the full fetcher (unchanged behaviour)", async () => {
      const fetcher = createContentFetcher({ isAddressBlocked: () => false });
      const doc = await fetcher.fetch(`http://127.0.0.1:${port}/`);
      expect(doc.normalizedText).toBe("pinned lookup works");
      expect(doc.httpStatus).toBe(200);
    });
  });
});
