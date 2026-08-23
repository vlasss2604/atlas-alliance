# Фаза 6, S10 — FREEZE. Live Provider Enablement + Internal Alpha Gate

> **Статус: ПРИНЯТО И ЗАМОРОЖЕНО владельцем, 2026-08-23.** Срез,
> подключающий РЕАЛЬНЫХ провайдеров (Brave Search, Anthropic
> QueryProposer, Anthropic EvidenceExtractor, native ContentFetcher) к
> замороженному движку S4→S5→S6→S7 за отдельным внутренним
> alpha-гейтом, с провабельной границей входа модели (D-090
> count-then-gate), попопыточным резервированием бюджета,
> capability-fatal каналом исполнения и аудитом фактической стоимости.
>
> **Канонический замороженный HEAD S10:**
> `20827c70255a53e6e5d3f6eee594819a3730406e`
>
> **Предшествующее замороженное состояние:** Stage 2 freeze `af7365b`
> (D-117); Stage 2 accepted runtime `8206a79`. Замороженная
> исследовательская семантика не переоткрывалась: S4 `d7e5b8a`,
> S5 `a657db3`, S6 `af23d8c`, S7 `9eccea7`.
>
> **Реализация:** `s10-live-provider-enablement.md` (D-118 + closure
> passes D-119, D-120, D-121).
>
> **Вердикт финального независимого ревью кода:**
> `ACCEPT WITH LIVE-SMOKE CONDITION`
> (BLOCKER 0 · HIGH 0 · MEDIUM 0 · LOW 1 принятый, не блокирующий).
>
> **Вердикт после ограниченного живого смоука:** `ACCEPT`.
>
> Это НЕ S8 и НЕ S9. Первый реальный исследовательский прогон (PUMP) НЕ
> выполнялся. `research_enabled` остаётся `false`.

---

## 1. Что заморожено

Замораживаются следующие принятые свойства S10. Любое их семантическое
изменение требует нового явного решения владельца и регрессионного
ревью.

**Живые провайдеры и их границы.** Четыре роли S4 (`SEARCH`, `FETCH`,
`QUERY_PROPOSE`, `EXTRACT`) резолвятся в реальные реализации только
через `createLiveS4WorkExecutor` (`live-executor.ts`) — единственную
функцию в кодовой базе, способную вернуть `WorkExecutor`, подключённый к
живым провайдерам. Она бросает `InternalAlphaGateClosedError`, если
`internal_alpha_enabled !== true`, и никогда не откатывается на
фикстуру.

**Двойной гейт.** Живое исполнение требует ОБОИХ условий:
`internal_alpha_enabled = true` (DB, `product_config`, default `false`)
И явного `alpha-run --mode=live`. `research_enabled` — отдельный
публичный/продуктовый гейт, остаётся `false` и S10 его не трогает.
`worker.ts` продолжает жёстко использовать `createNonLiveS4WorkExecutor`;
ни один HTTP-роут живого исполнителя не конструирует.

**Role-qualified cost-профили (D-090).** Каталог
`PRODUCTION_MODEL_COST_PROFILES` ключуется `${role}:${modelId}` и
содержит ровно две одобренные записи (`priceVersion "anthropic-2026-08"`):

| роль | модель | вход, micro-USD/ток. | выход, micro-USD/ток. | maxInputTokens | maxOutputTokens | резервация одного вызова |
|---|---|---|---|---|---|---|
| `QUERY_PROPOSER` | `claude-haiku-4-5` | 1 | 5 | 4 000 | 512 | 6 560 |
| `EVIDENCE_EXTRACTOR` | `claude-haiku-4-5` | 1 | 5 | 48 000 | 1 536 | 55 680 |

Любая другая пара (role, modelId) — `ModelCostProfileMissingError`,
fail-closed до любой резервации. Отката на профиль другой роли, на
дефолт или на живой прайсинг-эндпоинт не существует.

**COUNT-THEN-GATE (D-090).** Перед каждой генерацией строится ОДИН общий
`baseRequest = { model, system, messages, output_config }`, который
передаётся и в `messages.count_tokens`, и в `messages.create`.
Генерация добавляет только `max_tokens` (output-control). Превышение
`maxInputTokens` → `ModelInputOversizedError` и ноль генераций;
недоступность счётчика → `TokenCountUnavailableError` и ноль генераций.
Усечения документа и эвристических оценок токенов не существует.

