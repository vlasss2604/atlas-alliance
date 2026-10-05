"use client";

import { useState } from "react";

import { api, type FeedbackKeepUsing } from "../api";
import { useApp } from "../app-context";

// THE ONE-TIME PRIVATE-BETA FEEDBACK PROMPT (D-170).
//
// Rendered only when the server says it is due (/api/me feedbackDue: the
// second private-beta Research with a Proof, never answered or skipped).
// Optional in every sense: it blocks nothing, spends nothing, earns
// nothing. "Skip" records a dismissal, so the prompt never returns; "Send
// feedback" records the answers, with the same effect.
export function BetaFeedbackPrompt() {
  const { dict, refresh } = useApp();
  const t = dict.feedback;
  const [useful, setUseful] = useState("");
  const [missing, setMissing] = useState("");
  const [keepUsing, setKeepUsing] = useState<FeedbackKeepUsing | null>(null);
  const [changeNeeded, setChangeNeeded] = useState("");
  const [state, setState] = useState<"open" | "sending" | "sent" | "error">("open");

  if (state === "sent") {
    return (
      <p className="glass px-4 py-3 text-sm text-[var(--atlas-text-dim)]" data-testid="beta-feedback-thanks">
        {t.thanks}
      </p>
    );
  }

  const finish = async (send: () => Promise<unknown>, after: "sent" | "hidden") => {
    setState("sending");
    try {
      await send();
      if (after === "sent") setState("sent");
      await refresh();
    } catch {
      setState("error");
    }
  };

  const field =
    "glass w-full resize-none px-3 py-2 text-sm outline-none placeholder:text-[var(--atlas-text-dim)] focus:border-[var(--atlas-cyan)]";
  return (
    <section className="glass flex flex-col gap-3 px-4 py-4" data-testid="beta-feedback-prompt">
      <div>
        <p className="text-[1.02rem] font-semibold">{t.title}</p>
        <p className="mt-1 text-sm text-[var(--atlas-text-dim)]">{t.intro}</p>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        {t.useful}
        <textarea className={field} rows={2} maxLength={1000} value={useful} onChange={(e) => setUseful(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t.missing}
        <textarea className={field} rows={2} maxLength={1000} value={missing} onChange={(e) => setMissing(e.target.value)} />
      </label>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend>{t.keepUsing}</legend>
        <div className="mt-1 flex gap-4">
          {(["YES", "NO", "UNSURE"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1.5">
              <input type="radio" name="keep-using" checked={keepUsing === v} onChange={() => setKeepUsing(v)} />
              {v === "YES" ? t.yes : v === "NO" ? t.no : t.unsure}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        {t.changeNeeded}
        <textarea className={field} rows={2} maxLength={1000} value={changeNeeded} onChange={(e) => setChangeNeeded(e.target.value)} />
      </label>
      {state === "error" && <p className="text-sm text-[var(--atlas-amber)]">{t.error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          className="pill cta flex-1 py-2.5 text-sm disabled:opacity-50"
          disabled={keepUsing === null || state === "sending"}
          onClick={() =>
            keepUsing &&
            void finish(() => api.sendBetaFeedback({ action: "SUBMIT", useful, missing, keepUsing, changeNeeded }), "sent")
          }
        >
          {t.send}
        </button>
        <button
          type="button"
          className="pill glass px-4 py-2.5 text-sm text-[var(--atlas-text-dim)]"
          disabled={state === "sending"}
          onClick={() => void finish(() => api.sendBetaFeedback({ action: "DISMISS" }), "hidden")}
        >
          {t.skip}
        </button>
      </div>
    </section>
  );
}
