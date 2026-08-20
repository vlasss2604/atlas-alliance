"use client";

import Link from "next/link";

import { useApp } from "@/src/client/app-context";

export default function HomePage() {
  const { me, dict } = useApp();
  return (
    <main className="enter flex flex-col gap-6">
      <header className="pt-4">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--atlas-cyan)]">
          {dict.home.title}
        </h1>
        <p className="mt-1 text-sm text-[var(--atlas-text-dim)]">
          {dict.home.subtitle}
        </p>
      </header>

      <Link href="/ask" className="glass pill block px-5 py-4 text-left">
        <span className="text-base">{dict.home.cta}</span>
        <span className="mt-1 block text-xs text-[var(--atlas-text-dim)]">
          {dict.ask.helper}
        </span>
      </Link>

      <section className="glass px-5 py-4 text-sm text-[var(--atlas-text-dim)]">
        {me
          ? me.entitlement.level === "ARI_CORE"
            ? dict.home.coreActive
            : dict.home.demoCounter(me.entitlement.demoUsed, me.entitlement.demoLimit)
          : dict.common.loading}
      </section>
    </main>
  );
}
