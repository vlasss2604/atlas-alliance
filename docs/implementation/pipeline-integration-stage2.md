# First Real Run — Stage 2: Operational Trace + Internal Runner

> **Статус: РЕАЛИЗОВАНО (с closure pass), ожидает повторного ревью
> владельца.** Продолжает Stage 1 (D-113/D-114,
> `pipeline-integration-stage1.md`/`-freeze.md`) — не заменяет и не
> переоткрывает его. Stage 2 не начинает S8, S9 или S10 и не активирует
> живых провайдеров.
>
> D-115 фиксирует существование и границы этого среза. Независимое
> ревью на HEAD `f6858ec` вернуло `REJECT / DO NOT FREEZE` (HIGH 1,
> MEDIUM 3, LOW 6) — HIGH-1/MEDIUM-1/MEDIUM-2/MEDIUM-3 закрыты в
> closure pass, зафиксированном D-116 (см. §10 ниже). S7/S6/S5/S4
> исследовательская семантика НЕ переоткрывалась.

---

## 1. Цель

**Сделать видимым то, что S4 уже делает, не меняя того, что S4 решает.**

До этого среза единственным наблюдаемым следом S4 было
`research_attempts.reason` — одна строка на (job, step, component,
попытка). Нельзя было ответить на вопрос альфа-тестирования: «почему
Atlas не нашёл очевидный первичный источник?» — не хватало ли
кандидатов, провалилась ли загрузка, провалилось ли извлечение, или
извлечённые факты были отклонены (не тот проект/компонент/не
прослеживаемо).

---

## 2. Что реализовано

**A. `research_trace_events`** — выделенная append-only таблица
(миграция `0020`, аддитивная). НЕ расширение `research_attempts` в
JSON-журнал операций — `research_attempts` остаётся тем же агрегатом
уровня попытки, что и раньше.

Закрытые словари (`enums.ts`): `trace_operation_type` (14 значений),
`trace_status` (переиспользует `OK`/`FAILED`/`SKIPPED` из
`WorkExecutionResult`, не изобретает параллельный словарь),
`trace_provider_kind`, `trace_reason_code` (закрытый, `PROVIDER_ERROR`
— единственный catch-all для сырого текста исключения, который
никогда не персистируется как есть), `trace_budget_axis` (те же три
существующие оси — `searchQueries`/`sourceOpens`/`modelCostMicro`, ни
одной новой).

Детерминированный порядок (`sequence`) выделяется атомарно через
блокировку строки `research_jobs` (`SELECT ... FOR UPDATE`) — тот же
приём, что `claimAttempt` уже использует для `attemptNumber`; никакой
новой колонки на `research_jobs`, никакого отдельного примитива
синхронизации.

**B. `trace-store.ts`** — единственный писатель в таблицу.
`recordTraceEvent` бросает `TracePersistenceError` при сбое персиста —
намеренно, не проглатывается нигде в `s4-executor.ts` (см. §5).

**C. Инструментация `s4-executor.ts`** — только наблюдательные вызовы
вокруг уже существующих решений; ни одно условие, порядок ветвления,
порядок кандидатов, правило containment/traceability/admission, правило
классификации источника, правило бюджета или провайдера не изменено.
Полная построчная классификация diff — §7 ниже.

**D. `trace-fixture-executor.ts`** — отдельная non-live фикстура,
собранная поверх РЕАЛЬНОГО `createS4WorkExecutor` (не дублирует его
логику). Семь детерминированных сценариев (A–G задания): zero
candidates, fetch failure, extraction failure, admissible evidence,
partial fetch failure, duplicate candidate, budget-skipped candidate.
Каждый провайдер назван ровно `"non-live-fixture"`. НЕ заменяет и не
трогает принятый Stage 1 `createNonLiveS4WorkExecutor`
(`non-live-executor.ts`) — оба сосуществуют.

