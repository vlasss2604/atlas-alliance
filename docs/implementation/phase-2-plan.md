# Фаза 2 — Telegram identity + App shell + Onboarding + Motion System. План

Статус: **ожидает утверждения владельца. Код не пишется до подтверждения.**

Основания: `01_LOCKED_DECISIONS.md` §9–10, `02_ARCHITECTURE_AND_PHASES.md` (Фаза 2 + security DoD), skill `atlas-product-ui`, canonical v3 §2A/§58A/§58B (identity, платформенный адаптер), фундамент Фазы 1.

---

## 1. Объём фазы

**Делаем:** серверную Telegram-аутентификацию, session-слой, каркас приложения (bottom nav, 5 разделов, question-first input), onboarding (3 экрана, серверное состояние), i18n RU/EN, Motion System (токены + примитивы), API-слой `/api/me`, `/api/projects`, `/api/research-jobs`, удаление аккаунта из Профиля.

**Не делаем:** Interpreter и запуск исследований (Фаза 4), Research Engine (5–6), Proof-экраны и Proof Map (7, 10.5), экран оплаты Stars (11–12), admin-UI (9), SSE-прогресс (Фаза 3 — здесь только polling unread).

**Честное состояние вместо заглушек:** экран ввода вопроса полностью свёрстан, но отправка отключена с честным состоянием («ARI подключается — исследования станут доступны в ближайшем обновлении»). Никакого фейкового прогресса и фейковых Proof (закон «Never fake research progress»).

---

## 2. Telegram identity / auth flow

```
Mini App открытие
→ TelegramPlatformAdapter отдаёт raw initData
→ POST /api/auth/telegram  { initData }
→ сервер: HMAC-валидация → freshness → upsert identity → session
→ Set-Cookie: atlas_session (httpOnly, Secure)
→ клиент грузит GET /api/me
```

Серверная валидация (строго на backend, `initDataUnsafe` никогда не авторитет):
1. **Подпись:** `secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)`; `hash == HMAC_SHA256(key=secret, msg=data_check_string)` — сравнение constant-time.
2. **Свежесть:** `auth_date` не старше `AUTH_MAX_AGE_SEC` (env, default 600).
3. **Идентификация:** `user.id` из проверенного initData → upsert `user_identities (provider='TELEGRAM', provider_user_id)`; первого входа — INSERT `users` (гонка двух первых входов гасится unique-констрейнтом Фазы 1: проигравший делает re-select).
4. `users.last_seen_at = now()` при каждом входе.

Session-слой (таблица `sessions` Фазы 1):
- Токен: 32 случайных байта; в БД — только SHA-256 (`token_hash`), сырой токен в httpOnly+Secure+SameSite=None cookie `atlas_session`; TTL 7 дней.
- Повторная аутентификация **ротирует** сессию (старая строка удаляется).
- Middleware `requireSession` → ATLAS User UUID; `requireRole('ADMIN')` — разделение ролей с первого дня (admin-UI нет, guard есть).
- Очистка истёкших сессий — periodic-задача в worker Фазы 1.

Dev-режим: `WebPlatformAdapter` + `AUTH_DEV_BYPASS=1` (работает **только** при `NODE_ENV=development`; в production-сборке ветка кода отсутствует).

## 3. App shell

Структура (App Router):
```
app/(app)/layout.tsx      ← shell: bottom nav + safe areas + platform adapter
app/(app)/home/           ← Главная (вход, состояние уровня, CTA к вопросу)
app/(app)/research/       ← Исследования: список своих jobs/Proof (реальные
                            данные Фазы 1; сейчас — честный empty state)
app/(app)/ask/            ← question-first input (открывается ARI-кнопкой)
app/(app)/projects/       ← Проекты: roster из БД, замки по entitlement
app/(app)/profile/        ← Профиль: язык, уровень, приватность, помощь,
                            удаление аккаунта
app/onboarding/           ← 3 экрана до первого входа
```

