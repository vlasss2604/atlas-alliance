"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApp } from "../app-context";
import { AtlasMark } from "./atlas-header";

// THE APP SHELL — RESEARCH ← HOME → ANALYTICS, PROFILE ASIDE.
//
// One product structure, two treatments. On a wide screen a header: the
// ATLAS PROOF lockup on the left, the three anchors in the centre with
// the AP orb as Home between them, Profile on the right. On a handset a
// header with the lockup and the profile avatar, and a bottom dock with
// the same three anchors, the orb rising from its centre. The orb is the
// product's persistent start point: from anywhere, it returns to Home and
// a fresh question.
//
// No dead controls. Analytics is a real page — the place Compare and
// Monitoring will live — with an honest empty state, not a greyed item.

const ANCHORS = {
  research: { href: "/research", label: "Research" },
  analytics: { href: "/analytics", label: "Analytics" },
};

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader() {
  const pathname = usePathname();
  const { me } = useApp();
  const unread = (me?.unreadCount ?? 0) > 0;
  return (
    <header className="app-header" data-testid="app-header">
      <Link href="/home" className="brand-lockup" data-testid="brand-lockup" aria-label="ATLAS PROOF — Crypto Verification">
        <AtlasMark size={34} />
        <span className="min-w-0">
          <span className="wordmark block text-[0.82rem] leading-none text-[var(--atlas-text)]">
            ATLAS <span className="text-[var(--atlas-cyan)]">PROOF</span>
          </span>
          <span className="mt-1 block text-[0.72rem] leading-none tracking-[0.02em] text-[var(--atlas-text-dim)]">Crypto Verification</span>
        </span>
      </Link>

      <nav className="app-nav hidden sm:flex" aria-label="Primary" data-testid="app-nav">
        <Link href={ANCHORS.research.href} className={`app-nav-item ${isActive(pathname, "/research") ? "app-nav-item-active" : ""} ${unread ? "unread-dot" : ""}`} data-testid="nav-research">
          {ANCHORS.research.label}
        </Link>
        <Link href="/home" className={`home-orb ${pathname === "/home" ? "home-orb-active" : ""}`} aria-label="Home — start a new verification" data-testid="nav-home">
          <AtlasMark size={44} />
        </Link>
        <Link href={ANCHORS.analytics.href} className={`app-nav-item ${isActive(pathname, "/analytics") ? "app-nav-item-active" : ""}`} data-testid="nav-analytics">
          {ANCHORS.analytics.label}
        </Link>
      </nav>

      <Link href="/profile" className={`profile-link ${isActive(pathname, "/profile") ? "profile-link-active" : ""}`} aria-label="Profile" data-testid="nav-profile">
        <UserIcon />
        <span className="hidden sm:inline">Profile</span>
      </Link>
    </header>
  );
}

export function AtlasDock() {
  const pathname = usePathname();
  const { me } = useApp();
  const unread = (me?.unreadCount ?? 0) > 0;
  return (
    <nav className="dock sm:hidden" aria-label="Primary" data-testid="app-dock">
      <Link href={ANCHORS.research.href} className={`dock-item ${isActive(pathname, "/research") ? "dock-item-active" : ""} ${unread ? "unread-dot" : ""}`} data-testid="dock-research">
        <HistoryIcon />
        {ANCHORS.research.label}
      </Link>
      <Link href="/home" className={`dock-home ${pathname === "/home" ? "home-orb-active" : ""}`} aria-label="Home — start a new verification" data-testid="dock-home">
        <AtlasMark size={52} />
      </Link>
      <Link href={ANCHORS.analytics.href} className={`dock-item ${isActive(pathname, "/analytics") ? "dock-item-active" : ""}`} data-testid="dock-analytics">
        <ChartIcon />
        {ANCHORS.analytics.label}
      </Link>
    </nav>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 1.5, fill: "none" } as const;

function HistoryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <rect x="4.5" y="3" width="11" height="14" rx="2" {...stroke} />
      <path d="M7.5 7.5h5M7.5 10.5h5M7.5 13.5h3" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <path d="M3.5 16.5h13" {...stroke} strokeLinecap="round" />
      <path d="M5.5 13.5v-4M9.5 13.5V6M13.5 13.5V9.5" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="7.2" r="3" {...stroke} />
      <path d="M4.4 16.4a5.8 5.8 0 0 1 11.2 0" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
