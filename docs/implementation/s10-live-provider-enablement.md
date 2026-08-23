# S10 — Live Provider Enablement + Internal Alpha Gate

> **Статус: РЕАЛИЗОВАНО, ожидает ревью владельца.** Продолжает Stage 2
> (D-115/D-116/D-117, `pipeline-integration-stage2.md`/`-freeze.md`) —
> не переоткрывает его. Это финальный технический мост перед FIRST REAL
> ATLAS RUN — сам первый живой прогон этим срезом НЕ выполняется.
>
> D-118 фиксирует существование и границы этого среза. S10 не заморожен
> этим документом.

---

## 1. Цель

Подключить четыре живых провайдера (Brave SearchGateway, native
ContentFetcher, Anthropic QueryProposer, Anthropic EvidenceExtractor,
оба на `claude-haiku-4-5`) под жёстким internal-alpha гейтом — не
меняя исследовательскую семантику S4/S5/S6/S7 и не открывая
публичный/продуктовый путь.

---

## 2. Живые провайдеры (принято владельцем)

```
SEARCH:              существующий Brave SearchGateway
FETCH:                существующий native ContentFetcher (не тронут)
QUERY_PROPOSER:       существующий Anthropic QueryProposer, claude-haiku-4-5
EVIDENCE_EXTRACTOR:   существующий Anthropic EvidenceExtractor, claude-haiku-4-5
```

Никакого нового провайдера, browser automation, или fallback-
избыточности не добавлено. Статические HTML/text-ограничения
ContentFetcher — принятое ограничение internal alpha, видимое в трейсе
(`FETCH_FAILED`/`FETCH_OK`), не исправляется здесь.

---

## 3. Роль-квалифицированные cost-профили (D-118, owner correction §3)

**Проблема**: каталог `PRODUCTION_MODEL_COST_PROFILES`
(`model-cost-profile.ts`) был ключован только по `modelId`.
QUERY_PROPOSER и EVIDENCE_EXTRACTOR оба используют
`claude-haiku-4-5`, но требуют РАЗНЫХ жёстких потолков (4000/512 vs
48000/1536 токенов) — один ключ не может держать два профиля.

**Исправлено**: ключ каталога теперь `${role}:${modelId}`
(`ModelRole = "QUERY_PROPOSER" | "EVIDENCE_EXTRACTOR"`).
`loadModelCostProfile(role, modelId)` — новая сигнатура. Отсутствие
ТОЧНОЙ пары (role, model) — fail closed (`ModelCostProfileMissingError`)
ДО любой резервации или вызова. API model ID, отправляемый Anthropic,
остаётся голым `modelId` (`profile.modelId`) — роль-квалифицированный
ключ каталога никогда не покидает `model-cost-profile.ts`.

Утверждённые профили (`priceVersion = "anthropic-2026-08"`,
$1/$5 за 1M токенов вход/выход):

| role | modelId | maxInputTokens | maxOutputTokens |
|---|---|---|---|
| QUERY_PROPOSER | claude-haiku-4-5 | 4 000 | 512 |
| EVIDENCE_EXTRACTOR | claude-haiku-4-5 | 48 000 | 1 536 |

Ни одна другая (role, model) пара не резолвится — включая ОБРАТНУЮ
роль для той же `claude-haiku-4-5` (`QUERY_PROPOSER` не получает
профиль `EVIDENCE_EXTRACTOR`, и наоборот).

---

## 4. D-090 — доказуемый потолок входа модели (COUNT-THEN-GATE)

**Принципиальный live-блокер до этого среза**: EvidenceExtractor мог
отправить весь `normalizedText` без доказуемого потолка токенов.

**Реализовано** (`providers/token-gate.ts`), для ОБОИХ ролей:

```
построить ТОЧНЫЙ request shape (system + messages)
  → count_tokens (провайдерский точный счётчик, не эвристика)
  → сравнить с ROLE-SPECIFIC утверждённым maxInputTokens
  → только если в пределах — резервировать/выполнить generation
```

`input_tokens > maxInputTokens` → `ModelInputOversizedError` —
generation НЕ вызывается, документ НЕ усекается. `count_tokens`
недоступен → `TokenCountUnavailableError` — Atlas никогда не
переходит к generation без успешного точного счёта. Оба — закрытые,
непроглатываемые типы; НИКОГДА не проглатываются в
`INSUFFICIENT_EVIDENCE`.

