# ATLAS PROOF — ARI Learning Loop / Accumulated Research Intelligence

Статус: **зафиксировано владельцем 2026-08-20 как продуктовое и архитектурное
направление.** Реализация текущих утверждённых фаз из-за этого не меняется;
механика встраивается в будущие Фазы 4–10 (интеграционная карта ниже).

Полный текст директивы: разделы 0–3 — в этом документе; разделы 4–34 —
`docs/handoff/ARI_LEARNING_LOOP_DIRECTIVE_SECTIONS_4_34.md` (дословный
источник). Ключевые принципы хвоста интегрированы в §9–§12 ниже.

**Решения владельца по границам v1 (2026-08-20):**
- lesson extraction — автоматически; новый lesson сохраняется **только как
  candidate/observation**; CANDIDATE → ACTIVE подтверждает человек;
  CORE evolution полностью human-controlled; перед новой версией CORE —
  обязательная blind/adversarial regression validation. Полностью
  автоматическую validation/promotion в v1 НЕ вводим. Граница LOCKED §11
  сохраняется.
- **Extraction ≠ promotion.** Извлечение candidate-урока НЕ ограничено
  VERIFIED-исходами: качественно завершённый trace с достаточным provenance
  (в т.ч. честный INSUFFICIENT_EVIDENCE / unresolved gap) может дать урок.
  Требования к promotion — намного строже, чем к extraction.
- **Semantic retrieval не фиксируем.** На плане Фазы 5 сравнить
  (1) structured-only и (2) structured+embeddings hybrid; pgvector — только
  при измеримой пользе с учётом операционной стоимости.

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

## Итоговая рамка (зафиксирована владельцем при закрытии архитектурного цикла)

```
CORE            = как думать
Research Memory = что видел
Proof           = что доказал
Learning Loop   = как опыт улучшает следующие исследования
ARI             = система, которая становится лучше через проверенный опыт
```

Learning Loop — не отдельная система рядом с ATLAS, а слой поверх уже
построенных CORE / Proof Engine / Evidence System / Research Memory.
Главный критерий его существования: память меняет research plan
(вспомнил → изменил план → проверил слабые места → более сильный Proof);
если не меняет — это архив. «Ничего нового» — полноценный результат
learning-шага: память не растёт ради роста. CORE остаётся маленьким
мозгом методологии над большой памятью опыта. Atlas может сам находить
урок, сохранять candidate, искать похожие случаи, считать подтверждения
и готовить предложение — но не может сам менять CORE и объявлять новые
законы исследования: Proof → Lesson Candidate → Validation → Human
Review → CORE Update. Это не RAG и не база знаний — это концепция
исследовательского интеллекта: «Atlas doesn't start from zero».

## 9. Принципы из полного текста (Sections 4–34) — существенные дополнения

- **Knowledge Base — отдельный актив** (§6): цепочка claim → source →
  evidence → mechanism → date → Proof; человек должен уметь проследить
  вывод до доказательств. «100 сильных Proof ценнее 10 000 слабых ответов».
- **Память обязана менять ПЛАН исследования** (§7, §18): retrieval уроков —
  до построения плана; урок «Abstraction ≠ Removal» меняет, ЧТО проверяется.
  Иначе это архив, а не интеллект.
- **«Ничего нового» — хороший исход** (§10): память НЕ растёт после каждого
  Proof; рост без нужды = загрязнение дубликатами.
- **Расширенный lifecycle урока** (§11): OBSERVATION → CANDIDATE → SUPPORTED
  → CORE PROPOSAL → HUMAN DECISION → CORE. Принцип важнее имён enum'ов;
  маппинг на канонический OBSERVED→CANDIDATE→ACTIVE — при плане Фазы 5.
- **Многомерная оценка урока, не счётчик** (§12): repeatability + diversity
  (3 разных архитектуры сильнее 3 клонов) + counterexamples (контрпример →
  уточнение формулировки, не удаление: «Utility ≠ VC» → «Utility alone does
  not prove VC») + evidence strength + blind/adversarial validation.
  Числа §13 (1/2–3/4–5/5+) — эвристика для обсуждения, НЕ хардкодить.
