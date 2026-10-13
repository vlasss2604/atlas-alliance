---
name: atlas-memory
description: Research Memory architecture — retrieval before fresh research, freshness policy, what may be reused vs re-verified, and the strict rule that only verified outcomes become durable memory. Use when working on memory retrieval, Project Memory, caching of research knowledge, freshness logic, or the learning writeback path.
---

# ATLAS MEMORY — Accumulated Research Knowledge

## Главный закон

> **Research Memory guides. Fresh Evidence verifies.**

ATLAS не начинает каждое исследование с нуля. Накопленный опыт направляет исследование — свежие доказательства подтверждают результат.

---

## Retrieval First

Каждый реальный research-запрос **обязан** сверяться с проверенным предыдущим знанием **до** запуска fresh research.

```ts
interface MemoryRetrievalRequest {
  normalizedIntent: ResearchIntent;
  topic: string;
  entities: string[];
  mechanismHints?: string[];
}

interface MemoryRetrievalResult {
  verifiedPatterns: ResearchPattern[];
  relevantProofs: ProofMemory[];
  reusableSources: SourceMemory[];
  staleFacts: MemoryFact[];
  unresolvedGaps: ResearchGap[];
}
```

Планировщик должен ответить на пять вопросов:

1. Что мы уже знаем?
2. Какой проверенный паттерн переиспользуем?
3. Какие факты могли устареть?
4. Чего всё ещё не хватает?
5. Что можно пропустить?

Затем исследовать **только отсутствующее и устаревшее**.

---

## Три режима исследования

```
MEMORY             — достаточно релевантного, достаточно свежего проверенного знания
TARGETED_REFRESH   — большая часть валидна, но материальный динамический факт мог измениться
FRESH_RESEARCH     — адекватного Proof нет / evidence недостаточно / проект новый
```

**Правило:** переиспользование не отменяет свежесть. `REUSE DOES NOT OVERRIDE FRESHNESS.`

При `TARGETED_REFRESH` — не перезапускать весь Proof. Переиспользовать существующее verified Evidence, обновить только устаревший или отсутствующий шаг.

Пример:
```
Revenue source          ✓ fresh
Allocation mechanism    ✓ fresh
Buyback mechanism       ✓ fresh
Current execution status ⚠ stale   ← исследуется только это
Token destination       ✓ fresh
```

---

## Freshness

Каждый переиспользуемый факт несёт метаданные свежести.

```ts
interface MemoryFact {
  id: string;
  project: string;
  topic: string;
  statement: string;
  verifiedAt: string;
  mechanismState?: MechanismState;
  freshnessClass: "LOW_CHANGE" | "MEDIUM_CHANGE" | "HIGH_CHANGE";
  sourceIds: string[];
}
```

Project Memory должна содержать: `last_verified_at`, `data_as_of`, `freshness_policy`, `stale_after`.

Если claim зависит от текущей механики: получить существующий факт → оценить свежесть → обновить только при необходимости. Не перезапускать исследование всего проекта по умолчанию.

**DEMO:** если данные устарели за пределы допустимого для demo-памяти — не имитировать текущую проверку. Либо targeted refresh конкретного факта, либо честное обозначение границы.

---

## Семантическое сопоставление

Совпадение не должно опираться на точный текст. Учитывать:

```
PROJECT + TOPIC + смысл CLAIM/SUBCLAIM + TIMEFRAME + current/historical природа
```

Пример — это может быть один и тот же исследованный claim:
```
«Pump burns half its revenue»
«Does Pump.fun direct 50% of revenue to PUMP buybacks and burns?»
```

---

## Что такое Project Memory

Project Memory отвечает на вопрос:

> «Как ATLAS должен исследовать этот проект лучше в следующий раз?»

**А не на:**

> «Какую информацию мы когда-либо видели об этом проекте?»

Допустимое содержимое:
- официальная документация
- официальное governance
- официальные dashboards
- protocol-native источники
- полезные адреса/контракты, где релевантно
- терминология проекта
- семантика метрик
- удачные research-запросы
- неудачные запросы
- тупики (dead ends)
- назначение источника
- поведение свежести
- известные research-оговорки
- маршруты проверки исполнения

**Не сохранять** несвязанную информацию просто потому, что она попалась.

