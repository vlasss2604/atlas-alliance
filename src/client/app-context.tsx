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

import { authenticate, getMe, type MeResponse } from "./api";
import { en, type Dict } from "./i18n/en";
import { ru } from "./i18n/ru";
import { getPlatform } from "./platform";

interface AppState {
  me: MeResponse | null;
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
      if (auth && !auth.onboardingCompleted && pathname !== "/onboarding") {
        router.replace("/onboarding");
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
    <AppContext.Provider value={{ me, dict, refresh }}>
      {children}
    </AppContext.Provider>
  );
}
