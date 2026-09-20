"use client";

// ClientPlatformAdapter (canonical v3 §2A): ядро фронтенда не знает про
// window.Telegram — вся Telegram-специфика живёт здесь.

export interface PlatformAdapter {
  kind: "telegram" | "web";
  getInitData(): string | null;
  ready(): void;
  haptic(type: "light" | "success"): void;
  // Open an external URL the platform's own way. Inside Telegram a plain
  // `target="_blank"` anchor is not reliably honoured by every client, so
  // the Mini App API opens it; on the web the anchor does its own job.
  // Returns true when the platform handled it (the caller then prevents
  // the anchor's default), false to let the anchor proceed.
  openExternal(url: string): boolean;
}

interface TelegramWebApp {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
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
  openExternal: (url) => {
    if (!tg.openLink) return false;
    tg.openLink(url);
    return true;
  },
});

const webAdapter: PlatformAdapter = {
  kind: "web",
  getInitData: () => null,
  ready: () => {},
  haptic: () => {},
  openExternal: () => false,
};

export function getPlatform(): PlatformAdapter {
  const tg = telegramWebApp();
  return tg ? telegramAdapter(tg) : webAdapter;
}
