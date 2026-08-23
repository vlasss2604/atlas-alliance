# First Real Run — Stage 2 — FREEZE. Operational Trace + Internal Runner

> **Статус: ПРИНЯТО И ЗАМОРОЖЕНО владельцем, 2026-08-23.**
> Операционный трейс (`research_trace_events`), non-live trace-фикстура,
> раздельные `alpha-run`/`alpha-inspect`, атомарный захват research job
> и приведение `alpha-run` к реальному Interpreter-пути — принято на
> закрытый (D-116) HEAD после независимого closure pass.
>
> **Канонический замороженный HEAD Stage 2:** `8206a79`
>
> **Отклонённый HEAD (не заморожен, не принят):** `f6858ec`
> (D-115, независимое ревью вернуло `REJECT / DO NOT FREEZE`:
> HIGH 1 · MEDIUM 3 · LOW 6).
>
> **Closure pass, закрывший HIGH-1/MEDIUM-1/MEDIUM-2/MEDIUM-3:** D-116.
>
> **Вердикт финального ревью (на `8206a79`):**
> `ACCEPT WITH NON-BLOCKING NOTES`
> (BLOCKER 0 · HIGH 0 · MEDIUM 0 · LOW 4 принятых, не блокирующих).
>
> **Stage 1 принятый runtime (не тронут):**
> `cee7c199d44b20cbfdc95227082f9820cd2eca49` (freeze `56521ff`, D-114).
>
> Это НЕ S8, НЕ S9, НЕ S10 — продолжение Stage 1 (D-113/D-114),
> добавляющее observability и internal tooling. Полная реализация —
> `pipeline-integration-stage2.md`; closure pass — тот же документ §9–10.

---

## 1. Принятая функциональная граница

Stage 2 предоставляет:

- append-only-по-бизнес-пути операционный трейс
  (`research_trace_events`) — search/query/candidate/fetch/extraction
  observability;
- атрибуцию провайдера (`provider_name`, всегда `"non-live-fixture"`
  на non-live пути);
- атрибуцию бюджета (переиспользует существующие три оси, ни одной
  новой);
- детерминированную read-only инспекцию (`alpha-inspect`);
- non-live fixture-исполнение (`trace-fixture-executor.ts`), отдельное
  от принятого Stage 1 `createNonLiveS4WorkExecutor`;
- owner-only tooling (`alpha-run`), проходящее job через классифицирующий
  Interpreter-путь;
- атомарный захват research job (`claimResearchJob`).

**Stage 2 не меняет исследовательскую истину.** Заморожен инвариант:

```
TRACE ≠ EVIDENCE
```

Операционный трейс не может самостоятельно поддержать S5/S6/S7.

---

## 2. Атомарный захват (принятое closure)

```
QUEUED
  → атомарный UPDATE research_jobs
    SET state='RUNNING' WHERE id=$1 AND state='QUEUED'
    RETURNING *
  → ровно один победитель
```

Конкурентные обработчики не могут оба начать исследовательскую работу.

Независимая приёмка воспроизвела:

- 2-way конкурентный захват — ровно один победитель;
- 8-way claim storm — ровно один победитель;
- один план (`research_plans`), один набор попыток (`research_attempts`),
  один трейс, один набор Evidence, одна проекция S5/S6/S7;
- отсутствие порчи терминального состояния.

`handleResearchJobTask` возвращает структурированный
`{claimed: true} | {claimed: false, reason}` — не публичный API,
используется только `alpha-run.ts` и тестами этого модуля.

---

## 3. Граница исполнения alpha-run (принято)

`alpha-run` НЕ ставит свою внутреннюю fixture-job в очередь pg-boss.

Использует явную внутреннюю опцию:

```
skipEnqueue = true
```

и вызывает реальный путь worker-хендлера с non-live fixture-исполнителем.

Следовательно, Stage 2 alpha-run job имеет ровно одного инициатора
исполнения.

Нормальное продуктовое поведение `createResearchJob` не изменено: без
`skipEnqueue` pg-boss enqueue происходит как раньше (подтверждено
контрольным тестом: обычный job получает ровно одну строку
`pgboss.job`).

`skipEnqueue` — конфигурация внутреннего инструмента, не пользовательский
ввод: не часть `CreateResearchJobInput`, недостижима из разобранного
HTTP-тела.

---

## 4. Interpreter-путь (принято)

```
Вопрос
  → createInterpretation
  → детерминированный non-live fake InterpreterGateway
  → персистированная interpretation
  → normalized_intent + task_type
  → research job
  → Фаза 5
  → S4
  → S5
  → S6
  → S7
```

`alpha-run` НЕ фабрикует `normalized_intent` вручную. НЕ реализует Claim
Normalization.

Принятый ручной прогон произвёл классифицированное намерение в scope
(`PROTOCOL_REVENUE_TO_TOKEN`), а не `UNKNOWN` — S7 оценил реальный набор
требований (`INSUFFICIENT_EVIDENCE` с содержательными `reasonCodes`, не
generic-фолбэк).

---

## 5. Безопасность ошибок провайдера (принято)

Сырые сообщения исключений провайдера не персистируются в
`research_attempts.reason`.

