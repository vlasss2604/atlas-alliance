import { describe, expect, it } from "vitest";

import {
  EGRESS_DENIAL_REASONS,
  decideEgress,
  summarizeEgressDenials,
  type EgressProxyHandle,
} from "../src/server/engine/providers/render-egress-proxy";
import { RenderedDocsError } from "../src/server/engine/providers/rendered-docs-fetcher";
import { createIsolatedRenderedDocsFetcher } from "../src/server/engine/providers/rendered-docs-isolated";

// THE PROXY HAS BEEN WATCHING ALL ALONG.
//
// The egress boundary records every decision it makes, with a closed
// code-owned denial vocabulary — and the isolated renderer opened the
// proxy, held the handle, and dropped the entire log in its `finally`.
// A live window came back saying UNCLASSIFIED_NAVIGATION_ERROR while the
// answer to "did WE refuse it, and why" was sitting in memory, unread.
// Fourth instance of one defect: information produced and discarded.
//
// What must NOT come with it: a decision record carries a raw `target`,
// a `host:port` the browser asked for, and an allow-decision carries the
// resolved address. That is exactly the material this boundary exists to
// keep out of a diagnostic. So only COUNTS cross — the summary has no
// field that could hold a string.
//
// And it is an INDEPENDENT witness, never a replacement. What Chromium
// reported and what our containment decided are two different
// observations, and the point is being able to read both.

const HOST = "docs.proxy-diagnostics.test";
const URL_IN = `https://${HOST}/token/economics`;
const ROUTE = { confirmedHost: HOST, matchedPathPrefix: "/token" };

// Planted in every raw field a decision record carries.
const SECRET_HOST = "secret-internal.corp.test";
const SECRET_ADDR = "10.11.12.13";
const SECRET_PORT = 8443;
const SECRET_TARGET = `${SECRET_HOST}:${SECRET_PORT}`;
const SECRET_MSG = "Bearer sk-live-QQ11WW22EE33";

type Decision = EgressProxyHandle["decisions"][number];

const denial = (reason: Decision["reason"], target = SECRET_TARGET): Decision => ({
  target,
  allowed: false,
  reason,
});
const allow = (target = SECRET_TARGET): Decision => ({ target, allowed: true });