Классифицированы в закрытый `trace_reason_code`
(`MODEL_INPUT_OVERSIZED`/`TOKEN_COUNT_UNAVAILABLE`, не generic
`PROVIDER_ERROR`) — `EXTRACT_FAILED` уже несёт reasonCode параметрично
(было хардкожено `PROVIDER_ERROR`); для QueryProposer (у которого не
было pre-call trace-события) добавлен новый закрытый operation_type
`MODEL_CALL_SKIPPED`. `alpha-inspect` теперь может ответить: «модель
не вызвана из-за превышения потолка, или потому что сам счёт не
удался» — не одна неразличимая корзина.

QueryProposer НЕ получил структурного «доказуемого потолка без
count-then-gate» исключения — вход этой роли короткий, но состоит из
БД-строк (project name/slug), а доказательство «эти БД-строки всегда
< 4000 токенов» было бы ровно той непроверяемой эвристикой, которую
D-090 запрещает. Count-then-gate применён единообразно к обеим ролям.

---

## 5. INTERNAL_ALPHA_V1 (LOCKED)

Один неизменный envelope (`config/product.ts`), НЕ Quick/Standard/Deep:

```
maxSearchQueries:      12
maxSourceOpens:        24
maxModelCostMicro:     2 000 000
maxWallClockSec:       900
reservedRecoverySteps: 1
```

Код-константа (как `model-cost-profile.ts`'s каталог), не строка
`product_config` — намеренно: «не пытайтесь довести эти числа до
совершенства — пересмотр после ~10–20 живых прогонов» — плановый
будущий код-ревью, не runtime-настройка. Существующие счётчики
резервации (`research_jobs.*Reserved`) остаются авторитетным execution
ceiling — без изменений.

---

## 6. Реальное использование модели / стоимость — AUDIT ONLY

`research_trace_events` получил 3 новых nullable-колонки (миграция
`0021`): `actual_input_tokens`, `actual_output_tokens`,
`actual_cost_micro`. Заполняются ТОЛЬКО для реального успешного
модельного вызова (через `onUsage` callback, прокинутый из
`s4-executor.ts`'s `preflight()` в `resolveQueryProposer`/
`resolveEvidenceExtractor` → `createAnthropicX`) — `null` для
non-live/fixture/провалившегося вызова, никогда сфабрикованный 0.
Стоимость считается ТЕМ ЖЕ утверждённым профилем, что резервацию
(`calculateActualCostMicro`, model-cost-profile.ts) — никогда
динамический pricing lookup.

**AUDIT ONLY, не вторая бюджетная инстанция**: резервации НЕ
возвращаются, счётчики `research_jobs.*Reserved` НЕ декрементируются
по фактическому usage — явное решение владельца. `alpha-run`/
`alpha-inspect` теперь печатают три отдельных числа: `reserved` /
`actual` / `limit` — никогда не смешиваются.

Prompt caching текущими провайдерами не используется — это явное
допущение, не проверяется здесь; если провайдерская форма usage
когда-либо введёт billable cache-категорию, которую утверждённый
профиль не может безопасно оценить, код обязан явно отказать/
сообщить, а не занизить фактическую стоимость (в объём этого среза не
входит — провайдеры сегодня не возвращают cache-токены).

---

## 7. Retry policy (LOCKED, providers/retry.ts)

Один переиспользуемый `retryOnceIfTransient` — ровно 1 retry, 2
итоговых внешних попытки максимум, ТОЛЬКО когда провайдерская
типизированная ошибка несёт `.transient === true` (429/5xx/сетевой
сбой — существующая классификация в `search-gateway-brave.ts`/
`query-proposer-anthropic.ts`/`evidence-extractor-anthropic.ts` не
изменена, только теперь реально используется для retry, а не только
для маркировки). Никогда не повторяет: schema-invalid output,
max_tokens truncation, детерминированный 4xx.

```
SEARCH:            1 retry (2 попытки)
FETCH:              0 retries — не тронут, ContentFetcher принят как есть
MODEL GENERATION:  1 retry (2 попытки) — обе роли
COUNT_TOKENS:      тот же 1-retry helper, никогда не переходит к
                    generation без успешного точного счёта
```

Бюджет: retry ТОЙ ЖЕ логической внешней операции (тот же query/тот же
документ) не резервирует второй раз — резервация уже размерена как
верхняя граница ОДНОГО вызова этой роли (`calculateMaxAuthorizedCostMicro`),
и повтор остаётся тем же вызовом, ретраенным на транзиентный сбой —
не второй операцией. Явно раскрытая архитектурная трактовка, не
скрытая.

---

## 8. Failure semantics (расширение Stage 1 контракта)

Терминальный контракт Stage 1 (`job.state` ≠ `termination_reason` ≠
`error_code` ≠ `research_claim_support.status`) сохранён без изменений.

**LOCAL/CONTINUABLE** (уже покрыто существующей S4-логикой, не
тронуто): нуль кандидатов, один провал fetch, часть fetch провалилась
при доступных других маршрутах, провал извлечения для одного
источника.

**CAPABILITY FATAL** → `FAILED` + `SYSTEM_OR_PROVIDER_FAILURE` + БЕЗ
сфабрикованной `research_claim_support`: SearchGateway недоступен
после утверждённого retry, провайдер модели недоступен после retry,
`count_tokens` недоступен когда требуется для безопасного вызова,
устойчивый rate limit, отсутствующий credential, отсутствующий
role-specific cost-профиль, невалидная конфигурация live-провайдера.
Ни один из этих случаев не превращается в `INSUFFICIENT_EVIDENCE`.

`BUDGET_EXHAUSTED` остаётся `BUDGET_LIMIT_REACHED`, законно
сосуществует с доказательным `INSUFFICIENT_EVIDENCE`, если S7 уже
отработал под этим execution contract — без изменений.

---

## 9. Internal Alpha Gate (LOCKED)

```
research_enabled       — НЕ ТРОНУТ, false, публичный/продуктовый гейт
internal_alpha_enabled — НОВЫЙ, отдельный DB-гейт (product_config),
                          default false (миграция 0021 сеет строку)
```

Конструирование live-исполнителя требует ОБОИХ:

```
internal_alpha_enabled = true
  И
явный owner/admin вызов: alpha-run --mode=live
```

`createLiveS4WorkExecutor` (`live-executor.ts`) — ЕДИНСТВЕННАЯ функция
в кодовой базе, способная вернуть `WorkExecutor`, подключённый к
реальным Brave/native-fetch/Anthropic провайдерам. Бросает
`InternalAlphaGateClosedError`, если `internalAlphaEnabled=false` —
никогда молча не откатывается на fixture. Ни `worker.ts`, ни
`research-jobs.ts`, ни один HTTP-роут её не импортируют — только
`scripts/alpha-run.ts`'s явный `--mode=live` путь (подтверждено
статическим тестом, §12 ниже).

