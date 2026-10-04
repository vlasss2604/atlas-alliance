"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api, ApiError, type GateView, type InterpretResult, type ResearchIntakeView } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { intakeIdFromSearch } from "@/src/client/intake-launch";
import { getPlatform } from "@/src/client/platform";
import { canStartProof, proofBlockReason } from "@/src/client/proof-gate";

// Question-first input (канон atlas-product-ui) + Question Interpreter
// (Фаза 4). Состояния честные: пока идёт реальный вызов — «разбирает
// вопрос», никаких выдуманных стадий; кнопка Proof активна только тогда,
// когда сервер действительно разрешает старт.
type Phase = "input" | "thinking" | "result" | "starting";

// A FORWARDED CLAIM, IF THIS SCREEN WAS OPENED FOR ONE. `?intake=<id>` is
// the bot's launch (and what a signed Telegram start parameter is routed
// to). The id is only a pointer: the server returns the text solely to its
// owner while it is OPEN, and the text lands in the SAME editable composer
// as a typed question. Nothing starts and nothing is spent by opening it.
type IntakeLaunch =
  | { kind: "none" }
  | { kind: "open"; view: ResearchIntakeView }
  | { kind: "consumed" }
  | { kind: "unavailable" };

export default function AskPage() {
  const { dict, refresh } = useApp();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [intake, setIntake] = useState<IntakeLaunch>({ kind: "none" });

  useEffect(() => {
    const id = intakeIdFromSearch(window.location.search);
    if (!id) return;
    let cancelled = false;
    api
      .getIntake(id)
      .then(({ intake: view }) => {
        if (cancelled) return;
        if (view.status === "OPEN" && view.rawText) {
          setQuestion(view.rawText);
          setIntake({ kind: "open", view });
        } else {
          setIntake({ kind: "consumed" });
        }
      })
      .catch(() => {
        if (!cancelled) setIntake({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [showExamples, setShowExamples] = useState(false);
  const [phase, setPhase] = useState<Phase>("input");
  const [result, setResult] = useState<InterpretResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [clarifyClosed, setClarifyClosed] = useState(false);

  const interp = result?.interpretation ?? null;
  const gates: GateView | null = result?.gates ?? null;

  const reset = () => {
    setPhase("input");
    setResult(null);
    setQuestion("");
    setIntake({ kind: "none" });
    setAnswer("");
    setError(null);
    setLimitReached(false);
    setClarifyClosed(false);
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
        if (
          e instanceof ApiError &&
          (e.code === "CLARIFICATION_ALREADY_ANSWERED" ||
            e.code === "CLARIFICATION_NOT_EXPECTED")
        ) {
          // Форма уточнения больше не имеет смысла — убираем её.
          setClarifyClosed(true);
        }
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
      // The intake id rides along only so the server can mark the forwarded
      // claim consumed once a job exists; it decides nothing about admission.
      await api.startResearch(interp.id, crypto.randomUUID(), intake.kind === "open" ? intake.view.intakeId : undefined);
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
      if (e.code === "BETA_ACCESS_REQUIRED") return dict.ask.betaAccessRequired;
      if (e.code === "BETA_PROJECT_NOT_AVAILABLE") return dict.ask.betaProjectNotAvailable;
      if (e.code === "BETA_RESEARCH_LIMIT_REACHED") return dict.ask.betaResearchLimitReached;
      // Постоянные состояния не выдаём за временный сбой: «попробуйте ещё
      // раз» на них не сработает никогда (adversarial review, LOW-7).
      if (e.code === "CLARIFICATION_ALREADY_ANSWERED") return dict.ask.clarifyAnswered;
      if (e.code === "CLARIFICATION_NOT_EXPECTED") return dict.ask.clarifyStale;
    }
    return fallback;
  }

  // Both answers come from the SAME server verdict (proof-gate.ts), so the
  // note can never contradict the button. Объяснение и «исследовать
  // нечего» — не заблокированный Proof, а другой род ответа: кнопки там
  // быть не должно вовсе (plan §4.6, adversarial review MEDIUM-2).
  const subject = { interpretation: interp, gates };

  const blockedNote = (): string | null => {
    switch (proofBlockReason(subject)) {
      case "OUT_OF_SCOPE":
        return dict.ask.outOfScope;
      case "CORE_REQUIRED":
        return dict.ask.coreRequired;
      case "DEMO_QUOTA_EXHAUSTED":
        return dict.ask.quotaExhausted;
      case "ACTIVE_JOB_EXISTS":
        return dict.ask.activeJob;
      case "BETA_ACCESS_REQUIRED":
        return dict.ask.betaAccessRequired;
      case "BETA_PROJECT_NOT_AVAILABLE":
        return dict.ask.betaProjectNotAvailable;
      case "BETA_RESEARCH_LIMIT_REACHED":
        return dict.ask.betaResearchLimitReached;
      case "DISABLED":
        return dict.ask.disabledNote;
      case null:
        return null;
    }
  };

  const canStart = canStartProof(subject);

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

      {phase === "input" && intake.kind !== "none" && (
        <div className="glass sheet-enter flex flex-col gap-2 px-4 py-3" data-testid="intake-notice" data-kind={intake.kind}>
          {intake.kind === "open" && (
            <>
              <p className="flex flex-wrap items-center gap-x-2 text-xs uppercase tracking-wide text-[var(--atlas-cyan)]">
                <span>{dict.ask.intakeFrom}</span>
                {intake.view.sourceLabel && (
                  <span className="normal-case tracking-normal text-[var(--atlas-text-dim)]" data-testid="intake-source">
                    · {intake.view.sourceLabel}
                  </span>
                )}
                {intake.view.sourceUrl && (
                  <a
                    href={intake.view.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="normal-case tracking-normal underline-offset-2 hover:underline"
                    data-testid="intake-view-original"
                    onClick={(e) => {
                      if (getPlatform().openExternal(intake.view.sourceUrl!)) e.preventDefault();
                    }}
                  >
                    {dict.ask.intakeViewOriginal}
                  </a>
                )}
              </p>
              <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.intakeEditable}</p>
              {intake.view.detectedProject?.availableInPrivateBeta === false && (
                <p className="text-sm text-[var(--atlas-amber)]" data-testid="intake-project-unavailable">
                  {dict.ask.intakeProjectNotAvailable.replace("{project}", intake.view.detectedProject.name)}
                </p>
              )}
            </>
          )}
          {intake.kind === "consumed" && <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.intakeConsumed}</p>}
          {intake.kind === "unavailable" && <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.intakeUnavailable}</p>}
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
              <p className="text-base">{interp.understood.summary}</p>
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
            <div className="glass sheet-enter flex flex-col gap-3 px-4 py-4">
              <p className="text-xs uppercase tracking-wide text-[var(--atlas-cyan)]">
                {dict.ask.quickTitle}
              </p>
              <p className="text-base">{interp.quickAnswer}</p>
              {/* Быстрый ответ не тупик: предлагаем проверить это на
                  конкретном проекте. Это НОВАЯ интерпретация — гейт
                  route=DEEP_RESEARCH остаётся нетронутым. */}
              <button
                type="button"
                onClick={() => {
                  reset();
                  setQuestion(dict.ask.checkOnProjectDraft);
                }}
                className="pill glass w-full py-2 text-sm text-[var(--atlas-cyan)]"
              >
                {dict.ask.checkOnProject}
              </button>
            </div>
          )}

          {interp.status === "NEEDS_CLARIFICATION" && !limitReached && !clarifyClosed && (
            <div className="glass sheet-enter flex flex-col gap-3 px-4 py-4">
              <p className="text-xs uppercase tracking-wide text-[var(--atlas-cyan)]">
                {dict.ask.clarifyTitle}
              </p>
              {interp.provisionalTask && (
                <p className="text-sm text-[var(--atlas-text-dim)]">
                  {dict.ask.provisionalPrefix} {interp.provisionalTask}
                </p>
              )}
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
