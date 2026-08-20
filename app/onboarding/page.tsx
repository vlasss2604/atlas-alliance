"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { api, authenticate } from "@/src/client/api";
import { en } from "@/src/client/i18n/en";
import { ru } from "@/src/client/i18n/ru";

// 3 экрана (LOCKED §10): вторичный «Пропустить», точки-пагинация, каждый
// экран в один viewport. Состояние — на сервере, endpoint идемпотентен.
// Язык до первого /api/me неизвестен — берём из navigator (только для
// отображения onboarding; сохранённый выбор всегда с backend).
export default function OnboardingPage() {
  const router = useRouter();
  const [screen, setScreen] = useState(0);
  const [busy, setBusy] = useState(false);
  const dict =
    typeof navigator !== "undefined" && navigator.language.startsWith("ru") ? ru : en;
  const screens = dict.onboarding.screens;
  const isLast = screen === screens.length - 1;

  const complete = async () => {
    if (busy) return; // защита от двойного тапа (endpoint и так идемпотентен)
    setBusy(true);
    try {
      await authenticate();
      await api.completeOnboarding();
    } catch {
      /* даже при сбое не запираем пользователя в onboarding */
    }
    router.replace("/home");
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col px-6 py-10">
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
            className={`h-1.5 rounded-full transition-all ${
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
