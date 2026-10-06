"use client";

import Link from "next/link";

import { useApp } from "../app-context";
import { betaBlockOf } from "../beta-status";

// THE ONE NOTICE FOR A BETA USER WHO CANNOT START A NEW RESEARCH (D-171).
// Says why, in product language, and makes the Research Library the next
// action — finished Research stays readable in every one of these states.
export function BetaStatusNotice() {
  const { me, dict } = useApp();
  const block = betaBlockOf(me);
  if (!block || !me) return null;
  const text =
    block === "PAUSED"
      ? dict.home.betaPaused
      : block === "CAPACITY"
        ? dict.ask.globalBetaCapacity
        : dict.home.betaExhausted(me.privateBeta?.limit ?? 0);
  return (
    <section className="panel flex flex-col items-center gap-4 px-5 py-6 text-center" data-testid="beta-status-notice" data-block={block}>
      <p className="text-[0.85rem] font-semibold uppercase tracking-[0.08em] text-[var(--atlas-cyan-strong)]">{dict.home.betaLabel}</p>
      <p className="max-w-[46ch] text-[1.02rem] leading-[1.5] text-[var(--atlas-text-strong)]">{text}</p>
      <Link href="/research" className="pill cta px-6 py-3 text-[1rem] font-semibold" data-testid="open-library">
        {dict.home.openLibrary}
      </Link>
    </section>
  );
}
