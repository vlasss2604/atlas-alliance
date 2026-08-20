# Фаза 4 — Question Interpreter + Scope/Entitlement Gate. План

> Статус: **УТВЕРЖДЁН владельцем** (APPROVED WITH 4 DECISIONS) — реализация выполнена.
>
> Решения владельца, зафиксированные поверх плана:
> 1. **QUICK_EXPLANATION / NO_RESEARCH_NEEDED — вариант A**: короткий AI-ответ
>    показывается («Понял вопрос. Это объяснение, а не Proof»), но **без**
>    Research Memory, **без** Proof, без сильных утверждений, требующих
>    проверки, с лимитом длины.
> 2. **Модель Interpreter — `claude-haiku-4-5`**: разделение ролей
>    (Haiku — intent/routing/clarification/classification; сильные модели —
>    research и сложные рассуждения).
> 3. **`interpreter_enabled = true` с Фазы 4**: пользователь уже видит
>    «я спросил → Atlas понял смысл → Atlas объяснил, что будет делать».
> 4. **`research_enabled = false` до Фазы 6.**
> 5. **Copy — не сейчас**: тексты утверждаются после просмотра реальных
>    состояний UI (нормальный запрос, уточнение, вне scope, нет доступа,
>    простой вопрос).
>
> Источники: `.claude/skills/atlas-intent` (канон Interpreter),
> `01_LOCKED_DECISIONS.md` §5 (клarification-лимит, цепочка логирования),
> `02_ARCHITECTURE_AND_PHASES.md` (Фаза 4, security-мандат §4 «ввод — всегда данные»),
> phase-1/2/3-plan (переиспользуемая инфраструктура), skill `claude-api`
> (актуальный Anthropic SDK: structured outputs, модели, цены).

---

## 1. Объём фазы

**Входит:**

1. **Question Interpreter** — один лёгкий AI-вызов со строгой схемой
   (канон atlas-intent: «не три агента, не отдельный Research API»).
   Приём человеческого языка (опечатки, сленг, раскладка, неполные фразы)
   → нормализованная research task.
2. **ModelGateway** — абстракция AI-провайдера (канон, Часть 2 §4:
   «ARI не привязан к одной AI-модели»). Реализации: Anthropic + Fake
   (детерминированная, для тестов/dev/CI без API-ключа).
3. **Clarification flow** — максимум 2 уточнения (LOCKED §5), лимит уже
   зашит в БД (`ck_interpretations_attempt BETWEEN 1 AND 3`).
4. **Scope/Entitlement Gate preview** — после интерпретации пользователь
   сразу видит: понято ли, в scope ли, доступно ли на его уровне.
   Enforcement остаётся в `startResearch` (Фаза 3) — сервер, не UI.
5. **Ask-экран вживую** — submit → интерпретация → READY / уточнение /
   мягкий out-of-scope / invalid. Честные состояния, без фейкового прогресса.
6. Подключение READY-интерпретации к существующему конвейеру
   `startResearch` (контракт Фазы 3 не меняется, только наполняется).

**НЕ входит (границы):**

- Research Engine — worker остаётся честным `NOT_IMPLEMENTED` (Фаза 6).
  `research_enabled` в проде остаётся `false`.
- Research Memory / retrieval / freshness decision (Фаза 5).
- Intent Memory (`IntentPattern`) — накопление паттернов формулировок
  относится к memory-системам → план Фазы 5. В Фазе 4 закладывается только
  сырьё: полная цепочка `Original Question → Interpreter Result` в БД.
- `FUTURE_TOPIC_SIGNAL` как отдельная система — не нужна: interpretation
  со статусом `OUT_OF_SCOPE` уже хранит `project_or_asset` и запрашивается
  SQL-запросом. Новых таблиц под сигнал нет.

---

## 2. Interpreter — устройство

### 2.1 Один вызов, строгая схема

Вход модели: вопрос пользователя (+ при уточнении — история диалога
интерпретации). Выход — строго по схеме (structured outputs
`output_config.format` + серверная zod-валидация того же контракта):

