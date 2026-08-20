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

Проверка `auth_date` — с двух сторон (не только «слишком старое»):
```
now - auth_date >  AUTH_MAX_AGE_SEC (600)   → 401 (устаревшее)
auth_date - now >  AUTH_CLOCK_SKEW_SEC (60) → 401 (из будущего)
```
Второе условие ловит подделку с завышенным временем и рассинхрон часов; допустимый skew — узкий и конфигурируемый.

Session-слой (таблица `sessions` Фазы 1):
- Токен: 32 случайных байта; в БД — только SHA-256 (`token_hash`), сырой токен в cookie `atlas_session`.
- **Атрибуты cookie фиксируются явно:** `HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800` (7 дней).
  `SameSite=None` — вынужденно и осознанно: Telegram Web открывает Mini App в iframe (сторонний контекст), при `Lax/Strict` cookie туда не долетит. Плата за это — CSRF-защита не может опираться на SameSite, поэтому вводится явная (см. §3.1).
- Повторная аутентификация **ротирует** сессию (старая строка удаляется).
- Middleware `requireSession` → ATLAS User UUID; `requireRole('ADMIN')` — разделение ролей с первого дня (admin-UI нет, guard есть).
- Очистка истёкших сессий — periodic-задача в worker Фазы 1.

Dev-режим: `WebPlatformAdapter` + `AUTH_DEV_BYPASS=1` (работает **только** при `NODE_ENV=development`; в production-сборке ветка кода отсутствует).

### 2.1 Rate limit на аутентификацию — с явным хранилищем

Прежняя формулировка была противоречивой («новых таблиц нет» + «rate limit в Postgres»): до успешной аутентификации пользователя в БД ещё нет, счётчику негде жить. Поэтому **вводится одна служебная таблица** (не доменная сущность) — это честнее любого workaround:

```
auth_rate_limits
  bucket_key        text PRIMARY KEY   -- 'ip:<addr>' | 'tg:<provider_user_id>'
  window_started_at timestamptz NOT NULL
  attempts          integer NOT NULL
```

Атомарное обновление — **одним statement** (никакого read-modify-write и никаких гонок; при конфликте строка блокируется самим UPSERT):

```sql
INSERT INTO auth_rate_limits (bucket_key, window_started_at, attempts)
VALUES ($1, now(), 1)
ON CONFLICT (bucket_key) DO UPDATE SET
  attempts = CASE WHEN auth_rate_limits.window_started_at < now() - $2::interval
                  THEN 1 ELSE auth_rate_limits.attempts + 1 END,
  window_started_at = CASE WHEN auth_rate_limits.window_started_at < now() - $2::interval
                  THEN now() ELSE auth_rate_limits.window_started_at END
RETURNING attempts, window_started_at;
```

Фиксированное окно: `attempts > AUTH_RATE_LIMIT` (env, старт: 20 попыток / 10 мин на ключ) → `429` + `Retry-After`.

**Порядок применения ключей — строго после проверки подписи** (иначе злоумышленник подставляет чужой telegram id в невалидный initData и выжигает лимит жертвы — lockout чужого аккаунта):

```
1. IP-bucket   ('ip:<addr>')   → инкремент и проверка ДО валидации
2. валидация initData (HMAC + auth_date)   → при провале выход, шаг 3 НЕ выполняется
3. TG-bucket   ('tg:<verified provider_user_id>') → инкремент и проверка
   ТОЛЬКО для подтверждённого подписью id
4. login / создание сессии
```

Непроверенный `provider_user_id` не используется как ключ лимита ни при каких условиях. Оба инкремента — тем же атомарным UPSERT (конкурентно-безопасны независимо друг от друга). Очистка старых строк — periodic-задача worker'а (та же, что чистит сессии). Таблица служебная: не user-owned, при удалении аккаунта не участвует, хранит только bucket-ключ со счётчиком и TTL.

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

### 3.1 CSRF / same-origin защита state-changing endpoints

