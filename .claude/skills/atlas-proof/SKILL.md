---
name: atlas-proof
description: How ATLAS presents research results — the layered Proof structure, verdict semantics, confidence, uncertainty handling, Proof Map, and the language rules for explaining complex research simply. Use when working on Proof construction, verdict/confidence logic, Proof output formatting, Proof Map, or any user-facing research result.
---

# ATLAS PROOF — Presenting the Result

## Главный принцип

> Не упрощать исследование. Упрощать способ его объяснения пользователю.

Сложность принадлежит движку. Первый видимый ответ должен быть понятен человеку без знания крипто-терминологии.

---

## Layered structure — каноническая иерархия

```
1. Verdict + Confidence
2. Простыми словами
3. Почему ATLAS пришёл к этому выводу
4. Что важно учитывать / главный нюанс
5. Подробнее
6. Что может изменить вывод
7. Evidence / Sources / Gaps
```

**Первый viewport остаётся чистым.** Глубина раскрывается скроллом или аккуратным expand (progressive disclosure). Не вываливать всю структуру исследования на первый экран.

**Блок «Что может изменить вывод» обязателен.** Это часть философии продукта: вывод основан на текущих доказательствах, а не объявляется вечной истиной. Примеры того, что может изменить: новые данные, новое governance-решение, новая эмиссия токена, отключение механизма, свежие on-chain доказательства.

Не наполнять «Подробнее» дублирующим текстом ради самого блока.

---

## Layer 1 — Simple Answer

2–4 коротких предложения. Повседневный язык. Пользователь должен понять вывод сразу.

Пример:
> Не совсем. Чем больше Sui используют, тем больше SUI может попадать в Storage Fund. Но большая часть этих средств потенциально может вернуться, поэтому нельзя считать всю storage fee навсегда уничтоженной.

---

## Layer 2 — Why

Короткое объяснение обычным языком.

**Не использовать внутренние названия механик:**
```
✗ Actor × Action
✗ Source-of-Value Gate
✗ Token State Qualification
✗ Mechanism State Gate
```
Переводить рассуждение в нормальный язык.

---

## Правило: meaning first, term second

```
✓ «Проект использует часть денег для покупки своих токенов с рынка.»
  затем: «Такой механизм называется buyback.»

✗ «Проект осуществляет buyback.»
  затем объяснение, что это значит.
```

---

## Layer 3+ — Proof depth

Только когда пользователь открывает глубокий вид: evidence, sources, состояние механизма, экономические пути, контр-доказательства, gaps, confidence, детальный вердикт.

Продукт должен ощущаться простым, даже когда исследование под ним сложное.

---

## Verdicts

```ts
type Verdict =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "NOT_SUPPORTED"
  | "INSUFFICIENT_EVIDENCE"
  | "NOT_APPLICABLE";
```

Русская локализация — presentation layer, не доменная логика.

---

## Uncertainty principle

> ATLAS обязан понимать границу того, что удалось доказать.

ATLAS не обязан всегда давать сильный ответ. Если Evidence недостаточно — **не форсировать** SUPPORT/REJECT.

Ответ должен объяснить:
- что известно
- что неизвестно
- почему сильный вывод преждевременный
- что нужно подтвердить, чтобы вывод изменился

Пример:
> Я бы не спешил с выводом. Часть механики подтверждена, но ключевой элемент пока нельзя доказать достаточно надёжно.

**Исчерпание бюджета не должно порождать сфабрикованную уверенность.** Сохранить собранное Evidence и вернуть честный gap/verdict.

**Ограничение уровня доступа — это ограничение объёма работы, а не правдивости результата.** DEMO с исчерпанным бюджетом возвращает честный `INSUFFICIENT_EVIDENCE`, а не ослабленный вердикт. Quality floor одинаковый на всех уровнях — различается research ceiling.

---

## Proof object

```ts
interface AtlasProof {
  id: string;
  originalQuery: string;
  normalizedIntent: ResearchIntent;
  topic: string;
  entities: string[];

  simpleAnswer: string;
  verdict: Verdict;
  confidence: number;

  actors: string[];
  mechanisms: string[];
  tokenStates: string[];

  findings: EvidenceFinding[];
  paths: EconomicPath[];

  counterevidence: string[];
  gaps: ResearchGap[];

  memoryUsed: string[];
  sources: EvidenceSource[];

  researchStopReason: string;

  createdAt: string;
  researchCutoff: string;
}
```