- **CORE proposal — карточка, не вопрос** (§14): pattern, supporting Proofs,
  diversity, evidence strength, counterexamples, validation result,
  recommendation; действия ревьюера APPROVE / NEEDS MORE DATA / REFINE RULE /
  REJECT.
- **Защита от плохого обучения** (§15): ввод пользователя — не знание;
  вывод LLM — не знание; опасная петля bad Proof → bad lesson → worse Proof
  блокируется provenance + validation state (любой урок инспектируем).
- **Временнóе разделение** (§16): durable-принципы vs time-sensitive факты
  (verified_at, freshness, revalidation). «Старый опыт подсказывает, где
  искать; current-state перепроверяется».
- **Research Narrative** (§19): внутренний Learning Loop ≠ пользовательский
  рассказ; в будущем UI рассказывает реальную историю исследования
  («источник найден… один шаг не хватает… два источника противоречат») —
  без фейковой драмы; события только настоящие. Copy — через владельца.
- **Будущие агенты внутри ARI** (§20–22): Main ARI — единственный
  оркестратор и финальный решатель; Research/Mechanism/Critic — узкие роли,
  добавляются только по измеренной пользе (A/B §21). Не путать с Claude Code
  subagents (наш DEVELOPMENT_WORKFLOW §22 директивы это дублирует).
- **Бизнес-слой** (§23–26): накопленный интеллект — причина апгрейда
  DEMO→CORE («Atlas doesn't start from zero»); DEMO не делаем «глупым» —
  один развивающийся ARI, тиры отличаются бюджетом/глубиной/доступом;
  возможный третий тир — стратегическая опция, НЕ реализовывать; гипотеза
  снижения marginal cost — измерять, не предполагать.
- **Критерий успеха** (§27–28): controlled eval «memory OFF vs memory ON» —
  если одинаково, построен архив, а не интеллект. Рост CORE тестируется на
  породивших кейсах + unseen + adversarial; правило, ухудшающее reasoning,
  уточняется или удаляется.
- **V1 маленький** (§29–30): Structured CORE v0.1 + Proof Memory + Lesson
  Candidate + retrieval + provenance + human promotion (+ простой post-Proof
  extraction). Без: обучения сетей, авто-promotion, knowledge graph,
  RL-replay, «dreaming», сложной confidence-математики, роя агентов.
- **Safety-правила** (§31): сохранять provenance, uncertainty, time context,
  claim-vs-fact, mechanism/token state; «Unknown must remain a valid state»;
  ATLAS умеет сказать «видел раньше, но текущее состояние надо перепроверить»
  и «это candidate-урок, не проверенное правило».
- **Финальный принцип** (§34): ATLAS умнеет не от объёма текста, а от
  проверенного опыта, меняющего следующий research. Для пользователя всё
  это — просто «Atlas doesn't start from zero».

## 10. Архитектурное ревью по §32–33

Полный 17-секционный architecture review (что есть / чего не хватает /
данные / retrieval / lifecycle / оценка / фаза внедрения) — выполняется как
пре-работа плана Фазы 5 и входит в phase-5-plan.md. До того реализация не
начинается (§32: «Do not implement until approved»).

## 11. Открытые пункты (решаются при плане Фазы 5)

1. Механика retrieval: сравнение structured-only vs hybrid (+embeddings) с
   измеримой пользой и операционной стоимостью; что именно эмбеддится, когда,
   правила re-embedding, индексация, Top-K (старт 3–5 — не жёсткое правило).
2. Формальные критерии «качественного trace» для extraction и (строже) для
   promotion.
3. Имена статусов lifecycle и маппинг на канонический OBSERVED→CANDIDATE→ACTIVE.
4. Какая часть автоматизаций §14 (подсчёт поддержки, similarity-дедуп, поиск
   контрпримеров, подготовка proposal) входит в v1, а какая остаётся за
   границей LOCKED §11 (моя рекомендация: в v1 — extraction + similarity-дедуп
   + подсчёт; поиск контрпримеров и авто-подготовка proposal — после BETA).
5. Дизайн eval «memory OFF vs ON» (стыкуется с Blind Evaluator из
   DEVELOPMENT_WORKFLOW).
6. Карточка CORE proposal в Admin (Фаза 9) — UI четырёх действий.
