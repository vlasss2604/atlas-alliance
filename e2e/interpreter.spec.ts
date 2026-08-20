import { expect, test } from "@playwright/test";

// E2E Фазы 4 (DoD-14): реальный поток Ask-экрана на mobile viewport
// с детерминированным gateway (MODEL_GATEWAY=fake).
// research_enabled в dev-БД = false, поэтому финальное состояние —
// честная неактивная кнопка Proof, а не фейковый запуск.

async function openAsk(page: import("@playwright/test").Page) {
  // Онбординг может перенаправить уже после загрузки /home (аутентификация
  // идёт в фоне) — сначала дожидаемся, чем всё закончилось.
  await page.goto("/home");
  await page.waitForURL(/\/(home|onboarding)$/);
  await page.waitForTimeout(1000);
  if (page.url().includes("/onboarding")) {
    await page.getByRole("button", { name: /^(Skip|Пропустить)$/ }).click();
    await page.waitForURL("**/home");
  }
  await page.getByRole("link", { name: /Ask ARI|Спросить ARI/ }).click();
  await expect(page).toHaveURL(/\/ask$/);
}

test("14a. вопрос без проекта → уточнение → понимание задачи → честная кнопка Proof", async ({
  page,
}) => {
  await openAsk(page);

  await page.locator("textarea").fill("Они много зарабатывают, а holder что получает?");
  await page.getByRole("button", { name: /Start Proof|Начать Proof/ }).click();

  // Уточнение: ARI задаёт один короткий вопрос
  const clarify = page.getByText(/One question before I start|Один вопрос перед началом/);
  await expect(clarify).toBeVisible({ timeout: 15_000 });

  await page.locator("textarea").fill("Uniswap");
  await page.getByRole("button", { name: /^(Send|Отправить)$/ }).click();

  // Понимание задачи показано пользователю до запуска исследования
  await expect(
    page.getByText(/Here is what I will research|Вот что я буду исследовать/),
  ).toBeVisible({ timeout: 15_000 });

  // Запуск Proof закрыт честно: движок исследований появится в Фазе 6
  const start = page.getByRole("button", { name: /Start Proof|Начать Proof/ });
  await expect(start).toBeDisabled();
  await expect(
    page.getByText(/ARI is being connected|ARI подключается/),
  ).toBeVisible();
});

test("14b. вопрос вне области → мягкое объяснение, без ошибки", async ({ page }) => {
  await openAsk(page);

  await page.locator("textarea").fill("Какая завтра погода в Москве?");
  await page.getByRole("button", { name: /Start Proof|Начать Proof/ }).click();

  await expect(
    page.getByText(/ATLAS researches how digital assets|ATLAS исследует, как цифровые активы/),
  ).toBeVisible({ timeout: 15_000 });
  // Никаких технических кодов и слова «ошибка» на экране
  await expect(page.getByText(/UNSUPPORTED|ERROR|OUT_OF_SCOPE/)).toHaveCount(0);
});
