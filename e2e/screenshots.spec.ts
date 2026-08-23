import { test } from "@playwright/test";

const OUT = process.env.SHOTS_DIR ?? "/tmp/shots";

// Скриншот-прогон ключевых состояний Фазы 2 (viewport 390×844 из конфига).
test("capture phase 2 screens", async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, "screenshot run only (set SHOTS_DIR)");
  // Onboarding: 3 экрана
  await page.goto("/home");
  await page.waitForURL("**/onboarding");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-onboarding-1.png` });
  await page.getByRole("button", { name: /^(Next|Далее)$/ }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/02-onboarding-2.png` });
  await page.getByRole("button", { name: /^(Next|Далее)$/ }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/03-onboarding-3.png` });
  await page.getByRole("button", { name: /^(Start|Начать)$/ }).click();
  await page.waitForURL("**/home");

  // Home
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-home.png` });

  // Ask + примеры
  await page.getByRole("link", { name: /Ask ARI|Спросить ARI/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/05-ask.png` });
  await page.getByRole("button", { name: /Example|Примеры/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/06-ask-examples.png` });
  await page.locator("li button").first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/07-ask-filled.png` });

  // Research (empty state)
  await page.getByRole("link", { name: /Research|Исследования/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/08-research-empty.png` });

  // Projects
  await page.getByRole("link", { name: /Projects|Проекты/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/09-projects.png` });

  // Profile (EN) + переключение на RU
  await page.getByRole("link", { name: /Profile|Профиль/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/10-profile-en.png` });
  await page.getByRole("button", { name: "Русский" }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/11-profile-ru.png` });
});
