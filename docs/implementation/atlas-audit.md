# ATLAS PROOF — Audit + Gap Report (Фаза 0)

Дата: 2026-08-20 · Ветка: `claude/f-bs4c5s` · Режим: read-only (код приложения не изменялся)

Источники аудита (в порядке приоритета): `docs/handoff/01_LOCKED_DECISIONS.md` → `canonical/…MASTER_TECHNICAL_LAYER_v3.md` → `…PRE_BETA_TECHNICAL_LAYER_v2.md` → `ATLAS_PRE_BETA_INTELLIGENCE_ARCHITECTURE.md` → `…TECHNICAL_BLUEPRINT_v1.md`, плюс 5 Skills. Все пять canonical-документов прочитаны полностью.

---

## 0. Состояние репозитория (факты)

Репозиторий `atlas-alliance` — чистая заготовка `create-next-app`:

| Параметр | Значение |
|---|---|
| Коммиты | 1 («Initial commit», `54c01e5`) |
| Стек | Next.js 16.2.12 (App Router), React 19.2.4, TypeScript 5, Tailwind CSS 4 |
| Код приложения | `app/page.tsx`, `app/layout.tsx`, `app/globals.css` — 154 строки стартового шаблона |
| Backend / БД / миграции / очереди | отсутствуют |
| Зависимости | только next, react, react-dom, tailwind, eslint, typescript — ни БД-клиента, ни очередей, ни AI SDK, ни Telegram-библиотек |
| Тесты | отсутствуют |

Проверка на legacy-артефакты (п. 5 задания): `grep -rniE "pump|hyperliquid|aave|ethena|pendle|uniswap|jupiter|morpho|aerodrome|entitlement|proof|research|stars|telegram|demo_project"` по `app/`, `public/` и конфигам — **0 совпадений**.

**Главный вывод аудита:** кода ATLAS не существует. Это greenfield. Ни один из 12 пунктов аудита не имеет «текущей архитектуры», которая могла бы противоречить спецификации. Migration gap по legacy roster = **N/A** (заменять нечего — старый список проектов нигде не зашит). Поэтому:

- Раздел A содержит только **пре-реализационные** блокеры — решения, которые нужно зафиксировать до Фазы 1, иначе фундамент придётся переписывать.
- Разделы B/C по каждому пункту описывают: требование спецификации → чем грозит наивная реализация → минимальное рекомендуемое решение → будущие модули.
- Отчёт по каждому пункту одновременно является каркасом проектного решения для фаз 1–13.

---

## A. BLOCKERS

### A1. Серверный stack не зафиксирован ни в одном документе

```
Текущее состояние: репозиторий задаёт только фронтенд-стек (Next.js 16 + TS + Tailwind).
                   Canonical фиксирует лишь: PostgreSQL достаточно; graph DB запрещена;
                   Redis «not required merely because queues exist» (v1 §6);
                   modular monolith + async research worker; SSE достаточно для прогресса.
→ Проблема:        без зафиксированного выбора БД-слоя, job-runner'а и границы backend
                   Фаза 1 («Домен + БД») не может начаться, а поздняя смена этих решений —
                   это переписывание фундамента.
→ Почему важно:    ResearchJob — персистентная сущность с серверным контрактом
                   «можете вернуться позже»; это требование живёт именно в этом слое.
→ Минимальное решение (рекомендация, требует утверждения вместе с этим отчётом):
                   • Backend — modular monolith внутри этого же репозитория:
                     Next.js Route Handlers для API + ОТДЕЛЬНЫЙ долгоживущий Node-процесс
                     research-worker (не serverless-функция: research длится минуты и
                     должен переживать закрытие Mini App).
                   • PostgreSQL + типизированный ORM с миграциями (Drizzle; Prisma допустим).
                   • Очередь — Postgres-backed (pg-boss или своя таблица jobs + SKIP LOCKED),
                     без Redis. Canonical это явно допускает.
                   • Прогресс — SSE с fallback на polling.
                   • Деньги/квоты — целочисленные единицы (security DoD Фазы 1).
→ Затронуто:       весь будущий src/server/*, инфраструктура деплоя.
```

