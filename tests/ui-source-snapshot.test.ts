import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SnapshotDocumentView } from "../src/client/components/snapshot-document-view";
import {
  inlineText,
  MAX_BLOCK_DEPTH,
  preservesStructure,
  MAX_INLINE_DEPTH,
  parseInline,
  parseSnapshotDocument,
  resolveSnapshotHref,
  type DocumentBlock,
  type InlineNode,
} from "../src/client/snapshot-document";
import { representationOf, SNAPSHOT_BODY_LIMIT } from "../src/server/services/source-snapshot";

// ATLAS SOURCE SNAPSHOT — THE DOCUMENT THAT WAS ACTUALLY READ.
//
// What acquisition already stores, measured before any of this was built:
//
//   acquired_documents  — 121 rows, every field this feature needs
//   text/html   (103)   — persisted as EXTRACTED TEXT; no row contains a tag
//   text/markdown (18)  — persisted verbatim
//   longest capture     — 93,173 characters
//   no PDF bytes anywhere
//
// Two consequences the tests below pin. First, a snapshot needs no new
// fetch and no new storage: it IS the representation research reasoned
// over. Second, there is no stored markup to replay, so the whole class of
// "safely render remote HTML" problems does not arise — and must not be
// re-introduced by making the view prettier.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const SERVICE = "src/server/services/source-snapshot.ts";
const VIEW = "src/client/components/snapshot-document-view.tsx";
const PAGE = "app/(app)/research/[id]/source/[evidenceId]/page.tsx";
const LADDER = "src/client/components/result-ladder.tsx";
const ROUTE = "app/api/research-jobs/[id]/snapshots/[evidenceId]/route.ts";

const BASE = "https://docs.example.test/ray/ray-buybacks.md";

function doc(text: string, markdown = true): DocumentBlock[] {
  return parseSnapshotDocument(text, { markdown, baseUrl: BASE });
}

function html(text: string, markdown = true): string {
  return render(
    createElement(SnapshotDocumentView, { content: text, markdown, baseUrl: BASE }),
  );
}

