"use client";

// ClientPlatformAdapter (canonical v3 §2A): ядро фронтенда не знает про
// window.Telegram — вся Telegram-специфика живёт здесь.

export interface PlatformAdapter {
  kind: "telegram" | "web";
  getInitData(): string | null;
  ready(): void;
  haptic(type: "light" | "success"): void;
}

interface TelegramWebApp {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  HapticFeedback?: {
    impactOccurred?: (style: string) => void;
    notificationOccurred?: (type: string) => void;
  };
}

function telegramWebApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } })
    .Telegram?.WebApp;
  return tg && tg.initData ? tg : null;
}

const telegramAdapter = (tg: TelegramWebApp): PlatformAdapter => ({
  kind: "telegram",
  getInitData: () => tg.initData ?? null,
  ready: () => {
    tg.ready?.();
    tg.expand?.();
  },
  haptic: (type) => {
    if (type === "light") tg.HapticFeedback?.impactOccurred?.("light");
    else tg.HapticFeedback?.notificationOccurred?.("success");
  },
});

const webAdapter: PlatformAdapter = {
  kind: "web",
  getInitData: () => null,
  ready: () => {},
  haptic: () => {},
};

export function getPlatform(): PlatformAdapter {
  const tg = telegramWebApp();
  return tg ? telegramAdapter(tg) : webAdapter;
}
