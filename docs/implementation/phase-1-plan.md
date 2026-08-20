# Фаза 1 — Домен + БД. План реализации

Статус: **ожидает утверждения владельца. Код не пишется до подтверждения.**

Основания: `atlas-audit.md` (утверждённые A1/A2), `01_LOCKED_DECISIONS.md`, canonical v3 §59–§60 (модель данных и констрейнты, очищенные от legacy по правилу A2).

Утверждённый стек (A1): Next.js 16 (UI + Route Handlers) + отдельный долгоживущий Node research-worker, PostgreSQL + Drizzle, очередь pg-boss, SSE + polling fallback.

---

## 1. Объём фазы

**Делаем:** схема БД «волны 1», миграции, доменные типы, product config, каркас worker-процесса, юнит-тесты констрейнтов и резервации квоты.

**Не делаем:** Telegram-аутентификацию (Фаза 2), Interpreter (Фаза 4), Research Engine (Фазы 5–6), UI, платежи. Никакой бизнес-логики поверх схемы, кроме двух транзакционных примитивов: создание job с резервацией квоты и журнал переходов состояний.

Таблицы будущих фаз (research_memory, project_memory_items, research_experience, regression_*, payment_*, issues/audit_log) в волну 1 **не входят** — каждая придёт своей миграцией в своей фазе. Схема волны 1 обязана их не блокировать (см. §7).

---

## 2. Структура кода

```
src/server/
  db/
    schema/           ← Drizzle-схема по доменам (identity.ts, catalog.ts,
                        research.ts, proof.ts, config.ts)
    migrations/       ← SQL-миграции drizzle-kit (коммитятся в git)
    client.ts         ← пул подключений (pg)
  domain/             ← доменные типы и enum'ы (единственный источник)
  jobs/
    queue.ts          ← обёртка pg-boss (enqueue в той же транзакции)
    worker.ts         ← entrypoint worker-процесса (graceful shutdown,
                        подхват зависших RUNNING при старте)
  config/
    product.ts        ← чтение product_config c валидацией схемы
scripts/
  migrate.ts, seed.ts
```

`package.json`: `db:generate`, `db:migrate`, `db:seed`, `worker:dev`. Секреты (DATABASE_URL и пр.) — только через переменные окружения (security DoD Фазы 1). Все деньги/квоты/бюджеты — целые числа, float запрещён.

---

## 3. Enum'ы (PostgreSQL enum через Drizzle `pgEnum`)

| Enum | Значения |
|---|---|
| `entitlement_level` | `DEMO`, `ARI_CORE` |
| `research_capability` | `MEMORY`, `TARGETED_REFRESH`, `FRESH_RESEARCH` |
| `subscription_status` | `PENDING`, `ACTIVE`, `CANCEL_AT_PERIOD_END`, `CANCELLED`, `EXPIRED`, `PAST_DUE` |
| `project_status` | `RESEARCHED_INTERNAL`, `CANDIDATE`, `ACTIVE_CORE`, `UNPUBLISHED`, `DEPRECATED` |
| `research_job_state` | `QUEUED`, `RUNNING`, `AWAITING_CLARIFICATION`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `BUDGET_LIMIT_REACHED` |
| `interpreter_status` | `READY`, `NEEDS_CLARIFICATION`, `OUT_OF_SCOPE`, `INVALID` |
| `verdict` | `SUPPORTED`, `PARTIALLY_SUPPORTED`, `NOT_SUPPORTED`, `INSUFFICIENT_EVIDENCE`, `NOT_APPLICABLE` |
| `proof_visibility` | `PRIVATE`, `ADMIN_ONLY` (значения `PUBLIC` нет вообще — v1) |
| `quota_reservation_state` | `RESERVED`, `CONSUMED`, `RELEASED` |
| `evidence_relationship` | `SUPPORTS`, `CONTRADICTS`, `CONTEXT`, `LIMITS` |
| `source_type` | `OFFICIAL_DOCS`, `GOVERNANCE`, `ONCHAIN`, `SECURITY`, `RESEARCH`, `NEWS`, `OTHER` |
| `source_health` | `UNKNOWN`, `OK`, `BROKEN`, `CHANGED` |
| `memory_status` | `NOT_USED`, `USED`, `USED_AND_REVERIFIED` |
| `user_role` | `USER`, `ADMIN` |
| `progress_stage` | не enum — smallint 1..5 (стадии из LOCKED §9), CHECK (1..5) |

Все пользовательские тексты статусов — presentation layer; enum'ы в UI не показываются.