**Попопыточное резервирование (BLOCKER-2, D-119).** Провайдерские
примитивы делают ровно ОДНУ внешнюю попытку каждый. Повтор принадлежит
`reserveAndCallWithRetry` (`s4-executor.ts`), который резервирует бюджет
ПЕРЕД каждой попыткой, включая повтор. Одна резервация никогда не
авторизует два реальных внешних вызова. Максимум — две попытки, и только
для транзиентного сбоя.

**Классификация транзиентности.** Один общий
`isTransientAnthropicApiError` (429, отсутствующий статус, 5xx) на все
три места вызова; 400/401/403/404/422 — постоянные. Brave: 429/5xx/сеть
транзиентны, 403/4xx и HTTP 200 с невалидным JSON — нет.
`maxRetries: 0` у клиента Anthropic — скрытых SDK-повторов нет.
`count_tokens` — вне оси `modelCostMicro` (не тарифицируется), со своим
внутренним повтором максимум один раз.

**Три терминальных исхода, которые не схлопываются.**

| причина остановки | терминальное состояние | `research_claim_support` |
|---|---|---|
| способность недоступна после разрешённых попыток, отсутствующий credential, отсутствующий role-профиль, непригодная конфигурация провайдера | `CapabilityFatalError` → `FAILED` / `SYSTEM_OR_PROVIDER_FAILURE` | НЕ создаётся |
| отказ авторитетной размерной резервации (`searchQueries`/`sourceOpens`/`modelCostMicro`) — в точке отказа, независимо от уже полученного частичного результата | `BudgetExhaustedError` → `BUDGET_LIMIT_REACHED` / `BUDGET_EXHAUSTED` / `errorCode = null` | НЕ создаётся |
| локальные/продолжаемые условия (нулевые кандидаты, один провал fetch, одна неудачная экстракция, превышающий потолок источник) | обычный результат попытки, движок продолжает | по обычному контракту |

Отказ бюджета и отказ способности — разные типы, разные ветки в
`worker.ts`, разные терминальные состояния. Частичный результат
(`candidateUrls.size > 0`, `fetchedDocs.length > 0`,
`insertedEvidenceIds.length > 0`) НИКОГДА не подавляет отказ резервации —
S4 не является арбитром достаточности. Уже вставленное валидное Evidence
остаётся персистированным.

**Preflight — структурная классификация (HIGH-2, D-121).**
`PreflightFailure.kind` — типизированное поле (`CAPABILITY_FATAL` |
`LOCAL`), диспетчеризация по нему, без разбора человекочитаемых строк.
Все шесть текущих исходов preflight — `CAPABILITY_FATAL`, с закрытыми
кодами `MODEL_COST_PROFILE_MISSING`, `SEARCH_GATEWAY_UNAVAILABLE`,
`CONTENT_FETCHER_UNAVAILABLE`, `QUERY_PROPOSER_UNAVAILABLE`,
`EVIDENCE_EXTRACTOR_UNAVAILABLE`. Отсутствующий `ANTHROPIC_API_KEY`
проверяется eagerly в резолверах (`query-proposer.ts`,
`evidence-extractor.ts`), зеркаля уже существовавшую eager-проверку
`BRAVE_SEARCH_API_KEY`.

**Аудит фактической стоимости.** `MODEL_CALL_ATTEMPTED` — ровно одна
audit-строка на реальную внешнюю попытку генерации, с попопыточным
`budgetAmount`. `QUERY_PROPOSED`/`EXTRACT_OK` usage не несут.
`SUM(actual_cost_micro)` по `MODEL_CALL_ATTEMPTED` — истинная стоимость.
Резервация остаётся ЕДИНСТВЕННЫМ авторитетом исполнения; фактическая
стоимость — только аудит, никогда не уменьшает счётчики.
Небиллируемая через одобренный профиль категория usage
(`cache_creation_input_tokens`/`cache_read_input_tokens`) →
`actual_cost_micro = null` + `UNSUPPORTED_BILLING_USAGE`, никогда
молчаливого занижения. `cache_control` в запросах S10 не используется.

**INTERNAL_ALPHA_V1** — неизменяемый код-конверт живого альфа-прогона:
`maxSearchQueries = 12`, `maxSourceOpens = 24`,
`maxModelCostMicro = 2 000 000`, `maxWallClockSec = 900`,
`reservedRecoverySteps = 1`. Не `budget_core`, не `budget_demo`.

