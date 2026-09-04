# Фаза 3 — Job-инфраструктура: SSE-прогресс, cancel, запуск исследования. План

Статус: **утверждён владельцем 2026-08-20.** Зафиксированный принцип реализации: **PostgreSQL — единственный source of truth состояния research job; SSE — транспорт уведомлений о прогрессе.** Reconnect всегда восстанавливает актуальную картину из БД и не зависит от доставки всех SSE-событий.

Основания: `phase-1-plan.md` (state machine, reservation model, pg-boss — уже построены), `01_LOCKED_DECISIONS.md` §5–6, §9, `PRODUCT_QUALITY_DIRECTIVE.md` (§2 Invisible Complexity, §5 Immediate Feedback, §7 Simple Language), canonical v3 §42/§61–63.

Цель фазы словами директивы: **«нажал → мгновенная реакция → Atlas работает → состояние не теряется → результат приходит плавно»**. Фаза 1 построила скелет job'а; Фаза 3 делает его живым и наблюдаемым.

---

## 1. Объём фазы

**Делаем:** серверный endpoint запуска исследования (полный конвейер прав), SSE-поток прогресса поверх Postgres LISTEN/NOTIFY, cancel-API, живое обновление вкладки «Исследования», presentation-слой человеческих состояний (copy — на утверждение), закрытие гонок cancel/worker.

**Не делаем:** Question Interpreter (Фаза 4 — калитка запуска для пользователей остаётся закрытой), Research Engine (5–6), Proof-экраны (7). Worker-хендлер остаётся честным `NOT_IMPLEMENTED` — стадии прогресса начнёт двигать настоящий pipeline, не имитация (директива §5: no fake progress).

## 2. Запуск исследования — POST /api/research-jobs

Серверный конвейер (канон skill: `request → user → entitlement → project scope → topic scope → capability → execute`):

```
session + CSRF + Origin (общее правило §3.1 Фазы 2)
→ product_config.research_enabled == true          иначе 403 RESEARCH_DISABLED
→ interpretation обязателен и status == READY       иначе 409 INTERPRETATION_REQUIRED
→ resolveEntitlement(user)
→ scope: тема активна; проект существует и ACTIVE_CORE
→ entitlement gate: DEMO → проект в demo_project_slugs, иначе 403 CORE_REQUIRED
→ createResearchJob(...)  ← примитив Фазы 1: FOR UPDATE, квота
   RESERVED+CONSUMED, dedupe, one-active, транзакционный enqueue
→ 201 { job }  |  409 ACTIVE_JOB_EXISTS  |  403 DEMO_QUOTA_EXHAUSTED
```

Ключевые решения:
- **`research_enabled` (новый ключ product_config, default `false`).** LOCKED §5: «Research Engine не стартует, если interpreter.status !== READY» — Interpreter появится в Фазе 4, поэтому калитка для пользователей закрыта конфигом, UI остаётся в честном disabled. Endpoint при этом строится и тестируется полностью уже сейчас: тесты создают READY-interpretation прямой вставкой в БД (тестовый путь, не прод).
- Отказ ЛЮБОГО гейта не трогает квоту — admission происходит внутри `createResearchJob` после всех проверок (инвариант Фазы 1 сохраняется).
- `entitlement_at_start` снапшотится как в Фазе 1; `interpretation.research_job_id` проставляется после создания job (цепочка Original Question → Interpretation → Job).

## 3. SSE-прогресс — GET /api/research-jobs/:id/events

Механика (canonical v3 §63: «SSE достаточно для one-way прогресса»):

- **Миграция 0003:** в существующий AFTER UPDATE-триггер журнала добавляется `pg_notify('research_job_events', json_build_object('job_id', NEW.id, 'user_id', NEW.user_id))`. Доменные таблицы не меняются; событие несёт только идентификаторы — данные читаются запросом (никакой полезной нагрузки в канале).
- Route handler: проверка сессии + ownership (чужой job → 404) → `ReadableStream`:
  1) сразу отдаёт текущее состояние (подключение после перезахода восстанавливает картину — persistent job контракт);
  2) выделенный pg-клиент `LISTEN research_job_events`, фильтр по job_id → на каждое уведомление перечитывает job и шлёт событие;
  3) heartbeat-комментарий каждые 15с (proxy-таймауты);
  4) при терминальном состоянии — финальное событие и закрытие потока.
- **Формат события — только presentation-безопасные поля** (директива §2): `{state, progressStage, memoryStatus, unread, finishedAt}`. Бюджеты, error-детали, внутренние счётчики наружу не выходят.
- Лимит: не более 2 одновременных SSE-подключений на пользователя (счётчик в памяти процесса; третье закрывает самое старое). Fallback остаётся прежним — polling `GET /api/research-jobs`.

## 4. Cancel — POST /api/research-jobs/:id/cancel

- Требует session + CSRF + Origin + ownership.
- `QUEUED | RUNNING | AWAITING_CLARIFICATION → CANCELLED` (граф Фазы 1 это разрешает) + `RELEASED` для DEMO-резервации — в одной транзакции.
- Идемпотентность: повторный cancel уже `CANCELLED` job → `200 {already: true}`; другой терминал (`SUCCEEDED` и пр.) → `409 ALREADY_FINISHED`.
- Гонка cancel против worker: разруливается state machine БД — если worker уже перевёл в RUNNING, cancel из RUNNING валиден; если job успел завершиться, cancel получает 409. Worker при взятии задачи уже проверяет `state == QUEUED` (Фаза 1) — отменённый QUEUED-job не исполняется. Ретрай воркера после cancel не воскресит job: переход из CANCELLED запрещён триггером.