describe("1. the summary is counts, and structurally nothing else", () => {
  it("every closed reason key is always present, so zero is explicit", () => {
    const s = summarizeEgressDenials([]);
    for (const r of EGRESS_DENIAL_REASONS) expect(s.denials[r]).toBe(0);
    expect(Object.keys(s.denials).sort()).toEqual([...EGRESS_DENIAL_REASONS].sort());
    expect(s.deniedCount).toBe(0);
    expect(s.allowedCount).toBe(0);
    expect(s.distinctDenialClasses).toBe(0);
  });

  it("each denial class is surfaced only as its closed code and a count", () => {
    for (const reason of EGRESS_DENIAL_REASONS) {
      const s = summarizeEgressDenials([denial(reason)]);
      expect(s.denials[reason]).toBe(1);
      expect(s.deniedCount).toBe(1);
      expect(s.distinctDenialClasses).toBe(1);
      // Every other class stays explicitly zero.
      for (const other of EGRESS_DENIAL_REASONS) {
        if (other !== reason) expect(s.denials[other]).toBe(0);
      }
    }
  });

  it("multiple decisions aggregate, and repeated versus varied is distinguishable", () => {
    const repeated = summarizeEgressDenials([
      denial("DNS_FAILED"),
      denial("DNS_FAILED"),
      denial("DNS_FAILED"),
    ]);
    expect(repeated.denials.DNS_FAILED).toBe(3);
    expect(repeated.deniedCount).toBe(3);
    expect(repeated.distinctDenialClasses).toBe(1);

    const varied = summarizeEgressDenials([
      denial("DNS_FAILED"),
      denial("BLOCKED_ADDRESS"),
      denial("HOST_NOT_CONFIRMED"),
      allow(),
      allow(),
    ]);
    expect(varied.deniedCount).toBe(3);
    expect(varied.allowedCount).toBe(2);
    expect(varied.distinctDenialClasses).toBe(3);
  });

  it("allowed-only traffic is distinguishable from no traffic at all", () => {
    // Two very different situations: the proxy permitted requests and the
    // failure was downstream, versus the proxy was never consulted.
    const permitted = summarizeEgressDenials([allow(), allow()]);
    expect(permitted.deniedCount).toBe(0);
    expect(permitted.allowedCount).toBe(2);
    const silent = summarizeEgressDenials([]);
    expect(silent.allowedCount).toBe(0);
  });

  it("NOTHING from a decision record survives except counts", () => {
    const s = summarizeEgressDenials([
      denial("BLOCKED_ADDRESS"),
      allow(),
      // A hostile record with extra fields a future proxy might add.
      {
        ...denial("DNS_FAILED"),
        host: SECRET_HOST,
        address: SECRET_ADDR,
        port: SECRET_PORT,
      } as Decision,
    ]);
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain(SECRET_HOST);
    expect(serialized).not.toContain(SECRET_ADDR);
    expect(serialized).not.toContain(String(SECRET_PORT));
    expect(serialized).not.toContain(SECRET_TARGET);
    // Every value in the whole structure is a number.
    for (const v of Object.values(s.denials)) expect(typeof v).toBe("number");
    for (const k of ["deniedCount", "allowedCount", "distinctDenialClasses"] as const) {
      expect(typeof s[k]).toBe("number");
    }
  });

  it("an unrecognised reason is counted as a denial but never becomes a key", () => {
    // A key taken from data would be a key that can carry data.
    const s = summarizeEgressDenials([
      { target: SECRET_TARGET, allowed: false, reason: SECRET_HOST } as unknown as Decision,
    ]);
    expect(s.deniedCount).toBe(1);
    expect(Object.keys(s.denials).sort()).toEqual([...EGRESS_DENIAL_REASONS].sort());
    expect(JSON.stringify(s)).not.toContain(SECRET_HOST);
  });
});

describe("2. the error rebuilds the summary rather than adopting it", () => {
  it("a summary carrying extra fields cannot smuggle them in", () => {
    const hostile = {
      denials: { DNS_FAILED: 1, target: SECRET_TARGET },
      deniedCount: 1,
      allowedCount: 0,
      distinctDenialClasses: 1,
      host: SECRET_HOST,
      address: SECRET_ADDR,
    } as never;
    const e = new RenderedDocsError("RENDER_FAILED", "isolated", null, null, null, hostile);
    expect(JSON.stringify(e.proxyDenials)).not.toContain(SECRET_HOST);
    expect(JSON.stringify(e.proxyDenials)).not.toContain(SECRET_TARGET);
    expect(JSON.stringify(e.proxyDenials)).not.toContain(SECRET_ADDR);
    expect(e.proxyDenials?.denials.DNS_FAILED).toBe(1);
    expect(Object.keys(e.proxyDenials!.denials).sort()).toEqual([...EGRESS_DENIAL_REASONS].sort());
  });

  it("non-integer and negative counts are coerced, not trusted", () => {
    const e = new RenderedDocsError("RENDER_FAILED", "isolated", null, null, null, {
      denials: { DNS_FAILED: -5, BLOCKED_ADDRESS: 1.5, HOST_NOT_CONFIRMED: "3" },
      deniedCount: -1,
      allowedCount: Number.NaN,
      distinctDenialClasses: 99,
    } as never);
    expect(e.proxyDenials?.denials.DNS_FAILED).toBe(0);
    expect(e.proxyDenials?.denials.BLOCKED_ADDRESS).toBe(0);
    expect(e.proxyDenials?.denials.HOST_NOT_CONFIRMED).toBe(0);
    expect(e.proxyDenials?.deniedCount).toBe(0);
    expect(e.proxyDenials?.allowedCount).toBe(0);
    // Recomputed from the counts, never taken on trust.
    expect(e.proxyDenials?.distinctDenialClasses).toBe(0);
  });

  it("absent stays absent — null is different from all-zero", () => {
    expect(new RenderedDocsError("RENDER_FAILED").proxyDenials).toBeNull();
    const zeroed = new RenderedDocsError(
      "RENDER_FAILED",
      "isolated",
      null,
      null,
      null,
      summarizeEgressDenials([]),
    );
    expect(zeroed.proxyDenials).not.toBeNull();
    expect(zeroed.proxyDenials?.deniedCount).toBe(0);
  });

  it("withProxyDenials preserves every other classification untouched", () => {
    const before = new RenderedDocsError("NAVIGATION_FAILED", "iso", null, null, "NAVIGATION_TIMEOUT");
    const after = before.withProxyDenials(summarizeEgressDenials([denial("DNS_FAILED")]));
    expect(after.reason).toBe("NAVIGATION_FAILED");
    expect(after.navigationDiagnostic).toBe("NAVIGATION_TIMEOUT");
    expect(after.rendererName).toBe("iso");
    expect(after.proxyDenials?.denials.DNS_FAILED).toBe(1);
    // And the launch vocabulary is carried through, not clobbered.
    const launch = new RenderedDocsError("BROWSER_LAUNCH_FAILED", "iso", "EXECUTABLE_NOT_FOUND");
    expect(launch.withProxyDenials(null).diagnostic).toBe("EXECUTABLE_NOT_FOUND");
    const http = new RenderedDocsError("HTTP_ERROR", "iso", null, 403);
    expect(http.withProxyDenials(null).httpStatus).toBe(403);
  });
});