Отсутствующий internal-alpha гейт → FAIL CLOSED — подтверждено
модульным тестом и ручным smoke (`alpha-run --mode=live` без
`internal_alpha_enabled=true`/credentials печатает точный список
недостающих предпосылок и завершается ДО создания job).

---

## 10. `alpha-run` режимы (LOCKED, §11 задания)

Явный `--mode=fixture|live` — НЕТ default, НЕТ отката в любую сторону.

`fixture` — принятая non-live trace-фикстура Stage 2, без изменений.

`live` — до создания job проверяет (fail closed на первой
недостающей предпосылке, печатая ВСЕ найденные проблемы разом, не
одну за раз):

```
internal_alpha_enabled
BRAVE_SEARCH_API_KEY
ANTHROPIC_API_KEY
утверждённый профиль QUERY_PROPOSER
утверждённый профиль EVIDENCE_EXTRACTOR
```

Печатает баннер ПЕРЕД созданием live job (режим, реальный
интернет=YES, реальная стоимость=YES, провайдеры, model ID, версия
cost-профиля, полный envelope INTERNAL_ALPHA_V1). По завершении
печатает: mode, providers, reserved/actual/limit model cost, job
state, termination reason.

**Internal Alpha Data Boundary (§12 задания, owner: YES)**: live-режим
может нацелиться ТОЛЬКО на явно утверждённый project slug
(`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`, `live-executor.ts` —
единственный элемент сейчас: `pump_fun`, §18 owner-approved первая
живая цель). Произвольный/неутверждённый slug отклоняется ДО создания
job, interpretation, или резервации. Не редизайн хранения проектов,
не RBAC — один код-константный `Set`, та же дисциплина, что у
`source-authority.ts`'s доменных списков.

Interpreter-классификация использует ТОТ ЖЕ non-live `fake` gateway в
ОБОИХ режимах — Interpreter не входит в утверждённый набор из 4 живых
провайдеров (§2), продвижение его в live — вне объёма этого среза.

---

## 11. Pre-live URL credential hardening (Stage 2 LOW-2 → обязательное)

