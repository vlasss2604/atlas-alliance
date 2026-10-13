"use client";

import { useState } from "react";

import { api } from "@/src/client/api";
import { useApp } from "@/src/client/app-context";
import { ProfileIcon } from "@/src/client/components/icons";

// PROFILE (V7, HANDOFF §4.7). The layout is the approved board: a profile
// orb with the title, the access level as the one lit panel, the language
// as a two-way switch, privacy, and a grey delete row — grey, because
// deleting an account is not a verdict.
//
// WHAT IS NOT HERE YET, ON PURPOSE. The access level keeps its existing
// wording and logic (accessLine below): moving it to Free / Subscription
// is D14 and waits for Phase 1b, with the subscription sheet. No price is
// shown anywhere. No "Help" row (owner decision). No user name or photo:
// none is in the profile data (D9).
export default function ProfilePage() {
  const { me, dict, refresh } = useApp();
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const setLanguage = async (language: "RU" | "EN") => {
    await api.setLanguage(language).catch(() => {});
    await refresh();
  };

  const accessLine = (): string => {
    if (!me) return dict.common.loading;
    if (me.betaPaused) return `${dict.home.betaLabel} · ${dict.home.betaPaused}`;
    if (me.privateBeta) {
      return me.privateBeta.capacityReached
        ? `${dict.home.betaLabel} · ${dict.home.betaAtCapacity}`
        : `${dict.home.betaLabel} · ${dict.home.betaRemaining(me.privateBeta.remaining)}`;
    }
    if (me.entitlement.level === "ARI_CORE") return "ARI • CORE";
    if (me.demoAvailable) return `DEMO · ${dict.home.demoCounter(me.entitlement.demoUsed, me.entitlement.demoLimit)}`;
    return dict.profile.noAccess;
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
      <main className="flex flex-col gap-4 pt-10">
        <p className="profile-toast rise" role="status" data-testid="profile-deleted">
          <CheckIcon />
          {dict.profile.deleted}
        </p>
      </main>
    );
  }

  const language = me?.language === "RU" ? "RU" : "EN";

  return (
    <main className="flex flex-col gap-4 pt-3">
      <div className="flex items-center gap-4 pt-1 pb-1.5 rise">
        <span className="profile-orb" aria-hidden>
          <span className="profile-orb-disc">
            <ProfileIcon size={28} />
          </span>
        </span>
        <h1 className="library-title">{dict.profile.title}</h1>
      </div>

      <section className="profile-access rise" style={{ animationDelay: "32ms" }} aria-label={dict.profile.level}>
        <span className="lib-hero-light" aria-hidden />
        <span className="profile-label">{dict.profile.level}</span>
        {/* D-171: only states the server says are real. A private-beta grant
            is stored as an ARI_CORE subscription, but the user holds a beta
            allowance, not CORE. No plan price is shown: payments are not
            live, so nothing here may be offered for sale. */}
        <p className="profile-access-line" data-testid="profile-level">
          {me ? accessLine() : dict.common.loading}
        </p>
      </section>

      <section className="profile-panel profile-language rise" style={{ animationDelay: "63ms" }}>
        <span className="flex items-center gap-3">
          <span className="profile-icon" aria-hidden>
            <GlobeIcon />
          </span>
          <span className="profile-row-title">{dict.profile.language}</span>
        </span>
        <span className="profile-switch" role="group" aria-label={dict.profile.language} data-value={language}>
          <span className="profile-switch-thumb" aria-hidden />
          {(["EN", "RU"] as const).map((lang) => (
            <button
              key={lang}
              type="button"
              aria-pressed={language === lang}
              onClick={() => void setLanguage(lang)}
              className="profile-switch-option"
              data-testid={`profile-language-${lang}`}
            >
              {lang}
            </button>
          ))}
        </span>
      </section>

      <section className="profile-panel rise" style={{ animationDelay: "94ms" }}>
        <div className="flex items-start gap-3">
          <span className="profile-icon" aria-hidden>
            <ShieldIcon />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-[3px] pt-px">
            <span className="profile-row-title">{dict.profile.privacy}</span>
            <span className="profile-row-note">{dict.profile.privacyNote}</span>
          </span>
        </div>
      </section>

      <button
        type="button"
        onClick={() => void deleteAccount()}
        disabled={deleting}
        className="profile-delete rise"
        style={{ animationDelay: "125ms" }}
        data-testid="profile-delete"
      >
        <span className="profile-icon profile-icon-grey" aria-hidden>
          <TrashIcon />
        </span>
        <span className="profile-row-title">{dict.profile.deleteAccount}</span>
      </button>
    </main>
  );
}

function GlobeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 9.5-4-1.2-7-5-7-9.5V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
