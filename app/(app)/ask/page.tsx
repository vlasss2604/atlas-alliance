"use client";

import { useState } from "react";

import { useApp } from "@/src/client/app-context";

// Question-first input (канон atlas-product-ui). Отправка честно отключена
// до Фазы 4 — никаких фейковых job и фейкового прогресса.
export default function AskPage() {
  const { dict } = useApp();
  const [question, setQuestion] = useState("");
  const [showExamples, setShowExamples] = useState(false);

  return (
    <main className="enter flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 pt-4">
        <h1 className="text-xl font-semibold">{dict.ask.title}</h1>
        <button
          type="button"
          aria-label={dict.ask.examplesTitle}
          onClick={() => setShowExamples((v) => !v)}
          className="pill glass flex h-9 w-9 shrink-0 items-center justify-center text-[var(--atlas-cyan)]"
        >
          ?
        </button>
      </div>

      {showExamples && (
        <div className="glass sheet-enter px-4 py-3">
          <p className="mb-2 text-xs text-[var(--atlas-text-dim)]">
            {dict.ask.examplesTitle}
          </p>
          <ul className="flex flex-col gap-2">
            {dict.ask.examples.map((ex) => (
              <li key={ex}>
                <button
                  type="button"
                  className="pill w-full px-3 py-2 text-left text-sm text-[var(--atlas-text)] hover:bg-white/5"
                  onClick={() => {
                    setQuestion(ex);
                    setShowExamples(false);
                  }}
                >
                  {ex}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder={dict.ask.placeholder}
        rows={4}
        className="glass w-full resize-none px-4 py-3 text-base outline-none placeholder:text-[var(--atlas-text-dim)] focus:border-[var(--atlas-cyan)]"
      />
      <p className="text-xs text-[var(--atlas-text-dim)]">{dict.ask.helper}</p>

      <button type="button" disabled className="pill cta w-full py-3 text-base">
        {dict.ask.submit}
      </button>
      <p className="text-center text-xs text-[var(--atlas-text-dim)]">
        {dict.ask.disabledNote}
      </p>
    </main>
  );
}