---

## 4. Таблицы волны 1

PK везде — `uuid` (генерация `gen_random_uuid()`, несеквенциальные — защита от подбора ID). Везде `created_at timestamptz default now()`.

### 4.1 Identity / access

**users**
- `id`, `role user_role default 'USER'`
- `language text default 'EN'` (RU/EN, ручной выбор, хранится на backend)
- `onboarding_completed bool default false`, `onboarding_completed_at`, `onboarding_version smallint`
- `last_seen_at`
- Lifetime DEMO-счётчик здесь НЕ дублируется — единственный источник истины: `demo_quota_reservations` (см. 4.4). «Использовано» = COUNT(state='CONSUMED'). Двойная бухгалтерия запрещена.

**user_identities**
- `user_id FK→users ON DELETE CASCADE`, `provider text` (v1: `'TELEGRAM'`), `provider_user_id text`
- `UNIQUE (provider, provider_user_id)` — второй аккаунт не создаётся
- Telegram-специфика (username и т.п.) — jsonb `meta`, не колонки

**sessions**
- `user_id FK CASCADE`, `token_hash text UNIQUE`, `expires_at`
- Хэш, не сырой токен. Наполнение — Фаза 2, таблица создаётся сейчас.

**subscriptions**
- `user_id FK CASCADE`, `level entitlement_level` (v1 всегда `ARI_CORE`), `status subscription_status`
- `valid_from`, `valid_until`, `auto_renew bool`
- `billing_provider text` (v1: `'TELEGRAM_STARS'`), `provider_subscription_ref text`, `plan_version text`, `price_stars_at_purchase int` — снапшот цены/плана в момент покупки
- Партиальный уникальный индекс: максимум одна `status='ACTIVE'` подписка на пользователя
- Refund — событие поверх статуса (`CANCELLED` + `cancelled_reason text`), Proof'ы и запущенные job не трогаются (неретроактивность — B1)

### 4.2 Каталог знаний

**topics** — `slug UNIQUE` (`token_value_capture`), `name`, `is_active bool`. Активна одна; активация новых — вручную.

**projects**
- `slug UNIQUE`, `name`, `ticker`, `status project_status`
- `published_at`, `last_verified_at`, `deprecated_at`
- DEMO-доступность здесь НЕ хранится (это entitlement, не свойство проекта) — она в product_config (`demo_project_slugs`). Scope ≠ Entitlement (B4).
- `ON DELETE RESTRICT` отовсюду — проекты не удаляются, только `DEPRECATED`

**project_aliases** — `project_id FK RESTRICT`, `alias text`, `UNIQUE (lower(alias))`.

**research_patterns**
- `topic_id FK RESTRICT`, `version int`, `status text CHECK IN ('DRAFT','ACTIVE','RETIRED')`, `content jsonb`
- `UNIQUE (topic_id, version)`; партиальный уникальный индекс: одна ACTIVE на topic
- Переход v1→v2 — только вручную (LOCKED §11); таблица версионируема с первого дня (B12)

### 4.3 Research execution

**research_jobs** — центральная сущность (B2):
- `user_id FK CASCADE`, `project_id FK RESTRICT NULL`, `topic_id FK RESTRICT`
- `state research_job_state default 'QUEUED'`, `progress_stage smallint CHECK 1..5 default 1`, `memory_status memory_status default 'NOT_USED'`
- `original_question text`, `normalized_task jsonb`, `normalized_task_hash text` (sha256 канонизированной задачи)
- **Снапшот entitlement (B1):** `entitlement_at_start entitlement_level`, `capability_at_start research_capability`, `budget_at_start jsonb` (плоские значения: max_search_queries, max_source_opens, max_model_cost_micro, max_wall_clock_sec, reserved_recovery_budget — все int)
- `idempotency_key text`, `UNIQUE (user_id, idempotency_key)` — retry клиента возвращает тот же job
- **Dedupe активных job (B10):** `UNIQUE (user_id, normalized_task_hash) WHERE state IN ('QUEUED','RUNNING','AWAITING_CLARIFICATION')` — конфликт при INSERT обрабатывается как «вернуть существующий job», не ошибка
- `clarification_attempts smallint default 0 CHECK (<= 2)` — жёсткий лимит уточнений на уровне БД
- `unread bool default false` (серверный completion/unread state — B11)
- `started_at`, `finished_at`, `error_code text NULL` (без stack trace и внутренностей — пользователю не протекает)

