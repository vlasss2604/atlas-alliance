// Stage 0 — embedded structured-payload text recovery for CONFIRMED
// OFFICIAL_DOCS pages.
//
// THE PROBLEM THIS SOLVES. A confirmed docs page returned 1,477,632 bytes
// of HTML and 134 characters of text. normalizeHtmlToText (content-fetcher.ts)
// strips <script>...</script> AND its contents before anything downstream
// sees it — correctly, so a model never reads raw script. But modern
// frameworks put the page's actual prose INSIDE those tags as JSON
// (__NEXT_DATA__, RSC flight payloads, JSON-LD). So the content was in our
// hands and we deleted it.
//
// WHAT THIS IS NOT. It is not a script interpreter, not a renderer, and not
// a general HTML parser. It recognizes a closed set of STRUCTURED DATA
// containers and reads them with JSON.parse. Anything it does not
// positively recognize is ignored, not "best-effort" interpreted.
//
// SAFETY, structurally rather than by convention:
//   * JSON.parse ONLY. No eval, no new Function, no vm, no browser, no
//     dynamic import — bytes are parsed, never executed. A payload that
//     happens to contain JavaScript source is treated as a string like any
//     other, and the assertion that no execution primitive appears in this
//     file is enforced by test.
//   * Every parse is individually try/caught: one malformed payload is
//     skipped, never fatal, and never partially trusted.
//   * Bounded input scanned, bounded per-payload size, bounded output.
//   * Fail closed: on any doubt the recovered text is empty, which simply
//     leaves the page as poor as it was before this module existed.
//
// ADMISSIBILITY IS UNCHANGED. This recovers TEXT from a document already
// fetched from a human-confirmed route. It cannot change a source class, an
// officiality, or what counts as evidence — it only means the extractor
// gets to read what the page actually said.

export interface EmbeddedPayloadOptions {
  // Ignore HTML beyond this size entirely (defense against a pathological
  // document; the fetcher's own 2 MB cap already bounds what arrives).
  maxHtmlBytes?: number;
  // Skip any single script payload larger than this.
  maxPayloadBytes?: number;
  // Hard cap on recovered text handed downstream.
  maxTextLength?: number;
  // Shortest string worth keeping. Deliberately small: an on-chain address
  // or a program id is short but is exactly the kind of value a docs page
  // may carry, so aggressive filtering would defeat the purpose.
  minStringLength?: number;
}

const DEFAULTS: Required<EmbeddedPayloadOptions> = {
  maxHtmlBytes: 4_000_000,
  maxPayloadBytes: 1_000_000,
  maxTextLength: 200_000,
  minStringLength: 3,
};

export type EmbeddedPayloadKind = "NEXT_DATA" | "JSON_LD" | "RSC_FLIGHT";

export interface EmbeddedPayloadResult {
  text: string;
  kinds: EmbeddedPayloadKind[];
  // How many distinct strings survived filtering — useful for observing
  // that recovery did something without logging the content itself.
  recoveredStrings: number;
  truncated: boolean;
}

export const EMPTY_EMBEDDED_PAYLOAD: EmbeddedPayloadResult = {
  text: "",
  kinds: [],
  recoveredStrings: 0,
  truncated: false,
};

// Strings that are plumbing rather than prose. Kept deliberately narrow:
// over-filtering risks discarding the very value (an address, an id) the
// caller is looking for, so this drops only unambiguous asset noise.
function isNoiseString(value: string): boolean {
  if (value.startsWith("data:")) return true;
  if (/^\/_next\//.test(value)) return true;
  if (/\.(js|mjs|css|map|woff2?|ttf|png|jpe?g|gif|svg|ico|webp|avif)(\?|$)/i.test(value)) return true;
  // Pure punctuation/whitespace.
  if (!/[A-Za-z0-9]/.test(value)) return true;
  return false;
}

// Depth-bounded walk collecting string leaves. Depth and node budgets stop
// a hostile or merely enormous structure from becoming a CPU problem.
function collectStrings(
  node: unknown,
  out: string[],
  seen: Set<string>,
  opts: Required<EmbeddedPayloadOptions>,
  depth = 0,
  budget = { nodes: 200_000 },
): void {
  if (depth > 64 || budget.nodes <= 0) return;
  budget.nodes -= 1;
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (trimmed.length < opts.minStringLength) return;
    if (isNoiseString(trimmed)) return;
    if (seen.has(trimmed)) return; // deterministic dedup
    seen.add(trimmed);
    out.push(trimmed);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out, seen, opts, depth + 1, budget);
    return;
  }
  if (node && typeof node === "object") {
    // Key order from JSON.parse follows document order, so traversal is
    // deterministic and the same HTML always yields the same text.
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectStrings(value, out, seen, opts, depth + 1, budget);
    }
  }
  // numbers/booleans/null carry no prose and are ignored.
}

// Extracts the raw inner text of every <script> tag, with its attributes,
// using a bounded regex. This is intentionally NOT a full HTML parser: the
// only question asked is "which script bodies are structured data", and a
// wrong answer merely means a payload is skipped.
interface ScriptTag {
  attrs: string;
  body: string;
}