### A2. Canonical-документы содержат удалённые фичи — прямая реализация «по канону» запрещена

```
Текущее состояние: canonical v1–v3 написаны в терминах FREE/START/PLUS/PRO, валюты Links
                   (ledger, holds), платного Deep Check (включая endpoint
                   POST /api/proofs/:id/deep-check), TON Connect/GRAM, 4-стадийного
                   прогресса и claim-first ввода.
→ Проблема:        01_LOCKED_DECISIONS всё это отменяет (DEMO/ARI_CORE, только Stars,
                   Links и Deep Check удалены полностью, 5 стадий, question-first).
                   Если при реализации брать структуры из canonical напрямую,
                   в код попадут удалённые фичи.
→ Почему важно:    Links-ledger и Deep Check — это целые подсистемы; случайно построить их
                   и потом выпиливать — худший сценарий переписывания.
→ Минимальное решение: зафиксировать таблицу соответствия (ниже) как обязательное чтение
                   перед каждой фазой. LOCKED_DECISIONS всегда побеждает.
→ Затронуто:       все фазы; особенно 4 (Interpreter), 8 (Experience), 11–12 (подписка/Stars).
```

Таблица соответствия терминов (canonical → v1-реализация):

| Canonical (legacy) | Реализуем как |
|---|---|
| FREE / START / PLUS / PRO | `DEMO` / `ARI_CORE` (PLUS/PRO — не реализуются, только точки расширения) |
| PUBLISHED_START / PUBLISHED_FREE_SHOWCASE | `ACTIVE_CORE` / конфигурируемый `demo_project_ids` |
| Links, ledger, holds, packages | НЕ реализуются. Механика hold→capture/release переносится ТОЛЬКО как reservation model DEMO-квоты (см. B10) |
| Deep Check, `/proofs/:id/deep-check` | НЕ реализуется. Внутренний targeted follow-up — механика Engine без UI и оплаты |
| TON Connect / GRAM / RUB | НЕ реализуются (ограничение платформы Telegram, не «отложено») |
| Статусы фильтра VALID_IN_SCOPE / CLARIFICATION_REQUIRED / OUT_OF_SCOPE / INVALID_NOISE | Статусы Interpreter `READY / NEEDS_CLARIFICATION / OUT_OF_SCOPE / INVALID` |
| 4 стадии прогресса | 5 стадий из LOCKED §9 |
| Вердикты v2/v3 (NOT_ENOUGH_EVIDENCE, MISSING_CONTEXT, CONFLICTING_EVIDENCE) | Вердикты LOCKED §7: `SUPPORTED / PARTIALLY_SUPPORTED / NOT_SUPPORTED / INSUFFICIENT_EVIDENCE / NOT_APPLICABLE` |
| Proof Map с узлами Risks/Contradictions | Ровно 3 узла: Evidence / Sources / Gaps |
| «Paste a claim» | Question-first: «Что вы хотите понять?» |

Что при этом **остаётся действующим** из canonical (не отменено): state machine job'а и её инварианты, schema-валидация structured output, модель данных §59 v3 (за вычетом links_*), бюджеты per job, initData-аутентификация, SSRF-правила, DB-констрейнты §60, gateway-абстракции, regression-механика, lifecycle памяти OBSERVED→CANDIDATE→ACTIVE.

Кодовых блокеров нет — кода нет.

---

## B. SHOULD FIX BEFORE PUBLIC V1

Формат каждого пункта: текущее состояние → проблема → почему важно → минимальное решение → затронутые модули. «Текущее состояние репозитория» везде одинаково — **отсутствует**, поэтому не повторяется.

### B1. Entitlement state model