**E. `alpha-run.ts` / `alpha-inspect.ts`** — раздельные скрипты
(`npm run alpha:run` / `alpha:inspect`). `alpha-run` создаёт ОДНУ
job через `createResearchJob` (тот же слой, что и продакшн, теперь с
`{ skipEnqueue: true }` — см. §9) и проводит её через настоящий
`handleResearchJobTask` — не вызывает S5/S6/S7 напрямую как обход.
`alpha-inspect <jobId>` — строго READ-ONLY, детерминированный,
структурированные секции (JOB, INPUT, NORMALIZED INTENT,
PLAN/CONTRACT, MEMORY, S4 ATTEMPTS, SEARCH, SOURCE CANDIDATES,
FETCHES, EXTRACTION, EVIDENCE, S5, S6, S7, BUDGET, TERMINATION,
WARNINGS). Не создаёт публичный роут, не включает `research_enabled`,
не активирует живых провайдеров.

Closure pass (MEDIUM-3, §10): `alpha-run` теперь пропускает вопрос
через РЕАЛЬНЫЙ Interpreter (`createInterpretation`), с явно
зафиксированным non-live gateway (`interpreter/fake.ts`, через
`__setInterpreterGateway` — не зависит от `MODEL_GATEWAY` окружения) —
до этой правки job создавался БЕЗ строки `interpretations`, а S7
(`claim-support-store.ts`'s `loadIntentAndTaskType`) читает
`normalized_intent`/`task_type` именно из `interpretations`, найденной
по `researchJobId` — при отсутствии строки результат тихо схлопывался
в `UNKNOWN`, и S7 никогда не оценивал реальный набор требований
намерения, независимо от того, что производила S4-фикстура.

**F. Опциональный seam в `worker.ts`** — `handleResearchJobTask`
получил третий, опциональный параметр `executorOverride`, и теперь
возвращает структурированный результат `{ claimed: true } | { claimed:
false, reason }` (§9) вместо `void`. Без `executorOverride` поведение
побайтово идентично принятому Stage 1 (продакшн-путь и каждый
Stage-1-эры тест не изменились — подтверждено полным прогоном
регрессии). `executorOverride` используется ТОЛЬКО `alpha-run.ts` (для
non-live trace-фикстуры) и тестами Stage 2 — никогда живым/продакшн
путём (нет ни одного HTTP-роута, импортирующего `handleResearchJobTask`
напрямую — только `worker.ts`'s собственный `boss.work()`, который
никогда не передаёт третий аргумент).

---

## 3. TRACE ≠ EVIDENCE

Жёсткий инвариант приёмки. `research_trace_events`:

- не читается `component-reconciliation-store`, `S5`, `S6`, `S7` —
  подтверждено выделенным статическим регрессионным тестом
  (`tests/first-real-run-stage2-static.test.ts`), проверяющим
  исходники этих модулей на отсутствие ссылки на таблицу/модуль трейса;
- не содержит полей, которые могли бы притвориться Evidence (нет
  `fragment`/`summary`/`doesNotProve`/`supportFragment`/`statement`);
- `evidence_id`/`source_id` — только id-ссылки для аудита, не копия
  содержимого;
- никакого кода пути `trace → Evidence` не существует.

Trace фиксирует **операции**. Evidence фиксирует **допустимые
исследовательские факты с provenance**. Это разные вещи.

---

## 4. Безопасность данных

`target_ref` ограничен (CHECK ≤ 2048 символов + усечение в
`trace-store.ts`). `reason_code` — закрытый словарь; сырой текст
исключения никогда не персистируется в `reason_code` (проверено
адверсариальным тестом: URL с `api_key=SECRET` в тексте ошибки
провайдера никогда не попадает в `reason_code` — только
нормализованный `PROVIDER_ERROR`).

**Исправлено closure pass'ом (MEDIUM-1, D-116, §10):** на HEAD
`f6858ec` это утверждение было ЛОЖНЫМ для `target_ref` конкретно —
`target_ref` персистировал URL кандидата/фетча ВЕРБАТИМ, и секрет в
самом URL (не только в тексте исключения) персистировался бы
неотредактированным. `boundTargetRef` (`trace-store.ts`) теперь
применяет `redactUrl()` к КАЖДОМУ персистируемому `target_ref` —
детерминированная замена известных чувствительных query-параметров
(`api_key`/`apikey`/`key`/`token`/`access_token`/`auth`/
`authorization`/`signature`/`sig`/`secret`, регистронезависимо) на
`[REDACTED]`, строковая замена (не через `URL`/`URLSearchParams`, во
избежание percent-encoding и переупорядочивания query-строки).
Это ТОЛЬКО санитизация трейса — реальный URL, переданный
`ContentFetcher.fetch`, и `evidence.retrievedUrl`/`sources.url`
(provenance) НЕ затронуты (адверсариальный тест подтверждает оба
свойства: редактированный `target_ref` в трейсе, нередактированный URL
у самого fetch-вызова). Independent Opus review, обнаруживший разрыв
между этим утверждением и реализацией, не выявил такой же уязвимости
в Evidence/source provenance — если она когда-либо будет
продемонстрирована, это отдельный, явно раскрытый дефект, а не
предположение, закрытое здесь молча.

**Исправлено closure pass'ом (MEDIUM-2, D-116, §10):**
`research_attempts.reason` (не только `research_trace_events`) —
отдельное, ранее не защищённое поле: `controller.ts` персистирует
`WorkExecutionResult.reason` вербатим, а `callProvider()`
(`s4-executor.ts`) интерполировал `e.message` пойманного исключения
туда же — сырой текст провайдера/транспорта мог содержать URL с
credential или заголовок `Authorization`. `callProvider` теперь
использует `safeFailureReason(label, e)` — только код провайдерской
границы (`label`, закрытая, кодо-заданная константа) + класс
исключения (`e.constructor.name`), НИКОГДА не `.message`. Ни ключей,
ни заголовков авторизации, ни chain-of-thought, ни сырых
prompt/completion — структурно негде: `TraceEventInput` не имеет для
них полей, а теперь и `research_attempts.reason` не несёт свободного
текста исключения ни от одной из четырёх провайдерских границ.

Автоматическая очистка/TTL/архивация в Stage 2 **не реализованы** —
явное решение владельца (§2 задания): трейс хранится весь период
Internal Alpha, retention-политика — решение будущего среза.

---

## 5. Сбой персистенции трейса ≠ доказательный вывод

`recordTraceEvent` бросает `TracePersistenceError` при сбое, не
проглатывается нигде в `s4-executor.ts` (структурно подтверждено:
единственная функция с собственными `try/catch` в этом файле —
`preflight()` — не содержит ни одного вызова `recordTraceEvent`).
Непойманное исключение проходит сквозь `controller.ts`'s
`executor.execute()` (там тоже нет try/catch вокруг этого вызова) и
`run-job.ts` — и перехватывается только на границе Stage 1 worker'а
(`handleResearchJobTask`), становясь `state=FAILED`/
`terminationReason=SYSTEM_OR_PROVIDER_FAILURE`. Сбой персистенции
трейса **никогда** не превращается в `INSUFFICIENT_EVIDENCE` или любой
другой доказательный вывод — S7 для такого job'а не запускается вовсе.

---

## 6. Бюджет

Никакой новой оси бюджета. `CANDIDATE_SKIPPED_BUDGET`/`SEARCH_EXECUTED`
(skipped) несут `budget_axis`/`budget_amount` для той операции, что
реально израсходовала/зарезервировала бюджет — авторитетный источник
остаётся `research_jobs.*Reserved` (уже существующие счётчики),
никакой второй системы учёта не введено.

---

## 7. Классификация diff `s4-executor.ts` — только наблюдательные изменения

| Изменённая строка | Было | Стало | Классификация |
|---|---|---|---|
| `if (!reserved) break` (sourceOpens) | `break` | `recordTraceEvent(...)` затем тот же `break` | наблюдательная — условие и исход не изменены |
| `if (!reserved) break` (modelCostMicro) | `break` | `recordTraceEvent(...)` затем тот же `break` | наблюдательная |
| `if (!projectContained) continue` | `continue` | `recordTraceEvent(...)` затем тот же `continue` | наблюдательная |
| `if (fact.step !== target.step \|\| fact.component !== target.component) continue` | `continue` | `recordTraceEvent(...)` затем тот же `continue` | наблюдательная |
| `if (!isTraceable(...)) continue` | `continue` | `recordTraceEvent(...)` затем тот же `continue` | наблюдательная |

Все остальные изменения файла — чистые добавления (`await
recordTraceEvent(...)` вставлен ПОСЛЕ существующего решения, либо
новый импорт/комментарий). Ни одно условие, порядок ветвления, порядок
кандидатов, правило containment/traceability/admission, классификация
источника, правило бюджета или провайдера не изменено — подтверждено
построчно (`git diff` содержит ровно эти 5 изменённых строк, остальное
— добавления) и поведенчески (все 105 существующих тестов
`phase6-s4-executor.test.ts` проходят без изменений, полный набор 676
тестов Phase 1–7/Stage 1 — без изменений).

Closure pass (D-116, §10) добавил ОДНО дальнейшее изменение в этот же
файл — `callProvider()`/`safeFailureReason()` (MEDIUM-2, §4): замена
конструкции причины ошибки, без затрагивания ни одного условия/ветвления
этой таблицы. Это дополнительное изменение — тоже наблюдательное/
safety-only в узком смысле «что персистируется как причина», не
исследовательское — но, в отличие от строк выше, оно не вокруг
`recordTraceEvent`, а меняет САМ текст `WorkExecutionResult.reason`;
явно раскрыто здесь, а не молча включено в таблицу выше.

---

## 9. HIGH-1 — атомарный захват job (closure pass, D-116)

До closure pass `handleResearchJobTask` (`worker.ts`) читал job,
проверял `state !== "QUEUED"`, и затем БЕЗУСЛОВНО вызывал
`transitionJobState(..., "RUNNING")` — check-then-act. Два конкурентных
вызова могли оба прочитать `state='QUEUED'` до того, как любой из них
успевал перейти в `RUNNING`; более того, `trg_research_jobs_state_guard`
(`0001_state_machine.sql`) трактует `OLD.state === NEW.state` как
безопасный no-op, так что и более поздний `RUNNING -> RUNNING` "переход"
проигравшего не был бы отклонён БД.

Исправлено: `claimResearchJob(db, jobId)` (`research-jobs.ts`) —
`UPDATE research_jobs SET state='RUNNING', started_at=COALESCE(...)
WHERE id=$1 AND state='QUEUED' RETURNING *`, одним запросом, без явного
`FOR UPDATE` (блокировка строки Postgres на самом UPDATE уже
сериализует конкурентные транзакции — вторая переоценивает своё
`WHERE` уже после коммита первой и не находит строк). Ровно один
вызывающий получает не-`null` строку для данного job.

`handleResearchJobTask` возвращает структурированный результат
(`{ claimed: true } | { claimed: false, reason: "NOT_FOUND" |
"NOT_QUEUED" }`) вместо `void` — не публичный API, потребляется только
`alpha-run.ts` и тестами этого модуля. `claimed: false` означает НОЛЬ
исследовательской работы этим вызовом: планирование, S4-попытка, trace,
Evidence, S5/S6/S7, запись терминального состояния — ничего из этого не
запускалось.

`alpha-run.ts` теперь создаёт job с `{ skipEnqueue: true }`
(`createResearchJob`'s новая опция, НЕ часть `CreateResearchJobInput` —
не может попасть туда из разобранного HTTP-тела) — pg-boss задача для
этого job вообще не создаётся, так что реальный worker-процесс не может
физически конкурировать со скриптом за этот же job (адверсариальный
тест подтверждает: ноль строк `pgboss.job` для job, созданного с
`skipEnqueue: true`). Атомарный захват в `worker.ts` остаётся общей
защитой для продакшн-сценария нескольких worker'ов; `alpha-run.ts`
просто никогда не создаёт второго конкурента.

---

## 10. Closure pass (D-116) — сводка

Independent review (Opus) на HEAD `f6858ec` вернул
`REJECT / DO NOT FREEZE` (HIGH 1, MEDIUM 3, LOW 6). Закрыто:

- **HIGH-1** — атомарный захват job (§9 выше).
- **MEDIUM-1** — редактирование `target_ref` (§4 выше).
- **MEDIUM-2** — `research_attempts.reason` больше не несёт сырой текст
  исключения провайдера (§4 выше).
- **MEDIUM-3** — `alpha-run` теперь проходит через реальный Interpreter
  (non-live `fake` gateway), линкует `interpretations.researchJobId`,
  S7 больше не откатывается на `normalized_intent=UNKNOWN` (§2.E выше).
- **LOW** (по заданию closure pass, только тривиальные): исправлен
  неточный комментарий про усечение `target_ref` в `trace-store.ts`
  (усечение происходит ДО вставки — CHECK-ограничение в норме никогда
  не срабатывает на этом пути, это резервный DB-уровневый барьер, а не
  ожидаемый триггер); удалена неиспользуемая `recordTraceEventBestEffort`
  (единственное место в модуле, проглатывавшее `TracePersistenceError`).

S4/S5/S6/S7 исследовательская семантика не переоткрывалась и не
изменена этим closure pass'ом — единственные затронутые файлы движка:
`s4-executor.ts` (safety-only, §7/§4 выше), `trace-store.ts`
(редактирование + LOW-очистка), `worker.ts`/`research-jobs.ts`
(атомарный захват), `interpreter/gateway.ts` (комментарий, разрешающий
`__setInterpreterGateway` для non-live tooling — сама функция и её
поведение не изменены).

Этот closure pass НЕ замораживает Stage 2 — freeze остаётся отдельным
решением владельца после повторного ревью.

---

## 11. Что НЕ реализовано

- S8, S9, S10 — не начаты.
- `research_enabled` — не тронут, `false`.
- `PRODUCTION_MODEL_COST_PROFILES` — не тронут, пуст.
- Публичный роут, UI — не созданы.
- Retention/TTL/cleanup трейса — не реализованы (§2 задания).
- Stage 1 LOW-1/LOW-2/LOW-3 — не тронуты, не расширены (не потребовались
  для реализации Stage 2 или её closure pass).
- DB-level immutable trace triggers — не реализованы (closure pass §8
  задания: явно исключено из объёма).
- Recurring stale-sweep, Proof Core quota consumption, общее расширение
  телеметрии — не реализованы (closure pass §8 задания).

---

## 12. Регрессия (closure pass)

- `npx vitest run` → **702 passed, 4 skipped, 0 failed** (было 697 —
  +5 сетевых новых/расширенных тестов closure pass'а, §9/§4/§10)
- `tsc --noEmit` → чисто
- `eslint .` → чисто
- `next build` → успех, ни одного нового публичного маршрута
- `drizzle-kit generate` → без дрейфа (поведенческие изменения, схема
  не тронута)
- `npm run eval:memory` → не изменился
- `npx playwright test` → 7 passed, 1 skipped
- Адверсариальный concurrency-тест (два одновременных
  `handleResearchJobTask` на одном job, реальный Postgres) — ровно один
  захватывает job, проигравший не производит НИ ОДНОЙ строки
  планирования/attempt/trace/Evidence сверх baseline одного исполнения
- `research_enabled = false`; `PRODUCTION_MODEL_COST_PROFILES` пуст
- S4/S5/S6/S7 семантика не изменена: единственный тронутый файл
  замороженного движка — `s4-executor.ts`, только наблюдательно/
  safety-only (§7/§4); `controller.ts`, `component-reconciler.ts`,
  `mechanism-assembler.ts`, `claim-evaluator.ts`, `claim-support-store.ts`
  — нулевой diff
- Ручной smoke-тест `alpha-run.ts`/`alpha-inspect.ts` на реальном
  Postgres: реальная классификация Interpreter'а
  (`normalized_intent=PROTOCOL_REVENUE_TO_TOKEN`), полный трейс, S7
  оценил реальный набор требований (`INSUFFICIENT_EVIDENCE` с
  содержательными `reasonCodes`, не `UNKNOWN`/`INTENT_NOT_CLASSIFIED`);
  подтверждено ноль строк `pgboss.job` для job'а, созданного через
  `skipEnqueue: true`

---

**Stage 2 не заморожен этим документом.** Freeze — отдельное решение
владельца после ревью.