## 5. Живая вкладка «Исследования» + клиентский хук

- `useJobEvents(jobId)`: EventSource с авто-reconnect (expo backoff), деградация в polling при недоступности SSE. Хук — тонкий, без библиотек.
- Вкладка «Исследования»: активные job подписываются на события — стадия обновляется без перезагрузки; терминал → карточка перерисовывается, unread-точка на ARI-кнопке появляется через существующий `refresh()`.
- Ask-экран не меняется (submit включит Фаза 4).

## 6. Presentation-слой состояний — copy НА УТВЕРЖДЕНИЕ (директива §7)

Внутренние состояния наружу не выходят; отображение строится из state+progressStage. 5 стадий прогресса уже утверждены (LOCKED §9) и остаются как есть. Требуют утверждения формулировки для состояний вне прогресса:

| Внутреннее | RU (предлагаю) | EN (предлагаю) |
|---|---|---|
| QUEUED | «Atlas принимает задачу» | "Atlas is picking this up" |
| AWAITING_CLARIFICATION | «Нужно уточнение» | "Needs a clarification" |
| SUCCEEDED | «Proof готов» | "Proof is ready" |
| CANCELLED | «Остановлено вами» | "Stopped by you" |
| FAILED | «Не получилось завершить исследование. Попытка не потрачена» | "Couldn't finish this research. Your attempt wasn't spent" |
| BUDGET_LIMIT_REACHED | «Исследование дошло до предела бюджета — показываю честный результат» | "Research hit its budget limit — showing an honest result" |

(FAILED-формулировка верна контракту: резервация всегда RELEASED при техническом сбое. BUDGET_LIMIT_REACHED появится у пользователей только с Фазой 6–7 — формулировку можно перенести на ревью Proof-экрана.)

## 7. БД и переиспользование

Доменная схема **не меняется**. Миграция `0003` — только `pg_notify` в существующем триггере журнала. Переиспользуются: state machine + триггеры, reservation model, `createResearchJob`/`transitionJobState`/`resolveDemoReservation`, `resolveEntitlement`, guards Фазы 2, pg-boss.

## 8. Security considerations

1. SSE: ownership до открытия потока; в событиях нет внутренних полей; heartbeat + серверное закрытие; лимит подключений на пользователя.
2. Cancel/создание — общее правило session+CSRF+Origin (исключений не добавляется; список bootstrap-исключений Фазы 2 не расширяется).
3. Отказы гейтов не расходуют квоту; сообщения отказов не раскрывают чужие данные (несуществующий/чужой job — всегда 404).
4. LISTEN-клиент — отдельное подключение с авто-восстановлением; его падение деградирует в poll, не роняет API.
5. `research_enabled` читается из product_config на каждый запуск (кэш 60с) — аварийное отключение исследований без деплоя (предтеча emergency-флагов Фазы 13).

## 9. Definition of Done — тесты

Интеграционные (продолжение сьюта):
1. Создание: полный конвейер → 201; job+reservation+pgboss-задача; interpretation связывается с job.
2. `research_enabled=false` → 403, квота не тронута; без READY-interpretation → 409.
3. Scope/entitlement-гейты: неактивная тема → отказ; проект не ACTIVE_CORE → отказ; DEMO на не-demo проект → CORE_REQUIRED; всё — без расхода квоты.
4. Повторный POST с тем же idempotency_key → тот же job (200); второй активный job → 409 ACTIVE_JOB_EXISTS.
5. NOTIFY: сырой pg-клиент ловит `research_job_events` при UPDATE state.
6. SSE: подключение отдаёт текущее состояние; переход QUEUED→RUNNING доставляется в поток; терминал закрывает поток; чужой job → 404.
7. Cancel: QUEUED → CANCELLED+RELEASED (одна транзакция); повторный → 200 idempotent; SUCCEEDED → 409; чужой → 404.
8. Гонка cancel vs worker: инварианты state machine выдерживают оба порядка; отменённый job не исполняется.
9. Лимит SSE-подключений: третье подключение вытесняет старейшее.
10. Регресс: все 27 тестов Фаз 1–2 зелёные.

E2E:
11. Тестовый job виден в «Исследованиях» со стадией; смена стадии приходит без перезагрузки; после SUCCEEDED появляется unread-индикатор на ARI-кнопке.

Сборка: `next build`, `tsc`, `eslint` чистые.

**Adversarial review (новый шаг процесса, `docs/DEVELOPMENT_WORKFLOW.md`, впервые применяется к этой фазе):** после прохождения всех проверок — независимый reviewer со свежим контекстом (получает только план, LOCKED, директиву качества и дифф фазы; мандат — correctness/security/concurrency/инварианты/соответствие плану, каждая находка с severity и конкретным сценарием отказа). Разбор находок accepted/rejected с обоснованиями входит в финальный отчёт фазы.

## 10. STRATEGY REVIEW REQUIRED

Не обнаружено. Открытый пункт на утверждение владельцем (не блокирует старт кода, блокирует только финальный copy): таблица формулировок §6.

---

Оценка: ~1 нед (по плану фаз). Порядок: миграция 0003 + NOTIFY-тест → create-endpoint + гейты → cancel → SSE-сервер → клиентский хук + «Исследования» → e2e → регресс.

**Ожидает подтверждения владельца.**
