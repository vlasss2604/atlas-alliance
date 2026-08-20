import { expect, test } from "@playwright/test";
import { Pool } from "pg";

// Тест §9.11 Фазы 3: живой прогресс во вкладке «Исследования» без
// перезагрузки. Job создаётся напрямую в БД (research_enabled в dev
// остаётся false — прод-путь закрыт до Фазы 4), стадии двигаются SQL'ем,
// как это будет делать настоящий pipeline. UI обязан отражать обе смены.

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://atlas:atlas@localhost:5432/atlas_dev",
});

// Auth в dev происходит асинхронно после загрузки страницы —
// дожидаемся появления identity.
async function devUserId(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await pool.query(
      `SELECT user_id FROM user_identities
       WHERE provider = 'TELEGRAM_DEV' AND provider_user_id = 'dev_user_1'`,
    );
    if (r.rows[0]) return r.rows[0].user_id;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error("dev user was not created by auth");
}

test.afterAll(async () => {
  await pool.end();
});

test("live research tab: stage updates over SSE, unread dot appears on terminal", async ({
  page,
}) => {
  // Прогрев: shell рендерится ДО завершения auth (immediate feedback),
  // поэтому ждём сам ответ /api/auth/telegram, а не видимость навигации.
  const authResponse = page.waitForResponse((r) =>
    r.url().includes("/api/auth/telegram"),
  );
  await page.goto("/home");
  const auth = (await (await authResponse).json()) as {
    onboardingCompleted: boolean;
  };
  if (!auth.onboardingCompleted) {
    await page.waitForURL("**/onboarding");
    await page.getByRole("button", { name: /^(Skip|Пропустить)$/ }).click();
    await page.waitForURL("**/home");
  }

  const userId = await devUserId();
  await pool.query(`DELETE FROM research_jobs WHERE user_id = $1`, [userId]);
  const topic = await pool.query(`SELECT id FROM topics WHERE is_active = true`);
  const job = await pool.query(
    `INSERT INTO research_jobs
       (user_id, topic_id, original_question, normalized_task_hash,
        idempotency_key, entitlement_at_start, capability_at_start, budget_at_start)
     VALUES ($1, $2, 'live e2e question', $3, $4, 'ARI_CORE', 'FRESH_RESEARCH',
             '{"maxWallClockSec": 600}')
     RETURNING id`,
    [userId, topic.rows[0].id, `hash_${Date.now()}`, `idem_${Date.now()}`],
  );
  const jobId = job.rows[0].id as string;

  await page.getByRole("link", { name: /Research|Исследования/ }).click();
  const status = page.getByTestId(`job-status-${jobId}`);
  await expect(status).toHaveText(/Atlas is picking this up|Atlas принимает задачу/);

  // Worker-подобные переходы через БД: UI должен догнать без перезагрузки
  await pool.query(`UPDATE research_jobs SET state = 'RUNNING' WHERE id = $1`, [jobId]);
  await pool.query(`UPDATE research_jobs SET progress_stage = 3 WHERE id = $1`, [jobId]);
  await expect(status).toHaveText(
    /Searching for missing evidence|Ищу недостающие доказательства/,
    { timeout: 10_000 },
  );

  // Терминал — как в боевом transitionJobState: state + unread + finished_at
  await pool.query(
    `UPDATE research_jobs SET state = 'SUCCEEDED', unread = true, finished_at = now()
     WHERE id = $1`,
    [jobId],
  );
  await expect(status).toHaveText(/Proof is ready|Proof готов/, { timeout: 10_000 });

  // Терминал → unread-точка на ARI-кнопке (класс unread-dot)
  const ariButton = page.getByRole("link", { name: /Ask ARI|Спросить ARI/ });
  await expect(ariButton).toHaveClass(/unread-dot/, { timeout: 10_000 });

  await pool.query(`DELETE FROM research_jobs WHERE id = $1`, [jobId]);
});
