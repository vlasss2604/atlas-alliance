"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api, authenticate } from "@/src/client/api";
import { askPathForIntake, intakeIdFromStartParam, rememberLaunchIntake, takeLaunchIntake } from "@/src/client/intake-launch";
import { en } from "@/src/client/i18n/en";
import { ru } from "@/src/client/i18n/ru";

// 3 экрана (LOCKED §10): вторичный «Пропустить», точки-пагинация, каждый
// экран в один viewport. Состояние — на сервере, endpoint идемпотентен.
// D-171: English by default — never a browser, device or Telegram locale
// guess. An explicit EN | RU switch here saves the choice through the same
// endpoint Profile uses (users.language), so the app opens in it.
export default function OnboardingPage() {
  const router = useRouter();
  const [screen, setScreen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState<"EN" | "RU">("EN");
  const dict = language === "RU" ? ru : en;
  const choose = (next: "EN" | "RU") => {
    setLanguage(next);
    void api.setLanguage(next).catch(() => {});
  };
  const screens = dict.onboarding.screens;
  const isLast = screen === screens.length - 1;

  const complete = async () => {
    if (busy) return; // защита от двойного тапа (endpoint и так идемпотентен)
    setBusy(true);
    try {
      const auth = await authenticate();
      const launch = intakeIdFromStartParam(auth?.startParam);
      if (launch) rememberLaunchIntake(launch);
      await api.completeOnboarding();
    } catch {
      /* даже при сбое не запираем пользователя в onboarding */
    }
    // A launch that brought a forwarded claim continues to it; otherwise home.
    const intake = takeLaunchIntake();
    router.replace(intake ? askPathForIntake(intake) : "/home");
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col px-6 py-10">
      <div className="flex justify-end gap-1 text-sm" data-testid="onboarding-language">
        {(["EN", "RU"] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => choose(l)}
            aria-pressed={language === l}
            className={`pill px-3 py-1 ${language === l ? "text-[var(--atlas-cyan)]" : "text-[var(--atlas-text-dim)]"}`}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="enter flex flex-1 flex-col justify-center gap-4" key={screen}>
        <h1 className="text-2xl font-semibold text-[var(--atlas-cyan)]">
          {screens[screen].title}
        </h1>
        <p className="text-base leading-7 text-[var(--atlas-text)]">
          {screens[screen].body}
        </p>
      </div>

      <div className="flex items-center justify-center gap-2 py-6">
        {screens.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-colors ${
              i === screen ? "w-6 bg-[var(--atlas-cyan)]" : "w-1.5 bg-white/20"
            }`}
          />
        ))}
      </div>

      <div className="flex flex-col gap-3 pb-4">
        <button
          type="button"
          className="pill cta w-full py-3 text-base"
          onClick={() => (isLast ? void complete() : setScreen((s) => s + 1))}
        >
          {isLast ? dict.onboarding.start : dict.onboarding.next}
        </button>
        {!isLast && (
          <button
            type="button"
            onClick={() => void complete()}
            className="pill w-full py-2 text-sm text-[var(--atlas-text-dim)]"
          >
            {dict.onboarding.skip}
          </button>
        )}
      </div>
    </main>
  );
}
