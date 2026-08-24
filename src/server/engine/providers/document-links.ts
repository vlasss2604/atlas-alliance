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
  // a burn-row link apart from a nav item. Frequently TRUNCATED BY THE
  // PAGE ITSELF ("99mRw3…pm4F3c"), which is exactly why `href` is kept
  // verbatim alongside it: the anchor text is what a reader sees, the
  // href is what the document actually states.
  text: string;
  // Host of an absolute href; null for a relative one.
  host: string | null;
  // Text of the nearest preceding <h1>-<h6>, bounded. Null when the
  // anchor has no heading above it. This is where a page's own label for
  // a group of links lives ("Burn addresses", "Audits", "Contracts") —
  // the difference between "the page links to an account" and "the page
  // says WHAT that account is". Still an observation: a heading is page
  // text, and page text is a claim, never a verified fact.
  heading: string | null;
  // Visible text immediately preceding the anchor, bounded. Recovered
  // because a label is not always marked up as a heading; a page may put
  // it in a div, a table header, or a caption. Null when nothing legible
  // precedes it.
  context: string | null;
  // UNIQUE CONTEXT RESOLUTION. Set ONLY when this anchor's own visible
  // text is a truncated rendering of an identifier ("99mRw3…pm4F3c") AND
  // exactly one complete identifier in THIS SAME element's href or data-*
  // values agrees with the visible prefix and suffix. Null in every other
  // case — including two candidates, a prefix/suffix disagreement, and a
  // full identifier that lives in some other element.
  //
  // Fail-closed by construction rather than by policy: the resolution is
  // scoped to one element, so an unrelated external link elsewhere on the
  // page has no path to being substituted here, and ambiguity produces
  // null rather than a guess.
  resolvedIdentifier: string | null;
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
const MAX_HEADING_CHARS = 160;
const MAX_CONTEXT_CHARS = 160;
// How much HTML before an anchor is scanned for its preceding visible
// text. Bounded so a pathological document cannot make this quadratic.
const CONTEXT_WINDOW_HTML_CHARS = 2_000;

// Only http(s) and relative hrefs are recoverable. Everything else —
// javascript:, data:, blob:, file:, vbscript:, mailto:, tel:, and any
// scheme invented later — is dropped, because this output is placed
// verbatim into the text a model reads. An allowlist is the only form of
// this check that stays correct as new schemes appear; a denylist of
// known-bad schemes is one browser release away from being incomplete.
//
// The comparison is made on a NORMALIZED copy: HTML tolerates whitespace
// and control characters inside a scheme ("java\tscript:alert(1)"), and a
// naive startsWith on the raw value misses exactly those.
function isSafeHref(href: string): boolean {
  const normalized = href.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized);
  if (!scheme) return true; // relative — resolved against the page's own origin
  return scheme[1] === "http" || scheme[1] === "https";
}

// Base58 (no 0, O, I, l). Solana signatures are 64 bytes -> 87-88 chars;
// addresses are 32 bytes -> 32-44 chars.
const SIGNATURE_LIKE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ADDRESS_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function classifyShape(value: string): DocumentIdentifier["shape"] | null {
  if (SIGNATURE_LIKE.test(value)) return "SIGNATURE_LIKE";
  if (ADDRESS_LIKE.test(value)) return "ADDRESS_LIKE";
  return null;
}

// Named entities are a long tail; NUMERIC references are not, and both
// carry the characters that matter here. A page writing its ellipsis as
// "&#8230;" or "&hellip;" is writing exactly the same abbreviation as one
// writing "…", and unless it is decoded the truncated-text matcher simply
// does not see it — which is how a resolvable identifier goes missing.
//
// Decoding also HARDENS the scheme check rather than weakening it:
// href="&#106;avascript:alert(1)" reads as a scheme-less relative href
// undecoded, and as the javascript: scheme once decoded, where the
// allowlist refuses it. Browsers decode; so must this.
//
// Order matters at the call sites: stripTags removes markup BEFORE
// decoding, so a decoded "&lt;" can never be re-read as a tag.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mldr: "…",
  middot: "·",
  ndash: "–",
  mdash: "—",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Out-of-range or unpaired-surrogate values are left as written
      // rather than replaced with a substitution character, so nothing is
      // silently altered.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
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