- **Bottom nav — единственная навигация**: Главная · Исследования · [ARI] · Проекты · Профиль. Без гамбургера, без notification center, без вкладок Intelligence/History/Patterns/Memory.
- **Центральная ARI-кнопка**: глобальное «начать новое исследование», мягкий переход в `/ask`; несёт unread-индикатор (`research_jobs.unread`, polling `GET /api/me` при фокусе/навигации; SSE — Фаза 3).
- **Question-first input** (канон skill): заголовок «Что вы хотите понять?», placeholder «Задайте вопрос о проекте, токене или рыночном механизме…», helper «Можно писать простыми словами», круглый `?` → glass-tooltip с 4 кликабельными примерами (клик заполняет input, можно редактировать). Textarea не уходит под клавиатуру.
- **Проекты**: карточки из таблицы `projects` (сид: 3 шт.); DEMO-доступность вычисляется на сервере из `product_config.demo_project_slugs` + entitlement; недоступные — видимы с замком (ценность CORE), исследовать нельзя (серверно — с Фазы 4).
- **Профиль**: уровень (DEMO/ARI • CORE — вычисленный entitlement; цена из config, экран оплаты — Фазы 11–12, сейчас только состояние), переключатель языка RU/EN, приватность/помощь (статичные), **«Удалить аккаунт»** — двойное подтверждение → `DELETE users` (каскад доказан тестом №8 Фазы 1).
- **ClientPlatformAdapter** (canonical v3 §2A): интерфейс + `TelegramPlatformAdapter` (тонкая обёртка над `window.Telegram.WebApp`: initData, тема, BackButton, haptics, safe areas) и `WebPlatformAdapter` (dev). Ядро фронтенда не знает про `window.Telegram`.
- **i18n**: собственный типизированный словарь RU/EN (2 языка, ручной выбор — библиотека не нужна); default EN; хранение — `users.language` через `PATCH /api/me/language`; **никакого localStorage и авто-детекта по Telegram locale**.

API фазы: `POST /api/auth/telegram`, `GET /api/me` (профиль+entitlement+onboarding+language+unreadCount), `PATCH /api/me/language`, `POST /api/me/onboarding`, `GET /api/projects`, `GET /api/research-jobs` (свои), `POST /api/research-jobs/:id/read` (сброс unread), `DELETE /api/me`. Все — за `requireSession`; ownership-проверки на сервере.

## 4. Onboarding

3 экрана строго по LOCKED §10 (контент Screen 1–3, вторичный «Пропустить», точки-пагинация, каждый экран в один viewport). Показывается при `onboardingCompleted=false`.

- Состояние на сервере: `users.onboardingCompleted / CompletedAt / Version` (колонки Фазы 1). `POST /api/me/onboarding` **идемпотентен**: повторный вызов не меняет `completedAt` и не ошибается.
- Copy проходит семантические запреты (✗«обучает себя» → ✓«развивается через проверенный исследовательский опыт» и т.д.); не упоминаются human approval / training batches / Pattern-версии.
- Не добавляется: 4-й экран, видео, pricing, выбор языка, разрешения, XP.

## 5. Motion System

Небольшая переиспользуемая система, не значения «на глаз» по экранам:

- **Токены** (CSS variables + Tailwind theme): длительности `--motion-micro: 140ms`, `--motion-transition: 200ms`, `--motion-large: 280ms` (в канонных диапазонах 100–180 / 150–250 / 200–350; 500ms+ навигации нет); easing-набор; z/blur-лимиты.
- **Примитивы**: fade/slide/scale enter-exit, sheet-поведение (для tooltip примеров), transition-обёртка навигации («state transitions, not page jumps»).
- **Правила**: только `transform`/`opacity` в непрерывной анимации; без WebGL/Framer Motion/GSAP (аудит зависимостей: не нужны для v1 — CSS + View Transitions хватает); анимация никогда не блокирует ввод; `prefers-reduced-motion` уважается (упрощение, не уродство).
- **Async-паттерн зашит в API-клиент**: interaction → немедленный optimistic-отклик → наблюдение состояния; никаких блокировок UI на время запроса.
- **Визуальный язык** (направление, не требования): near-black/navy фон, cyan/teal акцент только для активного элемента и primary CTA, glass-панели, pill-кнопки, большие радиусы. Без white-SaaS, без заливки свечением.
- Проверка порядка: FEATURE → MOTION → MOBILE PERFORMANCE CHECK → TEST; целевой viewport 360–430px, реальный Telegram WebView.

## 6. Что переиспользуется из Фазы 1

| Фаза 1 | Использование в Фазе 2 |
|---|---|
| `users`, `user_identities`, `sessions` | весь auth/identity/session-слой |
| `subscriptions` + партиальный entitling-индекс | новый сервис `resolveEntitlement(userId)` → DEMO / ARI_CORE (читает entitling-строку + `valid_until`) |
| `demo_quota_reservations` | счётчик «использовано X из 3» в Профиле/Главной = COUNT(CONSUMED) |
| `projects`, `product_config` | экран Проекты + demo-замки + цена в Профиле |
| `research_jobs` (`unread`, список) | вкладка Исследования, unread-индикатор ARI-кнопки |
| worker Фазы 1 | + periodic-задача очистки истёкших sessions |
| Тестовая инфраструктура (vitest + PG16 + setup) | расширяется тестами Фазы 2 |

## 7. Новые сущности / изменения БД

