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

// THE BARE SHIELD (V7): the same asset without the orb disc — how the
// approved mockups draw it in the header lockup (44×47) and raised above
// the dock (64×68). Size and inset live in the stylesheet class.
export function AtlasShield({ className }: { className: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={ATLAS_SHIELD_SRC} alt="" draggable={false} className={`atlas-shield ${className}`} aria-hidden />
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
    <header>
      {/* V7: a 44px touch target, 14/500, soft text, a 16px chevron. */}
      <Link
        href={back.href}
        className="inline-flex h-11 items-center gap-1 text-[14px] leading-[18px] font-medium text-[var(--atlas-text-soft)] transition-colors hover:text-[var(--atlas-cyan-strong)]"
        data-testid="back-link"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {back.label}
      </Link>
    </header>
  );
}
