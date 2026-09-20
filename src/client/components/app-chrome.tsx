"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApp } from "../app-context";
import { AtlasMark } from "./atlas-header";

// THE APP SHELL V4 — FIVE PLACES, HOME IN THE MIDDLE.
//
//   Ask · Research · [ Home ] · Analytics · Profile
//
// One product structure, two treatments. On a handset the five sit in a
// bottom bar, Home as a raised disc rising from its centre — the way back
// from anywhere. On a wide screen the same five sit in the header: the
// brand lockup on the left, Ask · Research · Home · Analytics in the
// centre, Profile on the right. Ask is the focused question screen;
// Home is the overview with the composer and recent research.
//
// No dead controls. Analytics is a real page with an honest empty state.

const ITEMS = {
  ask: { href: "/ask", label: "Ask" },
  research: { href: "/research", label: "Research" },
  analytics: { href: "/analytics", label: "Analytics" },
  profile: { href: "/profile", label: "Profile" },
} as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader() {
  const pathname = usePathname();
  const { me } = useApp();
  const unread = (me?.unreadCount ?? 0) > 0;
  const item = (key: keyof typeof ITEMS, extra = "") => (
    <Link
      href={ITEMS[key].href}
      className={`app-nav-item ${isActive(pathname, ITEMS[key].href) ? "app-nav-item-active" : ""} ${extra}`}
      data-testid={`nav-${key}`}
    >
      {ITEMS[key].label}
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
        aria-label="ATLAS PROOF — Crypto Verification"
      >
        <AtlasMark size={32} />
        <span className="min-w-0">
          <span className="wordmark block text-[0.8rem] leading-none text-[var(--atlas-text-strong)]">
            ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>
          </span>
          <span className="mt-1 block text-[0.72rem] leading-none tracking-[0.02em] text-[var(--atlas-text-dim)]">
            Crypto Verification
          </span>
        </span>
      </Link>

      <nav className="app-nav hidden sm:flex" aria-label="Primary" data-testid="app-nav">
        {item("ask")}
        {item("research", unread ? "unread-dot" : "")}
        <Link
          href="/home"
          className={`home-orb mx-2 ${pathname === "/home" ? "home-orb-active" : ""}`}
          aria-label="Home"
          data-testid="nav-home"
        >
          <AtlasMark size={42} />
        </Link>
        {item("analytics")}
      </nav>

      <Link
        href={ITEMS.profile.href}
        className={`profile-link hidden sm:inline-flex ${isActive(pathname, "/profile") ? "profile-link-active" : ""}`}
        aria-label="Profile"
        data-testid="nav-profile"
      >
        <UserIcon />
        <span>Profile</span>
      </Link>
    </header>
  );
}

export function AtlasDock() {
  const pathname = usePathname();
  const { me } = useApp();
  const unread = (me?.unreadCount ?? 0) > 0;
  const item = (key: keyof typeof ITEMS, icon: React.ReactNode, extra = "") => (
    <Link
      href={ITEMS[key].href}
      className={`dock-item ${isActive(pathname, ITEMS[key].href) ? "dock-item-active" : ""} ${extra}`}
      data-testid={`dock-${key}`}
    >
      {icon}
      {ITEMS[key].label}
    </Link>
  );
  return (
    <nav className="dock sm:hidden" aria-label="Primary" data-testid="app-dock">
      {item("ask", <AskIcon />)}
      {item("research", <HistoryIcon />, unread ? "unread-dot" : "")}
      <Link
        href="/home"
        className={`dock-home ${pathname === "/home" ? "home-orb-active" : ""}`}
        aria-label="Home"
        data-testid="dock-home"
      >
        <AtlasMark size={56} />
      </Link>
      {item("analytics", <ChartIcon />)}
      {item("profile", <UserIcon />)}
    </nav>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 1.6, fill: "none" } as const;

function AskIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden>
      <circle cx="9" cy="9" r="5.5" {...stroke} />
      <path d="m13.2 13.2 3.3 3.3" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
function HistoryIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden>
      <rect x="4.5" y="3" width="11" height="14" rx="2.5" {...stroke} />
      <path d="M7.5 7.5h5M7.5 10.5h5M7.5 13.5h3" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden>
      <path d="M3.5 16.5h13" {...stroke} strokeLinecap="round" />
      <path d="M5.5 13.5v-4M9.5 13.5V6M13.5 13.5V9.5" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="7.2" r="3" {...stroke} />
      <path d="M4.4 16.4a5.8 5.8 0 0 1 11.2 0" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