```ts
interface InterpreterModelResult {
  status: "READY" | "NEEDS_CLARIFICATION" | "OUT_OF_SCOPE" | "INVALID";
  project_or_asset: string | null;   // как назвал пользователь; резолвит СЕРВЕР
  topic: string | null;
  task_type: "PROJECT_MECHANISM" | "PROJECT_REVENUE" | "TOKEN_VALUE"
    | "RISK" | "CLAIM_VERIFICATION" | "COMPARISON" | "CHANGE_OVER_TIME"
    | "EXPLANATION" | "OTHER_RESEARCH" | null;
  research_task: string | null;      // research language, EN
  user_assumptions: string[];        // допущения — как допущения, не факты
  ambiguities: string[];
  clarification_question: string | null; // на языке пользователя
  // Query Router (канон atlas-intent) — в том же вызове:
  route: "DEEP_RESEARCH" | "QUICK_EXPLANATION" | "CLARIFICATION_REQUIRED"
    | "NO_RESEARCH_NEEDED" | "OUTSIDE_CURRENT_DOMAIN";
  normalized_intent: "TOKEN_UTILITY" | "PASSIVE_HOLDER_OUTCOME"
    | "PROTOCOL_REVENUE_TO_TOKEN" | "USAGE_TO_TOKEN_LINKAGE" | "REWARD_SOURCE"
    | "BURN_OR_SUPPLY_EFFECT" | "MECHANISM_CURRENT_STATE" | "VALUE_CAPTURE"
    | "SCENARIO_CAUSAL_IMPACT" | "CLAIM_FACT_CHECK" | "UNKNOWN";
  intent_confidence: number;         // 0..1
  route_reason: string;
  needs_fresh_evidence: boolean;
  quick_answer: string | null;       // только для QUICK_EXPLANATION /
                                     // NO_RESEARCH_NEEDED — см. §2.5
}
```

Отличия от канона — осознанные:

- `original_question` модель **не** возвращает: сервер хранит ввод verbatim
  сам и не даёт модели переписать его (иначе injection может подменить
  «оригинал» в логе цепочки).
- Router слит в тот же вызов (канон требует «один лёгкий AI-вызов» — два
  вызова были бы нарушением).

### 2.2 ModelGateway

```
src/server/interpreter/
  gateway.ts        — interface InterpreterGateway { interpret(input): Promise<...> }
  anthropic.ts      — реализация через @anthropic-ai/sdk, structured outputs
  fake.ts           — детерминированная реализация (правила по ключевым словам)
  interpret.ts      — сервис: rate limit → вызов → валидация → резолюция → запись
  prompt.ts         — системный промпт (ввод пользователя — ТОЛЬКО данные)
```

Выбор реализации: env `MODEL_GATEWAY=anthropic|fake` (fake — только вне
production, по образцу dev-bypass Фазы 2: в `NODE_ENV=production` +
`MODEL_GATEWAY=fake` процесс отказывается стартовать интерпретацию).

### 2.3 Модель и стоимость

Канон atlas-intent фиксирует: «один лёгкий AI-вызов **с дешёвой моделью**».
Это прямое указание владельца, поэтому дефолт — **`claude-haiku-4-5`**
($1/$5 за 1M токенов), а не общий дефолт claude-opus-5 из skill claude-api.
Модель — ключ конфига `interpreter_model` в `product_config`: смена модели
без деплоя, апгрейд на более сильную — одной строкой, если валидация
покажет слабость понимания. Оценка стоимости интерпретации:
~1.5–2k input + ~300 output токенов ≈ **$0.003–0.004** — на порядки дешевле
research-бюджетов.

Без extended thinking (дешёвый вызов, скорость важнее), без streaming
(ответ короткий, схема цельная).

### 2.4 Отказоустойчивость (канон: failure handling)

- Ошибка API или невалидный по схеме ответ → **1 повтор**.
- Второй сбой → `502 INTERPRETER_UNAVAILABLE`, пользователю безопасное
  сообщение «Не удалось обработать вопрос. Попробуйте ещё раз».
  Строка interpretation **не создаётся** (инфраструктурный сбой ≠ INVALID —
  INVALID зарезервирован за осмысленно-неизвлекаемым вводом).
- Сырой пользовательский ввод **никогда** не попадает дальше Interpreter —
  Research Engine не может стартовать без READY-строки (уже enforcement
  Фазы 3: `startResearch` требует `status === 'READY'`).

### 2.5 Маршруты, не ведущие к Proof — РЕШЕНИЕ ВЛАДЕЛЬЦА

Канон требует: `QUICK_EXPLANATION` — объяснить концептуальную ошибку
категории, **не** запуская Proof; `NO_RESEARCH_NEEDED` («интернет на
Луне») — ответить кратко и остановиться. Оба ответа = текст пользователю
без исследования. Два варианта:

- **Вариант A (рекомендую):** поле `quick_answer` заполняется тем же
  вызовом (лимит длины ~600 символов, язык пользователя), Ask-экран
  показывает его как короткий ответ ARI без Proof. Плюс: поведение по
  канону, ноль дополнительных вызовов. Минус: AI-текст уходит пользователю
  без Proof-валидации — принимаем это только для двух «лёгких» маршрутов.
