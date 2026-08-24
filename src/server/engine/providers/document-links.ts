// Machine-readable identifiers recoverable from a RENDERED document.
//
// Why this exists: converting a settled DOM to plain text discards every
// href and data attribute. A rendered burn table can read as
// "Aug 23, 2026 | 160.1M | $842.6K" while the DOM behind it carries a
// transaction link per row — the exact identifier the plain-text path
// throws away.
//
// HOW IT STAYS SAFE. It parses the HTML STRING the renderer already
// captured via page.content(). It performs no page action: no click, no
// scroll, no evaluate, no script injection, no second navigation. The
// browser is finished by the time this runs, so the renderer's security
// boundary is untouched — this is string processing on bytes already in
// hand.
//
// TRUST: none is conferred. Everything here is an OBSERVATION. A link
// found on a confirmed official page is still just a link: it carries no
// class, no officiality, no entity binding, and cannot become evidence or
// a mechanism locator until the existing identity and provenance checks
// pass on their own terms. This module deliberately has no way to express
// approval.

export interface DocumentLink {
  href: string;
  // Visible text of the anchor, trimmed and bounded — useful for telling
  // a burn-row link apart from a nav item.
  text: string;
  // Host of an absolute href; null for a relative one.
  host: string | null;
}

export interface DocumentIdentifier {
  // Which attribute carried it, e.g. "href" or "data-signature".
  attribute: string;
  value: string;
  // Shape only — NOT a claim about what it is or which chain it belongs
  // to. A 64-88 char base58 run looks like a Solana signature; a 32-44
  // char run looks like an address. Confirming either is D-134's job.
  shape: "SIGNATURE_LIKE" | "ADDRESS_LIKE";
}

export interface DocumentLinkResult {
  links: DocumentLink[];
  identifiers: DocumentIdentifier[];
  // Hosts seen across all absolute links, for a quick read of where a
  // page points.
  hosts: string[];
  truncated: boolean;
}

export const EMPTY_LINKS: DocumentLinkResult = {
  links: [],
  identifiers: [],
  hosts: [],
  truncated: false,
};

const MAX_LINKS = 500;
const MAX_IDENTIFIERS = 500;
const MAX_HTML_BYTES = 8_000_000;

// Base58 (no 0, O, I, l). Solana signatures are 64 bytes -> 87-88 chars;
// addresses are 32 bytes -> 32-44 chars.
const SIGNATURE_LIKE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ADDRESS_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function classifyShape(value: string): DocumentIdentifier["shape"] | null {
  if (SIGNATURE_LIKE.test(value)) return "SIGNATURE_LIKE";
  if (ADDRESS_LIKE.test(value)) return "ADDRESS_LIKE";
  return null;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return null; // relative href
  }
}

// Pulls every base58-looking run out of a URL's path segments and query
// values. A transaction link is usually /tx/<signature> or ?sig=<...>.
function identifiersFromHref(href: string): DocumentIdentifier[] {
  const out: DocumentIdentifier[] = [];
  const candidates: string[] = [];
  try {
    const u = new URL(href, "https://placeholder.invalid");
    candidates.push(...u.pathname.split("/").filter(Boolean));
    for (const v of u.searchParams.values()) candidates.push(v);
  } catch {
    return out;
  }
  for (const c of candidates) {
    const shape = classifyShape(c);
    if (shape) out.push({ attribute: "href", value: c, shape });
  }
  return out;
}

export function extractDocumentLinks(html: string): DocumentLinkResult {
  if (typeof html !== "string" || html.length === 0) return EMPTY_LINKS;
  if (html.length > MAX_HTML_BYTES) return EMPTY_LINKS;

  const links: DocumentLink[] = [];
  const identifiers: DocumentIdentifier[] = [];
  const seenLinks = new Set<string>();
  const seenIds = new Set<string>();
  const hosts = new Set<string>();
  let truncated = false;

  const addIdentifier = (id: DocumentIdentifier) => {
    const key = `${id.attribute}|${id.value}`;
    if (seenIds.has(key)) return;
    if (identifiers.length >= MAX_IDENTIFIERS) {
      truncated = true;
      return;
    }
    seenIds.add(key);
    identifiers.push(id);
  };

  // Anchors, with their inner text.
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!hrefMatch) continue;
    const href = decodeEntities(hrefMatch[2] ?? hrefMatch[3] ?? "").trim();
    if (!href || href.startsWith("javascript:")) continue;
    const text = stripTags(m[2] ?? "").slice(0, 200);
    const key = `${href}|${text}`;
    if (!seenLinks.has(key)) {
      if (links.length >= MAX_LINKS) truncated = true;
      else {
        seenLinks.add(key);
        const host = hostOf(href);
        links.push({ href, text, host });
        if (host) hosts.add(host);
      }
    }
    for (const id of identifiersFromHref(href)) addIdentifier(id);
  }

  // data-* attributes anywhere in the document whose VALUE looks like an
  // on-chain identifier. Attribute names are not trusted — the shape of
  // the value is what is reported.
  const dataAttr = /\b(data-[a-z0-9-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = dataAttr.exec(html)) !== null) {
    const name = m[1].toLowerCase();
    const value = decodeEntities(m[3] ?? m[4] ?? "").trim();
    const shape = classifyShape(value);
    if (shape) addIdentifier({ attribute: name, value, shape });
  }

  return { links, identifiers, hosts: [...hosts].sort(), truncated };
}

// Convenience for a human reading inspection output: links whose href
// points at a path segment that looks like a transaction signature. Still
// an observation — naming a link "transaction-like" confers nothing.
export function signatureLinks(result: DocumentLinkResult): DocumentLink[] {
  return result.links.filter((l) =>
    identifiersFromHref(l.href).some((i) => i.shape === "SIGNATURE_LIKE"),
  );
}