Расширенный закрытый список credential-подобных query-параметров
(`trace-store.ts`'s `redactUrl`):

```
Было (Stage 2):  api_key, apikey, key, token, access_token,
                  auth, authorization, signature, sig, secret
Добавлено (S10): auth_token, refresh_token, client_secret,
                  password, session
```

Плюс НОВОЕ: userinfo-редактирование (`https://user:pass@host/...` →
`https://[REDACTED]@host/...`, хост не тронут) и credential-подобные
URL-фрагменты (`#access_token=...`, `#token=...` — тот же закрытый
список имён, теперь matched после `?`, `&`, ИЛИ `#`).

**Это остаётся ТОЛЬКО санитизацией операционного трейса.** Реальный
URL, переданный `ContentFetcher.fetch`, и существующая
Evidence/source provenance-семантика НЕ затронуты (подтверждено
адверсариальными тестами, включая закрытый secret-URL из Stage 2).
Список — текущий утверждённый (§6/§13 задания), НЕ исчерпывающий
перечень каждой возможной credential-формы — граница явно
задокументирована, не переоценена.

---

## 12. safeFailureReason hardening (LOW-3 из D-116, теперь закрыт)

`s4-executor.ts`'s `safeFailureReason` теперь ограничивает
error-класс-категорию до `MAX_FAILURE_CATEGORY_LENGTH = 64` символов
(`category.slice(0, 64)`). Провайдерские данные обычно не
контролируют `e.constructor.name`, утечка секрета не была
воспроизведена — это защита в глубину против теоретического
патологического имени класса, не исправление реальной уязвимости.
Ни `e.message`, ни заголовок Authorization, ни API-ключ, ни сырой
provider payload никогда не входят в эту строку (не изменено с
D-116) — только `label` (закрытая константа) + ограниченная категория.

---

## 13. Interpreter tooling boundary (§15 задания)

Новый статический regression-тест
(`tests/s10-live-provider-enablement.test.ts`) подтверждает:

- ни один файл под `app/` (публичные Next.js роуты) не ссылается на
  `__setInterpreterGateway` или `alpha-run`;
- ни один файл под `src/server/services/` (продуктовый service layer)
  не ссылается на них;
- `src/server/jobs/worker.ts` (реальный продакшн task handler) не
  импортирует `live-executor.ts` ни `__setInterpreterGateway`.

`__setInterpreterGateway` (`interpreter/gateway.ts`) остаётся
internal-only tooling — используется тестами и `alpha-run.ts`,
недостижим из публичного/продуктового runtime.

---

## 14. Live trace

Сохранена операционная трейс-инфраструктура Stage 2 без изменений
семантики: provider identity, query, candidate URL (редактированный,
§11), fetch attempt/outcome, extract/model attempt, safe failure
category, budget reservation attribution, terminal outcome. Добавлены
ТОЛЬКО 3 audit-only usage-поля (§6) и 1 новый operation_type
(`MODEL_CALL_SKIPPED`, §4) + 2 новых reason_code
(`MODEL_INPUT_OVERSIZED`/`TOKEN_COUNT_UNAVAILABLE`, §4). Не хранятся:
сырые prompt'ы, сырые completion'ы, chain-of-thought, credentials,
сырой provider error text — структурно негде (`TraceEventInput` не
имеет для них полей).

**TRACE ≠ EVIDENCE остаётся заморожено** — новый operation_type/
reason_code не меняет этот инвариант; статический тест из Stage 2
(`first-real-run-stage2-static.test.ts`) продолжает проходить
неизменным.

---

## 15. Первая живая цель (§18 задания — НЕ выполняется этим срезом)

```
PROJECT:   Pump.fun / PUMP
ВОПРОС:    Do PUMP buybacks actually reduce token supply?
```

Инструментарий подготовлен (`INTERNAL_ALPHA_LIVE_PROJECT_SLUGS`
содержит `pump_fun`), но исследовательская логика НЕ хардкожена под
PUMP — S4/S5/S6/S7 остаются полностью замороженными, generic pattern-
based движком. Первый живой прогон этим срезом НЕ выполнен.

---

## 16. Восходящий freeze — не тронут

```
S4 runtime: d7e5b8a  (safety-only изменения этого среза — §3/§4/§12
                       выше — не исследовательская семантика)
S5 runtime: a657db3
S6 runtime: af23d8c
S7 runtime: 9eccea7
Stage 1 accepted runtime: cee7c199d44b20cbfdc95227082f9820cd2eca49
Stage 2 accepted/frozen runtime: 8206a79 (freeze af7365b, D-117)
```

---

## 17. Live gate — подтверждено на конец этого среза

```
research_enabled = false
PRODUCTION_MODEL_COST_PROFILES — НЕ пуст (§3), но role-qualified и
  fail-closed вне двух утверждённых записей — не ослабление D-090
Живой Brave вызов НЕ произошёл
Живой Anthropic вызов НЕ произошёл
S10 остаётся CLOSED (internal_alpha_enabled=false по умолчанию)
FIRST REAL ATLAS RUN НЕ произошёл
```

---

## 18. Что НЕ реализовано

```
S8, S9                          НЕ НАЧАТЫ
Proof Core, UI, billing         НЕ НАЧАТЫ
Claim Normalization             НЕ НАЧАТА
private beta, share cards       НЕ НАЧАТЫ
automatic Research Memory promotion   НЕ РЕАЛИЗОВАНО
browser automation              НЕ РЕАЛИЗОВАНО
multi-provider redundancy       НЕ РЕАЛИЗОВАНО
production retention/TTL        НЕ РЕАЛИЗОВАНО
коммерческие research tiers     НЕ РЕАЛИЗОВАНЫ
downward reservation refunds/reconciliation   НЕ РЕАЛИЗОВАНО (§7)
FIRST REAL ATLAS RUN            НЕ ВЫПОЛНЕН
```

---

## 19. Регрессия

- `npx vitest run` → **729 passed, 4 skipped, 0 failed**
- `tsc --noEmit` → чисто
- `eslint .` → чисто
- `next build` → успех, ни одного нового публичного маршрута
- `drizzle-kit generate` → без дрейфа
- `npm run eval:memory` → не изменился
- `npx playwright test` → 7 passed, 1 skipped
- Ручной smoke `alpha-run --mode=fixture` — успешный прогон,
  `reserved=40 actual=0 limit=4000000` (корректно нулевой actual для
  non-live)
- Ручной smoke `alpha-run --mode=live` без `internal_alpha_enabled`/
  credentials — отказ ДО создания job, со списком всех недостающих
  предпосылок
- Ручной smoke `alpha-run --mode=live --project=<неутверждённый>` —
  отказ по allowlist ДО создания job
- `research_enabled = false`; S4/S5/S6/S7 семантика не изменена вне
  §3/§4/§12 (safety-only)

---

**S10 не заморожен этим документом.** Freeze — отдельное решение
владельца после ревью. FIRST REAL ATLAS RUN — отдельный, будущий,
явно owner-controlled шаг.

---

## 20. Acceptance Closure (D-119) — коррекция §5/§7/§17 по независимому ревью

Независимое ревью HEAD `eac7b87` (§19 выше) вернуло **REJECT / DO NOT
ACCEPT** (BLOCKER 2, HIGH 1, MEDIUM 2, LOW 3). Этот раздел — историческая
коррекция; §1–19 выше не стираются, но §5 (Retry) и §17 (терминальный
контракт при сбое) читать вместе с этим разделом как авторитетным.

**BLOCKER-1 — capability-fatal канал.** §17 (выше) утверждал, что сбой
исполнения становится `FAILED`/`SYSTEM_OR_PROVIDER_FAILURE` — это было
верно для `TracePersistenceError` (Stage 2, D-115), но НЕ было верно
для полного отказа живой способности провайдера: такой отказ
деградировал в обычный `WorkExecutionResult.FAILED`, доходил до
`WORK_QUEUE_EXHAUSTED → SUCCEEDED`, и S7 писал `INSUFFICIENT_EVIDENCE`
— нарушение D-114. Закрыто новым `CapabilityFatalError`
(`src/server/engine/capability-fatal-error.ts`), бросаемым из
`s4-executor.ts` при доказанной недоступности SearchGateway/
QueryProposer/EvidenceExtractor/count_tokens после допустимого retry —
распространяется структурно через `controller.ts`/`run-job.ts` (нет
промежуточного try/catch) до границы `worker.ts`, без единого
изменения контроллера или S5/S6/S7.

**BLOCKER-2 — retry владеет резервацией на КАЖДУЮ внешнюю попытку.** §5
(выше) описывал `retryOnceIfTransient` как провайдер-внутренний —
это было архитектурной ошибкой: одна S4-резервация могла авторизовать
ДВА реальных внешних вызова (Brave/Anthropic), в обход правила «каждый
биллируемый внешний вызов получает собственную резервацию ДО вызова».
Retry перенесён из провайдеров (`search-gateway-brave.ts`/
`query-proposer-anthropic.ts`/`evidence-extractor-anthropic.ts` теперь
делают РОВНО одну внешнюю попытку каждый) в новую единую функцию
`reserveAndCallWithRetry` (`s4-executor.ts`), которая резервирует
бюджет перед каждой попыткой, включая повтор. `count_tokens` остаётся
исключением (небиллируемо, собственный внутренний retry в
`token-gate.ts`) — задокументировано явно, не новая бюджетная ось.

**HIGH-1 — посчитанный запрос = generation-запрос.** `count_tokens`
получал только `model`/`system`/`messages`; `output_config` не входил
в посчитанный запрос, хотя влияет на то, как провайдер токенизирует
запрос. `countThenGate` (`token-gate.ts`) теперь требует `outputConfig`
как обязательный параметр; оба провайдерских файла строят один общий
`baseRequest`, используемый структурно идентично для counting и
generation.

**MEDIUM-1 — одна audit-строка на реальную попытку модели.** Полное
usage копировалось на каждую строку `QUERY_PROPOSED`/`EXTRACT_OK`, так
что `SUM(actual_cost_micro)` завышал реальную стоимость кратно числу
предложенных запросов/допущенных фактов одного вызова. Новый закрытый
`trace_operation_type` `MODEL_CALL_ATTEMPTED` (миграция `0022`) — ровно
одна audit-строка на реальный внешний вызов генерации.
`QUERY_PROPOSED`/`EXTRACT_OK` больше не несут usage-полей.
`alpha-run.ts`/`alpha-inspect.ts` теперь суммируют `actual_cost_micro`
только по `operation_type = 'MODEL_CALL_ATTEMPTED'`, без сужающего
`::int`.

**MEDIUM-2 — no-prompt-caching billing assumption.** `INTERNAL_ALPHA_V1`
намеренно не использует prompt caching. Новое поле
`ModelUsage.unsupportedBillingUsage` — если ответ Anthropic сообщает
ненулевые `cache_creation_input_tokens`/`cache_read_input_tokens`,
`s4-executor.ts` не вычисляет `actualCostMicro` из одних
input/output-токенов (оставляет `null`, `reasonCode=
UNSUPPORTED_BILLING_USAGE`), вместо молчаливого занижения стоимости.

**§7 LOW, принятые тривиально:** malformed JSON от Brave (HTTP 200,
невалидное тело) переклассифицирован нетранзиентным — детерминированный
сбой парсинга, повтор идентичного запроса воспроизвёл бы тот же
результат.

**Раскрыто, НЕ реализовано:** операционная видимость номера попытки
`count_tokens` (1 vs retry 2) — отдельная trace-запись не добавлена;
неудача `count_tokens` после retry уже становится `fatal` и видна
через `CapabilityFatalError`/`MODEL_CALL_ATTEMPTED`, но какая именно
попытка (первая или вторая) не различима в трейсе.

Новый regression-файл: `tests/s10-acceptance-closure.test.ts` (19
тестов — BLOCKER-1 A–F + E2E, BLOCKER-2 1–5, HIGH-1, MEDIUM-1,
MEDIUM-2).

### Регрессия этого closure pass

- `npx vitest run` → **748 passed, 4 skipped, 0 failed**
- `tsc --noEmit` → чисто
- `eslint .` → чисто
- `next build` → успех
- `drizzle-kit generate` → без дрейфа (миграция `0022` уже применена)
- `npm run eval:memory` → не изменился
- `npx playwright test` → 7 passed, 1 skipped

S4 изменён только execution/accounting-only; `controller.ts`/
`component-reconciler.ts`/`mechanism-assembler.ts`/`claim-evaluator.ts`/
`claim-support-store.ts` — нулевой diff. `research_enabled=false`;
`internal_alpha_enabled` остаётся default `false`. Живого трафика
Brave/Anthropic в рамках этого closure pass не было.

**Этот closure pass сам себя не замораживает.** Freeze S10 остаётся
отдельным решением владельца после повторного независимого ревью.

---

## 21. Final Pre-Smoke Closure (D-120) — коррекция §3/§20 по повторному
независимому ревью

Повторное независимое ревью HEAD `6108f30` (§20 выше) вернуло **REJECT /
DO NOT ACCEPT** (BLOCKER 0, HIGH 1, MEDIUM 1, LOW 3). Этот раздел —
историческая коррекция §20 и, транзитивно, §3 (Retry) выше.

**HIGH-1 — дименсиональное истощение бюджета.** §20 закрыло BLOCKER-1
(capability-fatal) и BLOCKER-2 (per-attempt резервация), но не заметило
симметричный дефект: отказ РЕЗЕРВАЦИИ (не сам вызов провайдера)
по-прежнему деградировал в обычный локальный исход исполнения —
замороженный контроллер мог завершиться `WORK_QUEUE_EXHAUSTED →
SUCCEEDED`, и S7 мог записать `INSUFFICIENT_EVIDENCE`, хотя реальная
причина остановки — исчерпание бюджета `searchQueries`/`sourceOpens`/
`modelCostMicro`, а не недостаточность доказательств. Закрыто новым
`BudgetExhaustedError` (`budget-exhausted-error.ts`), бросаемым из
`s4-executor.ts` ТОЛЬКО когда отказ резервации оставляет НОЛЬ полезного
результата этой попытки (компонент, уже получивший кандидатов/
документы/evidence до истощения оси, НЕ превращается задним числом в
бюджетный сбой) — распространяется структурно через `controller.ts`/
`run-job.ts` (без единого изменения) до `worker.ts`, который получил
ОДНУ узкую типизированную ветку catch: `state=BUDGET_LIMIT_REACHED`/
`terminationReason=BUDGET_EXHAUSTED`/`errorCode=null` — та же лексика,
которую `mapEngineOutcome` уже использует для собственного
(attempt-count) `BUDGET_EXHAUSTED` контроллера.

**MEDIUM-1 — ретрай count_tokens не работал против сырой ошибки
Anthropic SDK.** §3 (Retry) выше описывал `token-gate.ts`'s внутренний
retry как рабочий — это было архитектурной ошибкой: `retryOnceIfTransient`
классифицировал СЫРОЕ исключение SDK классификатором по умолчанию
(требует поле `.transient`, которого сырое исключение Anthropic никогда
не несёт, поскольку это поле вычисляется ВЫЗЫВАЮЩИМ в catch-блоке ПОСЛЕ
того, как retry уже решил не повторять). Реальный транзиентный
503/429/сетевой сбой на попытке #1 `count_tokens` никогда не повторялся
на практике. Исправлено новым `isTransientAnthropicApiError` (`retry.ts`)
— единое правило `429 | undefined-статус | 5xx`, теперь используемое
`token-gate.ts` (передан явно как классификатор) И
`query-proposer-anthropic.ts`/`evidence-extractor-anthropic.ts` (устранён
дубль того же правила, ранее продублированного трижды).

Принят §8 (кардинальность `MODEL_CALL_ATTEMPTED`, оставленный residual
LOW в §20): одна реальная HTTP-попытка генерации теперь равна одной
audit-строке — успешная попытка после одного транзиентного отказа
производит 2 строки (FAILED + OK), а не 1 строку с задвоенной
`budgetAmount`. Принят §9 (alpha-inspect): новая секция `MODEL CALLS`.

Раскрыто, НЕ реализовано (принято как LOW): операционная видимость
номера попытки `count_tokens` — недоступность после retry уже становится
`fatal` и видна через `CapabilityFatalError`, но какая именно попытка не
различима в трейсе; потребовало бы протаскивать db/jobId/attemptId в
`token-gate.ts` (сейчас чистый provider-слой без DB-осведомлённости).

Новый regression-файл: `tests/s10-final-pre-smoke-closure.test.ts` (12
тестов — A/B через полный `handleResearchJobTask`, C/D/E/F на уровне
executor, G/H/I против `countThenGate` с настоящими `Anthropic.APIError`,
J replay-safety, K cardinality). Миграция схемы НЕ потребовалась.

### Регрессия этого closure pass

- `npx vitest run` → **760 passed, 4 skipped, 0 failed** (748 базовых +
  12 новых; 10 существующих тестов обновлены — их ожидания
  соответствовали ДОпоправочному поведению budget-exhaustion)
- `tsc --noEmit` → чисто
- `eslint .` → чисто
- `next build` → успех
- `drizzle-kit generate` → без дрейфа
- `npm run eval:memory` → не изменился
- `npx playwright test` → 7 passed, 1 skipped

S4 изменён только execution/accounting-only (плюс одна узкая
типизированная ветка catch в `worker.ts`); `controller.ts`/`run-job.ts`/
S5/S6/S7 — нулевой diff. `research_enabled=false`;
`internal_alpha_enabled` остаётся default `false`. Живого трафика
провайдеров в рамках этого closure pass не было.

**Этот closure pass сам себя не замораживает.** Freeze S10 остаётся
отдельным решением владельца после повторного независимого ревью.

---

## 22. Last HIGH Closure (D-121) — partial-success budget denial +
preflight capability classification

Независимое ревью HEAD `539e000` (§21 выше) вернуло **REJECT / DO NOT
ACCEPT** (BLOCKER 0, HIGH 2, MEDIUM 0, LOW 3).

**HIGH-1 — partial success swallowed budget denial.** §21's
`BudgetExhaustedError` throw was gated on an END-OF-LOOP sufficiency
check (`candidateUrls.size===0`/`fetchedDocs.length===0`/
`insertedEvidenceIds.length===0`) — if an EARLIER call in the same loop
already produced a usable partial result, a LATER reservation denial in
that same loop was silently absorbed and the component could still
report `SUCCEEDED`. Fixed: `BudgetExhaustedError` now throws AT the
denial boundary — the moment a reservation is refused — regardless of
what was already collected earlier in the same loop. S4 is not the
sufficiency adjudicator; a non-empty partial result is not research
completion. Already-persisted Evidence/trace rows are never deleted —
only the terminal outcome of the CURRENT attempt changes.

**HIGH-2 — preflight capability failures.** `preflight()`'s failure
return was untyped (`{ok:false, reason}`), so `execute()` always
returned `WorkExecutionResult.FAILED` for it — a missing credential or
cost profile could then be folded by the controller into
`WORK_QUEUE_EXHAUSTED → SUCCEEDED → S7 INSUFFICIENT_EVIDENCE`. Fixed
with a structured `PreflightFailureKind` (`CAPABILITY_FATAL` | `LOCAL`)
— `execute()` throws `CapabilityFatalError` for a `CAPABILITY_FATAL`
result, before any reservation.

### Preflight classification table

| Code | Classification | Why |
|---|---|---|
| `MODEL_COST_PROFILE_MISSING` (QueryProposer) | CAPABILITY_FATAL | No approved (role, model) cost profile exists — QueryProposer cannot legally be called at all this attempt, not a per-call condition. |
| `MODEL_COST_PROFILE_MISSING` (EvidenceExtractor) | CAPABILITY_FATAL | Same reasoning, EvidenceExtractor role. |
| `SEARCH_GATEWAY_UNAVAILABLE` | CAPABILITY_FATAL | `resolveSearchGateway()` throws only for an unknown `SEARCH_GATEWAY_PROVIDER` or missing `BRAVE_SEARCH_API_KEY` — both environment/config facts, never a per-call outcome. |
| `CONTENT_FETCHER_UNAVAILABLE` | CAPABILITY_FATAL | Currently unreachable (`resolveContentFetcher()` never throws today) — classified defensively; a future construction failure would mean FETCH cannot function at all this attempt. |
| `QUERY_PROPOSER_UNAVAILABLE` | CAPABILITY_FATAL | `resolveQueryProposer()` throws for `MODEL_GATEWAY=fake` with no fixture, or (new this round) an eagerly-checked missing `ANTHROPIC_API_KEY` — both environment/config facts. |
| `EVIDENCE_EXTRACTOR_UNAVAILABLE` | CAPABILITY_FATAL | Same reasoning, mirrored for the extraction role. |

No current preflight failure classifies `LOCAL` — none represents "the
capability exists but this one call happened to fail for an ordinary
reason" (that classification belongs to `reserveAndCallWithRetry` at
runtime, not preflight).

