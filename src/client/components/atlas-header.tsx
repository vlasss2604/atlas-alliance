"use client";

import Link from "next/link";

// THE ATLAS MARK — the one approved ATLAS PROOF shield, the same file
// everywhere it appears (the compact header lockup, the raised Verify
// action in the dock and the desk header). It is a static asset under
// /public/brand taken from the approved design export; nothing is drawn
// or varied per place. The halo is the wrapping `.orb`'s box-shadow, so
// its strength is a stylesheet decision, not part of the asset.
export const ATLAS_SHIELD_SRC = "/brand/atlas-shield.png";

export function AtlasMark({ size = 40, hero = false }: { size?: number; hero?: boolean }) {
  return (
    <span className={`orb ${hero ? "orb-hero" : "orb-sm"}`} style={{ width: size, height: size }} aria-hidden>
      {/* A static, approved file; the plain element is deliberate (no
          optimisation round-trip, no remote loader). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={ATLAS_SHIELD_SRC} alt="" width={size} height={size} draggable={false} className="orb-mark" />
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
