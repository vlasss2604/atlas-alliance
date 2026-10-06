"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApp } from "../app-context";
import { AtlasMark } from "./atlas-header";
import { AskIcon, ProfileIcon, ResearchIcon } from "./icons";

// THE APP SHELL V4 — HOME IN THE MIDDLE.
//
//   Ask · Research · [ Home ] · · Profile
//
// One product structure, two treatments. On a handset the places sit in a
// bottom bar, Home as a raised disc rising from its centre — the way back
// from anywhere. On a wide screen they sit in the header: the brand lockup
// on the left, Ask · Research · Home in the centre, Profile on the right.
// Ask is the focused question screen; Home is the overview with the
// composer and recent research.
//
// No dead controls. Analytics (Compare / Monitoring) is not built, so it
// is not in the navigation (D-171); its page stays reachable by URL only.

// Labels come from the dictionary at render (D-171): EN by default, RU on
// the user's explicit choice.
const ITEMS = {
  ask: { href: "/ask" },
  research: { href: "/research" },
  profile: { href: "/profile" },
} as const;

type NavDict = { askShort: string; research: string; profile: string };
const navLabel = (key: keyof typeof ITEMS, nav: NavDict): string =>
  key === "ask" ? nav.askShort : key === "research" ? nav.research : nav.profile;

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
      {navLabel(key, dict.nav)}
    </Link>
  );
  // Home carries the brand itself, as its centred hero, so the header
  // does not repeat it there: hidden on a handset, an invisible spacer on
  // a wide screen so the nav stays centred.
  const onHome = pathname === "/home";
  return (
    <header className="app-header" data-testid="app-header">
      {/* On a handset the brand is centred and alone: the five places are
          in the bar below. On a wide screen it sits on the left. */}
      <Link
        href="/home"
        className={`brand-lockup mx-auto sm:mx-0 ${onHome ? "brand-lockup-home" : ""}`}
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
        {item("ask", <AskIcon size={16} />)}
        {item("research", <ResearchIcon size={16} />, unread ? "unread-dot" : "")}
        <Link
          href="/home"
          className={`home-orb mx-2 ${pathname === "/home" ? "home-orb-active" : ""}`}
          aria-label={dict.nav.home}
          data-testid="nav-home"
        >
          <AtlasMark size={42} />
        </Link>
      </nav>

      <Link
        href={ITEMS.profile.href}
        className={`profile-link hidden sm:inline-flex ${isActive(pathname, "/profile") ? "profile-link-active" : ""}`}
        aria-label={dict.nav.profile}
        data-testid="nav-profile"
      >
        <ProfileIcon size={16} />
        <span>{dict.nav.profile}</span>
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
      {navLabel(key, dict.nav)}
    </Link>
  );
  return (
    <nav className="dock sm:hidden" aria-label={dict.nav.primary} data-testid="app-dock">
      {item("ask", <AskIcon size={22} />)}
      {item("research", <ResearchIcon size={22} />, unread ? "unread-dot" : "")}
      <Link
        href="/home"
        className={`dock-home ${pathname === "/home" ? "home-orb-active" : ""}`}
        aria-label={dict.nav.home}
        data-testid="dock-home"
      >
        <AtlasMark size={56} />
      </Link>
      {/* D-171: Analytics (Compare / Monitoring) is not built, so it is not
          in the creator-beta navigation. The cell stays so the Home orb
          remains centred in the five-column dock. */}
      <span aria-hidden data-testid="dock-spacer" />
      {item("profile", <ProfileIcon size={22} />)}
    </nav>
  );
}
