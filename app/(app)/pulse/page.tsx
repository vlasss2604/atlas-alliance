"use client";

import { useEffect, useState } from "react";

import { useDict } from "@/src/client/app-context";
import { PulseCard } from "@/src/client/components/pulse-card";
import { pulseItems, splitPulseFeed } from "@/src/client/pulse-fixtures";

// PULSE — A CURATED FEED OF FRESH CRYPTO CLAIMS WORTH VERIFYING (D-172).
//
// Not news, not a social feed, not signals, not price talk, not Evidence,
// not verified truth, not an endorsement. Discovery input only: the
// product loop is Pulse → Verify → Research → Proof, and the only thing a
// card can do is prefill the Verify input.
//
// PHASE A: local deterministic fixtures (pulse-fixtures.ts), no API, no
// table, no worker, no model. The feed models the intended live shape —
// a 48-hour window newest first, 8–12 as a cap, "Earlier" kept apart,
// honest when it is thin — so the screen can be judged before anything
// live exists.
//
// V7 (HANDOFF §4.6): the heartbeat beside the title is static — Pulse is
// not live, so nothing on this screen pretends to be. The sample notice is
// grey, because amber is a result colour.
export default function PulsePage() {
  const dict = useDict();
  // Ages are computed at render; a fixed instant after mount keeps every
  // card's "… ago" consistent and the server and client markup aligned.
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    const t = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(t);
  }, []);
  const items = pulseItems();
  const { fresh, earlier } = splitPulseFeed(items);
  const sample = items.length > 0;

  return (
    <main className="flex flex-col gap-[22px] pt-3">
      <div className="flex flex-col gap-2.5 rise">
        <div className="flex items-center gap-3">
          <h1 className="library-title">{dict.pulse.title}</h1>
          <HeartbeatLine />
        </div>
        <p className="library-sub">{dict.pulse.subtitle}</p>
        <p className="library-keep" data-testid="pulse-note">
          <InfoIcon />
          <span>{dict.pulse.note}</span>
        </p>
      </div>

      {sample && (
        <div className="pulse-sample rise" style={{ animationDelay: "40ms" }} data-testid="pulse-sample-notice">
          <span className="pulse-sample-pill">{dict.pulse.sampleTitle}</span>
          <span className="pulse-sample-body">{dict.pulse.sampleBody}</span>
        </div>
      )}

      <section className="flex flex-col gap-3" data-testid="pulse-fresh">
        <h2 className="pulse-h2">{dict.pulse.fresh}</h2>
        {fresh.length === 0 ? (
          <p className="px-0.5 text-[0.98rem] text-[var(--atlas-text-dim)]" data-testid="pulse-empty">
            {dict.pulse.empty}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {fresh.map((item, i) => (
              <PulseCard key={item.id} item={item} now={now} index={i} />
            ))}
          </ul>
        )}
      </section>

      {earlier.length > 0 && (
        <section className="flex flex-col gap-3" data-testid="pulse-earlier">
          <h2 className="pulse-h2 pulse-h2-dim">{dict.pulse.earlier}</h2>
          <ul className="flex flex-col gap-3 opacity-80">
            {earlier.map((item, i) => (
              <PulseCard key={item.id} item={item} now={now} index={fresh.length + i} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

// A heartbeat drawn once, standing still: the mark of the screen, not a
// live indicator.
function HeartbeatLine() {
  return (
    <svg width="70" height="30" viewBox="0 0 70 30" aria-hidden className="pulse-heartbeat">
      <path d="M2 17h14l5-12 9 21 5-10h33" fill="none" stroke="var(--atlas-cyan)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--atlas-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-[1.5px] shrink-0">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}