// Comments name the things they introduce, so a scan for a forbidden
// construct must read the code rather than the prose about it.
function codeOf(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/* ---------------------------------------------------------------- *
 * WHAT A SNAPSHOT IS, AND IS NOT
 * ---------------------------------------------------------------- */

describe("source snapshot — the capture is described honestly", () => {
  it("an HTML page is never described as a preserved page", () => {
    // The transport strips markup before persisting, so what survives an
    // HTML source is its text. Calling that "the page" would claim a
    // fidelity the capture does not have.
    expect(representationOf("text/html; charset=utf-8")).toBe("EXTRACTED_TEXT");
    expect(representationOf("text/markdown")).toBe("MARKDOWN_SOURCE");
    expect(representationOf("application/json")).toBe("TEXT");

    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain("Captured representation of the source ATLAS retrieved");
    // The three notes must each exist, and the HTML one must say what was
    // lost rather than implying a faithful copy.
    expect(page).toContain("Layout, images and navigation were not kept");
    expect(page).toMatch(/not the (live )?page/i);
  });

  it("the view never claims to be the original, and always offers it", () => {
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain("ATLAS source snapshot");
    expect(page).toContain("snapshot-open-original");
    // "Open original" is the escape hatch to the live document. A snapshot
    // that could not be compared against its source would be worth less
    // than the excerpt it explains.
    expect(page).toContain("Open original");
  });

  it("the body is bounded, and truncation is declared rather than silent", () => {
    expect(SNAPSHOT_BODY_LIMIT).toBeGreaterThan(93_173);
    const service = readFileSync(SERVICE, "utf-8");
    expect(service).toContain("truncated");
    expect(service).toContain("fullLength");
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain("snapshot-truncated");
    // The hash keeps describing the WHOLE capture, so a truncated view
    // must say so rather than letting the hash look like it covers the
    // visible text.
    expect(page).toMatch(/hashes above cover/i);
  });
});

/* ---------------------------------------------------------------- *
 * THE CARD IS AN IDENTITY, AND THE TRANSPORT RECORD IS STILL THERE
 * ---------------------------------------------------------------- */

describe("source snapshot — the provenance card reads as an identity", () => {
  it("the identity leads: publisher, kind, date, then what this copy is", () => {
    const page = readFileSync(PAGE, "utf-8");
    const at = (needle: string) => page.indexOf(needle);
    // Eyebrow, then the domain as the headline, then the badge and the
    // capture date, then the note, then the way out to the live page.
    expect(at("ATLAS source snapshot")).toBeLessThan(at("{domain}"));
    expect(at("{domain}")).toBeLessThan(at("snapshot-source-class"));
    expect(at("snapshot-source-class")).toBeLessThan(at("snapshot-captured"));
    expect(at("snapshot-captured")).toBeLessThan(at("snapshot-representation-note"));
    expect(at("snapshot-representation-note")).toBeLessThan(at("snapshot-open-original"));
    // And the transport record comes after all of it.
    expect(at("snapshot-open-original")).toBeLessThan(at("snapshot-technical"));
  });

  it("no provenance field was dropped on the way behind the disclosure", () => {
    const page = readFileSync(PAGE, "utf-8");
    // Every field the card carried before the polish is still rendered.
    for (const label of [
      "Captured",
      "Type",
      "Response",
      "Size",
      "Retrieved from",
      "Landed on",
      "Content hash",
      "Text hash",
    ]) {
      expect(page, label).toContain(`label="${label}"`);
    }
    // The values are the persisted ones, not prettier versions of them.
    expect(page).toContain("snapshot.contentHash");
    expect(page).toContain("snapshot.textSha256");
    expect(page).toContain("snapshot.retrievedUrl");
    expect(page).toContain("snapshot.httpStatus");
    expect(page).toContain("snapshot.byteLength");
    expect(page).toContain("snapshot.contentType");
  });

  it("the technical rows stay a readable key/value grid, not centred decoration", () => {
    const page = readFileSync(PAGE, "utf-8");
    const details = page.slice(page.indexOf('data-testid="snapshot-technical"'));
    const grid = details.slice(details.indexOf("<dl"), details.indexOf("</dl>"));
    // Centred metadata is decoration; this is the part that has to be read
    // precisely, so the grid is explicitly left-aligned inside a centred card.
    expect(grid).toContain("text-left");
    expect(grid).toContain("sm:grid-cols-2");
    expect(grid).not.toContain("text-center");
    // Closed by default — a native <details> with no `open` attribute.
    expect(details.slice(0, 200)).not.toMatch(/\bopen\b/);
  });

  it("the source-type badge is a KIND marker from persisted classification", () => {
    const page = readFileSync(PAGE, "utf-8");
    // It comes from the engine's own `evidence.source_class`, through the
    // shared label map — never a judgement this page makes, and never a
    // second vocabulary for something the result card already names.
    expect(page).toContain("sourceClassLabel(snapshot.sourceClass)");
    expect(page).toContain("{snapshot.sourceClass && (");
    // No score, no rank, no ordering language reaches the card. Scanned
    // over the RENDER: the badge's own comment says it is "never a
    // score", and a ban a denial trips measures documentation instead of
    // what a reader sees.
    const rendered = codeOf(PAGE);
    const header = rendered.slice(
      rendered.indexOf('data-testid="snapshot-header"'),
      rendered.indexOf('data-testid="snapshot-content"'),
    );
    for (const scoreish of ["score", "rating", "rank", "trust", "quality"]) {
      expect(header.toLowerCase(), scoreish).not.toContain(scoreish);
    }
  });

  it("the class is projected from the persisted column, not invented here", () => {
    const service = readFileSync(SERVICE, "utf-8");
    // Read in the query that already loads the Evidence row: one more
    // column on one existing read, no second query and no new table.
    expect(service).toContain("sourceClass: evidence.sourceClass");
    expect(service).toContain("sourceClass: row.sourceClass");
    expect(service).toContain("sourceClass: string | null");
    // Nullable, because legacy Evidence honestly carries no class. The
    // card then shows no badge rather than guessing one.
    const page = readFileSync(PAGE, "utf-8");
    expect(page).not.toMatch(/sourceClass\s*\?\?\s*["']/);
  });
});

/* ---------------------------------------------------------------- *
 * SAFETY — A CAPTURE IS TEXT, AND STAYS TEXT
 * ---------------------------------------------------------------- */

describe("source snapshot — captured content cannot execute", () => {
  it("no snapshot surface uses dangerouslySetInnerHTML, an iframe or an embed", () => {
    for (const path of [VIEW, PAGE]) {
      const code = codeOf(path);
      expect(code, path).not.toContain("dangerouslySetInnerHTML");
      expect(code, path).not.toMatch(/<iframe|<embed|<object/i);
    }
  });

  it("markup inside a capture renders as visible characters, not as elements", () => {
    const hostile = html('# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror="go()">');
    // Escaped: the reader SEES the tag, the browser does not run it. So
    // the invariant is not that the characters are absent — they are the
    // document's own content and deleting them would be this view editing
    // a source. The invariant is that none of them form MARKUP.
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("&lt;script&gt;");
    expect(hostile).not.toMatch(/<img|<script|<\/script/i);
    // An attribute needs an unescaped quote to open. `onerror=&quot;` is
    // text on the page; `onerror="` would be a handler on an element.
    expect(hostile).not.toContain('onerror="');
    expect(hostile).toContain("onerror=&quot;");
  });

  it("a javascript: or data: destination is not rendered as a link", () => {
    expect(resolveSnapshotHref("javascript:alert(1)", BASE)).toBeNull();
    expect(resolveSnapshotHref("data:text/html,<script>", BASE)).toBeNull();
    const out = html("[click me](javascript:alert(1))");
    expect(out).toContain("click me");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a ");
  });

  it("a relative link resolves against the source, never against ATLAS", () => {
    // `/docs/x` resolved against the app would navigate a reader inside
    // ATLAS as though it were the publisher's page — a link that lies
    // about where it goes.
    expect(resolveSnapshotHref("/ray/fees", BASE)).toBe("https://docs.example.test/ray/fees");
    const out = html("[fees](/ray/fees)");
    expect(out).toContain('href="https://docs.example.test/ray/fees"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

/* ---------------------------------------------------------------- *
 * READABILITY — A DOCUMENT, NOT TERMINAL OUTPUT
 * ---------------------------------------------------------------- */

describe("source snapshot — the capture reads as a document", () => {
  it("markdown markers do not reach the reader", () => {
    const source = [
      "# Protocol fees",
      "",
      "## Buybacks",
      "",
      "The protocol directs **12%** of fees to buybacks.",
      "",
      "- first",
      "- second",
    ].join("\n");

    const out = html(source);
    // No structural marker survives into the rendered text.
    expect(out).not.toContain("##");
    expect(out).not.toContain("**");
    // And the words all did.
    expect(out).toContain("Protocol fees");
    expect(out).toContain("Buybacks");
    expect(out).toContain("12%");
  });

  it("headings become real headings, in their original hierarchy", () => {
    const blocks = doc("# One\n\n## Two\n\n### Three");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "heading", "heading"]);
    expect(blocks.map((b) => (b.kind === "heading" ? b.level : 0))).toEqual([1, 2, 3]);

    // Demoted by one on screen: the page's own h1 is the provenance
    // header, so the captured document sits inside it rather than
    // competing with it — while keeping its internal levels distinct.
    const out = html("# One\n\n## Two");
    expect(out).toContain("<h2");
    expect(out).toContain("<h3");
    expect(out).not.toContain("<h1");
  });

  it("bullet and numbered lists become real lists", () => {
    const bullets = doc("- alpha\n- beta");
    expect(bullets).toHaveLength(1);
    expect(bullets[0].kind).toBe("list");
    if (bullets[0].kind === "list") {
      expect(bullets[0].ordered).toBe(false);
      expect(bullets[0].items).toHaveLength(2);
      expect(inlineText(bullets[0].items[0])).toBe("alpha");
    }

    const numbered = doc("3. third\n4. fourth");
    if (numbered[0].kind === "list") {
      expect(numbered[0].ordered).toBe(true);
      // The document's own numbering is preserved rather than reset to 1.
      expect(numbered[0].start).toBe(3);
    }

    expect(html("- alpha\n- beta")).toContain("<ul");
    expect(html("1. one")).toContain("<ol");
  });

  it("a table becomes a table, and scrolls inside its own box", () => {
    const blocks = doc("| Fee | Share |\n| --- | ----- |\n| Swap | 12% |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("table");
    if (blocks[0].kind === "table") {
      expect(blocks[0].header.map(inlineText)).toEqual(["Fee", "Share"]);
      expect(blocks[0].rows[0].map(inlineText)).toEqual(["Swap", "12%"]);
    }
    const out = html("| Fee | Share |\n| --- | ----- |\n| Swap | 12% |");
    expect(out).toContain("<table");
    // A wide capture must not make the page scroll sideways on a phone.
    expect(out).toContain("overflow-x-auto");
  });

  it("prose that merely contains pipes is not reshaped into a grid", () => {
    // Guessing a table without its delimiter row would impose a structure
    // the source never had.
    const blocks = doc("Fees are split A | B | C across pools.");
    expect(blocks[0].kind).toBe("paragraph");
  });

  it("a code fence keeps its content exactly, and interprets nothing inside it", () => {
    const blocks = doc("```bash\nsolana address **not bold**\n```");
    expect(blocks[0].kind).toBe("code");
    if (blocks[0].kind === "code") {
      expect(blocks[0].language).toBe("bash");
      // An address or command must survive character for character.
      expect(blocks[0].text).toBe("solana address **not bold**");
    }
  });

  it("inline code, bold and emphasis become typography", () => {
    const nodes = parseInline("a `chip`, **strong** and *soft*", BASE);
    expect(nodes.map((n) => n.kind)).toEqual([
      "text",
      "code",
      "text",
      "strong",
      "text",
      "em",
    ]);
    const out = html("a `chip`, **strong** and *soft*");
    expect(out).toContain("<code");
    expect(out).toContain("<strong");
    expect(out).toContain("<em");
    expect(out).not.toContain("`chip`");
  });

  it("a fence carrying renderer attributes still opens", () => {
    // Every code block in the real Raydium capture is written this way.
    // CommonMark calls it the info string; only its first word is a
    // language. Requiring the line to end after the language left three
    // blocks unopened and dumped their ``` markers into the reader's view.
    const blocks = doc("```text theme={null}\n84% to LPs\n12% to RAY buybacks\n```");
    expect(blocks[0].kind).toBe("code");
    if (blocks[0].kind === "code") {
      expect(blocks[0].language).toBe("text");
      expect(blocks[0].text).toBe("84% to LPs\n12% to RAY buybacks");
    }
    expect(html("```text theme={null}\nx\n```")).not.toContain("```");
  });

  it("blockquotes get a restrained quote treatment", () => {
    const blocks = doc("> quoted line\n> second line");
    expect(blocks[0].kind).toBe("quote");
    expect(html("> quoted line")).toContain("<blockquote");
  });

  it("a quote holds a document, so a quoted heading is a heading", () => {
    // The Raydium capture opens with a quoted documentation-index
    // prelude. Parsing a quote's content as prose left "## Documentation
    // Index" on screen with its marker intact — the first thing a reader
    // met on the page.
    const blocks = doc("> ## Documentation Index\n> Fetch the index at: https://x.test\n");
    expect(blocks[0].kind).toBe("quote");
    if (blocks[0].kind === "quote") {
      expect(blocks[0].blocks.map((b) => b.kind)).toEqual(["heading", "paragraph"]);
      const head = blocks[0].blocks[0];
      if (head.kind === "heading") {
        expect(head.level).toBe(2);
        expect(inlineText(head.content)).toBe("Documentation Index");
      }
    }
    const out = html("> ## Documentation Index\n> body\n");
    expect(out).toContain("<blockquote");
    expect(out).not.toContain("##");
  });

  it("a quote nested past the ceiling stays prose instead of the stack", () => {
    const deep = `${"> ".repeat(40)}x`;
    const blocks = doc(deep);
    let level = 0;
    let node: DocumentBlock | undefined = blocks[0];
    while (node && node.kind === "quote") {
      level += 1;
      node = node.blocks[0];
    }
    expect(level).toBeLessThanOrEqual(MAX_BLOCK_DEPTH);
    expect(level).toBeGreaterThan(0);
  });

  it("soft-wrapped prose reflows into paragraphs rather than a column of fragments", () => {
    const blocks = doc("The protocol directs\nfees to buybacks.\n\nA second paragraph.");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("paragraph");
    if (blocks[0].kind === "paragraph") {
      expect(inlineText(blocks[0].content)).toBe("The protocol directs fees to buybacks.");
    }
  });

  it("the default view is the document, with the exact text one click away", () => {
    const page = readFileSync(PAGE, "utf-8");
    // Raw is opt-in — the readable form answers "what does this source
    // say?", and the exact text answers "is this really what you stored?".
    expect(page).toContain("Show exact captured text");
    expect(page).toContain("useState(false)");
    expect(page).toContain("snapshot-raw");
  });
});

/* ---------------------------------------------------------------- *
 * NOTHING IS INVENTED
 * ---------------------------------------------------------------- */

describe("source snapshot — typesetting adds no content", () => {
  it("every visible character comes from the capture", () => {
    const source = "# Title\n\nBody text with **emphasis** and a [link](https://x.test).";
    const blocks = doc(source);
    const visible = blocks
      .map((b) => {
        switch (b.kind) {
          case "heading":
          case "paragraph":
            return inlineText(b.kind === "heading" ? b.content : b.content);
          default:
            return "";
        }
      })
      .join(" ");
    expect(visible).toContain("Title");
    expect(visible).toContain("Body text with emphasis and a link.");
    // No word that was not in the source.
    expect(visible).not.toMatch(/summary|according to|ATLAS/i);
  });

  it("an extracted-text capture is not parsed as markdown", () => {
    // It never had markdown syntax. Reading a stray asterisk in prose as
    // emphasis would invent a structure the document did not have.
    const blocks = doc("Fees * are * split", false);
    expect(blocks[0].kind).toBe("paragraph");
    if (blocks[0].kind === "paragraph") {
      expect(inlineText(blocks[0].content)).toBe("Fees * are * split");
    }
    const page = readFileSync(PAGE, "utf-8");
    expect(page).toContain('snapshot.representation === "MARKDOWN_SOURCE"');
  });

  it("the snapshot view carries no publisher branding of its own", () => {
    const view = readFileSync(VIEW, "utf-8");
    // ATLAS's own typography, never an imitation of the source's site.
    expect(view).not.toMatch(/raydium/i);
    expect(view).not.toMatch(/logo|favicon|<img/i);
  });
});

/* ---------------------------------------------------------------- *
 * TWO KINDS OF CAPTURE, TWO WAYS TO READ ONE
 * ---------------------------------------------------------------- */

describe("source snapshot — a flattened capture is not a document", () => {
  it("structure is decided by what was stored, never by how the text looks", () => {
    // Markdown kept its own structure. An HTML page was flattened to text
    // by the transport before it was persisted, so there is none to show.
    expect(preservesStructure("MARKDOWN_SOURCE")).toBe(true);
    expect(preservesStructure("EXTRACTED_TEXT")).toBe(false);
    // A plain-text or JSON capture never carried structure either, so it
    // reads the same way rather than being parsed on a hunch.
    expect(preservesStructure("TEXT")).toBe(false);
    expect(preservesStructure(representationOf("text/html; charset=utf-8"))).toBe(false);
    expect(preservesStructure(representationOf("text/markdown"))).toBe(true);
  });

  it("no structure is ever reconstructed from flattened text", () => {
    // The tempting fix, permanently barred. Reading a heading out of
    // extracted prose would invent a structure ATLAS did not preserve and
    // show the invention as the source's own.
    const blocks = doc("Fees\n\n84% to LPs\n\n## not a heading\n\n| a | b |", false);
    expect(blocks.every((b) => b.kind === "paragraph")).toBe(true);
    const out = html("## not a heading\n\n- not a list", false);
    expect(out).not.toContain("<h2");
    expect(out).not.toContain("<h3");
    expect(out).not.toContain("<ul");
    expect(out).not.toContain("<table");
    // The markers stay visible, because they are characters the capture
    // really contains.
    expect(out).toContain("## not a heading");
    expect(out).toContain("- not a list");
  });

  it("a flattened capture leads with the cited passage, not the wall", () => {
    const page = readFileSync(PAGE, "utf-8");
    const at = (needle: string) => page.indexOf(needle);
    // It says what it is, shows the excerpt, and only then offers the
    // whole capture.
    expect(page).toContain("Extracted text snapshot");
    // JSX wraps prose across lines, so the sentence is matched against a
    // whitespace-normalised copy rather than the raw source layout.
    const prose = page.replace(/\s+/g, " ");
    expect(prose).toContain("This is the text representation ATLAS captured from the page.");
    expect(prose).toContain(
      "The original page structure was not preserved in this snapshot.",
    );
    expect(at("snapshot-flat-note")).toBeLessThan(at("snapshot-excerpt"));
    expect(at("snapshot-excerpt")).toBeLessThan(at("Show full captured text"));
    // The excerpt is this Evidence row's own fragment — the words the
    // finding quoted, never a passage chosen here.
    expect(page).toContain("{snapshot.fragment}");
    expect(page).toContain("Relevant excerpt");
  });

  it("the whole capture is kept, reachable and unmodified — just not default", () => {
    const page = readFileSync(PAGE, "utf-8");
    const flat = page.slice(page.indexOf('data-testid="snapshot-flat-note"'));
    // Behind a control, rendered verbatim, and never truncated or
    // rewritten on its way to the screen.
    expect(flat).toContain("Show full captured text");
    expect(flat).toContain("Hide full captured text");
    expect(flat).toContain("{snapshot.content}");
    expect(flat).toContain('data-testid="snapshot-raw"');
    // The reader is told how much there is before choosing to open it.
    expect(flat).toContain("snapshot.fullLength.toLocaleString()");
  });

  it("the structured reader is untouched and still the default for markdown", () => {
    const page = readFileSync(PAGE, "utf-8");
    const structured = page.slice(
      page.indexOf("{structured ? ("),
      page.indexOf('data-testid="snapshot-flat-note"'),
    );
    // Same document view, still the default for a structured capture.
    expect(structured).toContain("<SnapshotDocumentView");
    // Its opt-in exact text is unchanged, and offered only on this branch
    // — the flat branch has its own "full captured text" control instead.
    expect(page).toContain("Show exact captured text");
    expect(page).toContain("Show as document");
    expect(page).toContain("{structured && (");
    // And the branch is chosen by the stored representation, not by size,
    // not by sniffing the text.
    expect(page).toContain("preservesStructure(snapshot.representation)");
    expect(page).not.toMatch(/content\.length\s*[<>]/);
  });
});

/* ---------------------------------------------------------------- *
 * TERMINATION — THE PARSER ALWAYS COMES BACK
 * ---------------------------------------------------------------- */

// A capture is an untrusted document, and this parser is recursive. It
// once did NOT come back: `parseInline` shared one module-level global
// RegExp, whose `lastIndex` lives on the object. A nested call — a strong
// span's contents, a link's text — set that cursor to 0, so the OUTER
// loop resumed from the start of its own string, matched the same span
// again, recursed again, and grew the node list until V8 died. The input
// that did it was ordinary documentation prose: "a `chip`, **strong** and
// *soft*".
//
// Every test below therefore proves the same thing twice: the call
// RETURNS (a hang cannot be caught, so a hang fails the run by killing
// the worker), and it returns something bounded and correct.

// A budget generous enough not to be flaky on a slow machine, and far
// below what a runaway-but-finite parse would take. Termination is what
// is being asserted; the number is only a guard against a regression that
// is slow rather than infinite.
const PARSE_BUDGET_MS = 5_000;

function within(budgetMs: number, run: () => void): number {
  const started = Date.now();
  run();
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(budgetMs);
  return elapsed;
}

// How deep the returned tree actually nests — the observable half of the
// depth ceiling.
function nestingDepth(nodes: InlineNode[]): number {
  let deepest = 0;
  for (const node of nodes) {
    if (node.kind === "strong" || node.kind === "em" || node.kind === "link") {
      deepest = Math.max(deepest, 1 + nestingDepth(node.children));
    }
  }
  return deepest;
}

describe("source snapshot — the inline parser always terminates", () => {
  it("no cursor is shared between a parse and the parse nested inside it", () => {
    const code = codeOf("src/client/snapshot-document.ts");
    // The root cause, pinned structurally so it cannot come back by
    // someone hoisting the compiled regex for speed.
    expect(code).toContain("const pattern = new RegExp(INLINE_SOURCE");
    expect(code).not.toMatch(/^const\s+\w+\s*=\s*new RegExp\(/m);
    expect(code).not.toContain("lastIndex");
  });

  it("the exact input that hung the parser now returns a bounded tree", () => {
    const source = "a `chip`, **strong** and *soft*";
    within(PARSE_BUDGET_MS, () => {
      const nodes = parseInline(source, BASE);
      expect(nodes.map((n) => n.kind)).toEqual([
        "text",
        "code",
        "text",
        "strong",
        "text",
        "em",
      ]);
      // The runaway produced the SAME span over and over. A bounded tree
      // cannot hold more spans than the source has delimiters.
      expect(nodes).toHaveLength(6);
    });
  });

  it("every supported construct terminates, alone and mixed", () => {
    const cases: [string, string][] = [
      ["plain text", "Fees are directed to buybacks."],
      ["inline code", "the `normalized_text` column"],
      ["strong", "**Established** by the document"],
      ["emphasis", "*intended*, not observed"],
      ["link", "see [the policy](https://docs.example.test/policy)"],
      ["relative link", "see [fees](/ray/fees)"],
      ["mixed", "a `chip`, **strong** and *soft*"],
      ["adjacent", "**one****two** *a**b*"],
      ["nested", "**bold with *inner* and `code`**"],
      ["link holding spans", "[**bold** and `code`](https://x.test)"],
      ["code suppresses markers", "`**not bold**`"],
      ["underscores", "__strong__ and _soft_ and snake_case_word"],
    ];
    for (const [label, source] of cases) {
      within(PARSE_BUDGET_MS, () => {
        const nodes = parseInline(source, BASE);
        expect(nodes.length, label).toBeGreaterThan(0);
        // Whatever the shape, the reader is left with characters.
        expect(inlineText(nodes).length, label).toBeGreaterThan(0);
      });
    }
  });

  it("malformed and unclosed markdown terminates and keeps its characters", () => {
    // A capture is not a well-formed document and must never be required
    // to be one. An unclosed marker is not a span, so it stays literal —
    // dropping it would be this view silently editing a source.
    const cases = [
      "**unclosed strong",
      "*unclosed em",
      "`unclosed code",
      "[unclosed link](https://x.test",
      "[text with no destination]",
      "](backwards)[",
      "***",
      "____",
      "* * * a * * *",
      "a ** b ** c",
    ];
    for (const source of cases) {
      within(PARSE_BUDGET_MS, () => {
        const nodes = parseInline(source, BASE);
        const visible = inlineText(nodes);
        // Nothing invented: every character of the result is a character
        // of the source, in order.
        expect(source.includes(visible) || visible.length <= source.length).toBe(true);
        for (const ch of visible) expect(source).toContain(ch);
      });
    }
  });

  it("a long ordinary capture parses well inside the bound that is served", () => {
    // SNAPSHOT_BODY_LIMIT is what a reader can actually receive, so that
    // is the size termination has to hold at. The largest real capture in
    // the dev database is 93,173 characters.
    const sentence = "The protocol directs a share of trading fees to buybacks. ";
    const long = sentence.repeat(Math.ceil(SNAPSHOT_BODY_LIMIT / sentence.length));
    expect(long.length).toBeGreaterThanOrEqual(SNAPSHOT_BODY_LIMIT);
    within(PARSE_BUDGET_MS, () => {
      const blocks = parseSnapshotDocument(long, { markdown: true, baseUrl: BASE });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("paragraph");
    });
  });

  it("a pathological run of delimiters cannot descend without a floor", () => {
    // Nesting terminates on its own — every recursion parses a strictly
    // shorter string — but "on its own" could still be thousands of
    // frames deep. The ceiling is what keeps a hostile capture off the
    // stack, and past it the span renders as the characters it is made of.
    const pathological = `${"*".repeat(400)}x${"*".repeat(400)}`;
    within(PARSE_BUDGET_MS, () => {
      const nodes = parseInline(pathological, BASE);
      expect(nestingDepth(nodes)).toBeLessThanOrEqual(MAX_INLINE_DEPTH);
      // The content survives the ceiling; only styling is given up.
      expect(inlineText(nodes)).toContain("x");
    });
  });

  it("parsing the same capture twice gives the same tree", () => {
    // The runaway was a state bug — one parse changed what the next one
    // did. Determinism is the property that says the state is gone.
    const source =
      "# Buybacks\n\nA `chip`, **strong** and *soft* with [a link](/ray/fees).\n\n- one\n- two\n\n| Fee | Share |\n| --- | --- |\n| Swap | 12% |\n";
    const first = parseSnapshotDocument(source, { markdown: true, baseUrl: BASE });
    const second = parseSnapshotDocument(source, { markdown: true, baseUrl: BASE });
    expect(second).toEqual(first);
    // And a nested parse does not change what a later sibling parse sees.
    const sibling = parseInline("**a** then `b` then *c*", BASE);
    expect(sibling.map((n) => n.kind)).toEqual(["strong", "text", "code", "text", "em"]);
  });

  it("markup in a hostile capture still cannot execute after all of this", () => {
    // Termination must not have been bought by relaxing the escaping.
    const out = html("**bold** <script>alert(1)</script> <img src=x onerror=\"go()\">");
    expect(out).not.toMatch(/<img|<script/i);
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain('onerror="');
    expect(out).toContain("<strong");
  });
});

/* ---------------------------------------------------------------- *
 * LINKAGE, OWNERSHIP AND THE ACTION THAT LEADS TO IT
 * ---------------------------------------------------------------- */

describe("source snapshot — reachable only where it exists, and only by its owner", () => {
  it("the action appears only when a capture actually exists", () => {
    const ladder = codeOf(LADDER);
    // Not disabled, not greyed — absent. A dead button spends a reader's
    // trust to tell them nothing.
    expect(ladder).toContain("item.hasSnapshot && jobId");
    expect(ladder).toContain("view-source-snapshot");
    expect(ladder).toContain("View source snapshot");
  });

  it("the card still offers the live original alongside it", () => {
    const ladder = codeOf(LADDER);
    expect(ladder).toContain("open-source");
    expect(ladder).toContain("Open original");
    expect(ladder).toContain('target="_blank"');
  });

  it("ownership is enforced in the query, not after it", () => {
    const service = codeOf(SERVICE);
    expect(service).toContain("researchJobs.userId, ownerUserId");
    // Job scope on the document too: a row another job fetched can never
    // surface as this job's provenance.
    expect(service).toContain("acquiringJobId");
    expect(service).toContain("consumedByJobId");
  });

  it("absent, not-owned and never-captured are indistinguishable to a caller", () => {
    const route = readFileSync(ROUTE, "utf-8");
    expect(route).toContain("requireSession");
    expect(route).toContain("requireUuid");
    expect(route).toContain('new HttpError(404, "NOT_FOUND")');
  });

  it("the snapshot is fetched on demand, never bundled into the result payload", () => {
    const api = readFileSync("src/client/api.ts", "utf-8");
    expect(api).toContain("getSourceSnapshot");
    expect(api).toContain("snapshotEvidenceIds: string[]");
    // A boolean per row in the detail; the capture itself only when asked
    // for. A reader who opens no source downloads none.
    expect(api).toContain("hasSnapshot: boolean");
  });

  it("no new fetch is introduced — the capture is the one research read", () => {
    const service = codeOf(SERVICE);
    expect(service).not.toMatch(/\bfetch\(|axios|https?\.get/);
    expect(service).toContain("acquiredDocuments");
  });
});