### Evidence model

```ts
interface EvidenceSource {
  id: string;
  url: string;
  title: string;
  publisher: string;
  sourceType: "OFFICIAL_DOCS" | "GOVERNANCE" | "ONCHAIN"
            | "SECURITY" | "RESEARCH" | "NEWS" | "OTHER";
  publishedAt?: string;
  accessedAt: string;
  reliabilityScore?: number;
}

interface EvidenceFinding {
  id: string;
  claimPart: string;
  finding: string;
  proves: string[];
  doesNotProve: string[];   // ← важно: что этот Evidence НЕ доказывает
  sourceIds: string[];
  confidence: number;
}

interface EconomicPath {
  id: string;
  label: string;
  steps: { actor: string; action: string; asset?: string;
           mechanism?: string; outcome?: string }[];
  valueSource?: ValueSource;
}
```

Поле `doesNotProve` — не формальность. Оно защищает от подмены «механизм существует» на «механизм имеет большое влияние».

### Приоритет источников

```
1. protocol-native / on-chain, где напрямую релевантно
2. официальная документация
3. официальное governance
4. официальные отчёты / dashboards
5. сильные первичные провайдеры данных
6. качественная независимая аналитика
7. медиа
8. соцсети / форумы / блоги — только для обнаружения
```
Источники низкого качества могут направлять поиск, но не должны самостоятельно поддерживать сильные выводы.

---

## Proof Map

**3 top-level узла — одинаково для DEMO и ARI • CORE:**

```
        Evidence
           |
Sources — CLAIM — Gaps
```

В центре: Claim + Verdict + Confidence.

**Не добавлять как отдельные top-level круги:** Risks, Contradictions, Analytics, Community, Media, On-chain, Experts, Mechanisms, Memory, Patterns.

CORE может иметь более глубокий drill-down **внутри** узла, но не увеличивать число главных кругов — это требование визуальной преемственности.

Proof Map — presentation projection полного Proof. Не создавать отдельное исследование ради карты. Счётчики узлов обязаны точно соответствовать данным Proof Core — без потерь и дублирования.

```ts
interface ProofMapProjection {
  claim: { text: string; verdict: Verdict; confidence: number };
  evidenceCount: number;
  sourceCount: number;
  gapCount: number;
}
```

---

## Targeted follow-up

Если остаётся один материальный gap — предложить точечный follow-up **только по этому gap**. Не перезапускать весь Proof.

```ts
interface TargetedFollowUp {
  label: string;    // «Уточнить текущий статус fee switch ENA»
  gapId: string;
  question: string;
}
```

Важно: в v1 **нет** отдельной платной фичи Deep Check и нет кнопки «Уточнить / Deep Check». Targeted follow-up — внутренняя механика Research Engine, если и когда она выводится в UI, это отдельное продуктовое решение.

---

## Язык

Цель:
```
понятно, по-взрослому, премиально, профессионально, технологично,
понимаемо без экспертного словаря
```

> Понятно — не значит примитивно. Профессионально — не значит сложно.

Не писать как детское приложение. Не писать как академическую статью. Не превращать Proof в научную работу.

**Локализация Evidence:** интерфейс, verdict, объяснения, краткое описание Evidence — локализуются (RU/EN). Название источника, короткий фрагмент источника, ссылка — остаются в оригинале. Это сохраняет связь с первичным доказательством.

---

## Приватность

Proof приватен по умолчанию (`visibility = PRIVATE`). Не становится частью общей базы знаний автоматически.

Путь в общую Knowledge Base:
```
PRIVATE PROOF → OBSERVED EXPERIENCE → LEARNING CANDIDATE
→ REVIEW / APPROVAL → ACTIVE MEMORY
```

Проверка владения — на сервере, не в UI. Пользователь не должен иметь возможности получить чужой Proof подбором ID.

**Share в v1** — только экспорт снапшота / изображения / системный Telegram share. Никаких публичных Proof URL.

---

## Чего пользователь НЕ должен видеть

```
Memory Retrieval Failure     Planning Failure
Search Failure               internal recovery
model routing                expected / actual cost
learning candidates          internal Issue classification
Research Pattern version     Mechanism ID
Retrieval Score              Token usage
Search budget                Research Contract
Dead Ends                    Telemetry
```

Внутренняя сложность остаётся внутренней.
