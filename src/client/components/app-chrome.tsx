"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApp } from "../app-context";
import { AtlasMark } from "./atlas-header";
import { ProfileIcon, PulseIcon, ResearchIcon } from "./icons";

// THE APP SHELL V5 — PULSE · [ VERIFY ] · PROOFS (D-172).
//
// Three places, one product loop: Pulse (fresh claims worth verifying) →
// Verify (the AP shield in the centre — the existing Home screen with the
// composer and the research start flow, unchanged) → Proofs (the Research
// Library: everything finished, by project; a Result stays a contextual
// page under it and keeps Proofs lit). On a handset the three sit in a
// bottom bar with the shield raised from its centre; on a wide screen the
// same three sit in the header. Profile is not a place in the loop: it is
// an icon at the top-right on every width.
//
// No dead controls: Analytics (Compare / Monitoring) is not built, so it
// is not in the navigation; its page stays reachable by URL only.

const ITEMS = {
  pulse: { href: "/pulse" },
  proofs: { href: "/research" },
} as const;
const VERIFY_HREF = "/home";
const PROFILE_HREF = "/profile";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader() {
  const pathname = usePathname();
  const { me, dict } = useApp();
  const unread = (me?.unreadCount ?? 0) > 0;
  const item = (key: keyof typeof ITEMS, icon: React.ReactNode, extra = "") => (
    <Link
      href={ITEMS[key].href}
      className={`app-nav-item ${isActive(pathname, ITEMS[key].href) ? "app-nav-item-active" : ""} ${extra}`}
      data-testid={`nav-${key}`}
    >
      {icon}
      {dict.nav[key]}
    </Link>
  );
  // Verify (Home) carries the brand itself as its centred hero, so the
  // header does not repeat it there: hidden on a handset, an invisible
  // spacer on a wide screen so the nav stays centred.
  const onVerify = pathname === VERIFY_HREF;
  return (
    <header className="app-header" data-testid="app-header">
      <Link
        href={VERIFY_HREF}
        className={`brand-lockup ${onVerify ? "brand-lockup-home" : ""}`}
        data-testid="brand-lockup"
        aria-label={`ATLAS PROOF — ${dict.home.tagline}`}
      >
        <AtlasMark size={32} />
        <span className="min-w-0">
          <span className="wordmark block text-[0.8rem] leading-none text-[var(--atlas-text-strong)]">
            ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>
          </span>
          <span className="mt-1 block text-[0.72rem] leading-none tracking-[0.02em] text-[var(--atlas-text-dim)]">
            {dict.home.tagline}
          </span>
        </span>
      </Link>

      <nav className="app-nav hidden sm:flex" aria-label={dict.nav.primary} data-testid="app-nav">
        {item("pulse", <PulseIcon size={16} />)}
        <Link
          href={VERIFY_HREF}
          className={`home-orb mx-2 ${onVerify ? "home-orb-active" : ""}`}
          aria-label={dict.nav.verify}
          title={dict.nav.verify}
          data-testid="nav-verify"
        >
          <AtlasMark size={42} />
        </Link>
        {item("proofs", <ResearchIcon size={16} />, unread ? "unread-dot" : "")}
      </nav>

      {/* Profile: top-right on every width; the word only where there is room. */}
      <Link
        href={PROFILE_HREF}
        className={`profile-link ml-auto sm:ml-0 ${isActive(pathname, PROFILE_HREF) ? "profile-link-active" : ""}`}
        aria-label={dict.nav.profile}
        title={dict.nav.profile}
        data-testid="nav-profile"
      >
        <ProfileIcon size={18} />
        <span className="hidden sm:inline">{dict.nav.profile}</span>
      </Link>
    </header>
  );
}

export function AtlasDock() {
  const pathname = usePathname();
  const { me, dict } = useApp();
  const unread = (me?.unreadCount ?? 0) > 0;
  const item = (key: keyof typeof ITEMS, icon: React.ReactNode, extra = "") => (
    <Link
      href={ITEMS[key].href}
      className={`dock-item ${isActive(pathname, ITEMS[key].href) ? "dock-item-active" : ""} ${extra}`}
      data-testid={`dock-${key}`}
    >
      {icon}
      {dict.nav[key]}
    </Link>
  );
  return (
    <nav className="dock sm:hidden" aria-label={dict.nav.primary} data-testid="app-dock">
      {item("pulse", <PulseIcon size={22} />)}
      <Link
        href={VERIFY_HREF}
        className={`dock-home ${pathname === VERIFY_HREF ? "home-orb-active" : ""}`}
        aria-label={dict.nav.verify}
        data-testid="dock-verify"
      >
        <AtlasMark size={56} />
        <span className="dock-home-label">{dict.nav.verify}</span>
      </Link>
      {item("proofs", <ResearchIcon size={22} />, unread ? "unread-dot" : "")}
    </nav>
  );
}
