import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

import type { ContentType, FetchedDocument } from "./types";
import {
  extractEmbeddedPayloadText,
  mergeDocumentText,
  type EmbeddedPayloadResult,
} from "./embedded-payload";

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
  // Stage 0 opt-in. Only set by a caller that has already confirmed this
  // url is a human-confirmed OFFICIAL_DOCS route with a matched
  // pathPrefix. Default off: an ordinary search candidate never receives
  // this treatment.
  recoverEmbeddedPayloads?: boolean;
}

// THE CLOSED, CODE-OWNED SET OF FETCH FAILURE REASONS.
//
// The ARRAY is the single source of truth and the type is derived from it,
// so the two cannot drift: adding a reason to the union without adding it
// here is not expressible. That matters because this list is also the
// allowlist consumers use to decide what may safely appear in sanitized
// diagnostics — a reason not in it is not surfaced.
//
// Every value is authored here. None is derived from a response, a header,
// a URL or any other provider-controlled input, which is what makes the
// whole list safe to show.
export const CONTENT_FETCH_FAILURE_REASONS = [
  "INVALID_URL",
  "UNSUPPORTED_PROTOCOL",
  "DNS_RESOLUTION_FAILED",
  "BLOCKED_ADDRESS",
  "TOO_MANY_REDIRECTS",
  "REDIRECT_TARGET_BLOCKED",
  "TIMEOUT",
  "TOO_LARGE",
  "UNSUPPORTED_CONTENT_TYPE",
  "HTTP_ERROR",
  "NETWORK_ERROR",
] as const;

export type ContentFetchFailureReason = (typeof CONTENT_FETCH_FAILURE_REASONS)[number];

// A status code is safe to keep and safe to show, and it is the one detail
// that turns "the server refused us" into something actionable: 403 and 429
// are refusals a browser often satisfies, 404 is an absent page and no
// amount of rendering invents one.
//
// TRUSTED NUMERIC ONLY. It is set from the Response's own `status` — never
// parsed back out of a message, which is provider-influenced text. The
// constructor re-checks the range so a caller cannot smuggle anything else
// through, and anything that is not an integer in 100..599 is dropped to
// null rather than kept and hoped about.
function coerceHttpStatus(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 100 && value <= 599 ? value : null;
}

export class ContentFetchError extends Error {
  readonly httpStatus: number | null;