describe("3. the renderer attaches it to a real failure", () => {
  const PARENT_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };

  function isolatedWith(decisions: Decision[], stdout: string) {
    return createIsolatedRenderedDocsFetcher({
      spawnChild: (async () => ({ stdout, code: 0 })) as never,
      startProxy: (async () => ({
        port: 44997,
        decisions,
        close: async () => {},
      })) as never,
      parentEnv: PARENT_ENV,
    });
  }

  async function failWith(decisions: Decision[]): Promise<RenderedDocsError> {
    const f = isolatedWith(
      decisions,
      JSON.stringify({
        ok: false,
        reason: "NAVIGATION_FAILED",
        navigationDetail: "UNCLASSIFIED_NAVIGATION_ERROR",
      }),
    );
    return (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
  }

  it("an SSRF denial reaches the failure as a count, beside the browser's own verdict", async () => {
    const e = await failWith([denial("BLOCKED_ADDRESS")]);
    // INDEPENDENT observations: neither replaces the other.
    expect(e.reason).toBe("NAVIGATION_FAILED");
    expect(e.navigationDiagnostic).toBe("UNCLASSIFIED_NAVIGATION_ERROR");
    expect(e.proxyDenials?.denials.BLOCKED_ADDRESS).toBe(1);
    expect(e.proxyDenials?.deniedCount).toBe(1);
  });

  it("a DNS denial reaches it the same way", async () => {
    const e = await failWith([denial("DNS_FAILED")]);
    expect(e.proxyDenials?.denials.DNS_FAILED).toBe(1);
  });

  it("an unconfirmed CONNECT host reaches it the same way", async () => {
    const e = await failWith([denial("HOST_NOT_CONFIRMED")]);
    expect(e.proxyDenials?.denials.HOST_NOT_CONFIRMED).toBe(1);
  });

  it("malformed and non-HTTPS denials reach it the same way", async () => {
    const e = await failWith([denial("NOT_HTTPS"), denial("MALFORMED_TARGET")]);
    expect(e.proxyDenials?.denials.NOT_HTTPS).toBe(1);
    expect(e.proxyDenials?.denials.MALFORMED_TARGET).toBe(1);
    expect(e.proxyDenials?.distinctDenialClasses).toBe(2);
  });

  it("zero denials with traffic allowed says the failure was NOT a containment refusal", async () => {
    const e = await failWith([allow(), allow()]);
    expect(e.proxyDenials).not.toBeNull();
    expect(e.proxyDenials?.deniedCount).toBe(0);
    expect(e.proxyDenials?.allowedCount).toBe(2);
  });

  it("no target, host, port or address reaches anything surfaced", async () => {
    const e = await failWith([denial("BLOCKED_ADDRESS"), allow()]);
    const surfaced = JSON.stringify({
      r: e.reason,
      n: e.navigationDiagnostic,
      p: e.proxyDenials,
      m: e.message,
      name: e.name,
    });
    expect(surfaced).not.toContain(SECRET_TARGET);
    expect(surfaced).not.toContain(SECRET_HOST);
    expect(surfaced).not.toContain(SECRET_ADDR);
    expect(surfaced).not.toContain(String(SECRET_PORT));
    expect(surfaced).not.toContain(HOST);
  });

  it("a planted exception message still never leaks", async () => {
    const f = createIsolatedRenderedDocsFetcher({
      spawnChild: (async () => {
        throw new Error(`${SECRET_MSG} at https://${SECRET_HOST}/x`);
      }) as never,
      startProxy: (async () => ({
        port: 44998,
        decisions: [denial("DNS_FAILED")],
        close: async () => {},
      })) as never,
      parentEnv: PARENT_ENV,
    });
    const e = (await f.render(URL_IN, ROUTE).catch((x: unknown) => x)) as RenderedDocsError;
    expect(e.reason).toBe("CHILD_SPAWN_FAILED");
    expect(e.proxyDenials?.denials.DNS_FAILED).toBe(1);
    expect(JSON.stringify({ m: e.message, p: e.proxyDenials })).not.toContain(SECRET_MSG);
    expect(JSON.stringify({ m: e.message, p: e.proxyDenials })).not.toContain(SECRET_HOST);
  });

  it("a SUCCESSFUL render is unaffected — no proxy field on a document", async () => {
    const doc = {
      renderMode: "RENDERED",
      finalUrl: URL_IN,
      normalizedText: "text",
      contentHash: "h",
      byteLength: 4,
      fetchedAt: new Date("2026-08-28T00:00:00Z").toISOString(),
    };
    const f = isolatedWith([allow()], JSON.stringify({ ok: true, document: doc }));
    const out = await f.render(URL_IN, ROUTE);
    expect(out.renderMode).toBe("RENDERED");
    expect(JSON.stringify(out)).not.toContain(SECRET_TARGET);
  });
});

