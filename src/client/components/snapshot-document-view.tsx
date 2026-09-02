"use client";

import { Fragment, createElement, type ReactNode } from "react";

import {
  type DocumentBlock,
  type InlineNode,
  parseSnapshotDocument,
} from "../snapshot-document";

// TYPESETTING A CAPTURE — AND NOTHING MORE.
//
// Every element here is built from the parsed block tree, so every
// character reaches the screen as a React child and is escaped. There is
// no HTML string in this file, no dangerouslySetInnerHTML, no iframe and
// no embed: a hostile document renders as words, exactly like a friendly
// one.
//
// The styling is deliberately ATLAS's own rather than an imitation of any
// publisher. This must read as a well-set document that ATLAS captured —
// never as a reproduction of the site it came from. Restraint here is a
// correctness property, not taste.
export function SnapshotDocumentView({
  content,
  markdown,
  baseUrl,
}: {
  content: string;
  markdown: boolean;
  baseUrl: string;
}) {
  const blocks = parseSnapshotDocument(content, { markdown, baseUrl });
  return (
    <div className="snapshot-doc" data-testid="snapshot-document">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: DocumentBlock }) {
  switch (block.kind) {
    case "heading": {
      // A captured document's own h1 is not the page's h1 — the provenance
      // header above owns that. Headings are demoted one level so the
      // document sits INSIDE the snapshot rather than competing with it,
      // while keeping its internal hierarchy intact.
      const tag = `h${Math.min(block.level + 1, 6)}`;
      const size =
        block.level === 1
          ? "mt-7 text-[1.02rem]"
          : block.level === 2
            ? "mt-6 text-[0.95rem]"
            : "mt-5 text-[0.88rem]";
      return createElement(
        tag,
        {
          className: `${size} font-semibold leading-snug tracking-tight text-[var(--atlas-text)] first:mt-0`,
        },
        <Inline nodes={block.content} />,
      );
    }

    case "paragraph":
      return (
        <p className="mt-3 text-[0.86rem] leading-[1.65] text-[var(--atlas-text)]/88 first:mt-0">
          <Inline nodes={block.content} />
        </p>
      );

    case "list": {
      const className =
        "mt-3 flex flex-col gap-1.5 pl-5 text-[0.86rem] leading-[1.6] text-[var(--atlas-text)]/88";
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-1">
          <Inline nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className={`${className} list-decimal`} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className={`${className} list-disc`}>{items}</ul>
      );
    }

    case "quote":
      return (
        <blockquote className="mt-4 border-l-2 border-[var(--hairline-strong)] pl-3.5 text-[0.85rem] leading-[1.6] text-[var(--atlas-text-dim)]">
          {/* A quote holds blocks, so it renders blocks. Publishers put
              headings and lists inside one, and rendering those as prose
              would leave the reader looking at a literal `##`. */}
          {block.blocks.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </blockquote>
      );

    case "code":
      // Monospace is CORRECT here and wrong everywhere else: an address, a
      // command or a config fragment has to be readable character by
      // character, and its own line breaks are meaningful.
      return (
        <pre className="mt-4 overflow-x-auto rounded-lg border border-[var(--hairline)] bg-[rgba(255,255,255,0.03)] px-3.5 py-3 font-mono text-[0.75rem] leading-relaxed text-[var(--atlas-text)]/90">
          {block.text}
        </pre>
      );

    case "table":
      // A table scrolls inside its own box. A wide capture must never make
      // the whole screen scroll sideways on a phone.
      return (
        <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--hairline)]">
          <table className="w-full border-collapse text-left text-[0.8rem]">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    className="border-b border-[var(--hairline)] bg-[rgba(255,255,255,0.025)] px-3 py-2 font-semibold whitespace-nowrap text-[var(--atlas-text)]"
                  >
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className="border-b border-[var(--hairline)] px-3 py-2 align-top text-[var(--atlas-text)]/85 last:border-0"
                    >
                      <Inline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "rule":
      return <hr className="mt-6 border-0 border-t border-[var(--hairline)]" />;
  }
}

function Inline({ nodes }: { nodes: InlineNode[] }): ReactNode {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.kind) {
          case "text":
            return <Fragment key={i}>{node.text}</Fragment>;
          case "strong":
            return (
              <strong key={i} className="font-semibold text-[var(--atlas-text)]">
                <Inline nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i} className="italic">
                <Inline nodes={node.children} />
              </em>
            );
          case "code":
            return (
              <code
                key={i}
                className="rounded border border-[var(--hairline)] bg-[rgba(255,255,255,0.04)] px-1 py-px font-mono text-[0.78em] text-[var(--atlas-text)]"
              >
                {node.text}
              </code>
            );
          case "link":
            // The parser already refused anything that is not http(s).
            // `noreferrer` and a new tab keep the captured document from
            // reaching back into the app it is displayed in.
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--atlas-cyan)] underline decoration-[rgba(34,211,238,0.35)] underline-offset-2 hover:decoration-[var(--atlas-cyan)]"
              >
                <Inline nodes={node.children} />
              </a>
            );
        }
      })}
    </>
  );
}