```
→ Проблема:      наивная реализация («поле plan на user» или копия прав в подписку)
                 не выражает: expired/refunded CORE, lifetime DEMO-счётчик, read-only
                 доступ к истории, неретроактивность.
→ Почему важно:  ключевое правило продукта: entitlement решает, можно ли НАЧАТЬ новую
                 операцию; последующее изменение не уничтожает Proof и не обрывает job.
→ Минимальное решение:
    • users.lifetime_demo_proofs_used — счётчик на User (НЕ на плане, НЕ сбрасывается
      при смене плана: было 1/3 до CORE — после CORE останется 2).
    • subscriptions: PENDING/ACTIVE/CANCEL_AT_PERIOD_END/CANCELLED/EXPIRED/PAST_DUE
      (v3 §57) + refund-события.
    • Entitlement НЕ хранится как отдельная запись прав — он ВЫЧИСЛЯЕТСЯ:
      resolveEntitlement(user) → {level: DEMO|ARI_CORE, capabilityCeiling, quota}.
    • «Read-only после исчерпания/истечения» — не статус данных, а отсутствие права
      START_NEW_RESEARCH; история и Proof Map читаются по ownership (B6).
    • entitlement_at_start: ДА, снапшотить в ResearchJob при создании (требование
      LOCKED §4; в canonical снапшота не было — фиксируем расхождение в пользу LOCKED).
      Снапшот — плоские поля (level, capability, budget-профиль), не FK на подписку:
      job доводится до конца, даже если подписка истекла через минуту после старта.
→ Модули: src/server/domain/entitlement/*, таблицы users, subscriptions,
          research_jobs.entitlement_at_start_*.
```

### B2. Жизненный цикл Research Job

```
→ Проблема:      «кнопка → длинный API-запрос → ответ» нарушает серверный контракт
                 «можете вернуться позже — ARI продолжит работу».
→ Почему важно:  это продуктовое обещание в UI; также источник дублей дорогой работы.
→ Минимальное решение:
    • State machine v1: QUEUED / RUNNING / AWAITING_CLARIFICATION / SUCCEEDED /
      FAILED / CANCELLED / BUDGET_LIMIT_REACHED.
      Обоснование дополнительных состояний: AWAITING_CLARIFICATION — контракт
      Interpreter (макс. 2 уточнения); BUDGET_LIMIT_REACHED — честный терминал
      исчерпания бюджета (v3 §42/§46): сохранить Evidence и gaps, вернуть честный
      ограниченный вердикт, не FAILED и не сфабрикованная уверенность.
      17-состоянийную машину canonical НЕ строить: внутренние подэтапы — это поле
      progress_stage (5 UI-стадий) + research_job_transitions (журнал переходов).
    • Job живёт в PostgreSQL; исполняет отдельный worker-процесс; закрытие Mini App
      ни на что не влияет; повторное открытие → GET /research-jobs/:id + SSE.
    • Идемпотентность: клиентский idempotency_key на создании; ретраи воркера не
      создают второй Proof/Evidence/списание (unique-констрейнты, B10).
    • Восстановление после рестарта воркера: RUNNING-jobs подхватываются с последнего
      персистентного чекпоинта либо честно завершаются FAILED с освобождением
      резервации квоты. НЕ распределённая job-платформа — один worker + Postgres.
    • Жёсткий бюджетный потолок per job: max_search_queries, max_source_opens,
      max_model_cost, max_wall_clock_time, reserved_recovery_budget (v3 §46).
→ Модули: src/server/jobs/*, таблицы research_jobs, research_job_transitions.
```

### B3. Question Interpreter boundary

```
→ Проблема:      без жёсткой границы сырой пользовательский текст попадает в дорогой
                 Research Engine (или, хуже, в промпт как инструкции).
→ Почему важно:  единственная защита от мусорных трат бюджета и prompt-инъекций
                 на входе; UNDERSTANDING FAILURE должен быть отличим от RESEARCH FAILURE.
→ Минимальное решение:
    • Один лёгкий AI-вызов (дешёвая модель) со строгой схемой:
      {status, original_question, project_or_asset, topic, task_type, research_task,
       user_assumptions[], ambiguities[], clarification_question} — schema-валидация
      (zod) на сервере; невалидный output → 1 безопасный retry → INVALID.
    • Статусы: READY / NEEDS_CLARIFICATION / OUT_OF_SCOPE / INVALID.
      Инвариант: Engine не стартует при status !== READY. Падение Interpreter API
      НИКОГДА не приводит к отправке сырого ввода в Engine.
    • Максимум 2 попытки уточнения, затем фиксированное сообщение и закрытие flow
      (LOCKED §5; в canonical числового лимита не было — расхождение в пользу LOCKED).
    • user_assumptions сохраняются как допущения для проверки, не как факты.
    • Пользовательский текст в промпте — всегда данные (отдельный блок), никогда
      часть системных инструкций (security DoD Фазы 4).
    • Логируемая цепочка: Original Question → Interpreter Result → Normalized Task →
      Research Plan → Proof.
→ Модули: src/server/interpreter/*, таблица interpretations (или поля в research_jobs).
```