**Граница данных внутренней альфы.**
`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS = { "pump_fun" }` — проверяется до
создания job. Фикстурный режим этой границей не связан.

**TRACE ≠ EVIDENCE.** Ни `BudgetExhaustedError`, ни
`CapabilityFatalError`, ни `MODEL_CALL_ATTEMPTED`/`MODEL_CALL_SKIPPED`,
ни `UNSUPPORTED_BILLING_USAGE` не имеют пути в Evidence/S5/S6/S7.
`research_trace_events` читают только `alpha-inspect`/`alpha-run`.

---

## 2. Ограниченный живой смоук провайдеров — ВЫПОЛНЕН, PASS

Условие приёмки, наложенное финальным ревью кода, закрыто. Смоук — это
capability-проба совместимости, а НЕ исследовательский прогон.

### 2.1 Фактические счётчики

| метрика | значение | авторизованный предел |
|---|---|---|
| запросов к Brave | **1** | 1 |
| вызовов Anthropic `count_tokens` | **3** | ≤ 3 |
| генераций Anthropic | **2** | 2 |
| повторов | **0** | — |
| вызовов `ContentFetcher` | **0** | 0 |
| созданных research job | **0** | 0 |
| исполнений S4/S5/S6/S7 | **0** | 0 |
| прогонов PUMP | **0** | 0 |
| фоновых агентов/субагентов | **0** | 0 |
| фактическая стоимость провайдеров | **$0.004056** | < $0.02 |
| расход `INTERNAL_ALPHA_V1` | **0** | 0 |

`git` чист после смоука; HEAD смоука остался `20827c7`; секреты не
раскрыты; неожиданного поведения провайдеров нет.

### 2.2 Brave Search

Один реальный запрос `"pump.fun protocol fee"`, `count=3`, HTTP 200,
3 результата, разобраны в кандидаты. Ни один URL результата не
открывался (`ContentFetcher = 0`). Повтора не было.

### 2.3 QueryProposer (`claude-haiku-4-5`)

| измерение | значение |
|---|---|
| `count_tokens` БЕЗ `output_config` | 207 |
| `count_tokens` С продакшн `output_config` | **457** |
| дельта схемы структурированного вывода | **+250** |
| `usage.input_tokens` генерации | **457** |
| `usage.output_tokens` генерации | 39 |
| `stop_reason` | `end_turn` |
| продакшн-схема структурированного вывода | валидна |
| фактическая стоимость | 457×1 + 39×5 = 652 micro = **$0.000652** |

**Точное равенство counted = generated подтверждено вживую: 457 = 457.**

### 2.4 EvidenceExtractor (`claude-haiku-4-5`)

Фиксированный локальный синтетический документ из 5 предложений.

| измерение | значение |
|---|---|
| `count_tokens` С продакшн `output_config` | **1159** |
| `usage.input_tokens` генерации | **1159** |
| `usage.output_tokens` генерации | 449 |
| `stop_reason` | `end_turn` |
| продакшн-схема структурированного вывода | валидна |
| извлечено traceable-фактов | 4 |
| фактическая стоимость | 1159×1 + 449×5 = 3404 micro = **$0.003404** |

**Точное равенство counted = generated подтверждено вживую: 1159 = 1159.**

### 2.5 Что живой смоук доказал

- Реальная совместимость с Brave Web Search: форма запроса, заголовок
  `X-Subscription-Token`, разбор `web.results[].url/title/description`.
- Реальная совместимость с `messages.count_tokens`, ВКЛЮЧАЯ приём
  `output_config` — параметра, отсутствие которого в подсчёте было
  дефектом HIGH-1 на HEAD `eac7b87`.
- **Дельта +250 токенов на схеме QueryProposer эмпирически
  подтверждает, что тот дефект был реальным и материальным:** до
  исправления гейт недосчитывал вход этой роли примерно на 55 %.
- Продакшн-схемы структурированного вывода обеих ролей принимаются
  моделью и возвращают валидный по схеме результат; `stop_reason` не
  `max_tokens` ни в одной роли.
- Одобренные ценовые допущения когерентны: обе роли уложились в
  `maxInputTokens`/`maxOutputTokens` (457 ≤ 4 000, 39 ≤ 512;
  1159 ≤ 48 000, 449 ≤ 1 536), фактическая стоимость посчитана теми же
  ценами профиля и оказалась много ниже авторизованных резерваций
  (652 против 6 560; 3 404 против 55 680) — резервация ведёт себя как
  потолок, а не как прогноз.