**Architecture correction (provider seams, outside S4):**
`resolveQueryProposer()`/`resolveEvidenceExtractor()` previously
deferred the `ANTHROPIC_API_KEY` check to the first REAL call (lazy-
failure discipline inherited from `resolveInterpreterGateway`) — this
gave preflight nothing to catch, since the failure happened AFTER a
reservation was already made. Both now throw immediately for a missing
key, mirroring `resolveSearchGateway()`'s existing eager
`BRAVE_SEARCH_API_KEY` check. This is the one behavioral change outside
S4 this round, scoped to the provider-seam layer only.

Test fixture note: `depsFor()` helpers in `s10-acceptance-closure.test.ts`/
`s10-final-pre-smoke-closure.test.ts` now default ALL four provider
roles (previously only cost profiles) — eager credential validation
otherwise caught the test environment's missing `ANTHROPIC_API_KEY` for
any test that left EvidenceExtractor unfixtured, even when that test's
scenario never needed it.

New closure regression block in `tests/s10-final-pre-smoke-closure.test.ts`
(+6 HIGH-2 tests A–F, on top of the prior 12). 3 tests in
`phase6-s4-executor.test.ts` and 2 in `phase6-provider-seams.test.ts`
updated — their assertions matched the PRE-fix (non-throw / lazy-failure)
contract, not a regression in coverage.

### Регрессия этого closure pass

- `npx vitest run` → **766 passed, 4 skipped, 0 failed** (760 baseline +
  6 new HIGH-2 tests)
- `tsc --noEmit` → чисто
- `eslint .` → чисто
- `next build` → успех
- `drizzle-kit generate` → без дрейфа (миграция не потребовалась)
- `npm run eval:memory` → не изменился
- `npx playwright test` → 7 passed, 1 skipped

S4 изменён только execution/accounting-only; `query-proposer.ts`/
`evidence-extractor.ts` — единственные затронутые файлы вне S4,
ограничено credential-eagerness. `controller.ts`/`run-job.ts`/S5/S6/S7 —
нулевой diff. `research_enabled=false`; `internal_alpha_enabled`
остаётся default `false`. Живого трафика провайдеров не было.

**Этот closure pass сам себя не замораживает.** Freeze S10 остаётся
отдельным решением владельца после повторного независимого ревью.
