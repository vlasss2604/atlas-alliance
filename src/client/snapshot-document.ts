// READING A CAPTURED DOCUMENT AS A DOCUMENT.
//
// A snapshot exists so a reader can check a quotation against the whole
// text it came from. Showing that text as terminal output with `##` and
// `**` still in it makes real external documentation look like debug
// output, and a source that looks like debug output is harder to trust
// than one that reads like what it is.
//
// So this module turns the captured text into a STRUCTURE, and the page
// renders that structure with typography. Two properties make it safe to
// do at all:
//
//   IT PRODUCES DATA, NOT MARKUP. The output is a plain block tree. The
//   page maps it to React elements, so every character of the capture is
//   escaped by React on the way to the screen. There is no HTML string
//   anywhere in this path and no dangerouslySetInnerHTML — a hostile
//   document cannot become active content by being rendered prettily.
//
//   IT ADDS NOTHING. Every block and every span comes from characters
//   present in the capture. Nothing is summarised, reordered, completed
//   or inferred. This is a change of TYPESETTING, not of content: the
//   hash on the page still describes the text this was parsed from, and
//   the raw capture stays one click away so the two can be compared.
//
// WHAT IS DELIBERATELY NOT SUPPORTED: raw HTML blocks (dropped as text),
// footnotes, and reference-style links. A capture that uses them shows
// the literal characters rather than silently losing them.

// DID THE CAPTURE KEEP THE DOCUMENT'S STRUCTURE, OR ONLY ITS WORDS?
//
// The one question that decides how a snapshot may be READ, answered from
// what was STORED rather than from how the text happens to look. A
// markdown resource kept its own headings, lists and tables, so it opens
// as the document it is. An HTML page did not: the transport flattened it
// to text before it was ever persisted, and what survives is prose with
// every structural signal already gone.
//
// The difference is one of size as much as honesty. Measured across the
// dev database: markdown captures average 4,310 characters and top out at
// 6,299 — a document. HTML-derived captures average 18,454 and reach
// 93,173 — a wall. Opening a reader on the second buries the passage the
// research actually cited under tens of thousands of characters of
// navigation, footers and boilerplate.
//
// What must NEVER happen is the obvious-looking fix: guessing headings,
// lists or tables back out of flattened text. That would invent a
// structure ATLAS did not preserve and present the invention as the
// source's own — a fabricated provenance claim on the one screen whose
// entire purpose is to prevent them. Absence of structure is a fact about
// the capture, and the view states it rather than papering over it.
//
// It takes the representation as a string so this module stays pure and
// importable from a client component; the server names the same values.
export function preservesStructure(representation: string): boolean {
  return representation === "MARKDOWN_SOURCE";
}

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: InlineNode[] };

