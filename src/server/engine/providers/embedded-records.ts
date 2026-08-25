import {
  embeddedPayloadSources,
  type EmbeddedPayloadKind,
  type EmbeddedPayloadOptions,
} from "./embedded-payload";

// RECORD-PRESERVING EMBEDDED PAYLOAD RECOVERY.
//
// Stage 0's existing recovery flattens a payload to a list of strings. That
// is the right shape for handing prose to an extractor and the wrong shape
// for the question now being asked: a table row's date, its amount and its
// transaction id are only meaningfully related if they came from the SAME
// object. Flattened, "160.1M" and a base58 string are two strings that
// happen to be in the same document — which is exactly the association this
// system must never make.
//
// So this walks the SAME parsed payloads and keeps objects intact. A match
// is one record: its own JSON, its own field names, and the identifiers
// found inside it. An identifier from a different record is not reported
// for that match, because it is not evidence about that row.
//
// PARSE ONLY, exactly like Stage 0. It reads an HTML STRING that the caller
// already has. There is no eval, no Function, no script execution, no
// browser evaluate, no navigation and no fetch — a URL discovered inside a
// payload is a string, and nothing here can follow it.
//
// AUTHORITY: none. Recovering a value from a page's embedded payload says
// the page shipped that value. It is not evidence, not a documentary
// locator, not on-chain provenance and not a burn. Any identifier found
// here is an observational candidate until it passes the provenance path
// that actually admits identifiers.

// Complete base58 identifier shapes. Same alphabet and ranges the rest of
// the codebase uses; a shape is a claim about length and alphabet, never
// about which chain or project a value belongs to.
const SIGNATURE_LIKE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ADDRESS_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type IdentifierShape = "SIGNATURE_LIKE" | "ADDRESS_LIKE";

export function classifyIdentifier(value: string): IdentifierShape | null {
  if (SIGNATURE_LIKE.test(value)) return "SIGNATURE_LIKE";
  if (ADDRESS_LIKE.test(value)) return "ADDRESS_LIKE";
  return null;
}

export interface RecordIdentifier {
  // Dotted path of the field WITHIN the matched record.
  field: string;
  value: string;
  shape: IdentifierShape;
}

export interface EmbeddedRecordMatch {
  kind: EmbeddedPayloadKind;
  // Which <script> in document order the payload came from, and where in
  // that payload the record sits. Provenance for "where did this come
  // from", not a claim that it means anything.
  scriptIndex: number;
  path: string;
  // The record itself, serialized and bounded. Truncation is visible.
  json: string;
  jsonTruncated: boolean;
  // Immediate field names, so a reader can see the record's shape even
  // when its JSON was cut.
  fields: string[];
  // Which of the caller's needles this record contained.
  matchedNeedles: string[];
  // Identifiers found INSIDE THIS RECORD ONLY.
  identifiers: RecordIdentifier[];
}

export interface EmbeddedRecordsResult {
  kinds: EmbeddedPayloadKind[];
  // How many objects were examined — evidence that recovery ran, without
  // reproducing the document.
  recordsScanned: number;
  matches: EmbeddedRecordMatch[];
  // A cap was hit: there may be more matches, more record text, or more
  // records than were examined.
  truncated: boolean;
}

export const EMPTY_EMBEDDED_RECORDS: EmbeddedRecordsResult = {
  kinds: [],
  recordsScanned: 0,
  matches: [],
  truncated: false,
};

export interface EmbeddedRecordsOptions extends EmbeddedPayloadOptions {
  // Values to look for. Compared case-insensitively against a record's own
  // JSON. Generic: the runtime has no idea what any needle means.
  needles: readonly string[];
  maxNeedles?: number;
  maxMatches?: number;
  maxRecordChars?: number;
  maxTotalChars?: number;
  maxRecordsScanned?: number;
  maxEmbeddedJsonChars?: number;
}

const RECORD_DEFAULTS = {
  maxNeedles: 20,
  maxMatches: 20,
  maxRecordChars: 4_000,
  maxTotalChars: 60_000,
  maxRecordsScanned: 200_000,
  // Longest string this will attempt to re-parse as embedded JSON. A
  // flight chunk is legitimately large; a pathological one must not be
  // parsed repeatedly at every depth.
  maxEmbeddedJsonChars: 2_000_000,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Bounded stringify. A record containing a huge nested blob must not be
// able to blow the cap on its own.
function safeStringify(value: unknown, limit: number): { json: string; truncated: boolean } {
  let raw: string;
  try {
    raw = JSON.stringify(value) ?? "";
  } catch {
    // Circular or otherwise unserializable: report nothing rather than a
    // partial structure that could mislead.
    return { json: "", truncated: true };
  }
  if (raw.length <= limit) return { json: raw, truncated: false };
  return { json: `${raw.slice(0, limit)}…[truncated]`, truncated: true };
}

// Identifiers inside ONE record. Depth-bounded, and it never leaves the
// record it was given — which is what keeps an identifier from another row
// out of this row's match.
function identifiersIn(
  node: unknown,
  out: RecordIdentifier[],
  seen: Set<string>,
  path: string,
  depth: number,
): void {
  if (depth > 32 || out.length >= 50) return;
  if (typeof node === "string") {
    const shape = classifyIdentifier(node.trim());
    if (shape && !seen.has(node.trim())) {
      seen.add(node.trim());
      out.push({ field: path || "(root)", value: node.trim(), shape });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) {
      identifiersIn(child, out, seen, `${path}[${i}]`, depth + 1);
    }
    return;
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      identifiersIn(v, out, seen, path ? `${path}.${k}` : k, depth + 1);
    }
  }
}

