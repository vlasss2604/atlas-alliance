# ATLAS PROOF — ARI Learning Loop / Accumulated Research Intelligence

Статус: **зафиксировано владельцем 2026-08-20 как продуктовое и архитектурное
направление.** Реализация текущих утверждённых фаз из-за этого не меняется;
механика встраивается в будущие Фазы 4–10 (интеграционная карта ниже).

⚠️ Директива владельца дошла с обрывом: раздел 3 обрывается на примере
«"Protocol earns revenue. Does the token actually capture any…». Разделы после
него (предположительно: правила lesson extraction, validation, controlled CORE
evolution) ожидаются отдельным сообщением и будут дополнены здесь.

---

## 0. Главная идея

Atlas не начинает каждое новое исследование с нуля. Каждый качественно
завершённый Proof потенциально оставляет **проверенный исследовательский
опыт**, который помогает Atlas лучше провести похожее исследование в будущем.

При этом Atlas **НЕ обучает собственную нейросеть** и **НЕ меняет LLM weights**
после запросов. Накопленный интеллект живёт в ATLAS-owned структурах данных
(canonical v3 §43), а не в провайдере модели.

Первая версия Learning Loop строится вокруг: стартового CORE · Research
Memory · Proof Memory · semantic retrieval · lesson extraction · validation ·
controlled CORE evolution.

## 1. Starting CORE

Atlas не начинается как пустой AI. Стартовый **CORE v0.1** — базовая
исследовательская механика, полученная вручную в BETA research traces
(HYPE → UNI → CRV → AAVE → LINK → FIL → ETH → HNT → BTC → RENDER).

Текущие принципы CORE v0.1 (канонический носитель — skill `atlas-core`):

```
User-action necessity ≠ infrastructure necessity ≠ value capture
Token Role Decomposition
Existence ≠ Strength
Mechanism State Gate
Token State Qualification
Economic Capture Path
System Utility ≠ Economic Capture
Mechanism Label ≠ Economic Outcome
Actor × Action Utility
Abstraction ≠ Removal
Same Asset ≠ Same Economic Flow
```

**Разделение ответственности:**

| | Отвечает на вопрос |
|---|---|
| CORE | «**КАК** Atlas должен исследовать» |
| Research Memory | «**ЧТО** Atlas уже видел и чему научился» |

CORE — не база фактов о проектах. CORE остаётся **компактным и качественным**;
он не превращается в огромную базу фактов.

## 2. Три уровня знаний

### A. PROOF MEMORY — конкретный проверенный опыт исследования

Пример: «В RENDER customer usage приводит к burn, а node rewards идут
отдельным emissions-путём». Project-specific knowledge. Каждый факт:
имеет source provenance; имеет дату проверки; может устареть; при новом
исследовании при необходимости перепроверяется (**Research Memory guides.
Fresh Evidence verifies** — закон atlas-memory).

### B. PATTERN / LESSON MEMORY — обобщённый исследовательский урок

Пример: «Same Asset ≠ Same Economic Flow». Не факт одного проекта, а
потенциально переносимый research pattern. Хранится как урок, не как вердикт
по токену (запрет захардкоженных выводов — atlas-core).

### C. CORE — самые устойчивые принципы

Небольшой набор принципов, прошедших максимальную проверку. Урок попадает
в CORE только через контролируемую эволюцию (см. §5).

## 3. Поток нового вопроса (целевой, Фазы 4–8)

```
User Question
→ Intent / research type            (Question Interpreter, Фаза 4)
→ Relevant Memory Retrieval         (Фаза 5 — retrieval first)
→ Research Plan                     (Фаза 5 — динамический план)
→ Research Execution                (Фаза 6)
→ Evidence                          (Фаза 6, immutable provenance — уже в схеме)
→ Proof                             (Фаза 7)
→ Lesson Extraction                 (Фаза 8 — ResearchExperienceRecord)
→ Validation                        (Фаза 9 — human review, см. §4)
→ Memory Update                     (promotion CANDIDATE → ACTIVE)
```

*(Пример владельца из директивы оборван — будет дополнен полным текстом.)*

## 4. Согласование с LOCKED §11 — граница автоматизации

LOCKED §11 откладывает **механизм самоанализа** (ArISelfReview,
PatternCandidate, shadow validation) до после-BETA и оставляет переход
Pattern v1→v2 полностью ручным. Learning Loop v1 встраивается БЕЗ конфликта,
если границы такие:

