// NEXT.JS FLIGHT FRAME PARSING — literal payloads only.
//
// A React Server Components stream is not one JSON document. It is a
// sequence of newline-delimited FRAMES, each of the form
//
//   <id>:<payload>
//
// where the payload may be a bare JSON literal, or a short recognised tag
// followed by one:
//
//   2:I[4707,[],""]
//   3:["$","div",null,{"rows":[…]}]
//   7:{"burns":[…]}
//
// The previous recovery only re-parsed a nested string when the ENTIRE
// string was JSON, so a chunk beginning `2:I[` failed that guard and every
// record inside the stream stayed unreachable. A live inspection reported
// four scanned objects on a two-megabyte page and drew a negative
// conclusion from it — which is exactly the failure this module exists to
// prevent.
//
// PARSE ONLY. Every payload here is handed to JSON.parse and nothing else.
// There is no eval, no Function, no VM, no script execution and no attempt
// to interpret the RSC protocol's semantics. A frame whose payload is not a
// JSON literal is REPORTED AS UNSUPPORTED, never guessed at and never run.
//
// The tag allowlist is closed. Flight adds frame types over time, and an
// unrecognised tag must widen the "not inspected" count rather than quietly
// become something this code tries to interpret.

// Tags Next.js places between the frame id and a JSON literal payload. The
// empty string covers the common untagged case (`3:[…]`). Anything else is
// unsupported by construction.
const RECOGNISED_TAGS = new Set(["", "I", "H", "HL", "HC", "E", "L", "P", "D", "J", "M", "S"]);

export interface FlightFrameStats {
  seen: number;
  parsed: number;
  unsupported: number;
  parseErrors: number;
}

export interface FlightFrameResult {
  values: unknown[];
  stats: FlightFrameStats;
}

export interface FlightFrameOptions {
  // Longest single frame payload this will attempt to parse.
  maxFrameChars?: number;
  // Ceiling on frames examined, so a pathological stream cannot become a
  // CPU problem.
  maxFrames?: number;
}

const DEFAULTS: Required<FlightFrameOptions> = {
  maxFrameChars: 2_000_000,
  maxFrames: 20_000,
};

// Splits ONE flight stream into frames and parses the literal payloads.
//
// The stream is the concatenation of every chunk string a page pushed, in
// document order — Next splits frames across pushes freely, so joining
// first is what makes a frame whole.
export function parseFlightFrames(
  stream: string,
  options: FlightFrameOptions = {},
): FlightFrameResult {
  const opts = { ...DEFAULTS, ...options };
  const values: unknown[] = [];
  const stats: FlightFrameStats = { seen: 0, parsed: 0, unsupported: 0, parseErrors: 0 };
  if (typeof stream !== "string" || stream.length === 0) return { values, stats };

  for (const rawLine of stream.split("\n")) {
    if (stats.seen >= opts.maxFrames) break;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // `<id>:` — the id is hex in practice; anything else is not a frame.
    const sep = /^([0-9a-fA-F]{1,8}):/.exec(line);
    if (!sep) continue;
    stats.seen += 1;

    const payload = line.slice(sep[0].length);
    if (payload.length === 0 || payload.length > opts.maxFrameChars) {
      stats.unsupported += 1;
      continue;
    }

    // Split the payload into an optional tag and a JSON literal. The
    // literal must START the remainder — a tag with trailing prose is not
    // something to salvage.
    const bracket = payload.search(/[[{]/);
    if (bracket < 0) {
      // No literal at all (e.g. a text frame `T2a,hello`). Unsupported by
      // design: reported, never interpreted.
      stats.unsupported += 1;
      continue;
    }
    const tag = payload.slice(0, bracket);
    if (!RECOGNISED_TAGS.has(tag)) {
      stats.unsupported += 1;
      continue;
    }

    const literal = payload.slice(bracket);
    try {
      values.push(JSON.parse(literal));
      stats.parsed += 1;
    } catch {
      // A frame split across chunk boundaries, or genuinely malformed.
      // Counted so coverage can report the stream was not fully read.
      stats.parseErrors += 1;
    }
  }

  return { values, stats };
}
