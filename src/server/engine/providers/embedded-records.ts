import {
  embeddedPayloadSources,
  type EmbeddedPayloadKind,
  type EmbeddedPayloadOptions,
} from "./embedded-payload";
import { parseFlightFrames } from "./flight-frames";

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

// WAS THE PAYLOAD ACTUALLY SEARCHED?
//
// Finding a source is not searching it. A live inspection once reported
// zero matches after traversing four objects on a two-megabyte page and
// that was read as "no identifier exists" — a false negative produced by
// unsupported framing, not by absence. These counters exist so the
// difference between (A) searched and found nothing and (B) found a
// payload and could not read it is visible in the result rather than
// inferred by a reader.
export interface EmbeddedRecordsCoverage {
  sourcesFound: number;
  sourcesTraversed: number;
  framesSeen: number;
  framesParsed: number;
  framesUnsupported: number;
  parseErrors: number;
  recordsScanned: number;
  // COMPLETE — every discovered source was traversed, every frame was
  //            parsed, and no cap was hit. A zero-match result here is a
  //            real negative.
  // PARTIAL  — something was searched, but something else was not.
  // NONE     — nothing was traversed at all.
  coverage: "COMPLETE" | "PARTIAL" | "NONE";
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
  coverage: EmbeddedRecordsCoverage;
}

export const EMPTY_COVERAGE: EmbeddedRecordsCoverage = {
  sourcesFound: 0,
  sourcesTraversed: 0,
  framesSeen: 0,
  framesParsed: 0,
  framesUnsupported: 0,
  parseErrors: 0,
  recordsScanned: 0,
  coverage: "NONE",
};

export const EMPTY_EMBEDDED_RECORDS: EmbeddedRecordsResult = {
  kinds: [],
  recordsScanned: 0,
  matches: [],
  truncated: false,
  coverage: EMPTY_COVERAGE,
};

// The states a caller may report. Deliberately NOT a boolean: the whole
// point is that 'no match' and 'not searched' are different answers, and
// a boolean would collapse them again.
//
// FINDING THE RECORD IS NOT FINDING AN IDENTIFIER.
//
// The previous version returned EVENT_IDENTIFIER_PATH_FOUND whenever any
// record matched, and a live inspection duly reported an identifier path
// for a record containing zero identifiers. "We located the row" and "the
// row points at a transaction" are different claims, and collapsing them
// is how a locating success gets read as a linkage success.
//
// Four outcomes, along two INDEPENDENT axes: did we find the record, and
// did that record carry an identifier. Coverage remains a separate axis
// again — it decides only whether a NEGATIVE is available.
export type EmbeddedSearchVerdict =
  | "EVENT_RECORD_AND_IDENTIFIER_FOUND"
  | "EVENT_RECORD_FOUND_NO_IDENTIFIER_IN_RECORD"
  | "SEARCHED_SUPPORTED_PAYLOAD_EVENT_RECORD_NOT_FOUND"
  | "PAYLOAD_PRESENT_BUT_NOT_FULLY_INSPECTED";

// A NEGATIVE IS ONLY AVAILABLE AFTER COMPLETE COVERAGE. Anything less
// reports that the payload was not fully inspected, which is a statement
// about this system rather than about the page.
//
// Takes only what the decision needs, so a caller holding a widened
// projection of the result (the cross-process document shape) can still
// ask the question without re-deriving it.
export function embeddedSearchVerdict(result: {
  matches: readonly { identifiers: readonly unknown[] }[];
  coverage: { coverage: string };
}): EmbeddedSearchVerdict {
  if (result.matches.length > 0) {
    // An identifier counts only when it was found INSIDE a matched
    // record. Identifiers elsewhere in the payload are not this row's.
    const withIdentifier = result.matches.some((m) => m.identifiers.length > 0);
    return withIdentifier
      ? "EVENT_RECORD_AND_IDENTIFIER_FOUND"
      : "EVENT_RECORD_FOUND_NO_IDENTIFIER_IN_RECORD";
  }
  if (result.coverage.coverage === "COMPLETE") {
    return "SEARCHED_SUPPORTED_PAYLOAD_EVENT_RECORD_NOT_FOUND";
  }
  return "PAYLOAD_PRESENT_BUT_NOT_FULLY_INSPECTED";
}

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
  seen: Set<string>;
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
  // The same record can be reached through frame parsing AND through the
  // whole-string re-parse. Reporting it twice would suggest two
  // independent occurrences, which is a different claim.
  const dedupKey = `${st.kind}|${st.scriptIndex}|${path}|${bounded.json}`;
  if (st.seen.has(dedupKey)) return true;
  st.seen.add(dedupKey);
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
  const matchKeys = new Set<string>();
  let sourcesTraversed = 0;
  let framesSeen = 0;
  let framesParsed = 0;
  let framesUnsupported = 0;
  let parseErrors = 0;

  for (const source of sources) {
    kinds.add(source.kind);
    const st = {
      needles,
      matches,
      seen: matchKeys,
      kind: source.kind,
      scriptIndex: source.scriptIndex,
      scanned,
      totalChars,
      truncated,
      opts,
    };

    if (source.kind === "RSC_FLIGHT") {
      // A flight stream is newline-delimited FRAMES, not one JSON
      // document, and Next splits frames across pushes freely — so the
      // chunk strings are joined in document order before framing.
      const stream = collectFlightStream(source.values, opts);
      const framed = parseFlightFrames(stream, {
        maxFrameChars: opts.maxEmbeddedJsonChars,
      });
      framesSeen += framed.stats.seen;
      framesParsed += framed.stats.parsed;
      framesUnsupported += framed.stats.unsupported;
      parseErrors += framed.stats.parseErrors;
      for (const value of framed.values) walk(value, "", 0, st);
      // A chunk may also be a whole JSON string rather than a frame
      // stream. Both are walked and matches deduped, so supporting one
      // shape never costs the other.
      for (const value of source.values) walk(value, "", 0, st);
      if (framed.values.length > 0 || source.values.length > 0) sourcesTraversed += 1;
      continue;
    }

    let walkedAny = false;
    for (const value of source.values) {
      walk(value, "", 0, st);
      walkedAny = true;
    }
    if (walkedAny) sourcesTraversed += 1;
  }

  const complete =
    sources.length > 0 &&
    sourcesTraversed === sources.length &&
    framesUnsupported === 0 &&
    parseErrors === 0 &&
    !truncated.v;

  return {
    kinds: [...kinds].sort(),
    recordsScanned: scanned.n,
    matches,
    truncated: truncated.v,
    coverage: {
      sourcesFound: sources.length,
      sourcesTraversed,
      framesSeen,
      framesParsed,
      framesUnsupported,
      parseErrors,
      recordsScanned: scanned.n,
      coverage: sourcesTraversed === 0 ? "NONE" : complete ? "COMPLETE" : "PARTIAL",
    },
  };
}

// Every string inside a flight source's parsed pushes, in document
// order, joined into one stream. Depth-bounded.
function collectFlightStream(values: unknown[], opts: typeof RECORD_DEFAULTS): string {
  const parts: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 16 || parts.length > 100_000) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
    }
  };
  for (const v of values) visit(v, 0);
  const joined = parts.join("");
  return joined.length > opts.maxEmbeddedJsonChars ? joined.slice(0, opts.maxEmbeddedJsonChars) : joined;
}