export type DocumentBlock =
  | { kind: "heading"; level: number; content: InlineNode[] }
  | { kind: "paragraph"; content: InlineNode[] }
  | { kind: "list"; ordered: boolean; start: number; items: InlineNode[][] }
  // A quote holds BLOCKS, not paragraphs. Its content is a document in
  // its own right: publishers put headings, lists and callouts inside
  // one, and parsing it as prose leaves the reader looking at a literal
  // `##`. Which is exactly what the Raydium capture shows — its whole
  // documentation-index prelude is quoted.
  | { kind: "quote"; blocks: DocumentBlock[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: "rule" };

export interface ParseOptions {
  // Interpret markdown structure. FALSE for a capture that was extracted
  // from HTML: that text never had markdown syntax, so reading a stray
  // asterisk in prose as emphasis would be this module inventing a
  // structure the source did not have. Such a capture is still typeset as
  // a document — proportional text in paragraphs — just not parsed.
  markdown: boolean;
  // The url the capture came from. Relative links resolve against it, so
  // a link in the document points at the publisher. Without this, `/docs/x`
  // would resolve against ATLAS and navigate a reader into this app as
  // though it were the source — a link that silently lies about where it
  // goes. Anything that will not resolve to http(s) renders as plain text.
  baseUrl: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const UNORDERED = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
// A FENCE MAY CARRY MORE THAN A LANGUAGE. CommonMark calls everything
// after the delimiters the "info string", and only its first word names a
// language; documentation generators routinely append attributes, which is
// how the Raydium capture writes every one of its blocks:
//
//   ```text theme={null}
//
// Requiring the line to END after the language rejected those, so the
// fence was never opened and its ``` markers were dumped into the reader's
// view as prose. The trailing attributes are read and discarded — they
// describe the publisher's own renderer, not the content.
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)[^`]*$/;
// A GFM delimiter row: pipes, dashes and optional alignment colons only.
const TABLE_DELIMITER = /^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

// The same ceiling the inline parser uses, for the same reason: a quote
// nests, every level strips its own marker so nesting terminates on its
// own, and the cap is what keeps a hostile capture off the stack rather
// than what makes it finite. Past it the quoted lines are kept as prose,
// which costs structure and no content.
export const MAX_BLOCK_DEPTH = 8;

export function parseSnapshotDocument(
  text: string,
  options: ParseOptions,
  depth: number = 0,
): DocumentBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocumentBlock[] = [];
  let i = 0;

  const inline = (raw: string): InlineNode[] =>
    options.markdown ? parseInline(raw, options.baseUrl) : [{ kind: "text", text: raw }];

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // A FENCE IS OPAQUE. Everything inside is preserved exactly — an
    // address, a command or a config block is content a reader may need
    // to copy character for character, so nothing in it is interpreted.
    const fence = options.markdown ? FENCE.exec(line) : null;
    if (fence) {
      const marker = fence[1];
      const language = fence[2] || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !isClosingFence(lines[i], marker)) {
        body.push(lines[i]);
        i++;
      }
      // An unterminated fence still yields its content rather than
      // swallowing the rest of the document.
      if (i < lines.length) i++;
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }

    if (options.markdown && RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    const heading = options.markdown ? HEADING.exec(line) : null;
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        content: inline(heading[2].trim()),
      });
      i++;
      continue;
    }

    if (options.markdown && QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      // The quoted lines are a document, so they are parsed as one. Past
      // the ceiling they stay prose rather than descending further.
      blocks.push({
        kind: "quote",
        blocks:
          depth + 1 >= MAX_BLOCK_DEPTH
            ? splitParagraphs(quoted).map((p) => ({
                kind: "paragraph" as const,
                content: inline(p),
              }))
            : parseSnapshotDocument(quoted.join("\n"), options, depth + 1),
      });
      continue;
    }

    // A TABLE NEEDS ITS DELIMITER ROW. Without one, a line containing
    // pipes is just a line containing pipes, and guessing otherwise would
    // reshape prose into a grid that was never in the source.
    if (
      options.markdown &&
      line.includes("|") &&
      i + 1 < lines.length &&
      TABLE_DELIMITER.test(lines[i + 1])
    ) {
      const header = splitTableRow(lines[i]).map((c) => inline(c));
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]).map((c) => inline(c)));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const listMatch = options.markdown
      ? (UNORDERED.exec(line) ?? ORDERED.exec(line))
      : null;
    if (listMatch) {
      const ordered = ORDERED.test(line);
      const start = ordered ? Number(ORDERED.exec(line)![1]) : 1;
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const current = lines[i];
        const asUnordered = UNORDERED.exec(current);
        const asOrdered = ORDERED.exec(current);
        const isSameKind = ordered ? Boolean(asOrdered) : Boolean(asUnordered);
        if (!isSameKind) break;
        const itemText = ordered ? asOrdered![2] : asUnordered![1];
        const continuation: string[] = [itemText];
        i++;
        // An indented line that starts no new item belongs to the item
        // above it — wrapped list text is common and should not become a
        // detached paragraph.
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          /^\s{2,}\S/.test(lines[i]) &&
          !UNORDERED.test(lines[i]) &&
          !ORDERED.test(lines[i])
        ) {
          continuation.push(lines[i].trim());
          i++;
        }
        items.push(inline(continuation.join(" ")));
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    // PARAGRAPH — everything up to a blank line or the start of another
    // block. Soft line breaks inside a paragraph become spaces, which is
    // what makes reflowed text read as prose rather than as a column of
    // fragments.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i], options)) {
      paragraph.push(lines[i].trim());
      i++;
    }
    if (paragraph.length === 0) {
      // The line starts a block only reachable above; consume it as text
      // so the loop cannot stall.
      paragraph.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: "paragraph", content: inline(paragraph.join(" ")) });
  }

  return blocks;
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(marker[0].repeat(3)) && /^[`~]+$/.test(trimmed);
}

