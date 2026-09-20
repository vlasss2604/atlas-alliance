"use client";

import Link from "next/link";
import { useId } from "react";

// THE ATLAS MARK — the Founder's AP identity, translated to a UI mark.
//
// What the logo is: a near-black disc, a thin double cyan ring with four
// cardinal tick marks, an electric-cyan "A" and a brushed-silver "P",
// one controlled glow. What this draws: exactly that, at any size, from
// an inline SVG that costs no request. The letterforms are the base AP
// form and are not redesigned.
//
// GRADIENTS ARE SCOPED PER INSTANCE (`useId`). A gradient referenced by a
// shared id resolves to the FIRST definition on the page, and when that
// instance is hidden (the header lockup on Home) every mark paints
// nothing — that bug shipped once. The halo is the wrapping `.orb`'s
// box-shadow, so its strength is a stylesheet decision, not a drawing.
export function AtlasMark({ size = 40, hero = false }: { size?: number; hero?: boolean }) {
  const id = useId().replace(/:/g, "");
  const a = `ap-a-${id}`;
  const p = `ap-p-${id}`;
  const body = `ap-b-${id}`;
  return (
    <span className={`orb ${hero ? "orb-hero" : "orb-sm"}`} style={{ width: size, height: size }} aria-hidden>
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
        <defs>
          <radialGradient id={body} cx="50%" cy="38%" r="65%">
            <stop offset="0%" stopColor="#111c30" />
            <stop offset="100%" stopColor="#060a12" />
          </radialGradient>
          <linearGradient id={a} x1="16" y1="46" x2="34" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#12a8dd" />
            <stop offset="100%" stopColor="#8ceaff" />
          </linearGradient>
          <linearGradient id={p} x1="34" y1="46" x2="48" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#9aa7b6" />
            <stop offset="100%" stopColor="#f2f6fa" />
          </linearGradient>
        </defs>
        {/* the disc */}
        <circle cx="32" cy="32" r="31" fill={`url(#${body})`} />
        {/* the double ring: outer bright, inner faint */}
        <circle cx="32" cy="32" r="30" stroke="#1ec5f5" strokeWidth="1.4" opacity="0.95" />
        <circle cx="32" cy="32" r="26.5" stroke="#1ec5f5" strokeWidth="0.7" opacity="0.45" />
        {/* the four cardinal ticks */}
        <path d="M32 3.6v3M32 57.4v3M3.6 32h3M57.4 32h3" stroke="#8ceaff" strokeWidth="1.2" opacity="0.9" />
        {/* the letterforms — the base AP form, drawn on a 24-unit grid */}
        <g transform="translate(14.5 14.5) scale(1.45)">
          <path d="M8.2 3.2 1.6 21h3.5l1.5-4.4h6.3L11.6 13H7.9l2.1-6 2.2 6.4L13.6 18l1 3h3.6L11.7 3.2z" fill={`url(#${a})`} />
          <path d="M15.6 3.2v17.9h3.2v-6.4h1.6c2.4 0 4-1.9 4-5.4 0-4-1.6-6.1-4.4-6.1zm3.2 3h1c1.1 0 1.6 1 1.6 3.1 0 1.9-.5 2.8-1.5 2.8h-1.1z" fill={`url(#${p})`} />
        </g>
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
        className="inline-flex items-center gap-1.5 text-[0.92rem] text-[var(--atlas-text-dim)] transition-colors hover:text-[var(--atlas-cyan-strong)]"
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
