# First Real Run — Stage 2: Operational Trace + Internal Runner

> **Статус: РЕАЛИЗОВАНО, ожидает ревью владельца.** Продолжает Stage 1
> (D-113/D-114, `pipeline-integration-stage1.md`/`-freeze.md`) — не
> заменяет и не переоткрывает его. Stage 2 не начинает S8, S9 или S10 и
> не активирует живых провайдеров.
>
> D-115 фиксирует существование и границы этого среза.

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
job через `createResearchJob` (тот же слой, что и продакшн) и проводит
её через настоящий `handleResearchJobTask` — не вызывает S5/S6/S7
напрямую как обход. `alpha-inspect <jobId>` — строго READ-ONLY,
детерминированный, структурированные секции (JOB, INPUT, NORMALIZED
INTENT, PLAN/CONTRACT, MEMORY, S4 ATTEMPTS, SEARCH, SOURCE CANDIDATES,
FETCHES, EXTRACTION, EVIDENCE, S5, S6, S7, BUDGET, TERMINATION,
WARNINGS). Не создаёт публичный роут, не включает `research_enabled`,
не активирует живых провайдеров.

**F. Опциональный seam в `worker.ts`** — `handleResearchJobTask`
получил третий, опциональный параметр `executorOverride`. Без него
поведение побайтово идентично принятому Stage 1 (продакшн-путь и
каждый Stage-1-эры тест не изменились — подтверждено полным прогоном
регрессии). Используется ТОЛЬКО `alpha-run.ts` (для non-live
trace-фикстуры) и тестами Stage 2 — никогда живым/продакшн путём.

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
исключения никогда не персистируется (проверено адверсариальным
тестом: URL с `api_key=SECRET` в тексте ошибки провайдера никогда не
попадает ни в `reason_code`, ни в любое другое неограниченное поле
трейса — только нормализованный `PROVIDER_ERROR`). Ни ключей, ни
заголовков авторизации, ни chain-of-thought, ни сырых
prompt/completion — структурно негде: `TraceEventInput` не имеет для
них полей.

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

---

## 8. Что НЕ реализовано

- S8, S9, S10 — не начаты.
- `research_enabled` — не тронут, `false`.
- `PRODUCTION_MODEL_COST_PROFILES` — не тронут, пуст.
- Публичный роут, UI — не созданы.
- Retention/TTL/cleanup трейса — не реализованы (§2 задания).
- Stage 1 LOW-1/LOW-2/LOW-3 — не тронуты, не расширены (не потребовались
  для реализации Stage 2).

---

## 9. Регрессия

- `npx vitest run` → **697 passed, 4 skipped, 0 failed**
- `tsc --noEmit` → чисто
- `eslint` → чисто
- `next build` → успех, ни одного нового публичного маршрута
- `drizzle-kit generate` → без дрейфа
- `npm run eval:memory` → не изменился
- `npx playwright test` → 7 passed, 1 skipped
- `research_enabled = false`; `PRODUCTION_MODEL_COST_PROFILES` пуст
- S4/S5/S6/S7 семантика не изменена: единственный тронутый файл
  замороженного движка — `s4-executor.ts`, только наблюдательно (§7)

---

**Stage 2 не заморожен этим документом.** Freeze — отдельное решение
владельца после ревью.