**Новых таблиц нет. Изменений доменной схемы нет.** Единственная миграция `0002` — служебный индекс `sessions(expires_at)` для дешёвой periodic-очистки. Всё остальное фаза строит на схеме Фазы 1 — это подтверждение того, что фундамент был спроектирован правильно.

## 8. Security considerations (DoD-требования Части 4, Фаза 2)

1. initData валидируется **только на сервере**: HMAC (constant-time сравнение), свежесть `auth_date`, привязка к BOT_TOKEN. `initDataUnsafe` не используется как authority нигде.
2. `BOT_TOKEN` — только env; в логи не попадают ни initData, ни токены сессий (logger-фильтр из Фазы 1 расширяется).
3. Сессии: только хэш в БД, httpOnly+Secure cookie, TTL, ротация при повторном входе, серверная инвалидация при удалении аккаунта.
4. Разделение ролей USER/ADMIN с первого дня: `requireRole` middleware; admin-поверхностей в UI нет.
5. Rate limit на `POST /api/auth/telegram` (простой, per-IP+per-telegram-id, в Postgres — Redis не вводим).
6. Каждый endpoint проверяет ownership на сервере (`GET /api/research-jobs` — только свои; `/read` — только свой job).
7. `DELETE /api/me` — двойное подтверждение в UI + серверная проверка сессии; выполняется одним DELETE (каскады Фазы 1), сессия гасится.
8. Dev-bypass исключён из production-кода условной компиляцией по `NODE_ENV`.

## 9. Definition of Done — тесты

Юнит/интеграционные (vitest + PostgreSQL, продолжение сьюта Фазы 1):
1. initData: валидный образец проходит; подделанный hash → 401; `auth_date` старше лимита → 401; чужой BOT_TOKEN → 401.
2. Первый вход создаёт users + user_identities; повторный вход того же telegram id возвращает того же user (дублей нет); гонка двух первых входов → один user.
3. Сессия: в БД только хэш; истёкшая → 401; повторная аутентификация ротирует (старый токен перестаёт работать).
4. Onboarding: двойной POST → `completedAt` не меняется, ошибок нет; `version` фиксируется.
5. Язык: default EN; PATCH сохраняет RU на backend; `GET /api/me` отражает.
6. `GET /api/projects`: 3 проекта из сида; `demoAvailable` вычислен из product_config (смена config меняет ответ без деплоя).
7. Unread: терминальный переход job выставляет unread (Фаза 1) → `unreadCount` в `/api/me`; `POST :id/read` сбрасывает; чужой job сбросить нельзя.
8. RBAC: USER на admin-guarded endpoint → 403.
9. Удаление аккаунта: user-owned каскадится, знания целы, сессия невалидна.
10. Rate limit: N+1-й запрос auth в окно → 429.

E2E (Playwright, предустановленный Chromium, viewport 390×844, dev-режим с WebPlatformAdapter):
11. Первый вход → onboarding (3 экрана, «Пропустить» вторичен) → shell; повторный вход → onboarding не показывается.
12. Bottom nav обходит все 4 раздела; ARI-кнопка открывает `/ask`; клик по примеру заполняет input; submit в честном disabled-состоянии.
13. `prefers-reduced-motion: reduce` — приложение остаётся полностью функциональным.

Сборка: `next build`, `tsc --noEmit`, `eslint` — чистые. Перед вёрсткой сверяюсь с `node_modules/next/dist/docs` (Next 16, App Router — требование AGENTS.md).

## 10. STRATEGY REVIEW REQUIRED

Не обнаружено — фаза реализует уже зафиксированные решения. Три **инженерных** решения фиксируются этим планом (не продуктовые):
1. Без сторонних библиотек Telegram SDK / i18n / motion — тонкий адаптер, свой словарь на 2 языка, CSS-механика (правило аудита зависимостей из skill).
2. Session в httpOnly cookie с ротацией (вместо повторной передачи initData на каждый запрос).
3. Отправка вопроса до Фазы 4 — честное disabled-состояние (не создаём job, не имитируем работу).

Пограничный пункт, который я считаю решённым каноном, но подсвечиваю: **«Удалить аккаунт» активен уже в Фазе 2** (канон навигации включает его в Профиль; схема Фазы 1 делает удаление тривиальным и безопасным). Если хочешь отложить активацию до public v1 — скажи, уберу за флаг.

---

Оценка: 1.5–2 нед из плана фаз. Порядок: auth+sessions → API `/me` → shell+nav+adapter → i18n → onboarding → экраны → motion-полировка → тесты → e2e.

**Ожидает подтверждения владельца. После «подтверждаю» — реализация строго по этому документу.**