// A page's abbreviated rendering of an identifier: a base58 head, an
// elision marker, a base58 tail. Both sides must be long enough to carry
// real information — a one-character head would "agree" with far too much.
const TRUNCATED_DISPLAY =
  /^([1-9A-HJ-NP-Za-km-z]{3,})\s*(?:…|⋯|‥|\.{2,}|·{2,})\s*([1-9A-HJ-NP-Za-km-z]{3,})$/;

// UNIQUE CONTEXT RESOLUTION (owner requirement). Given ONE element's
// visible text and the complete identifiers found in THAT SAME element's
// href and data-* values, return the single identifier the visible text is
// an abbreviation of — or null.
//
// Null is returned, deliberately, in every case that is not a single
// unambiguous answer:
//   * the visible text is not an abbreviation at all;
//   * no candidate agrees with the visible prefix AND suffix — mere shape
//     similarity is not agreement;
//   * more than one distinct candidate agrees.
//
// The caller cannot widen this: candidates come from one element, so an
// identifier on an unrelated link elsewhere in the document is not a
// candidate here at all, and nothing in this function can reach it.
//
// It also never CONSTRUCTS a value. Every result is a candidate string
// taken whole from the document; the abbreviation is only ever used to
// choose between candidates, never to fill in what it elides.
export function resolveTruncatedText(
  visibleText: string,
  elementIdentifiers: readonly string[],
): string | null {
  const m = TRUNCATED_DISPLAY.exec(visibleText.trim());
  if (!m) return null;
  const [, head, tail] = m;
  const agreeing = [...new Set(elementIdentifiers)].filter(
    (candidate) =>
      classifyShape(candidate) !== null &&
      // Long enough that head and tail cannot overlap — otherwise a short
      // candidate could satisfy both ends with the same characters.
      candidate.length > head.length + tail.length &&
      candidate.startsWith(head) &&
      candidate.endsWith(tail),
  );
  return agreeing.length === 1 ? agreeing[0] : null;
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

  // Headings, in document order, so each anchor can be attributed to the
  // section it sits under. Collected once up front rather than re-scanned
  // per anchor.
  const headings: { end: number; text: string }[] = [];
  const heading = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let h: RegExpExecArray | null;
  while ((h = heading.exec(html)) !== null) {
    const text = stripTags(h[2] ?? "").slice(0, MAX_HEADING_CHARS);
    if (text) headings.push({ end: h.index + h[0].length, text });
  }
  // Nearest heading whose element ENDED before the anchor began.
  const headingBefore = (index: number): string | null => {
    let found: string | null = null;
    for (const candidate of headings) {
      if (candidate.end > index) break;
      found = candidate.text;
    }
    return found;
  };
  // Visible text immediately preceding the anchor, from a bounded window.
  // The window is trimmed to the first tag boundary so a half-open tag at
  // its start cannot leak markup into the result.
  const contextBefore = (index: number): string | null => {
    const start = Math.max(0, index - CONTEXT_WINDOW_HTML_CHARS);
    let window = html.slice(start, index);
    // Trim ONLY when the window genuinely begins inside a tag — i.e. a ">"
    // appears before any "<". Trimming at the first ">" unconditionally
    // throws away the whole window whenever the nearest markup is a
    // CLOSING tag at the end, which is the common case for a long run of
    // text immediately before a link.
    const firstGt = window.indexOf(">");
    const firstLt = window.indexOf("<");
    if (firstGt >= 0 && (firstLt < 0 || firstGt < firstLt)) {
      window = window.slice(firstGt + 1);
    }
    const text = stripTags(window);
    if (!text) return null;
    return text.slice(-MAX_CONTEXT_CHARS);
  };

  // Identifier-shaped values among ONE element's own data-* attributes.
  // Scoped to the element deliberately — see resolveTruncatedText.
  const dataIdentifiersOf = (attrs: string): string[] => {
    const out: string[] = [];
    const attr = /\bdata-[a-z0-9-]+\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let a: RegExpExecArray | null;
    while ((a = attr.exec(attrs)) !== null) {
      const value = decodeEntities(a[2] ?? a[3] ?? "").trim();
      if (classifyShape(value)) out.push(value);
    }
    return out;
  };

  // Anchors, with their inner text.
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!hrefMatch) continue;
    const href = decodeEntities(hrefMatch[2] ?? hrefMatch[3] ?? "").trim();
    if (!href || !isSafeHref(href)) continue;
    const text = stripTags(m[2] ?? "").slice(0, 200);
    const key = `${href}|${text}`;
    if (!seenLinks.has(key)) {
      if (links.length >= MAX_LINKS) truncated = true;
      else {
        seenLinks.add(key);
        const host = hostOf(href);
        links.push({
          href,
          text,
          host,
          heading: headingBefore(m.index),
          context: contextBefore(m.index),
          resolvedIdentifier: resolveTruncatedText(text, [
            ...identifiersFromHref(href).map((i) => i.value),
            ...dataIdentifiersOf(attrs),
          ]),
        });
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

// ---------------------------------------------------------------------
// Presenting recovered links to the extraction step.
// ---------------------------------------------------------------------
//
// The plain-text conversion of a settled DOM keeps what a reader SEES and
// drops what the document STATES. A page can render "99mRw3…pm4F3c" —
// visually truncated by its own CSS or markup — while the href behind it
// carries the full identifier. Extraction reading only the visible text
// can therefore never quote an exact address, and D-076's traceability
// rule means an untraceable excerpt is correctly refused. The fix is not
// to relax traceability; it is to make the exact value part of the
// document text that is actually presented and hashed.
//
// WHAT THIS DOES NOT DO. It confers nothing. A link to any host appears
// here identically to a link to the page's own host, because this
// function has no notion of which hosts are interesting. Whether the
// resulting Evidence carries authority is decided elsewhere, from the
// DOCUMENT's confirmed route — never from a link inside it. An external
// link recovered from an OFFICIAL_DOCS page makes the PAGE's statement
// about that link quotable; it does not make the linked site official,
// and it does not make the page's claim true.
//
// The appendix is fenced with a prefix on every line so that a model
// reading the document can tell recovered metadata from page prose, and
// so a page cannot forge the boundary by containing the same text: the
// appendix is appended after the page's own text either way, and its
// content is quoted data inside the untrusted DOCUMENT block regardless.
const APPENDIX_PREFIX = "[LINK]";
const MAX_APPENDIX_LINKS = 100;
const MAX_APPENDIX_CHARS = 20_000;

export const LINK_APPENDIX_HEADER =
  "--- RECOVERED DOCUMENT LINKS (href values from this page's rendered DOM, not page prose) ---";

function appendixField(label: string, value: string | null): string {
  if (!value) return "";
  // One line per link, so a support fragment quoting it stays a single
  // legible excerpt. Newlines inside a recovered value would break that.
  return ` | ${label}=${value.replace(/\s+/g, " ").trim()}`;
}

// Deterministic: same links in, same string out. The renderer hashes the
// text that includes this, so an appendix that varied run to run would
// make contentHash meaningless.
export function renderLinkAppendix(result: DocumentLinkResult): string {
  if (!result || result.links.length === 0) return "";
  const lines: string[] = [
    LINK_APPENDIX_HEADER,
    `${APPENDIX_PREFIX} Anchor text may be truncated by the page; href is verbatim.`,
    `${APPENDIX_PREFIX} A link confers no authority, officiality or entity binding of its own.`,
  ];
  // Explained only when at least one link actually resolved. Emitting it
  // unconditionally would put the string "resolves=" in every document,
  // including ones where nothing resolved — noise, and an invitation to
  // read the legend as data.
  if (result.links.some((l) => l.resolvedIdentifier)) {
    lines.splice(
      1,
      0,
      `${APPENDIX_PREFIX} resolves= is the exact identifier a truncated text abbreviates; prefer it over the truncated text.`,
    );
  }
  let used = lines.join("\n").length;
  let omitted = 0;
  for (const [i, link] of result.links.entries()) {
    if (i >= MAX_APPENDIX_LINKS) {
      omitted = result.links.length - i;
      break;
    }
    const line =
      `${APPENDIX_PREFIX} href=${link.href}` +
      appendixField("text", link.text) +
      // The exact identifier the visible text abbreviates, when exactly
      // one candidate in this same element agrees. Emitted right after
      // the truncated text it belongs to, on the same line, so extraction
      // quoting the pair quotes one contiguous excerpt.
      appendixField("resolves", link.resolvedIdentifier) +
      appendixField("heading", link.heading) +
      appendixField("context", link.context);
    if (used + line.length + 1 > MAX_APPENDIX_CHARS) {
      omitted = result.links.length - i;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0 || result.truncated) {
    lines.push(`${APPENDIX_PREFIX} ${omitted} further link(s) not listed (bounded output).`);
  }
  return lines.join("\n");
}
