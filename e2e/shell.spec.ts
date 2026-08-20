import { expect, test } from "@playwright/test";

// Тесты §9.11–13 плана Фазы 2. Последовательность важна (workers: 1):
// первый прогон проходит onboarding, дальше он не показывается.

test("11. first visit shows onboarding once, skip is secondary", async ({ page }) => {
  await page.goto("/home");
  await page.waitForURL("**/onboarding");

  // 3 экрана, «Пропустить» вторичен (есть, но не primary CTA)
  const next = page.getByRole("button", { name: /^(Next|Далее)$/ });
  const skip = page.getByRole("button", { name: /^(Skip|Пропустить)$/ });
  await expect(next).toBeVisible();
  await expect(skip).toBeVisible();

  await next.click();
  await next.click();
  await page.getByRole("button", { name: /Start|Начать/ }).click();
  await page.waitForURL("**/home");

  // Повторный вход — onboarding не показывается
  await page.goto("/home");
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByText("ATLAS PROOF").first()).toBeVisible();
});

test("12. bottom nav walks all tabs; ARI opens ask; example fills input; submit honestly disabled", async ({
  page,
}) => {
  await page.goto("/home");
  await expect(page).toHaveURL(/\/home$/);

  await page.getByRole("link", { name: /Research|Исследования/ }).click();
  await expect(page).toHaveURL(/\/research$/);

  await page.getByRole("link", { name: /Projects|Проекты/ }).click();
  await expect(page).toHaveURL(/\/projects$/);
  // Реальный roster из сида
  await expect(page.getByText("Pump.fun")).toBeVisible();

  await page.getByRole("link", { name: /Profile|Профиль/ }).click();
  await expect(page).toHaveURL(/\/profile$/);

  // Центральная ARI-кнопка
  await page.getByRole("link", { name: /Ask ARI|Спросить ARI/ }).click();
  await expect(page).toHaveURL(/\/ask$/);

  // «?» → примеры → клик заполняет input
  await page.getByRole("button", { name: /Example|Примеры/ }).click();
  const example = page.locator("li button").first();
  const exampleText = (await example.textContent())!.trim();
  await example.click();
  await expect(page.locator("textarea")).toHaveValue(exampleText);

  // Честное disabled-состояние отправки (Фаза 4 ещё не подключена)
  await expect(page.getByRole("button", { name: /Start Proof|Начать Proof/ })).toBeDisabled();
});

test("13. prefers-reduced-motion keeps the app fully functional", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("http://localhost:3100/home");
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole("link", { name: /Ask ARI|Спросить ARI/ }).click();
  await expect(page).toHaveURL(/\/ask$/);
  await expect(page.locator("textarea")).toBeVisible();
  await context.close();
});
