"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { api, ApiError, type GateView, type InterpretResult } from "../api";
import { useApp } from "../app-context";
import { canStartProof, proofBlockReason } from "../proof-gate";

// UI V1 — START A NEW PROOF.
//
// This is the EXISTING research-start flow, not a new one: interpret →
// (clarify) → server gate → startResearch, exactly the sequence /ask has
// always used, with the same idempotency key per click and the same
// server-side authority over whether a Proof may begin. Nothing here decides
// eligibility; it renders what the gate returned.

type Phase = "input" | "thinking" | "result" | "starting";

const EXAMPLES = [
  { text: "Does PUMP buyback reduce supply?", tone: "chip-violet", icon: "trend" },
  { text: "Where do Raydium trading fees go?", tone: "chip-cyan", icon: "link" },
  { text: "HYPE buyback mechanism", tone: "chip-teal", icon: "bolt" },
] as const;

export function ResearchComposer() {
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
      case null:
        return null;
    }
  };

  const canStart = canStartProof(subject);

  return (
    <section className="panel panel-raised panel-hero enter relative overflow-hidden p-5 sm:p-7">
      <p className="eyebrow eyebrow-cyan flex items-center gap-2">
        <SparkIcon />
        Start a new proof
      </p>

      <h2 className="mt-3 text-[1.65rem] font-semibold leading-[1.15] tracking-tight sm:text-[2.1rem]">
        What do you want to <span className="text-gradient-cyan">verify?</span>
      </h2>
      <p className="mt-2 text-sm text-[var(--atlas-text-dim)]">
        Ask about a project, token, claim or link.
      </p>

      {phase === "input" || phase === "thinking" ? (
        <>
          <div className="mt-5 flex items-center gap-3">
            <div className="field flex flex-1 items-center gap-3 px-4 py-3">
              <SearchIcon />
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Type your question or paste a link…"
                maxLength={2000}
                aria-label="Research question"
                data-testid="composer-input"
                disabled={phase === "thinking"}
                className="w-full bg-transparent text-[0.95rem] outline-none placeholder:text-[rgba(139,155,176,0.75)]"
              />
            </div>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!question.trim() || phase === "thinking"}
              aria-label={dict.ask.submit}
              data-testid="composer-submit"
              className="send-orb h-[52px] w-[52px] shrink-0"
            >
              {phase === "thinking" ? (
                <span className="pulse-dot" aria-hidden />
              ) : (
                <ArrowIcon />
              )}
            </button>
          </div>

          <p className="eyebrow mt-6">Examples</p>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.text}
                type="button"
                onClick={() => setQuestion(ex.text)}
                className={`chip ${ex.tone}`}
                data-testid="composer-example"
              >
                <ChipIcon kind={ex.icon} />
                <span>{ex.text}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {phase === "starting" && (
        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] px-4 py-4">
          <span className="pulse-dot" aria-hidden />
          <p className="text-sm text-[var(--atlas-text-dim)]">{dict.ask.thinking}</p>
        </div>
      )}

      {phase === "result" && interp && (
        <div className="mt-5 flex flex-col gap-3">
          {interp.status === "READY" &&
            interp.understood &&
            interp.route === "DEEP_RESEARCH" && (
              <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] px-4 py-4">
                <p className="eyebrow eyebrow-cyan">{dict.ask.understoodTitle}</p>
                <p className="mt-2 text-[0.95rem]">{interp.understood.summary}</p>
                {interp.understood.assumptions.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1 text-sm text-[var(--atlas-text-dim)]">
                    {interp.understood.assumptions.map((a) => (
                      <li key={a}>— {a}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

          {interp.quickAnswer && (
            <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] px-4 py-4">
              <p className="eyebrow eyebrow-cyan">{dict.ask.quickTitle}</p>
              <p className="mt-2 text-[0.95rem]">{interp.quickAnswer}</p>
            </div>
          )}

          {interp.status === "NEEDS_CLARIFICATION" && !limitReached && !clarifyClosed && (
            <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--surface-1)] px-4 py-4">
              <p className="eyebrow eyebrow-cyan">{dict.ask.clarifyTitle}</p>
              <p className="mt-2 text-[0.95rem]">
                {interp.clarificationQuestion ?? dict.ask.clarifyProjectFallback}
              </p>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={dict.ask.clarifyPlaceholder}
                rows={2}
                maxLength={500}
                className="field mt-3 resize-none px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void sendClarification()}
                disabled={!answer.trim()}
                className="pill cta mt-3 w-full py-2.5 text-sm"
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

          {canStart ? (
            <button
              type="button"
              onClick={() => void startProof()}
              data-testid="start-proof"
              className="pill cta w-full py-3 text-sm font-semibold"
            >
              {dict.ask.submit}
            </button>
          ) : blockedNote() ? (
            <>
              <button type="button" disabled className="pill cta w-full py-3 text-sm">
                {dict.ask.submit}
              </button>
              <p className="text-center text-xs text-[var(--atlas-text-dim)]">
                {blockedNote()}
              </p>
            </>
          ) : null}

          <button
            type="button"
            onClick={reset}
            className="pill w-full py-2 text-xs text-[var(--atlas-text-dim)] hover:text-[var(--atlas-text)]"
          >
            {dict.ask.newQuestion}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-4 text-center text-sm text-[var(--atlas-amber)]">{error}</p>
      )}
    </section>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden className="shrink-0 text-[var(--atlas-text-dim)]">
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="m12.2 12.2 3.3 3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 10h11m0 0-4.2-4.2M15 10l-4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".5" />
    </svg>
  );
}

function ChipIcon({ kind }: { kind: "trend" | "link" | "bolt" }) {
  const common = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none" } as const;
  if (kind === "trend") {
    return (
      <svg {...common} aria-hidden className="mt-0.5 shrink-0">
        <path d="M2 11.5 6 7l3 2.5L14 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 4H14v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "link") {
    return (
      <svg {...common} aria-hidden className="mt-0.5 shrink-0">
        <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.9.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.9-.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden className="mt-0.5 shrink-0">
      <path d="M9 1.5 3.5 9H7l-.5 5.5L12.5 7H9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
