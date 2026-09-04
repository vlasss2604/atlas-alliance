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

// ---- OPERATOR INSPECTION DIAGNOSTICS (opt-in, never production) -------
//
// The summary above is counts, and that is the right answer for an
// evidentiary render: a denied `host:port` is exactly the material this
// boundary keeps out of logs and trace.
//
// OWNER INSPECTION is a different situation, and conflating the two is
// what produced the observability gap. Inspection is a local, human-driven,
// non-evidentiary act performed on a URL the operator typed, against a
// host a human already confirmed for the project and which is already
// printed to that operator's own terminal by the entrypoint. "1 denied /
// 1 allowed" cannot say WHICH host was refused, so it cannot separate a
// third-party CDN the page pulled from the confirmed host itself — and
// those call for opposite next actions.
//
// So this is a SECOND, WIDER description, reachable only when a caller
// explicitly asks for it, and still deliberately narrow:
//   * host and port, rebuilt through parseConnectTarget — never the raw
//     `target` string, never the resolved `address`, which is the field
//     that could name a private destination;
//   * the closed denial reason, or nothing;
//   * a hard cap, so a page that fires hundreds of requests cannot turn a
//     diagnostic into a dump.
//
// WHAT IT STRUCTURALLY CANNOT SAY: whether a denied CONNECT was the
// main-frame navigation or a subresource. The proxy sees `host:port`
// before the tunnel exists and nothing else — there is no frame, no
// resource type and no request on this boundary. That attribution is
// available only from the browser-side route handler, and is reported
// separately by it.
export interface EgressDecisionDescription {
  host: string | null;
  port: number | null;
  allowed: boolean;
  reason: EgressDenialReason | null;
}

export const MAX_DESCRIBED_EGRESS_DECISIONS = 20;

// Hostnames and bracket-stripped IPv6 literals. Anything else is dropped
// to null rather than passed through: a value that failed this test is not
// a host, and printing it would be printing whatever the browser sent.
const SAFE_HOST_PATTERN = /^[a-z0-9._:-]{1,253}$/;

export function describeEgressDecisions(
  decisions: readonly { target?: unknown; allowed: boolean; reason?: string }[],
): { decisions: EgressDecisionDescription[]; truncated: boolean } {
  const out: EgressDecisionDescription[] = [];
  for (const d of decisions) {
    if (out.length >= MAX_DESCRIBED_EGRESS_DECISIONS) {
      return { decisions: out, truncated: true };
    }
    // REBUILT, never copied. The raw target is parsed by the same pure
    // function the policy uses and only its two structured parts survive,
    // so a record carrying extra fields yields a description that has
    // nowhere to put them.
    const parsed =
      typeof d.target === "string" ? parseConnectTarget(d.target) : null;
    const host = parsed ? parsed.host.toLowerCase() : null;
    const reason = d.reason;
    out.push({
      host: host !== null && SAFE_HOST_PATTERN.test(host) ? host : null,
      port: parsed ? parsed.port : null,
      allowed: d.allowed === true,
      reason:
        typeof reason === "string" &&
        (EGRESS_DENIAL_REASONS as readonly string[]).includes(reason)
          ? (reason as EgressDenialReason)
          : null,
    });
  }
  return { decisions: out, truncated: false };
}