describe("4. the proxy's own policy is untouched", () => {
  // The decisions this task reports on must still be MADE identically.
  // Injected lookup, so no DNS query happens here.
  const lookup = async (host: string) => {
    if (host === "blocked.test") return { address: "10.0.0.5" };
    if (host === "dead.test") throw new Error("nope");
    return { address: "93.184.216.34" };
  };

  it("still allows only the confirmed host, over https, to a public address", async () => {
    await expect(decideEgress(`${HOST}:443`, { confirmedHost: HOST, lookup })).resolves.toMatchObject({
      allow: true,
    });
  });

  it("still refuses an unconfirmed host", async () => {
    await expect(
      decideEgress("elsewhere.test:443", { confirmedHost: HOST, lookup }),
    ).resolves.toMatchObject({ allow: false, reason: "HOST_NOT_CONFIRMED" });
  });

  it("still refuses a private address — the SSRF guard is unchanged", async () => {
    await expect(
      decideEgress("blocked.test:443", { confirmedHost: "blocked.test", lookup }),
    ).resolves.toMatchObject({ allow: false, reason: "BLOCKED_ADDRESS" });
  });

  it("still refuses a non-https port and a malformed target", async () => {
    await expect(
      decideEgress(`${HOST}:80`, { confirmedHost: HOST, lookup }),
    ).resolves.toMatchObject({ allow: false, reason: "NOT_HTTPS" });
    await expect(
      decideEgress("!!!", { confirmedHost: HOST, lookup }),
    ).resolves.toMatchObject({ allow: false, reason: "MALFORMED_TARGET" });
  });

  it("still refuses a host whose DNS fails", async () => {
    await expect(
      decideEgress("dead.test:443", { confirmedHost: "dead.test", lookup }),
    ).resolves.toMatchObject({ allow: false, reason: "DNS_FAILED" });
  });
});
