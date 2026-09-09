"use client";

import { type AnswerHeader as AnswerHeaderData } from "./types";

// 1. QUESTION / ANSWER — THE ONLY PROSE BLOCK AT THE TOP.
//
// The question is the heading, because this is a question-driven product and
// "what did I actually ask?" is the first thing a reader needs on returning.
// The verdict and confidence are chips, not sentences. The answer is three
// to five lines and then stops: everything below this block communicates
// through structure, and if the prose here grew to cover the whole result
// the structure underneath would be decoration.
export function AnswerHeaderBlock({ data }: { data: AnswerHeaderData }) {
  return (
    <section className="panel panel-raised p-5 sm:p-6" data-testid="block-answer">
      <p className="eyebrow eyebrow-violet">Research result</p>
      <h1 className="mt-2 text-[1.16rem] font-semibold leading-snug tracking-tight sm:text-[1.34rem]">
        {data.question}
      </h1>

      <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-[var(--hairline)] pt-4">
        <span className="tone tone-partial">{data.verdict}</span>
        <span className="tone tone-neutral">{data.confidence} confidence</span>
        <span className="ml-auto text-[0.72rem] text-[var(--atlas-text-dim)]">{data.asOf}</span>
      </div>

      <div className="mt-4 flex flex-col gap-2 text-[0.85rem] leading-normal sm:text-[0.9rem]" data-testid="answer-prose">
        {data.answer.map((s) => (
          <p key={s}>{s}</p>
        ))}
      </div>
    </section>
  );
}
