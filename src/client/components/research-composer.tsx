"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { api, ApiError, type GateView, type InterpretResult } from "../api";
import { useApp } from "../app-context";
import { canStartProof, proofBlockReason } from "../proof-gate";
import { ArrowIcon, AskIcon } from "./icons";

// THE INPUT IS THE HERO.
//
// This is the EXISTING research-start flow, not a new one: interpret →
// (clarify) → server gate → startResearch, exactly the sequence /ask has
// always used, with the same idempotency key per click and the same
// server-side authority over whether a Proof may begin. Nothing here decides
// eligibility; it renders what the gate returned.
//
// Around that flow there is as little as possible: one question, one
// field, three example questions as chips. `hero` centres it for Home,
// where it sits under the brand.

type Phase = "input" | "thinking" | "result" | "starting";

// Four research examples in the product's own domain — Token Value
// Capture. A tap fills the input; the reader edits or sends. The fourth
// names no project on purpose: the interpreter asks which, exactly as it
// would for any reader's question.
const EXAMPLES = [
  { text: "Does PUMP buyback actually reduce supply?" },
  { text: "Where do Raydium trading fees go?" },
  { text: "Does HYPE revenue actually reach token holders?" },
  { text: "Are bought-back tokens burned or held?" },
] as const;

export function ResearchComposer({ hero = false }: { hero?: boolean }) {
  const { dict, refresh } = useApp();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [result, setResult] = useState<InterpretResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [clarifyClosed, setClarifyClosed] = useState(false);

  const interp = result?.interpretation ?? null;
  const gates: GateView | null = result?.gates ?? null;
  const subject = { interpretation: interp, gates };

  const reset = () => {
    setPhase("input");
    setResult(null);
    setQuestion("");
    setAnswer("");
    setError(null);
    setLimitReached(false);
    setClarifyClosed(false);
  };

  const submit = async () => {
    if (!question.trim() || phase === "thinking") return;
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
      // Idempotency key per click: a double press cannot create two jobs.
      const { job } = await api.startResearch(interp.id, crypto.randomUUID());
      await refresh();
      router.push(`/research/${job.id}`);
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
      if (e.code === "CLARIFICATION_ALREADY_ANSWERED") return dict.ask.clarifyAnswered;
      if (e.code === "CLARIFICATION_NOT_EXPECTED") return dict.ask.clarifyStale;
    }
    return fallback;
  }

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
      case "DISABLED":
        return dict.ask.disabledNote;
      case "BETA_ACCESS_REQUIRED":
        return dict.ask.betaAccessRequired;
      case "BETA_PROJECT_NOT_AVAILABLE":
        return dict.ask.betaProjectNotAvailable;
      case "BETA_RESEARCH_LIMIT_REACHED":
        return dict.ask.betaResearchLimitReached;
      case null:
        return null;
    }
  };

  const canStart = canStartProof(subject);
  const centred = hero ? "text-center" : "";

  return (
    <section data-testid="composer" className={centred}>
      <h1 className="display text-[1.55rem] font-semibold leading-[1.15] text-[var(--atlas-text-strong)] sm:text-[1.9rem]">
        What do you want to verify?
      </h1>
      <p className="mt-1.5 text-[1rem] text-[var(--atlas-text-dim)]">Ask about a project, a token, a claim or a link.</p>

      {phase === "input" || phase === "thinking" ? (
        <>
          <div className={`mt-4 flex items-center gap-2.5 ${hero ? "mx-auto max-w-[640px]" : ""}`}>
            <div className="field flex flex-1 items-center gap-3 px-4 py-[0.85rem] text-left">
              <AskIcon size={18} className="field-icon" />
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Ask or paste a link…"
                maxLength={2000}
                aria-label="Research question"
                data-testid="composer-input"
                disabled={phase === "thinking"}
                className="w-full bg-transparent text-[1.05rem] outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!question.trim() || phase === "thinking"}
              aria-label={dict.ask.submit}
              data-testid="composer-submit"
              className="send-orb h-[50px] w-[50px] shrink-0"
            >
              {phase === "thinking" ? <span className="pulse-dot" aria-hidden /> : <ArrowIcon size={20} />}
            </button>
          </div>

          <div className={`mt-4 ${hero ? "mx-auto max-w-[640px]" : ""}`}>
            <p className="text-[0.8rem] font-semibold uppercase tracking-[0.08em] text-[var(--atlas-text-faint)]">Try asking</p>
            <ul className={`mt-2 flex flex-wrap gap-2 ${hero ? "justify-center" : ""}`} data-testid="composer-examples">
              {EXAMPLES.map((ex) => (
                <li key={ex.text}>
                  <button type="button" onClick={() => setQuestion(ex.text)} className="chip" data-testid="composer-example">
                    {ex.text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {phase === "starting" && (
        <div className={`mt-6 flex items-center gap-3 ${hero ? "justify-center" : ""}`}>
          <span className="pulse-dot" aria-hidden />
          <p className="text-[0.98rem] text-[var(--atlas-text-dim)]">{dict.ask.thinking}</p>
        </div>
      )}

      {phase === "result" && interp && (
        <div className={`panel mt-6 flex flex-col gap-5 px-5 py-5 text-left sm:px-7 sm:py-6 ${hero ? "mx-auto w-full max-w-[640px]" : ""}`}>
          {interp.status === "READY" &&
            interp.understood &&
            interp.route === "DEEP_RESEARCH" && (
              <div>
                <p className="section-label">{dict.ask.understoodTitle}</p>
                <p className="mt-2 text-[1.08rem] leading-[1.5] text-[var(--atlas-text-strong)]">{interp.understood.summary}</p>
                {interp.understood.assumptions.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1 text-[0.95rem] text-[var(--atlas-text-dim)]">
                    {interp.understood.assumptions.map((a) => (
                      <li key={a}>— {a}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

          {interp.quickAnswer && (
            <div>
              <p className="section-label">{dict.ask.quickTitle}</p>
              <p className="mt-2 text-[1.08rem] leading-[1.5]">{interp.quickAnswer}</p>
            </div>
          )}

          {interp.status === "NEEDS_CLARIFICATION" && !limitReached && !clarifyClosed && (
            <div>
              <p className="section-label">{dict.ask.clarifyTitle}</p>
              <p className="mt-2 text-[1.08rem] leading-[1.5]">
                {interp.clarificationQuestion ?? dict.ask.clarifyProjectFallback}
              </p>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={dict.ask.clarifyPlaceholder}
                rows={2}
                maxLength={500}
                className="field mt-3 resize-none px-4 py-3 text-[1rem]"
              />
              <button
                type="button"
                onClick={() => void sendClarification()}
                disabled={!answer.trim()}
                className="pill cta mt-3 w-full py-3 text-[0.98rem]"
              >
                {dict.ask.clarifySubmit}
              </button>
            </div>
          )}

          {limitReached && <p className="text-[0.98rem] text-[var(--atlas-text-dim)]">{dict.ask.clarifyLimit}</p>}
          {interp.status === "OUT_OF_SCOPE" && <p className="text-[0.98rem] text-[var(--atlas-text-dim)]">{dict.ask.outOfScope}</p>}
          {interp.status === "INVALID" && <p className="text-[0.98rem] text-[var(--atlas-text-dim)]">{dict.ask.invalid}</p>}

          {canStart ? (
            <button
              type="button"
              onClick={() => void startProof()}
              data-testid="start-proof"
              className="pill cta w-full py-3.5 text-[1.02rem] font-semibold"
            >
              {dict.ask.submit}
            </button>
          ) : blockedNote() ? (
            <>
              <button type="button" disabled className="pill cta w-full py-3.5 text-[1.02rem]">
                {dict.ask.submit}
              </button>
              <p className="text-center text-[0.92rem] text-[var(--atlas-text-dim)]">{blockedNote()}</p>
            </>
          ) : null}

          <button
            type="button"
            onClick={reset}
            className="py-1 text-[0.92rem] text-[var(--atlas-text-dim)] hover:text-[var(--atlas-text)]"
          >
            {dict.ask.newQuestion}
          </button>
        </div>
      )}

      {error && <p className="mt-4 text-[0.98rem] text-[var(--atlas-amber)]">{error}</p>}
    </section>
  );
}
