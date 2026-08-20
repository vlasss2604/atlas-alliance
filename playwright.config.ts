import { defineConfig } from "@playwright/test";

// E2E Фазы 2 (phase-2-plan §9.11–13): dev-режим, WebPlatformAdapter +
// AUTH_DEV_BYPASS. Viewport — канонный mobile-first 390×844.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3100",
    // Канонный mobile-first viewport; НЕ спредить devices["Desktop Chrome"]
    // поверх — project-level use перекрывает этот блок (был баг: e2e шли 1280×720).
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    // Предустановленный Chromium окружения (версия пиннована не нами):
    // не скачиваем браузеры, используем существующий бинарь.
    launchOptions: { executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" },
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: "npx next dev -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      NODE_ENV: "development",
      AUTH_DEV_BYPASS: "1",
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://atlas:atlas@localhost:5432/atlas_dev",
      BOT_TOKEN: "123456:E2E_TOKEN",
      CSRF_SECRET: "e2e-csrf-secret",
      ALLOWED_ORIGINS: "http://localhost:3100",
      // Детерминированный Interpreter: e2e проверяет поведение продукта,
      // а не вывод модели (и не тратит бюджет на прогонах).
      MODEL_GATEWAY: "fake",
    },
  },
});
