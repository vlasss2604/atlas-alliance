import { Pool } from "pg";

// Сброс dev-пользователя перед прогоном: onboarding-флоу воспроизводим.
export default async function globalSetup() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://atlas:atlas@localhost:5432/atlas_dev",
  });
  await pool.query(
    `DELETE FROM users WHERE id IN (
       SELECT user_id FROM user_identities
       WHERE provider = 'TELEGRAM_DEV' AND provider_user_id = 'dev_user_1')`,
  );
  await pool.end();
}
