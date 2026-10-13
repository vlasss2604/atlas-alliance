"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import { api, ApiError, authenticate, getMe, type MeResponse } from "./api";
import { betaInviteFromStartParam } from "./beta-invite-launch";
import { en, type Dict } from "./i18n/en";
import { ru } from "./i18n/ru";
import { askPathForIntake, intakeIdFromStartParam, rememberLaunchIntake } from "./intake-launch";
import { getPlatform } from "./platform";

interface AppState {
  me: MeResponse | null;
  // D-170: a creator invite this user opened could not grant access
  // because the invite's user limit is reached. Generic, in memory only.
  betaAccessFull: boolean;
  dict: Dict;
  refresh: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

// Async-паттерн (B11): shell рендерится сразу, аутентификация и /api/me —
// в фоне; UI наблюдает состояние, а не блокируется запросом.
export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [betaAccessFull, setBetaAccessFull] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      setMe(await getMe());
    } catch {
      /* остаёмся в loading-состоянии; api.ts сам переаутентифицируется */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      getPlatform().ready();
      const auth = await authenticate();
      if (cancelled) return;
      // A creator beta invite (D-170) is redeemed for the user who just
      // signed in, before anything else reads /api/me. A refused or failed
      // redemption changes nothing: the app opens exactly as without it.
      const invite = betaInviteFromStartParam(auth?.startParam);
      if (invite) {
        await api.redeemBetaInvite(invite).catch((e: unknown) => {
          if (e instanceof ApiError && e.code === "BETA_ACCESS_FULL") setBetaAccessFull(true);
        });
      }
      // A Telegram deep link carrying an intake id (signed start parameter)
      // lands on the Ask screen with that id in the query — the same entry
      // the bot's button uses. Onboarding still runs first for a new user;
      // the launch is remembered for the moment it completes.
      const launchIntake = intakeIdFromStartParam(auth?.startParam);
      if (auth && !auth.onboardingCompleted && pathname !== "/onboarding") {
        if (launchIntake) rememberLaunchIntake(launchIntake);
        router.replace("/onboarding");
      } else if (launchIntake && pathname !== "/ask") {
        router.replace(askPathForIntake(launchIntake));
      }
      await refresh();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Обновление unread-состояния при возврате фокуса (SSE — Фаза 3).
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const dict = me?.language === "RU" ? ru : en;
  return (
    <AppContext.Provider value={{ me, betaAccessFull, dict, refresh }}>
      {children}
    </AppContext.Provider>
  );
}