**research_job_transitions** — append-only журнал: `job_id FK CASCADE`, `from_state`, `to_state`, `at`, `note text`. Без UPDATE/DELETE (правкой не занимаемся — только вставка).

**interpretations** — результат Question Interpreter (B3), существует ДО job (невалидный ввод не создаёт job и не трогает квоту):
- `user_id FK CASCADE`, `research_job_id FK CASCADE NULL`
- `original_question text`, `status interpreter_status`, `attempt smallint CHECK 1..3`
- `result jsonb` (schema-валидированный structured output), `model_meta jsonb` (модель, длительность — не показывается пользователю)
- Цепочка для отладки UNDERSTANDING vs RESEARCH failure: interpretation → job.normalized_task → (Фаза 5+) plan → proof

### 4.4 DEMO-квота — reservation model (B10, LOCKED §2)

**demo_quota_reservations**
- `user_id FK CASCADE`, `research_job_id FK CASCADE UNIQUE` — максимум одна резервация на job
- `state quota_reservation_state default 'RESERVED'`, `resolved_at`
- Инвариант перехода: `RESERVED → CONSUMED` (успешный Proof) | `RESERVED → RELEASED` (invalid, unsupported, техническая ошибка, отмена). Терминальные состояния не меняются (CHECK + прикладной код).
- **Транзакция создания DEMO-job:** `SELECT id FROM users WHERE id=$1 FOR UPDATE` → подсчёт RESERVED+CONSUMED → если < limit (из config, сейчас 3) → INSERT job + INSERT reservation + enqueue pg-boss — всё в одном коммите. Гонка двух устройств упирается в блокировку строки user.
- CORE-job резервацию не создаёт (лимита нет), счётчик DEMO не трогается — «lifetime живёт на уровне User», история сохраняется при смене плана.

### 4.5 Proof (скелет — наполняется Фазой 7, схема сейчас: цепочка владения и ON DELETE решаются в первых миграциях — B6/B7)

**proofs**
- `research_job_id FK CASCADE UNIQUE` — ровно один Proof на job (ретрай не создаёт второй — констрейнт, не договорённость)
- `owner_user_id FK→users CASCADE`, `project_id FK RESTRICT`, `topic_id FK RESTRICT`
- `visibility proof_visibility default 'PRIVATE'`, `verdict verdict`, `confidence smallint CHECK 0..100`
- `layers jsonb` — 7-слойная структура (LOCKED §7), включая обязательный блок «Что может изменить вывод»
- `research_cutoff timestamptz`

**sources** — общесистемные (НЕ user-owned, переживают удаление пользователя):
- `url text`, `url_hash text UNIQUE`, `publisher`, `source_type source_type`
- `health source_health default 'UNKNOWN'`, `last_checked_at` — поля под health-check Фазы 10 (B9)

**evidence**
- `proof_id FK CASCADE NOT NULL`, `source_id FK RESTRICT NOT NULL` — provenance обязателен
- `relationship evidence_relationship`, `fragment text` (оригинал, не переводится), `summary text` (локализуемое краткое описание), `does_not_prove text`
- `fetched_at`, `observed_at`, `data_as_of`, `freshness_class text CHECK IN ('LOW','MEDIUM','HIGH_CHANGE')`

**proof_gaps** — `proof_id FK CASCADE`, `description`, `kind text`

### 4.6 Конфигурация

**product_config** — key-value: `key text PK`, `value jsonb`, `updated_at`. Читается через `src/server/config/product.ts` с zod-валидацией. Сид:

```
ari_core_price_stars        = 2999          (int, XTR)
subscription_period_days    = 30
demo_lifetime_proof_limit   = 3
demo_project_slugs          = ["pump_fun","hyperliquid","uniswap"]
demo_max_capability         = "TARGETED_REFRESH"
demo_max_recovery_steps     = 1
budget_demo / budget_core   = профили бюджетов job (целые числа)
```

Ни одно из этих значений не появляется в коде или UI как литерал (B8).

---

## 5. Правила ON DELETE (deletion-safe с первого дня — B7)

| Категория | Таблицы | Поведение |
|---|---|---|
| User-owned | user_identities, sessions, subscriptions, research_jobs (+transitions), interpretations, demo_quota_reservations, proofs (+evidence, proof_gaps) | `ON DELETE CASCADE` от users — удаление аккаунта достижимо одним DELETE |
| System knowledge | topics, projects, project_aliases, research_patterns, sources, product_config | БЕЗ ссылок на user; `RESTRICT` между собой; переживают удаление любого пользователя |