### B4. Scope vs Entitlement — раздельные понятия

```
→ Проблема:      слить их в один тип («доступен ли проект пользователю») — значит
                 не суметь выразить «Aave в scope ATLAS, но недоступен для DEMO».
→ Почему важно:  разные отказы = разные UX и разная монетизация (CORE_REQUIRED —
                 это upsell, OUT_OF_SCOPE — нет).
→ Минимальное решение: два независимых последовательных гейта с разными типами:
      ScopeDecision:       SUPPORTED / PARTIALLY_SUPPORTED / OUT_OF_SCOPE
      EntitlementDecision: ALLOWED / CORE_REQUIRED / QUOTA_EXHAUSTED
    Entitlement Gate проверяет ВСЕ сущности normalized research task (сравнение
    двух проектов — оба), не только основную. Заблокированный запрос НЕ списывает
    DEMO-квоту (B10). Оплата покупает доступ к работе, не «лучшую истину».
→ Модули: src/server/domain/scope/*, src/server/domain/entitlement/*.
```

### B5. Динамический project roster

```
→ Проблема:      наивная реализация копирует список проектов в подписку или зашивает
                 массив в код — CORE перестаёт быть «развивающимся интеллектом».
→ Почему важно:  LOCKED §3: новый ACTIVE_CORE-проект автоматически доступен всем
                 действующим подписчикам.
→ Минимальное решение:
    • projects.status: RESEARCHED_INTERNAL / CANDIDATE / ACTIVE_CORE / UNPUBLISHED /
      DEPRECATED (маппинг PUBLISHED_START→ACTIVE_CORE). Статус — данные, не код.
    • DEMO-доступ: demo_project_ids в product config (сейчас pump_fun, hyperliquid,
      uniswap) — конфигурируемо, не константа в компонентах.
    • Проверка доступа — join по статусу в момент запроса; НИКАКИХ копий списка
      в подписке.
    • Кэш ростера: короткий TTL + инвалидация по событию смены статуса проекта.
    • Публикация в ACTIVE_CORE — только через human approval (admin-действие).
    • Legacy roster из 10 проектов: в коде НЕ НАЙДЕН (grep, раздел 0). Тихая замена
      невозможна и не требуется — migration gap отсутствует.
→ Модули: src/server/domain/projects/*, таблицы projects, project_aliases;
          config/product.ts.
```

### B6. Proof ownership и privacy

```
→ Проблема:      без серверной проверки владения чужой Proof достаётся подбором ID;
                 share-фича может незаметно сделать Proof публичным.
→ Почему важно:  Proof приватен по умолчанию — это продуктовый закон; публичных
                 Proof URL в v1 нет.
→ Минимальное решение:
    • Цепочка владения: users → research_jobs → proofs → proof_evidence → evidence →
      sources (provenance-FK обязательны).
    • proofs: owner_user_id NOT NULL, visibility DEFAULT 'PRIVATE'. UUID как ID
      (несеквенциальные — подбор невозможен).
    • Каждый endpoint проверяет владение на сервере (owner → allow, admin → по роли,
      прочие → 404). Скрытая кнопка ≠ access control.
    • Share v1 = экспорт снапшота/изображения + системный Telegram share. Никаких
      публичных страниц; visibility в v1 вообще не имеет значения 'PUBLIC'.
    • Удаление пользователем своего Proof НЕ удаляет независимо верифицированную
      системную Research Memory (см. B7).
→ Модули: src/server/domain/proofs/*, authz-мидлвар; таблицы proofs, evidence, sources.
```

### B7. Data deletion architecture (future-safe минимум)

