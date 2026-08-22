# First Real Run — Stage 1: Pipeline Integration + Terminal Contract

> **Статус: РЕАЛИЗОВАНО, ожидает ревью владельца.** Этот срез — НЕ S8,
> НЕ S9, НЕ S10. Он не существовал явным пунктом в прежней дорожной карте
> Фазы 6 (§19 `phase-6-plan.md` шла прямо S7 → S8) — старую нумерацию
> срезов Фазы 6 (S0–S10) он не продолжает и не переопределяет; он
> закрывает обнаруженный владельцем разрыв между «замороженный движок
> S4→S7 существует» и «продуктовый worker его никогда не вызывает».
>
> D-113 фиксирует существование и границы этого среза.

---

## 1. Проблема, которую закрывает этот срез

До этого среза `handleResearchJobTask` (`src/server/jobs/worker.ts`)
делал ровно это после планирования Фазы 5:

```
runMemoryPlanningStage(...)
→ errorCode = "NOT_IMPLEMENTED"
→ state = FAILED
```

`runS4ResearchJob` — единственная продакшн-точка входа в замороженный
движок S4→S5→S6→S7 (D-091, D-097, D-104, D-112) — не имела ни одного
вызывающего места в `src/`, кроме собственных тестов. Движок существовал
и был заморожен, но продукт им никогда не пользовался.

---

## 2. Что реализовано

**A. Подключение worker'а к движку.** `handleResearchJobTask` после
успешного планирования Фазы 5 вызывает `runS4ResearchJob(db, jobId,
executor, now)` — ту же самую, замороженную функцию, что и тесты S4–S7.
Worker не переопределяет и не дублирует логику S4/S5/S6/S7; он только
строит зависимости (project, executor) и переносит результат
(`ControllerRunResult.stopReason`) в терминальный контракт job'а.

**B. Zero-cost, zero-network исполнитель.** Новый файл
`src/server/engine/non-live-executor.ts` собирает РЕАЛЬНЫЙ, замороженный
`createS4WorkExecutor` (`s4-executor.ts`) с явными фиктивными
реализациями всех четырёх ролей провайдера (`QueryProposer`,
`SearchGateway`, `ContentFetcher`, `EvidenceExtractor`) и явными
фикстурными `ModelCostProfile` для обеих модельных ролей. Каждое из
четырёх полей `S4ExecutorDeps` передаётся явно — `preflight()` внутри
`s4-executor.ts` проверяет `deps.X ?? resolveX()` для каждого провайдера
БЕЗУСЛОВНО до какой-либо резервации бюджета, поэтому пропуск даже одного
поля рисковал бы обращением к боевому резолверу. `PRODUCTION_MODEL_COST_PROFILES`
(`model-cost-profile.ts`) этим файлом не тронут; `loadModelCostProfile`'s
fail-closed поведение для боевых `modelId` не ослаблено.

Фиктивный `SearchGateway` детерминированно возвращает ноль кандидатов —
никакого фабрикованного Evidence, честный отказ каждой попытки S4.

**C. Терминальный контракт.** Аддитивная миграция
`0019_first_real_run_stage1_termination_reason.sql` добавляет
`research_jobs.termination_reason` (nullable `text`), структурно
отдельную от `state` (исход исполнения) и `error_code` (техническая
деталь). Концептуальный контракт:

```
job.state                      = исход исполнения
job.termination_reason         = почему исполнение остановилось
job.error_code                 = техническая причина сбоя
research_claim_support.status  = доказательный результат
```

Эти четыре поля никогда не схлопываются друг в друга.

`mapEngineOutcome` (`worker.ts`, экспортирована для тестирования)
переиспользует словарь `ControllerStopReason` (`controller.ts`) без
изобретения параллельного:

| `ControllerStopReason` | `job.state` | `job.termination_reason` | `job.error_code` |
|---|---|---|---|
| `WORK_QUEUE_EXHAUSTED` | `SUCCEEDED` | `WORK_QUEUE_EXHAUSTED` | `null` |
| `BUDGET_EXHAUSTED` | `BUDGET_LIMIT_REACHED` | `BUDGET_EXHAUSTED` | `null` |
| `CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK` | `SUCCEEDED` | `CAPABILITY_BOUNDARY_NO_ELIGIBLE_WORK` | `CAPABILITY_BOUNDARY` (задокументированная конвенция из `controller.ts`) |
| `INTERRUPTED` | *(нет перехода — job остаётся `RUNNING`)* | — | — |

Любое исключение из вызова движка (например `MissingActivePatternError`,
`ClaimEvaluationInvariantError`, внутренний сбой резолвера) становится
`state = FAILED`, `termination_reason = SYSTEM_OR_PROVIDER_FAILURE`,
`error_code = <имя класса исключения>` — **никогда** доказательным
выводом.

---

## 3. Явные семантические примеры (реализованы и протестированы)

**A. Нормальное завершение доказательства.**
`state = SUCCEEDED`, `termination_reason = WORK_QUEUE_EXHAUSTED`, строка
`research_claim_support` существует.

**B. Исчерпание бюджета с неполным доказательством.**
`state = BUDGET_LIMIT_REACHED`, `termination_reason = BUDGET_EXHAUSTED`,
`research_claim_support.status` законно может быть
`INSUFFICIENT_EVIDENCE` — это не сбой провайдера/системы.

