"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { api, ApiError, type GateView, type InterpretResult } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";

// Question-first input (канон atlas-product-ui) + Question Interpreter
// (Фаза 4). Состояния честные: пока идёт реальный вызов — «разбирает
// вопрос», никаких выдуманных стадий; кнопка Proof активна только тогда,
// когда сервер действительно разрешает старт.
type Phase = "input" | "thinking" | "result" | "starting";

export default function AskPage() {
  const { dict, refresh } = useApp();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [showExamples, setShowExamples] = useState(false);
  const [phase, setPhase] = useState<Phase>("input");
  const [result, setResult] = useState<InterpretResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  const interp = result?.interpretation ?? null;
  const gates: GateView | null = result?.gates ?? null;

  const reset = () => {
    setPhase("input");
    setResult(null);
    setQuestion("");
    setAnswer("");
    setError(null);
    setLimitReached(false);
  };

  const submit = async () => {
    if (!question.trim()) return;
    setPhase("thinking");
    setError(null);
    try {
      setResult(await api.interpret(question));
      setPhase("result");
    } catch (e) {
      setError(errorText(e, dict.ask.error));
      setPhase("input");
    }
  };

  const sendClarification = async () => {
    if (!interp || !answer.trim()) return;
    setPhase("thinking");
    setError(null);
    try {
      setResult(await api.clarify(interp.id, answer));
      setAnswer("");
      setPhase("result");
    } catch (e) {
      if (e instanceof ApiError && e.code === "CLARIFICATION_LIMIT") {
        setLimitReached(true);
      } else {
        setError(errorText(e, dict.ask.error));
      }
      setPhase("result");
    }
  };

  const startProof = async () => {
    if (!interp) return;
    setPhase("starting");
    try {
      // Ключ идемпотентности на клик: двойное нажатие не создаёт два job.
      await api.startResearch(interp.id, crypto.randomUUID());
      await refresh();
      router.push("/research");
    } catch (e) {
      setError(errorText(e, dict.ask.error));
      setPhase("result");
    }
  };

  function errorText(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
      if (e.code === "CORE_REQUIRED") return dict.ask.coreRequired;
      if (e.code === "DEMO_QUOTA_EXHAUSTED") return dict.ask.quotaExhausted;
      if (e.code === "ACTIVE_JOB_EXISTS") return dict.ask.activeJob;
      if (e.code === "OUT_OF_SCOPE") return dict.ask.outOfScope;
    }
    return fallback;
  }

  // Причина, по которой Proof запустить нельзя. null = можно.
  const blockedNote = (): string | null => {
    if (!gates || !interp || interp.status !== "READY") return null;
    if (gates.scope === "OUT_OF_SCOPE") return dict.ask.outOfScope;
    if (gates.entitlement === "CORE_REQUIRED") return dict.ask.coreRequired;
    if (gates.research === "DEMO_QUOTA_EXHAUSTED") return dict.ask.quotaExhausted;
    if (gates.research === "ACTIVE_JOB_EXISTS") return dict.ask.activeJob;
    if (gates.research === "DISABLED") return dict.ask.disabledNote;
    return null;
  };

  const canStart =
    interp?.status === "READY" &&
    interp.route === "DEEP_RESEARCH" &&
    gates?.research === "AVAILABLE" &&
    gates.scope === "SUPPORTED" &&
    gates.entitlement === "OK";

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

      {showExamples && phase === "input" && (
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

      {phase === "input" && (
        <>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={dict.ask.placeholder}
            rows={4}
            maxLength={2000}
            className="glass w-full resize-none px-4 py-3 text-base outline-none placeholder:text-[var(--atlas-text-dim)] focus:border-[var(--atlas-cyan)]"
          />
          <p className="text-xs text-[var(--atlas-text-dim)]">{dict.ask.helper}</p>
          <button
            type="button"
            onClick={submit}
            disabled={!question.trim()}
            className="pill cta w-full py-3 text-base"
          >
            {dict.ask.submit}
          </button>
        </>
      )}

      {(phase === "thinking" || phase === "starting") && (
        <div className="glass sheet-enter flex items-center gap-3 px-4 py-4">
          <span className="pulse-dot" aria-hidden />
          <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.thinking}</p>
        </div>
      )}

      {phase === "result" && interp && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--atlas-text-dim)]">{interpQuestionLabel()}</p>

          {interp.status === "READY" && interp.understood && interp.route === "DEEP_RESEARCH" && (
            <div className="glass sheet-enter flex flex-col gap-3 px-4 py-4">
              <p className="text-xs uppercase tracking-wide text-[var(--atlas-cyan)]">
                {dict.ask.understoodTitle}
              </p>
              <p className="text-base">{interp.understood.researchTask}</p>
              {interp.understood.assumptions.length > 0 && (
                <div>
                  <p className="mb-1 text-xs text-[var(--atlas-text-dim)]">
                    {dict.ask.assumptionsTitle}
                  </p>
                  <ul className="flex flex-col gap-1 text-sm text-[var(--atlas-text-dim)]">
                    {interp.understood.assumptions.map((a) => (
                      <li key={a}>— {a}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {interp.quickAnswer && (
            <div className="glass sheet-enter flex flex-col gap-2 px-4 py-4">
              <p className="text-xs uppercase tracking-wide text-[var(--atlas-cyan)]">
                {dict.ask.quickTitle}
              </p>
              <p className="text-base">{interp.quickAnswer}</p>
            </div>
          )}

          {interp.status === "NEEDS_CLARIFICATION" && !limitReached && (
            <div className="glass sheet-enter flex flex-col gap-3 px-4 py-4">
              <p className="text-xs uppercase tracking-wide text-[var(--atlas-cyan)]">
                {dict.ask.clarifyTitle}
              </p>
              <p className="text-base">
                {interp.clarificationQuestion ?? dict.ask.clarifyProjectFallback}
              </p>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={dict.ask.clarifyPlaceholder}
                rows={2}
                maxLength={500}
                className="glass w-full resize-none px-3 py-2 text-base outline-none placeholder:text-[var(--atlas-text-dim)] focus:border-[var(--atlas-cyan)]"
              />
              <button
                type="button"
                onClick={sendClarification}
                disabled={!answer.trim()}
                className="pill cta w-full py-3 text-base"
              >
                {dict.ask.clarifySubmit}
              </button>
            </div>
          )}

          {limitReached && (
            <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.clarifyLimit}</p>
          )}

          {interp.status === "OUT_OF_SCOPE" && (
            <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.outOfScope}</p>
          )}
          {interp.status === "INVALID" && (
            <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.invalid}</p>
          )}

          {canStart && (
            <button
              type="button"
              onClick={startProof}
              className="pill cta w-full py-3 text-base"
            >
              {dict.ask.submit}
            </button>
          )}
          {!canStart && blockedNote() && (
            <>
              <button type="button" disabled className="pill cta w-full py-3 text-base">
                {dict.ask.submit}
              </button>
              <p className="text-center text-xs text-[var(--atlas-text-dim)]">
                {blockedNote()}
              </p>
            </>
          )}

          <button
            type="button"
            onClick={reset}
            className="pill glass w-full py-2 text-sm text-[var(--atlas-text-dim)]"
          >
            {dict.ask.newQuestion}
          </button>
        </div>
      )}

      {error && <p className="text-center text-sm text-[var(--atlas-amber)]">{error}</p>}
    </main>
  );

  function interpQuestionLabel(): string {
    return question.trim();
  }
}
