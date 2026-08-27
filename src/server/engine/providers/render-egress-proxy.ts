import * as http from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Socket } from "node:net";
import { connect as netConnect, isIP } from "node:net";

import { isBlockedIp } from "./content-fetcher";

// The renderer's EGRESS BOUNDARY.
//
// Why this exists even though the adapter already filters requests: a
// browser resolves DNS and opens sockets itself. page.route() interception
// is an in-process convenience that a renderer bug, a Playwright change,
// or any code path that bypasses the route handler could sidestep. Relying
// on it alone would make "the browser cannot reach the internet" a
// statement about our code rather than about the network.
//
// So the browser is launched with --proxy-server pointing here and an
// EMPTY bypass list, and this proxy is deny-by-default. Anything it does
// not explicitly allow never leaves the machine, regardless of what the
// browser or the page attempts.
//
// HTTPS is filtered at CONNECT: the proxy sees `host:port` before the TLS
// tunnel is established, which is exactly enough to allow or deny by host
// WITHOUT terminating TLS. We never MITM, never see plaintext, and never
// need a certificate — the boundary is about destination, not content.

export type EgressDenialReason =
  | "NOT_HTTPS"
  | "HOST_NOT_CONFIRMED"
  | "BLOCKED_ADDRESS"
  | "DNS_FAILED"
  | "MALFORMED_TARGET";

export type EgressDecision =
  | { allow: true; host: string; port: number; address: string }
  | { allow: false; reason: EgressDenialReason };

export interface EgressPolicy {
  confirmedHost: string;
  // Injectable so the offline suite performs no DNS query.
  lookup?: (host: string) => Promise<{ address: string }>;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

// Parses a CONNECT target ("host:443", "[::1]:443").
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  if (!target || target.length > 300) return null;
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target.trim());
  if (!m) return null;
  const host = m[1].startsWith("[") ? m[1].slice(1, -1) : m[1];
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

// The single decision function. Deny-by-default: every path that is not an
// explicit allow returns a denial, including anything unexpected.
export async function decideEgress(
  target: string,
  policy: EgressPolicy,
): Promise<EgressDecision> {
  const parsed = parseConnectTarget(target);
  if (!parsed) return { allow: false, reason: "MALFORMED_TARGET" };
  // https only — 443 is the only port that can carry it.
  if (parsed.port !== 443) return { allow: false, reason: "NOT_HTTPS" };
  if (normalizeHost(parsed.host) !== normalizeHost(policy.confirmedHost)) {
    // Cross-origin, including CDNs, dies here — not in the browser.
    return { allow: false, reason: "HOST_NOT_CONFIRMED" };
  }
  // DNS is validated AT THE BOUNDARY, not in the browser, so a page cannot
  // reach a private address by resolving one itself.
  let address: string;
  try {
    if (isIP(parsed.host)) address = parsed.host;
    else address = (await (policy.lookup ?? dnsLookup)(parsed.host)).address;
  } catch {
    return { allow: false, reason: "DNS_FAILED" };
  }
  if (isBlockedIp(address)) return { allow: false, reason: "BLOCKED_ADDRESS" };
  return { allow: true, host: parsed.host, port: parsed.port, address };
}

export interface EgressProxyHandle {
  port: number;
  // Every decision made, for assertion and for the render's audit trail.
  decisions: { target: string; allowed: boolean; reason?: EgressDenialReason }[];
  close(): Promise<void>;
}

// The closed list, as a runtime array so a summary can enumerate it and a
// caller can check membership. The type above stays the source of truth;
// `satisfies` makes the two impossible to drift apart.
export const EGRESS_DENIAL_REASONS = [
  "NOT_HTTPS",
  "HOST_NOT_CONFIRMED",
  "BLOCKED_ADDRESS",
  "DNS_FAILED",
  "MALFORMED_TARGET",
] as const satisfies readonly EgressDenialReason[];

// WHAT MAY LEAVE THE PROXY'S LOG: counts, and nothing else.
//
// A decision record carries a raw `target` — a `host:port` the browser
// asked for. That is exactly the material this boundary exists to keep
// out of diagnostics, so the summary is built by COUNTING and the strings
// are never copied, formatted or returned. There is no field here that
// could hold one.
//
// Every reason key is always present, so "no denial of this kind" and
// "no summary at all" are different observations rather than the same
// silence. `allowedCount` distinguishes a proxy that saw traffic and
// permitted it from one that was never consulted at all — an integer, not
// target metadata.
export interface EgressDenialSummary {
  denials: Record<EgressDenialReason, number>;
  deniedCount: number;
  allowedCount: number;
  // How many distinct denial classes fired. One class repeated is a
  // different picture from several classes at once.
  distinctDenialClasses: number;
}

export function summarizeEgressDenials(
  decisions: readonly { allowed: boolean; reason?: string }[],
): EgressDenialSummary {
  const denials = Object.fromEntries(
    EGRESS_DENIAL_REASONS.map((r) => [r, 0]),
  ) as Record<EgressDenialReason, number>;
  let deniedCount = 0;
  let allowedCount = 0;
  for (const d of decisions) {
    if (d.allowed) {
      allowedCount += 1;
      continue;
    }
    deniedCount += 1;
    // Only a member of the closed list is counted. An unrecognised value
    // is dropped rather than becoming a key — a record whose keys came
    // from data would be a record that can carry data.
    const reason = d.reason;
    if (typeof reason === "string" && reason in denials) {
      denials[reason as EgressDenialReason] += 1;
    }
  }
  const distinctDenialClasses = EGRESS_DENIAL_REASONS.filter((r) => denials[r] > 0).length;
  return { denials, deniedCount, allowedCount, distinctDenialClasses };
}

// Starts the proxy on an ephemeral loopback port. Bound to 127.0.0.1 so
// nothing outside this machine can use it as an open relay.
export async function startEgressProxy(policy: EgressPolicy): Promise<EgressProxyHandle> {
  const decisions: EgressProxyHandle["decisions"] = [];

  const server = http.createServer((_req, res) => {
    // A plain (non-CONNECT) HTTP request through the proxy is http://,
    // which this boundary does not carry at all.
    decisions.push({ target: "http-request", allowed: false, reason: "NOT_HTTPS" });
    res.writeHead(403);
    res.end();
  });

  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    const target = req.url ?? "";
    void decideEgress(target, policy).then((decision) => {
      if (!decision.allow) {
        decisions.push({ target, allowed: false, reason: decision.reason });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      decisions.push({ target, allowed: true });
      // Connect to the VALIDATED ADDRESS, not the hostname — the browser
      // cannot re-resolve behind our back, closing the same rebinding
      // window the static fetcher's pinned lookup closes.
      const upstream = netConnect(decision.port, decision.address, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const kill = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.on("error", kill);
      clientSocket.on("error", kill);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    decisions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
