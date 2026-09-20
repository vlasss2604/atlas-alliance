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

// THE IN-PAGE HEADER OF A SUB-SCREEN: one back link. The brand lives in
// the app header above every screen, so it is never restated here.
export function AtlasHeader({
  back,
}: {
  compact?: boolean;
  back?: { href: string; label: string };
}) {
  if (!back) return null;
  return (
    <header className="pt-1 pb-1">
      <Link
        href={back.href}
        className="inline-flex items-center gap-1.5 text-[0.9rem] text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-cyan)]"
        data-testid="back-link"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {back.label}
      </Link>
    </header>
  );
}
