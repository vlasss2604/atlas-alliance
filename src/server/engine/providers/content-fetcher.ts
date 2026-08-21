import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

import type { ContentType, FetchedDocument } from "./types";

// Phase 6, S1 — ContentFetcher (phase-6-plan.md §7.1, §16, D-076).
//
// Security requirements this module exists to satisfy, all of them real
// for Phase 6 (unlike QueryProposer/SearchGateway/EvidenceExtractor,
// which need an unresolved live provider — P2/P3 — this fetcher needs no
// external API and so gets a genuine production implementation now):
//
//   - only http/https, nothing else
//   - DNS resolved and validated BEFORE connecting, and the connection is
//     pinned to the validated IP (defends against DNS rebinding: the
//     hostname could re-resolve to a private address between check and
//     connect if we let Node re-resolve it itself)
//   - private/loopback/link-local/metadata ranges rejected outright
//   - every redirect hop is independently re-validated — a same-origin
//     redirect can still repoint to 169.254.169.254
//   - bounded size, bounded time, bounded redirect count
//   - content-type allowlist
//   - content is normalized to plain text and handed back as DATA; this
//     module never executes, evaluates, or interprets anything it fetches

export interface ContentFetcher {
  readonly name: string;
  fetch(url: string, opts?: FetchOptions): Promise<FetchedDocument>;
}

export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export type ContentFetchFailureReason =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "DNS_RESOLUTION_FAILED"
  | "BLOCKED_ADDRESS"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_TARGET_BLOCKED"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR";

export class ContentFetchError extends Error {
  constructor(
    public readonly reason: ContentFetchFailureReason,
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = "ContentFetchError";
  }
}

const DEFAULT_MAX_BYTES = 2_000_000; // 2 MB — bounded content handling (§16)
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

const ALLOWED_CONTENT_TYPES: readonly ContentType[] = [
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
];

function normalizeContentType(header: string | undefined): ContentType | null {
  if (!header) return null;
  const base = header.split(";")[0]?.trim().toLowerCase();
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(base ?? "")
    ? (base as ContentType)
    : null;
}

// IPv4 helpers — plain numeric comparison, no CIDR library needed for a
// small fixed blocklist.
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inV4Range(ip: string, base: string, maskBits: number): boolean {
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(base);
  if (ipN === null || baseN === null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

// Ranges that must never be reachable from this fetcher — loopback,
// RFC1918 private space, link-local (includes the cloud metadata
// endpoint 169.254.169.254), the "this network" block, and CGNAT space.
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local + cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_V4_RANGES.some(([base, bits]) => inV4Range(ip, base, bits));
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified
  if (
    lower.startsWith("fe80:") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9")
  )
    return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local (fc00::/7)
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — validate the embedded v4 address too, otherwise
    // rebinding through a mapped address would bypass the v4 blocklist.
    const mapped = lower.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isBlockedIpv4(mapped);
  }
  return false;
}

// Exported for direct unit testing (§3, S1 tests) — dns.lookup() resolves
// a literal IP instantly with no network I/O, so blocked-range coverage
// needs no live connectivity at all.
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // unrecognized — fail closed
}

// Strips script/style tags and their contents, then collapses remaining
// markup to plain text. This is intentionally simple, not a full HTML
// parser: the only goal is that a model never sees raw <script> content
// or hidden text as if it were visible page content (§16). The original
// bytes are still hashed/returned separately for snapshot purposes.
export function normalizeHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveAndValidate(
  hostname: string,
  url: string,
  isAddressBlocked: (ip: string) => boolean,
): Promise<string> {
  let resolved: { address: string; family: number };
  try {
    resolved = await dnsLookup(hostname);
  } catch {
    throw new ContentFetchError(
      "DNS_RESOLUTION_FAILED",
      `DNS resolution failed for ${hostname}`,
      url,
    );
  }
  if (isAddressBlocked(resolved.address)) {
    throw new ContentFetchError(
      "BLOCKED_ADDRESS",
      `resolved address ${resolved.address} for ${hostname} is in a blocked range`,
      url,
    );
  }
  return resolved.address;
}

interface RawFetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

// Performs exactly ONE hop — no redirect following here. The caller loop
// (fetchWithRedirects) re-validates SSRF for every hop, because a
// same-origin 30x can still point at a blocked address.
function fetchOneHop(
  url: string,
  pinnedIp: string,
  opts: Required<FetchOptions>,
): Promise<RawFetchResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const requestFn = isHttps ? https.request : http.request;

    const req = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        // Pin the TCP connection to the address we already validated —
        // Node will NOT re-resolve the hostname itself when `lookup` is
        // supplied, closing the DNS-rebinding TOCTOU window.
        lookup: (_hostname, _options, callback) => {
          callback(null, pinnedIp, isIP(pinnedIp) as 4 | 6);
        },
        headers: {
          "User-Agent": "AtlasProofResearchEngine/1 (+content-fetch)",
          Accept: "text/html,text/plain,application/json,application/xml",
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > opts.maxBytes) {
            aborted = true;
            req.destroy();
            reject(
              new ContentFetchError(
                "TOO_LARGE",
                `response exceeded ${opts.maxBytes} bytes`,
                url,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            finalUrl: url,
          });
        });
        res.on("error", (e) => {
          if (!aborted)
            reject(new ContentFetchError("NETWORK_ERROR", e.message, url));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(
        new ContentFetchError(
          "TIMEOUT",
          `fetch of ${url} timed out after ${opts.timeoutMs}ms`,
          url,
        ),
      );
    });
    req.on("error", (e) => {
      reject(new ContentFetchError("NETWORK_ERROR", e.message, url));
    });
    req.end();
  });
}

