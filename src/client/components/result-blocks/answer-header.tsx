"use client";

import { type AnswerHeader as AnswerHeaderData } from "./types";

// 1. QUESTION / ANSWER — THE TEN-SECOND HALF OF THE RESULT.
//
// The question is the heading, because this is a question-driven product and
// "what did I actually ask?" is the first thing a reader needs on returning.
//
// WHAT CHANGED, AND WHY. This block used to open with four full-width
// paragraphs, so the first screen of a result was a wall of prose and the
// first number arrived two scrolls down. The paragraphs are still here and
// still complete — nothing was cut — but the top of the block is now the ONE
// SENTENCE that answers the question, and the four that support it sit
// behind a disclosure that says how many there are.
//
// THE DISCLOSURE IS A `<details>`, NOT A TOGGLE. No state, no effect, no
// hydration cost, works with JavaScript off, and — the part that matters
// here — the full answer is in the served markup, so nothing is hidden from
// a reader, a screen reader or a page search.
//
// IT RENDERS NO FRAME OF ITS OWN. The masthead panel wraps this block and
// the proof map together, because "what is the answer" and "how much of it
// stands up" are one thought, and two stacked panels made them two.
export function AnswerHeaderBlock({ data }: { data: AnswerHeaderData }) {
  return (
    <section className="flex min-w-0 flex-col" data-testid="block-answer">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow eyebrow-violet">Research result</p>
        <p className="text-[0.68rem] text-[var(--atlas-text-dim)]">{data.asOf}</p>
      </div>

      <h1 className="mt-2 text-[1.08rem] font-semibold leading-snug tracking-tight sm:text-[1.24rem] lg:text-[1.34rem]">
        {data.question}
      </h1>

      {/* THE ANSWER, AT ANSWER SIZE. Set against a violet spine rather than
          in a box: it is the continuation of the question above it, not a
          separate card. */}
      <p
        className="mt-3.5 border-l-2 pl-3 text-[0.95rem] font-medium leading-snug sm:text-[1.02rem]"
        style={{ borderColor: "rgba(167, 139, 250, 0.7)" }}
        data-testid="answer-short"
      >
        {data.short}
      </p>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <span className="tone tone-partial">{data.verdict}</span>
        <span className="tone tone-neutral">{data.confidence} confidence</span>
      </div>

      {/* A DISCLOSURE ON A PHONE, OPEN ON A DESKTOP — see `.answer-detail`
          in globals.css. The paragraphs exist once in the markup either
          way; what changes is whether a reader has to ask for them. On a
          handset they are the wall of text this revision removed from the
          first screen; on a wide screen they are two short columns that
          fill the space beside the proof map. */}
      <details className="answer-detail group mt-auto border-t border-[var(--hairline)] pt-3">
        <summary
          className="flex cursor-pointer list-none items-center gap-2 text-[0.72rem] font-medium text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-text)]"
          data-testid="answer-disclosure"
        >
          <span
            className="inline-block transition-transform group-open:rotate-90"
            aria-hidden
          >
            ›
          </span>
          Full answer · {data.answer.length} points
        </summary>
        {/* Two columns on a wide screen: the same sentences at half the
            column height, which is most of what made them read as a wall. */}
        <div
          className="mt-2.5 text-[0.8rem] leading-normal text-[var(--atlas-text-dim)] lg:columns-2 lg:gap-6"
          data-testid="answer-prose"
        >
          {data.answer.map((s) => (
            <p key={s} className="mb-2 break-inside-avoid last:mb-0">
              {s}
            </p>
          ))}
        </div>
      </details>
    </section>
  );
}
