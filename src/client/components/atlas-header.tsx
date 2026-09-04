"use client";

import Link from "next/link";

// The ATLAS mark. Drawn, not imported: an inline SVG scales cleanly, costs
// no request, and inherits the theme's colours instead of baking them in.
export function AtlasMark({ size = 40 }: { size?: number }) {
  return (
    <span
      className="orb orb-sm"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        width={size * 0.52}
        height={size * 0.52}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        <defs>
          <linearGradient id="atlas-a" x1="0" y1="24" x2="18" y2="0">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#7dd3fc" />
          </linearGradient>
          <linearGradient id="atlas-p" x1="12" y1="24" x2="24" y2="2">
            <stop offset="0%" stopColor="#e2e8f0" />
            <stop offset="100%" stopColor="#94a3b8" />
          </linearGradient>
        </defs>
        <path d="M8.2 3.2 1.6 21h3.5l1.5-4.4h6.3L11.6 13H7.9l2.1-6 2.2 6.4L13.6 18l1 3h3.6L11.7 3.2z" fill="url(#atlas-a)" />
        <path d="M15.6 3.2v17.9h3.2v-6.4h1.6c2.4 0 4-1.9 4-5.4 0-4-1.6-6.1-4.4-6.1zm3.2 3h1c1.1 0 1.6 1 1.6 3.1 0 1.9-.5 2.8-1.5 2.8h-1.1z" fill="url(#atlas-p)" />
      </svg>
    </span>
  );
}

// The full lockup, used at the top of Home. `compact` is the in-page header
// used on every other screen.
export function AtlasHeader({
  compact = false,
  back,
}: {
  compact?: boolean;
  back?: { href: string; label: string };
}) {
  if (compact) {
    return (
      <header className="flex items-center gap-3 pt-5 pb-1">
        {back ? (
          <Link
            href={back.href}
            aria-label={back.label}
            className="row-card flex h-10 w-10 shrink-0 items-center justify-center text-[var(--atlas-text-dim)]"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M10 3 5 8l5 5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        ) : null}
        <Link href="/home" className="mx-auto flex items-center gap-2.5">
          <AtlasMark size={32} />
          <span className="wordmark text-[0.8rem] text-[var(--atlas-text)]">
            ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>
          </span>
        </Link>
        <span className="h-10 w-10 shrink-0" aria-hidden />
      </header>
    );
  }

  return (
    <header className="flex flex-col items-center pt-8 pb-2 text-center sm:pt-12">
      <span className="orb h-[76px] w-[76px] sm:h-[92px] sm:w-[92px]" aria-hidden>
        <AtlasMarkInner />
      </span>
      <h1 className="wordmark mt-5 text-[1.25rem] sm:text-[1.6rem]">
        ATLAS <span className="text-gradient-cyan">PROOF</span>
      </h1>
      <p className="mt-2 text-sm text-[var(--atlas-text-dim)]">Evidence over opinions.</p>
    </header>
  );
}

function AtlasMarkInner() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id="atlas-a-lg" x1="0" y1="24" x2="18" y2="0">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#7dd3fc" />
        </linearGradient>
        <linearGradient id="atlas-p-lg" x1="12" y1="24" x2="24" y2="2">
          <stop offset="0%" stopColor="#f1f5f9" />
          <stop offset="100%" stopColor="#94a3b8" />
        </linearGradient>
      </defs>
      <path d="M8.2 3.2 1.6 21h3.5l1.5-4.4h6.3L11.6 13H7.9l2.1-6 2.2 6.4L13.6 18l1 3h3.6L11.7 3.2z" fill="url(#atlas-a-lg)" />
      <path d="M15.6 3.2v17.9h3.2v-6.4h1.6c2.4 0 4-1.9 4-5.4 0-4-1.6-6.1-4.4-6.1zm3.2 3h1c1.1 0 1.6 1 1.6 3.1 0 1.9-.5 2.8-1.5 2.8h-1.1z" fill="url(#atlas-p-lg)" />
    </svg>
  );
}