Правило анонимизации на будущее (Фаза 5): знание при промоушене в verified memory теряет ссылку на пользователя в момент промоушена, а не при удалении аккаунта.

---

## 6. Job-модель (pg-boss)

- pg-boss в том же PostgreSQL (schema `pgboss`), очередь `research`.
- **Enqueue транзакционен:** вставка задачи pg-boss выполняется тем же коммитом, что и INSERT research_jobs + резервация квоты (pg-boss поддерживает insert через клиентскую транзакцию). Нет коммита — нет задачи; есть задача — есть job. Outbox не нужен.
- Worker (`worker.ts`): отдельный процесс; конкурентность v1 = 1 job на пользователя (проверка при взятии), глобально — конфигурируемо (старт: 2).
- Ретраи pg-boss ограничены (retryLimit 2, backoff); идемпотентность гарантируют констрейнты (`proofs.research_job_id UNIQUE`, reservation UNIQUE), а не дисциплина кода.
- Рестарт worker: при старте — подхват задач pg-boss (встроенно); job, зависший в RUNNING дольше `max_wall_clock_sec` × 1.5 — переводится в FAILED с `RELEASED` резервацией (честный сбой вместо вечного RUNNING).
- В Фазе 1 worker исполняет только тестовый no-op хендлер (создание инфраструктуры); реальный pipeline — Фазы 4–6.

---

## 7. Что волна 1 сознательно НЕ создаёт (и почему не заблокирует)

| Отложено | Фаза | Почему схема готова |
|---|---|---|
| research_memory, project_memory_items (lifecycle OBSERVED→CANDIDATE→ACTIVE) | 5 | ссылаются на projects/topics/sources — все существуют |
| research_plans / contracts | 5–6 | ссылаются на research_jobs |
| research_experience | 8 | ссылается на proofs/research_jobs |
| regression_cases/runs/results | 10 | ссылаются на projects/patterns |
| payment_orders / payments / payment_events | 12 | ссылаются на users/subscriptions; снапшот цены уже в subscriptions |
| issues, audit_log (admin) | 9 | append-only поверх существующего |

---

## 8. Миграции и сид

- drizzle-kit generate → SQL-файлы в `src/server/db/migrations/`, коммитятся; порядок детерминирован; каждая миграция прогоняется на чистой БД в тесте.
- Сид (идемпотентный, безопасный для повторного запуска): topic `token_value_capture`; product_config (значения выше); проекты `pump_fun`, `hyperliquid`, `uniswap` со статусом `ACTIVE_CORE` (минимум для работы DEMO). Остальные проекты добавляются админ-действием, не сидом. **Никаких фейковых Proof/Evidence/Memory в сиде** — verified-знание сид создавать не может.

## 9. Тесты (Definition of Done фазы)

Vitest + PGlite (in-memory Postgres) либо локальный Postgres — оба варианта без внешней инфраструктуры:

1. Миграции проходят на чистой БД; повторный сид не дублирует данные.
2. `UNIQUE (provider, provider_user_id)` — второй identity отклоняется.
3. Idempotency: два INSERT job с одним `(user_id, idempotency_key)` → один job.
4. Dedupe: два активных job с одним `normalized_task_hash` → второй INSERT конфликтует; после SUCCEEDED — новый создаётся.
5. Квота: параллельные транзакции резервации при лимите 3 → максимум 3 RESERVED+CONSUMED (тест гонки через FOR UPDATE).
6. RELEASED не считается в лимите; CONSUMED не освобождается.
7. `proofs.research_job_id UNIQUE` — второй Proof на job отклоняется.
8. Удаление user каскадит все user-owned таблицы и НЕ трогает projects/sources/topics.
9. Enqueue-транзакция: rollback после INSERT job → задача в pg-boss не появляется.

## 10. Порядок выполнения

1. Зависимости: `drizzle-orm`, `drizzle-kit`, `pg`, `pg-boss`, `zod`, `vitest`, `@electric-sql/pglite` (dev).
2. Схема волны 1 + enum'ы + миграция 0001 + сид.
3. Транзакционные примитивы: `createResearchJob()` (квота+job+enqueue) и `transitionJobState()` (переход + журнал) — единственная логика фазы.
4. Каркас worker + no-op хендлер.
5. Тесты §9, прогон, фиксация результатов в PR-описании коммита.

Оценка: в пределах 1–1.5 нед из плана фаз.

---

**Ожидает подтверждения владельца. После «подтверждаю» — реализация строго по этому документу; любое отклонение от схемы — сначала правка этого документа.**