```
→ Проблема:      если user_id не проходит через все пользовательские таблицы, а
                 verified-знание держит ссылки на пользователей, удаление аккаунта
                 позже станет практически невозможным.
→ Почему важно:  полная compliance-подсистема сейчас не нужна, но модель данных
                 не должна её заблокировать; «Удалить аккаунт» уже заявлен в Профиле.
→ Минимальное решение:
    • Классификация с первого дня:
      user-owned (удаляются): users, sessions, research_jobs, interpretations,
      proofs+evidence-связки пользователя, платёжные записи (с учётом retention),
      onboarding-состояние, языковая настройка;
      system knowledge (остаётся): projects, sources, research_memory,
      research_patterns, verified lessons — при условии подлинной анонимизации.
    • Правило промоушена памяти: при переходе OBSERVED→CANDIDATE→ACTIVE запись
      теряет ссылку на пользователя (обезличивание на входе, а не при удалении).
    • Логи с пользовательскими вопросами — отдельный контур с retention-политикой;
      запрещено логировать initData-секреты, токены, платёжные секреты.
    • Платёжные записи: retention по требованиям учёта — документировать конфликт
      с полным удалением (удаление = анонимизация плательщика, не стирание проводок).
    • ON DELETE поведение задать осознанно в первых миграциях (cascade для user-owned,
      restrict для знаний) — это дешёво сейчас и дорого потом.
→ Модули: схема БД (Фаза 1), migration-конвенции, logger-конфигурация.
```

### B8. Telegram Stars isolation

```
→ Проблема:      захардкоженная цена «2 999 Stars» по UI и Stars-логика в домене
                 сделают смену цены/платёжки переписыванием Research Engine.
→ Почему важно:  цена — бизнес-гипотеза; платёжный слой должен быть заменяем.
→ Минимальное решение:
    • product config (таблица или типизированный конфиг): ari_core_price_stars=2999,
      period, demo_lifetime_limit=3, demo_project_ids. Все UI-поверхности читают
      отсюда. Snapshot цены/версии плана в момент покупки — в платёжной записи.
    • Интерфейс PaymentProvider; единственная реализация TelegramStarsProvider.
      Домен оперирует «подписка активирована/истекла/refunded», не Stars.
    • Поток: invoice XTR → pre-checkout валидация (order/user/amount/idempotency) →
      server-verified successful payment → сохранить telegram charge id → атомарная
      активация подписки. Backend НИКОГДА не доверяет payment_success с фронтенда.
    • Идемпотентность по (provider, charge_id) — двойной клик не активирует дважды.
→ Модули: src/server/payments/*, src/server/domain/subscription/*, config/product.ts.
          Реализация — Фазы 11–12; изоляция закладывается схемой в Фазе 1.
```

### B9. Source health vs Pattern regression

```
→ Проблема:      смешение двух механизмов даёт либо дорогие перезапуски Proof по
                 расписанию, либо непроверенные изменения методологии.
→ Почему важно:  «Knowledge/state evolves live. Core mechanics evolve by release».
→ Минимальное решение:
    • Source health check (дёшево, периодически): cron-задача воркера, HTTP-проверка
      URL источников (status/redirect/content-type), результат → пометка источника
      OK / BROKEN / CHANGED и связанных фактов REVERIFY/STALE. Без запуска research.
    • Pattern regression (дорого, по триггеру): прогон blind-кейсов (TAO, SUI, TIA,
      staking-safety, BTC passive holder, SOL valuation, TAO Moon + robustness-набор)
      после изменения методологии. Таблицы regression_cases/runs/case_results.
      Позже подключается hook'ом «CORE file changed» (Часть 5 02_ARCHITECTURE).
    • Здоровье источников НИКОГДА не меняет Pattern; регрессия НИКОГДА не запускается
      расписанием «на всякий случай».
→ Модули: src/server/health/*, src/server/regression/*; Фазы 10/10.5.
```

### B10. Concurrency / дублирующие действия / идемпотентность