| Шаг | v1 (сейчас) | После BETA (LOCKED §11) |
|---|---|---|
| Lesson **extraction** | автоматическая ФИКСАЦИЯ кандидатов: структурированные поля ResearchExperienceRecord + learning_candidates (это observability, разрешено §11) | + самоанализ ARI, предложения изменений |
| **Validation** | **только человек** утверждает переход CANDIDATE → ACTIVE | + shadow validation |
| Memory **update** | promotion выполняется по итогу human review; lifecycle OBSERVED → CANDIDATE → ACTIVE не обходится никогда, даже в тестах (закон atlas-memory) | без изменений закона |
| **CORE evolution** | полностью ручная: человек формулирует изменения Pattern; активация новой версии — только после blind-регрессии 5/5 + TAO/SUI/TIA | + IntelligenceRelease-версионирование |

Если полный текст директивы предполагает **автоматическую** validation или
автоматическое обновление CORE уже в v1 — это изменение LOCKED §11 и
оформляется как решение владельца поверх LOCKED (право владельца), о чём
нужно сказать явно. По обрезанному тексту предположение обратное:
«controlled CORE evolution» читается как ручной контроль — тогда конфликта
нет вообще.

## 5. Интеграционная карта: где это живёт в архитектуре

Схема Фазы 1 проектировалась под это — новых «переделок» не требуется,
только запланированные wave-2 таблицы:

| Уровень знаний | Носитель | Фаза появления |
|---|---|---|
| CORE (методология) | `research_patterns` (versioned, одна ACTIVE на topic, партиальный индекс уже в БД) + skill `atlas-core` как канон для разработки; сид Pattern v1 | 5 |
| PROOF MEMORY | `research_memory` (факты: verifiedAt, data_as_of, freshness_class, sourceIds, mechanismState) + `project_memory_items` (как исследовать проект: источники, терминология, dead ends) | 5 |
| LESSON MEMORY | `learning_candidates` → после human-валидации urок в `research_memory` (kind=LESSON, lifecycle-статус) | 5 + 8–9 |
| Опыт per Proof | `research_experience` (queries, dead ends, evidence paths, стоимость, время, possibleLearning) | 8 |
| Provenance фактов | уже построено: `evidence` (retrieved_url, content_hash, fetched_at, data_as_of, snapshot_ref), `sources` (health) | готово (Фазы 1–3) |
| Приватность | путь PRIVATE PROOF → OBSERVED → CANDIDATE → review → ACTIVE; при промоушене знание обезличивается (ссылка на пользователя теряется в момент промоушена) | закон, уже зафиксирован |

**Semantic retrieval** (Фаза 5, решение в phase-5-plan): matching по
`PROJECT + TOPIC + смысл claim + TIMEFRAME + current/historical` (закон
atlas-memory). Инженерная лестница: v1 — структурные ключи + нормализованные
intent/entities из Interpreter; расширение — embedding-колонка (pgvector) для
смысловой близости formulировок. Graph DB запрещена (canonical) — и не нужна:
уровни знаний реляционны.

## 6. Что Learning Loop НЕ делает (границы, уже законы проекта)

- Не меняет LLM weights, не делает fine-tuning, не переписывает промпты
  автономно (canonical «НЕ реализовывать»).
- Пользовательская активность не становится знанием напрямую: activity →
  signals, not truth (CLAUDE.md). Только VERIFIED-исходы становятся durable
  memory.
- CORE не растёт автоматически и не превращается в базу фактов.
- Research Memory никогда не перекрывает freshness: reuse does not override
  freshness (atlas-memory).

## 7. Влияние на ближайшие фазы

- **Фаза 4 (Interpreter):** без изменений; normalized intent/entities — это
  будущие ключи retrieval, схема interpretations уже их несёт.
- **Фаза 5 (Memory + Planner):** план фазы проектируется ИЗ этого документа —
  retrieval-контракты (MemoryRetrievalRequest/Result), три режима
  MEMORY / TARGETED_REFRESH / FRESH_RESEARCH, wave-2 таблицы.
- **Фаза 8 (Experience):** lesson extraction = структурированные поля
  ResearchExperienceRecord (уже в каноне atlas-memory), плюс
  learning_candidates.
- **Фаза 9 (Admin):** экран валидации кандидатов (human review) — вход
  Memory Update.
- **Фаза 10 (Regression):** ворота эволюции CORE: смена ACTIVE-паттерна
  требует blind 5/5 + TAO/SUI/TIA + robustness.

## 8. Открытые пункты

1. **Хвост директивы владельца** (после «Does the token actually capture
   any…») — дослать; документ будет дополнен.
2. Порог «качественно завершённого Proof», дающего право на lesson
   extraction (предложение: только VERIFIED-исходы, не каждый DRAFT) —
   утвердить при плане Фазы 5.
3. Механика semantic retrieval v1 (структурные ключи vs +pgvector) —
   инженерное решение в phase-5-plan.
