"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApp } from "./app-context";

// Bottom nav — единственная навигация (LOCKED §9): 4 раздела + центральная
// ARI-кнопка с unread-индикатором. Гамбургера и notification center нет.
export function BottomNav() {
  const { me, dict } = useApp();
  const pathname = usePathname();

  const item = (href: string, label: string) => {
    const active = pathname === href;
    return (
      <Link
        href={href}
        className={`pill flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
          active ? "text-[var(--atlas-cyan)]" : "text-[var(--atlas-text-dim)]"
        }`}
      >
        <span aria-hidden className="text-base leading-none">
          {href === "/home" ? "◆" : href === "/research" ? "▤" : href === "/projects" ? "◈" : "◉"}
        </span>
        {label}
      </Link>
    );
  };

  return (
    <nav className="glass safe-bottom fixed inset-x-3 bottom-3 z-40 flex items-center px-2">
      {item("/home", dict.nav.home)}
      {item("/research", dict.nav.research)}
      <Link
        href="/ask"
        aria-label={dict.nav.ask}
        className={`pill cta relative mx-1 -mt-6 flex h-14 w-14 shrink-0 items-center justify-center text-xl shadow-[0_0_18px_rgba(34,211,238,0.45)] ${
          (me?.unreadCount ?? 0) > 0 ? "unread-dot" : ""
        }`}
      >
        ✦
      </Link>
      {item("/projects", dict.nav.projects)}
      {item("/profile", dict.nav.profile)}
    </nav>
  );
}