interface WalkState {
  needles: string[];
  matches: EmbeddedRecordMatch[];
  kind: EmbeddedPayloadKind;
  scriptIndex: number;
  scanned: { n: number };
  totalChars: { n: number };
  truncated: { v: boolean };
  opts: typeof RECORD_DEFAULTS;
}

// Depth-first, reporting the SMALLEST matching record.
//
// A parent object's JSON contains all of its children, so a needle in one
// row also "matches" the array around it and the page state above that.
// Reporting the outermost match would return the whole payload and destroy
// the very association this exists to preserve, so a record is reported
// only when no descendant matched.
//
// Returns whether this subtree produced a match.
function walk(node: unknown, path: string, depth: number, st: WalkState): boolean {
  if (depth > 64) return false;
  if (st.scanned.n >= st.opts.maxRecordsScanned) {
    st.truncated.v = true;
    return false;
  }

  if (Array.isArray(node)) {
    let any = false;
    for (const [i, child] of node.entries()) {
      if (walk(child, `${path}[${i}]`, depth + 1, st)) any = true;
    }
    return any;
  }

  // JSON EMBEDDED IN A STRING. An RSC flight chunk carries its records as
  // an ESCAPED JSON string nested inside the pushed array, so a walk that
  // only descends real objects never reaches a single row. One bounded
  // re-parse attempt per string recovers them; anything that is not valid
  // JSON stays an inert string. This is still parsing — the string is
  // read, never executed.
  if (typeof node === "string") {
    if (node.length < 2 || node.length > st.opts.maxEmbeddedJsonChars) return false;
    const trimmed = node.trim();
    const looksJson =
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"));
    if (!looksJson) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
    return walk(parsed, path, depth + 1, st);
  }

  if (!isPlainObject(node)) return false;

  st.scanned.n += 1;

  // Children first, so the deepest match wins.
  let childMatched = false;
  for (const [k, v] of Object.entries(node)) {
    if (walk(v, path ? `${path}.${k}` : k, depth + 1, st)) childMatched = true;
  }
  if (childMatched) return true;

  const { json } = safeStringify(node, st.opts.maxRecordChars * 8);
  if (json.length === 0) return false;
  const haystack = json.toLowerCase();
  const matchedNeedles = st.needles.filter((n) => haystack.includes(n));
  if (matchedNeedles.length === 0) return false;

  if (st.matches.length >= st.opts.maxMatches || st.totalChars.n >= st.opts.maxTotalChars) {
    st.truncated.v = true;
    return true;
  }

  const bounded = safeStringify(node, st.opts.maxRecordChars);
  const identifiers: RecordIdentifier[] = [];
  identifiersIn(node, identifiers, new Set<string>(), "", 0);

  st.matches.push({
    kind: st.kind,
    scriptIndex: st.scriptIndex,
    path: path || "(root)",
    json: bounded.json,
    jsonTruncated: bounded.truncated,
    fields: Object.keys(node).slice(0, 100),
    matchedNeedles,
    identifiers,
  });
  st.totalChars.n += bounded.json.length;
  if (bounded.truncated) st.truncated.v = true;
  return true;
}

// Recovers RECORDS containing any of the given needles from a document's
// embedded payloads. The input is an HTML string the caller already holds;
// nothing is fetched, executed or navigated.
export function recoverEmbeddedRecords(
  html: string,
  options: EmbeddedRecordsOptions,
): EmbeddedRecordsResult {
  const opts = { ...RECORD_DEFAULTS, ...options };
  const needles = (options.needles ?? [])
    .filter((n) => typeof n === "string" && n.trim().length > 0)
    .slice(0, opts.maxNeedles)
    .map((n) => n.trim().toLowerCase());
  if (needles.length === 0) return EMPTY_EMBEDDED_RECORDS;

  // The SAME payload discovery Stage 0 uses — one source of truth for
  // which script bodies are structured data and how each is parsed.
  const sources = embeddedPayloadSources(html, options);
  if (sources.length === 0) return EMPTY_EMBEDDED_RECORDS;

  const kinds = new Set<EmbeddedPayloadKind>();
  const matches: EmbeddedRecordMatch[] = [];
  const scanned = { n: 0 };
  const totalChars = { n: 0 };
  const truncated = { v: false };

  for (const source of sources) {
    kinds.add(source.kind);
    for (const value of source.values) {
      walk(value, "", 0, {
        needles,
        matches,
        kind: source.kind,
        scriptIndex: source.scriptIndex,
        scanned,
        totalChars,
        truncated,
        opts,
      });
    }
  }

  return {
    kinds: [...kinds].sort(),
    recordsScanned: scanned.n,
    matches,
    truncated: truncated.v,
  };
}
