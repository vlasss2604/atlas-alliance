"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApp } from "../app-context";

// UI V1 navigation. Proof (home) and Research are real; Watchlist and
// Profile are placeholders and are rendered as visibly disabled rather than
// as links that go nowhere — an inert control that looks live is a lie about
// what the product does.
export function AtlasNavigation() {
  const pathname = usePathname();
  const { me } = useApp();

  const items = [
    { href: "/home", label: "Proof", icon: <SearchIcon />, enabled: true },
    { href: "/research", label: "Research", icon: <DocIcon />, enabled: true },
    { href: "/watchlist", label: "Watchlist", icon: <StarIcon />, enabled: false },
    { href: "/profile", label: "Profile", icon: <UserIcon />, enabled: true },
  ];

  return (
    <nav className="safe-bottom fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-[520px] items-center px-2 navbar">
      {items.map((item) => {
        const active =
          pathname === item.href ||
          (item.href === "/research" && pathname.startsWith("/research"));
        if (!item.enabled) {
          return (
            <span
              key={item.href}
              className="nav-item nav-item-disabled"
              aria-disabled="true"
              title="Coming soon"
            >
              {item.icon}
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item ${active ? "nav-item-active" : ""} ${
              item.href === "/research" && (me?.unreadCount ?? 0) > 0 ? "unread-dot" : ""
            }`}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 1.5, fill: "none" } as const;

function SearchIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden>
      <circle cx="9" cy="9" r="5.6" {...stroke} />
      <path d="m13.4 13.4 3.4 3.4" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden>
      <rect x="4.5" y="3" width="11" height="14" rx="2" {...stroke} />
      <path d="M7.5 7.5h5M7.5 10.5h5M7.5 13.5h3" {...stroke} strokeLinecap="round" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden>
      <path d="m10 3 2.2 4.5 4.8.7-3.5 3.4.8 4.9L10 14.2 5.7 16.5l.8-4.9L3 8.2l4.8-.7z" {...stroke} strokeLinejoin="round" />
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