Принятая безопасная форма сбоя использует нормализованную операционную
информацию вместо `e.message`: `${label}_FAILED:${e.constructor.name}`.

Независимо проверено: текст ошибки провайдера с секретом
(`Authorization: Bearer ...`, `api_key=...`) не персистируется в:

- `research_attempts.reason`;
- `research_trace_events`;
- вывод `alpha-inspect`.

---

## 6. Редактирование URL трейса (принятая граница)

Точная принятая граница Stage 2: `target_ref` операционного трейса
редактирует ТЕКУЩИЙ утверждённый список credential-подобных
query-параметров, регистронезависимо:

```
api_key · apikey · key · token · access_token
auth · authorization · signature · sig · secret
```

Редактирование применяется ТОЛЬКО к персистируемому операционному
трейсу. Реальный URL продолжает использоваться для настоящего fetch и
для существующей семантики provenance Evidence/source — гарантия НЕ
шире этого.

---

## 7. Коррекция D-115 (историческая ясность)

**D-115 (исходная формулировка) утверждала**, что URL с
`api_key=SECRET` в тексте ошибки провайдера никогда не персистируется
ни в `reason_code`, ни в «любое другое неограниченное поле трейса».

Это было точно для персистенции сырого исключения/`reason_code`, но
СЛИШКОМ ШИРОКО для `target_ref` конкретно: на HEAD `f6858ec`
`target_ref` персистировал URL кандидата/фетча вербатим, и
credential-подобный query-параметр САМОГО URL персистировался бы
неотредактированным.

**Это исправлено D-116**: `trace-store.ts`'s `boundTargetRef` теперь
применяет `redactUrl()` к каждому персистируемому `target_ref` (§6
выше). D-115 как историческое решение НЕ стирается и НЕ переписывается
задним числом — эта запись фиксирует, что его исходная формулировка
была позже уточнена и исправлена D-116, которое остаётся авторитетной
closure-коррекцией.

---

## 8. TRACE ≠ EVIDENCE (заморожено)

`research_trace_events` — операционные аудиторские данные. Не несёт
контракт Evidence, требуемый S5.

S5/S6/S7 не читают события трейса (подтверждено статическим
регрессионным тестом источников этих модулей).

`source_id`/`evidence_id` в трейсе — только аудиторские id-ссылки, не
копия содержимого.

**Ни один будущий срез не вправе молча сделать трейс допустимым
Evidence без нового явного решения владельца.**

---

## 9. alpha-inspect (заморожено)

Строго read-only. Может отображать секции: JOB, INPUT, NORMALIZED
INTENT, PLAN/CONTRACT, MEMORY, S4 ATTEMPTS, SEARCH, SOURCE CANDIDATES,
FETCHES, EXTRACTION, EVIDENCE, S5, S6, S7, BUDGET, TERMINATION,
WARNINGS.

НЕ делает: не мутирует job'ы, не ставит работу в очередь, не пишет
трейс, не создаёт Evidence, не вызывает S5/S6/S7, не выдумывает Proof
prose, не раскрывает model chain-of-thought.

Повторная инспекция над неизменным состоянием — детерминирована
(подтверждено побайтовым сравнением повторного вывода).

---

## 10. Принятая граница безопасности

Stage 2 не хранит скрытое модельное рассуждение, сырые prompt'ы, сырые
model completion'ы, API-ключи, заголовки Authorization или сырой текст
исключения провайдера в операционном трейсе.

Редактирование операционного трейса НЕ изменяет реальный
research-URL, используемый для fetch/provenance.

---

## 11. Принятые LOW (4, не блокируют)

**LOW-1 (D-115 documentation).** Закрыт этим freeze-документом
добавлением исторического уточнения (§7 выше). Изменений кода нет.

**LOW-2 (Redaction coverage).** Текущее редактирование URL трейса
намеренно покрывает принятый начальный список (§6). Не покрывает
исчерпывающе каждую возможную credential-подобную форму URL, включая:
`auth_token`, `refresh_token`, `client_secret`, `password`, `session`,
userinfo URL (`user:pass@host`), credential в URL fragment.

Не блокирует freeze Stage 2. **Обязано быть пересмотрено до или во
время включения живых провайдеров S10.** Рантайм в этом freeze не
меняется.

**LOW-3 (Safe failure category length).** `safeFailureReason`
использует `constructor.name` без явного малого предела длины.
Провайдерские данные обычно не контролируют `constructor.name`, утечка
секрета не воспроизведена. Принято не блокирующим. Рассмотреть
ограничение длины категории при security hardening S10. Рантайм сейчас
не меняется.

**LOW-4 (Interpreter override).** `__setInterpreterGateway`
используется тестами и owner-only non-live alpha tooling. Может
обойти обычный guard «fake запрещён в production» внутри этого
изолированного процесса. Ни один публичный/серверный runtime-путь
сейчас не импортирует `alpha-run` и не позволяет пользователю
управлять этим seam'ом. Принято не блокирующим. **Будущий код не
должен импортировать alpha tooling в публичный/серверный runtime без
явного security-ревью.**

---