function scriptTags(html: string, maxPayloadBytes: number): ScriptTag[] {
  const out: ScriptTag[] = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[2];
    if (body.length === 0 || body.length > maxPayloadBytes) continue;
    out.push({ attrs: m[1] ?? "", body });
  }
  return out;
}

function attrHas(attrs: string, name: string, value: string): boolean {
  const re = new RegExp(`${name}\\s*=\\s*["']?${value}["']?`, "i");
  return re.test(attrs);
}

function safeParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    // Malformed payload: ignored, never partially salvaged.
    return undefined;
  }
}

// RSC / Next.js flight payloads arrive as JS statements:
//   self.__next_f.push([1,"<escaped json-ish string>"])
// The argument is a JSON array literal, so the ARGUMENT can be parsed as
// JSON without executing the statement around it. That is the whole trick:
// we read the literal, we never run the push.
function parseFlightPushes(body: string, maxPayloadBytes: number): unknown[] {
  const out: unknown[] = [];
  const re = /self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const literal = m[1];
    if (!literal || literal.length > maxPayloadBytes) continue;
    const parsed = safeParse(literal);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

// A flight chunk's payload string often embeds further JSON fragments.
// One extra, bounded parse attempt recovers those; anything that is not
// valid JSON stays a plain string and is kept as text.
function expandFlightStrings(values: unknown[], opts: Required<EmbeddedPayloadOptions>): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    out.push(v);
    if (typeof v === "string" && v.length > 1 && v.length <= opts.maxPayloadBytes) {
      const trimmed = v.trim();
      const looksJson =
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"));
      if (looksJson) {
        const parsed = safeParse(trimmed);
        if (parsed !== undefined) out.push(parsed);
      }
    }
  }
  return out;
}

export function extractEmbeddedPayloadText(
  html: string,
  options: EmbeddedPayloadOptions = {},
): EmbeddedPayloadResult {
  const opts = { ...DEFAULTS, ...options };
  if (typeof html !== "string" || html.length === 0) return EMPTY_EMBEDDED_PAYLOAD;
  if (html.length > opts.maxHtmlBytes) return EMPTY_EMBEDDED_PAYLOAD;

  const kinds = new Set<EmbeddedPayloadKind>();
  const strings: string[] = [];
  const seen = new Set<string>();

  for (const tag of scriptTags(html, opts.maxPayloadBytes)) {
    // 1. __NEXT_DATA__ — a single application/json blob.
    if (attrHas(tag.attrs, "id", "__NEXT_DATA__")) {
      const parsed = safeParse(tag.body);
      if (parsed !== undefined) {
        kinds.add("NEXT_DATA");
        collectStrings(parsed, strings, seen, opts);
      }
      continue;
    }
    // 2. JSON-LD — one object or an array of them.
    if (attrHas(tag.attrs, "type", "application/ld\\+json")) {
      const parsed = safeParse(tag.body);
      if (parsed !== undefined) {
        kinds.add("JSON_LD");
        collectStrings(parsed, strings, seen, opts);
      }
      continue;
    }
    // 3. RSC flight chunks — parsed as literals, never executed.
    if (tag.body.includes("self.__next_f.push(")) {
      const pushes = parseFlightPushes(tag.body, opts.maxPayloadBytes);
      if (pushes.length > 0) {
        kinds.add("RSC_FLIGHT");
        collectStrings(expandFlightStrings(pushes, opts), strings, seen, opts);
      }
      continue;
    }
    // 4. Any other application/json blob that is genuinely structured
    // data. An unrecognized/plain script is IGNORED — never scraped for
    // text, never interpreted.
    if (attrHas(tag.attrs, "type", "application/json")) {
      const parsed = safeParse(tag.body);
      if (parsed !== undefined) {
        kinds.add("NEXT_DATA");
        collectStrings(parsed, strings, seen, opts);
      }
    }
  }

  if (strings.length === 0) return EMPTY_EMBEDDED_PAYLOAD;

  let text = strings.join("\n");
  let truncated = false;
  if (text.length > opts.maxTextLength) {
    text = text.slice(0, opts.maxTextLength);
    truncated = true;
  }

  return {
    text,
    kinds: [...kinds].sort(),
    recoveredStrings: strings.length,
    truncated,
  };
}

// Deterministic merge of the statically extracted text with recovered
// payload text. Static text comes FIRST (it is the page's own visible
// prose), recovered text is appended, and any recovered line already
// present in the static text is dropped so the extractor never sees the
// same sentence twice.
export function mergeDocumentText(
  staticText: string,
  recovered: EmbeddedPayloadResult,
  maxTextLength = DEFAULTS.maxTextLength,
): string {
  if (recovered.text.length === 0) return staticText;
  const staticNormalized = staticText.replace(/\s+/g, " ").trim();
  const kept: string[] = [];
  for (const line of recovered.text.split("\n")) {
    if (line.length === 0) continue;
    if (staticNormalized.includes(line)) continue; // already visible statically
    kept.push(line);
  }
  if (kept.length === 0) return staticText;
  const merged = staticText.length > 0 ? `${staticText}\n${kept.join("\n")}` : kept.join("\n");
  return merged.length > maxTextLength ? merged.slice(0, maxTextLength) : merged;
}