**Важное различие:**
```
FACT MEMORY      — что было истинно в определённый момент
RESEARCH MEMORY  — как ATLAS должен эффективно проверить такой тип факта снова
```
Research Memory стратегически долговечнее.

**Project Memory не создаёт новую research capability.** Она помогает лучше применять текущий Pattern.

---

## Lifecycle — барьер против отравления памяти

```
OBSERVED → CANDIDATE → ACTIVE
```

Состояния здоровья: `QUESTIONABLE`, `REVERIFY`, `STALE`, `DEPRECATED`.

**Этот lifecycle не обходится никогда — даже в тестах, даже «для скорости».** Это единственный барьер против отравления памяти системы: если однажды в исследование попадёт источник, специально созданный выглядеть официальным, он не должен молча осесть как ACTIVE и искажать все будущие Proof по этому проекту.

Материальное знание **не становится** доверенной ACTIVE-памятью только потому, что его сгенерировал LLM.

---

## Только VERIFIED становится durable memory

```ts
type ProofVerificationStatus = "DRAFT" | "REVIEWED" | "VERIFIED";
```

Только `VERIFIED` Proof могут порождать durable reusable patterns.

Ручное одобрение:
- принимает Proof к переиспользованию
- **не** превращает неопределённость в определённость
- нерешённые gaps остаются нерешёнными

---

## Пользовательская активность ≠ обучение

Пользовательские Proof **дают**: сигналы, реальные edge cases, наблюдения о слабостях, спрос на темы и проекты, сбои свежести, дорогие кейсы.

Пользовательские Proof **не делают** автоматически:
- изменение canonical Pattern
- превращение в Verified Memory
- превращение в training record
- активацию новой способности

Требуется human review. Сильный спрос ещё не означает, что тема готова к активации.

---

## Knowledge Base ≠ scraped internet RAG

```
Интернет               = сырой исследовательский материал
ATLAS Knowledge Base   = знание, прошедшее исследовательскую обработку
```

Концептуальные состояния: `RAW → EVIDENCE → VERIFIED / ACTIVE KNOWLEDGE`
Историческое управление: `STALE`, `SUPERSEDED`, `DEPRECATED`

Каждый важный Evidence сохраняет: source, URL, publisher/тип источника, `fetched_at`, `observed_at`, `data_as_of`, релевантный фрагмент, project, topic, claim/subclaim, research step, отношение support/contradict/context, информацию о свежести, ограничения.

---

## Приватность памяти

Пользовательская история и Project Memory — **разные вещи**.

- Пользователь может удалить свой Proof — это не должно автоматически удалять общее проверенное знание ATLAS, если оно было независимо верифицировано и является системной Research Memory.
- И наоборот: нельзя взять приватный вопрос пользователя и просто превратить его в публичную память.

---

## Research Experience Record

После каждого значимого Proof сохранять структурированный опыт. Это observability-фундамент — он нужен независимо от того, автоматизирован ли анализ.

```ts
interface ResearchExperience {
  proofId: string;
  projectId?: string;
  topicId?: string;
  normalizedResearchTask: string;
  positionsUsed: ResearchPosition[];
  memoryUsed: boolean;
  memoryHelpful?: boolean;
  searches: number;
  sourcesReviewed: number;
  usefulSources: string[];
  failedPaths: string[];
  duplicateActions: number;
  deadEnds: number;
  stopReason: StopReason;
  evidenceQuality: string;
  importantGap?: string;
  possibleLearning?: string;
  createdAt: Date;
}
```

Не превращать это сейчас в гигантскую telemetry-архитектуру.

**Важно:** в v1 автоматический анализ этих записей (ARI Self Review, генерация Pattern Candidate) **не реализуется** — переход Pattern v1→v2 остаётся полностью ручным. Записи собираются, чтобы у человека был материал для анализа.

---

## Ожидаемая динамика

При правильно работающей памяти со временем:
```
dead ends        ↓
duplicate search ↓
время            ↓
стоимость        ↓

Evidence Quality — не хуже, желательно ↑
Verdict Quality  — не хуже, желательно ↑
Freshness        — не хуже, желательно ↑
```

**Но:** ARI экономит не на качестве исследования, а на повторении уже выполненной исследовательской работы. Никогда не ограничивать поиск искусственно ради дешевизны.