function startsBlock(line: string, options: ParseOptions): boolean {
  if (!options.markdown) return false;
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    FENCE.test(line) ||
    UNORDERED.test(line) ||
    ORDERED.test(line)
  );
}

function splitParagraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) out.push(current.join(" "));
      current = [];
    } else {
      current.push(line.trim());
    }
  }
  if (current.length > 0) out.push(current.join(" "));
  return out;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

// WHERE A LINK MAY POINT.
//
// http(s) only, resolved against the document's own url. A `javascript:`
// or `data:` href is not rendered as a link at all — the reader sees the
// link text as plain text instead, so nothing is hidden and nothing is
// clickable that should not be.
export function resolveSnapshotHref(raw: string, baseUrl: string): string | null {
  const candidate = raw.trim();
  if (candidate === "") return null;
  try {
    const url = new URL(candidate, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Inline spans, in precedence order: code first (it suppresses everything
// inside it), then links, then strong, then emphasis. Anything that does
// not match stays literal text.
//
// THE PATTERN IS SHARED; THE CURSOR IS NOT. A global RegExp carries its
// `lastIndex` on the object itself, and `parseInline` is recursive. One
// shared instance meant a nested call — the contents of a strong span, the
// text of a link — reset the cursor the OUTER loop was still using, so on
// return that loop resumed from position 0, matched the very same span
// again, recursed again, and never terminated: the heap ran out before the
// loop did. So the pattern is a string constant and every invocation
// compiles its own RegExp. Cursor state is then owned by the call that
// uses it, which is a structural property rather than a rule someone has
// to remember. Do not hoist the compiled form back to module scope.
const INLINE_SOURCE = [
  "(`+)([\\s\\S]*?)\\1", // 1,2 code
  "\\[([^\\]]*)\\]\\(\\s*<?([^)\\s>]*)>?[^)]*\\)", // 3,4 link
  "(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\5", // 5,6 strong
  "(\\*|_)(?=\\S)([\\s\\S]*?\\S)\\7", // 7,8 emphasis
].join("|");

// A CEILING ON NESTING, because a capture is an untrusted document.
// Every recursion parses a STRICTLY shorter string — a span always loses
// at least its own delimiters — so nesting terminates on its own. The
// ceiling is against the stack, not against non-termination: a
// pathological run of delimiters could descend thousands of levels first.
// Past it the remaining span renders as the characters it is made of,
// which costs styling and no content at all. Real prose nests two or
// three levels; a link holding bold holding code is four.
export const MAX_INLINE_DEPTH = 8;

export function parseInline(
  raw: string,
  baseUrl: string,
  depth: number = 0,
): InlineNode[] {
  if (depth >= MAX_INLINE_DEPTH) {
    return raw === "" ? [] : [{ kind: "text", text: raw }];
  }

  // Compiled here, per invocation, for the reason above.
  const pattern = new RegExp(INLINE_SOURCE, "g");
  const nodes: InlineNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > last) {
      nodes.push({ kind: "text", text: raw.slice(last, match.index) });
    }

    if (match[1] !== undefined) {
      nodes.push({ kind: "code", text: match[2].trim() });
    } else if (match[3] !== undefined) {
      const href = resolveSnapshotHref(match[4], baseUrl);
      const children = parseInline(match[3], baseUrl, depth + 1);
      // An unusable destination keeps the words and drops the link. The
      // reader loses nothing readable and gains nothing clickable.
      nodes.push(href ? { kind: "link", href, children } : { kind: "text", text: match[3] });
    } else if (match[5] !== undefined) {
      nodes.push({ kind: "strong", children: parseInline(match[6], baseUrl, depth + 1) });
    } else if (match[7] !== undefined) {
      nodes.push({ kind: "em", children: parseInline(match[8], baseUrl, depth + 1) });
    }

    last = match.index + match[0].length;
  }

  if (last < raw.length) nodes.push({ kind: "text", text: raw.slice(last) });
  return nodes;
}

// The plain text of a parsed document, used by tests to assert that no
// markdown marker survives into what a reader sees.
export function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "text":
          return n.text;
        case "code":
          return n.text;
        default:
          return inlineText(n.children);
      }
    })
    .join("");
}