```
→ Проблема:      двойное нажатие «Начать Proof», обновление Mini App, retry после
                 таймаута, второе устройство — каждый сценарий без защиты создаёт
                 дублирующую дорогую research-работу или двойное списание квоты.
→ Почему важно:  research — самая дорогая операция продукта; DEMO-квота lifetime=3.
→ Минимальное решение (v1):
    • Reservation model квоты (требование LOCKED §2): AVAILABLE → RESERVED (при
      создании job) → CONSUMED (при успешном Proof) / RELEASED (invalid claim,
      unsupported проект/тема, техническая ошибка, отмена). Квота не списывается
      при заблокированном или неуспешном запуске.
    • Dedupe активных job: unique partial index по (user_id, project_id,
      normalized_task_hash) WHERE state IN (QUEUED, RUNNING, AWAITING_CLARIFICATION);
      повторное создание возвращает существующий job (200, не ошибка).
    • Клиентский idempotency_key на POST /research-jobs (unique) — retry после
      таймаута получает тот же job.
    • Второе устройство читает то же серверное состояние — конфликтов нет by design.
    • max concurrent jobs per user (v1: 1 активный) + скромный rate limit.
→ Модули: src/server/jobs/create.ts, DB-констрейнты; сквозной через Фазы 1, 3.
```

### B11. Motion architecture vs Research state

```
→ Проблема:      завязка UI на блокирующий запрос («ждём API → разблокируем UI»)
                 запрещена спецификацией и ломает контракт persistent job.
→ Почему важно:  Mini App mobile-first; тайминги микровзаимодействий 100–180ms
                 несовместимы с ожиданием сети.
→ Минимальное решение:
    • Контракт API: POST /research-jobs отвечает немедленно (id + state=QUEUED);
      UI даёт мгновенный отклик и переходит в наблюдение (SSE /research-jobs/:id/
      events, fallback polling).
    • Прогресс — 5 реальных стадий с сервера (Понимаю задачу → Проверяю опыт →
      Ищу доказательства → Сопоставляю → Формирую Proof) + memoryStatus; показывать
      только реально происходящие стадии, без фиктивных пауз.
    • Unread/completion state — на сервере (индикатор на ARI-кнопке, новый Proof
      во вкладке «Исследования»); notification center не строится.
    • Язык RU/EN и onboarding-флаги — на backend, привязаны к ATLAS User ID,
      не localStorage; onboarding-endpoint идемпотентен.
→ Модули: app/* (клиент), src/server/api/research-jobs/*; Фазы 2–3.
```

### B12. ARI future evolution — точки расширения без активации

```
→ Проблема:      зашитые намертво «одна тема», «N проектов», «один Pattern»,
                 «провайдер AI в домене» потребуют переписывания при первом росте.
→ Почему важно:  CORE — развивающийся интеллект; расширение должно быть добавлением
                 строк, не рефакторингом.
→ Минимальное решение:
    • topics — таблица; активна одна запись (token_value_capture), активация новых —
      только вручную. Никакого autonomous topic discovery.
    • research_patterns — версионируемая сущность per topic; переход v1→v2 —
      полностью ручной, на основе ResearchExperienceRecord.
    • Engine project-agnostic: никаких if (token === 'BTC') — выводы деривируются
      actor → mechanism → source → path → outcome; 10 BETA traces — regression
      evidence, не lookup table.
    • AI abstraction layer: интерфейсы ModelGateway / SearchGateway / ContentFetcher
      (+ ChainDataGateway позже); провайдер-специфика — только в реализациях;
      накопленный интеллект — в ATLAS-owned таблицах, не у провайдера.
    • Будущие концепты — enum'ы/неактивные сущности (FUTURE_TOPIC_SIGNAL и т.п.),
      не активное поведение.
→ Модули: src/server/gateways/*, схема topics/research_patterns; сквозной принцип.
```

---

## C. SAFE TO DEFER (сознательно откладываем)