async function fetchWithRedirects(
  startUrl: string,
  opts: Required<FetchOptions>,
  isAddressBlocked: (ip: string) => boolean,
): Promise<RawFetchResult> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const parsed = safeParseUrl(currentUrl);
    const pinnedIp = await resolveAndValidate(
      parsed.hostname,
      currentUrl,
      isAddressBlocked,
    );
    const result = await fetchOneHop(currentUrl, pinnedIp, opts);

    if (
      result.status >= 300 &&
      result.status < 400 &&
      result.headers.location
    ) {
      if (hop === opts.maxRedirects) {
        throw new ContentFetchError(
          "TOO_MANY_REDIRECTS",
          `exceeded ${opts.maxRedirects} redirects`,
          startUrl,
        );
      }
      const next = new URL(result.headers.location, currentUrl).toString();
      const nextParsed = safeParseUrl(next);
      if (nextParsed.protocol !== "http:" && nextParsed.protocol !== "https:") {
        throw new ContentFetchError(
          "UNSUPPORTED_PROTOCOL",
          `redirect target uses unsupported protocol ${nextParsed.protocol}`,
          next,
        );
      }
      currentUrl = next;
      continue;
    }
    return { ...result, finalUrl: currentUrl };
  }
  throw new ContentFetchError(
    "TOO_MANY_REDIRECTS",
    `exceeded ${opts.maxRedirects} redirects`,
    startUrl,
  );
}

function safeParseUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ContentFetchError("INVALID_URL", `not a valid URL: ${url}`, url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ContentFetchError(
      "UNSUPPORTED_PROTOCOL",
      `unsupported protocol: ${parsed.protocol}`,
      url,
    );
  }
  return parsed;
}

// Factory, not a fixed export, so tests can build an instance whose SSRF
// check is swapped out (`isAddressBlocked`) to exercise the real HTTP
// mechanics (redirects, size limit, content-type, hashing) against a
// local test server — without weakening what `safeContentFetcher` (the
// only instance production ever sees, via resolveContentFetcher()) does.
// The default here is the real, unmodified isBlockedIp.
export function createContentFetcher(
  overrides: { isAddressBlocked?: (ip: string) => boolean } = {},
): ContentFetcher {
  const isAddressBlocked = overrides.isAddressBlocked ?? isBlockedIp;
  return {
    name: "safe-http",
    async fetch(url, opts) {
      const resolved: Required<FetchOptions> = {
        maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BYTES,
        timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRedirects: opts?.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      };
      // Validate before any network activity — REDIRECT_TARGET_BLOCKED vs
      // BLOCKED_ADDRESS both flow through resolveAndValidate per hop
      // inside fetchWithRedirects; this call covers the first hop up
      // front so a bad starting URL fails fast with a clear reason.
      safeParseUrl(url);

      const raw = await fetchWithRedirects(url, resolved, isAddressBlocked);

      if (raw.status < 200 || raw.status >= 300) {
        throw new ContentFetchError(
          "HTTP_ERROR",
          `HTTP ${raw.status} for ${raw.finalUrl}`,
          url,
        );
      }

      const contentType = normalizeContentType(raw.headers["content-type"]);
      if (!contentType) {
        throw new ContentFetchError(
          "UNSUPPORTED_CONTENT_TYPE",
          `unsupported or missing content-type: ${raw.headers["content-type"] ?? "(none)"}`,
          url,
        );
      }

      const rawText = raw.body.toString("utf-8");
      const normalizedText =
        contentType === "text/html"
          ? normalizeHtmlToText(rawText)
          : rawText.trim();

      return {
        finalUrl: raw.finalUrl,
        requestedUrl: url,
        httpStatus: raw.status,
        contentType,
        normalizedText,
        contentHash: `sha256:${createHash("sha256").update(raw.body).digest("hex")}`,
        fetchedAt: new Date(),
        byteLength: raw.body.length,
      };
    },
  };
}

export const safeContentFetcher: ContentFetcher = createContentFetcher();

let _override: ContentFetcher | null = null;

// Test-only override — same pattern as interpreter/gateway.ts. Production
// never falls back to a fake fetcher; there is no "fake" branch here at
// all, only the real implementation and an explicit test override.
export function __setContentFetcher(f: ContentFetcher | null): void {
  _override = f;
}

export function resolveContentFetcher(): ContentFetcher {
  return _override ?? safeContentFetcher;
}
