"use client";

import { useState } from "react";

import { api } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";

export default function ProfilePage() {
  const { me, dict, refresh } = useApp();
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const setLanguage = async (language: "RU" | "EN") => {
    await api.setLanguage(language).catch(() => {});
    await refresh();
  };

  // Двойное подтверждение (phase-2-plan §3): два независимых confirm.
  const deleteAccount = async () => {
    if (!window.confirm(dict.profile.deleteConfirm1)) return;
    if (!window.confirm(dict.profile.deleteConfirm2)) return;
    setDeleting(true);
    try {
      await api.deleteAccount();
      setDeleted(true);
    } finally {
      setDeleting(false);
    }
  };

  if (deleted) {
    return (
      <main className="enter pt-10 text-center text-sm text-[var(--atlas-text-dim)]">
        {dict.profile.deleted}
      </main>
    );
  }

  return (
    <main className="enter flex flex-col gap-4">
      <h1 className="pt-4 text-xl font-semibold">{dict.profile.title}</h1>

      <section className="glass px-4 py-3">
        <p className="mb-2 text-xs text-[var(--atlas-text-dim)]">
          {dict.profile.language}
        </p>
        <div className="flex gap-2">
          {(["EN", "RU"] as const).map((lang) => (
            <button
              key={lang}
              type="button"
              onClick={() => void setLanguage(lang)}
              className={`pill flex-1 border px-3 py-2 text-sm ${
                me?.language === lang
                  ? "border-[var(--atlas-cyan)] text-[var(--atlas-cyan)]"
                  : "border-[var(--atlas-border)] text-[var(--atlas-text-dim)]"
              }`}
            >
              {lang === "EN" ? "English" : "Русский"}
            </button>
          ))}
        </div>
      </section>

      <section className="glass px-4 py-3">
        <p className="text-xs text-[var(--atlas-text-dim)]">{dict.profile.level}</p>
        <p className="mt-1 text-sm">
          {me
            ? me.entitlement.level === "ARI_CORE"
              ? "ARI • CORE"
              : `DEMO · ${dict.home.demoCounter(me.entitlement.demoUsed, me.entitlement.demoLimit)}`
            : dict.common.loading}
        </p>
        {me && me.entitlement.level === "DEMO" && (
          <p className="mt-1 text-xs text-[var(--atlas-text-dim)]">
            {dict.profile.priceNote(me.entitlement.priceStars)}
          </p>
        )}
      </section>

      <section className="glass px-4 py-3">
        <p className="text-xs text-[var(--atlas-text-dim)]">{dict.profile.privacy}</p>
        <p className="mt-1 text-sm">{dict.profile.privacyNote}</p>
      </section>

      <button
        type="button"
        onClick={() => void deleteAccount()}
        disabled={deleting}
        className="pill border border-[var(--atlas-red)]/40 px-4 py-3 text-sm text-[var(--atlas-red)]"
      >
        {dict.profile.deleteAccount}
      </button>
    </main>
  );
}