- **Вариант B:** в v1 оба маршрута показывают фиксированное мягкое
  сообщение без содержательного ответа; `quick_answer` не показывается.
  Плюс: ни одного невалидированного AI-текста. Минус: расходится с каноном
  («объяснить», «ответить кратко»), опыт беднее.

В любом варианте: job для этих маршрутов создать невозможно —
`startResearch` дополнительно проверяет `route === 'DEEP_RESEARCH'`.

### 2.6 Резолюция проекта — сервер, не модель

Модель возвращает `project_or_asset` как свободный текст. Слаг проекта
определяет **детерминированный серверный код**: `projects.slug` +
`project_aliases` (уже есть уникальный индекс `lower(alias)`), регистр
не важен. Модель не может «заявить» проект в scope — scope-решение
принимает каталог в БД.

- Резолвится + `status=READY` → в `result` записывается
  `project_slug` (контракт `startResearch` Фазы 3 наполняется без
  изменений).
- Не резолвится → сервер понижает статус до `OUT_OF_SCOPE`
  (мягкий ответ, §4), `project_or_asset` сохраняется как сигнал спроса.

---

## 3. API и данные

### 3.1 POST /api/interpretations

Гарды (все из Фазы 2): Origin allowlist → session → CSRF → rate limit
(`auth_rate_limits`, bucket `interp:{userId}`, 20/10 мин — тот же механизм
и та же таблица) → `interpreter_enabled` (новый ключ конфига) → длина
вопроса ≤ 2000 символов (`400 QUESTION_TOO_LONG`).

Тело: `{ question: string }`. Ответ:

```ts
{
  interpretation: {
    id, status, attempt,
    clarificationQuestion,     // если NEEDS_CLARIFICATION
    understood: {              // если READY: что будет исследоваться
      researchTask, projectSlug, assumptions
    } | null,
    quickAnswer,               // вариант A, если утверждён
  },
  gates: {                     // preview; enforcement — в startResearch
    scope: "SUPPORTED" | "OUT_OF_SCOPE",
    entitlement: "OK" | "CORE_REQUIRED",
    research: "AVAILABLE" | "DISABLED" | "ACTIVE_JOB_EXISTS" | "DEMO_QUOTA_EXHAUSTED",
    demo: { used, limit } | null
  }
}
```

Gate preview считается **тем же кодом**, что и enforcement: общая функция
`evaluateGates(db, config, interp, userId)`, которую вызывают и превью,
и `startResearch` — превью не может разойтись с реальным решением.
Канон Scope ≠ Entitlement соблюдается и в превью: проект в scope, но вне
`demo_project_slugs` → `CORE_REQUIRED`, не «out of scope». COMPARISON с
сущностью вне DEMO-доступа гейтится целиком — «половину сравнения» сделать
нельзя (Entitlement Gate проверяет все сущности normalized task; в v1
normalized task несёт один `project_slug`, поэтому COMPARISON с двумя
проектами, где второй не резолвится/недоступен → `OUT_OF_SCOPE` /
`CORE_REQUIRED` всей задачи — тест DoD-6).

### 3.2 POST /api/interpretations/:id/clarify

Тело: `{ answer: string }` (лимит 500 символов). Гарды те же + ownership
(`user_id`), `requireUuid`. Условия: родитель имеет
`status=NEEDS_CLARIFICATION`, `attempt < 3`, не имеет ребёнка.
Модель получает: исходный вопрос + предыдущий результат + вопрос-уточнение
+ ответ пользователя (всё — как данные). Создаётся **новая строка**
`attempt = parent.attempt + 1`, `parent_id = :id`.

Лимит уточнений: попытка 1 = исходная, попытки 2–3 = уточнения 1–2.
Clarify на строке `attempt=3` → `409 CLARIFICATION_LIMIT`; клиент
показывает фиксированное сообщение канона («Не удалось достаточно точно
определить исследовательскую задачу. Попробуйте сформулировать новый
вопрос») и закрывает flow. БД хранит правду: статус модели не
переписывается, лимит держат CHECK + серверная проверка.

### 3.3 Изменения БД — миграция 0004 (минимальные)

Новых таблиц **нет**. В `interpretations`:

- `parent_id uuid NULL REFERENCES interpretations(id) ON DELETE CASCADE` —
  цепочка уточнений (логирование LOCKED §5: вся цепочка восстановима).