Раз `SameSite=None` (требование Telegram Web, §2), браузер сам от CSRF не защитит. Вводим два независимых барьера для **всех** POST/PATCH/DELETE (`/api/me/*`, `/api/research-jobs/*/read`, `DELETE /api/me`):

1. **Session-bound CSRF-токен.** Выводится из сессии без новых колонок и без хранения:
   `csrfToken = HMAC_SHA256(key=CSRF_SECRET, msg=session.token_hash)` (base64url).
   Отдаётся в теле ответа `POST /api/auth/telegram` и `GET /api/me` (не в cookie — иначе double-submit теряет смысл), клиент шлёт его в заголовке `X-Atlas-CSRF`. Сервер пересчитывает от найденной сессии и сравнивает constant-time. Стороннему сайту токен недоступен: cookie `HttpOnly`, а чтобы прочитать тело `/api/me`, нужен CORS-доступ, которого нет.
2. **Origin/Referer allowlist — только собственные frontend-origins ATLAS PROOF.** Домены Telegram в доверенные origins **не добавляются**: Mini App грузится с нашего домена, поэтому у fetch-запросов из его страницы `Origin` — наш собственный, даже когда страница открыта внутри iframe Telegram Web (домен Telegram там — родительский фрейм, а не источник запроса). Расширять allowlist доменами Telegram — только при подтверждённой технической необходимости, доказанной на реальном клиенте, и отдельным решением. Отсутствующий или чужой `Origin` (при отсутствии — `Referer`) на state-changing запросе → `403`.

**Требование ко всем authenticated state-changing endpoints (POST / PATCH / DELETE) — три условия одновременно:** валидная сессия + валидный CSRF-токен + разрешённый Origin. Ни одно не заменяет другое.

**Bootstrap-исключение — `POST /api/auth/telegram`.** Этот endpoint сессию и CSRF-токен *создаёт*, поэтому требовать их от него невозможно (иначе авторизоваться было бы нечем). Его собственная цепочка защиты:

```
1. разрешённый Origin (allowlist — тот же)
2. IP rate limit
3. валидный Telegram initData: HMAC + auth_date (обе границы)
4. verified Telegram-ID rate limit (только для подтверждённого подписью id)
5. → создание сессии, Set-Cookie, выдача CSRF-токена в теле ответа
```

Роль CSRF-токена здесь играет сама подпись initData: подделать её без BOT_TOKEN нельзя, поэтому сторонний сайт не может «залогинить» жертву. Это **единственное** исключение; список endpoints с ним закрыт и зафиксирован здесь — любой новый state-changing endpoint по умолчанию требует все три условия.

GET-запросы остаются без CSRF-требования, но не изменяют состояние (в т.ч. `/api/me` не помечает ничего прочитанным). CORS: `Access-Control-Allow-Origin` только явный allowlist, `credentials: true`; wildcard запрещён.

### 3.2 Compatibility check на реальных Telegram-клиентах (обязателен до public release)

Поведение cookie в embedded WebView нельзя подтвердить в эмуляторе — требуется прогон на живых клиентах. Матрица (каждая ячейка — ручная проверка, результат фиксируется в `docs/implementation/phase-2-compat.md`):

| Клиент | Что проверяем |
|---|---|
| Telegram **Android** | auth (initData доходит и валидируется) · session cookie ставится и переживает переоткрытие · CSRF-заголовок проходит · навигация после auth |
| Telegram **iOS** | то же (отдельно: ITP/ограничения third-party cookie) |
| Telegram **Web** | то же в iframe-контексте (SameSite=None фактически работает) |
| Telegram **Desktop** | то же |

Если на каком-то клиенте cookie в стороннем контексте блокируется, запасной путь — Authorization-заголовок с session-токеном в памяти клиента вместо cookie (архитектура к этому готова: сервер и так сверяет `token_hash`). Решение принимается по результатам проверки, не заранее.

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

**Изменений доменной схемы нет.** Миграция `0002` содержит ровно два пункта:

1. Служебная таблица `auth_rate_limits` (§2.1) — единственная новая таблица фазы; техническая, вне доменной модели, вне цепочки владения пользователя.
2. Индекс `sessions(expires_at)` для дешёвой periodic-очистки.

Ни одна доменная таблица Фазы 1 не меняется — фундамент выдержал фазу без правок.

## 8. Security considerations (DoD-требования Части 4, Фаза 2)

1. initData валидируется **только на сервере**: HMAC (constant-time сравнение), `auth_date` с двух сторон (устаревшее + из будущего сверх skew), привязка к BOT_TOKEN. `initDataUnsafe` не используется как authority нигде. Точный состав `data_check_string` (какие поля исключаются помимо `hash` — в частности `signature` из схемы третьесторонней валидации) сверяется с актуальной документацией Telegram **в момент реализации**, а не по памяти, и пиннится тестом §9.1.
2. `BOT_TOKEN`, `CSRF_SECRET` — только env; в логи не попадают ни initData, ни токены сессий, ни CSRF-токены (logger-фильтр из Фазы 1 расширяется).
3. Сессии: только хэш в БД; cookie `HttpOnly; Secure; SameSite=None; Path=/`; TTL 7 дней; ротация при повторном входе; серверная инвалидация при удалении аккаунта.
4. CSRF: на каждом **authenticated** state-changing endpoint (POST/PATCH/DELETE) одновременно требуются сессия + session-bound токен `X-Atlas-CSRF` + разрешённый Origin (§3.1). Единственное исключение — bootstrap `POST /api/auth/telegram` (создаёт сессию и CSRF-токен; защищён Origin + IP-лимитом + подписью initData + verified-TG-лимитом). Allowlist — только собственные frontend-origins; домены Telegram не доверяются без подтверждённой необходимости. CORS без wildcard, `credentials: true`.
5. Разделение ролей USER/ADMIN с первого дня: `requireRole` middleware; admin-поверхностей в UI нет.
6. Rate limit на `POST /api/auth/telegram` — таблица `auth_rate_limits`, атомарный UPSERT. IP-bucket применяется до валидации, telegram-bucket — **только для подтверждённого подписью** `provider_user_id` (§2.1): непроверенным id чужой лимит выжечь нельзя. `429 + Retry-After`. Redis не вводим.
7. Каждый endpoint проверяет ownership на сервере (`GET /api/research-jobs` — только свои; `/read` — только свой job).
8. `DELETE /api/me` — двойное подтверждение в UI + сессия + CSRF-токен + Origin-проверка; выполняется одним DELETE (каскады Фазы 1), сессия гасится.
9. Dev-bypass исключён из production-кода условной компиляцией по `NODE_ENV`.

## 9. Definition of Done — тесты

Юнит/интеграционные (vitest + PostgreSQL, продолжение сьюта Фазы 1):
1. **initData — известный вектор + мутационный тест** (защита от перепутанных key/message и неверной сборки data-check-string):
   - Вектор строится **независимой референс-реализацией**, написанной в тесте напрямую по шагам документации Telegram (сортировка полей, `\n`-разделитель, `secret = HMAC(key="WebAppData", msg=BOT_TOKEN)`), а не вызовом продакшн-функции. Тест сверяет две независимые реализации — ошибка в одной не «самоподтвердится». Честная оговорка: подписать образец настоящим ботом я не могу, поэтому вектор синтетический, но строится по спецификации независимо и на реалистичной строке (URL-encoding, вложенный JSON `user`, поля `chat_instance`, `auth_date`, `hash`).
   - **Позитивные кейсы** (`200`): валидный вектор проходит; **тот же валидный initData с переставленными query-параметрами проходит тоже** — валидатор обязан сам строить canonical data-check-string (сортировка полей по спецификации), а не полагаться на порядок прихода; неизвестное дополнительное поле включается в data-check-string и не ломает валидацию.
   - **Мутационные кейсы** (`401`) — везде меняется содержимое при сохранении старого `hash`: изменён один символ в `hash`; изменён один символ в `user`; изменён `auth_date`; подпись тем же алгоритмом, но с другим BOT_TOKEN; отсутствует `hash`; пустой initData.
   - Сравнение `hash` — constant-time (проверяется вызовом `timingSafeEqual`, а не `===`).