  constructor(
    public readonly reason: ContentFetchFailureReason,
    message: string,
    public readonly url: string,
    httpStatus?: number,
  ) {
    super(message);
    this.name = "ContentFetchError";
    this.httpStatus = coerceHttpStatus(httpStatus);
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

// HIGH-2 fix: string-prefix checks (`lower.startsWith("fe8")`) are wrong
// for CIDR ranges that don't align to a hex-digit (nibble) boundary —
// fe80::/10 covers fe80:: through febf:ffff:..., which "startsWith('fe8')"
// both over- and under-matches (febf:: doesn't start with "fe8", and
// "fe9"/"fe8" as separate prefixes miss fea0::-febf:: entirely). Numeric,
// bit-level prefix matching is the only correct way to test a CIDR range.

// Parses any textual form dns.lookup() can return for a valid IPv6
// address — full, "::"-compressed, and forms with a dotted-quad IPv4 tail
// (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4) — into its 16 raw bytes.
// Returns null for anything that doesn't parse as a well-formed address;
// callers treat that as "block" (fail closed), never "allow".
function ipv6ToBytes(ip: string): Uint8Array | null {
  let head = ip;

  // Embedded dotted-quad IPv4 tail, if present — rewritten into two hex
  // groups so the rest of the parser only ever deals with hex groups.
  const lastColon = ip.lastIndexOf(":");
  const tail = lastColon >= 0 ? ip.slice(lastColon + 1) : ip;
  if (tail.includes(".")) {
    const octets = tail.split(".").map((n) => Number(n));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    head = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = head.split("::");
  if (doubleColonParts.length > 2) return null;

  const toGroups = (s: string): string[] => (s.length === 0 ? [] : s.split(":"));
  let groups: string[];
  if (doubleColonParts.length === 2) {
    const left = toGroups(doubleColonParts[0]);
    const right = toGroups(doubleColonParts[1]);
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = toGroups(head);
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

// True when `bytes` falls within the CIDR range described by `prefixIp`/
// `prefixLen` (0-128), compared bit-for-bit rather than by string prefix.
function matchesV6Prefix(bytes: Uint8Array, prefixIp: string, prefixLen: number): boolean {
  const prefixBytes = ipv6ToBytes(prefixIp);
  if (!prefixBytes) return false;
  const fullBytes = Math.floor(prefixLen / 8);
  const remBits = prefixLen % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== prefixBytes[i]) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((bytes[fullBytes] & mask) !== (prefixBytes[fullBytes] & mask)) return false;
  }
  return true;
}

// CIDR ranges blocked outright, checked bit-for-bit (HIGH-2):
//   ::/128       unspecified
//   ::1/128      loopback
//   fe80::/10    link-local (fe80:: .. febf:ffff:...) — includes fea0::/fea1::/febf:ffff:: etc
//   fc00::/7     unique local (fc00:: .. fdff:...)
//   ff00::/8     multicast
const BLOCKED_V6_EXACT_RANGES: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fe80::", 10],
  ["fc00::", 7],
  ["ff00::", 8],
];

// Tunneling/embedding forms that can carry a blocked IPv4 destination
// inside an otherwise-unblocked-looking IPv6 literal — each maps to the
// byte offset where the embedded IPv4 address lives once decoded to raw
// bytes, and the embedded address is re-checked against the ordinary
// IPv4 policy (HIGH-2: "decode the IPv4 address and pass it through the
// normal IPv4 deny policy").
const V6_EMBEDDED_V4_TUNNELS: Array<{ prefix: string; prefixLen: number; v4Offset: number }> = [
  { prefix: "::ffff:0:0", prefixLen: 96, v4Offset: 12 }, // IPv4-mapped ::ffff:0:0/96
  { prefix: "64:ff9b::", prefixLen: 96, v4Offset: 12 }, // NAT64 64:ff9b::/96
  { prefix: "2002::", prefixLen: 16, v4Offset: 2 }, // 6to4 2002::/16
  { prefix: "::", prefixLen: 96, v4Offset: 12 }, // deprecated IPv4-compatible ::a.b.c.d/96
];

function isBlockedIpv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return true; // unparsable — fail closed, never allow

  if (BLOCKED_V6_EXACT_RANGES.some(([prefix, len]) => matchesV6Prefix(bytes, prefix, len))) {
    return true;
  }
  for (const tunnel of V6_EMBEDDED_V4_TUNNELS) {
    if (matchesV6Prefix(bytes, tunnel.prefix, tunnel.prefixLen)) {
      const [a, b, c, d] = bytes.slice(tunnel.v4Offset, tunnel.v4Offset + 4);
      if (isBlockedIpv4(`${a}.${b}.${c}.${d}`)) return true;
    }
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
  // LOW-2 fix: the initial URL and a redirect target are distinct typed
  // failure reasons (ContentFetchFailureReason already declared both) —
  // a blocked redirect hop must surface as REDIRECT_TARGET_BLOCKED, not
  // be silently reported under the same reason as a blocked start URL.
  isRedirectHop: boolean,
): Promise<string> {
  // URL#hostname keeps the brackets around an IPv6 literal ("[::1]") —
  // required for Host-header formatting, but dns.lookup() only accepts
  // the bare address. Without stripping them here, any URL with a
  // literal IPv6 host (attacker-supplied or otherwise) fails DNS
  // resolution outright instead of ever reaching the SSRF address check.
  const lookupTarget =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  let resolved: { address: string; family: number };
  try {
    resolved = await dnsLookup(lookupTarget);
  } catch {
    throw new ContentFetchError(
      "DNS_RESOLUTION_FAILED",
      `DNS resolution failed for ${hostname}`,
      url,
    );
  }
  if (isAddressBlocked(resolved.address)) {
    throw new ContentFetchError(
      isRedirectHop ? "REDIRECT_TARGET_BLOCKED" : "BLOCKED_ADDRESS",
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

// Builds the `lookup` function handed to http/https.request so the TCP
// connection is pinned to an already-SSRF-validated address and Node never
// re-resolves the hostname itself (closing the DNS-rebinding TOCTOU
// window).
//
// Honoring `options.all` is REQUIRED, not cosmetic: Node >= 20 enables
// autoSelectFamily (Happy Eyeballs) by default, and in that mode
// net.connect calls lookup with `{ all: true }` and requires an ARRAY of
// { address, family } back. Answering with the bare (address, family)
// form there makes Node read `.address` off a string, producing
// "Invalid IP address: undefined" and failing EVERY fetch whose host is a
// hostname — i.e. every real research URL. A literal-IP host skips lookup
// entirely inside Node, which is why a suite that only fetches
// http://127.0.0.1:<port> never exercised this at all.
//
// Both branches return the SAME pre-validated `pinnedIp`, so the
// rebinding defense is identical either way.
// Exported for direct unit testing of that contract (no DNS, no network).
export function createPinnedLookup(pinnedIp: string) {
  const family = isIP(pinnedIp) as 4 | 6;
  return (
    _hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    if ((options as { all?: boolean } | undefined)?.all) {
      callback(null, [{ address: pinnedIp, family }]);
      return;
    }
    callback(null, pinnedIp, family);
  };
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
        // Pins the connection to the pre-validated address; see
        // createPinnedLookup for why the `all` contract matters.
        lookup: createPinnedLookup(pinnedIp) as unknown as http.RequestOptions["lookup"],
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
      hop > 0,
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
      // LOW-2 fix: a malformed Location header must not escape as a raw
      // TypeError from the URL constructor — it is a typed fetch failure
      // like any other rejected redirect target.
      let next: string;
      try {
        next = new URL(result.headers.location, currentUrl).toString();
      } catch {
        throw new ContentFetchError(
          "INVALID_URL",
          `malformed redirect Location header: ${result.headers.location}`,
          currentUrl,
        );
      }
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
        // Off unless the caller explicitly opted in.
        recoverEmbeddedPayloads: opts?.recoverEmbeddedPayloads ?? false,
      };
      // Validate before any network activity — REDIRECT_TARGET_BLOCKED vs
      // BLOCKED_ADDRESS both flow through resolveAndValidate per hop
      // inside fetchWithRedirects; this call covers the first hop up
      // front so a bad starting URL fails fast with a clear reason.
      safeParseUrl(url);

      const raw = await fetchWithRedirects(url, resolved, isAddressBlocked);

      if (raw.status < 200 || raw.status >= 300) {
        // The status travels as a number beside the message, not inside it.
        throw new ContentFetchError(
          "HTTP_ERROR",
          `HTTP ${raw.status} for ${raw.finalUrl}`,
          url,
          raw.status,
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
      const staticText =
        contentType === "text/html"
          ? normalizeHtmlToText(rawText)
          : rawText.trim();

      // Stage 0 — embedded structured-payload recovery. OPT-IN per call and
      // never on by default: the caller must have already established that
      // this url is a human-confirmed OFFICIAL_DOCS route with a matched
      // pathPrefix (see docsPayloadRecoveryEligible). Done HERE because the
      // fetcher is the only place holding the raw bytes — recovering inside
      // it means raw HTML never has to be handed downstream just so someone
      // else can re-parse it.
      //
      // Parse-only: extractEmbeddedPayloadText runs JSON.parse over
      // recognized structured-data containers. No page JavaScript is ever
      // executed, here or anywhere in this path.
      let normalizedText = staticText;
      let embeddedPayload: EmbeddedPayloadResult | null = null;
      if (opts?.recoverEmbeddedPayloads && contentType === "text/html") {
        const recovered = extractEmbeddedPayloadText(rawText);
        if (recovered.text.length > 0) {
          embeddedPayload = recovered;
          normalizedText = mergeDocumentText(staticText, recovered);
        }
      }

      return {
        finalUrl: raw.finalUrl,
        requestedUrl: url,
        httpStatus: raw.status,
        contentType,
        normalizedText,
        contentHash: `sha256:${createHash("sha256").update(raw.body).digest("hex")}`,
        fetchedAt: new Date(),
        byteLength: raw.body.length,
        // Non-null ONLY when recovery ran AND found something, so a reader
        // can always tell whether a document's text came purely from
        // visible HTML or was augmented from embedded payloads.
        embeddedPayload,
        staticTextLength: staticText.length,
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