- Частичный уникальный индекс `uq_interpretations_one_child ON (parent_id)
  WHERE parent_id IS NOT NULL` — двойной clarify (double-tap, гонка двух
  вкладок) не создаст две ветки: инвариант в БД, не в коде.
- Индекс `(user_id, created_at DESC)` — списки/аналитика.

`product_config` — новые ключи (сид + zod-схема):

- `interpreter_enabled: boolean` (сид `true`) — аварийный рубильник
  Interpreter отдельно от `research_enabled` (который остаётся `false`
  до Фазы 6): Ask-экран живёт и валидируется до появления Engine.
- `interpreter_model: string` (сид `"claude-haiku-4-5"`).

В `interpretations.model_meta` пишутся: model, input/output tokens,
latency_ms, retries — сырьё для наблюдаемости и будущего сравнения моделей.

### 3.4 startResearch — точечные изменения

1. Интерфейс `InterpretationResult` расширяется до полной схемы §2.1
   (тип, не поведение).
2. Дополнительная проверка: `result.route === 'DEEP_RESEARCH'`, иначе
   `409 INTERPRETATION_REQUIRED` — QUICK_EXPLANATION/NO_RESEARCH_NEEDED
   не могут породить job даже прямым вызовом API.
3. Всё остальное (replay, self-heal, TOCTOU-компенсация, квота, гейты) —
   без изменений; регресс-тесты Фазы 3 обязаны остаться зелёными.

---

## 4. Ask-экран — честные состояния

Поток (motion — токены директивы 140/200/280ms, transform+opacity):

1. Ввод → submit → состояние «ARI разбирает вопрос» (реальный in-flight
   запрос, спиннер без фейковых стадий).
2. `READY` → карточка «Вот что я исследую»: research task (человеческим
   языком), проект, допущения пользователя (как допущения). Кнопка
   «Start Proof»:
   - `gates.research === "AVAILABLE"` → активна → POST /api/research-jobs
     (idempotency key генерируется на клике, как в Фазе 3);
   - `research_enabled=false` (прод Фазы 4–5) → существующий честный
     `disabledNote`;
   - `CORE_REQUIRED` → мягкое сообщение канона про ARI • CORE;
   - `DEMO_QUOTA_EXHAUSTED` / `ACTIVE_JOB_EXISTS` → соответствующие
     честные состояния.
3. `NEEDS_CLARIFICATION` → вопрос ARI + поле ответа (счётчик попыток
   не выпячивается; после второй неудачи — фиксированное сообщение канона).
4. `OUT_OF_SCOPE` → мягко, по канону: без `UNSUPPORTED_TOPIC`/`ERROR`;
   объяснение специализации ATLAS + предложение переформулировать.
5. `INVALID` → мягкое «не получилось выделить исследовательскую задачу».
6. Вариант A: `QUICK_EXPLANATION`/`NO_RESEARCH_NEEDED` → короткий ответ
   ARI без кнопки Proof.

i18n: новые ключи en/ru (вопросы-состояния, карточка understanding,
CORE_REQUIRED, лимит уточнений). **Copy — предложение; финальное
утверждение текстов — за владельцем** (как states Фазы 3).

Внутренние enum'ы (`READY`, `DEEP_RESEARCH`, confidence…) пользователю
не показываются никогда — presentation layer только.

---

## 5. Промпт-архитектура и security (мандат Части 4 §4)

1. **Ввод пользователя — всегда данные.** Системный промпт неизменен и
   не содержит пользовательского текста; вопрос/ответы уточнений уходят
   исключительно в user-сообщения, обёрнутые как данные для анализа.
2. **Схема — второй барьер.** Structured outputs + серверный zod: enum'ы
   с закрытыми списками; ответ вне схемы = сбой вызова (retry → 502),
   а не «почти подходящий» результат.
3. **Модель ничего не решает о доступе.** Scope — каталог БД (резолюция
   слага сервером, §2.6); Entitlement — `resolveEntitlement`; запуск —
   `startResearch` с его гейтами. Даже статус READY, «выпрошенный»
   инъекцией, упирается в серверные проверки и `research_enabled`.
4. **Инъекции — в тестах** (DoD-7): «ignore previous instructions»,
   попытки выдать себя за систему/админа, попытки получить системный
   промпт, попытки навязать READY/проект/route. Ожидание: схема валидна,
   опасный ввод не получает привилегий, вопрос сохранён verbatim как данные.
5. **Лимиты в обе стороны:** вопрос ≤ 2000 символов, ответ уточнения
   ≤ 500, `max_tokens` вызова ограничен (~1k), `quick_answer` ≤ 600
   символов (вариант A).
