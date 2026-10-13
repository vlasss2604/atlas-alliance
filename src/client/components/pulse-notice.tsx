"use client";

import { useEffect, useRef, useState } from "react";

import { useDict } from "../app-context";
import type { PulseItem } from "../pulse-fixtures";
import { PulseIcon } from "./icons";

// "FROM PULSE" ABOVE THE VERIFY TITLE (owner decision, step 8 review).
//
// When the card carries a verify question, that question is what lands in
// the field, and the claim it came from is shown here as context — the
// source's own words, verbatim, folded to two lines with a control to read
// the rest. When the card has no question, the claim itself is in the
// field, so the notice keeps its one-line "review or edit" hint instead of
// repeating it. Opening this starts nothing.
export function PulseNotice({ item, prefilledQuestion }: { item: PulseItem; prefilledQuestion: boolean }) {
  const dict = useDict();
  const [open, setOpen] = useState(false);
  const [folds, setFolds] = useState(false);
  const claim = useRef<HTMLSpanElement>(null);

  // Offer the control only when the claim is actually cut at two lines.
  useEffect(() => {
    const el = claim.current;
    if (!el || open) return;
    const t = window.setTimeout(() => setFolds(el.scrollHeight > el.clientHeight + 1), 0);
    return () => window.clearTimeout(t);
  }, [open, item.id]);

  return (
    <div className="from-pulse rise" data-testid="pulse-notice" data-kind="open">
      <PulseIcon size={16} strokeWidth={2} className="from-pulse-icon" />
      <span className="flex min-w-0 flex-col gap-1">
        <span>
          <span className="font-bold text-[var(--atlas-cyan-strong)]">{dict.pulse.fromPulse(item.source.handle)}</span>
          {!prefilledQuestion && (
            <>
              {" · "}
              {dict.pulse.fromPulseEditable}
            </>
          )}
        </span>
        {prefilledQuestion && (
          <>
            <span
              ref={claim}
              className={`from-pulse-claim ${open ? "" : "from-pulse-claim-folded"}`}
              data-testid="pulse-notice-claim"
            >
              {item.text}
            </span>
            {(folds || open) && (
              <button
                type="button"
                className="from-pulse-toggle"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                data-testid="pulse-notice-toggle"
              >
                {open ? dict.pulse.contextLess : dict.pulse.contextMore}
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}