| Что | Почему безопасно отложить |
|---|---|
| ARI Self-Learning Loop (ArISelfReview, PatternCandidate, shadow validation, IntelligenceRelease) | Решение владельца: тренировать не на чем до BETA. Строим только `ResearchExperienceRecord` (Фаза 8) — чистая observability |
| Business Review Panel | До появления реальных пользователей |
| Telegram Bot уведомление о завершении research | Unread-state уже серверный (B11) — бот добавится без изменения архитектуры |
| Кнопка «Перевести» для фрагментов Evidence | Локализация Evidence уже разделена по слоям (интерфейс локализуется, источники в оригинале) |
| Web-клиент вне Telegram | Достаточно не зашивать window.Telegram в ядро фронтенда (адаптер платформы) |
| Anti-abuse / device fingerprinting против мульти-аккаунтов | Принятый риск (LOCKED §12); решать на данных, если станет экономической проблемой |
| Полная compliance-подсистема удаления данных | B7 закладывает future-safe модель; сам flow удаления — минимальный |
| Мульти-топики, team-планы, PLUS/PRO | Только точки расширения (B12), нулевая активная логика |
| Graph DB, мультиагентная оркестрация, user-selected модели | Запрещено спецификацией («НЕ реализовывать») |
| Admin сверх минимума (issues, ручные правки, append-only аудит-лог) | Фаза 9 — минимальный объём |

---

## RECOMMENDED IMPLEMENTATION ORDER

Порядок фаз из `02_ARCHITECTURE_AND_PHASES.md` подтверждается; greenfield-корректировки минимальны. Каждая фаза включает свой security-пункт (Часть 4) как Definition of Done.

| № | Фаза | Ключевые решения из этого отчёта |
|---|---|---|
| 1 | Домен + БД | A1 (stack), B1 (entitlement-модель, lifetime-счётчик), B5 (статусы проектов), B6 (ownership-цепочка), B7 (deletion-safe схема, ON DELETE), B8 (product config, изоляция платежей в схеме), B12 (topics/patterns/gateways) |
| 2 | Telegram identity + shell + onboarding + Motion | initData строго на сервере; язык/onboarding на User; B11 (async-контракт UI) |
| 3 | Job-инфраструктура | B2 (state machine, worker, SSE), B10 (reservation model, dedupe, idempotency_key) |
| 4 | Interpreter + Scope/Entitlement Gate | B3 (граница, 2 уточнения, schema), B4 (раздельные гейты) |
| 5 | Research Memory + Planner + 5 checks | lifecycle OBSERVED→CANDIDATE→ACTIVE не обходится никогда; retrieval-first |
| 6 | Research Engine + Evidence + Recovery | единый Engine для DEMO/CORE; SSRF-защита именно здесь; бюджеты per job |
| 7 | Proof + layered output + Privacy | 7 слоёв, вердикты LOCKED §7, «Что может изменить вывод» обязателен; B6 server-side authz |
| 8 | Research Experience Record | только запись, без авто-анализа |
| 9 | Admin v1 | append-only аудит-лог |
| 10 | Regression + Source Health | B9 (два раздельных механизма); blind-кейсы TAO/SUI/TIA + robustness |
| 10.5 | Proof Map (3 узла) + Access Control | проекция Proof Core, счётчики точно соответствуют данным |
| 11 | SubscriptionService | B1 (lifecycle, refund, неретроактивность) |
| 12 | Telegram Stars | B8 (server-verified, идемпотентность по charge id) |
| 13 | Hardening | rate limiting, бэкапы + restore-тест, emergency-флаги, запретный список логирования |

Затем — Closed Validation Phase (owner-only флаг, ~75 ситуаций) по 02_ARCHITECTURE Часть 3.

---

## ВЕРДИКТ

**READY FOR IMPLEMENTATION** — с двумя условиями, закрываемыми утверждением этого отчёта:

1. **A1**: утвердить рекомендованный серверный stack (Next.js Route Handlers + отдельный worker-процесс, PostgreSQL + Drizzle, Postgres-backed очередь без Redis, SSE).
2. **A2**: принять таблицу соответствия legacy-терминов; при любом расхождении canonical ↔ LOCKED_DECISIONS побеждает LOCKED_DECISIONS; фичи из списка «НЕ реализовывать» не строятся даже при наличии их спецификации в canonical.

Кодовых блокеров нет: репозиторий пуст, конфликтующей архитектуры не существует, migration gap по legacy roster отсутствует. STRATEGY REVIEW REQUIRED не требуется — противоречий с зафиксированной концепцией не обнаружено.

Следующий шаг после утверждения: Фаза 1 «Домен + БД» (детальный план фазы — отдельным документом `docs/implementation/phase-1-plan.md` перед началом кода).