## 12. Перенесённые заметки (не расширяются)

Stage 1 LOW-1/LOW-2/LOW-3 (`pipeline-integration-stage1-freeze.md` §6)
— сохранены, не тронуты, не расширены.

Прочие отложенные заметки Stage 2, не блокирующие freeze:

- нет DB-level immutable-триггера на трейс;
- нет TTL/retention-очистки трейса (явное решение владельца, §2 задания
  Stage 2);
- `alpha-run` может нацелиться на существующий project slug;
- самые ранние сбои `modelCostMicro`/query-proposer до первого
  успешного резервирования не полностью трейсируются (structural —
  преflight-сбои не порождают события трейса, см.
  `pipeline-integration-stage2.md` §5).

---

## 13. Восходящий freeze — не тронут

```
S4 runtime: d7e5b8a
S5 runtime: a657db3
S6 runtime: af23d8c
S7 runtime: 9eccea7
Stage 1 accepted runtime: cee7c199d44b20cbfdc95227082f9820cd2eca49
```

Stage 2 closure НЕ переоткрыл семантику S5/S6/S7. Единственное
изменение S4 — принятая операционная санитизация ошибок
(`callProvider`/`safeFailureReason`, D-116), safety-only, не
исследовательское.

---

## 14. Финальное приёмочное состояние

Независимо воспроизведено на `8206a79`:

| Гейт | Результат |
|---|---|
| Vitest | **702 passed, 4 skipped, 0 failed** |
| `tsc --noEmit` | PASS |
| `eslint` | PASS |
| `next build` | PASS, ни одного нового публичного маршрута |
| Drizzle drift | нет |
| Оценка Фазы 5 (`npm run eval:memory`) | 21 сценарий · recall `1` · precision `1` · negative safety `1` · `false_reuse_rate = 0` · self-check **PASS** |
| Playwright | **7 passed, 1 skipped** |
| Атомарный захват | 2-way + 8-way claim storm — ровно один победитель |
| alpha-run / pg-boss | ноль строк `pgboss.job` для `skipEnqueue:true`; одна строка для обычного enqueue (контроль) |
| Провайдерский секрет-инъекция | не персистируется в `research_attempts.reason`/`research_trace_events`/`alpha-inspect` |
| Credential-URL в результате поиска | редактируется в трейсе; реальный fetch получает нередактированный URL |
| Классифицированный `normalized_intent` | подтверждён (`PROTOCOL_REVENUE_TO_TOKEN`, не `UNKNOWN`) |
| Терминальный replay | детерминированный no-op |
| S4/S5/S6/S7 | S5/S6/S7 побайтово идентичны замороженным runtime; S4 — только safety-only |
| `research_enabled` | `false` |
| `PRODUCTION_MODEL_COST_PROFILES` | пуст, fail-closed |
| Живой Brave/Anthropic вызов | не произошёл |

---

## 15. Область — что НЕ начато

```
S8                          НЕ НАЧАТ
S9                          НЕ НАЧАТ
S10                         НЕ НАЧАТ (ЗАКРЫТ)
Proof Core                  НЕ НАЧАТ
UI                          НЕ НАЧАТ
Claim Normalization         НЕ НАЧАТА
billing                     НЕ НАЧАТ
FIRST REAL ATLAS RUN        НЕ НАЧАТ
запись кандидатов Research Memory   НЕ НАЧАТА
```

---

## 16. Правило freeze

**После этого freeze Stage 2 НЕ переоткрывается ради:**

- косметических рефакторингов;
- расширения покрытия редактирования URL «заодно» (LOW-2 — решение
  будущего среза, до/во время S10);
- исправления LOW-1..LOW-4 без отдельного запроса владельца;
- требований S8, S9, S10, Proof Core, UI, Claim Normalization, billing.

**Stage 2 переоткрывается только при:**

1. воспроизведённом материальном регрессе против замороженного
   поведения (атомарный захват, TRACE ≠ EVIDENCE, редактирование URL,
   Interpreter-путь alpha-run, read-only поведение alpha-inspect);
2. дефекте корректности или безопасности;
3. явном новом решении владельца, изменяющем эту границу (D-115/D-116);
4. данных Internal Alpha, показывающих, что отложенный LOW материально
   блокирует корректную работу.

**Любое будущее семантическое изменение атомарного захвата,
TRACE ≠ EVIDENCE, смысла событий трейса, границы исполнения alpha-run
или read-only поведения alpha-inspect требует явного решения владельца
и регрессионного ревью.**

---

## 17. Что этот freeze НЕ делает

- **Не меняет реализацию.** Freeze документационный: код, миграции,
  тесты и конфигурация на `8206a79` не тронуты.
- **Не исправляет LOW-2/LOW-3/LOW-4.** См. §11.
- **Не начинает S8, S9, S10.** `research_enabled = false`;
  `PRODUCTION_MODEL_COST_PROFILES` пуст; S10 остаётся закрыт.
- **Не начинает Proof Core, UI, Claim Normalization, billing.**
- **Не начинает FIRST REAL ATLAS RUN.**

---

**FIRST REAL RUN — STAGE 2 FROZEN**