6. **Логи без лишнего:** сохраняется только контракт схемы + model_meta;
   free-form текст модели вне схемы не существует по построению.
7. Rate limit по верифицированному пользователю (bucket `interp:`) —
   защита бюджета от скриптового спама; неудачные гейты по-прежнему
   не трогают DEMO-квоту (квота — только при создании job, Фаза 3).

---

## 6. Definition of Done — тесты

Vitest + реальный Postgres (инфраструктура Фаз 1–3), gateway — Fake;
контракт Fake = контракт Anthropic (общая zod-схема). Живой smoke-тест
с реальным API — опциональный, скипается без `ANTHROPIC_API_KEY`.

1. **READY happy path:** вопрос → строка interpretations (status, result
   по схеме, model_meta), проект резолвится по алиасу без учёта регистра,
   `result.project_slug` заполнен.
2. **Clarification chain:** NEEDS_CLARIFICATION → clarify → READY;
   `parent_id` связан, attempt 1→2; цепочка Original Question →
   Interpreter Result восстановима одним запросом.
3. **Лимит уточнений:** две неудачи → attempt=3; clarify → 409
   CLARIFICATION_LIMIT; вставка attempt=4 невозможна (CHECK).
4. **Гонка clarify:** два параллельных clarify одного родителя → ровно
   один ребёнок (частичный уникальный индекс), второй — 409.
5. **OUT_OF_SCOPE:** неизвестный проект → мягкий статус, job не создать,
   квота нетронута; `project_or_asset` сохранён (сигнал спроса).
6. **Scope ≠ Entitlement:** DEMO + ACTIVE_CORE-проект вне
   `demo_project_slugs` → preview `CORE_REQUIRED` и `startResearch` 403;
   COMPARISON со второй недоступной сущностью гейтится целиком.
7. **Prompt injection suite** (≥5 кейсов, §5.4) — схема валидна,
   привилегий нет, verbatim-хранение.
8. **Сбой модели:** невалидный ответ → ровно 1 retry → 502, строки нет,
   сырой ввод никуда не передан.
9. **Роутинг без research:** QUICK_EXPLANATION и NO_RESEARCH_NEEDED
   («интернет на Луне») → `startResearch` отвергает (409), job нет.
10. **interpreter_enabled=false** → 403 без обращения к модели;
    production + MODEL_GATEWAY=fake → отказ.
11. **Rate limit:** 21-й запрос за окно → 429.
12. **Интеграция с Фазой 3:** READY → startResearch → job создан и связан;
    все 40 тестов Фаз 1–3 зелёные (регресс).
13. **Валидация схемы:** unit-тесты zod (неизвестный enum, confidence вне
    0..1, лишние поля → reject).
14. **e2e (Playwright, fake gateway, 390×844):** submit → clarification →
    READY-карточка → честная disabled-кнопка при `research_enabled=false`;
    OUT_OF_SCOPE мягкий экран.

Плюс: build, tsc, eslint — чисто. Adversarial review со свежим контекстом —
по workflow (обязателен с Фазы 3).

---

## 7. Переиспользование Фаз 1–3 (ничего не переписывается)

- `interpretations` (Фаза 1) — наполняется; только ALTER (parent_id).
- `ck_interpretations_attempt 1..3` — уже готовый лимит канона.
- Гарды Фазы 2: session, CSRF, Origin, rate-limit таблица, requireUuid.
- `startResearch` (Фаза 3) — принимающая сторона; гейт-цепочка не меняется.
- `research_enabled` — остаётся `false` в проде до Фазы 6.
- Fake gateway — паттерн dev-bypass Фазы 2 (env-переключатель, запрет в prod).

## 8. Решения владельца (закрыты до реализации)

1. **§2.5 — вариант A принят.** `quick_answer` показывается на маршрутах
   QUICK_EXPLANATION / NO_RESEARCH_NEEDED: без Research Memory, без Proof,
   без обучения, с лимитом длины (600 символов) и запретом сильных
   утверждений в промпте. Схема отвергает `quick_answer` на любом другом
   маршруте (`assertConsistent`).
2. **§2.3 — `claude-haiku-4-5` принят** как модель Interpreter
   (ключ конфига `interpreter_model`, смена без деплоя).
3. **§3.3 — `interpreter_enabled=true` принят**; `research_enabled=false`
   до Фазы 6.
4. **Copy — отложен**: тексты (§4) предложены реализацией и утверждаются
   владельцем после просмотра реальных состояний UI.

Конфликтов с LOCKED-концепцией не обнаружено: план наполняет уже
зафиксированные сущности и границы, ничего не пересматривая.