**C. Сбой исполнения провайдера/системы.**
`state = FAILED`, `error_code` — явная техническая причина,
`termination_reason = SYSTEM_OR_PROVIDER_FAILURE`. Если исследование
предметно не выполнялось, доказательный вывод не выдумывается: строки
`research_claim_support` для такого job'а не существует вовсе.

---

## 4. Что НЕ реализовано этим срезом

- S8, S9, S10 — не начаты.
- `research_enabled` — остаётся `false`.
- `PRODUCTION_MODEL_COST_PROFILES` — остаётся пустым каталогом.
- Proof Core, UI, приватная бета, Claim Normalization, billing — не
  начаты.
- Новые кандидаты Research Memory (`OBSERVED`) — этот срез их не пишет;
  S8 намеренно отложен владельцем до первых живых альфа-прогонов.
- Глобальный редизайн replay/идемпотентности — не выполнялся; закрыты
  только регрессии, введённые самим подключением worker'а (см. §6).

---

## 5. Zero-cost / zero-network доказательство

- `non-live-executor.ts` никогда не вызывает `resolveSearchGateway`,
  `resolveContentFetcher`, `resolveQueryProposer`,
  `resolveEvidenceExtractor` или `loadModelCostProfile` — каждая из
  четырёх ролей провайдера и оба фикстурных `ModelCostProfile` переданы
  явно.
- Тестовое доказательство (`tests/first-real-run-stage1.test.ts`):
  каждая строка `research_attempts`, порождённая этим исполнителем,
  несёт причину `NO_SEARCH_CANDIDATES` — никогда `SEARCH_GATEWAY:`,
  `CONTENT_FETCHER:`, `QUERY_PROPOSER:`, `EVIDENCE_EXTRACTOR:` (которые
  означали бы, что реальный резолвер был потревожен) — и ноль строк
  `evidence` для job'а (фиктивный провайдер не порождает
  прослеживаемых фактов).
- `PRODUCTION_MODEL_COST_PROFILES` не изменён (пустая diff по
  `model-cost-profile.ts`).

---

## 6. Replay / дублирование

`handleResearchJobTask`'s собственный guard (`job.state !== "QUEUED"`)
делает повторную доставку той же задачи pg-boss чистым no-op — job уже
покинул `QUEUED` после первого прохода. Доказано тестом
(«a duplicate worker pickup never duplicates state»): второй вызов не
меняет job, не добавляет строк `research_attempts`, не дублирует
`research_claim_support`.

Внутренняя crash/replay-семантика самого движка (атомарный claim
попыток, upsert-проекции S5/S6/S7) не переоткрывалась — это
замороженный инвариант S4–S7 (D-091, D-097, D-104, D-112), уже
покрытый их собственными наборами тестов.

**Известное architecturally-honest ограничение**, зафиксированное, а не
скрытое: механизм `reservedRecoverySteps` (recovery-бюджет контроллера)
реально задействуется только при ПОВТОРНОМ вызове `runS4ResearchJob`
для одного и того же job'а — а один проход `handleResearchJobTask` на
`QUEUED`-подхват всегда доводит job до терминального состояния за один
проход контроллера (`pending` обходится ровно один раз за вызов).
Поэтому `BUDGET_EXHAUSTED` через recovery-потолок в проде этим срезом
недостижим за один обычный подхват — он достижим только для job'а,
возобновлённого после сбоя (два реальных вызова движка), что и
подтверждает тест этого среза напрямую через `runS4ResearchJob`. Само
по себе это не регресс: recovery-бюджет — механизм именно для
возобновления после сбоя, а не для одного непрерывного прохода, и этот
срез не берётся его переиспользовать под что-то другое.

---

## 7. Регрессия

- `npx vitest run` → **676 passed, 4 skipped, 0 failed**
- `tsc --noEmit` → чисто
- `eslint` → чисто
- `next build` → успех, 17 маршрутов
- `drizzle-kit generate` → без дрейфа
- `npm run eval:memory` → не изменился (21 сценарий, recall=1,
  precision=1, false_reuse_rate=0, negative safety=1, self-check PASS)
- `npx playwright test` → 7 passed, 1 skipped
- S4/S5/S6/S7 исходники движка — не тронуты (`git diff --stat` не
  содержит ни одного файла `engine/controller.ts`, `engine/s4-executor.ts`,
  `engine/claim-evaluator.ts`, `engine/claim-support-store.ts`,
  `engine/mechanism-assembler.ts`)
- `research_enabled = false` — без изменений

---

## 8. Обновлённый существующий тест

`tests/phase5-worker-acceptance.test.ts` (тест 26) обновлён: ожидание
`errorCode = "NOT_IMPLEMENTED"` заменено на «job достигает
`SUCCEEDED`/`BUDGET_LIMIT_REACHED`, `errorCode` не `NOT_IMPLEMENTED`» —
это прямое, требуемое следствие самого подключения worker'а
(acceptance-условие «Worker no longer returns NOT_IMPLEMENTED»), а не
случайное изменение теста.

---

## 9. Что дальше

Этот срез сознательно не строит: S8 (память из живых прогонов), S9,
S10 (живые провайдеры), Proof Core, UI, billing, Claim Normalization.
Он не замораживается сам по себе (владелец решает после ревью). Любое
изменение замороженной семантики S4–S7 по-прежнему требует отдельного
явного решения владельца (D-112 §9) — этот срез такого решения не
принимает и не пытается.