- Учётные данные обоих провайдеров реально проработали без утечки.

### 2.6 Раскрытое методологическое отклонение смоука

Смоук НЕ вызывал продакшн-хелпер `countThenGate()` напрямую. Причина:
`countThenGate()` сам выполняет вызов `count_tokens` и не возвращает
посчитанное значение, поэтому его использование в пробе потребовало бы
четвёртого вызова счётчика поверх двух измерительных и превысило бы
авторизованный максимум в ровно 3 вызова.

Вместо этого проба вызвала `client.messages.countTokens()` напрямую с
ИДЕНТИЧНЫМИ продакшн-формами запроса и применила ту же проверку
превышения входа инлайн. Сохранены точно: системные промпты, messages,
модель, `output_config`, Zod-схемы, эндпоинты, заголовки.

**Это отклонение принято ТОЛЬКО как ограниченная приёмочная проба и
НИКАК не изменяет продакшн-поведение рантайма.** Продакшн-путь
по-прежнему проходит через `countThenGate()`; смоук ничего в коде не
менял (HEAD остался `20827c7`, `git` чист).

Обоснование приемлемости: `countThenGate()` вызывает
`client.messages.countTokens({ model, system, messages, output_config })`
и ничего сверх этого к сетевому запросу не добавляет; клиент —
`new Anthropic({ apiKey, maxRetries: 0 })` без кастомных
эндпоинтов/заголовков. Всё, что хелпер добавляет поверх этого вызова —
обёртка одного повтора, обёртка типизированной ошибки и сравнение
`input_tokens > maxInputTokens` — детерминированная локальная логика,
полностью покрытая офлайн-тестами на этом же HEAD. Живым трафиком
доказуемо только то, что реальный эндпоинт принимает нашу точную форму
запроса и что его число совпадает с `usage.input_tokens` генерации —
именно это смоук и доказал.

---

## 3. Принятые не блокирующие остатки

- **LOW-1.** Порядковый номер попытки `count_tokens` (первая или повтор)
  не фиксируется отдельной строкой трейса. Недоступность после повтора
  всё равно видна как `CapabilityFatalError` на границе
  `MODEL_CALL_ATTEMPTED`. Принято как не блокирующее.

Ранее раскрытые LOW-B (дублирование `MODEL_CALL_SKIPPED` в двух секциях
вывода `alpha-inspect` — дублирование строк вывода, не данных) и LOW-C
(визуальное отличие fixture от live) закрыты: `alpha-inspect` теперь
печатает `providerName` в секции `MODEL CALLS`
(`non-live-fixture` против `anthropic`).

---

## 4. Регрессия на замороженном HEAD

Воспроизведено независимо на `20827c7`:

- `npx vitest run` → **766 passed, 4 skipped, 0 failed**
- `tsc --noEmit` → чисто
- `eslint` → чисто
- `next build` → успех, новых публичных маршрутов нет
- `drizzle-kit generate` → без дрейфа
- `npm run eval:memory` → не изменился (21 сценарий, recall 1,
  precision 1, negative safety 1, `false_reuse_rate = 0 (0/23)`,
  self-check PASS)
- `npx playwright test` → 7 passed, 1 skipped

Нулевой diff против замороженных baseline'ов: `controller.ts`,
`run-job.ts`, `component-reconciler`, `component-reconciliation-store`,
`mechanism-assembler`, `mechanism-assembly-store`, `claim-evaluator`,
`claim-support-store`, `src/server/memory/` (против `9eccea7`);
`content-fetcher`, `source-authority`, `budget-reservation` (против
`d7e5b8a`).

---

## 5. Что НЕ сделано и не входит в эту заморозку

- Первый реальный исследовательский прогон (PUMP) — **НЕ выполнялся**.
- `research_enabled` — не тронут, `false`.
- `internal_alpha_enabled` — остаётся default `false`.
- S8 (запись памяти из живых прогонов), S9 — не начаты.
- Proof Core, UI, Claim Normalization, billing — не начаты.
- Retention/TTL трейса — не реализованы (решение отложено с D-115).

**Любое будущее семантическое изменение живого провайдерского слоя,
терминального контракта S10 или конверта `INTERNAL_ALPHA_V1` требует
нового явного решения владельца и регрессионного ревью.** Это freeze
среза S10, а не freeze Фазы 6 целиком.
