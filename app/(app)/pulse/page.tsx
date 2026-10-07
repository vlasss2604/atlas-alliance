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
    <main className="enter flex flex-col gap-7 pt-4">
      <div>
        <h1 className="display text-[1.7rem] font-semibold text-[var(--atlas-text-strong)] sm:text-[2rem]">{dict.pulse.title}</h1>
        <p className="mt-1.5 text-[1.02rem] text-[var(--atlas-text-dim)]">{dict.pulse.subtitle}</p>
        <p className="mt-1.5 text-[0.95rem] text-[var(--atlas-text-faint)]" data-testid="pulse-note">
          {dict.pulse.note}
        </p>
      </div>

      {sample && (
        <p className="glass px-4 py-3 text-[0.9rem] text-[var(--atlas-text-dim)]" data-testid="pulse-sample-notice">
          <span className="font-semibold text-[var(--atlas-amber)]">{dict.pulse.sampleTitle}</span>
          {" — "}
          {dict.pulse.sampleBody}
        </p>
      )}

      <section data-testid="pulse-fresh">
        <h2 className="px-1 text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-strong)]">{dict.pulse.fresh}</h2>
        {fresh.length === 0 ? (
          <p className="mt-3 px-1 text-[0.98rem] text-[var(--atlas-text-dim)]" data-testid="pulse-empty">
            {dict.pulse.empty}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-4">
            {fresh.map((item) => (
              <PulseCard key={item.id} item={item} now={now} />
            ))}
          </ul>
        )}
      </section>

      {earlier.length > 0 && (
        <section data-testid="pulse-earlier">
          <h2 className="px-1 text-[1.15rem] font-semibold tracking-tight text-[var(--atlas-text-dim)]">{dict.pulse.earlier}</h2>
          <ul className="mt-3 flex flex-col gap-4 opacity-80">
            {earlier.map((item) => (
              <PulseCard key={item.id} item={item} now={now} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