1b. `auth_date`: старше `AUTH_MAX_AGE_SEC` → 401; из будущего сверх `AUTH_CLOCK_SKEW_SEC` → 401; в пределах skew → проходит.
2. Первый вход создаёт users + user_identities; повторный вход того же telegram id возвращает того же user (дублей нет); гонка двух первых входов → один user.
3. Сессия: в БД только хэш; истёкшая → 401; повторная аутентификация ротирует (старый токен перестаёт работать); Set-Cookie содержит `HttpOnly`, `Secure`, `SameSite=None`, `Path=/` (проверка строки заголовка).
3b. CSRF: authenticated state-changing запрос без `X-Atlas-CSRF` → 403; с чужим/битым токеном → 403; с валидным → проходит; чужой `Origin` при валидном токене → 403; отсутствующий Origin на POST → 403; GET без токена → 200.
3c. **Граница bootstrap-исключения:** `POST /api/auth/telegram` с валидным initData и разрешённым Origin проходит **без** существующих сессии и CSRF-токена (200 + Set-Cookie + csrfToken в теле); он же с чужим Origin → 403. Все остальные state-changing endpoints (`PATCH /api/me/language`, `POST /api/me/onboarding`, `POST /api/research-jobs/:id/read`, `DELETE /api/me`) без сессии → 401, с сессией но без CSRF → 403 (проверяется по списку, а не на одном примере — чтобы исключение не расползлось).
4. Onboarding: двойной POST → `completedAt` не меняется, ошибок нет; `version` фиксируется.
5. Язык: default EN; PATCH сохраняет RU на backend; `GET /api/me` отражает.
6. `GET /api/projects`: 3 проекта из сида; `demoAvailable` вычислен из product_config (смена config меняет ответ без деплоя).
7. Unread: терминальный переход job выставляет unread (Фаза 1) → `unreadCount` в `/api/me`; `POST :id/read` сбрасывает; чужой job сбросить нельзя.
8. RBAC: USER на admin-guarded endpoint → 403.
9. Удаление аккаунта: user-owned каскадится, знания целы, сессия невалидна.
10. Rate limit: N+1-й запрос auth в окно → 429 с `Retry-After`; после истечения окна счётчик стартует заново; **конкурентная серия** запросов не пробивает лимит (атомарность UPSERT); лимиты по IP и по telegram id независимы.
10b. **Lockout-защита:** серия запросов с невалидной подписью, но с чужим `provider_user_id` внутри, **не расходует** telegram-bucket этого пользователя (проверяется прямым чтением `auth_rate_limits`: строки `tg:<victim>` не появилось) — жертва после этого логинится штатно; при валидной подписи telegram-bucket применяется нормально и его исчерпание даёт 429.

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

**«Удалить аккаунт» — решено владельцем: остаётся в Фазе 2** (базовая функция Профиля; хороший момент проверить каскад удаления на реальном UI, раз backend-инварианты уже построены).

Добавлено четвёртое инженерное решение по итогам ревью: служебная таблица `auth_rate_limits` (§2.1) — сознательно предпочтена workaround'у ради лозунга «новых таблиц нет».

---

Оценка: 1.5–2 нед из плана фаз. Порядок: auth+sessions → CSRF/rate limit → API `/me` → shell+nav+adapter → i18n → onboarding → экраны → motion-полировка → тесты → e2e. Compatibility-check на реальных Telegram-клиентах (§3.2) — до public release, вне кодовой части фазы.

**Ожидает подтверждения владельца. После «подтверждаю» — реализация строго по этому документу.**
